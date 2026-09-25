/* Cache static assets so Keys + Offline Signer work without network after first visit */
const CACHE = 'zkp-family-vote-v4';
const PRECACHE = [
  '/',
  '/index.html',
  '/voter.html',
  '/keys.html',
  '/offline.html',
  '/register.html',
  '/vote.html',
  '/results.html',
  '/admin.html',
  '/css/app.css',
  '/js/crypto-client.js',
  '/js/help.js',
  '/js/wizard-ui.js',
  '/js/nav.js',
  '/js/importmap.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API — always network for live election state
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((res) => {
          if (res.ok && event.request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
