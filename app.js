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
const STORE_A = 'sourceAssets';

const APP_VERSION = '2.4.0';  // バージョンが変わっても IndexedDB のデータは保持される
const SOURCE_INDEX_META_KEY = 'localSourceIndex';
const SOURCE_INDEX_SCHEMA_VERSIONS = new Set([1, 2]);
const SOURCE_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const SOURCE_ASSET_MAX_BYTES = 2 * 1024 * 1024;
const SOURCE_ASSET_TOTAL_MAX_BYTES = 48 * 1024 * 1024;
const SOURCE_ASSET_MAX_COUNT = 1000;
const SOURCE_ASSET_CACHE_LIMIT = 12;

const CATS = { common: '共通', solution: 'ソリューション', engineering: 'エンジニア' };

const state = {
  questions: [],          // [{id, category, question, answer, ...}]
  progress: {},           // {questionId: {ease, interval, reps, due, ...}}
  dailyStudy: {},         // {YYYY-MM-DD: {date, studied, correct, newCount, reviewCount, ...}}
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
  // 共通・ソリューション資料のローカル索引。本文はアプリ本体や同期ファイルへ含めない。
  sourceIndex: {
    loaded: false, schemaVersion: 0, generatedAt: '', questionCount: 0, stats: {},
    assetCount: 0, assetBytes: 0, byId: new Map(), byHash: new Map(),
  },
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
      if (!d.objectStoreNames.contains(STORE_A)) {
        d.createObjectStore(STORE_A, { keyPath: 'id' });
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
// 習得(マスター)の条件: 同じ穴に累計3回正解したら習得。
// 正解速度はSM-2評価にだけ使い、習得回数には影響させない。
const MASTER_CORRECT_COUNT = 3;
const BLANK_FAST_SEC = 30;  // 1穴あたりこの秒数以内ならSM-2上の「簡単」
const BLANK_SLOW_SEC = 60;  // これを超えるとSM-2上の「難」

// 文字列ハッシュ(djb2)
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
// 穴ごとの進捗キー: 問題id + '#' + 解答内容のハッシュ。
// 位置や問題文が変わっても、解答の中身が同じなら同じキー = 学習履歴が追従する。
function blankKey(qid, answer) { return qid + '#' + hashStr(normalizeAns(answer)); }

// 旧版の進捗を含め、その穴で何回正解したかを安全に取得する。
// rating 2/3/4 はいずれも正解、rating 1 は不正解として扱う。
function progressCorrectCount(p) {
  if (!p) return 0;
  const stored = Number(p.correctCount);
  if (Number.isFinite(stored) && stored >= 0) {
    return Math.min(MASTER_CORRECT_COUNT, Math.floor(stored));
  }
  if (p.mastered) return MASTER_CORRECT_COUNT;
  let fromHistory = 0;
  for (const h of (Array.isArray(p.history) ? p.history : [])) {
    if (Number(h && h.r) >= 2) fromHistory += 1;
  }
  const legacyFast = Number.isFinite(Number(p.fastStreak)) ? Number(p.fastStreak) : 0;
  return Math.min(MASTER_CORRECT_COUNT, Math.max(fromHistory, legacyFast, 0));
}

function normalizeProgressMastery(p) {
  if (!p) return false;
  const beforeCount = p.correctCount;
  const beforeMastered = p.mastered;
  let count = progressCorrectCount(p);
  if (p.mastered) count = Math.max(count, MASTER_CORRECT_COUNT);
  p.correctCount = Math.min(MASTER_CORRECT_COUNT, count);
  p.mastered = !!p.mastered || p.correctCount >= MASTER_CORRECT_COUNT;
  return beforeCount !== p.correctCount || beforeMastered !== p.mastered;
}

// 問題の穴一覧 [{label, answer}]。穴が無い場合は解答全体を1穴とみなす。
function getBlanks(q) {
  const b = parseQuizBlanks(q.question, q.answer);
  if (b && b.length) return b;
  return [{ label: '', answer: (q.answer || '').trim() }];
}
// 各穴の状態を返す: [{i,label,answer,key,prog,correctCount,st}]
// st='new'|'due'|'wait'|'mastered'。同一問題内に同じ解答が複数あれば ~1, ~2 を付けて区別する。
function getBlankStates(q) {
  const today = startOfDay();
  const blanks = getBlanks(q);
  const seen = {};
  return blanks.map((b, i) => {
    const base = blankKey(q.id, b.answer);
    const n = seen[base] || 0; seen[base] = n + 1;
    const key = n === 0 ? base : base + '~' + n;
    const bp = state.progress[key];
    const correctCount = progressCorrectCount(bp);
    let st;
    if (bp && (bp.mastered || correctCount >= MASTER_CORRECT_COUNT)) st = 'mastered';
    else if (!bp || !bp.due) st = 'new';
    else st = startOfDay(new Date(bp.due)) <= today ? 'due' : 'wait';
    return { i, label: b.label, answer: b.answer, key, prog: bp || null, correctCount, st };
  });
}

function isReinforcementBlank(s) {
  return s.st !== 'mastered' && s.correctCount > 0 && s.correctCount < MASTER_CORRECT_COUNT;
}

// 問題がいずれかのモードで選ばれたら、3回正解前の穴は期日に関係なく必ず再出題する。
// 習得済みの穴だけは入力対象から外し、問題文側へ正解を埋め込む。
function qActiveBlanks(q) {
  return getBlankStates(q).filter(s => s.st !== 'mastered');
}

// 「間違えた問題」でも同じルールを適用し、正解済み1～2回の穴を省略しない。
function qWrongFocusBlanks(q) {
  return qActiveBlanks(q);
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
    correctCount: 0,  // 累計正解数。3回で習得
    fastStreak: 0,    // 旧版互換・分析用。習得判定には使わない
    mastered: false,  // 習得済み(次回以降は問題文に正解を表示)
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
  p.history.push({ d: dateKey(now), r: rating, b: before, a: p.interval });
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
  // UTC変換を挟まず、利用端末のローカル日付を使う。
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

// 出題画面専用。3回正解済みの穴は正解を埋め、未習得の穴だけを従来どおり空欄表示する。
function renderStudyQuestion(q) {
  const text = String((q && q.question) || '');
  const states = getBlankStates(q);
  const re = /【([^】]*)】/g;
  let html = '';
  let last = 0;
  let i = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    html += escapeHtml(text.slice(last, m.index));
    const st = states[i++];
    if (st && st.st === 'mastered') {
      html += `<span class="blank blank-filled" title="3回正解済み">${escapeHtml(st.answer)}</span>`;
    } else {
      const label = (m[1] || '').trim();
      html += `<span class="blank">${escapeHtml(label) || '　'}</span>`;
    }
    last = m.index + m[0].length;
  }
  html += escapeHtml(text.slice(last));
  return html;
}

function studyQuestionSpeechText(q) {
  const states = getBlankStates(q);
  let i = 0;
  return String((q && q.question) || '').replace(/【([^】]*)】/g, (m, inner) => {
    const st = states[i++];
    if (st && st.st === 'mastered') return st.answer;
    const label = (inner || '').trim();
    return label ? `空欄${label}` : '空欄';
  });
}

function renderAnswer(text) {
  // 改行は維持。①②...㊿ を少し強調。
  return escapeHtml(text).replace(/([①-⑳㉑-㊿])/g, '<span class="ans-num">$1</span>');
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


// ============================================
// Local/private source index and page images
// ============================================
// Source excerpts and page screenshots are never bundled into the public app.
// The user-selected local JSON is split across IndexedDB metadata and Blob assets.
function emptySourceIndex() {
  return {
    loaded: false, schemaVersion: 0, generatedAt: '', questionCount: 0, stats: {},
    assetCount: 0, assetBytes: 0, byId: new Map(), byHash: new Map(),
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateSourcePageImage(pageImage) {
  if (!isPlainObject(pageImage)) throw new Error('PDFページ画像情報が壊れています');
  const assetId = String(pageImage.assetId || '');
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(assetId)) {
    throw new Error('PDFページ画像IDが正しくありません');
  }
  if (!Number.isInteger(pageImage.width) || pageImage.width < 1 || pageImage.width > 10000 ||
      !Number.isInteger(pageImage.height) || pageImage.height < 1 || pageImage.height > 10000) {
    throw new Error('PDFページ画像サイズが正しくありません');
  }
  const rects = pageImage.highlightRects == null ? [] : pageImage.highlightRects;
  if (!Array.isArray(rects) || rects.length > 40) {
    throw new Error('画像ハイライト情報が正しくありません');
  }
  for (const rect of rects) {
    if (!isPlainObject(rect)) throw new Error('画像ハイライト座標が壊れています');
    const values = ['x', 'y', 'w', 'h'].map(k => Number(rect[k]));
    if (values.some(v => !Number.isFinite(v))) throw new Error('画像ハイライト座標が正しくありません');
    const [x, y, w, h] = values;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || x + w > 1.02 || y + h > 1.02) {
      throw new Error('画像ハイライト座標が範囲外です');
    }
  }
}

function validateSourceAssets(assets) {
  if (assets == null) return { count: 0, bytes: 0 };
  if (!isPlainObject(assets)) throw new Error('ページ画像データが正しくありません');
  const rows = Object.entries(assets);
  if (rows.length > SOURCE_ASSET_MAX_COUNT) throw new Error('ページ画像が多すぎます');
  let totalBytes = 0;
  for (const [id, asset] of rows) {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id) || !isPlainObject(asset)) {
      throw new Error('ページ画像データが壊れています');
    }
    if (!['image/webp', 'image/jpeg', 'image/png'].includes(String(asset.mime || ''))) {
      throw new Error('未対応のページ画像形式です');
    }
    if (!Number.isInteger(asset.width) || asset.width < 1 || asset.width > 10000 ||
        !Number.isInteger(asset.height) || asset.height < 1 || asset.height > 10000) {
      throw new Error('ページ画像サイズが正しくありません');
    }
    if (!Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > SOURCE_ASSET_MAX_BYTES) {
      throw new Error('ページ画像の容量が正しくありません');
    }
    if (typeof asset.data !== 'string' || asset.data.length < 4 ||
        asset.data.length > Math.ceil(SOURCE_ASSET_MAX_BYTES * 4 / 3) + 8) {
      throw new Error('ページ画像本体が正しくありません');
    }
    totalBytes += asset.bytes;
    if (totalBytes > SOURCE_ASSET_TOTAL_MAX_BYTES) throw new Error('ページ画像の合計容量が大きすぎます');
  }
  return { count: rows.length, bytes: totalBytes };
}

function validateSourceIndex(data) {
  if (!isPlainObject(data)) throw new Error('出典データの形式が正しくありません');
  if (!SOURCE_INDEX_SCHEMA_VERSIONS.has(data.schemaVersion)) {
    throw new Error(`未対応の出典データ形式です (schemaVersion: ${data.schemaVersion ?? 'なし'})`);
  }
  if (!Array.isArray(data.entries) || data.entries.length > 20000) {
    throw new Error('出典エントリが正しくありません');
  }
  for (const entry of data.entries) {
    if (!isPlainObject(entry)) throw new Error('出典エントリが壊れています');
    const id = entry.id == null ? '' : String(entry.id);
    const hash = entry.contentHash == null ? '' : String(entry.contentHash);
    if (!id && !hash) throw new Error('問題との照合キーがない出典エントリがあります');
    if (id.length > 300 || hash.length > 160 || String(entry.source || '').length > 4000) {
      throw new Error('出典エントリが大きすぎます');
    }
    const refs = entry.references == null ? [] : entry.references;
    if (!Array.isArray(refs) || refs.length > 8) throw new Error('出典参照の形式が正しくありません');
    for (const ref of refs) {
      if (!isPlainObject(ref)) throw new Error('出典参照が壊れています');
      if (String(ref.document || '').length > 600 || String(ref.excerpt || '').length > 6000) {
        throw new Error('出典本文が大きすぎます');
      }
      if (ref.page != null && (!Number.isInteger(ref.page) || ref.page < 1 || ref.page > 10000)) {
        throw new Error('出典ページ番号が正しくありません');
      }
      if (ref.highlights != null) {
        if (!Array.isArray(ref.highlights) || ref.highlights.length > 40) {
          throw new Error('マーカー情報が正しくありません');
        }
        if (ref.highlights.some(x => typeof x !== 'string' || x.length > 300)) {
          throw new Error('マーカー情報が大きすぎます');
        }
      }
      if (ref.pageImage != null) validateSourcePageImage(ref.pageImage);
    }
  }
  validateSourceAssets(data.assets);
  return data;
}

function setSourceIndexData(data) {
  const byId = new Map();
  const byHash = new Map();
  for (const entry of data.entries) {
    const id = entry.id == null ? '' : String(entry.id).trim();
    const hash = entry.contentHash == null ? '' : String(entry.contentHash).trim();
    if (id && !byId.has(id)) byId.set(id, entry);
    if (hash && !byHash.has(hash)) byHash.set(hash, entry);
  }
  state.sourceIndex = {
    loaded: true,
    schemaVersion: Number(data.schemaVersion) || 1,
    generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '',
    questionCount: Number(data.questionCount) || data.entries.length,
    stats: isPlainObject(data.stats) ? data.stats : {},
    assetCount: Number(data.assetCount) || 0,
    assetBytes: Number(data.assetBytes) || 0,
    byId,
    byHash,
  };
}

async function loadLocalSourceIndex() {
  try {
    const data = await metaGet(SOURCE_INDEX_META_KEY);
    if (!data) {
      state.sourceIndex = emptySourceIndex();
      return;
    }
    validateSourceIndex(data);
    setSourceIndexData(data);
  } catch (e) {
    console.warn('ローカル出典データの読み込みをスキップしました', e);
    state.sourceIndex = emptySourceIndex();
  }
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function prepareSourceDataForStorage(data) {
  const assets = isPlainObject(data.assets) ? data.assets : {};
  const records = [];
  for (const [id, asset] of Object.entries(assets)) {
    let blob;
    try {
      blob = base64ToBlob(asset.data, asset.mime);
    } catch (e) {
      throw new Error(`ページ画像 ${id} を展開できません`);
    }
    if (blob.size !== asset.bytes) throw new Error(`ページ画像 ${id} の容量が一致しません`);
    records.push({
      id,
      blob,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      bytes: blob.size,
      sha256: typeof asset.sha256 === 'string' ? asset.sha256 : '',
    });
  }

  const referenced = new Set();
  for (const entry of data.entries) {
    for (const ref of entry.references || []) {
      const aid = ref && ref.pageImage && String(ref.pageImage.assetId || '');
      if (aid) referenced.add(aid);
    }
  }
  if (referenced.size > 0) {
    const available = new Set(records.map(record => record.id));
    for (const id of referenced) {
      if (!available.has(id)) throw new Error(`ページ画像 ${id} が出典パック内にありません`);
    }
  }

  const indexData = { ...data };
  delete indexData.assets;
  indexData.assetCount = records.length;
  indexData.assetBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  validateSourceIndex(indexData);
  return { indexData, records };
}

function replaceLocalSourceData(indexData, assetRecords) {
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_M, STORE_A], 'readwrite');
    t.onerror = () => reject(t.error || new Error('出典データを保存できませんでした'));
    t.onabort = () => reject(t.error || new Error('出典データの保存が中断されました'));
    t.oncomplete = resolve;
    const assets = t.objectStore(STORE_A);
    assets.clear();
    for (const record of assetRecords) assets.put(record);
    t.objectStore(STORE_M).put({ key: SOURCE_INDEX_META_KEY, value: indexData });
  });
}

