// Fetchers for each free public feed. Every function returns plain, slim JSON for the map.
import zlib from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as I from './intel.js';

const { round, parseCsvLine } = I;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

const UA = { 'User-Agent': 'osint-map/0.2 (personal project)' };

export async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).host} -> ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).host} -> ${r.status}`);
  return r.text();
}

// Cache with in-flight sharing; on upstream error it keeps serving the last good value.
// Within staleMs an expired value is returned at once while a fresh copy loads in the background.
const cache = new Map();
export function cached(key, ttlMs, fn, staleMs = 0) {
  const hit = cache.get(key);
  const age = hit?.v !== undefined ? Date.now() - hit.t : Infinity;
  if (age < ttlMs) return Promise.resolve(hit.v);
  if (age < staleMs) {
    if (!hit.p) cached(key, 0, fn).catch(() => {});
    return Promise.resolve(hit.v);
  }
  if (hit?.p) return hit.p;
  const p = fn().then(
    v => { cache.set(key, { t: Date.now(), v }); return v; },
    err => {
      if (hit?.v !== undefined) { cache.set(key, { ...hit, p: null }); return hit.v; }
      cache.delete(key); throw err;
    });
  cache.set(key, { ...hit, p });
  return p;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The free flight services rate-limit, so each gets its own queue: requests are spaced out,
// things you clicked or searched go before background polling, and a 429 pauses it for 30 s.
function rateLimited(name, spacingMs) {
  const jobs = { user: [], background: [] };
  let busy = false, last = 0, coolUntil = 0;
  async function run() {
    if (busy) return;
    busy = true;
    while (jobs.user.length || jobs.background.length) {
      const job = jobs.user.shift() || jobs.background.shift();
      try {
        if (Date.now() < coolUntil) throw new Error(`${name} rate limit, cooling down`);
        const gap = last + spacingMs - Date.now();
        if (gap > 0) await sleep(gap);
        last = Date.now();
        const r = await fetch(job.url, { ...job.init, headers: { ...UA, ...job.init.headers } });
        if (r.status === 429) { coolUntil = Date.now() + 30000; throw new Error(`${name} -> 429`); }
        if (!r.ok) throw new Error(`${name} -> ${r.status}`);
        const text = await r.text();
        job.resolve(text ? JSON.parse(text) : null);
      } catch (err) { job.reject(err); }
    }
    busy = false;
  }
  return (url, { priority = 'background', ...init } = {}) => new Promise((resolve, reject) => {
    jobs[priority].push({ url, init, resolve, reject });
    run();
  });
}

const adsb = rateLimited('adsb.lol', 1500);
const adsbFi = rateLimited('adsb.fi', 1500);

// ---------- watchlist lookups ----------
// One aircraft by ICAO hex (exact) or callsign/registration, via adsb.fi.
export async function lookupAircraft({ hex, call }) {
  const path = hex ? `hex/${hex.toLowerCase()}` : `callsign/${encodeURIComponent(call.toUpperCase())}`;
  const j = await adsbFi(`https://opendata.adsb.fi/api/v2/${path}`);
  const a = (j?.ac || []).find(x => x.lat != null);
  return a ? slimFlight(a) : null;
}

// Every aircraft worldwide squawking hijack (7500), radio failure (7600) or emergency (7700).
export async function emergencies() {
  const out = [];
  for (const code of ['7700', '7600', '7500']) {
    const j = await adsbFi(`https://opendata.adsb.fi/api/v2/sqk/${code}`);
    out.push(...(j?.ac || []).filter(a => a.lat != null).map(slimFlight));
  }
  return out;
}

