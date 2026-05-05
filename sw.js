// Service Worker - XemTV.vn
// Cache JS/CSS trong phiên, xóa khi user thoát web

const CACHE_NAME = 'xemtv-session-v2';
const STATIC_ASSETS = [
  '/Image_WEB/XEMTV_192X192.png',
  '/Image_WEB/XEMTV_96X96.png'
];

// Install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: xóa cache cũ
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Message: xóa toàn bộ cache khi nhận lệnh từ page
self.addEventListener('message', e => {
  if (e.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});

// Fetch: cache JS, CSS, ảnh — network first, fallback cache
self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;

  // Không cache: stream, API, PHP
  const skipCache = ['.m3u8', '.ts', '.mpd', '.dash', '.mp4', '.php', '.json', '/api/', 'localhost'];
  if (skipCache.some(s => url.includes(s))) return;

  // Cache JS, CSS, ảnh: network first, lưu vào cache
  const shouldCache = url.match(/\.(js|css|png|jpg|jpeg|gif|webp|ico|woff2?)/);
  if (shouldCache) {
    e.respondWith(
      fetch(e.request).then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // HTML: luôn network
  if (url.includes('.html') || e.request.mode === 'navigate') return;

  // Mọi thứ khác: cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
