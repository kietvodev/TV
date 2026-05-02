// Service Worker - XemTV.vn
// Không cache JS/CSS/HTML — luôn lấy mới từ mạng

const CACHE_NAME = 'xemtv-v2';
// Chỉ cache ảnh icon (ít thay đổi)
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

// Activate: xóa toàn bộ cache cũ
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: KHÔNG cache HTML, JS, CSS, JSON — network only
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Luôn network: HTML, JS, CSS, JSON, PHP, stream
  const networkOnly = [
    '.html', '.js', '.css', '.json',
    '.php', '.m3u8', '.ts',
    'googletagmanager', 'jwplatform'
  ];
  if (networkOnly.some(s => url.includes(s))) {
    return; // network only, không qua cache
  }

  // Cache first chỉ cho ảnh icon
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
