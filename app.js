/* ============================================
   昇進試験 学習PWA / app.js
   - SM-2 spaced repetition
   - IndexedDB storage
   - JSON/CSV import-export
   - TTS for commute mode
   ============================================ */
(() => {
'use strict';

// ============================================
// Constants & state
// ============================================
const DB_NAME = 'shoshin-shiken';
const DB_VERSION = 2;
const STORE_Q = 'questions';
const STORE_P = 'progress';
const STORE_S = 'sessions';
const STORE_M = 'meta';
const STORE_SRC = 'sources';

const APP_VERSION = '2.2.0';  // バージョンが変わっても IndexedDB のデータは保持される

const CATS = { common: '共通', solution: 'ソリューション', engineering: 'エンジニア' };

const state = {
  questions: [],          // [{id, category, question, answer, ...}]
  progress: {},           // {questionId: {ease, interval, reps, due, ...}}
  settings: {
    examDate: '',
    newPerDay: 10,
    revPerDay: 100,
    mixRatio: '3:7',
    theme: 'auto',
    fontSize: 'm',
    ttsAuto: false,
    authorName: '',
  },
  todayKey: '',
  todaySeen: { new: 0, rev: 0 },  // counters reset daily
  studyDeck: [],          // current session queue
  studyIdx: 0,
  studyStats: { again: 0, hard: 0, good: 0, easy: 0, total: 0 },
  selectedCat: 'all',
  selectedSize: 10,
  quiz: { active: [], idx: 0, results: [] },  // 解答モードの進行状態
  editingReturnView: null,  // 編集保存後の戻り先('view-study' or null→'view-list')
  listCat: 'all',
  listStatus: 'all',
  listSort: 'created',
  listSearch: '',
  editingId: null,
  editingCat: 'common',
  editingImp: 3,
  utterance: null,
  ttsEnabled: false,
  sourceManifest: null,    // 端末内に読み込んだ出典パッケージの索引
  sourceObjectUrls: [],    // 出題切替時に破棄するプレビュー用Blob URL
};

// ============================================
// IndexedDB wrapper
// ============================================
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      // IMPORTANT: 既存ストアは絶対に削除しない。なければ作るだけ。
      if (!d.objectStoreNames.contains(STORE_Q)) {
        const s = d.createObjectStore(STORE_Q, { keyPath: 'id' });
        s.createIndex('category', 'category');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!d.objectStoreNames.contains(STORE_P)) {
        d.createObjectStore(STORE_P, { keyPath: 'questionId' });
      }
      if (!d.objectStoreNames.contains(STORE_S)) {
        d.createObjectStore(STORE_S, { keyPath: 'date' });
      }
      if (!d.objectStoreNames.contains(STORE_M)) {
        d.createObjectStore(STORE_M, { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains(STORE_SRC)) {
        d.createObjectStore(STORE_SRC, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode = 'readonly') {
  const t = db.transaction(stores, mode);
  return Array.isArray(stores) ? stores.map(s => t.objectStore(s)) : t.objectStore(stores);
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) { return reqP(tx(store).getAll()); }
async function dbGet(store, key) { return reqP(tx(store).get(key)); }
async function dbPut(store, value) { return reqP(tx(store, 'readwrite').put(value)); }
async function dbDel(store, key) { return reqP(tx(store, 'readwrite').delete(key)); }
async function dbClear(store) { return reqP(tx(store, 'readwrite').clear()); }

// 1トランザクションでストアをクリアして一括書き込む。
// dbClear + ループdbPut の代わりにこれを使うことで、
// iOS Safariで「The database connection is closing」を防ぐ。
// delIds: 個別に削除するキーの配列(progress リセット用)
async function dbReplaceAll(store, records, delIds = []) {
  return new Promise((resolve, reject) => {
    const t = db.transaction([store, STORE_P], 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    const s = t.objectStore(store);
    s.clear();
    for (const rec of records) s.put(rec);
    if (delIds.length > 0) {
      const ps = t.objectStore(STORE_P);
      for (const id of delIds) ps.delete(id);
    }
  });
}

async function metaSet(key, value) { return dbPut(STORE_M, { key, value }); }
async function metaGet(key) { const r = await dbGet(STORE_M, key); return r ? r.value : null; }

// ============================================
// SM-2 algorithm
// ============================================
// 習得(マスター)の条件: 連続で速く正解した回数がこの値に達したら、その穴は卒業(以後出題しない)
const MASTER_STREAK = 3;
const BLANK_FAST_SEC = 30;  // 1穴あたりこの秒数以内なら「速い」(連続MASTER_STREAK回で習得卒業)
const BLANK_SLOW_SEC = 60;  // これを超えると「遅い」

// 文字列ハッシュ(djb2)
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
// 穴ごとの進捗キー: 問題id + '#' + 解答内容のハッシュ。
// 位置や問題文が変わっても、解答の中身が同じなら同じキー = 学習履歴が追従する。
function blankKey(qid, answer) { return qid + '#' + hashStr(normalizeAns(answer)); }

// 問題の穴一覧 [{label, answer}]。穴が無い場合は解答全体を1穴とみなす。
function getBlanks(q) {
  const b = parseQuizBlanks(q.question, q.answer);
  if (b && b.length) return b;
  return [{ label: '', answer: (q.answer || '').trim() }];
}
// 各穴の状態を返す: [{i,label,answer,key,prog,st}] st='new'|'due'|'wait'|'mastered'
// 同一問題内に同じ解答が複数あれば ~1, ~2 を付けて区別する。
function getBlankStates(q) {
  const today = startOfDay();
  const blanks = getBlanks(q);
  const seen = {};
  return blanks.map((b, i) => {
    const base = blankKey(q.id, b.answer);
    const n = seen[base] || 0; seen[base] = n + 1;
    const key = n === 0 ? base : base + '~' + n;
    const bp = state.progress[key];
    let st;
    if (bp && bp.mastered) st = 'mastered';
    else if (!bp || !bp.due) st = 'new';
    else st = startOfDay(new Date(bp.due)) <= today ? 'due' : 'wait';
    return { i, label: b.label, answer: b.answer, key, prog: bp || null, st };
  });
}
// 今学習すべき穴(new または due)
function qActiveBlanks(q) {
  return getBlankStates(q).filter(s => s.st === 'new' || s.st === 'due');
}
// 「間違えた問題」モード用: new/dueに加え、まだ期日前でも
// 直近で間違えた穴(lapses>=1かつ未習得)を出題対象に含める。
// SM-2の間隔がまだ満了していなくても、ユーザーが明示的に選んだモードなので
// 「学習対象の穴がありません」と出題できないのを避ける。
function qWrongFocusBlanks(q) {
  return getBlankStates(q).filter(s =>
    s.st === 'new' || s.st === 'due' ||
    (s.st === 'wait' && s.prog && !s.prog.mastered && s.prog.lapses >= 1 && s.prog.interval < 14)
  );
}

function newProgress(key) {
  return {
    questionId: key,    // 穴ごとの場合は blankKey(qid, answer)
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: null,        // null = new (never reviewed)
    lastReviewed: null,
    totalReviews: 0,
    fastStreak: 0,    // 連続高速正解の回数
    mastered: false,  // 習得済み(卒業)
    history: [],
  };
}

function applySM2(p, rating) {
  // rating: 1=Again, 2=Hard, 3=Good, 4=Easy
  const before = p.interval;
  if (rating === 1) {
    p.reps = 0;
    p.interval = 1;
    p.ease = Math.max(1.3, p.ease - 0.20);
    p.lapses += 1;
  } else {
    if (p.reps === 0) {
      p.interval = rating === 2 ? 1 : (rating === 3 ? 1 : 4);
    } else if (p.reps === 1) {
      p.interval = rating === 2 ? 3 : (rating === 3 ? 6 : 10);
    } else {
      const factor = rating === 2 ? 1.2 : (rating === 3 ? p.ease : p.ease * 1.3);
      p.interval = Math.max(1, Math.round(p.interval * factor));
    }
    p.reps += 1;
    if (rating === 2) p.ease = Math.max(1.3, p.ease - 0.15);
    else if (rating === 4) p.ease = Math.min(3.0, p.ease + 0.15);
  }
  p.totalReviews += 1;
  const now = new Date();
  p.lastReviewed = now.toISOString();
  const due = startOfDay(now);
  due.setDate(due.getDate() + p.interval);
  p.due = due.toISOString();
  p.history.push({ d: now.toISOString().slice(0,10), r: rating, b: before, a: p.interval });
  if (p.history.length > 100) p.history = p.history.slice(-100);
  return p;
}

function previewIntervals(p) {
  // Return what interval each rating would produce, without modifying p
  const make = (r) => {
    const c = JSON.parse(JSON.stringify(p));
    return applySM2(c, r).interval;
  };
  return [make(1), make(2), make(3), make(4)];
}

// ============================================
// Helpers
// ============================================
function startOfDay(d = new Date()) {
  const x = new Date(d); x.setHours(0,0,0,0); return x;
}
function dateKey(d = new Date()) {
  const x = startOfDay(d);
  return x.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const ms = startOfDay(b) - startOfDay(a);
  return Math.round(ms / 86400000);
}
function fmtDays(n) {
  if (n < 1) return '今日';
  if (n === 1) return '1日後';
  if (n < 30) return `${n}日後`;
  if (n < 365) return `${Math.round(n/30)}ヶ月後`;
  return `${Math.round(n/365*10)/10}年後`;
}
function fmtDue(due) {
  if (!due) return '未学習';
  const d = daysBetween(new Date(), due);
  if (d < 0) return `期日超過 (${-d}日)`;
  if (d === 0) return '今日が期日';
  return `${d}日後`;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 【】を穴に変換、答え側の① ②等を強調表示
function renderBlanks(text) {
  return escapeHtml(text).replace(/【([^】]*)】/g, (m, inner) => {
    return `<span class="blank">${inner || '　'}</span>`;
  });
}
function renderAnswer(text) {
  // 改行は維持。①②...㊿ を少し強調。
  return escapeHtml(text).replace(/([①-⑳㉑-㊿])/g, '<span class="ans-num">$1</span>');
}

// ============================================
// Local source library (never uploaded by the app)
// ============================================
function clearRenderedSourceAssets() {
  for (const url of state.sourceObjectUrls) {
    try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
  }
  state.sourceObjectUrls = [];
}

function sourceRecordKey(manifest, path) {
  return `${(manifest && manifest.packageId) || 'source'}::${path}`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderMarkedText(text, terms) {
  const uniq = [...new Set((terms || [])
    .map(t => String(t || '').trim())
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 30);
  if (!uniq.length) return escapeHtml(text).replace(/\n/g, '<br>');
  const re = new RegExp(`(${uniq.map(escapeRegExp).join('|')})`, 'giu');
  return String(text || '').split(re).map(part => {
    if (!part) return '';
    const isMark = uniq.some(t => t.localeCompare(part, undefined, { sensitivity: 'accent' }) === 0);
    return isMark ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part);
  }).join('').replace(/\n/g, '<br>');
}

function findSourceQuestionEntry(q) {
  const manifest = state.sourceManifest;
  if (!manifest || !manifest.questions) return null;
  const hash = contentHash(q);
  const sourceKey = value => (value || '').replace(/\s+/g, '').trim();
  const currentSource = sourceKey(q.source);
  const isCompatible = candidate => {
    if (!candidate || (candidate.contentHash && candidate.contentHash !== hash)) return false;
    const packagedSource = sourceKey(candidate.sourceText);
    return !currentSource || !packagedSource || packagedSource === currentSource;
  };

  let entry = manifest.questions[q.id] || null;
  if (!isCompatible(entry)) entry = null;
  if (!entry && manifest.contentIndex && manifest.contentIndex[hash]) {
    const ids = Array.isArray(manifest.contentIndex[hash])
      ? manifest.contentIndex[hash] : [manifest.contentIndex[hash]];
    let fallback = null;
    for (const id of ids) {
      const candidate = manifest.questions[id];
      if (!candidate || (candidate.contentHash && candidate.contentHash !== hash)) continue;
      if (!fallback) fallback = candidate;
      if (isCompatible(candidate)) {
        entry = candidate;
        break;
      }
    }
    // 古いCSVなどsource列が空の問題だけは、同じ本文・解答の候補へフォールバックする。
    if (!entry && !currentSource) entry = fallback;
  }
  return entry;
}

async function renderStudySources(q) {
  const panel = document.getElementById('study-source');
  const content = document.getElementById('study-source-content');
  if (!panel || !content || !q) return;

  const expectedQid = q.id;
  const manifest = state.sourceManifest;
  const entry = findSourceQuestionEntry(q);
  const rawSource = (q.source || (entry && entry.sourceText) || '').trim();
  const parts = [];

  if (rawSource) {
    parts.push(`<div class="source-raw">${escapeHtml(rawSource)}</div>`);
  }

  if (!manifest) {
    parts.push('<div class="source-unavailable">設定の「出典資料（端末内のみ）」から出典パッケージを読み込むと、原文ページとマーカーを表示できます。</div>');
  } else if (!entry || !Array.isArray(entry.references) || entry.references.length === 0) {
    parts.push('<div class="source-unavailable">この出典文字列に対応する原文ページは、読み込んだパッケージ内で特定できませんでした。上記の出典情報を参照してください。</div>');
  } else {
    entry.references.forEach((ref, i) => {
      const doc = (manifest.documents && manifest.documents[ref.documentId]) || {};
      const name = ref.documentName || doc.name || ref.documentId || '出典資料';
      const pageLabel = ref.pageLabel || (ref.page ? `PDF ${ref.page}ページ` : '該当資料');
      const candidate = ref.isCandidate ? '（原典候補）' : '';
      const previewId = `source-preview-${expectedQid.replace(/[^a-zA-Z0-9_-]/g, '_')}-${i}`;
      const openButton = doc.path
        ? `<button type="button" class="source-open-btn" data-source-path="${escapeHtml(doc.path)}" data-source-page="${Number(ref.page) || ''}" data-source-type="${escapeHtml(doc.mime || '')}">原本を開く</button>`
        : '';
      const preview = ref.previewPath
        ? `<div class="source-preview" id="${previewId}"><div class="source-preview-loading">該当ページを読み込み中...</div></div>`
        : '';
      const excerpt = ref.excerpt
        ? `<div class="source-excerpt">${renderMarkedText(ref.excerpt, ref.highlights || entry.highlights || [])}</div>`
        : '';
      parts.push(
        `<article class="source-card">` +
          `<div class="source-card-head">` +
            `<div class="source-doc-info">` +
              `<div class="source-doc-name">${escapeHtml(name)}</div>` +
              `<div class="source-page-label">${escapeHtml(pageLabel + candidate)}</div>` +
            `</div>${openButton}` +
          `</div>${preview}${excerpt}` +
        `</article>`
      );
    });
    parts.push('<div class="source-note">黄色のマーカーと抜粋は自動照合です。最終確認は「原本を開く」から行ってください。出典ファイルはこの端末内だけに保存されています。</div>');
  }

  if (!rawSource && !entry) {
    parts.push('<div class="source-unavailable">この問題には出典情報が登録されていません。</div>');
  }

  content.innerHTML = parts.join('');
  panel.hidden = false;

  if (!manifest || !entry || !Array.isArray(entry.references)) return;
  for (let i = 0; i < entry.references.length; i++) {
    const ref = entry.references[i];
    if (!ref.previewPath) continue;
    const previewId = `source-preview-${expectedQid.replace(/[^a-zA-Z0-9_-]/g, '_')}-${i}`;
    const target = document.getElementById(previewId);
    if (!target) continue;
    try {
      const rec = await dbGet(STORE_SRC, sourceRecordKey(manifest, ref.previewPath));
      const current = state.studyDeck[state.studyIdx];
      if (!current || current.id !== expectedQid || state.quiz.phase !== 'finished') return;
      if (!rec || !rec.blob) {
        target.innerHTML = '<div class="source-preview-loading">ページ画像が見つかりません</div>';
        continue;
      }
      const url = URL.createObjectURL(rec.blob);
      state.sourceObjectUrls.push(url);
      const boxes = (ref.boxes || []).map(b => {
        const left = Math.max(0, Math.min(100, Number(b.x) * 100));
        const top = Math.max(0, Math.min(100, Number(b.y) * 100));
        const width = Math.max(0.2, Math.min(100 - left, Number(b.w) * 100));
        const height = Math.max(0.2, Math.min(100 - top, Number(b.h) * 100));
        return `<span class="source-marker" style="left:${left.toFixed(3)}%;top:${top.toFixed(3)}%;width:${width.toFixed(3)}%;height:${height.toFixed(3)}%"></span>`;
      }).join('');
      target.innerHTML = `<img src="${url}" alt="${escapeHtml((ref.documentName || '出典') + ' ' + (ref.pageLabel || ''))}" loading="lazy">${boxes}`;
    } catch (e) {
      console.warn('source preview load failed', e);
      target.innerHTML = '<div class="source-preview-loading">ページ画像を読み込めませんでした</div>';
    }
  }
}

async function openLocalSourceFile(path, page, mime) {
  const manifest = state.sourceManifest;
  if (!manifest || !path) return;
  const popup = window.open('', '_blank');
  if (!popup) {
    toast('ポップアップを許可してから、もう一度開いてください');
    return;
  }
  try {
    popup.document.title = '出典を読み込み中';
    popup.document.body.textContent = '出典を読み込み中...';
    const rec = await dbGet(STORE_SRC, sourceRecordKey(manifest, path));
    if (!rec || !rec.blob) throw new Error('出典ファイルが見つかりません');
    const url = URL.createObjectURL(rec.blob);
    const isPdf = (mime || rec.mime || '').includes('pdf') || /\.pdf$/i.test(path);
    popup.location.href = isPdf && page ? `${url}#page=${Number(page)}` : url;
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10 * 60 * 1000);
  } catch (e) {
    try { popup.close(); } catch (ignore) {}
    toast('出典を開けません: ' + e.message);
  }
}

// 丸数字 ⇔ 整数
// 丸数字 ①〜㊿ (1〜50)
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿';
function circledToNum(s) {
  const i = CIRCLED.indexOf((s || '').trim());
  return i >= 0 ? i + 1 : null;
}
function numToCircled(n) {
  return (n >= 1 && n <= CIRCLED.length) ? CIRCLED[n - 1] : String(n);
}
// 丸数字にマッチする正規表現（①-㊿）
const RE_CIRCLED = /([①-⑳㉑-㊿])/;
const RE_CIRCLED_SPLIT = /([①-⑳㉑-㊿])\s*[:：]?\s*([^①-⑳㉑-㊿]*)/g;

// 解答モード用: 問題文の穴と解答を対応づけて [{label, answer}] を返す。穴が無ければnull。
function parseQuizBlanks(question, answer) {
  const matches = [...(question || '').matchAll(/【([^】]*)】/g)];
  const numBlanks = matches.length;
  if (numBlanks === 0) return null;

  // 解答を ①②… マーカーで分割（①〜㊿ 対応）
  const parts = {};
  let hasMarkers = false;
  const re = new RegExp(RE_CIRCLED_SPLIT.source, 'g');
  let m;
  while ((m = re.exec(answer || '')) !== null) {
    const n = circledToNum(m[1]);
    if (n) { parts[n] = (m[2] || '').replace(/^[\s　]+|[\s　]+$/g, ''); hasMarkers = true; }
  }

  const out = [];
  for (let i = 0; i < numBlanks; i++) {
    const inner = (matches[i][1] || '').trim();
    const blankNum = circledToNum(inner) || (i + 1);
    let ans;
    if (hasMarkers && parts[blankNum] !== undefined) {
      ans = parts[blankNum];
    } else if (numBlanks === 1) {
      ans = (answer || '').trim();
    } else {
      ans = (parts[blankNum] !== undefined) ? parts[blankNum] : (answer || '').trim();
    }
    out.push({ label: inner || numToCircled(i + 1), answer: ans });
  }
  return out;
}

// 比較用の正規化(全半角・大小・空白・カンマを吸収)
function normalizeAns(s) {
  let t = (s || '');
  try { t = t.normalize('NFKC'); } catch (e) {}
  return t.toLowerCase().replace(/[\s　]+/g, '').replace(/[、,，]/g, '').trim();
}
function stripParens(s) {
  return (s || '').replace(/[(（][^)）]*[)）]/g, '');
}
// 入力が正解かどうか(完全一致 or 括弧書きを除いた一致)
function judgeAnswer(input, expected) {
  const ni = normalizeAns(input);
  if (!ni) return false;
  const ne = normalizeAns(expected);
  if (ni === ne) return true;
  const ne2 = normalizeAns(stripParens(expected));
  if (ne2 && ni === ne2) return true;
  return false;
}

// CSVのQ&A1列形式 → 内部形式 {question, answer}
// 例: "【業績】や【事業活動】を【コンプライアンス】に..." →
//     question: "【①】や【②】を【③】に...", answer: "① 業績　② 事業活動　③ コンプライアンス"
//     単一穴 "基準価格は【10.82】円" → question: "基準価格は【】円", answer: "10.82"
function parseQACell(qa) {
  const text = (qa || '').trim();
  if (!text) return null;
  const matches = [...text.matchAll(/【([^】]*)】/g)];
  if (matches.length === 0) {
    // 穴が無い → 問題文のみ。解答として問題文全体をセット（スキップされないよう）
    return { question: text, answer: text };
  }
  const blanks = [];
  if (matches.length === 1) {
    const question = text.replace(/【([^】]*)】/, (m, inner) => { blanks.push(inner.trim()); return '【】'; });
    return { question, answer: blanks[0] };
  }
  const question = text.replace(/【([^】]*)】/g, (m, inner) => { blanks.push(inner.trim()); return `【${numToCircled(blanks.length)}】`; });
  const answer = blanks.map((b, i) => `${numToCircled(i + 1)} ${b}`).join('　');
  return { question, answer };
}

// 内部形式 → Q&A1列形式(エクスポート用)
function buildQACell(question, answer) {
  const blanks = parseQuizBlanks(question, answer);
  if (!blanks || blanks.length === 0) return question || '';
  let i = 0;
  return (question || '').replace(/【[^】]*】/g, () => {
    const b = blanks[i++];
    return `【${b ? b.answer : ''}】`;
  });
}


function uid(prefix = 'q') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
// 問題文+解答の内容ハッシュ。これが変わった=内容が編集された とみなし、進捗をリセットする。
// タグ・重要度・出典・年度だけの変更ではハッシュは変わらない(学習する中身は同じため)。
function contentHash(q) {
  const str = (q.question || '') + '\u0000' + (q.answer || '');
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function cardStatus(q, p) {
  const states = getBlankStates(q);
  if (states.length && states.every(s => s.st === 'mastered')) return 'mastered';
  if (states.some(s => s.prog && s.prog.lapses >= 4 && s.prog.interval < 7 && !s.prog.mastered)) return 'leech';
  const studied = states.some(s => s.prog);
  if (states.some(s => s.st === 'new')) return studied ? 'learning' : 'new';
  return 'review';
}
// 習得済み穴数 / 全穴数
function masteryRatio(q) {
  const states = getBlankStates(q);
  const m = states.filter(s => s.st === 'mastered').length;
  return { mastered: m, total: states.length };
}

// ============================================
// Loading & init
// ============================================
async function init() {
  await openDB();
  await loadSettings();
  state.sourceManifest = await metaGet('sourceManifest');
  applyTheme();
  applyFontSize();

  // Load existing
  state.questions = await dbGetAll(STORE_Q);
  const progArr = await dbGetAll(STORE_P);
  state.progress = {};
  for (const p of progArr) state.progress[p.questionId] = p;

  // Initial seed if empty
  if (state.questions.length === 0) {
    await loadSeed(false);
  }

  // 旧 per-question 進捗 → 穴ごと進捗へマイグレーション(履歴を保持)
  await migrateProgressToPerBlank();

  // Reset today's counters if new day
  await resetTodayIfNeeded();

  // バージョン確認: 更新があれば「学習履歴は保持されています」と通知
  await checkVersionAndNotify();

  // Wire UI
  bindEvents();

  // Initial render
  renderHome();

  // Hide loader
  document.getElementById('loader').remove();
  document.getElementById('app').hidden = false;
}

// 全問題について、現在有効な穴キー集合に含まれない進捗レコードを一括削除。
// (解answ変更・穴削除・問題削除で不要になった古い進捗を掃除)
async function pruneAllOrphanProgress() {
  const valid = new Set();
  for (const q of state.questions) {
    for (const s of getBlankStates(q)) valid.add(s.key);
  }
  const delKeys = Object.keys(state.progress).filter(k => !valid.has(k));
  if (delKeys.length === 0) return;
  for (const k of delKeys) delete state.progress[k];
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_P, 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    const s = t.objectStore(STORE_P);
    for (const k of delKeys) s.delete(k);
  });
}

// 指定問題の「今の穴キー集合」に含まれない、その問題ぶらさがりの進捗を削除。
// 解答が変わった/削除された穴の古い進捗を掃除し、残った穴の履歴は保持する。
async function pruneOrphanBlankProgress(q) {
  const valid = new Set(getBlankStates(q).map(s => s.key));
  const prefix = q.id + '#';
  for (const k of Object.keys(state.progress)) {
    if (k === q.id || (k.startsWith(prefix) && !valid.has(k))) {
      await dbDel(STORE_P, k);
      delete state.progress[k];
    }
  }
}

// 旧形式の進捗を新形式(解答内容ベースの穴キー)へ移行。履歴を保持する。
//  - "id"(問題ごと)        → 各穴へ複製
//  - "id#0","id#1"(位置ベース) → 解答内容ベースのキーへ付け替え
async function migrateProgressToPerBlank() {
  const allKeys = Object.keys(state.progress);
  const qById = {};
  for (const q of state.questions) qById[q.id] = q;

  const toAdd = [];
  const toDel = [];

  const copyInto = (np, old) => {
    np.ease = old.ease; np.interval = old.interval; np.reps = old.reps;
    np.lapses = old.lapses; np.due = old.due; np.lastReviewed = old.lastReviewed;
    np.totalReviews = old.totalReviews; np.history = old.history || [];
    np.mastered = old.mastered != null ? old.mastered : (old.interval >= 21);
    np.fastStreak = old.fastStreak != null ? old.fastStreak : (np.mastered ? MASTER_STREAK : 0);
  };

  for (const key of allKeys) {
    const hashPos = key.indexOf('#');
    if (hashPos < 0) {
      // 旧·問題ごと進捗 → 全穴へ複製
      const q = qById[key];
      if (!q) continue;
      for (const s of getBlankStates(q)) {
        if (state.progress[s.key]) continue;
        const np = newProgress(s.key); copyInto(np, state.progress[key]);
        toAdd.push(np);
      }
      toDel.push(key);
    } else {
      // 既に '#' を含む = 穴キー。位置ベース(id#数字)なら解答ベースへ付け替え。
      const suffix = key.slice(hashPos + 1);
      if (/^\d+$/.test(suffix)) {
        const qid = key.slice(0, hashPos);
        const q = qById[qid];
        if (!q) { toDel.push(key); continue; }
        const states = getBlankStates(q);
        const idx = Number(suffix);
        const st = states[idx];
        if (st && !state.progress[st.key]) {
          const np = newProgress(st.key); copyInto(np, state.progress[key]);
          toAdd.push(np);
        }
        toDel.push(key);
      }
      // それ以外(既に解答ベース)はそのまま
    }
  }
  for (const np of toAdd) { state.progress[np.questionId] = np; await dbPut(STORE_P, np); }
  for (const key of toDel) { delete state.progress[key]; await dbDel(STORE_P, key); }
}

// アプリバージョン管理: 更新検出と履歴保護通知
async function checkVersionAndNotify() {
  const storedVersion = await metaGet('appVersion');
  if (storedVersion && storedVersion !== APP_VERSION) {
    // バージョンが変わった = アプリが更新された
    // IndexedDB のデータ(問題・進捗)は一切触れていないので安全
    setTimeout(() => toast('✓ アプリが更新されました。学習履歴は保持されています'), 2000);
  }
  await metaSet('appVersion', APP_VERSION);
}

async function loadSettings() {
  const saved = await metaGet('settings');
  if (saved) state.settings = { ...state.settings, ...saved };
}
async function saveSettings() {
  await metaSet('settings', state.settings);
}

async function resetTodayIfNeeded() {
  const today = dateKey();
  const m = await metaGet('todayCounters');
  if (!m || m.date !== today) {
    state.todaySeen = { new: 0, rev: 0 };
    await metaSet('todayCounters', { date: today, ...state.todaySeen });
  } else {
    state.todaySeen = { new: m.new || 0, rev: m.rev || 0 };
  }
  state.todayKey = today;
}
async function bumpTodayCounter(kind) {
  state.todaySeen[kind] = (state.todaySeen[kind] || 0) + 1;
  await metaSet('todayCounters', { date: state.todayKey, ...state.todaySeen });
}

function applyTheme() {
  const t = state.settings.theme || 'auto';
  document.documentElement.dataset.theme = t;
}
function applyFontSize() {
  const fs = state.settings.fontSize || 'm';
  document.documentElement.dataset.fontsize = fs;
  // 出題中フォントボタンのアクティブ状態を同期
  document.querySelectorAll('.btn-font-size').forEach(b => {
    b.classList.toggle('active', b.dataset.fs === fs);
  });
}

async function loadSeed(merge = true) {
  // seed.jsonはfetch不要（file://でCORSエラーになるため）
  // 問題はCSVインポートまたはアプリ内の編集で追加する
  const questions = [];  // 初期問題なし
  let added = 0;
  for (const q of questions) {
    if (merge && state.questions.find(x => x.id === q.id)) continue;
    const rec = {
      id: q.id || uid(),
      category: q.category || 'common',
      tags: q.tags || [],
      source: q.source || '',
      year: q.year || null,
      importance: q.importance || 3,
      question: q.question || '',
      answer: q.answer || '',
      createdAt: q.createdAt || new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    };
    rec.contentHash = contentHash(rec);
    await dbPut(STORE_Q, rec);
    const idx = state.questions.findIndex(x => x.id === rec.id);
    if (idx >= 0) state.questions[idx] = rec; else state.questions.push(rec);
    added++;
  }
}

// ============================================
// Toast & modal
// ============================================
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function confirm(msg) {
  return new Promise((resolve) => {
    const m = document.getElementById('modal');
    document.getElementById('modal-msg').textContent = msg;
    m.hidden = false;
    const ok = document.getElementById('modal-ok');
    const cn = document.getElementById('modal-cancel');
    function done(v) {
      m.hidden = true;
      ok.removeEventListener('click', okH);
      cn.removeEventListener('click', cnH);
      resolve(v);
    }
    function okH() { done(true); }
    function cnH() { done(false); }
    ok.addEventListener('click', okH);
    cn.addEventListener('click', cnH);
  });
}

// ============================================
// View routing
// ============================================
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  window.scrollTo(0, 0);
}

// ============================================
// HOME view
// ============================================
function getDeckCounts(catFilter) {
  let due = 0, newq = 0;
  for (const q of state.questions) {
    if (catFilter !== 'all' && q.category !== catFilter) continue;
    const states = getBlankStates(q);
    const hasDue = states.some(s => s.st === 'due');
    const hasNew = states.some(s => s.st === 'new');
    if (hasDue) due++;
    else if (hasNew) newq++;
  }
  return { due, newq };
}

function getWrongCount(catFilter) {
  let n = 0;
  for (const q of state.questions) {
    if (catFilter !== 'all' && q.category !== catFilter) continue;
    const states = getBlankStates(q);
    if (states.some(s => s.prog && !s.prog.mastered && s.prog.lapses >= 1 && s.prog.interval < 14)) n++;
  }
  return n;
}

function renderHome() {
  // Category chips
  document.querySelectorAll('#view-home .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.cat === state.selectedCat);
  });
  // Counts
  const { due, newq } = getDeckCounts(state.selectedCat);
  document.getElementById('num-due').textContent = due;
  document.getElementById('num-new').textContent = newq;
  const heroTotal = due + newq;
  const heroEl = document.getElementById('hero-total');
  if (heroEl) heroEl.textContent = heroTotal;

  // Streak
  document.getElementById('num-streak').textContent = computeStreak();

  // Sub labels
  document.getElementById('btn-review-sub').textContent = `期日が来た問題 (${due}問)`;
  document.getElementById('btn-new-sub').textContent = `未学習の問題 (${newq}問)`;
  const wrongN = getWrongCount(state.selectedCat);
  document.getElementById('btn-wrong-sub').textContent = `直近で × にした問題 (${wrongN}問)`;

  // Cat stats line
  const cs = document.getElementById('cat-stats');
  if (state.selectedCat === 'all') {
    const lines = ['common','solution','engineering'].map(c => {
      const cnt = state.questions.filter(q => q.category === c).length;
      const dc = getDeckCounts(c);
      return `<span>${CATS[c]} ${cnt}問 (本日${dc.due+dc.newq})</span>`;
    });
    cs.innerHTML = lines.join('・');
  } else {
    cs.innerHTML = '';
  }

  // Exam countdown
  if (state.settings.examDate) {
    const d = daysBetween(new Date(), new Date(state.settings.examDate));
    const html = d > 0
      ? `試験まで <strong>${d}</strong> 日`
      : (d === 0 ? '<strong>本日が試験日です</strong>' : `試験日から ${-d} 日経過`);
    document.getElementById('exam-countdown').innerHTML = html;
  } else {
    document.getElementById('exam-countdown').textContent = '';
  }

  // Session size buttons
  document.querySelectorAll('.opt[data-size]').forEach(o => {
    o.classList.toggle('active', Number(o.dataset.size) === state.selectedSize);
  });
}

function computeStreak() {
  // Count consecutive days with at least 1 review, working backward from today.
  // Build set of dates from progress histories.
  const dates = new Set();
  for (const qid in state.progress) {
    for (const h of (state.progress[qid].history || [])) {
      if (h && h.d) dates.add(h.d);
    }
  }
  let streak = 0;
  let cur = startOfDay();
  // If today not present, streak starts from yesterday backwards.
  while (true) {
    const k = cur.toISOString().slice(0,10);
    if (dates.has(k)) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    } else if (streak === 0) {
      // allow today not to break streak -> roll back once
      cur.setDate(cur.getDate() - 1);
      const k2 = cur.toISOString().slice(0,10);
      if (dates.has(k2)) { streak++; cur.setDate(cur.getDate() - 1); }
      else break;
    } else {
      break;
    }
  }
  return streak;
}

// ============================================
// Build study decks
// ============================================
function buildDeck(mode) {
  const today = startOfDay();
  const cat = state.selectedCat;
  const size = state.selectedSize;
  const newCap = Math.max(0, state.settings.newPerDay - state.todaySeen.new);
  const revCap = Math.max(0, state.settings.revPerDay - state.todaySeen.rev);

  const filterCat = (q) => cat === 'all' || q.category === cat;

  const dueList = [];
  const newList = [];
  const wrongList = [];

  // 各問題の穴状態で分類: dueな穴があれば復習、無くてnewな穴があれば新規
  const earliestDue = {};  // ソート用: 問題内で最も早いdue穴の期日
  for (const q of state.questions) {
    if (!filterCat(q)) continue;
    const states = getBlankStates(q);
    const hasDue = states.some(s => s.st === 'due');
    const hasNew = states.some(s => s.st === 'new');
    const hasWrong = states.some(s => s.prog && !s.prog.mastered && s.prog.lapses >= 1 && s.prog.interval < 14);
    if (hasDue) {
      dueList.push(q);
      const dues = states.filter(s => s.st === 'due' && s.prog).map(s => new Date(s.prog.due).getTime());
      earliestDue[q.id] = dues.length ? Math.min(...dues) : 0;
    } else if (hasNew) {
      newList.push(q);
    }
    if (hasWrong) wrongList.push(q);
  }

  // Sort due by oldest due first, then importance desc
  dueList.sort((a, b) => {
    const d = (earliestDue[a.id] || 0) - (earliestDue[b.id] || 0);
    if (d !== 0) return d;
    return (b.importance || 3) - (a.importance || 3);
  });
  // Sort new by importance desc, then created
  newList.sort((a, b) => {
    const ai = (b.importance || 3) - (a.importance || 3);
    if (ai !== 0) return ai;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  // Sort wrong by total lapses across blanks desc
  const totalLapses = (q) => getBlankStates(q).reduce((s, x) => s + (x.prog ? x.prog.lapses : 0), 0);
  wrongList.sort((a, b) => totalLapses(b) - totalLapses(a));

  let deck = [];
  if (mode === 'review') {
    deck = shuffle(dueList.slice(0, revCap));
  } else if (mode === 'new') {
    deck = shuffle(newList.slice(0, newCap));
  } else if (mode === 'wrong') {
    deck = shuffle(wrongList);
  } else if (mode === 'mixed') {
    // Interleave new + due according to mixRatio
    const [nr, rr] = state.settings.mixRatio.split(':').map(Number);
    const target = size > 0 ? size : (dueList.length + newList.length);
    const nN = Math.min(newList.length, newCap, Math.floor(target * nr / (nr + rr)));
    const rN = Math.min(dueList.length, revCap, target - nN);
    const news = shuffle(newList.slice(0, nN));
    const revs = shuffle(dueList.slice(0, rN));
    deck = interleave(revs, news);
  }
  if (size > 0 && deck.length > size) deck = deck.slice(0, size);
  return deck;
}

function interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  // light shuffle within blocks of 3 for variety
  for (let i = 0; i < out.length; i += 3) {
    const block = out.slice(i, i + 3);
    const sh = shuffle(block);
    for (let j = 0; j < block.length; j++) out[i + j] = sh[j];
  }
  return out;
}

// ============================================
// STUDY view
// ============================================
function startStudy(mode) {
  const deck = buildDeck(mode);
  if (deck.length === 0) {
    toast('対象の問題がありません');
    return;
  }
  state.studyDeck = deck;
  state.studyIdx = 0;
  state.studyStats = { again: 0, hard: 0, good: 0, easy: 0, total: 0, mode };
  renderStudy();
  showView('view-study');
  if (state.settings.ttsAuto) state.ttsEnabled = true;
}

function renderStudy() {
  clearRenderedSourceAssets();
  const total = state.studyDeck.length;
  const idx = state.studyIdx;
  document.getElementById('progress-fill').style.width = `${(idx / total * 100)}%`;
  document.getElementById('progress-text').textContent = `${idx + 1} / ${total}`;

  const q = state.studyDeck[idx];

  // Meta
  const meta = [];
  meta.push(`<span class="meta-cat">${CATS[q.category] || q.category}</span>`);
  if (q.importance) {
    const stars = '★'.repeat(q.importance);
    meta.push(`<span class="meta-imp">${stars}</span>`);
  }
  if (q.year) meta.push(`<span>(${q.year}年度)</span>`);
  if (q.author) meta.push(`<span class="meta-author">作:${escapeHtml(q.author)}</span>`);
  document.getElementById('study-meta').innerHTML = meta.join(' ');

  document.getElementById('study-question').innerHTML = renderBlanks(q.question);
  const ansEl = document.getElementById('study-answer');
  ansEl.innerHTML = renderAnswer(q.answer);
  ansEl.hidden = true;
  const sourceEl = document.getElementById('study-source');
  sourceEl.hidden = true;
  document.getElementById('study-source-content').innerHTML = '';

  // Reset all action elements
  document.getElementById('btn-show-answer').hidden = true;
  document.getElementById('btn-quiz-judge').hidden = true;
  document.getElementById('btn-quiz-next').hidden = true;
  document.getElementById('btn-quiz-manual').hidden = true;
  document.getElementById('rating-grid').hidden = true;
  document.getElementById('quiz-area').hidden = true;
  document.getElementById('quiz-feedback').hidden = true;

  // この問題で今学習すべき穴(new/due)。mastered/waitは出題しない。
  // ただし「間違えた問題」モードでは、期日前でも直近の誤答穴を出題対象に含める。
  const isWrongMode = state.studyStats && state.studyStats.mode === 'wrong';
  const active = isWrongMode ? qWrongFocusBlanks(q) : qActiveBlanks(q);
  const hadNew = active.some(s => s.st === 'new');
  state.quiz = {
    q, active, idx: 0, results: [], hadNew,
    finished: false, phase: 'input', blankStart: 0,
    masteredNow: [],
  };

  if (active.length > 0) {
    // 解答モード: 穴ごとに入力・判定
    renderQuizBlank();
  } else {
    // 出題対象の穴が無い(全穴習得済み等)。念のため答えを表示して次へ。
    const ansEl = document.getElementById('study-answer');
    ansEl.hidden = false;
    ansEl.innerHTML = `<div class="quiz-summary all-ok">この問題は学習対象の穴がありません</div>` + renderAnswer(q.answer);
    state.quiz.phase = 'finished';
    const nextBtn = document.getElementById('btn-quiz-next');
    nextBtn.hidden = false;
    nextBtn.textContent = (state.studyIdx >= state.studyDeck.length - 1) ? '完了' : '次の問題へ';
    renderStudySources(q);
  }

  // TTS auto
  stopTTS();
  if (state.ttsEnabled) speakNow(q.question);
  document.getElementById('btn-tts').textContent = state.ttsEnabled ? '🔇' : '🔊';
}

// 解答モード: 現在の穴の入力欄を表示
function renderQuizBlank() {
  const { active, idx } = state.quiz;
  const b = active[idx];
  state.quiz.phase = 'input';
  state.quiz.blankStart = Date.now();
  stopMic();
  document.getElementById('quiz-area').hidden = false;
  const labelEl = document.getElementById('quiz-blank-label');
  const totalBlanks = getBlanks(state.quiz.q).length;
  labelEl.innerHTML = (totalBlanks > 1)
    ? `<span class="qbl-num">${escapeHtml(b.label)}</span> の解答 <span class="qbl-count">(${idx + 1}/${active.length})</span>`
    : `解答を入力`;
  const input = document.getElementById('quiz-input');
  input.value = '';
  input.readOnly = false;
  input.classList.remove('correct', 'incorrect');
  document.getElementById('quiz-feedback').hidden = true;
  document.getElementById('btn-quiz-judge').hidden = false;
  document.getElementById('btn-quiz-next').hidden = true;
  document.getElementById('btn-quiz-manual').hidden = true;
  document.getElementById('rating-grid').hidden = true;
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
}

// 1穴の自動SM-2評価: 不正解→1 / 速い正解→4 / 普通→3 / 遅い正解→2
function rateBlankAuto(correct, elapsedSec) {
  if (!correct) return 1;
  if (elapsedSec <= BLANK_FAST_SEC) return 4;
  if (elapsedSec <= BLANK_SLOW_SEC) return 3;
  return 2;
}

// 解答モード: 現在の穴を判定(SM-2適用は次へ進む時=commitBlankでOverride反映後)
function judgeQuizBlank() {
  if (state.quiz.phase !== 'input') return;
  const { active, idx, blankStart } = state.quiz;
  const b = active[idx];
  const input = document.getElementById('quiz-input');
  const correct = judgeAnswer(input.value, b.answer);
  const elapsedSec = Math.max(0.1, (Date.now() - blankStart) / 1000);
  state.quiz.results[idx] = { correct, elapsedSec };
  state.quiz.phase = 'judged';

  input.readOnly = true;
  input.classList.add(correct ? 'correct' : 'incorrect');

  const fb = document.getElementById('quiz-feedback');
  fb.hidden = false;
  fb.className = 'quiz-feedback ' + (correct ? 'fb-correct' : 'fb-incorrect');
  fb.innerHTML = correct
    ? `<span class="fb-mark">✓</span> 正解 <span class="fb-time">${elapsedSec.toFixed(1)}秒</span>`
    : `<span class="fb-mark">✗</span> 不正解　<span class="fb-correct-ans">正解: ${escapeHtml(b.answer)}</span>`
      + ` <button class="fb-override" id="fb-override">やっぱり正解だった</button>`;

  if (!correct) {
    const ov = document.getElementById('fb-override');
    if (ov) ov.addEventListener('click', () => {
      state.quiz.results[idx] = { correct: true, elapsedSec };
      input.classList.remove('incorrect');
      input.classList.add('correct');
      fb.className = 'quiz-feedback fb-correct';
      fb.innerHTML = `<span class="fb-mark">✓</span> 正解にしました`;
    });
  }

  document.getElementById('btn-quiz-judge').hidden = true;
  document.getElementById('btn-quiz-next').hidden = false;
  const isLast = idx >= active.length - 1;
  document.getElementById('btn-quiz-next').textContent = isLast ? '結果を見る' : '次の穴へ';

  if (state.ttsEnabled) speakNow(b.answer);
}

// 1穴の結果を確定(SM-2 + 習得判定 + 保存)
async function commitBlank(idx) {
  const r = state.quiz.results[idx];
  if (!r || r.committed) return;
  r.committed = true;
  const b = state.quiz.active[idx];
  const key = b.key;
  let bp = state.progress[key] || newProgress(key);
  const rating = rateBlankAuto(r.correct, r.elapsedSec);
  bp = applySM2(bp, rating);
  // 連続高速正解の更新と習得卒業
  if (r.correct && r.elapsedSec <= BLANK_FAST_SEC) bp.fastStreak = (bp.fastStreak || 0) + 1;
  else bp.fastStreak = 0;
  if (bp.fastStreak >= MASTER_STREAK) {
    if (!bp.mastered) state.quiz.masteredNow.push(b.label || (b.i + 1));
    bp.mastered = true;
  }
  state.progress[key] = bp;
  await dbPut(STORE_P, bp);
}

// 解答モード: 次の穴 or 全完了
async function nextQuizBlank() {
  if (state.quiz.phase === 'finished') {
    goNextQuestion();
    return;
  }
  await commitBlank(state.quiz.idx);
  if (state.quiz.idx < state.quiz.active.length - 1) {
    state.quiz.idx += 1;
    renderQuizBlank();
  } else {
    await finishQuizQuestion();
  }
}

// 解答モード: 全穴判定後のサマリ。問題単位の評価は廃止(穴ごとに確定済み)。
async function finishQuizQuestion() {
  const { active, results, q, hadNew, masteredNow } = state.quiz;
  state.quiz.phase = 'finished';
  const correctCount = results.filter(r => r && r.correct).length;
  const allCorrect = correctCount === active.length;

  // 日次カウンタは問題ごとに1回(穴数では数えない)
  if (hadNew) await bumpTodayCounter('new');
  else await bumpTodayCounter('rev');

  // セッション統計(問題単位)
  state.studyStats.total += 1;
  if (allCorrect) state.studyStats.good += 1; else state.studyStats.again += 1;

  // 解答全文 + サマリ表示
  const ansEl = document.getElementById('study-answer');
  ansEl.hidden = false;
  const head = active.length > 1 ? `${active.length}問中 ${correctCount}問正解` : (allCorrect ? '正解' : '不正解');
  let summary = `<div class="quiz-summary ${allCorrect ? 'all-ok' : 'some-ng'}">${head}</div>`;
  if (masteredNow && masteredNow.length) {
    summary += `<div class="quiz-mastered">🎓 ${masteredNow.length}個の穴を習得（以後出題されません）</div>`;
  }
  // 残りの穴状況
  const ratio = masteryRatio(q);
  summary += `<div class="quiz-autorate">この問題の習得 <strong>${ratio.mastered}/${ratio.total}</strong> 穴</div>`;
  ansEl.innerHTML = summary + renderAnswer(q.answer);
  renderStudySources(q);

  document.getElementById('quiz-area').hidden = true;
  document.getElementById('btn-quiz-judge').hidden = true;
  document.getElementById('btn-quiz-manual').hidden = true;
  document.getElementById('rating-grid').hidden = true;
  const nextBtn = document.getElementById('btn-quiz-next');
  nextBtn.hidden = false;
  nextBtn.textContent = (state.studyIdx >= state.studyDeck.length - 1) ? '完了' : '次の問題へ';
}

// 次の問題へ進む(共通)
function goNextQuestion() {
  state.studyIdx += 1;
  if (state.studyIdx >= state.studyDeck.length) {
    finishStudy();
  } else {
    renderStudy();
  }
}

function finishStudy() {
  stopTTS();
  const s = state.studyStats;
  const acc = s.total ? Math.round(((s.good + s.easy) / s.total) * 100) : 0;
  document.getElementById('done-title').textContent = `${s.total}問完了!`;
  document.getElementById('done-stats').innerHTML =
    `正解率 <strong>${acc}%</strong><br>` +
    `<span style="color:var(--again)">●</span> もう一度 ${s.again}　` +
    `<span style="color:var(--hard)">●</span> 難 ${s.hard}<br>` +
    `<span style="color:var(--good)">●</span> 普通 ${s.good}　` +
    `<span style="color:var(--easy)">●</span> 簡単 ${s.easy}`;
  showView('view-done');
}

// ============================================
// TTS
// ============================================
function speakNow(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.0;
    state.utterance = u;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}
function stopTTS() {
  try { speechSynthesis.cancel(); } catch (e) {}
}
function toggleTTS() {
  state.ttsEnabled = !state.ttsEnabled;
  document.getElementById('btn-tts').textContent = state.ttsEnabled ? '🔇' : '🔊';
  if (state.ttsEnabled) {
    const q = state.studyDeck[state.studyIdx];
    const ansVisible = !document.getElementById('study-answer').hidden;
    speakNow(ansVisible ? q.answer : q.question);
  } else {
    stopTTS();
  }
}

// ============================================
// LIST view
// ============================================
function renderList() {
  // Counts
  document.getElementById('cnt-all').textContent = state.questions.length;
  for (const c of ['common','solution','engineering']) {
    document.getElementById('cnt-' + c).textContent =
      state.questions.filter(q => q.category === c).length;
  }
  document.querySelectorAll('#view-list .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.listcat === state.listCat);
  });

  let items = state.questions.slice();
  if (state.listCat !== 'all') items = items.filter(q => q.category === state.listCat);
  if (state.listStatus !== 'all') {
    items = items.filter(q => cardStatus(q) === state.listStatus);
  }
  if (state.listSearch) {
    const s = state.listSearch.toLowerCase();
    items = items.filter(q => {
      return (q.question || '').toLowerCase().includes(s)
          || (q.answer || '').toLowerCase().includes(s)
          || (q.source || '').toLowerCase().includes(s)
          || (q.tags || []).some(t => t.toLowerCase().includes(s));
    });
  }

  // Sort
  const earliestDueOf = (q) => {
    const ds = getBlankStates(q).filter(s => s.prog && s.prog.due && !s.prog.mastered)
      .map(s => new Date(s.prog.due).getTime());
    return ds.length ? Math.min(...ds) : Infinity;
  };
  const totalLapsesOf = (q) => getBlankStates(q).reduce((s, x) => s + (x.prog ? x.prog.lapses : 0), 0);
  const sortFn = {
    created: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    importance: (a, b) => (b.importance || 0) - (a.importance || 0),
    due: (a, b) => earliestDueOf(a) - earliestDueOf(b),
    lapses: (a, b) => totalLapsesOf(b) - totalLapsesOf(a),
  };
  items.sort(sortFn[state.listSort] || sortFn.created);

  const ul = document.getElementById('question-list');
  if (items.length === 0) {
    ul.innerHTML = '<li class="q-empty">該当する問題がありません<br>右上の「＋」から追加できます</li>';
    return;
  }
  ul.innerHTML = items.map(q => {
    const status = cardStatus(q);
    const statusLabel = {new:'未学習', learning:'学習中', review:'復習中', mastered:'習得', leech:'苦手'}[status];
    const stars = '★'.repeat(q.importance || 0);
    const ratio = masteryRatio(q);
    const earliest = earliestDueOf(q);
    let due;
    if (status === 'mastered') due = `習得 ${ratio.mastered}/${ratio.total}`;
    else if (earliest === Infinity) due = `未学習 (習得${ratio.mastered}/${ratio.total})`;
    else due = `${fmtDue(new Date(earliest))} (習得${ratio.mastered}/${ratio.total})`;
    const author = q.author ? `<span class="q-author">作:${escapeHtml(q.author)}</span>` : '';
    return `<li class="q-item" data-qid="${escapeHtml(q.id)}">
      <div class="q-item-head">
        <span class="q-cat-badge">${CATS[q.category] || q.category}</span>
        <span class="q-status q-status-${status}">${statusLabel}</span>
        <span class="q-importance">${stars}</span>
        ${author}
        <span style="margin-left:auto" class="q-due">${escapeHtml(due)}</span>
      </div>
      <div class="q-text">${escapeHtml(q.question)}</div>
    </li>`;
  }).join('');
  ul.querySelectorAll('.q-item').forEach(el => {
    el.addEventListener('click', () => openEditor(el.dataset.qid));
  });
}

// ============================================
// EDITOR view
// ============================================
function openEditor(qid) {
  state.editingId = qid;
  const q = qid ? state.questions.find(x => x.id === qid) : null;
  document.getElementById('edit-title').textContent = q ? '問題を編集' : '問題を追加';
  document.getElementById('btn-edit-delete').hidden = !q;
  state.editingCat = q ? q.category : 'common';
  state.editingImp = q ? (q.importance || 3) : 3;
  document.querySelectorAll('.seg-opt').forEach(s => {
    s.classList.toggle('active', s.dataset.edcat === state.editingCat);
  });
  document.querySelectorAll('#ed-stars .star').forEach(s => {
    s.classList.toggle('on', Number(s.dataset.imp) <= state.editingImp);
  });
  // Q&A1列形式: 既存問題はbuildQACellで復元
  document.getElementById('ed-qa').value = q ? buildQACell(q.question, q.answer) : '';
  document.getElementById('ed-tags').value = q ? (q.tags || []).join(', ') : '';
  document.getElementById('ed-source').value = q ? (q.source || '') : '';
  document.getElementById('ed-year').value = q && q.year ? String(q.year) : '';
  document.getElementById('ed-author').value = q ? (q.author || '') : (state.settings.authorName || '');
  showView('view-edit');
}

async function saveEditor() {
  const qaRaw = document.getElementById('ed-qa').value.trim();
  if (!qaRaw) {
    toast('問題と解答は必須です');
    return;
  }
  const parsed = parseQACell(qaRaw);
  if (!parsed || !parsed.question) {
    toast('問題文を入力してください');
    return;
  }
  const qText = parsed.question;
  const aText = parsed.answer || qaRaw;  // 穴なし問題は全体を解答とする
  const tagsRaw = document.getElementById('ed-tags').value;
  const tags = tagsRaw.split(/[,、]/).map(s => s.trim()).filter(Boolean);
  const source = document.getElementById('ed-source').value.trim();
  const yearV = document.getElementById('ed-year').value;
  const year = yearV ? Number(yearV) : null;
  const author = document.getElementById('ed-author').value.trim();

  let rec;
  if (state.editingId) {
    rec = state.questions.find(x => x.id === state.editingId);
    rec.category = state.editingCat;
    rec.question = qText;
    rec.answer = aText;
    rec.tags = tags;
    rec.source = source;
    rec.year = year;
    rec.importance = state.editingImp;
    rec.author = author || rec.author || '';
    rec.modifiedAt = new Date().toISOString();
    rec.contentHash = contentHash(rec);
    // 進捗キーは解答内容に紐づくため、解答が変わった穴だけ自然に新規化される。
    // この問題のどの穴にも該当しなくなった進捗(=解答が変わった/消えた穴)を掃除する。
    await pruneOrphanBlankProgress(rec);
  } else {
    rec = {
      id: uid(),
      category: state.editingCat,
      question: qText,
      answer: aText,
      tags, source, year,
      importance: state.editingImp,
      author: author || state.settings.authorName || '',
      contentHash: contentHash({ question: qText, answer: aText }),
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    };
    state.questions.push(rec);
  }
  await dbPut(STORE_Q, rec);
  toast(state.editingId ? '保存しました' : '追加しました');
  state.editingId = null;
  const returnView = state.editingReturnView || 'view-list';
  state.editingReturnView = null;
  renderHome();
  renderList();
  if (returnView === 'view-study') {
    // 出題中に編集した場合: 問題内容が変わったので現在の問題を再描画して戻る
    renderStudy();
    showView('view-study');
  } else {
    showView('view-list');
  }
}

async function deleteEditor() {
  if (!state.editingId) return;
  const ok = await confirm('この問題を削除します。\n進捗データも削除されます。よろしいですか?');
  if (!ok) return;
  const deletedId = state.editingId;
  const returnView = state.editingReturnView || 'view-list';
  state.editingReturnView = null;
  await dbDel(STORE_Q, deletedId);
  const prefix = deletedId + '#';
  for (const k of Object.keys(state.progress)) {
    if (k === deletedId || k.startsWith(prefix)) {
      await dbDel(STORE_P, k);
      delete state.progress[k];
    }
  }
  state.questions = state.questions.filter(q => q.id !== deletedId);
  state.editingId = null;
  toast('削除しました');
  renderHome();
  renderList();
  if (returnView === 'view-study') {
    // 出題中に削除した場合: デッキからも除いて次の問題へ
    state.studyDeck = state.studyDeck.filter(q => q.id !== deletedId);
    if (state.studyDeck.length === 0) {
      finishStudy();
    } else {
      state.studyIdx = Math.min(state.studyIdx, state.studyDeck.length - 1);
      renderStudy();
      showView('view-study');
    }
  } else {
    showView('view-list');
  }
}

// ============================================
// STATS view
// ============================================
function renderStats() {
  let total = state.questions.length;
  let mastered = 0, review = 0, learning = 0, newq = 0, leech = 0;
  for (const q of state.questions) {
    const s = cardStatus(q, state.progress[q.id]);
    if (s === 'mastered') mastered++;
    else if (s === 'review') review++;
    else if (s === 'learning') learning++;
    else if (s === 'leech') leech++;
    else newq++;
  }
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-mastered').textContent = mastered;
  document.getElementById('stat-review').textContent = review;
  document.getElementById('stat-learning').textContent = learning;
  document.getElementById('stat-newq').textContent = newq;
  document.getElementById('stat-leech').textContent = leech;

  // Heatmap (last 30 days)
  const counts = {};
  for (const qid in state.progress) {
    for (const h of (state.progress[qid].history || [])) {
      counts[h.d] = (counts[h.d] || 0) + 1;
    }
  }
  const cells = [];
  const now = startOfDay();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    const n = counts[k] || 0;
    let lvl = 0;
    if (n >= 30) lvl = 4;
    else if (n >= 15) lvl = 3;
    else if (n >= 5) lvl = 2;
    else if (n >= 1) lvl = 1;
    cells.push(`<div class="heat-cell" data-level="${lvl}" title="${k}: ${n}回"></div>`);
  }
  document.getElementById('heatmap').innerHTML = cells.join('');

  // Cat progress
  const cp = document.getElementById('cat-progress');
  const html = ['common','solution','engineering'].map(c => {
    const qs = state.questions.filter(q => q.category === c);
    if (qs.length === 0) return `<div class="cat-prog-row">
      <div class="cat-prog-label"><span>${CATS[c]}</span><span>0問</span></div>
      <div class="cat-prog-bar"><div class="bar-new" style="width:100%"></div></div>
    </div>`;
    let mc=0, rc=0, lc=0, nc=0;
    for (const q of qs) {
      const s = cardStatus(q, state.progress[q.id]);
      if (s === 'mastered') mc++;
      else if (s === 'review') rc++;
      else if (s === 'learning' || s === 'leech') lc++;
      else nc++;
    }
    const t = qs.length;
    return `<div class="cat-prog-row">
      <div class="cat-prog-label"><span>${CATS[c]}</span><span>${mc}/${t} 習得</span></div>
      <div class="cat-prog-bar">
        <div class="bar-mastered" style="width:${mc/t*100}%"></div>
        <div class="bar-review" style="width:${rc/t*100}%"></div>
        <div class="bar-learning" style="width:${lc/t*100}%"></div>
        <div class="bar-new" style="width:${nc/t*100}%"></div>
      </div>
    </div>`;
  }).join('');
  cp.innerHTML = html;

  // Forecast
  if (state.settings.examDate) {
    const days = daysBetween(new Date(), new Date(state.settings.examDate));
    const remaining = total - mastered;
    const dailyCap = state.settings.newPerDay;
    const requiredPerDay = days > 0 ? Math.ceil(remaining / Math.max(days, 1)) : remaining;
    let msg = '';
    if (days <= 0) msg = '試験日を過ぎています。設定で日付を更新してください。';
    else if (remaining === 0) msg = `<strong>全${total}問が習得済み</strong>です。試験まで余裕があります(残り${days}日)。`;
    else {
      msg = `試験まで残り <strong>${days}</strong> 日<br>` +
            `未習得 <strong>${remaining}</strong> 問 / 1日上限 ${dailyCap}問<br>` +
            `1日あたり最低 <strong>${requiredPerDay}</strong> 問の新規消化が必要`;
      if (requiredPerDay > dailyCap) {
        msg += `<br><span style="color:var(--again)">⚠ 1日上限を超えています。設定で増やすか問題を絞り込みましょう。</span>`;
      }
    }
    document.getElementById('forecast').innerHTML = msg;
  } else {
    document.getElementById('forecast').textContent = '設定で試験日を入力すると、必要な学習ペースが表示されます。';
  }
}

// ============================================
// SETTINGS view
// ============================================
function renderSettings() {
  document.getElementById('set-exam-date').value = state.settings.examDate || '';
  document.getElementById('set-new-per-day').value = state.settings.newPerDay;
  document.getElementById('set-rev-per-day').value = state.settings.revPerDay;
  document.getElementById('set-mix-ratio').value = state.settings.mixRatio;
  document.getElementById('set-theme').value = state.settings.theme;
  document.getElementById('set-font-size').value = state.settings.fontSize;
  document.getElementById('set-tts-auto').checked = !!state.settings.ttsAuto;
  document.getElementById('set-author-name').value = state.settings.authorName || '';
  renderSourceLibraryStatus();
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderSourceLibraryStatus() {
  const el = document.getElementById('source-library-status');
  const removeBtn = document.getElementById('btn-remove-sources');
  if (!el || !removeBtn) return;
  const manifest = state.sourceManifest;
  if (!manifest) {
    el.textContent = '出典パッケージは未読込です';
    removeBtn.hidden = true;
    return;
  }
  const stats = manifest.stats || {};
  const mapped = Number(stats.mappedQuestions) || Object.values(manifest.questions || {})
    .filter(q => Array.isArray(q.references) && q.references.length > 0).length;
  const total = Number(stats.totalQuestions) || Object.keys(manifest.questions || {}).length;
  const date = manifest.createdAt ? new Date(manifest.createdAt).toLocaleString('ja-JP') : '日時不明';
  const size = stats.packageBytes ? ` / ${formatBytes(stats.packageBytes)}` : '';
  el.innerHTML = `<strong>${escapeHtml(manifest.name || 'S2 出典ライブラリ')}</strong><br>` +
    `原文ページ対応: ${mapped}/${total}問${size}<br>作成: ${escapeHtml(date)}`;
  removeBtn.hidden = false;
}

async function saveSettingsFromForm() {
  state.settings.examDate = document.getElementById('set-exam-date').value;
  state.settings.newPerDay = Math.max(0, Number(document.getElementById('set-new-per-day').value) || 10);
  state.settings.revPerDay = Math.max(0, Number(document.getElementById('set-rev-per-day').value) || 100);
  state.settings.mixRatio = document.getElementById('set-mix-ratio').value;
  state.settings.theme = document.getElementById('set-theme').value;
  state.settings.fontSize = document.getElementById('set-font-size').value;
  state.settings.ttsAuto = document.getElementById('set-tts-auto').checked;
  state.settings.authorName = document.getElementById('set-author-name').value.trim();
  await saveSettings();
  applyTheme();
  applyFontSize();
  toast('設定を保存しました');
}

// ============================================
// IMPORT / EXPORT
// ============================================
// iCloud Drive同期: 固定ファイル名で保存（上書き = 同期）
const ICLOUD_FILENAME = 'shoshin-study-sync.json';

async function iCloudSave() {
  const data = {
    version: 2,
    type: 'icloud-sync',
    savedAt: new Date().toISOString(),
    deviceHint: navigator.userAgent.includes('iPhone') ? 'iPhone'
      : navigator.userAgent.includes('Mac') ? 'Mac' : 'unknown',
    settings: state.settings,
    questions: state.questions,
    progress: Object.values(state.progress),
  };
  // iPhoneのSafariではdownloadリンクがファイルアプリに保存される
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ICLOUD_FILENAME;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  toast(`☁️ "${ICLOUD_FILENAME}" を保存しました\niPhoneは「ファイル」アプリ → iCloud Drive に保存してください`);
}

async function iCloudLoad(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !data.questions) throw new Error('ファイル形式が正しくありません');

    const savedAt = data.savedAt ? new Date(data.savedAt).toLocaleString('ja-JP') : '不明';
    const deviceHint = data.deviceHint || '不明';
    const ok = await confirm(
      `☁️ iCloudから読み込みます\n\n` +
      `保存元: ${deviceHint}\n保存日時: ${savedAt}\n` +
      `問題数: ${data.questions.length}問\n\n` +
      `現在のデータ（問題・学習履歴）は上書きされます。\n続けますか?`
    );
    if (!ok) return;

    // questions を置き換え
    await dbReplaceAll(STORE_Q, data.questions, []);
    state.questions = [...data.questions];

    // progress を全置換（1トランザクション）
    const progArr = Array.isArray(data.progress)
      ? data.progress
      : Object.values(data.progress || {});
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_P, 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = resolve;
      const s = t.objectStore(STORE_P);
      s.clear();
      for (const p of progArr) s.put(p);
    });
    state.progress = {};
    for (const p of progArr) state.progress[p.questionId] = p;

    // settings があれば上書き
    if (data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      await saveSettings();
    }

    toast(`☁️ 読み込み完了: ${state.questions.length}問 / 進捗${progArr.length}件`);
    applyTheme(); applyFontSize();
    renderHome(); renderList(); renderStats(); renderSettings();
  } catch (e) {
    console.error(e);
    toast('読み込み失敗: ' + e.message);
  }
}