// ---------- flights (adsb.lol, ODbL) ----------
export function slimFlight(a) {
  const f = {
    hex: a.hex, call: (a.flight || '').trim(), reg: a.r || '', type: a.t || '',
    lat: a.lat, lon: a.lon, alt: a.alt_baro, speed: a.gs, track: a.track ?? a.true_heading ?? 0,
    squawk: a.squawk || '', mil: Boolean(a.dbFlags & 1),
    emergency: ['7500', '7600', '7700'].includes(a.squawk) || Boolean(a.emergency && a.emergency !== 'none'),
    nacp: a.nac_p ?? null, // GPS position accuracy category (used for the jamming map)
    src: a.type || '', ver: a.version ?? null, // where the position came from, ADS-B version
  };
  const sanc = I.matchAircraft(sanctionsIndex, f.reg);
  if (sanc) f.sanc = sanc;
  return f;
}

// GPS jamming is worked out from every batch of aircraft the server sees.
const jammingTracker = I.createJammingTracker();
export const jamming = async () => jammingTracker.summary();

export const regionKey = (lat, lon) => `${Math.round(lat)}:${Math.round(lon)}`;

// Areas someone looked at recently are kept refreshed, so coming back (or reloading) is instant.
const recentRegions = new Map(); // key -> last asked
export function flightsNear(key) {
  recentRegions.set(key, Date.now());
  return cached(`fl:${key}`, 6000, () => fetchRegion(key), 120000);
}

async function fetchRegion(key) {
  const [la, lo] = key.split(':');
  // adsb.fi first (separate rate limit), adsb.lol as backup. Both serve the same readsb format.
  const j = await adsbFi(`https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/250`)
    .catch(() => adsb(`https://api.adsb.lol/v2/point/${la}/${lo}/250`));
  const flights = (j?.ac || j?.aircraft || []).filter(a => a.lat != null).map(slimFlight);
  jammingTracker.record(flights);
  return flights;
}

setInterval(() => {
  for (const [key, asked] of recentRegions) {
    if (Date.now() - asked > 15 * 60 * 1000) { recentRegions.delete(key); continue; }
    cached(`fl:${key}`, 15000, () => fetchRegion(key)).catch(() => {});
  }
}, 20000).unref();

// Known GPS-jamming areas are sampled in the background (one every 20 s, in turn) so the
// jamming map has data even where nobody is looking. They're also recorded for the timeline.
const HOTSPOTS = [
  [55, 20], [59, 26], [57, 24], [54, 14], [34, 33], [33, 36], [44, 34], [47, 37],
  [33, 44], [36, 40], [26, 54], [29, 48], [38, 127], [56, 38], [41, 29], [50, 30],
];
let hotspotIndex = 0;
export function startHotspots() {
  setInterval(() => {
    const [la, lo] = HOTSPOTS[hotspotIndex++ % HOTSPOTS.length];
    cached(`fl:${regionKey(la, lo)}`, 60000, () => fetchRegion(regionKey(la, lo))).catch(() => {});
  }, 20000).unref();
}
export const knownRegions = () => [...new Set([...recentRegions.keys(), ...HOTSPOTS.map(([a, b]) => regionKey(a, b))])];
export const cachedFlights = key => cache.get(`fl:${key}`)?.v || [];

export async function militaryFlights() {
  const j = await adsb('https://api.adsb.lol/v2/mil');
  const flights = (j.ac || []).filter(a => a.lat != null).map(a => ({ ...slimFlight(a), mil: true }));
  jammingTracker.record(flights);
  return flights;
}

// ---------- sanctions (US Treasury OFAC SDN list) ----------
let sanctionsIndex = null;
export async function sanctions() {
  const csv = await getText('https://www.treasury.gov/ofac/downloads/sdn.csv');
  const parsed = I.parseOfacCsv(csv);
  if (parsed.ships.length < 100) throw new Error('OFAC list looks incomplete');
  sanctionsIndex = I.buildSanctionsIndex(parsed);
  for (const s of ships.values()) s.sanc = I.matchShip(sanctionsIndex, s); // re-check ships already known
  return { ...sanctionsIndex.counts, imo: sanctionsIndex.imo.size, mmsi: sanctionsIndex.mmsi.size, regs: sanctionsIndex.reg.size };
}

