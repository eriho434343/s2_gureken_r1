// Service Worker - 自己解除版
// 以前のバージョンでPWA(ホーム画面追加)をお使いだった方向け:
// このファイルが読み込まれると、旧キャッシュを全て削除してSWを解除します。
// IndexedDB(問題・学習履歴)には一切触れません。

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});
