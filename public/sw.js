// WATTS Voice service worker: app shell works offline on the shop floor.
// Bump VERSION whenever files in public/ change.
const VERSION = 'wv-2026-10-03-2';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/model.js', 'js/matcher.js', 'js/store.js', 'js/speech.js',
  'js/camera.js', 'js/timeline.js', 'js/export.js', 'js/zip.js', 'js/util.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // AI / transcription calls are never cached
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) {
    // Network first for catalog/config; fall back to the last good copy offline.
    if (/\/api\/(catalog|config)$/.test(url.pathname)) {
      event.respondWith(fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req)));
    }
    return;
  }
  // App shell: network first (so deploys show up), cache when offline.
  event.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
});