async function exportAll() {
  const data = {
    version: 2,
    type: 'full',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    questions: state.questions,
    progress: state.progress,
  };
  downloadJSON(data, `shoshin-shiken-full-${dateKey()}.json`);
  toast('全データをエクスポートしました');
}

async function exportQuestionsOnly() {
  const data = {
    version: 2,
    type: 'questions-only',
    exportedAt: new Date().toISOString(),
    note: '問題のみのエクスポート(進捗・設定は含まれません)。共有用。',
    questions: state.questions,
  };
  downloadJSON(data, `shoshin-shiken-questions-${dateKey()}.json`);
  toast(`${state.questions.length}問をエクスポートしました`);
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// PC → スマホ同期: 問題バンクを丸ごと置き換える。
// SM-2の学習進捗(progressストア)には一切触れない。
// - 同じid: 問題内容が更新され、進捗は引き継がれる
// - importに無いid: スマホから問題が消える(進捗レコードは残るが無害。再追加すれば復活)
// - 新しいid: 新規問題として追加され、進捗はまっさら
async function importQuestionsReplace(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.questions)) {
      throw new Error('不正なファイル(questions配列が見つかりません)');
    }
    const incoming = data.questions;
    const count = incoming.length;

    // 既存問題のid→内容ハッシュ のマップ
    const existingHash = {};
    for (const q of state.questions) {
      existingHash[q.id] = q.contentHash || contentHash(q);
    }
    const incomingIds = new Set(incoming.map(q => q.id).filter(Boolean));

    // 差分(問題単位): 追加/更新/削除。穴ごと履歴は解答内容で自動追従するため
    // 「リセット」ではなく、解答が変わった/消えた穴の進捗だけ後で掃除する。
    let added = 0, updated = 0, removed = 0;
    for (const q of incoming) {
      q.contentHash = contentHash(q);
      if (q.id && existingHash[q.id] !== undefined) updated++;
      else added++;
    }
    for (const id of Object.keys(existingHash)) {
      if (!incomingIds.has(id)) removed++;
    }

    const delLine2 = removed > 0
      ? `・削除: ${removed}問 ⚠️ アプリから消えます(学習履歴も削除)\n`
      : `・削除: 0問\n`;
    const ok = await confirm(
      `PCの問題でスマホを同期します。\n\n` +
      `同期後は合計 ${incoming.length}問になります\n` +
      `・新規/更新: ${added + updated}問\n` +
      delLine2 +
      `\n解答の中身を変えていない穴の学習履歴は保持されます。\n` +
      `続けますか?`
    );
    if (!ok) return;

    // 問題バンクを全置換
    for (const q of incoming) {
      if (!q.id) q.id = uid();
      if (!q.category) q.category = 'common';
      if (!q.contentHash) q.contentHash = contentHash(q);
      if (!q.createdAt) q.createdAt = new Date().toISOString();
      if (!q.modifiedAt) q.modifiedAt = q.createdAt;
    }
    await dbReplaceAll(STORE_Q, incoming, []);
    state.questions = [...incoming];

    // 各問題で、現在の穴に該当しない古い進捗(解答変更/削除された穴)を掃除
    await pruneAllOrphanProgress();

    const kept = Object.keys(state.progress).length;
    toast(`✓ 同期完了: 全${incoming.length}問 / 保持中の穴履歴${kept}件`);
    renderHome(); renderList(); renderStats();
  } catch (e) {
    console.error(e);
    toast('同期失敗: ' + e.message);
  }
}