// Sanctioned ships currently being tracked anywhere in the world.
export async function sanctionedShips() {
  const out = [];
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const s of ships.values()) if (s.sanc && s.lat != null && s.seen > cutoff) out.push({ ...s });
  return out;
}

export const darkShips = async () => I.findDarkShips(ships.values());

// ---------- satellites (CelesTrak orbital elements) ----------
// CelesTrak updates every few hours and asks users not to download more often, so groups are
// fetched one at a time, slowly, and the result is saved to disk for restarts.
const SAT_GROUPS = ['stations', 'gps-ops', 'weather', 'military', 'geo', 'starlink'];
export function parseTle(text, group) {
  const lines = text.trim().split(/\r?\n/), out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    if (!lines[i + 1].startsWith('1 ') || !lines[i + 2].startsWith('2 ')) continue;
    out.push({ name: lines[i].trim(), group, l1: lines[i + 1].trim(), l2: lines[i + 2].trim() });
  }
  return out;
}

export async function satellites() {
  const file = join(DATA_DIR, 'satellites.json');
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { time: 0, sats: [], missing: SAT_GROUPS };
  const stale = Date.now() - saved.time > 6 * 60 * 60 * 1000;
  // Fresh download every 6 h; in between, only retry groups that failed (at most every 10 min).
  const missingBefore = saved.missing ?? SAT_GROUPS.filter(g => !saved.sats.some(s => s.group === g));
  const groups = stale ? SAT_GROUPS : missingBefore.filter(() => Date.now() - (saved.tried || 0) > 10 * 60 * 1000);
  if (!groups.length) return saved.sats;
  const got = [], missing = [];
  for (const group of groups) {
    try {
      const sats = parseTle(await getText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`), group);
      if (sats.length) got.push(...sats); else missing.push(group);
    } catch (err) { console.warn(`[satellites] ${group}: ${err.message}`); missing.push(group); }
    await sleep(3000);
  }
  const sats = [...(stale ? [] : saved.sats.filter(s => !groups.includes(s.group))), ...got];
  if (!sats.length) throw new Error('no satellite data');
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ time: stale ? Date.now() : saved.time, tried: Date.now(), missing, sats }));
  if (missing.length) console.warn(`[satellites] will retry: ${missing.join(', ')}`);
  return sats;
}

// Find a live aircraft anywhere by ICAO hex, callsign or registration.
export function findFlight(q) {
  const term = q.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{2,10}$/.test(term)) return Promise.resolve([]);
  return cached(`find:${term}`, 8000, async () => {
    const paths = /^[0-9A-F]{6}$/.test(term) ? [`hex/${term.toLowerCase()}`] : [`callsign/${term}`, `reg/${term}`];
    for (const p of paths) {
      const j = await adsb(`https://api.adsb.lol/v2/${p}`, { priority: 'user' });
      const hits = (j?.ac || []).filter(a => a.lat != null).map(slimFlight);
      if (hits.length) return hits;
    }
    return [];
  });
}

// Today's track for one aircraft, plus where it took off (last time it was on the ground).
export function flightTrace(hex) {
  hex = hex.toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return Promise.reject(new Error('bad hex'));
  return cached(`trace:${hex}`, 30000, async () => {
    const j = await adsb(`https://globe.adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`, { priority: 'user' });
    // trace point: [secondsAfterTimestamp, lat, lon, alt|'ground', speed, track, flags, ...]; flag 2 = a new leg starts here
    const pts = (j?.trace || []).map(p => ({ t: j.timestamp + p[0], lat: p[1], lon: p[2], alt: p[3], newLeg: Boolean(p[6] & 2) }));
    let start = 0;
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i].alt === 'ground' || pts[i].newLeg) { start = i; break; }
    const leg = pts.slice(start);
    const first = leg[0];
    // Only call it a takeoff if the leg begins low, i.e. we actually saw it leave the ground.
    const sawTakeoff = first && (first.alt === 'ground' || +first.alt < 3000);
    return {
      desc: j?.desc || '', operator: j?.ownOp || '', year: j?.year || '',
      takeoff: sawTakeoff ? { lat: first.lat, lon: first.lon, time: first.t * 1000 } : null,
      firstSeen: leg.length ? leg[0].t * 1000 : null,
      path: leg.map(p => [round(p.lon), round(p.lat)]),
    };
  });
}

