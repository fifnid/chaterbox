const CACHE = 'chatterbox-shell-v15';
const OCR_CACHE = 'linia-school-ocr-v1';
const SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/icon-1024.png', '/icons/icon-maskable-512.png', '/favicon.ico', '/favicon.png', '/avatars/teacher-neutral.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && key !== OCR_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api') return;
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/ocr/')) {
    event.respondWith(caches.open(OCR_CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) { try { await cache.put(event.request, response.clone()); } catch {} }
      return response;
    }));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname === '/' || SHELL.includes(url.pathname))) {
      const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html'))));
});
