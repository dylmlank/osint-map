// OSINT Map server: keeps every feed warm in the background and pushes updates to the
// browser over Server-Sent Events. No dependencies — Node 22+.
import http from 'node:http';
import zlib from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './feeds.js';
import { createWatch, AREA_RULES } from './watch.js';
import { createHistory } from './history.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
loadEnv(join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 8790);

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- feeds kept warm on the server ----------
// live: pushed to subscribed browsers whenever they change. static: fetched once by the browser.
const S = 1000, M = 60 * S, H = 60 * M;
const FEEDS = {
  military: { fn: F.militaryFlights, every: 15 * S, live: true },
  news:     { fn: F.news,            every: 5 * M,  live: true },
  quakes:   { fn: F.quakes,          every: 1 * M,  live: true },
  fires:    { fn: F.fires,           every: 5 * M,  live: true },
  events:   { fn: F.naturalEvents,   every: 15 * M, live: true },
  alerts:   { fn: F.alerts,          every: 2 * M,  live: true },
  cameras:  { fn: F.cameras,         every: 10 * M },
  cables:   { fn: F.cables,          every: 24 * H },
  plants:   { fn: F.powerPlants,     every: 24 * H },
  sanctions:  { fn: F.sanctions,       every: 24 * H },
  sanctioned: { fn: F.sanctionedShips, every: 1 * M,  live: true },
  dark:       { fn: F.darkShips,       every: 1 * M,  live: true },
  jamming:    { fn: F.jamming,         every: 1 * M,  live: true },
  satellites: { fn: F.satellites,      every: 10 * M }, // cheap: only downloads when due (see feeds.js)
};
F.startHotspots();

for (const [name, feed] of Object.entries(FEEDS)) {
  feed.json = null; feed.gz = null; feed.data = null; feed.updated = 0; feed.checked = 0; feed.error = '';
  const started = Date.now();
  const refresh = async () => {
    try {
      feed.data = await feed.fn();
      const json = JSON.stringify(feed.data);
      feed.error = '';
      feed.checked = Date.now();
      if (!feed.json) console.log(`[${name}] ready in ${Date.now() - started} ms`);
      if (json !== feed.json) {
        feed.json = json;
        feed.gz = zlib.gzipSync(json);
        feed.updated = Date.now();
        if (feed.live) broadcast(name);
      }
    } catch (err) {
      feed.error = err.message;
      console.warn(`[${name}] ${err.message}`);
    }
    setTimeout(refresh, feed.error ? Math.min(feed.every, 30 * S) : feed.every).unref?.();
  };
  refresh(); // preload at startup
}

F.connectAIS(process.env.AISSTREAM_KEY);

// ---------- live stream (SSE) ----------
const clients = new Map(); // id -> { res, layers:Set, region, bbox }
let nextId = 1;

function sendEvent(c, event, json) {
  c.res.write(`event: ${event}\ndata: ${json}\n\n`);
}

// Big feeds aren't pushed whole: browsers get a small "changed" note and fetch the gzipped copy.
function broadcast(layer) {
  const note = JSON.stringify({ layer, updated: FEEDS[layer].updated });
  for (const c of clients.values()) if (c.layers.has(layer)) sendEvent(c, 'changed', note);
}

function broadcastAll(event, json) {
  for (const c of clients.values()) sendEvent(c, event, json);
}

const watch = createWatch({ dir: join(ROOT, 'data'), feeds: FEEDS, broadcast: broadcastAll });