async function importLocalSourceIndex(file) {
  try {
    if (!file) return;
    if (file.size > SOURCE_INDEX_MAX_BYTES) {
      throw new Error(`ファイルが大きすぎます (${Math.ceil(file.size / 1024 / 1024)}MB)。上限は64MBです`);
    }
    toast('ローカル出典データを読み込んでいます…');
    await new Promise(resolve => setTimeout(resolve, 20));
    const data = validateSourceIndex(JSON.parse(await file.text()));
    const { indexData, records } = prepareSourceDataForStorage(data);
    await replaceLocalSourceData(indexData, records);
    clearSourceAssetUrlCache();
    setSourceIndexData(indexData);
    renderSourceIndexStatus();
    const coverage = sourceCoverageStats();
    const imageText = coverage.pageImage ? ` / ページ画像${coverage.pageImage}問` : '';
    toast(`出典データを読み込みました: 抜粋${coverage.excerpt}問 / マーカー${coverage.marked}問${imageText}`);
  } catch (e) {
    console.error(e);
    toast('出典データの読み込み失敗: ' + e.message);
  }
}

function clearLocalSourceDataFromDB() {
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_M, STORE_A], 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    t.objectStore(STORE_M).delete(SOURCE_INDEX_META_KEY);
    t.objectStore(STORE_A).clear();
  });
}

