// オフラインでも開けるようにするための Service Worker。
// 自分のサイトのファイルは「まずネット、だめならキャッシュ」で返すので、更新はすぐ反映されます。
// 歌詞検索（lrclib.net）など外部への通信には手を出しません。
const CACHE = 'ktv-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'vendor/pinyin-pro.js',
  'vendor/hanzi-map.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))),
  );
});
