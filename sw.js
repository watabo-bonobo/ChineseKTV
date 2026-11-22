// オフラインでも開けるようにするための Service Worker。
// 自分のサイトのファイルは「まずネット、だめならキャッシュ」で返すので、更新はすぐ反映されます。
//
// 更新直後に index.html だけ新しく app.js / style.css が古い、と混ざらないようにしている点：
// - ネットから取るときはブラウザのキャッシュ（GitHub Pages は 10 分）を使わず、毎回サーバーに確認する
//   （変わっていなければ 304 が返るだけなので軽い）
// - ページに渡すファイルには「次も確認して」（Cache-Control: no-cache）を付け直す。
//   付けないと、再読み込みのときブラウザがメモリ上の古い app.js をこの Service Worker を通さずに使い回す
//
// 歌詞検索（lrclib.net）など外部への通信には手を出しません。
const CACHE = 'ktv-v2';
const ASSETS = [
  './',
  'index.html',
  'style.css?v=2', // index.html と同じ URL にしておく
  'app.js?v=2',
  'vendor/pinyin-pro.js',
  'vendor/hanzi-map.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ページに渡す前に「次も確認して」を付ける（画面そのもの＝ナビゲーションはそのまま返す）
function revalidateNextTime(req, res) {
  if (!res || req.mode === 'navigate' || res.type !== 'basic') return res;
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    // 古いブラウザで no-cache 付きの取得ができないときは、ふつうに取り直す
    fetch(req, { cache: 'no-cache' })
      .catch(() => fetch(req))
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req)
          .then((hit) => hit || caches.match(req, { ignoreSearch: true }))
          .then((hit) => hit || caches.match('./')),
      )
      .then((res) => revalidateNextTime(req, res)),
  );
});
