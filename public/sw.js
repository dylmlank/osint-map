// Service worker: keeps the heavy, unchanging downloads on this computer so repeat visits
// start almost instantly.
//  - map libraries and fonts (versioned URLs, never change)  -> cache first
//  - basemap style, tiles and satellite imagery               -> show cached copy, refresh in background
//  - the page's own files                                     -> network first (so updates show), cache as fallback
//  - live data (/api) and camera snapshots                    -> always from the network
const VERSION = 'v1';
const LIBS = `libs-${VERSION}`, SHELL = `shell-${VERSION}`, TILES = 'tiles-v1';
const MAX_TILES = 4000;

const LIB_URLS = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/deck.gl@9.0.38/dist.min.js',
];
const LIB_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_HOSTS = ['basemaps.cartocdn.com', 'tiles.basemaps.cartocdn.com', 'server.arcgisonline.com'];

self.addEventListener('install', event => {
  self.skipWaiting();
  // Fetch the big libraries now, in the background, so the next page load has them.
  event.waitUntil(caches.open(LIBS).then(c => c.addAll(LIB_URLS)).catch(() => {}));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (![LIBS, SHELL, TILES].includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

let tilePuts = 0;
async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys(); // oldest first
  for (const req of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(req);
}

const usable = res => res && (res.ok || res.type === 'opaque');

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return; // live data: never cached here
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || Response.error();
      }
    })());
    return;
  }

  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (usable(res)) (await caches.open(LIBS)).put(req, res.clone());
      return res;
    })());
    return;
  }

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      const refresh = fetch(req).then(res => {
        if (usable(res)) {
          cache.put(req, res.clone());
          if (++tilePuts % 200 === 0) trimTiles();
        }
        return res;
      });
      if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
      return refresh;
    })());
  }
});