async function clearLocalSourceIndex() {
  closeSourcePageViewer();
  await clearLocalSourceDataFromDB();
  clearSourceAssetUrlCache();
  state.sourceIndex = emptySourceIndex();
  renderSourceIndexStatus();
  toast('ローカル出典データを端末から削除しました');
}

function findSourceEntry(q) {
  if (!state.sourceIndex.loaded || !q) return null;
  const id = q.id == null ? '' : String(q.id);
  const hash = contentHash(q);
  if (id && state.sourceIndex.byId.has(id)) {
    const entry = state.sourceIndex.byId.get(id);
    const entryHash = entry.contentHash == null ? '' : String(entry.contentHash);
    // Do not show stale source data after the question or answer was edited.
    if (!entryHash || entryHash === hash) return entry;
  }
  return hash && state.sourceIndex.byHash.has(hash) ? state.sourceIndex.byHash.get(hash) : null;
}

function sourceCoverageStats() {
  const result = { total: state.questions.length, matched: 0, excerpt: 0, marked: 0, pageImage: 0, imageMarked: 0 };
  if (!state.sourceIndex.loaded) return result;
  for (const q of state.questions) {
    const entry = findSourceEntry(q);
    if (!entry) continue;
    result.matched++;
    const refs = Array.isArray(entry.references) ? entry.references : [];
    if (refs.some(ref => ref && ref.excerpt)) result.excerpt++;
    if (refs.some(ref => ref && Array.isArray(ref.highlights) && ref.highlights.length)) result.marked++;
    if (refs.some(ref => ref && ref.pageImage && ref.pageImage.assetId)) result.pageImage++;
    if (refs.some(ref => ref && ref.pageImage && Array.isArray(ref.pageImage.highlightRects) && ref.pageImage.highlightRects.length)) {
      result.imageMarked++;
    }
  }
  return result;
}

function renderSourceIndexStatus() {
  const statusEl = document.getElementById('source-index-status');
  const clearBtn = document.getElementById('btn-clear-source-index');
  if (!statusEl) return;
  if (!state.sourceIndex.loaded) {
    statusEl.className = 'source-index-status';
    statusEl.innerHTML = '<strong>未読み込み</strong><span>出典データはこの端末にだけ保存されます</span>';
    if (clearBtn) clearBtn.disabled = true;
    return;
  }
  const coverage = sourceCoverageStats();
  let generated = '';
  if (state.sourceIndex.generatedAt) {
    const d = new Date(state.sourceIndex.generatedAt);
    if (!Number.isNaN(d.getTime())) generated = ` / 作成 ${d.toLocaleString('ja-JP')}`;
  }
  const pageText = coverage.pageImage
    ? `・ページ画像 ${coverage.pageImage}問(${state.sourceIndex.assetCount}枚)・画像ハイライト ${coverage.imageMarked}問`
    : '';
  statusEl.className = 'source-index-status loaded';
  statusEl.innerHTML =
    `<strong>読み込み済み</strong>` +
    `<span>照合 ${coverage.matched}/${coverage.total}問・本文抜粋 ${coverage.excerpt}問・マーカー ${coverage.marked}問${pageText}${escapeHtml(generated)}</span>`;
  if (clearBtn) clearBtn.disabled = false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSourceExcerpt(text, terms) {
  const source = String(text || '');
  const unique = [];
  const seen = new Set();
  const sourceLower = source.toLocaleLowerCase('ja-JP');
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw || '').trim();
    const key = term.toLocaleLowerCase('ja-JP');
    if (!term || term.length > 300 || seen.has(key) || !sourceLower.includes(key)) continue;
    seen.add(key);
    unique.push(term);
  }
  unique.sort((a, b) => b.length - a.length);
  if (!unique.length) return escapeHtml(source);
  const re = new RegExp(unique.map(escapeRegExp).join('|'), 'gi');
  let out = '';
  let last = 0;
  source.replace(re, (match, offset) => {
    out += escapeHtml(source.slice(last, offset));
    out += `<mark>${escapeHtml(match)}</mark>`;
    last = offset + match.length;
    return match;
  });
  out += escapeHtml(source.slice(last));
  return out;
}

