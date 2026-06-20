// =====================================================================
// Service Worker — PWA インストール要件 (fetch ハンドラ) + オフライン対応
//
// アプリシェル (ルートの HTML / アイコン / マニフェスト ＋ src/main の ES モジュール群)
// を install 時にキャッシュし、fetch はキャッシュ優先 + ネットワークフォールバックで返す。
// これにより「ホーム画面に追加 / インストール」が可能になり、オフラインでも動く。
// テストコード (src/test) は ASSETS に含めず、実行時キャッシュからも除外する
// (= PWA には src/test を一切含めない)。
// =====================================================================
const CACHE = 'esora-maps-v2';
const ASSETS = [
  // ルート: アプリシェル ＋ PWA 設定
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  // src/main: アプリ本体 (ES モジュール)
  './src/main/main.js', './src/main/camera.js', './src/main/collectible.js',
  './src/main/config.js', './src/main/effects.js', './src/main/input.js',
  './src/main/litter.js', './src/main/mail.js', './src/main/map.js',
  './src/main/render.js', './src/main/rng.js', './src/main/roadpart.js',
  './src/main/scenario.js', './src/main/vehicles.js',
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
  const url = new URL(e.request.url);
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      // 同一オリジンの取得はキャッシュへ追記 (オフライン対応を広げる)。
      // ただし src/test 配下は PWA に含めないのでキャッシュしない。
      if (res.ok && url.origin === self.location.origin && !url.pathname.includes('/src/test/')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html'))) // オフラインで未キャッシュ → シェルへ
  );
});
