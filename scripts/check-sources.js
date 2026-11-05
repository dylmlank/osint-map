// Live check of every outside data source: does it answer, and does the answer still parse
// into something sensible? Run this when a layer looks empty.  npm run check-sources
import zlib from 'node:zlib';
import * as F from '../feeds.js';
import * as I from '../intel.js';

const UA = { 'User-Agent': 'osint-map/0.5 (source check)' };
const get = async (url, as = 'json') => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === 'json' ? r.json() : as === 'text' ? r.text() : Buffer.from(await r.arrayBuffer());
};
const atLeast = (n, min, what) => { if (n < min) throw new Error(`only ${n} ${what} (expected ${min}+)`); return `${n.toLocaleString()} ${what}`; };

const checks = {
  'Flights (adsb.fi)': async () => atLeast((await get('https://opendata.adsb.fi/api/v2/lat/34/lon/-118/dist/250')).aircraft?.length ?? 0, 50, 'aircraft'),
  'Flights backup (adsb.lol)': async () => atLeast((await get('https://api.adsb.lol/v2/point/51/0/250')).ac.length, 50, 'aircraft'),
  'Military (adsb.lol)': async () => atLeast((await F.militaryFlights()).length, 20, 'aircraft'),
  'Flight routes (VRS list)': async () => atLeast((await get('https://vrs-standing-data.adsb.lol/routes/UA/UAL1.json'))._airports?.length ?? 0, 2, 'airports'),
  ...Object.fromEntries(Object.keys(F.CAMERA_FETCH).map(name => [`Cameras: ${name}`, async () =>
    atLeast(F.CAMERA_PARSERS[name](await F.CAMERA_FETCH[name]()).filter(c => c.on !== false && c.image).length, name === 'Singapore' ? 1 : 50, 'cameras')])),
  'News (GDELT)': async () => {
    const last = await get('http://data.gdeltproject.org/gdeltv2/lastupdate.txt', 'text');
    const url = last.split('\n')[0].split(' ')[2];
    const buf = await get(url, 'buffer');
    const csv = zlib.inflateRawSync(buf.subarray(30 + buf.readUInt16LE(26) + buf.readUInt16LE(28))).toString();
    const stories = new Map();
    for (const line of csv.split('\n')) I.addGdeltRow(stories, line, Date.now());
    return atLeast(stories.size, 50, 'stories in the latest 15 min');
  },
  'Earthquakes (USGS)': async () => atLeast((await F.quakes()).length, 10, 'quakes today'),
  'Natural disasters (NASA EONET)': async () => atLeast((await F.naturalEvents()).length, 5, 'events'),
  'Wildfires (NIFC)': async () => atLeast((await F.fires()).length, 1, 'fires'),
  'Weather alerts (NWS)': async () => `${(await F.alerts()).features.length} alerts with outlines`,
  'Undersea cables (TeleGeography)': async () => atLeast((await F.cables()).features.length, 300, 'cables'),
  'Power plants (WRI)': async () => atLeast((await F.powerPlants()).length, 20000, 'plants'),
  'Sanctions (OFAC)': async () => {
    const p = I.parseOfacCsv(await get('https://www.treasury.gov/ofac/downloads/sdn.csv', 'text'));
    return `${atLeast(p.ships.length, 500, 'ships')}, ${atLeast(p.aircraft.length, 100, 'aircraft')}`;
  },
  'Satellites (CelesTrak)': async () => atLeast(F.parseTle(await get('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle', 'text'), 'stations').length, 5, 'stations'),
  'Rain radar (RainViewer)': async () => atLeast((await get('https://api.rainviewer.com/public/weather-maps.json')).radar.past.length, 1, 'radar frames'),
  'Place search (Nominatim)': async () => atLeast((await get('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=London')).length, 1, 'result'),
  'Satellite imagery (Esri)': async () => `${((await get('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/2', 'buffer')).length / 1000).toFixed(0)} KB tile`,
  '3D terrain (AWS)': async () => `${((await get('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/8/41/98.png', 'buffer')).length / 1000).toFixed(0)} KB tile`,
  '3D buildings (OpenFreeMap)': async () => atLeast((await get('https://tiles.openfreemap.org/planet')).vector_layers.length, 5, 'tile layers'),
};

const warnOnly = new Set(['Satellites (CelesTrak)']); // CelesTrak refuses repeat downloads within 2 h
let failed = 0;
console.log('Checking data sources (one at a time, to stay inside rate limits)…\n');
for (const [name, fn] of Object.entries(checks)) {
  const t = Date.now();
  try {
    const result = await fn();
    console.log(`  ok    ${name.padEnd(34)} ${result}  (${Date.now() - t} ms)`);
  } catch (err) {
    const warn = warnOnly.has(name);
    if (!warn) failed++;
    console.log(`  ${warn ? 'warn' : 'FAIL'}  ${name.padEnd(34)} ${err.message}${warn ? ' (CelesTrak limits repeat downloads; retry later)' : ''}`);
  }
  await new Promise(r => setTimeout(r, 1500));
}
console.log(failed ? `\n${failed} source(s) failing.` : '\nAll sources working.');
process.exit(failed ? 1 : 0);