function sourcePercent(value) {
  return (Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(4);
}

function sourcePageVisualHtml(ref, documentName) {
  const pageImage = ref && ref.pageImage;
  if (!pageImage || !pageImage.assetId) return '';
  const rects = Array.isArray(pageImage.highlightRects) ? pageImage.highlightRects : [];
  const marks = rects.map(rect =>
    `<span class="source-page-mark" style="left:${sourcePercent(rect.x)}%;top:${sourcePercent(rect.y)}%;width:${sourcePercent(rect.w)}%;height:${sourcePercent(rect.h)}%"></span>`
  ).join('');
  const pageNo = Number.isInteger(ref.page) ? ref.page : '';
  const isRaster = /\.(?:png|jpe?g|webp)$/i.test(documentName);
  const pageLabel = isRaster ? '該当資料画像' : '該当PDFページ';
  const note = rects.length
    ? '<span class="source-page-key" aria-hidden="true"></span>黄色の枠が穴抜き解答の該当箇所です。'
    : '画像上の解答位置は安全に特定できなかったため、下の原文マーカーをご確認ください。';
  const alt = `${documentName}${pageNo ? ` PDF p.${pageNo}` : ''} のページ画像`;
  return `<div class="source-page-visual${rects.length ? ' has-marks' : ''}" ` +
    `data-source-asset-id="${escapeHtml(pageImage.assetId)}" ` +
    `data-source-document="${escapeHtml(documentName)}" data-source-page="${escapeHtml(pageNo)}" ` +
    `data-source-width="${pageImage.width}" tabindex="0" role="button" aria-label="${escapeHtml(alt)}を拡大表示">` +
      `<div class="source-page-caption"><span>${pageLabel}</span><span>タップで拡大</span></div>` +
      `<div class="source-page-stage" style="aspect-ratio:${pageImage.width}/${pageImage.height}">` +
        `<div class="source-page-placeholder"><span class="source-page-spinner" aria-hidden="true"></span><span>ページ画像を読み込み中</span></div>` +
        `<img class="source-page-image" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" data-source-asset-id="${escapeHtml(pageImage.assetId)}">` +
        `<div class="source-page-marks" aria-hidden="true">${marks}</div>` +
      `</div>` +
      `<p class="source-page-note">${note}</p>` +
    `</div>`;
}

const sourceAssetUrlCache = new Map();
let sourceAssetUseTick = 0;
let sourcePageViewer = null;
let sourceViewerPreviousFocus = null;

function clearSourceAssetUrlCache() {
  for (const item of sourceAssetUrlCache.values()) {
    try { URL.revokeObjectURL(item.url); } catch (e) { /* ignore */ }
  }
  sourceAssetUrlCache.clear();
}

function pruneSourceAssetUrlCache() {
  if (sourceAssetUrlCache.size <= SOURCE_ASSET_CACHE_LIMIT) return;
  const active = new Set(Array.from(document.querySelectorAll('.source-page-image[data-source-asset-id]'))
    .map(img => img.dataset.sourceAssetId).filter(Boolean));
  const ordered = Array.from(sourceAssetUrlCache.entries()).sort((a, b) => a[1].used - b[1].used);
  for (const [id, item] of ordered) {
    if (sourceAssetUrlCache.size <= SOURCE_ASSET_CACHE_LIMIT) break;
    if (active.has(id)) continue;
    try { URL.revokeObjectURL(item.url); } catch (e) { /* ignore */ }
    sourceAssetUrlCache.delete(id);
  }
}

async function getSourceAssetUrl(id) {
  const cached = sourceAssetUrlCache.get(id);
  if (cached) {
    cached.used = ++sourceAssetUseTick;
    return cached.url;
  }
  const record = await dbGet(STORE_A, id);
  if (!record || !(record.blob instanceof Blob)) return '';
  const url = URL.createObjectURL(record.blob);
  sourceAssetUrlCache.set(id, { url, used: ++sourceAssetUseTick });
  pruneSourceAssetUrlCache();
  return url;
}

function closeSourcePageViewer() {
  if (!sourcePageViewer) return;
  document.removeEventListener('keydown', handleSourceViewerKeydown);
  sourcePageViewer.remove();
  sourcePageViewer = null;
  document.body.classList.remove('source-viewer-open');
  if (sourceViewerPreviousFocus && document.contains(sourceViewerPreviousFocus)) {
    try { sourceViewerPreviousFocus.focus(); } catch (e) { /* ignore */ }
  }
  sourceViewerPreviousFocus = null;
}

function handleSourceViewerKeydown(e) {
  if (e.key === 'Escape') closeSourcePageViewer();
}

function openSourcePageViewer(wrapper) {
  const originalStage = wrapper.querySelector('.source-page-stage');
  const originalImage = wrapper.querySelector('.source-page-image');
  if (!originalStage || !originalImage || !originalImage.src || !wrapper.classList.contains('is-ready')) return;
  closeSourcePageViewer();
  sourceViewerPreviousFocus = document.activeElement;

  const viewer = document.createElement('div');
  viewer.className = 'source-image-viewer';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', '出典ページ拡大表示');

  const bar = document.createElement('div');
  bar.className = 'source-image-viewer-bar';
  const title = document.createElement('div');
  title.className = 'source-image-viewer-title';
  const titleStrong = document.createElement('strong');
  titleStrong.textContent = wrapper.dataset.sourceDocument || '出典資料';
  const titlePage = document.createElement('span');
  titlePage.textContent = wrapper.dataset.sourcePage ? `PDF p.${wrapper.dataset.sourcePage}` : '資料画像';
  title.append(titleStrong, titlePage);

  const actions = document.createElement('div');
  actions.className = 'source-image-viewer-actions';
  const zoomButton = document.createElement('button');
  zoomButton.type = 'button';
  zoomButton.className = 'source-image-viewer-zoom';
  zoomButton.textContent = '等倍表示';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'source-image-viewer-close';
  closeButton.setAttribute('aria-label', '閉じる');
  closeButton.textContent = '×';
  actions.append(zoomButton, closeButton);
  bar.append(title, actions);

  const scroll = document.createElement('div');
  scroll.className = 'source-image-viewer-scroll';
  const stage = originalStage.cloneNode(true);
  stage.classList.add('source-image-viewer-stage', 'is-ready');
  const placeholder = stage.querySelector('.source-page-placeholder');
  if (placeholder) placeholder.remove();
  const image = stage.querySelector('.source-page-image');
  if (image) image.loading = 'eager';
  const naturalWidth = Math.max(320, Math.min(1800, Number(wrapper.dataset.sourceWidth) || originalImage.naturalWidth || 900));
  stage.style.setProperty('--source-natural-width', `${naturalWidth}px`);
  scroll.append(stage);
  viewer.append(bar, scroll);

  closeButton.addEventListener('click', closeSourcePageViewer);
  zoomButton.addEventListener('click', () => {
    const actual = viewer.classList.toggle('is-actual');
    zoomButton.textContent = actual ? '全体表示' : '等倍表示';
    scroll.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  });
  viewer.addEventListener('click', e => {
    if (e.target === viewer) closeSourcePageViewer();
  });
  document.body.appendChild(viewer);
  document.body.classList.add('source-viewer-open');
  sourcePageViewer = viewer;
  document.addEventListener('keydown', handleSourceViewerKeydown);
  closeButton.focus();
}

function bindSourcePageVisual(wrapper) {
  if (wrapper.dataset.sourceViewerBound === '1') return;
  wrapper.dataset.sourceViewerBound = '1';
  wrapper.addEventListener('click', () => openSourcePageViewer(wrapper));
  wrapper.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openSourcePageViewer(wrapper);
    }
  });
}

