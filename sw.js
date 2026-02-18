// Service Worker — Charlie Parker's Mind
// Cache-first strategy for offline play

const CACHE_NAME = 'cpm-v1';

// Core static assets to pre-cache on install
const PRECACHE_ASSETS = [
  './game.html',
  './game.js?v=13',
  './game.css?v=4',
  './manifest.json',
  './favicon.svg',
  './assets/tone.min.js',
  './assets/osmd.min.js',
  './assets/fonts/Bravura.woff',
  './assets/fonts/BravuraText.woff',
  // Google Fonts (may fail offline on first load — handled gracefully)
];

// ─── Install: pre-cache core assets ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // addAll with individual error handling so one failure doesn't abort
        return Promise.allSettled(
          PRECACHE_ASSETS.map(url =>
            cache.add(url).catch(err => console.warn('[SW] pre-cache miss:', url, err))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: purge old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ─── Fetch: cache-first, fallback to network, cache new resources ─────────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests for http(s) URLs
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;

  // For navigation requests, try network first (keeps app fresh),
  // fall back to cached game.html when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, cloned));
          return response;
        })
        .catch(() => caches.match('./game.html'))
    );
    return;
  }

  // For all other assets: cache-first, then network + auto-cache
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          // Don't cache bad responses or opaque cross-origin responses that
          // might silently represent errors.
          if (
            !response ||
            response.status !== 200 ||
            (response.type === 'opaque' && response.status === 0)
          ) {
            return response;
          }
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, cloned));
          return response;
        })
        .catch(() => {
          // Offline and not in cache — nothing we can do
          return new Response('Offline — resource not cached', { status: 503 });
        });
    })
  );
});
