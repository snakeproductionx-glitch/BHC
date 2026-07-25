// LabourArc Service Worker — basic offline support
// Caches the app shell so the app still opens (with last-seen UI) when offline,
// instead of showing a blank white screen.

const CACHE_NAME = 'labourarc-cache-v1';

// Add any other core static files your app always needs (logo, main CSS/JS bundle names
// change on every build, so those are cached automatically as they're requested — see fetch handler below).
const CORE_ASSETS = [
  './',
  './index.html',
  './offline.html',
];

// Install: pre-cache the core app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for navigation/API, falling back to cache, then offline page.
// Static assets (JS/CSS/images) are cached as they're fetched, so the app shell works offline
// even on a second visit without needing to know exact hashed filenames ahead of time.
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests — POST/PUT (e.g. clock-in, payroll submits) always need network
  if (request.method !== 'GET') return;

  // Page navigations: try network, fall back to cached page, then offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('./offline.html'))
        )
    );
    return;
  }

  // Static assets (JS, CSS, images, fonts): cache-first, then network, cache the result
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Don't cache non-OK or opaque cross-origin responses
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          // If it's an image, you could return a placeholder here. For now just fail silently.
          return new Response('', { status: 408, statusText: 'Offline' });
        });
    })
  );
});