function hydrateSourcePageImages(root) {
  const wrappers = root.querySelectorAll('.source-page-visual[data-source-asset-id]');
  wrappers.forEach(wrapper => {
    bindSourcePageVisual(wrapper);
    if (wrapper.dataset.sourceHydrated === '1') return;
    wrapper.dataset.sourceHydrated = '1';
    const image = wrapper.querySelector('.source-page-image');
    const placeholderText = wrapper.querySelector('.source-page-placeholder span:last-child');
    const assetId = wrapper.dataset.sourceAssetId;
    if (!image || !assetId) return;
    image.addEventListener('load', () => wrapper.classList.add('is-ready'), { once: true });
    image.addEventListener('error', () => {
      wrapper.classList.add('is-error');
      if (placeholderText) placeholderText.textContent = 'ページ画像を読み込めませんでした';
    }, { once: true });
    getSourceAssetUrl(assetId).then(url => {
      if (!document.contains(wrapper)) return;
      if (!url) {
        wrapper.classList.add('is-error');
        if (placeholderText) placeholderText.textContent = 'ページ画像データが見つかりません';
        return;
      }
      image.src = url;
    }).catch(e => {
      console.warn('ページ画像の読み込みに失敗しました', e);
      wrapper.classList.add('is-error');
      if (placeholderText) placeholderText.textContent = 'ページ画像を読み込めませんでした';
    });
  });
}

function renderQuestionSources(q) {
  const entry = findSourceEntry(q);
  const sourceLabel = String((entry && entry.source) || q.source || '').trim();
  const refs = entry && Array.isArray(entry.references) ? entry.references.filter(Boolean) : [];
  if (!sourceLabel && refs.length === 0) return '';

  let body = '';
  if (sourceLabel) {
    body += `<div class="source-label"><span>CSV記載</span><div>${escapeHtml(sourceLabel)}</div></div>`;
  }

  if (!state.sourceIndex.loaded) {
    body += '<p class="source-note">設定でローカル出典データを読み込むと、資料名・ページ・該当本文を表示できます。</p>';
  } else if (refs.length > 0) {
    for (const ref of refs) {
      const match = ref.match === 'verified' ? 'verified' : (ref.match === 'inferred' ? 'inferred' : 'citation');
      const badge = match === 'verified' ? '資料内の一致箇所' : (match === 'inferred' ? '資料内の一致候補' : '出典情報のみ');
      const documentName = String(ref.document || '出典資料');
      const page = Number.isInteger(ref.page) && ref.page > 0 ? `<span class="source-page">PDF p.${ref.page}</span>` : '';
      body += `<article class="source-ref ${match}">` +
        `<div class="source-ref-head"><span class="source-badge ${match}">${badge}</span>${page}</div>` +
        `<div class="source-document">${escapeHtml(documentName)}</div>` +
        sourcePageVisualHtml(ref, documentName);
      if (ref.excerpt) {
        body += `<div class="source-excerpt">${highlightSourceExcerpt(ref.excerpt, ref.highlights)}</div>`;
        if (match === 'inferred') {
          body += '<p class="source-note">問題文との類似度から抽出した候補です。前後の文脈は元資料で確認してください。</p>';
        }
      } else {
        body += '<p class="source-note">本文の一致箇所を安全に特定できなかったため、資料名とページ情報だけを表示しています。</p>';
      }
      body += '</article>';
    }
  } else if (!entry) {
    body += '<p class="source-note">現在の問題内容に一致するローカル索引がありません。問題を編集した場合は、出典データを再作成してください。</p>';
  } else {
    body += '<p class="source-note">提供資料内で安全に特定できる本文一致が見つからなかったため、CSV記載の出典だけを表示しています。</p>';
  }

  return `<section class="source-panel" aria-label="出典"><h3>出典（ローカル資料）</h3>${body}</section>`;
}

function showQuestionSources(q) {
  const el = document.getElementById('study-sources');
  if (!el) return;
  const html = renderQuestionSources(q);
  el.innerHTML = html;
  el.hidden = !html;
  if (html) hydrateSourcePageImages(el);
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
  if (states.some(s => s.prog && s.prog.lapses >= 4 && s.prog.interval < 7 && s.st !== 'mastered')) return 'leech';
  if (states.some(isReinforcementBlank)) return 'learning';
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

  // 出典索引は公開物・同期データと分離し、端末のmetaストアからのみ復元する。
  await loadLocalSourceIndex();

  // 旧 per-question 進捗 → 穴ごと進捗へマイグレーション(履歴を保持)
  await migrateProgressToPerBlank();
  // 旧版の高速連続正解方式から、累計3回正解方式へ安全に移行する。
  await migrateProgressCorrectCounts();
  // 日別学習数を読み込み、更新前の履歴は問題単位へ重複除去して復元する。
  await loadDailyStudyHistory();

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
    np.correctCount = old.correctCount != null ? old.correctCount : progressCorrectCount(old);
    np.fastStreak = old.fastStreak != null ? old.fastStreak : (np.mastered ? MASTER_CORRECT_COUNT : 0);
    normalizeProgressMastery(np);
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

async function migrateProgressCorrectCounts() {
  const changed = [];
  for (const p of Object.values(state.progress)) {
    if (normalizeProgressMastery(p)) changed.push(p);
  }
  if (changed.length === 0) return;
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_P, 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    const store = t.objectStore(STORE_P);
    for (const p of changed) store.put(p);
  });
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

function progressKeyQuestionId(key) {
  const s = String(key || '');
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(0, i) : s;
}

// 旧版には日別問題数の専用記録がないため、穴の履歴を「日付×問題ID」で重複除去して復元する。
function deriveDailyStudyCountsFromProgress() {
  const byDate = {};
  for (const [key, p] of Object.entries(state.progress)) {
    const qid = progressKeyQuestionId(key);
    for (const h of (Array.isArray(p.history) ? p.history : [])) {
      const d = h && typeof h.d === 'string' ? h.d : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (!byDate[d]) byDate[d] = new Set();
      byDate[d].add(qid);
    }
  }
  const out = {};
  for (const [d, ids] of Object.entries(byDate)) out[d] = ids.size;
  return out;
}

function normalizeDailyStudyRecord(rec) {
  if (!rec || !/^\d{4}-\d{2}-\d{2}$/.test(String(rec.date || ''))) return null;
  const num = v => Math.max(0, Math.floor(Number(v) || 0));
  return {
    date: String(rec.date),
    studied: num(rec.studied != null ? rec.studied : rec.count),
    correct: num(rec.correct),
    newCount: num(rec.newCount),
    reviewCount: num(rec.reviewCount),
    modes: rec.modes && typeof rec.modes === 'object' ? { ...rec.modes } : {},
    migrated: !!rec.migrated,
    updatedAt: rec.updatedAt || '',
  };
}