async function importJSON(file, full) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.questions)) throw new Error('不正なファイル(questions配列なし)');

    // Type-aware safety check for full restore
    if (full && data.type === 'questions-only') {
      const ok = await confirm('このファイルは「問題のみ」です。完全復元すると、現在の進捗が消えてしまいます。\n本当に進めますか?');
      if (!ok) return;
    }

    let added = 0, updated = 0, skipped = 0;
    for (const q of data.questions) {
      if (!q.id) q.id = uid();
      if (!q.category) q.category = 'common';
      if (!q.createdAt) q.createdAt = new Date().toISOString();
      if (!q.modifiedAt) q.modifiedAt = q.createdAt;
      if (!q.contentHash) q.contentHash = contentHash(q);

      const existing = state.questions.find(x => x.id === q.id);
      if (existing) {
        // Merge: keep newer (modifiedAt-based); skip if local is newer/equal
        const localTime = new Date(existing.modifiedAt || existing.createdAt || 0).getTime();
        const importTime = new Date(q.modifiedAt || q.createdAt || 0).getTime();
        if (importTime > localTime || full) {
          const idx = state.questions.indexOf(existing);
          state.questions[idx] = q;
          await dbPut(STORE_Q, q);
          updated++;
        } else {
          skipped++;
        }
      } else {
        state.questions.push(q);
        await dbPut(STORE_Q, q);
        added++;
      }
    }

    if (full && data.progress) {
      // Replace progress
      await dbClear(STORE_P);
      state.progress = {};
      for (const k in data.progress) {
        const p = data.progress[k];
        await dbPut(STORE_P, p);
        state.progress[p.questionId] = p;
      }
    }
    if (full && data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      await saveSettings();
      applyTheme(); applyFontSize();
    }
    toast(`完了: 新規${added} / 更新${updated} / スキップ${skipped}`);
    renderHome(); renderList(); renderStats();
  } catch (e) {
    console.error(e);
    toast('インポート失敗: ' + e.message);
  }
}

