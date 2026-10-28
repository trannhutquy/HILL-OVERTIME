/* Service worker: mở app tức thì, chạy được khi mất mạng, và TỰ BÁO khi có bản mới.
   - File của app: trả ngay bản đã lưu, đồng thời hỏi lại GitHub (bỏ qua bộ nhớ đệm của trình duyệt).
     Nếu nội dung khác bản đã lưu thì lưu bản mới rồi báo cho trang để tự tải lại.
   - Phông Google Fonts: lưu lại để offline vẫn đúng chữ.
   - Gọi API Apps Script (POST) không bao giờ bị lưu. Đổi VERSION khi thêm/bớt file trong SHELL. */
const VERSION = 'hill-v2';
const FONTS = 'hill-fonts';
const SHELL = [
  './', 'index.html', 'config.js', 'pwa.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/logo-mark.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const TEXTY = /\.(html|js|json|webmanifest|css)$|\/$/;

async function changed(oldRes, newRes) {
  try {
    const [a, b] = await Promise.all([oldRes.clone().text(), newRes.clone().text()]);
    return a !== b;
  } catch (_) { return false; }
}

async function notify() {
  const all = await self.clients.matchAll({ type: 'window' });
  all.forEach((c) => c.postMessage({ type: 'HILL_UPDATED' }));
}

function swr(e, cacheName, fallbackKey, sameOrigin) {
  e.respondWith(caches.open(cacheName).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    // same-origin: bỏ qua bộ nhớ đệm HTTP (GitHub Pages giữ ~10 phút) để thấy bản mới sớm
    const net = (sameOrigin ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request))
      .then(async (res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const isNew = hit && sameOrigin && TEXTY.test(new URL(e.request.url).pathname) && await changed(hit, res);
          try { await cache.put(e.request, res.clone()); } catch (_) {}
          if (isNew) await notify();
        }
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
  if (url.origin === self.location.origin) swr(e, VERSION, e.request.mode === 'navigate' ? 'index.html' : null, true);
  else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') swr(e, FONTS, null, false);
});

/* ---------- Thông báo đẩy (Firebase Cloud Messaging) ----------
   Firebase gửi nội dung bọc trong "data" (tin do máy chủ gửi) hoặc "notification" (tin gửi thử từ trang Firebase). */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  const n = d.notification || d.data || d;
  e.waitUntil(self.registration.showNotification(n.title || 'Nhập giờ tăng ca', {
    body: n.body || 'Hôm nay bạn ra về lúc mấy giờ? Bấm để nhập nhé.',
    icon: 'icons/icon-192.png',
    tag: 'hill-daily',          // nhiều thông báo cùng loại chỉ giữ cái mới nhất
    data: { url: './' }
  }));                           // iOS bắt buộc: mỗi lần đẩy phải hiện thông báo
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