// ---------- timeline recording ----------
// flights: [hex, call, lat, lon, alt (-1 = on ground), track, speed, flags (1 military, 2 emergency, 4 sanctioned), type]
// ships:   [mmsi, name, lat, lon, course, speed, type, sanctioned (0/1)]
const r3 = n => Math.round(n * 1000) / 1000;
const history = createHistory({
  dir: join(ROOT, 'data', 'history'),
  sources: {
    flights: {
      every: 60 * S,
      collect() {
        const byHex = new Map();
        for (const f of [...(FEEDS.military.data || []), ...F.knownRegions().flatMap(F.cachedFlights)]) {
          if (f.lat == null || byHex.has(f.hex)) continue;
          byHex.set(f.hex, [f.hex, f.call, r3(f.lat), r3(f.lon), f.alt === 'ground' ? -1 : Math.round(+f.alt || 0),
            Math.round(f.track || 0), Math.round(f.speed || 0), (f.mil ? 1 : 0) | (f.emergency ? 2 : 0) | (f.sanc ? 4 : 0), f.type]);
        }
        return [...byHex.values()];
      },
    },
    ships: {
      every: 5 * M, firstAfter: 90 * S,
      collect() {
        const out = [], fresh = Date.now() - 30 * M;
        for (const s of F.allShips()) {
          if (s.lat == null || s.seen < fresh) continue;
          out.push(F.shipRow(s));
        }
        return out;
      },
    },
  },
});

function inBbox(bbox) {
  if (!bbox) return null;
  const [w, s, e, n] = bbox.split(',').map(Number);
  return row => row[2] >= s && row[2] <= n && (w <= e ? row[3] >= w && row[3] <= e : row[3] >= w || row[3] <= e);
}

async function readJSON(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10000) throw new Error('body too large');
  }
  return JSON.parse(body || '{}');
}

function openStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const id = String(nextId++);
  clients.set(id, { res, layers: new Set(), region: null, bbox: null });
  res.write(`event: hello\ndata: ${JSON.stringify({ id })}\n\n`);
  res.write(`event: checked\ndata: ${checkedTimes()}\n\n`);
  req.on('close', () => clients.delete(id));
}

// The browser reports what it's looking at; flights and ships for that view are pushed right away.
function updateView(q) {
  const c = clients.get(q.get('id'));
  if (!c) return false;
  const layers = new Set((q.get('layers') || '').split(',').filter(Boolean));
  const added = [...layers].filter(l => !c.layers.has(l));
  c.layers = layers;
  const region = F.regionKey(+q.get('lat'), +q.get('lon'));
  const regionChanged = region !== c.region;
  c.region = region;
  c.bbox = (q.get('bbox') || '-180,-90,180,90').split(',').map(Number);
  c.zoom = Number(q.get('zoom')) || 5;

  if (layers.has('flights') && (regionChanged || added.includes('flights'))) pushFlights(c);
  if (layers.has('ships')) pushShips(c);
  return true;
}

async function pushFlights(c) {
  try { sendEvent(c, 'flights', JSON.stringify(await F.flightsNear(c.region, 'user'))); } // someone is looking at it
  catch (err) { sendEvent(c, 'status', JSON.stringify({ layer: 'flights', error: err.message })); }
}

// Zoomed far out, ships barely move on screen and there can be 10,000+ of them, so send
// fewer, less often. Each ship is a compact row (see F.shipRow).
const shipLimit = zoom => (zoom < 3 ? 4000 : zoom < 5 ? 8000 : 20000);
function pushShips(c) {
  const ships = F.shipsIn(c.bbox, shipLimit(c.zoom)).map(F.shipRow);
  sendEvent(c, 'ships', JSON.stringify({ status: F.ais.status, total: F.ais.total(), ships }));
}

// Flights and ships depend on each browser's view, so they're pushed on their own beat.
setInterval(() => {
  for (const c of clients.values()) if (c.layers.has('flights') && c.region) pushFlights(c);
}, 8 * S);
setInterval(() => {
  shipTick++;
  for (const c of clients.values()) {
    if (!c.layers.has('ships') || !c.bbox) continue;
    if (c.zoom < 5 && shipTick % 3) continue; // every 15 s when zoomed out, 5 s otherwise
    pushShips(c);
  }
}, 5 * S);
let shipTick = 0;
setInterval(() => { for (const c of clients.values()) c.res.write(': ping\n\n'); }, 20 * S);

// When each feed was last checked successfully, so the panel can show "updated 20s ago".
// `now` lets the browser correct for any clock difference with this machine.
function checkedTimes() {
  return JSON.stringify({ now: Date.now(), feeds: Object.fromEntries(Object.entries(FEEDS).map(([k, f]) => [k, f.checked])) });
}
setInterval(() => broadcastAll('checked', checkedTimes()), 10 * S);