// Scheduled route for a callsign, from adsb.lol's copy of the Virtual Radar Server route list.
// Routes can have stops (BOS-SFO-SNA), so we pick the leg the plane is actually on.
function routeAirports(cs) {
  return cached(`route:${cs}`, 6 * 60 * 60 * 1000, async () => {
    const r = await fetch(`https://vrs-standing-data.adsb.lol/routes/${cs.slice(0, 2)}/${cs}.json`, { headers: UA });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`route list -> ${r.status}`);
    return ((await r.json())._airports || []).map(a => ({
      code: a.iata || a.icao, icao: a.icao, name: a.name, city: a.location, lat: a.lat, lon: a.lon,
    }));
  });
}

export async function flightRoute(callsign, lat, lon, takeoff, track) {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return null; // only airline-style callsigns have scheduled routes
  return I.pickLeg(await routeAirports(cs), { lat, lon }, takeoff, track);
}

// Place search (OpenStreetMap Nominatim). Their rules: real User-Agent, no search-as-you-type.
export function geocode(q) {
  const term = q.trim();
  if (term.length < 2) return Promise.resolve([]);
  return cached(`geo:${term.toLowerCase()}`, 24 * 60 * 60 * 1000, async () => {
    const j = await getJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=en&q=${encodeURIComponent(term)}`);
    return j.map(p => ({
      name: p.display_name, type: p.addresstype || p.type, lat: +p.lat, lon: +p.lon,
      bbox: p.boundingbox ? [+p.boundingbox[2], +p.boundingbox[0], +p.boundingbox[3], +p.boundingbox[1]] : null,
    }));
  });
}

// ---------- traffic cameras, worldwide (public road-agency feeds, no keys) ----------
// Every source returns: { name, place, route, lat, lon, image, views?, video?, videoType?, source }
export const xmlItems = (xml, tag) => xml.split(`<${tag}>`).slice(1).map(s => s.split(`</${tag}>`)[0]);
export const xmlField = (item, tag) => (item.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1]?.trim() || '';

// Parsers turn each agency's raw format into map cameras (tested in test/feeds.test.js).
export const CAMERA_PARSERS = {
  California: j => (j.data || []).map(({ cctv: c }) => ({
    name: c.location.locationName, place: c.location.nearbyPlace, route: c.location.route,
    lat: +c.location.latitude, lon: +c.location.longitude, on: c.inService === 'true',
    image: c.imageData?.static?.currentImageURL || '',
    video: c.imageData?.streamingVideoURL || '', videoType: 'hls', source: 'Caltrans',
  })),

  'British Columbia': j => j.map(c => ({
    name: c.name, place: c.region_name || 'British Columbia', route: c.highway_display ? `Hwy ${c.highway_display}` : '',
    lat: c.location?.coordinates?.[1], lon: c.location?.coordinates?.[0], on: c.is_on !== false,
    image: `https://www.drivebc.ca/images/${c.id}.jpg`, note: c.caption, source: 'DriveBC',
  })),

  London: j => j.map(c => {
    const p = Object.fromEntries(c.additionalProperties.map(a => [a.key, a.value]));
    return {
      name: c.commonName, place: 'London', route: p.view ? `facing ${p.view}` : '',
      lat: c.lat, lon: c.lon, on: p.available !== 'false',
      image: p.imageUrl, video: p.videoUrl, videoType: 'mp4', source: 'Transport for London',
    };
  }),

  'Hong Kong': xml => xmlItems(xml, 'image').map(i => ({
    name: xmlField(i, 'description').replace(/\s*\[\w+\]$/, ''), place: `${xmlField(i, 'district')}, ${xmlField(i, 'region')}`, route: '',
    lat: +xmlField(i, 'latitude'), lon: +xmlField(i, 'longitude'), on: true,
    image: xmlField(i, 'url'), source: 'HK Transport Department',
  })),

  Finland: j => j.features.map(f => {
    const [, road, place] = f.properties.name.match(/^[a-z]*(\d+)?_?(.*)$/i) || [];
    const views = (f.properties.presets || []).filter(p => p.inCollection !== false)
      .map(p => `https://weathercam.digitraffic.fi/${p.id}.jpg`);
    return {
      name: (place || f.properties.name).replace(/_/g, ' '), place: 'Finland', route: road ? `Road ${road}` : '',
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], on: f.properties.collectionStatus === 'GATHERING',
      image: views[0], views, source: 'Fintraffic Digitraffic',
    };
  }),

  'New Zealand': xml => xmlItems(xml, 'camera').map(i => ({
    name: xmlField(i, 'name') || xmlField(i, 'description'), place: (i.match(/<region>.*?<name>([^<]*)<\/name>/) || [])[1] || 'New Zealand',
    route: xmlField(i, 'highway'), note: xmlField(i, 'description'),
    // the camera's own lat/lon come after the nested journey/region blocks
    lat: +(i.match(/<\/journeyLeg><latitude>([^<]*)/) || [])[1], lon: +(i.match(/<\/journeyLeg><latitude>[^<]*<\/latitude><longitude>([^<]*)/) || [])[1],
    on: xmlField(i, 'offline') !== 'true', image: `https://trafficnz.info${xmlField(i, 'imageUrl')}`, source: 'NZ Transport Agency',
  })),

  Singapore: j => (j.items?.[0]?.cameras || []).map(c => ({
    name: `Camera ${c.camera_id}`, place: 'Singapore', route: '', lat: c.location.latitude, lon: c.location.longitude,
    on: true, image: c.image, source: 'Singapore LTA',
  })),
};

