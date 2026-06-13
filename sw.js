// =====================================================================
// Service Worker — PWA インストール要件 (fetch ハンドラ) + オフライン対応
//
// アプリシェル (HTML / ES モジュール群 / アイコン / マニフェスト) を install 時に
// キャッシュし、fetch はキャッシュ優先 + ネットワークフォールバックで返す。
// これにより「ホーム画面に追加 / インストール」が可能になり、オフラインでも動く。
// 自己完結アプリ (外部データ無し) なので一度キャッシュすれば完全に動作する。
// =====================================================================
const CACHE = 'esora-maps-v1';
const ASSETS = [
  './', './index.html', './main.js',
  './camera.js', './config.js', './input.js', './map.js', './render.js',
  './rng.js', './roadpart.js', './scenario.js', './vehicles.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      // 同一オリジンの取得はキャッシュへ追記 (オフライン対応を広げる)
      if (res.ok && new URL(e.request.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html'))) // オフラインで未キャッシュ → シェルへ
  );
});