// Load the default view's flights at startup so the first visit is instant
// (feeds.js then keeps every recently viewed area fresh).
F.flightsNear(F.regionKey(34, -118.3)).catch(() => {});

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

// The page's own files: gzipped once and kept in memory, with an ETag so a repeat visit
// gets a tiny "304 not changed" instead of the whole file again.
const staticFiles = new Map(); // path -> { mtime, buf, gz, etag }
async function serveStatic(req, res, file) {
  const info = await stat(file);
  let f = staticFiles.get(file);
  if (!f || f.mtime !== info.mtimeMs) {
    const buf = await readFile(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    f = { mtime: info.mtimeMs, buf, type, etag: `"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}"`,
      gz: /text|javascript|json|svg/.test(type) ? zlib.gzipSync(buf) : null };
    staticFiles.set(file, f);
  }
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ETag: f.etag }); return res.end(); }
  const gzip = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-cache', ETag: f.etag, Vary: 'Accept-Encoding',
    ...(gzip && { 'Content-Encoding': 'gzip' }) });
  res.end(gzip ? f.gz : f.buf);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFeed(req, res, name) {
  const feed = FEEDS[name];
  if (!feed.json) return send(res, 503, { error: feed.error || 'still loading' });
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-cache',
    'Last-Modified': new Date(feed.updated).toUTCString(), ...(gzip && { 'Content-Encoding': 'gzip' }),
  });
  res.end(gzip ? feed.gz : feed.json);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  try {
    if (url.pathname === '/api/stream') return openStream(req, res);
    if (url.pathname === '/api/view') return send(res, updateView(q) ? 204 : 404, '');
    if (url.pathname === '/api/history') return send(res, 200, history.list());
    if (url.pathname === '/api/history/at') {
      try { return send(res, 200, history.at(q.get('kind'), +q.get('t'), inBbox(q.get('bbox')))); }
      catch (err) { return send(res, 400, { error: err.message }); }
    }
    if (url.pathname === '/api/watch') {
      if (req.method === 'GET') return send(res, 200, { ...watch.get(), rules: AREA_RULES });
      if (req.method === 'POST') {
        try { return send(res, 200, watch.add(await readJSON(req))); }
        catch (err) { return send(res, 400, { error: err.message }); }
      }
      if (req.method === 'DELETE') { watch.remove(q.get('id')); return send(res, 204, ''); }
    }
    if (url.pathname === '/api/alerts' && req.method === 'POST') { watch.markRead(); return send(res, 204, ''); }
    if (url.pathname === '/api/alerts' && req.method === 'DELETE') { watch.clearAlerts(); return send(res, 204, ''); }
    if (url.pathname === '/api/geocode') return send(res, 200, await F.geocode(q.get('q') || ''));
    if (url.pathname === '/api/find') return send(res, 200, await F.findFlight(q.get('q') || ''));
    if (url.pathname === '/api/ship') {
      const s = F.getShip(q.get('mmsi'));
      return s ? send(res, 200, s) : send(res, 404, { error: 'not heard recently' });
    }
    if (url.pathname === '/api/flight') {
      const errors = [];
      const trace = await F.flightTrace(q.get('hex') || '').catch(err => { errors.push(err.message); return null; });
      const route = await F.flightRoute(q.get('call') || '', +q.get('lat'), +q.get('lon'), trace?.takeoff, parseFloat(q.get('track')))
        .catch(err => { errors.push(err.message); return null; });
      return send(res, 200, { trace, route, errors });
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, Object.fromEntries(Object.entries(FEEDS).map(([k, f]) =>
        [k, { ready: Boolean(f.json), updated: f.updated, error: f.error }])));
    }
    const feed = url.pathname.match(/^\/api\/(\w+)$/)?.[1];
    if (feed && FEEDS[feed]) return sendFeed(req, res, feed);

    const file = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
    await serveStatic(req, res, file);
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    console.error(err.message);
    send(res, 502, { error: err.message });
  }
}).listen(PORT, () => console.log(`OSINT Map on http://localhost:${PORT}  (ships: ${F.ais.status})`));