async function loadDailyStudyHistory() {
  state.dailyStudy = {};
  const rows = await dbGetAll(STORE_S);
  for (const row of rows) {
    const rec = normalizeDailyStudyRecord(row);
    if (rec) state.dailyStudy[rec.date] = rec;
  }

  const derived = deriveDailyStudyCountsFromProgress();
  const additions = [];
  for (const [date, studied] of Object.entries(derived)) {
    if (state.dailyStudy[date]) continue;
    const rec = {
      date, studied, correct: 0, newCount: 0, reviewCount: 0,
      modes: {}, migrated: true, updatedAt: new Date().toISOString(),
    };
    state.dailyStudy[date] = rec;
    additions.push(rec);
  }
  if (additions.length > 0) {
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_S, 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = resolve;
      const store = t.objectStore(STORE_S);
      for (const rec of additions) store.put(rec);
    });
  }
}

async function recordDailyStudy({ allCorrect, hadNew, mode }) {
  const today = dateKey();
  let rec = normalizeDailyStudyRecord(state.dailyStudy[today]) || {
    date: today, studied: 0, correct: 0, newCount: 0, reviewCount: 0,
    modes: {}, migrated: false, updatedAt: '',
  };
  rec.studied += 1;
  if (allCorrect) rec.correct += 1;
  if (hadNew) rec.newCount += 1; else rec.reviewCount += 1;
  const modeKey = ['review', 'new', 'mixed', 'wrong'].includes(mode) ? mode : 'other';
  rec.modes[modeKey] = Math.max(0, Math.floor(Number(rec.modes[modeKey]) || 0)) + 1;
  rec.updatedAt = new Date().toISOString();
  state.dailyStudy[today] = rec;
  await dbPut(STORE_S, rec);
}

async function replaceDailyStudyHistory(records) {
  const normalized = [];
  for (const row of (Array.isArray(records) ? records : [])) {
    const rec = normalizeDailyStudyRecord(row);
    if (rec) normalized.push(rec);
  }
  await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_S, 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    const store = t.objectStore(STORE_S);
    store.clear();
    for (const rec of normalized) store.put(rec);
  });
  await loadDailyStudyHistory();
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
  if (name !== 'view-study') closeSourcePageViewer();
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
  const reviewIds = new Set();
  const newIds = new Set();
  const reinforcementIds = new Set();
  const totalIds = new Set();
  for (const q of state.questions) {
    if (catFilter !== 'all' && q.category !== catFilter) continue;
    const states = getBlankStates(q);
    const hasDue = states.some(s => s.st === 'due');
    const hasNew = states.some(s => s.st === 'new');
    const hasReinforcement = states.some(isReinforcementBlank);
    if (hasDue || hasReinforcement) reviewIds.add(q.id);
    if (hasNew) newIds.add(q.id);
    if (hasReinforcement) reinforcementIds.add(q.id);
    if (hasDue || hasNew || hasReinforcement) totalIds.add(q.id);
  }
  return {
    due: reviewIds.size,
    newq: newIds.size,
    reinforce: reinforcementIds.size,
    total: totalIds.size,
  };
}

function getWrongCount(catFilter) {
  let n = 0;
  for (const q of state.questions) {
    if (catFilter !== 'all' && q.category !== catFilter) continue;
    const states = getBlankStates(q);
    if (states.some(s => s.prog && s.st !== 'mastered' && s.prog.lapses >= 1 && s.prog.interval < 14)) n++;
  }
  return n;
}

