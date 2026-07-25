// LabourArc Service Worker — basic offline support (v3)
// Caches the app shell AND its exact CDN dependencies so the app can actually
// render when offline, not just load a blank shell.

const CACHE_NAME = 'labourarc-cache-v3';

// Core app files
const CORE_ASSETS = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
];

// Exact CDN dependencies pulled from index.html — update this list if index.html changes
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Inter:wght@400;500;600',
];

// Install: pre-cache core app shell + CDN dependencies (best-effort for CDN — one
// failed CDN fetch shouldn't block the whole install)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS);
      await Promise.all(
        CDN_ASSETS.map((url) =>
          fetch(url, { mode: 'no-cors' })
            .then((response) => cache.put(url, response))
            .catch(() => {}) // don't fail install if one CDN is unreachable at install time
        )
      );
    })
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

// Fetch: network-first for navigation, falling back to cache, then offline page.
// Static/CDN assets: cache-first, caching whatever comes back (including opaque
// cross-origin responses, which is what most CDN <script> tags produce).
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

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

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && (response.status === 200 || response.type === 'opaque')) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => new Response('', { status: 408, statusText: 'Offline' }));
    })
  );
});
