// Offline cache for the tower defense game only. Registered with
// scope: '/tower-defense.html' so it never touches index.html, budget.html,
// or any /api/* request elsewhere on the site.
const CACHE_NAME = 'td-cache-v1';
const ASSET = '/tower-defense.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(ASSET)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// stale-while-revalidate: serve the cached page instantly (works fully
// offline), and refresh the cache in the background whenever the network
// is reachable so the next launch picks up new versions of the game.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((res) => {
        if (res && res.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
