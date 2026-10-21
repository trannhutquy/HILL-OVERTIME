/* Service worker: mở app tức thì và chạy được khi mất mạng.
   - File của app: trả bản đã lưu ngay, đồng thời tải bản mới ngầm (lần mở sau sẽ dùng bản mới).
   - Phông Google Fonts: lưu lại để offline vẫn đúng chữ.
   - Gọi API Apps Script (POST) không bao giờ bị lưu. Đổi VERSION khi thêm/bớt file trong SHELL. */
const VERSION = 'hill-v1';
const FONTS = 'hill-fonts';
const SHELL = [
  './', 'index.html', 'config.js', 'pwa.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/logo-mark.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function swr(e, cacheName, fallbackKey) {
  e.respondWith(caches.open(cacheName).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) { try { cache.put(e.request, res.clone()); } catch (_) {} }
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    return (fallbackKey && await cache.match(fallbackKey)) || Response.error();
  }));
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) swr(e, VERSION, e.request.mode === 'navigate' ? 'index.html' : null);
  else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') swr(e, FONTS, null);
});