export const CAMERA_FETCH = {
  async California() {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => i + 1).map(d =>
      getJSON(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, '0')}.json`)));
    return { data: results.filter(r => r.status === 'fulfilled').flatMap(r => r.value.data || []) };
  },
  'British Columbia': () => getJSON('https://www.drivebc.ca/api/webcams/'),
  London: () => getJSON('https://api.tfl.gov.uk/Place/Type/JamCam'),
  'Hong Kong': () => getText('https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml'),
  Finland: () => getJSON('https://tie.digitraffic.fi/api/weathercam/v1/stations'),
  'New Zealand': () => getText('https://trafficnz.info/service/traffic/rest/4/cameras/all'),
  Singapore: () => getJSON('https://api.data.gov.sg/v1/transport/traffic-images'),
};

export async function cameras() {
  const names = Object.keys(CAMERA_FETCH);
  const results = await Promise.allSettled(names.map(async n => CAMERA_PARSERS[n](await CAMERA_FETCH[n]())));
  const cams = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') { console.warn(`[cameras] ${names[i]}: ${r.reason.message}`); return; }
    for (const c of r.value) {
      if (!c.on || !c.image || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || (!c.lat && !c.lon)) continue;
      delete c.on;
      c.region = names[i];
      c.lat = round(c.lat); c.lon = round(c.lon);
      cams.push(c);
    }
  });
  return cams;
}

// ---------- news (GDELT 2.0 event export, every 15 min) ----------
const NEWS_HOURS = 6;
const stories = new Map(); // url -> story
const fetchedFiles = new Set();

function unzipFirst(buf) {
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28);
  return zlib.inflateRawSync(buf.subarray(30 + nameLen + extraLen)).toString();
}

async function loadNewsFile(stamp) {
  if (fetchedFiles.has(stamp)) return;
  const r = await fetch(`http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`, { headers: UA });
  if (!r.ok) return;
  fetchedFiles.add(stamp);
  const time = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12));
  for (const line of unzipFirst(Buffer.from(await r.arrayBuffer())).split('\n')) I.addGdeltRow(stories, line, time);
}

const stampOf = d => d.toISOString().replace(/\D/g, '').slice(0, 12) + '00';

export async function news() {
  const last = await getText('http://data.gdeltproject.org/gdeltv2/lastupdate.txt');
  const latest = last.match(/(\d{14})\.export/)?.[1];
  if (!latest) throw new Error('gdelt: no latest file');
  const end = Date.UTC(+latest.slice(0, 4), +latest.slice(4, 6) - 1, +latest.slice(6, 8), +latest.slice(8, 10), +latest.slice(10, 12));
  const stamps = Array.from({ length: NEWS_HOURS * 4 }, (_, i) => stampOf(new Date(end - i * 15 * 60000)));
  for (let i = 0; i < stamps.length; i += 6) await Promise.allSettled(stamps.slice(i, i + 6).map(loadNewsFile));

  const cutoff = end - NEWS_HOURS * 3600000;
  for (const [url, s] of stories) if (s.time < cutoff) stories.delete(url);

  // group stories by place so each map dot is one location
  const rank = { violence: 3, protest: 2, tension: 1, other: 0 };
  const places = new Map();
  for (const s of stories.values()) {
    const key = `${s.lat},${s.lon}`;
    const p = places.get(key) || { lat: s.lat, lon: s.lon, place: s.place, cat: 'other', n: 0, stories: [] };
    p.n++;
    if (rank[s.cat] > rank[p.cat]) p.cat = s.cat;
    p.stories.push(s);
    places.set(key, p);
  }
  return [...places.values()].map(p => {
    p.stories.sort((a, b) => rank[b.cat] - rank[a.cat] || b.mentions - a.mentions);
    p.stories = p.stories.slice(0, 15).map(({ lat, lon, place, votes, ...s }) => s);
    return p;
  });
}

// ---------- earthquakes (USGS, past day) ----------
export async function quakes() {
  const j = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
  return j.features.map(f => ({
    id: f.id, mag: f.properties.mag ?? 0, place: f.properties.place, time: f.properties.time,
    url: f.properties.url, tsunami: f.properties.tsunami === 1,
    lon: round(f.geometry.coordinates[0]), lat: round(f.geometry.coordinates[1]), depth: round(f.geometry.coordinates[2], 1),
  }));
}

// ---------- US wildfires (NIFC WFIGS current incidents) ----------
export async function fires() {
  const j = await getJSON('https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query'
    + '?where=1%3D1&outFields=IncidentName,IncidentSize,PercentContained,FireDiscoveryDateTime,POOState&f=geojson');
  return j.features.filter(f => f.geometry).map(f => ({
    name: f.properties.IncidentName, acres: f.properties.IncidentSize ?? 0,
    contained: f.properties.PercentContained, since: f.properties.FireDiscoveryDateTime,
    state: (f.properties.POOState || '').replace('US-', ''),
    lon: round(f.geometry.coordinates[0]), lat: round(f.geometry.coordinates[1]),
  }));
}

// ---------- natural events worldwide (NASA EONET) ----------
export async function naturalEvents() {
  const j = await getJSON('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30');
  return j.events.flatMap(e => {
    const g = e.geometry.at(-1);
    if (!g || g.type !== 'Point') return [];
    return [{
      title: e.title, cat: e.categories[0]?.title || 'Event', date: g.date,
      source: e.sources[0]?.url || '', lon: round(g.coordinates[0]), lat: round(g.coordinates[1]),
    }];
  });
}

// ---------- US weather alerts (NWS) ----------
export async function alerts() {
  const j = await getJSON('https://api.weather.gov/alerts/active?status=actual&message_type=alert');
  return {
    type: 'FeatureCollection',
    features: j.features.filter(f => f.geometry).map(f => ({
      type: 'Feature',
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
      properties: {
        event: f.properties.event, severity: f.properties.severity, area: f.properties.areaDesc,
        headline: f.properties.headline, ends: f.properties.ends || f.properties.expires,
      },
    })),
  };
}
const roundCoords = c => (typeof c[0] === 'number' ? [round(c[0], 3), round(c[1], 3)] : c.map(roundCoords));

// ---------- undersea cables (TeleGeography) ----------
export async function cables() {
  const j = await getJSON('https://www.submarinecablemap.com/api/v3/cable/cable-geo.json');
  for (const f of j.features) {
    f.geometry.coordinates = roundCoords(f.geometry.coordinates);
    f.properties = { name: f.properties.name, color: f.properties.color, id: f.properties.id };
  }
  return j;
}

// ---------- power plants (WRI Global Power Plant Database) ----------
export async function powerPlants() {
  const csv = await getText('https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv');
  const lines = csv.split('\n');
  const head = lines[0].split(',');
  const col = name => head.indexOf(name);
  const iName = col('name'), iMW = col('capacity_mw'), iLat = col('latitude'), iLon = col('longitude'), iFuel = col('primary_fuel'), iCountry = col('country_long');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const lat = +c[iLat], lon = +c[iLon];
    if (!lat && !lon) continue;
    out.push([round(lon, 3), round(lat, 3), c[iFuel], Math.round(+c[iMW] || 0), c[iName], c[iCountry]]);
  }
  return out; // compact rows: [lon, lat, fuel, mw, name, country]
}

// ---------- ships (aisstream.io websocket, free key) ----------
const ships = new Map();
export const ais = { status: 'no-key', total: () => ships.size };

export function connectAIS(key) {
  if (!key) return;
  ais.status = 'connecting';
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.onopen = () => {
    ais.status = 'live';
    ws.send(JSON.stringify({
      APIKey: key, BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'],
    }));
  };
  ws.onmessage = async ev => {
    const text = typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text();
    let m; try { m = JSON.parse(text); } catch { return; }
    if (m.error) { ais.status = `error: ${m.error}`; return; }
    const meta = m.MetaData || {}, id = meta.MMSI;
    if (!id) return;
    const s = ships.get(id) || { mmsi: id };
    s.name = (meta.ShipName || s.name || '').trim();
    const pos = m.Message?.PositionReport || m.Message?.StandardClassBPositionReport;
    if (pos) Object.assign(s, { lat: meta.latitude, lon: meta.longitude, speed: pos.Sog, course: pos.Cog,
      heading: pos.TrueHeading === 511 ? pos.Cog : pos.TrueHeading, seen: Date.now() });
    const st = m.Message?.ShipStaticData;
    if (st) Object.assign(s, { type: st.Type, dest: (st.Destination || '').trim(), imo: st.ImoNumber || undefined,
      length: (st.Dimension?.A || 0) + (st.Dimension?.B || 0) });
    if (st || !ships.has(id)) s.sanc = I.matchShip(sanctionsIndex, s);
    ships.set(id, s);
  };
  ws.onclose = ev => {
    console.warn(`[ships] connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''}), reconnecting`);
    if (!ais.status.startsWith('error')) ais.status = 'reconnecting';
    setTimeout(() => connectAIS(key), 5000);
  };
  ws.onerror = () => {};
  // Ships are kept for 6 h after their last report so silent ("dark") ones can still be shown.
  pruneShips ||= setInterval(() => {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id, s] of ships) if (!s.seen || s.seen < cutoff) ships.delete(id);
  }, 60000).unref();
}
let pruneShips = null;

export const getShip = mmsi => ships.get(Number(mmsi)) || ships.get(String(mmsi));
export const allShips = () => ships.values();

export function shipsIn([w, s, e, n]) {
  const out = [];
  const fresh = Date.now() - 30 * 60 * 1000; // the live layer only shows ships heard in the last 30 min
  for (const sh of ships.values()) {
    if (sh.lat == null || sh.lat < s || sh.lat > n || sh.seen < fresh) continue;
    if (w <= e ? (sh.lon < w || sh.lon > e) : (sh.lon < w && sh.lon > e)) continue;
    out.push(sh);
    if (out.length >= 20000) break;
  }
  return out;
}