function renderHome() {
  // Category chips
  document.querySelectorAll('#view-home .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.cat === state.selectedCat);
  });
  // Counts
  const { due, newq, reinforce, total } = getDeckCounts(state.selectedCat);
  document.getElementById('num-due').textContent = due;
  document.getElementById('num-new').textContent = newq;
  const heroTotal = total;
  const heroEl = document.getElementById('hero-total');
  if (heroEl) heroEl.textContent = heroTotal;

  // Streak
  document.getElementById('num-streak').textContent = computeStreak();

  // Sub labels
  document.getElementById('btn-review-sub').textContent = `期日・3回正解前の問題 (${due}問)`;
  document.getElementById('btn-new-sub').textContent = `未学習${newq}問 + 定着中${reinforce}問`;
  const wrongN = getWrongCount(state.selectedCat);
  document.getElementById('btn-wrong-sub').textContent = `誤答${wrongN}問 + 定着中${reinforce}問`;

  // Cat stats line
  const cs = document.getElementById('cat-stats');
  if (state.selectedCat === 'all') {
    const lines = ['common','solution','engineering'].map(c => {
      const cnt = state.questions.filter(q => q.category === c).length;
      const dc = getDeckCounts(c);
      return `<span>${CATS[c]} ${cnt}問 (対象${dc.total})</span>`;
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
    const k = dateKey(cur);
    if (dates.has(k)) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    } else if (streak === 0) {
      // allow today not to break streak -> roll back once
      cur.setDate(cur.getDate() - 1);
      const k2 = dateKey(cur);
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
function uniqueQuestions(items) {
  const seen = new Set();
  const out = [];
  for (const q of items) {
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
  }
  return out;
}

function buildDeck(mode) {
  const cat = state.selectedCat;
  const size = state.selectedSize;
  const newCap = Math.max(0, state.settings.newPerDay - state.todaySeen.new);
  const revCap = Math.max(0, state.settings.revPerDay - state.todaySeen.rev);

  const filterCat = (q) => cat === 'all' || q.category === cat;

  const dueList = [];
  const newList = [];
  const wrongList = [];
  const reinforcementList = [];

  // 正解1～2回の「定着中」は全モード共通の優先枠として扱う。
  const earliestDue = {};
  for (const q of state.questions) {
    if (!filterCat(q)) continue;
    const states = getBlankStates(q);
    const hasDue = states.some(s => s.st === 'due');
    const hasNew = states.some(s => s.st === 'new');
    const hasWrong = states.some(s => s.prog && s.st !== 'mastered' && s.prog.lapses >= 1 && s.prog.interval < 14);
    const hasReinforcement = states.some(isReinforcementBlank);
    if (hasDue) {
      dueList.push(q);
      const dues = states.filter(s => s.st === 'due' && s.prog).map(s => new Date(s.prog.due).getTime());
      earliestDue[q.id] = dues.length ? Math.min(...dues) : 0;
    }
    if (hasNew) newList.push(q);
    if (hasWrong) wrongList.push(q);
    if (hasReinforcement) reinforcementList.push(q);
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
  const totalLapses = (q) => getBlankStates(q).reduce((sum, x) => sum + (x.prog ? x.prog.lapses : 0), 0);
  wrongList.sort((a, b) => totalLapses(b) - totalLapses(a));
  // 定着中は正解回数が少ない問題を先にし、同数なら前回学習が古いものを優先する。
  const reinforcementScore = (q) => {
    const ss = getBlankStates(q).filter(isReinforcementBlank);
    const minCorrect = ss.length ? Math.min(...ss.map(x => x.correctCount)) : MASTER_CORRECT_COUNT;
    const oldest = ss.map(x => x.prog && x.prog.lastReviewed ? new Date(x.prog.lastReviewed).getTime() : 0);
    return [minCorrect, oldest.length ? Math.min(...oldest) : 0];
  };
  reinforcementList.sort((a, b) => {
    const aa = reinforcementScore(a), bb = reinforcementScore(b);
    return aa[0] - bb[0] || aa[1] - bb[1];
  });

  const reinforcementIds = new Set(reinforcementList.map(q => q.id));
  const dueOnly = dueList.filter(q => !reinforcementIds.has(q.id));
  const newOnly = newList.filter(q => !reinforcementIds.has(q.id));
  const wrongOnly = wrongList.filter(q => !reinforcementIds.has(q.id));
  const reinforce = shuffle(reinforcementList);

  let deck = [];
  if (mode === 'review') {
    deck = uniqueQuestions([...reinforce, ...shuffle(dueOnly.slice(0, revCap))]);
  } else if (mode === 'new') {
    deck = uniqueQuestions([...reinforce, ...shuffle(newOnly.slice(0, newCap))]);
  } else if (mode === 'wrong') {
    deck = uniqueQuestions([...reinforce, ...shuffle(wrongOnly)]);
  } else if (mode === 'mixed') {
    // 定着中を先に確保し、残枠へ従来どおり新規・復習を指定比率で混ぜる。
    const [nrRaw, rrRaw] = state.settings.mixRatio.split(':').map(Number);
    const nr = Number.isFinite(nrRaw) && nrRaw >= 0 ? nrRaw : 3;
    const rr = Number.isFinite(rrRaw) && rrRaw >= 0 ? rrRaw : 7;
    const ratioTotal = Math.max(1, nr + rr);
    const target = size > 0 ? size : (reinforce.length + dueOnly.length + newOnly.length);
    const remaining = Math.max(0, target - reinforce.length);
    const nN = Math.min(newOnly.length, newCap, Math.floor(remaining * nr / ratioTotal));
    const rN = Math.min(dueOnly.length, revCap, remaining - nN);
    const news = shuffle(newOnly.slice(0, nN));
    const revs = shuffle(dueOnly.slice(0, rN));
    deck = uniqueQuestions([...reinforce, ...interleave(revs, news)]);
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
  closeSourcePageViewer();
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
  if (q.source) meta.push(`<span>${escapeHtml(q.source)}</span>`);
  if (q.year) meta.push(`<span>(${q.year}年度)</span>`);
  if (q.author) meta.push(`<span class="meta-author">作:${escapeHtml(q.author)}</span>`);
  document.getElementById('study-meta').innerHTML = meta.join(' ');

  document.getElementById('study-question').innerHTML = renderStudyQuestion(q);
  const ansEl = document.getElementById('study-answer');
  ansEl.innerHTML = renderAnswer(q.answer);
  ansEl.hidden = true;
  const sourcesEl = document.getElementById('study-sources');
  if (sourcesEl) { sourcesEl.innerHTML = ''; sourcesEl.hidden = true; }

  // Reset all action elements
  document.getElementById('btn-show-answer').hidden = true;
  document.getElementById('btn-quiz-judge').hidden = true;
  document.getElementById('btn-quiz-next').hidden = true;
  document.getElementById('btn-quiz-manual').hidden = true;
  document.getElementById('rating-grid').hidden = true;
  document.getElementById('quiz-area').hidden = true;
  document.getElementById('quiz-feedback').hidden = true;

  // モード・期日にかかわらず、累計3回正解前の穴をすべて出題する。
  // 習得済みの穴は上の問題文へ正解を埋め込み、入力対象から外す。
  const active = qActiveBlanks(q);
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
    showQuestionSources(q);
    state.quiz.phase = 'finished';
    const nextBtn = document.getElementById('btn-quiz-next');
    nextBtn.hidden = false;
    nextBtn.textContent = (state.studyIdx >= state.studyDeck.length - 1) ? '完了' : '次の問題へ';
  }

  // TTS auto
  stopTTS();
  if (state.ttsEnabled) speakNow(studyQuestionSpeechText(q));
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
  const masteryLabel = `<span class="qbl-mastery">正解 ${b.correctCount}/${MASTER_CORRECT_COUNT}</span>`;
  labelEl.innerHTML = (totalBlanks > 1)
    ? `<span class="qbl-num">${escapeHtml(b.label)}</span> の解答 <span class="qbl-count">(${idx + 1}/${active.length})</span>${masteryLabel}`
    : `解答を入力 ${masteryLabel}`;
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
  const nextCorrectCount = Math.min(MASTER_CORRECT_COUNT, b.correctCount + 1);
  fb.innerHTML = correct
    ? `<span class="fb-mark">✓</span> 正解 <span class="fb-time">${elapsedSec.toFixed(1)}秒</span>`
      + ` <span class="fb-progress">${nextCorrectCount}/${MASTER_CORRECT_COUNT}</span>`
    : `<span class="fb-mark">✗</span> 不正解　<span class="fb-correct-ans">正解: ${escapeHtml(b.answer)}</span>`
      + ` <button class="fb-override" id="fb-override">やっぱり正解だった</button>`;

  if (!correct) {
    const ov = document.getElementById('fb-override');
    if (ov) ov.addEventListener('click', () => {
      state.quiz.results[idx] = { correct: true, elapsedSec };
      input.classList.remove('incorrect');
      input.classList.add('correct');
      fb.className = 'quiz-feedback fb-correct';
      fb.innerHTML = `<span class="fb-mark">✓</span> 正解にしました <span class="fb-progress">${nextCorrectCount}/${MASTER_CORRECT_COUNT}</span>`;
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
  normalizeProgressMastery(bp);
  const wasMastered = bp.mastered;
  const beforeCorrectCount = bp.correctCount;
  const rating = rateBlankAuto(r.correct, r.elapsedSec);
  bp = applySM2(bp, rating);

  // 正解速度はSM-2評価用に残すが、習得は速度を問わず累計正解数で判定する。
  if (r.correct && r.elapsedSec <= BLANK_FAST_SEC) bp.fastStreak = (bp.fastStreak || 0) + 1;
  else bp.fastStreak = 0;
  bp.correctCount = r.correct
    ? Math.min(MASTER_CORRECT_COUNT, beforeCorrectCount + 1)
    : beforeCorrectCount;
  if (bp.correctCount >= MASTER_CORRECT_COUNT) {
    if (!wasMastered) state.quiz.masteredNow.push(b.label || (b.i + 1));
    bp.mastered = true;
  }
  b.correctCount = bp.correctCount;
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

  // 日付をまたいでアプリを開いたままでも、完了した日の記録へ正しく加算する。
  if (state.todayKey !== dateKey()) await resetTodayIfNeeded();
  // 日次カウンタは問題ごとに1回(穴数では数えない)
  if (hadNew) await bumpTodayCounter('new');
  else await bumpTodayCounter('rev');
  await recordDailyStudy({ allCorrect, hadNew, mode: state.studyStats && state.studyStats.mode });

  // セッション統計(問題単位)
  state.studyStats.total += 1;
  if (allCorrect) state.studyStats.good += 1; else state.studyStats.again += 1;

  // 解答全文 + サマリ表示
  const ansEl = document.getElementById('study-answer');
  ansEl.hidden = false;
  const head = active.length > 1 ? `${active.length}問中 ${correctCount}問正解` : (allCorrect ? '正解' : '不正解');
  let summary = `<div class="quiz-summary ${allCorrect ? 'all-ok' : 'some-ng'}">${head}</div>`;
  if (masteredNow && masteredNow.length) {
    summary += `<div class="quiz-mastered">🎓 ${masteredNow.length}個の穴を習得（3回正解。次回から問題文に正解を表示）</div>`;
  }
  // 残りの穴状況
  const ratio = masteryRatio(q);
  summary += `<div class="quiz-autorate">この問題の習得 <strong>${ratio.mastered}/${ratio.total}</strong> 穴</div>`;
  ansEl.innerHTML = summary + renderAnswer(q.answer);
  showQuestionSources(q);

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
    speakNow(ansVisible ? q.answer : studyQuestionSpeechText(q));
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
function renderDailyStudyTrend() {
  const el = document.getElementById('daily-study-trend');
  if (!el) return;
  const now = startOfDay();
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const rec = state.dailyStudy[key];
    series.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      count: rec ? Math.max(0, Number(rec.studied) || 0) : 0,
      migrated: !!(rec && rec.migrated),
    });
  }
  const max = Math.max(1, ...series.map(x => x.count));
  const today = series[series.length - 1].count;
  const last7 = series.slice(-7);
  const average7 = last7.reduce((sum, x) => sum + x.count, 0) / 7;
  const total30 = series.reduce((sum, x) => sum + x.count, 0);
  const best = Math.max(...series.map(x => x.count));
  const bars = series.map((x, i) => {
    const height = x.count > 0 ? Math.max(5, Math.round(x.count / max * 100)) : 0;
    const showLabel = i === 0 || i === series.length - 1 || i % 5 === 0;
    return `<div class="daily-trend-day" title="${x.key}: ${x.count}問" aria-label="${x.key} ${x.count}問">
      <div class="daily-trend-value">${x.count || ''}</div>
      <div class="daily-trend-bar-track"><div class="daily-trend-bar" style="height:${height}%"></div></div>
      <div class="daily-trend-label">${showLabel ? x.label : ''}</div>
    </div>`;
  }).join('');
  const hasMigrated = series.some(x => x.migrated);
  el.innerHTML = `<div class="daily-trend-summary">
      <div><span>今日</span><strong>${today}</strong><small>問</small></div>
      <div><span>7日平均</span><strong>${average7.toFixed(1)}</strong><small>問/日</small></div>
      <div><span>30日合計</span><strong>${total30}</strong><small>問</small></div>
      <div><span>最多</span><strong>${best}</strong><small>問/日</small></div>
    </div>
    <div class="daily-trend-scroll" tabindex="0" aria-label="直近30日の日別学習問題数。横にスクロールできます">
      <div class="daily-trend-chart">${bars}</div>
    </div>
    <p class="daily-trend-note">完了した問題を1回ごとに集計します。${hasMigrated ? '更新前の期間は、既存の穴別履歴から同じ問題を日ごとに重複除去して復元しています。' : ''}</p>`;
}

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

  renderDailyStudyTrend();

  // Heatmap (last 30 days / blank answers)
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
    const k = dateKey(d);
    const n = counts[k] || 0;
    let lvl = 0;
    if (n >= 30) lvl = 4;
    else if (n >= 15) lvl = 3;
    else if (n >= 5) lvl = 2;
    else if (n >= 1) lvl = 1;
    cells.push(`<div class="heat-cell" data-level="${lvl}" title="${k}: 穴回答 ${n}回"></div>`);
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
  renderSourceIndexStatus();
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
    version: 3,
    type: 'icloud-sync',
    savedAt: new Date().toISOString(),
    deviceHint: navigator.userAgent.includes('iPhone') ? 'iPhone'
      : navigator.userAgent.includes('Mac') ? 'Mac' : 'unknown',
    settings: state.settings,
    questions: state.questions,
    progress: Object.values(state.progress),
    sessions: Object.values(state.dailyStudy),
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
    await migrateProgressToPerBlank();
    await migrateProgressCorrectCounts();

    const sessionRaw = Array.isArray(data.sessions)
      ? data.sessions
      : Object.values(data.sessions || data.dailyStudy || {});
    await replaceDailyStudyHistory(sessionRaw);

    // settings があれば上書き
    if (data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      await saveSettings();
    }

    toast(`☁️ 読み込み完了: ${state.questions.length}問 / 進捗${Object.keys(state.progress).length}件`);
    applyTheme(); applyFontSize();
    renderHome(); renderList(); renderStats(); renderSettings();
  } catch (e) {
    console.error(e);
    toast('読み込み失敗: ' + e.message);
  }
}

async function exportAll() {
  const data = {
    version: 3,
    type: 'full',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    questions: state.questions,
    progress: state.progress,
    sessions: state.dailyStudy,
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
      const importedProgress = Array.isArray(data.progress)
        ? data.progress
        : Object.values(data.progress || {});
      for (const p of importedProgress) {
        if (!p || !p.questionId) continue;
        await dbPut(STORE_P, p);
        state.progress[p.questionId] = p;
      }
      await migrateProgressToPerBlank();
      await migrateProgressCorrectCounts();

      const sessionRaw = Array.isArray(data.sessions)
        ? data.sessions
        : Object.values(data.sessions || data.dailyStudy || {});
      await replaceDailyStudyHistory(sessionRaw);
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
    renderHome(); renderList(); renderStats(); renderSourceIndexStatus();
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

async function resetProgress() {
  await Promise.all([dbClear(STORE_P), dbClear(STORE_S)]);
  state.progress = {};
  state.dailyStudy = {};
  await metaSet('todayCounters', { date: state.todayKey, new: 0, rev: 0 });
  state.todaySeen = { new: 0, rev: 0 };
  toast('進捗と日別学習記録をリセットしました');
  renderHome(); renderList(); renderStats();
}

async function resetAll() {
  // 全ストアを1トランザクションでクリア
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE_Q, STORE_P, STORE_S, STORE_M, STORE_A], 'readwrite');
    t.onerror = () => reject(t.error);
    t.oncomplete = resolve;
    [STORE_Q, STORE_P, STORE_S, STORE_M, STORE_A].forEach(s => t.objectStore(s).clear());
  });
  closeSourcePageViewer();
  clearSourceAssetUrlCache();
  state.questions = [];
  state.progress = {};
  state.dailyStudy = {};
  state.sourceIndex = emptySourceIndex();
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
  // ローカル出典データ（バックアップ・iCloud同期・GitHub公開物には含めない）
  document.getElementById('btn-import-source-index').addEventListener('click', () => {
    document.getElementById('file-import-source-index').click();
  });
  document.getElementById('file-import-source-index').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await importLocalSourceIndex(f);
    e.target.value = '';
  });
  document.getElementById('btn-clear-source-index').addEventListener('click', async () => {
    if (!state.sourceIndex.loaded) return;
    const ok = await confirm('ローカル出典データだけをこの端末から削除します。\n問題・学習履歴は残ります。よろしいですか?');
    if (ok) await clearLocalSourceIndex();
  });

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
    const ok = await confirm('全ての学習進捗(SM-2の状態・履歴・本日のカウンタ・日別学習数)をリセットします。\n問題自体は残ります。よろしいですか?');
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
}

// Boot
window.addEventListener('DOMContentLoaded', init);

})();