// 問題文の正規化キー(id列が無いときのフォールバック照合用)
function qKey(text) {
  return (text || '').replace(/\s+/g, '').trim();
}

// CSVセルのエスケープ
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// 全問題をCSVで書き出す(id列つき)。これをExcelで編集して戻すのが基本フロー。
async function exportCSV() {
  const headers = ['id', 'category', 'Q&A', 'tags', 'source', 'year', 'importance', 'author'];
  const lines = [headers.join(',')];
  for (const q of state.questions) {
    const row = [
      q.id,
      q.category || 'common',
      buildQACell(q.question, q.answer),
      (q.tags || []).join(';'),
      q.source || '',
      q.year || '',
      q.importance || '',
      q.author || '',
    ].map(csvEscape).join(',');
    lines.push(row);
  }
  const csv = lines.join('\r\n');
  // BOM付きでExcelがUTF-8と認識できるように
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `questions-${dateKey()}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  toast(`${state.questions.length}問をCSVに書き出しました`);
}

// CSVを正本としてアプリを完全同期する(追加・更新・削除をすべて反映)。
// - id列で既存問題を照合(id無い行は問題文で照合、それも無ければ新規)
// - 問題文/解答が変わった行 → 進捗リセット(新規扱い)
// - メタのみ変更 → 進捗保持
// - CSVに無い既存問題 → 削除(進捗は孤立して残る)
// - progressストアは直接触らない(リセット対象のみ削除)
async function importCSV(file) {
  // ヘッダー行必須(タブ区切りも可):
  //   必須: category, question, answer
  //   任意: id, tags, source, year, importance, author
  try {
    const text = await file.text();
    // BOM除去
    const clean = text.replace(/^\ufeff/, '');
    const firstLine = clean.slice(0, clean.indexOf('\n') >= 0 ? clean.indexOf('\n') : clean.length);
    const sep = firstLine.indexOf('\t') >= 0 ? '\t' : ',';
    const rows = parseDelim(clean, sep);
    if (rows.length < 2) throw new Error('行が足りません(ヘッダー+1行以上)');
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const idx = (...names) => {
      for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; }
      return -1;
    };
    const iId = idx('id');
    const iCat = idx('category');
    const iQA = idx('q&a', 'qa', 'q＆a', 'q_a', 'q and a');
    const iQ = idx('question'); const iA = idx('answer');
    const iTags = idx('tags'); const iSrc = idx('source'); const iYear = idx('year');
    const iImp = idx('importance'); const iAuth = idx('author');
    const useQA = iQA >= 0;
    if (!useQA && (iQ < 0 || iA < 0)) throw new Error('Q&A 列、または question/answer 列が必要です');

    // 既存問題の照合用インデックス
    const byId = {};
    const byQ = {};
    for (const q of state.questions) {
      byId[q.id] = q;
      const k = qKey(q.question);
      if (!(k in byQ)) byQ[k] = q;
    }

    const now = new Date().toISOString();
    const incoming = [];
    const usedIds = new Set();
    const skippedRows = [];  // スキップされた行の記録

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;

      // Q&A形式 or question/answer形式 から {question, answer} を得る
      let qText, aText;
      if (useQA) {
        const cellRaw = r[iQA] || '';
        const parsed = parseQACell(cellRaw);
        if (!parsed || !parsed.question) {
          if (cellRaw.trim()) {  // 空行でない場合のみ警告
            console.warn(`[CSV] 行${i+1} スキップ: Q&Aパース失敗 "${cellRaw.slice(0,40)}"`);
            skippedRows.push({ row: i+1, reason: 'Q&Aパース失敗', raw: cellRaw.slice(0, 60) });
          }
          continue;
        }
        qText = parsed.question;
        aText = parsed.answer;
      } else {
        qText = (r[iQ] || '').trim();
        aText = (r[iA] || '').trim();
      }
      if (!qText || !aText) {
        if (qText || aText) {  // どちらかが入っている場合のみ警告
          console.warn(`[CSV] 行${i+1} スキップ: qText="${qText.slice(0,30)}" aText="${aText.slice(0,30)}"`);
          skippedRows.push({ row: i+1, reason: !qText ? '問題文が空' : '解答が空', raw: (qText || aText).slice(0, 60) });
        }
        continue;
      }

      const cat = (iCat >= 0 ? (r[iCat] || '') : 'common').trim().toLowerCase();
      const catNorm = ['common','solution','engineering'].includes(cat) ? cat
        : (cat.includes('共') ? 'common' : (cat.includes('ソリュ') ? 'solution' : (cat.includes('エンジ') ? 'engineering' : 'common')));

      // id照合 → 無ければ問題文照合 → それも無ければ新規
      let id = iId >= 0 ? (r[iId] || '').trim() : '';
      let matched = null;
      if (id && byId[id]) {
        matched = byId[id];
      } else if (!id) {
        const cand = byQ[qKey(qText)];
        if (cand && !usedIds.has(cand.id)) { matched = cand; id = cand.id; }
      }
      if (!id) id = uid();
      if (usedIds.has(id)) id = uid();  // 同一id重複行を避ける
      usedIds.add(id);

      const q = {
        id,
        category: catNorm,
        question: qText,
        answer: aText,
        tags: iTags >= 0 ? (r[iTags] || '').split(/[,、|;]/).map(s => s.trim()).filter(Boolean) : (matched ? matched.tags : []),
        source: iSrc >= 0 ? (r[iSrc] || '').trim() : (matched ? matched.source : ''),
        year: iYear >= 0 && r[iYear] ? Number(String(r[iYear]).trim()) : (matched ? matched.year : null),
        importance: iImp >= 0 && r[iImp] ? Math.max(1, Math.min(5, Number(r[iImp]))) : (matched ? (matched.importance || 3) : 3),
        author: iAuth >= 0 ? (r[iAuth] || '').trim() : (matched ? (matched.author || '') : (state.settings.authorName || '')),
        createdAt: matched ? (matched.createdAt || now) : now,
        modifiedAt: now,
      };
      q.contentHash = contentHash(q);
      q._matched = matched;
      incoming.push(q);
    }

    if (incoming.length === 0) throw new Error('有効な問題行がありません');

    // 差分(問題単位): 追加/更新/削除。穴ごと履歴は解答内容で自動追従。
    let added = 0, updated = 0;
    const incomingIds = new Set(incoming.map(q => q.id));
    for (const q of incoming) {
      if (!q._matched) added++;
      else updated++;
    }
    let removed = 0;
    for (const q of state.questions) {
      if (!incomingIds.has(q.id)) removed++;
    }

    const delLine = removed > 0
      ? `・削除: ${removed}問 ⚠️ この問題はアプリから消えます(学習履歴も削除)\n`
      : `・削除: 0問\n`;
    const skipLine = skippedRows.length > 0
      ? `・スキップ: ${skippedRows.length}行 ⚠️ 取り込めない行があります\n`
      : '';
    const ok = await confirm(
      `CSVの内容でアプリを同期します。\n\n` +
      `同期後は合計 ${incoming.length}問になります\n` +
      `・新規/更新: ${added + updated}問\n` +
      delLine +
      skipLine +
      (skippedRows.length > 0
        ? `\nスキップされた行:\n` + skippedRows.slice(0,5).map(s=>`  行${s.row}: ${s.reason} "${s.raw}"`).join('\n') + (skippedRows.length>5?`\n  ...他${skippedRows.length-5}行`:'') + '\n\n'
        : '\n') +
      `CSVに無い問題は(学習済みでも)削除されます。\n` +
      `解答の中身を変えていない穴の学習履歴は保持されます。\n\n` +
      `続けますか?`
    );
    if (!ok) return;

    // 問題バンクを全置換 → そのあと解答が変わった/消えた穴の進捗を掃除
    incoming.forEach(q => delete q._matched);
    await dbReplaceAll(STORE_Q, incoming, []);
    state.questions = [...incoming];
    await pruneAllOrphanProgress();

    const kept = Object.keys(state.progress).length;
    const skipMsg = skippedRows.length > 0 ? ` / スキップ${skippedRows.length}行` : '';
    toast(`✓ CSV同期完了: 全${incoming.length}問 / 保持中の穴履歴${kept}件${skipMsg}`);
    renderHome(); renderList(); renderStats();
  } catch (e) {
    console.error(e);
    toast('CSV取り込み失敗: ' + e.message);
  }
}

function parseDelim(text, sep) {
  // Minimal CSV parser supporting quoted fields with newlines
  const out = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* ignore */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); out.push(row); }
  return out;
}

// ============================================
// 出典パッケージZIP（端末内のみ）
// ============================================
function zipMime(path) {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.pdf')) return 'application/pdf';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.txt')) return 'text/plain;charset=utf-8';
  return 'application/octet-stream';
}

async function readSourceZipDirectory(file) {
  // EOCDは末尾から最大65,557バイト以内にある（ZIP64は本パッケージでは使用しない）。
  const tailSize = Math.min(file.size, 65557);
  const tailOffset = file.size - tailSize;
  const tail = await file.slice(tailOffset).arrayBuffer();
  const tailView = new DataView(tail);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIPの終端情報が見つかりません');
  const entryCount = tailView.getUint16(eocd + 10, true);
  const centralSize = tailView.getUint32(eocd + 12, true);
  const centralOffset = tailView.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error('ZIP64形式には対応していません');
  }
  const central = await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer();
  const view = new DataView(central);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let pos = 0;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > view.byteLength || view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('ZIPの中央ディレクトリが壊れています');
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameBytes = new Uint8Array(central, pos + 46, nameLen);
    const name = decoder.decode(nameBytes).replace(/\\/g, '/');
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error('安全でないパスを含むZIPです');
    }
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readSourceZipEntry(file, entry) {
  if (entry.flags & 0x1) throw new Error(`${entry.name}: 暗号化ZIPには対応していません`);
  const local = await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer();
  const view = new DataView(local);
  if (view.byteLength < 30 || view.getUint32(0, true) !== 0x04034b50) {
    throw new Error(`${entry.name}: ローカルヘッダーが壊れています`);
  }
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = file.slice(dataStart, dataStart + entry.compressedSize);
  const mime = zipMime(entry.name);
  if (entry.method === 0) return raw.slice(0, raw.size, mime);
  if (entry.method === 8 && typeof DecompressionStream !== 'undefined') {
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const decompressed = await new Response(stream).blob();
    return decompressed.slice(0, decompressed.size, mime);
  }
  throw new Error(`${entry.name}: 圧縮方式${entry.method}には対応していません`);
}

async function pruneSourceRecords(keepPrefix) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SRC, 'readwrite');
    const s = t.objectStore(STORE_SRC);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    const req = s.openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!String(cursor.key).startsWith(keepPrefix)) cursor.delete();
      cursor.continue();
    };
  });
}

async function importSourcePackage(file) {
  const btn = document.getElementById('btn-import-sources');
  const progressEl = document.getElementById('source-import-progress');
  try {
    btn.disabled = true;
    progressEl.hidden = false;
    progressEl.textContent = '出典パッケージを確認中...';

    const entries = await readSourceZipDirectory(file);
    const manifestEntry = entries.find(e => e.name === 'manifest.json');
    if (!manifestEntry) throw new Error('manifest.json がありません');
    const manifestBlob = await readSourceZipEntry(file, manifestEntry);
    const manifest = JSON.parse(await manifestBlob.text());
    if (!manifest || manifest.schemaVersion !== 1 || !manifest.packageId || !manifest.documents || !manifest.questions) {
      throw new Error('S2出典パッケージの形式ではありません');
    }

    const dataEntries = entries.filter(e => e.name !== 'manifest.json' && !e.name.endsWith('/'));
    const totalBytes = dataEntries.reduce((sum, e) => sum + (e.uncompressedSize || 0), 0);
    const mapped = Number((manifest.stats || {}).mappedQuestions) || Object.values(manifest.questions)
      .filter(q => Array.isArray(q.references) && q.references.length).length;
    const total = Number((manifest.stats || {}).totalQuestions) || Object.keys(manifest.questions).length;
    const ok = await confirm(
      `出典パッケージをこの端末に保存します。\n\n` +
      `名称: ${manifest.name || 'S2 出典ライブラリ'}\n` +
      `原文ページ対応: ${mapped}/${total}問\n` +
      `保存ファイル: ${dataEntries.length}件（約${formatBytes(totalBytes)}）\n\n` +
      `GitHubや外部サーバーへは送信されません。続けますか?`
    );
    if (!ok) {
      progressEl.hidden = true;
      progressEl.textContent = '';
      return;
    }

    const prefix = `${manifest.packageId}::`;
    for (let i = 0; i < dataEntries.length; i++) {
      const e = dataEntries[i];
      progressEl.textContent = `端末内へ保存中... ${i + 1}/${dataEntries.length}\n${e.name}`;
      const blob = await readSourceZipEntry(file, e);
      await dbPut(STORE_SRC, {
        id: sourceRecordKey(manifest, e.name),
        path: e.name,
        mime: zipMime(e.name),
        size: blob.size,
        blob,
      });
      if (i % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }

    manifest.stats = { ...(manifest.stats || {}), packageBytes: file.size };
    await metaSet('sourceManifest', manifest);
    state.sourceManifest = manifest;
    await pruneSourceRecords(prefix);
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (e) { /* 永続化非対応でも通常のIndexedDB保存は有効 */ }
    renderSourceLibraryStatus();
    progressEl.textContent = `読込完了: 原文ページ対応 ${mapped}/${total}問`;
    toast('✓ 出典パッケージを端末内に保存しました');
    setTimeout(() => { progressEl.hidden = true; }, 2500);
  } catch (e) {
    console.error(e);
    progressEl.hidden = false;
    progressEl.textContent = '読み込み失敗: ' + e.message;
    toast('出典パッケージ読み込み失敗: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function removeSourceLibrary() {
  const ok = await confirm('この端末に保存した出典PDF・画像・索引を削除します。\n問題と学習履歴は残ります。よろしいですか?');
  if (!ok) return;
  clearRenderedSourceAssets();
  await dbClear(STORE_SRC);
  await dbDel(STORE_M, 'sourceManifest');
  state.sourceManifest = null;
  renderSourceLibraryStatus();
  toast('端末内の出典資料を削除しました');
}

async function resetProgress() {
  await dbClear(STORE_P);
  state.progress = {};
  await metaSet('todayCounters', { date: state.todayKey, new: 0, rev: 0 });
  state.todaySeen = { new: 0, rev: 0 };
  toast('進捗をリセットしました');
  renderHome(); renderList(); renderStats();
}

async function resetAll() {
  // 全ストアを1トランザクションでクリア
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE_Q, STORE_P, STORE_S, STORE_M, STORE_SRC], 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    [STORE_Q, STORE_P, STORE_S, STORE_M, STORE_SRC].forEach(s => t.objectStore(s).clear());
  });
  state.questions = [];
  state.progress = {};
  state.sourceManifest = null;
  clearRenderedSourceAssets();
  state.settings = {
    examDate: '', newPerDay: 10, revPerDay: 100,
    mixRatio: '3:7', theme: 'auto', fontSize: 'm', ttsAuto: false, authorName: '',
  };
  await saveSettings();
  state.todaySeen = { new: 0, rev: 0 };
  toast('全データを削除しました');
  await loadSeed(false);
  applyTheme(); applyFontSize();
  renderHome(); renderList(); renderStats(); renderSettings();
}

// ============================================
// 音声入力 (Web Speech API / iOS Safari対応)
// ============================================
// 音声入力 (Web Speech API / iOS Safari対応)
// ============================================
let _recog = null;
let _micRecording = false;

function initMic() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('btn-mic');
  if (!SpeechRecognition) return;  // 非対応ブラウザではボタン非表示のまま
  btn.classList.remove('hidden');

  btn.addEventListener('click', () => {
    if (_micRecording) {
      stopMic();
    } else {
      startMic();
    }
  });
}

function startMic() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  const btn = document.getElementById('btn-mic');
  const input = document.getElementById('quiz-input');

  // タップ直後に即座に視覚フィードバック
  btn.classList.add('recording');
  input.value = '';
  input.placeholder = '🎤 話してください...';

  _recog = new SpeechRecognition();
  _recog.lang = 'ja-JP';
  _recog.continuous = false;
  _recog.interimResults = true;
  _recog.maxAlternatives = 1;

  let finalResult = '';
  let judged = false;

  _recog.onstart = () => { _micRecording = true; };

  _recog.onresult = (e) => {
    let interim = '';
    for (const r of e.results) {
      if (r.isFinal) {
        finalResult += r[0].transcript;
      } else {
        interim += r[0].transcript;
      }
    }
    input.value = finalResult || interim;

    // 最終結果が出た瞬間に即判定(onendを待たない → iOS遅延を解消)
    if (finalResult && !judged && !document.getElementById('btn-quiz-judge').hidden) {
      judged = true;
      btn.classList.remove('recording');
      input.placeholder = '解答を入力';
      _micRecording = false;
      try { _recog.stop(); } catch (e) {}
      judgeQuizBlank();
    }
  };

  _recog.onend = () => {
    _micRecording = false;
    btn.classList.remove('recording');
    input.placeholder = '解答を入力';
    // finalResultが来る前にonendが来た場合(no-speechなど)の補完
    if (!judged && input.value.trim() && !document.getElementById('btn-quiz-judge').hidden) {
      judgeQuizBlank();
    }
  };

  _recog.onerror = (e) => {
    _micRecording = false;
    btn.classList.remove('recording');
    input.placeholder = '解答を入力';
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      toast('音声入力エラー: ' + e.error);
    }
  };

  try { _recog.start(); } catch (e) { console.warn('mic start error', e); }
}

function stopMic() {
  if (_recog) {
    try { _recog.stop(); } catch (e) {}
    _recog = null;
  }
  _micRecording = false;
  const btn = document.getElementById('btn-mic');
  if (btn) btn.classList.remove('recording');
}

// ============================================
// EVENTS
// ============================================
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      const v = t.dataset.view;
      showView(v);
      if (v === 'view-home') renderHome();
      if (v === 'view-list') renderList();
      if (v === 'view-stats') renderStats();
    });
  });

  // Home: category chips
  document.querySelectorAll('#view-home .chip').forEach(c => {
    c.addEventListener('click', () => {
      state.selectedCat = c.dataset.cat;
      renderHome();
    });
  });
  // Session size
  document.querySelectorAll('.opt[data-size]').forEach(o => {
    o.addEventListener('click', () => {
      state.selectedSize = Number(o.dataset.size);
      renderHome();
    });
  });
  // Action buttons
  document.getElementById('btn-review').addEventListener('click', () => startStudy('review'));
  document.getElementById('btn-new').addEventListener('click', () => startStudy('new'));
  document.getElementById('btn-mixed').addEventListener('click', () => startStudy('mixed'));
  document.getElementById('btn-wrong').addEventListener('click', () => startStudy('wrong'));

  // Settings open/close
  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettings();
    showView('view-settings');
  });
  document.getElementById('btn-settings-back').addEventListener('click', async () => {
    await saveSettingsFromForm();
    showView('view-home'); renderHome();
  });

  // Settings: live save fields
  ['set-exam-date','set-new-per-day','set-rev-per-day','set-mix-ratio',
   'set-theme','set-font-size','set-tts-auto','set-author-name'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettingsFromForm);
  });

  // Study controls (解答モードのみ)
  document.getElementById('btn-quiz-judge').addEventListener('click', judgeQuizBlank);
  document.getElementById('btn-quiz-next').addEventListener('click', nextQuizBlank);
  document.getElementById('study-source').addEventListener('click', (e) => {
    const btn = e.target.closest('.source-open-btn');
    if (!btn) return;
    openLocalSourceFile(btn.dataset.sourcePath, Number(btn.dataset.sourcePage) || null, btn.dataset.sourceType || '');
  });

  // Enterキーハンドラ（フォーカス位置に依存せず一元管理）
  // - IME変換中(isComposing / keyCode=229)は無視
  // - テキスト入力欄以外にフォーカスがある場合もキャプチャ
  // - 二重発火防止: 処理後150msブロック
  let _enterBlocked = false;
  function blockEnter(ms = 150) {
    _enterBlocked = true;
    setTimeout(() => { _enterBlocked = false; }, ms);
  }

  function handleStudyEnter(e) {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;  // IME変換中は無視
    if (_enterBlocked) return;

    // モーダルが開いていたら何もしない
    const modal = document.getElementById('modal');
    if (modal && !modal.hidden) return;

    // 出題画面でなければ何もしない
    const viewStudy = document.getElementById('view-study');
    if (!viewStudy || viewStudy.hidden) return;

    // 編集フォームなど他のinput/textareaにフォーカスがある場合は何もしない
    const tag = (document.activeElement || {}).tagName || '';
    const activeId = (document.activeElement || {}).id || '';
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && activeId !== 'quiz-input') return;

    e.preventDefault();

    // quiz-inputが表示中かつbtn-quiz-judgeが有効 → 判定
    const judgeBtn = document.getElementById('btn-quiz-judge');
    const nextBtn = document.getElementById('btn-quiz-next');
    if (judgeBtn && !judgeBtn.hidden) {
      blockEnter();
      judgeQuizBlank();
    } else if (nextBtn && !nextBtn.hidden) {
      // 次の穴 or 結果を見る or 次の問題へ
      blockEnter(200);  // 次問題ロード中は少し長めにブロック
      nextQuizBlank();
    }
  }

  document.addEventListener('keydown', handleStudyEnter, { capture: true });

  // 音声入力
  initMic();
  // 出題中フォントサイズ切替ボタン
  document.querySelectorAll('.btn-font-size').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.settings.fontSize = btn.dataset.fs;
      applyFontSize();
      await saveSettings();
      // 設定画面のselect要素も同期
      const sel = document.getElementById('set-font-size');
      if (sel) sel.value = btn.dataset.fs;
    });
  });

  document.getElementById('btn-study-edit').addEventListener('click', () => {
    const q = state.studyDeck[state.studyIdx];
    if (!q) return;
    state.editingReturnView = 'view-study';
    openEditor(q.id);
  });
  document.getElementById('btn-study-back').addEventListener('click', async () => {
    if (state.studyIdx > 0) {
      const ok = await confirm('セッションを中断します。\n途中の進捗は保存されています。');
      if (!ok) return;
    }
    stopTTS();
    showView('view-home'); renderHome();
  });
  document.getElementById('btn-tts').addEventListener('click', toggleTTS);

  // Done
  document.getElementById('btn-done-home').addEventListener('click', () => { showView('view-home'); renderHome(); });
  document.getElementById('btn-done-again').addEventListener('click', () => {
    const mode = state.studyStats.mode || 'mixed';
    startStudy(mode);
  });

  // List
  document.getElementById('btn-add').addEventListener('click', () => openEditor(null));
  document.querySelectorAll('#view-list .chip').forEach(c => {
    c.addEventListener('click', () => {
      state.listCat = c.dataset.listcat;
      renderList();
    });
  });
  document.getElementById('list-status').addEventListener('change', (e) => {
    state.listStatus = e.target.value; renderList();
  });
  document.getElementById('list-sort').addEventListener('change', (e) => {
    state.listSort = e.target.value; renderList();
  });
  document.getElementById('list-search').addEventListener('input', (e) => {
    state.listSearch = e.target.value.trim();
    renderList();
  });

  // Editor
  document.getElementById('btn-edit-back').addEventListener('click', () => {
    const returnView = state.editingReturnView || 'view-list';
    state.editingReturnView = null;
    state.editingId = null;
    if (returnView === 'view-study') {
      showView('view-study');
    } else {
      showView('view-list');
    }
  });
  document.getElementById('btn-edit-save').addEventListener('click', saveEditor);
  document.getElementById('btn-edit-delete').addEventListener('click', deleteEditor);
  document.querySelectorAll('.seg-opt').forEach(s => {
    s.addEventListener('click', () => {
      state.editingCat = s.dataset.edcat;
      document.querySelectorAll('.seg-opt').forEach(x => x.classList.toggle('active', x === s));
    });
  });
  document.querySelectorAll('#ed-stars .star').forEach(s => {
    s.addEventListener('click', () => {
      state.editingImp = Number(s.dataset.imp);
      document.querySelectorAll('#ed-stars .star').forEach(x => {
        x.classList.toggle('on', Number(x.dataset.imp) <= state.editingImp);
      });
    });
  });

  // Settings: import/export
  // iCloud Drive同期
  document.getElementById('btn-icloud-save').addEventListener('click', iCloudSave);
  document.getElementById('btn-icloud-load').addEventListener('click', () => {
    const fi = document.createElement('input');
    fi.type = 'file'; fi.accept = 'application/json,.json';
    fi.addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      await iCloudLoad(f);
    });
    fi.click();
  });

  document.getElementById('btn-export-all').addEventListener('click', exportAll);

  // CSV: question management (source of truth). Export (with id) and full-sync import.
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-import-csv').addEventListener('click', () => {
    document.getElementById('file-import-csv').click();
  });
  document.getElementById('file-import-csv').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await importCSV(f);
    e.target.value = '';
  });

  // 出典パッケージ: 原本と索引は端末内のIndexedDBだけに保存
  document.getElementById('btn-import-sources').addEventListener('click', () => {
    document.getElementById('file-import-sources').click();
  });
  document.getElementById('file-import-sources').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await importSourcePackage(f);
    e.target.value = '';
  });
  document.getElementById('btn-remove-sources').addEventListener('click', removeSourceLibrary);

  // Full restore (overwrite progress too) - restore from backup
  document.getElementById('btn-import-full').addEventListener('click', () => {
    document.getElementById('file-import').dataset.full = '1';
    document.getElementById('file-import').click();
  });
  document.getElementById('file-import').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const full = e.target.dataset.full === '1';
    if (full) {
      const ok = await confirm('既存の進捗を削除して、JSONの内容で完全復元します。\nよろしいですか?');
      if (!ok) { e.target.value = ''; return; }
    }
    await importJSON(f, full);
    e.target.value = '';
  });

  // Settings: reset
  document.getElementById('btn-reset-progress').addEventListener('click', async () => {
    const ok = await confirm('全ての学習進捗(SM-2の状態・履歴・本日のカウンタ)をリセットします。\n問題自体は残ります。よろしいですか?');
    if (!ok) return;
    await resetProgress();
  });
  document.getElementById('btn-reset-all').addEventListener('click', async () => {
    const ok = await confirm('全データを削除し、シード問題を再読込します。\n本当によろしいですか?');
    if (!ok) return;
    await resetAll();
  });

  // Modal close on backdrop click
  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') {
      document.getElementById('modal-cancel').click();
    }
  });

  // Prefer no double-tap zoom on iOS
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  window.addEventListener('beforeunload', clearRenderedSourceAssets);
}

// Boot
window.addEventListener('DOMContentLoaded', init);

})();
