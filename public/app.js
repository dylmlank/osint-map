/* global maplibregl, deck, Icons */
const { MapboxOverlay, IconLayer, GeoJsonLayer, PathLayer, ScatterplotLayer } = deck;

// ---------- colors (one hue family per layer; shapes tell layers apart) ----------
const C = {
  planeLow: '#38bdf8', planeMid: '#7dd3fc', planeHigh: '#e0f2fe', planeGround: '#64748b',
  military: '#f59e0b', emergency: '#ff1744',
  camera: '#e879f9', fire: '#f97316', alert: '#f472b6', radar: '#60a5fa', cable: '#2dd4bf',
  track: '#22d3ee', sanction: '#ff1744', dark: '#fbbf24', darkLow: '#a8a29e',
};
const SAT = { stations: '#fde047', 'gps-ops': '#4ade80', weather: '#60a5fa', military: '#ef4444', geo: '#c084fc', starlink: '#94a3b8' };
const SHIP = { Cargo: '#4ade80', Tanker: '#fb7185', Passenger: '#c084fc', Fishing: '#facc15', Service: '#fdba74', Other: '#94a3b8' };
const NEWS = { violence: '#ef4444', protest: '#fb923c', tension: '#facc15', other: '#94a3b8' };
const QUAKE = [[6, '#dc2626'], [4.5, '#f97316'], [2.5, '#facc15'], [-9, '#d9f99d']];
const EVENT = {
  Volcanoes: ['volcano', '#ef4444'], 'Severe Storms': ['storm', '#a78bfa'], 'Sea and Lake Ice': ['ice', '#bae6fd'],
  Wildfires: ['fire', '#fb923c'], Floods: ['drop', '#3b82f6'],
};
const EVENT_OTHER = ['diamond', '#e2e8f0'];
const FUEL = {
  Coal: '#a8a29e', Gas: '#fb923c', Oil: '#a855f7', Nuclear: '#4ade80', Hydro: '#3b82f6',
  Wind: '#67e8f9', Solar: '#fde047', Biomass: '#84cc16', Geothermal: '#f472b6',
};
const ALERT = { Extreme: [239, 68, 68], Severe: [249, 115, 22], Moderate: [250, 204, 21], Minor: [96, 165, 250] };

// ---------- layer list (drives the panel) ----------
// kind: 'push' = streamed for the current view, 'feed' = fetched + refreshed on "changed", 'raster' = map tiles
const LAYERS = [
  { id: 'flights',  group: 'Tracking',       label: 'Flights near view',    icon: ['plane', C.planeLow],  kind: 'push', on: true },
  { id: 'military', group: 'Tracking',       label: 'Military (worldwide)', icon: ['plane', C.military],  kind: 'feed' },
  { id: 'ships',    group: 'Tracking',       label: 'Ships',                icon: ['ship', SHIP.Cargo],   kind: 'push' },
  { id: 'cameras',  group: 'Cameras',        label: 'Road cameras (7 regions)', icon: ['camera', C.camera], kind: 'feed', on: true },
  { id: 'news',     group: 'World events',   label: 'News (last 6 h)',      icon: ['news', NEWS.violence], kind: 'feed', on: true },
  { id: 'quakes',   group: 'World events',   label: 'Earthquakes (24 h)',   icon: ['quake', '#facc15'],   kind: 'feed', on: true },
  { id: 'events',   group: 'World events',   label: 'Natural disasters',    icon: ['volcano', '#ef4444'], kind: 'feed' },
  { id: 'fires',    group: 'World events',   label: 'Wildfires (US)',       icon: ['fire', C.fire],       kind: 'feed' },
  { id: 'alerts',   group: 'World events',   label: 'Weather alerts (US)',  icon: ['diamond', C.alert],   kind: 'feed' },
  { id: 'radar',    group: 'World events',   label: 'Rain radar',           icon: ['drop', C.radar],      kind: 'raster' },
  { id: 'cables',   group: 'Infrastructure', label: 'Undersea cables',      icon: ['diamond', C.cable],   kind: 'feed' },
  { id: 'plants',   group: 'Infrastructure', label: 'Power plants',         icon: ['bolt', FUEL.Solar],   kind: 'feed' },
  { id: 'sanctioned', group: 'Intelligence', label: 'Sanctioned ships (world)', icon: ['ship', C.sanction], kind: 'feed' },
  { id: 'dark',       group: 'Intelligence', label: 'Ships gone silent',    icon: ['ship', C.dark],       kind: 'feed' },
  { id: 'jamming',    group: 'Intelligence', label: 'GPS jamming (last hour)', icon: ['grid', '#ef4444'], kind: 'feed' },
  { id: 'satellites', group: 'Space',        label: 'Satellites',           icon: ['satellite', '#fde047'], kind: 'sat' },
  { id: 'starlink',   group: 'Space',        label: 'Starlink',             icon: ['satellite', '#94a3b8'], kind: 'sat' },
];

// How often each layer normally refreshes (seconds). The panel's timer turns amber past 3× this.
const EVERY = {
  flights: 8, military: 15, ships: 5, cameras: 600, news: 900, quakes: 60, events: 900,
  fires: 300, alerts: 120, radar: 600, cables: 86400, plants: 86400,
  sanctioned: 60, dark: 60, jamming: 60, satellites: 21600, starlink: 21600,
};

const LEGEND = [
  ['plane', C.planeLow, 'Plane, low'], ['plane', C.planeHigh, 'Plane, high'],
  ['plane', C.military, 'Military'], ['plane', C.emergency, 'Emergency'],
  ['ship', SHIP.Cargo, 'Cargo ship'], ['ship', SHIP.Tanker, 'Tanker'],
  ['ship', SHIP.Passenger, 'Passenger'], ['ship', SHIP.Fishing, 'Fishing'],
  ['news', NEWS.violence, 'News: violence'], ['news', NEWS.protest, 'News: protest'],
  ['news', NEWS.tension, 'News: tension'], ['news', NEWS.other, 'News: other'],
  ['quake', '#facc15', 'Quake M2.5+'], ['quake', '#dc2626', 'Quake M6+'],
  ['volcano', '#ef4444', 'Volcano'], ['storm', '#a78bfa', 'Storm'],
  ['ice', '#bae6fd', 'Sea ice'], ['fire', C.fire, 'Wildfire'],
  ['bolt', FUEL.Nuclear, 'Nuclear'], ['bolt', FUEL.Coal, 'Coal'],
  ['bolt', FUEL.Gas, 'Gas'], ['bolt', FUEL.Hydro, 'Hydro'],
  ['bolt', FUEL.Wind, 'Wind'], ['bolt', FUEL.Solar, 'Solar'],
  ['airport', '#22d3ee', 'Departure'], ['airport', '#f472b6', 'Destination'],
  ['ship', C.sanction, 'Sanctioned (red ring)'], ['ship', C.dark, 'Silent, likely switched off'],
  ['ship', C.darkLow, 'Silent, maybe out of range'], ['grid', '#ef4444', 'GPS jamming 10%+'],
  ['grid', '#facc15', 'GPS jamming 5–10%'], ['satellite', SAT.stations, 'Space station'],
  ['satellite', SAT['gps-ops'], 'GPS'], ['satellite', SAT.weather, 'Weather'],
  ['satellite', SAT.military, 'Military sat'], ['satellite', SAT.geo, 'Geostationary'],
];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
};

const savedOn = store.get('osint-layers', null);
const on = Object.fromEntries(LAYERS.map(l => [l.id, savedOn ? Boolean(savedOn[l.id]) : Boolean(l.on)]));
const data = Object.fromEntries(LAYERS.map(l => [l.id, null]));
const received = {}; // layer -> time its data arrived (for smooth plane motion)

// ---------- map + basemaps ----------
const BASEMAPS = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  satellite: {
    version: 8,
    sources: {
      imagery: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
      labels: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      },
    },
    layers: [
      { id: 'imagery', type: 'raster', source: 'imagery' },
      { id: 'labels', type: 'raster', source: 'labels' },
    ],
  },
};
let basemap = store.get('osint-basemap', 'dark');
if (!BASEMAPS[basemap]) basemap = 'dark';

const view = store.get('osint-view', { center: [-118.3, 34.0], zoom: 7 });
const map = new maplibregl.Map({
  container: 'map', style: BASEMAPS[basemap],
  center: view.center, zoom: view.zoom, attributionControl: { compact: true }, maxPitch: 80,
});
map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
const overlay = new MapboxOverlay({ layers: [], getTooltip: tooltip });
map.addControl(overlay);
// Resolves once the current map style has loaded (replaced whenever the style changes).
let styleReady = new Promise(r => map.once('style.load', r));

const basemapButtons = document.querySelectorAll('[data-basemap]');
function markBasemap() {
  basemapButtons.forEach(b => b.setAttribute('aria-checked', String(b.dataset.basemap === basemap)));
}
markBasemap();
basemapButtons.forEach(b => b.addEventListener('click', () => {
  if (b.dataset.basemap === basemap) return;
  basemap = b.dataset.basemap;
  store.set('osint-basemap', basemap);
  markBasemap();
  styleReady = new Promise(r => map.once('style.load', r));
  map.setStyle(BASEMAPS[basemap]);
}));
// A new style drops our radar and 3D layers, so put them back whenever a style finishes loading.
map.on('style.load', () => { if (on.radar) setRadar(); if (is3D) add3D(); });

// ---------- 3D: real terrain (AWS elevation tiles) + building heights (OpenFreeMap) ----------
// Right-click toggles it; tilting with right-drag turns it on automatically.
let is3D = store.get('osint-3d', false);
const button3D = document.getElementById('toggle-3d');

function add3D() {
  if (!map.getSource('terrain-dem')) {
    map.addSource('terrain-dem', {
      type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 14,
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      attribution: 'Elevation: Mapzen / AWS Terrain Tiles',
    });
  }
  map.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 });
  if (basemap === 'dark' && !map.getLayer('hillshade')) {
    // Shade slopes so mountains read on the dark map (satellite imagery is already shaded).
    const firstLabel = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
    map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'terrain-dem',
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#3b4757' } }, firstLabel);
  }
  if (!map.getSource('ofm')) map.addSource('ofm', { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: 'Buildings: OpenFreeMap, OpenStreetMap' });
  if (!map.getLayer('buildings-3d')) {
    map.addLayer({
      id: 'buildings-3d', type: 'fill-extrusion', source: 'ofm', 'source-layer': 'building', minzoom: 13,
      paint: {
        'fill-extrusion-color': basemap === 'dark' ? '#2c3a4b' : '#e7e2d8',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.85,
      },
    });
  }
}

function remove3D() {
  map.setTerrain(null);
  for (const id of ['buildings-3d', 'hillshade']) if (map.getLayer(id)) map.removeLayer(id);
}

async function set3D(onOff, { tilt = true } = {}) {
  is3D = onOff;
  store.set('osint-3d', is3D);
  button3D.setAttribute('aria-pressed', String(is3D));
  await styleReady;
  if (is3D) {
    add3D();
    if (tilt) {
      if (map.getPitch() < 30) map.easeTo({ pitch: 65, duration: 1200 });
      toast({ kind: 'info', title: '3D on', detail: 'Right-drag (or Ctrl + drag) to tilt and turn. Zoom in close to see buildings. Right-click again to go back to flat.' }, 6000);
    }
  } else {
    remove3D();
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
}

button3D.addEventListener('click', () => set3D(!is3D));
button3D.setAttribute('aria-pressed', String(is3D));
if (is3D) set3D(true, { tilt: false });

// A right-click without dragging toggles 3D (a right-drag just tilts/rotates as usual).
let rightDown = null;
map.on('mousedown', e => { if (e.originalEvent.button === 2) rightDown = e.point; });
map.on('contextmenu', e => {
  e.originalEvent.preventDefault();
  const moved = rightDown && Math.hypot(e.point.x - rightDown.x, e.point.y - rightDown.y) > 5;
  rightDown = null;
  if (!moved) set3D(!is3D);
});
map.on('pitchend', () => { if (!is3D && map.getPitch() > 25) set3D(true, { tilt: false }); });

// ---------- panel ----------
const panel = document.getElementById('layers');
let lastGroup = '';
for (const l of LAYERS) {
  if (l.group !== lastGroup) {
    panel.insertAdjacentHTML('beforeend', `<div class="group">${l.group}</div>`);
    lastGroup = l.group;
  }
  panel.insertAdjacentHTML('beforeend', `
    <label class="layer" id="row-${l.id}"><input type="checkbox" data-layer="${l.id}" ${on[l.id] ? 'checked' : ''}>
      <img src="${Icons.url(...l.icon)}" alt=""><span>${l.label}</span>
      <span class="meta"><b id="n-${l.id}" class="loading">${on[l.id] ? '…' : ''}</b><small id="age-${l.id}" class="age"></small></span></label>`);
}
document.getElementById('legend').innerHTML = LEGEND
  .map(([shape, color, text]) => `<div><img src="${Icons.url(shape, color)}" alt="">${text}</div>`).join('');

panel.addEventListener('change', e => {
  const id = e.target.dataset.layer;
  if (!id) return;
  on[id] = e.target.checked;
  store.set('osint-layers', on);
  const l = LAYERS.find(x => x.id === id);
  if (on[id] && l.kind === 'feed' && !data[id]) loadFeed(id);
  if (l.kind === 'raster') setRadar();
  if (l.kind === 'sat') { if (on[id]) loadSatellites(); else data[id] = null; }
  if (on[id] && !data[id] && l.kind !== 'raster') setCount(id, '…');
  if (!on[id]) setCount(id, '');
  sendView();
  render();
});

function setCount(id, n) {
  const el = document.getElementById(`n-${id}`);
  const text = typeof n === 'number' ? n.toLocaleString() : n;
  if (el.textContent === text) return; // only flash when the number actually changes
  el.textContent = text;
  el.className = typeof n === 'number' ? '' : 'loading';
  if (typeof n === 'number') {
    const row = document.getElementById(`row-${id}`);
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }
}

const statusMsgs = {};
function setStatus(key, msg) {
  statusMsgs[key] = msg;
  document.getElementById('status').textContent = Object.values(statusMsgs).filter(Boolean).join('\n');
}

// ---------- data loading ----------
const COUNT = {
  news: d => d.reduce((s, p) => s + p.n, 0),
  alerts: d => d.features.length,
  cables: d => d.features.length,
  jamming: d => d.filter(c => c.level === 'high').length, // areas with strong signs of jamming
};

function accept(id, json) {
  data[id] = json;
  received[id] = performance.now();
  if (LAYERS.find(l => l.id === id)?.kind === 'push') updatedAt[id] = Date.now();
  if (!replay.active) setCount(id, (COUNT[id] || (d => d.length))(json)); // replay shows its own counts
  if (id === 'flights' || id === 'military') updateTracked(json);
  render();
}

async function loadFeed(id, attempt = 0) {
  try {
    let json = attempt === 0 && window.prefetch?.[id] ? await window.prefetch[id] : null;
    if (window.prefetch) delete window.prefetch[id];
    if (!json) {
      const r = await fetch(`/api/${id}`);
      if (r.status === 503) throw new Error('warming up');
      if (!r.ok) throw new Error(r.status);
      json = await r.json();
    }
    setStatus(id, '');
    accept(id, json);
  } catch {
    setStatus(id, attempt > 2 ? `${id}: source not responding, retrying` : '');
    setTimeout(() => on[id] && loadFeed(id, attempt + 1), Math.min(30000, 2000 * 2 ** attempt));
  }
}

// ---------- live stream ----------
let clientId = null;
const liveDot = document.getElementById('live-dot');

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', e => { clientId = JSON.parse(e.data).id; liveDot.classList.add('on'); sendView(0); });
  es.addEventListener('flights', e => { setStatus('flights', ''); accept('flights', JSON.parse(e.data)); });
  es.addEventListener('ships', e => {
    const j = JSON.parse(e.data);
    setStatus('ships', j.status === 'no-key' ? 'Ships off: add a free AISSTREAM_KEY to .env' : j.status === 'live' ? '' : `Ships: ${j.status}`);
    accept('ships', j.ships);
  });
  es.addEventListener('checked', e => {
    const j = JSON.parse(e.data), offset = Date.now() - j.now;
    for (const [id, t] of Object.entries(j.feeds)) if (t) updatedAt[id] = t + offset;
    if (updatedAt.satellites) updatedAt.starlink = updatedAt.satellites; // same orbit download
    showAges();
  });
  es.addEventListener('watch', e => { watchItems = JSON.parse(e.data); renderWatch(); render(); });
  es.addEventListener('alert', e => onAlert(JSON.parse(e.data)));
  es.addEventListener('changed', e => { const { layer } = JSON.parse(e.data); if (on[layer]) loadFeed(layer); });
  es.addEventListener('status', e => { const j = JSON.parse(e.data); setStatus(j.layer, data[j.layer] ? '' : `${j.layer}: ${j.error}, retrying`); });
  es.onerror = () => { liveDot.classList.remove('on'); clientId = null; };
}

let viewTimer;
function sendView(delay = 250) {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    if (!clientId) return;
    const c = map.getCenter(), b = map.getBounds();
    const layers = LAYERS.filter(l => on[l.id]).map(l => l.id).join(',');
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(n => n.toFixed(3)).join(',');
    fetch(`/api/view?id=${clientId}&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&bbox=${bbox}&layers=${layers}`);
  }, delay);
}

map.on('moveend', () => {
  sendView();
  store.set('osint-view', { center: map.getCenter().toArray(), zoom: map.getZoom() });
});

// ---------- per-item colors ----------
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function planeColor(f) {
  if (f.emergency) return C.emergency;
  if (f.mil) return C.military;
  if (f.alt === 'ground') return C.planeGround;
  const a = +f.alt || 0;
  return a < 10000 ? C.planeLow : a < 25000 ? C.planeMid : C.planeHigh;
}

const SHIP_TYPES = { 30: 'Fishing', 31: 'Towing', 32: 'Towing', 33: 'Dredging', 34: 'Diving', 35: 'Military', 36: 'Sailing',
  37: 'Pleasure craft', 50: 'Pilot boat', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 55: 'Law enforcement', 58: 'Medical' };
function shipType(t) {
  if (!t) return '';
  if (SHIP_TYPES[t]) return SHIP_TYPES[t];
  return { 2: 'Wing-in-ground', 4: 'High-speed craft', 6: 'Passenger', 7: 'Cargo', 8: 'Tanker' }[Math.floor(t / 10)] || 'Other';
}
function shipColor(s) {
  const name = shipType(s.type);
  if (SHIP[name]) return SHIP[name];
  if (/Tug|Pilot|Towing|Dredging|Port tender|Search/.test(name)) return SHIP.Service;
  return SHIP.Other;
}

const quakeColor = q => QUAKE.find(([m]) => q.mag >= m)[1];

function jamColor(level, fill) {
  const c = level === 'high' ? [239, 68, 68] : level === 'medium' ? [250, 204, 21] : [34, 197, 94];
  return [...c, fill ? (level === 'high' ? 110 : level === 'medium' ? 80 : 22) : (level === 'normal' ? 50 : 200)];
}

// Dead-reckon a silent ship: last position moved along its course at its last speed.
function projectShip(d) {
  const hours = Math.min(d.silentMin, 360) / 60;
  const nm = (d.speed || 0) * hours, rad = (d.course || 0) * Math.PI / 180;
  return [d.lon + (nm / 60) * Math.sin(rad) / Math.cos(d.lat * Math.PI / 180), d.lat + (nm / 60) * Math.cos(rad)];
}

// Red ring around anything matched to the sanctions list, on any layer.
function sanctionRings() {
  const hits = [];
  for (const id of ['flights', 'military', 'ships', 'dark', 'sanctioned']) if (on[id]) for (const d of V[id] || []) if (d.sanc) hits.push(d);
  return new ScatterplotLayer({
    id: 'sanction-rings', data: hits, getPosition: d => [d.lon, d.lat], radiusUnits: 'pixels', getRadius: 15,
    stroked: true, filled: false, getLineColor: [...rgb(C.sanction), 230], lineWidthMinPixels: 2,
  });
}

function sanctionBlock(s) {
  if (!s) return '';
  return `<div class="route sanc"><b>Sanctioned (US OFAC)</b>
    <small>Listed as ${esc(s.name)} · programs: ${esc(s.programs.join(', '))}</small>
    ${s.owner ? `<small>Owner: ${esc(s.owner)}</small>` : ''}${s.operator ? `<small>Operator: ${esc(s.operator)}</small>` : ''}
    <small>Matched by ${esc(s.by)}${s.by === 'MMSI' ? '. MMSI numbers get reused or faked, so treat this as a lead to check' : ''}</small></div>`;
}
const eventIcon = e => EVENT[e.cat] || EVENT_OTHER;

// ---------- smooth plane motion ----------
// Between updates each plane keeps moving along its heading at its reported speed.
let tick = 0;
function movedPosition(f, sinceMs) {
  if (!f.speed || f.alt === 'ground') return [f.lon, f.lat];
  const nm = f.speed * Math.min(sinceMs, 30000) / 3600000;
  const rad = f.track * Math.PI / 180;
  return [f.lon + (nm / 60) * Math.sin(rad) / Math.cos(f.lat * Math.PI / 180), f.lat + (nm / 60) * Math.cos(rad)];
}

let lastFrame = 0;
function animate(now) {
  if ((on.flights || on.military || tracked) && now - lastFrame > 100) { lastFrame = now; tick++; render(); }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ---------- layers ----------
function icons(id, { shape, color, size, angle, ...extra }) {
  return new IconLayer({
    id, data: V[id], pickable: true,
    getPosition: d => [d.lon, d.lat],
    getIcon: typeof shape === 'function'
      ? d => Icons.icon(shape(d), color(d))
      : d => Icons.icon(shape, typeof color === 'function' ? color(d) : color),
    getSize: size, sizeUnits: 'pixels',
    ...(angle && { getAngle: angle }),
    onClick: ({ object }) => select(id, object),
    ...extra,
  });
}

function planes(id) {
  const t0 = received[id] || performance.now();
  return icons(id, {
    shape: 'plane', color: planeColor,
    size: d => (d.mil || d.emergency ? 24 : 20),
    angle: d => -(d.track || 0),
    getPosition: d => (replay.active ? [d.lon, d.lat] : movedPosition(d, performance.now() - t0)),
    onClick: ({ object }) => (replay.active ? select('replayFlight', object) : openFlight(object)),
    updateTriggers: { getPosition: tick },
  });
}

function render() {
  const L = [];
  V = currentView();
  const show = id => on[id] && V[id];
  if (show('alerts')) L.push(new GeoJsonLayer({
    id: 'alerts', data: V.alerts, pickable: true, stroked: true, filled: true,
    getFillColor: f => [...(ALERT[f.properties.severity] || [148, 163, 184]), 55],
    getLineColor: f => [...(ALERT[f.properties.severity] || [148, 163, 184]), 220], lineWidthMinPixels: 1.5,
    onClick: ({ object }) => select('alerts', object),
  }));
  if (show('jamming')) L.push(new GeoJsonLayer({
    id: 'jamming', pickable: true, stroked: true, filled: true, lineWidthMinPixels: 1,
    data: { type: 'FeatureCollection', features: V.jamming.map(c => ({ type: 'Feature', properties: c,
      geometry: { type: 'Polygon', coordinates: [boxPolygon([c.lon, c.lat, c.lon + c.size, c.lat + c.size])] } })) },
    getFillColor: f => jamColor(f.properties.level, true), getLineColor: f => jamColor(f.properties.level, false),
    onClick: ({ object }) => select('jamming', object.properties),
  }));
  if (show('cables')) L.push(new GeoJsonLayer({
    id: 'cables', data: V.cables, pickable: true, lineWidthMinPixels: 1.5,
    getLineColor: f => [...rgb(f.properties.color || C.cable), 180],
    onClick: ({ object }) => select('cables', object),
  }));
  if (show('plants')) L.push(icons('plants', {
    shape: 'bolt', color: d => FUEL[d[2]] || '#cbd5e1',
    size: d => Math.max(9, Math.min(22, 7 + Math.sqrt(d[3]) / 4)),
    getPosition: d => [d[0], d[1]],
  }));
  if (show('cameras')) L.push(icons('cameras', { shape: 'camera', color: C.camera, size: 16 }));
  if (show('news')) L.push(icons('news', { shape: 'news', color: d => NEWS[d.cat], size: d => Math.min(28, 13 + Math.sqrt(d.n) * 2) }));
  if (show('events')) L.push(icons('events', { shape: d => eventIcon(d)[0], color: d => eventIcon(d)[1], size: 22 }));
  if (show('fires')) L.push(icons('fires', { shape: 'fire', color: C.fire, size: d => Math.max(13, Math.min(30, 9 + Math.log10(d.acres + 1) * 4)) }));
  if (show('quakes')) L.push(icons('quakes', { shape: 'quake', color: quakeColor, size: d => Math.max(12, Math.min(34, 8 + d.mag * 4)) }));
  if (show('ships')) L.push(icons('ships', {
    shape: 'ship', color: shipColor, size: 15, angle: d => -(d.heading ?? d.course ?? 0),
  }));
  if (show('dark')) {
    // Where each silent ship would be now if it kept its last course and speed.
    L.push(new PathLayer({
      id: 'dark-projection', data: V.dark, widthUnits: 'pixels', getWidth: 1.5,
      getPath: d => [[d.lon, d.lat], projectShip(d)], getColor: d => [...rgb(d.confidence === 'high' ? C.dark : C.darkLow), 150],
    }));
    L.push(icons('dark', {
      shape: 'ship', color: d => (d.confidence === 'high' ? C.dark : C.darkLow), size: 18, angle: d => -(d.course || 0),
    }));
  }
  if (show('sanctioned')) L.push(icons('sanctioned', {
    shape: 'ship', color: C.sanction, size: 20, angle: d => -(d.heading ?? d.course ?? 0),
  }));
  L.push(sanctionRings());
  if (show('satellites')) L.push(icons('satellites', {
    shape: 'satellite', color: d => SAT[d.group] || '#e2e8f0', size: d => (d.iss ? 28 : d.group === 'stations' ? 20 : 14),
    updateTriggers: { getPosition: satTick },
  }));
  if (show('starlink')) L.push(new ScatterplotLayer({
    id: 'starlink', data: V.starlink, pickable: true, radiusUnits: 'pixels', getRadius: 2,
    getPosition: d => [d.lon, d.lat], getFillColor: [...rgb(SAT.starlink), 200],
    onClick: ({ object }) => select('starlink', object), updateTriggers: { getPosition: satTick },
  }));
  if (selectedSat) L.push(new PathLayer({
    id: 'sat-track', data: selectedSat.track, getPath: d => d, widthUnits: 'pixels', getWidth: 2,
    getColor: [...rgb(SAT[selectedSat.group] || '#e2e8f0'), 200],
  }));
  L.push(...areaLayers());
  if (!replay.active) L.push(...routeLayers());
  if (show('flights')) L.push(planes('flights'));
  if (show('military')) L.push(planes('military'));
  if (tracked && !replay.active) L.push(...trackedPlaneLayers());
  overlay.setProps({ layers: L });
}

function tooltip({ object, layer }) {
  if (!object) return null;
  const id = layer.id;
  const text = id === 'cameras' ? object.name
    : id === 'ships' ? `${object.name || `MMSI ${object.mmsi}`}${object.type ? ` · ${shipType(object.type)}` : ''}`
    : id === 'news' ? `${object.place} · ${object.n} ${object.n === 1 ? 'story' : 'stories'}`
    : id === 'quakes' ? `M${object.mag.toFixed(1)} · ${object.place}`
    : id === 'events' ? object.title
    : id === 'fires' ? `${object.name} fire · ${Math.round(object.acres).toLocaleString()} acres`
    : id === 'alerts' ? object.properties.event
    : id === 'cables' ? object.properties.name
    : id === 'plants' ? `${object[4]} · ${object[2]} ${object[3]} MW`
    : id === 'airports' ? `${object.label}: ${object.code} · ${object.name}`
    : id === 'sanctioned' ? `SANCTIONED: ${object.name || `MMSI ${object.mmsi}`}`
    : id === 'dark' ? `${object.name || `MMSI ${object.mmsi}`} · silent ${object.silentMin} min`
    : id === 'jamming' ? `${object.properties.pct}% of ${object.properties.n} aircraft with poor GPS`
    : id === 'satellites' || id === 'starlink' ? `${object.name} · ${Math.round(object.alt).toLocaleString()} km up`
    : id === 'sanction-rings' || id === 'dark-projection' || id === 'sat-track' ? null
    : id === 'watch-areas' ? (object.properties.draft ? null : `Watching: ${object.properties.label}`)
    : id.startsWith('route') ? null
    : (object.call || object.reg || object.hex);
  return text && { text, style: { background: '#0b0f14', color: '#e2e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
}

// ---------- radar (RainViewer tiles) ----------
async function setRadar() {
  await styleReady;
  if (!on.radar) {
    if (map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', 'none');
    setCount('radar', '');
    return;
  }
  try {
    const j = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    const frame = j.radar.past.at(-1);
    const tiles = [`${j.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`];
    if (map.getSource('radar')) map.getSource('radar').setTiles(tiles);
    else {
      map.addSource('radar', { type: 'raster', tiles, tileSize: 256, maxzoom: 7, attribution: 'RainViewer' });
      map.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.65 } });
    }
    map.setLayoutProperty('radar', 'visibility', 'visible');
    setCount('radar', new Date(frame.time * 1000).toTimeString().slice(0, 5));
    updatedAt.radar = frame.time * 1000; // when the radar picture was taken
  } catch { setStatus('radar', 'Radar unavailable'); }
}
setInterval(() => on.radar && setRadar(), 5 * 60000);

// ---------- tracked flight: takeoff → now → destination ----------
let tracked = null; // { hex, call, live, info, crumbs, follow, receivedAt }

const toRad = d => d * Math.PI / 180;
function distKm(a, b) {
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// Points along the shortest path over the globe, so long routes curve like real flights.
function greatCircle(a, b, n = 64) {
  const [l1, p1, l2, p2] = [a[0], a[1], b[0], b[1]].map(toRad);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!d) return [a, b];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI]);
  }
  // keep the line continuous across the date line
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  return pts;
}

function trackedPos() {
  return tracked ? movedPosition(tracked.live, performance.now() - tracked.receivedAt) : null;
}

async function openFlight(f, { fly = false } = {}) {
  if (!f) return;
  tracked = { hex: f.hex, call: f.call, live: f, info: null, crumbs: [[f.lon, f.lat]], follow: false, receivedAt: performance.now() };
  if (fly) map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 7) });
  showFlightCard();
  render();
  try {
    const r = await fetch(`/api/flight?hex=${f.hex}&call=${encodeURIComponent(f.call || '')}&lat=${f.lat}&lon=${f.lon}&track=${f.track ?? ''}`);
    const info = await r.json();
    if (tracked?.hex !== f.hex) return;
    tracked.info = info;
    showFlightCard();
    render();
  } catch {
    if (tracked?.hex === f.hex) { tracked.info = { trace: null, route: null, errors: ['lookup failed'] }; showFlightCard(); }
  }
}

function updateTracked(list) {
  if (!tracked) return;
  const f = list.find(x => x.hex === tracked.hex);
  if (f) setTrackedLive(f);
}

function setTrackedLive(f) {
  tracked.live = f;
  tracked.receivedAt = performance.now();
  const last = tracked.crumbs.at(-1);
  if (!last || last[0] !== f.lon || last[1] !== f.lat) tracked.crumbs.push([f.lon, f.lat]);
  if (tracked.follow) map.easeTo({ center: [f.lon, f.lat], duration: 1000 });
  if (!card.hidden && cardKind === 'flight') showFlightCard();
}

// If the tracked plane leaves the area being streamed, look it up directly.
setInterval(async () => {
  if (!tracked || performance.now() - tracked.receivedAt < 15000) return;
  try {
    const hits = await (await fetch(`/api/find?q=${tracked.hex}`)).json();
    if (tracked && hits[0]) setTrackedLive(hits[0]);
  } catch { /* try again next round */ }
}, 15000);

function routeLayers() {
  if (!tracked) return [];
  const pos = trackedPos();
  const trace = tracked.info?.trace?.path || [];
  const flown = [...trace, ...tracked.crumbs, pos];
  const route = tracked.info?.route?.plausible ? tracked.info.route : null;
  const takeoff = route?.from ? [route.from.lon, route.from.lat] : tracked.info?.trace?.takeoff ? [tracked.info.trace.takeoff.lon, tracked.info.trace.takeoff.lat] : null;
  const L = [];
  if (route?.to) L.push(new PathLayer({
    id: 'route-ahead', data: [{ path: greatCircle(pos, [route.to.lon, route.to.lat]) }],
    getPath: d => d.path, getColor: [244, 114, 182, 170], getWidth: 2, widthUnits: 'pixels',
    updateTriggers: { getPath: tick },
  }));
  if (route?.from && !trace.length) L.push(new PathLayer({
    id: 'route-behind', data: [{ path: greatCircle([route.from.lon, route.from.lat], pos) }],
    getPath: d => d.path, getColor: [34, 211, 238, 110], getWidth: 2, widthUnits: 'pixels',
    updateTriggers: { getPath: tick },
  }));
  L.push(new PathLayer({
    id: 'route-flown', data: [{ path: flown }], getPath: d => d.path,
    getColor: rgb(C.track), getWidth: 3, widthUnits: 'pixels', jointRounded: true, capRounded: true,
    updateTriggers: { getPath: tick },
  }));
  const ports = [];
  if (takeoff) ports.push({ lon: takeoff[0], lat: takeoff[1], label: 'Departed', code: route?.from?.code || 'Takeoff', name: route?.from?.name || 'where the aircraft left the ground', color: '#22d3ee' });
  if (route?.to) ports.push({ lon: route.to.lon, lat: route.to.lat, label: 'Destination', code: route.to.code, name: route.to.name, color: '#f472b6' });
  if (ports.length) L.push(new IconLayer({
    id: 'airports', data: ports, pickable: true, getPosition: d => [d.lon, d.lat],
    getIcon: d => Icons.icon('airport', d.color), getSize: 30, sizeUnits: 'pixels',
  }));
  return L;
}

function trackedPlaneLayers() {
  const pos = trackedPos();
  return [
    new ScatterplotLayer({
      id: 'tracked-ring', data: [pos], getPosition: d => d, getRadius: 17, radiusUnits: 'pixels',
      stroked: true, filled: false, getLineColor: rgb(C.track), lineWidthMinPixels: 2,
      updateTriggers: { getPosition: tick },
    }),
    new IconLayer({
      id: 'tracked', data: [tracked.live], pickable: true, getPosition: () => pos,
      getIcon: d => Icons.icon('plane', planeColor(d)), getSize: 26, sizeUnits: 'pixels', getAngle: d => -(d.track || 0),
      onClick: () => showFlightCard(), updateTriggers: { getPosition: tick },
    }),
  ];
}

function showFlightCard() {
  if (!tracked) return;
  const d = tracked.live, info = tracked.info, route = info?.route, trace = info?.trace;
  const pos = [d.lon, d.lat];
  let routeHtml = '<div class="route"><small>Looking up route…</small></div>';
  if (info) {
    if (route) {
      const total = distKm([route.from.lon, route.from.lat], [route.to.lon, route.to.lat]);
      const left = distKm(pos, [route.to.lon, route.to.lat]);
      const pct = Math.max(0, Math.min(100, 100 * (1 - left / total)));
      routeHtml = `<div class="route">
        <div class="ends">
          <div><b>${esc(route.from.code)}</b><small>${esc(route.from.city || route.from.name)}</small></div>
          <span class="arrow">→</span>
          <div><b>${esc(route.to.code)}</b><small>${esc(route.to.city || route.to.name)}</small></div>
        </div>
        ${route.plausible
          ? `<div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>
             <small>${Math.round(left).toLocaleString()} km to go of ${Math.round(total).toLocaleString()} km${trace?.takeoff ? ` · took off ${ago(trace.takeoff.time)}` : ''}</small>`
          : '<small>⚠ This is the route on file for this flight number, but the plane\'s position doesn\'t match it. It may be flying a different leg today.</small>'}
        ${route.stops?.length > 2 ? `<small>Full route: ${esc(route.stops.join(' → '))}</small>` : ''}
      </div>`;
    } else if (trace?.takeoff) {
      routeHtml = `<div class="route"><small>No scheduled route on file. Took off ${ago(trace.takeoff.time)} at ${pos2(trace.takeoff.lat, trace.takeoff.lon)} (cyan pin). The cyan line is the path flown.</small></div>`;
    } else {
      routeHtml = `<div class="route"><small>No route on file${info.errors?.length ? ` (${esc(info.errors.join(', '))})` : ''}. The cyan line is the path seen so far.</small></div>`;
    }
  }
  openCard('flight', `<h2>${esc(d.call || d.reg || d.hex)}${d.mil ? '<span class="flag mil">MILITARY</span>' : ''}${d.emergency ? '<span class="flag emg">EMERGENCY</span>' : ''}</h2>
    <div class="sub">${esc(trace?.desc || d.type)}${trace?.operator ? ` · ${esc(trace.operator)}` : ''} · ICAO ${esc(d.hex)}</div>
    ${sanctionBlock(d.sanc)}
    ${routeHtml}
    ${rows([['Registration', d.reg], ['Altitude', d.alt === 'ground' ? 'on ground' : d.alt != null ? `${d.alt.toLocaleString()} ft` : ''],
      ['Speed', d.speed != null ? `${Math.round(d.speed)} kt` : ''], ['Heading', `${Math.round(d.track)}°`], ['Squawk', d.squawk], ['Position', pos2(d.lat, d.lon)]])}
    <div class="actions">
      <button id="follow" class="${tracked.follow ? 'on' : ''}">${tracked.follow ? 'Following' : 'Follow'}</button>
      ${watchButton(findWatch('flight', d.hex))}
      <button id="untrack">Stop tracking</button>
    </div>
    ${link(`https://globe.adsb.lol/?icao=${d.hex}`, 'Full history on adsb.lol')}
    <p class="sub">Routes come from adsb.lol's community route list and can be wrong.</p>`, true);
  document.getElementById('follow').onclick = () => {
    tracked.follow = !tracked.follow;
    if (tracked.follow) map.easeTo({ center: trackedPos(), zoom: Math.max(map.getZoom(), 8) });
    showFlightCard();
  };
  document.getElementById('untrack').onclick = () => { tracked = null; closeCard(); render(); };
  document.getElementById('watch-toggle').onclick = () =>
    toggleWatch(findWatch('flight', d.hex), { type: 'flight', hex: d.hex, label: d.call || d.reg || d.hex.toUpperCase() });
}

// ---------- detail card ----------
const card = document.getElementById('card');
const cardBody = document.getElementById('card-body');
let camTimer = null, hls = null, cardKind = null;

function closeCard() {
  card.hidden = true;
  cardKind = null;
  clearInterval(camTimer);
  if (hls) { hls.destroy(); hls = null; }
  cardBody.innerHTML = '';
}
document.getElementById('card-close').onclick = closeCard;

function openCard(kind, html, keepScroll = false) {
  const scroll = card.scrollTop;
  if (cardKind !== kind || !keepScroll) closeCard();
  cardKind = kind;
  card.hidden = false;
  cardBody.innerHTML = html;
  if (keepScroll) card.scrollTop = scroll;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const rows = pairs => '<dl>' + pairs.filter(([, v]) => v !== '' && v != null)
  .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
const link = (url, text) => url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)} ↗</a></p>` : '';
const ago = t => {
  const s = Math.max(0, (Date.now() - new Date(t)) / 1000);
  return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const pos2 = (lat, lon) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

const CARDS = {
  ships: d => `<h2>${esc(d.name || 'Unknown vessel')}${d.sanc ? '<span class="flag emg">SANCTIONED</span>' : ''}</h2>
    <div class="sub">MMSI ${esc(d.mmsi)}${d.imo ? ` · IMO ${esc(d.imo)}` : ''}</div>
    ${sanctionBlock(d.sanc)}
    ${rows([['Type', shipType(d.type)], ['Destination', d.dest], ['Length', d.length ? `${d.length} m` : ''],
      ['Speed', d.speed != null ? `${d.speed} kt` : ''], ['Course', d.course != null ? `${Math.round(d.course)}°` : ''],
      ['Last heard', d.seen ? ago(d.seen) : ''], ['Position', pos2(d.lat, d.lon)]])}
    <div class="actions">${watchButton(findWatch('ship', d.mmsi))}</div>`,

  cameras: d => `<h2>${esc(d.name)}</h2>
    <div class="sub">${[d.place, d.route, d.source].filter(Boolean).map(esc).join(' · ')}</div>
    <div id="cam-media"><img id="cam-img" alt="Latest camera image" src="${esc(withTime(d.image))}"></div>
    ${d.views?.length > 1 ? `<div class="actions">${d.views.map((v, i) => `<button data-view="${i}" class="${i ? '' : 'on'}">View ${i + 1}</button>`).join('')}</div>` : ''}
    ${d.video ? `<button class="play" id="cam-play">▶ ${d.videoType === 'mp4' ? 'Play latest clip' : 'Play live video'}</button>` : ''}
    ${d.note && d.note !== d.name ? `<p class="sub">${esc(d.note)}</p>` : ''}
    ${rows([['Position', pos2(d.lat, d.lon)]])}
    <p class="sub">Still image refreshes every 30 s.</p>`,

  news: d => `<h2>${esc(d.place)}</h2>
    <div class="sub">${d.n} ${d.n === 1 ? 'story' : 'stories'} in the last 6 hours · GDELT</div>
    <ul>${d.stories.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
      <small>${esc(s.domain)} · ${ago(s.time)}</small><span class="flag ${s.cat}">${s.cat}</span></li>`).join('')}</ul>
    <p class="sub">Place and category are machine-coded by GDELT and are often wrong (political stories regularly get tagged "violence"). Headlines come from the link, so open the story to check it.</p>`,

  quakes: d => `<h2>M${d.mag.toFixed(1)} earthquake${d.tsunami ? '<span class="flag emg">TSUNAMI FLAG</span>' : ''}</h2>
    <div class="sub">${esc(d.place)}</div>
    ${rows([['When', ago(d.time)], ['Depth', `${d.depth} km`], ['Position', pos2(d.lat, d.lon)]])}
    ${link(d.url, 'USGS event page')}`,

  events: d => `<h2>${esc(d.title)}</h2>
    <div class="sub">${esc(d.cat)} · NASA EONET</div>
    ${rows([['Last update', ago(d.date)], ['Position', pos2(d.lat, d.lon)]])}
    ${link(d.source, 'Source')}`,

  fires: d => `<h2>${esc(d.name)} fire</h2>
    <div class="sub">${esc(d.state)} · NIFC</div>
    ${rows([['Size', `${Math.round(d.acres).toLocaleString()} acres`], ['Contained', d.contained != null ? `${d.contained}%` : 'unknown'],
      ['Started', d.since ? new Date(d.since).toLocaleDateString() : ''], ['Position', pos2(d.lat, d.lon)]])}`,

  alerts: d => `<h2>${esc(d.properties.event)}</h2>
    <div class="sub">${esc(d.properties.severity)} · NWS</div>
    <p>${esc(d.properties.headline)}</p>
    ${rows([['Area', d.properties.area], ['Ends', d.properties.ends ? new Date(d.properties.ends).toLocaleString() : '']])}`,

  cables: d => `<h2>${esc(d.properties.name)}</h2>
    <div class="sub">Undersea internet cable · TeleGeography</div>
    ${link(`https://www.submarinecablemap.com/submarine-cable/${d.properties.id}`, 'Landing points and owners')}`,

  dark: d => `<h2>${esc(d.name || `MMSI ${d.mmsi}`)}${d.sanc ? '<span class="flag emg">SANCTIONED</span>' : ''}</h2>
    <div class="sub">Silent for ${d.silentMin} min · MMSI ${esc(d.mmsi)}${d.imo ? ` · IMO ${esc(d.imo)}` : ''}</div>
    <div class="route"><small>${d.confidence === 'high'
      ? `<b>Likely switched off.</b> ${d.neighbors} other ships nearby are still being heard, so a gap in receiver coverage is unlikely.`
      : '<b>Maybe just out of range.</b> No other ships nearby are being heard either, so this may be a gap in receiver coverage.'}</small>
      <small>The line shows where it would be now if it kept going at ${d.speed} kt on its last course.</small></div>
    ${sanctionBlock(d.sanc)}
    ${rows([['Type', shipType(d.type)], ['Destination', d.dest], ['Last speed', `${d.speed} kt`], ['Last course', `${Math.round(d.course || 0)}°`],
      ['Last heard', ago(d.lastSeen)], ['Last position', pos2(d.lat, d.lon)]])}`,

  jamming: d => `<h2>GPS ${d.level === 'high' ? 'jamming likely' : d.level === 'medium' ? 'interference possible' : 'looks normal'}</h2>
    <div class="sub">${d.lat}…${d.lat + d.size}°, ${d.lon}…${d.lon + d.size}° · last hour</div>
    <p><b>${d.bad}</b> of <b>${d.n}</b> aircraft (${d.pct}%) reported poor GPS accuracy here.</p>
    <p class="sub">Planes broadcast how sure they are of their GPS position. When many in one area report poor accuracy at once, the usual cause is jamming or spoofing. This only covers areas the server has sampled: the ones you've viewed plus known hotspots (Baltic, Black Sea, Eastern Mediterranean, Middle East, Korea).</p>`,

  satellites: d => satCard(d),
  starlink: d => satCard(d),

  plants: d => `<h2>${esc(d[4])}</h2>
    <div class="sub">${esc(d[5])} · WRI power plant database</div>
    ${rows([['Fuel', d[2]], ['Capacity', `${d[3].toLocaleString()} MW`], ['Position', pos2(d[1], d[0])]])}`,
};

function select(kind, d) {
  if (kind === 'sanctioned') kind = 'ships'; // same card as any ship
  if (!d || !CARDS[kind]) return;
  if (selectedSat && kind !== 'satellites' && kind !== 'starlink') selectedSat = null;
  if (kind === 'satellites' || kind === 'starlink') selectSat(d);
  openCard(kind, CARDS[kind](d));
  if (kind === 'replayFlight') {
    document.getElementById('replay-track').onclick = async () => {
      goLive();
      const hit = (await fetch(`/api/find?q=${d.hex}`).then(r => (r.ok ? r.json() : [])).catch(() => []))[0];
      if (hit) openFlight(hit, { fly: true });
      else toast({ kind: 'info', title: `${d.call || d.hex} isn't broadcasting right now`, detail: 'It may have landed or be out of receiver range.' });
    };
  }
  if (kind === 'ships' && document.getElementById('watch-toggle')) {
    document.getElementById('watch-toggle').onclick = async () => {
      await toggleWatch(findWatch('ship', d.mmsi), { type: 'ship', mmsi: d.mmsi, label: d.name || `MMSI ${d.mmsi}` });
      select('ships', d);
    };
  }
  if (kind === 'cameras') {
    let current = d.image;
    camTimer = setInterval(() => {
      const img = document.getElementById('cam-img');
      if (img) img.src = withTime(current);
    }, 30000);
    cardBody.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
      current = d.views[+b.dataset.view];
      document.getElementById('cam-img').src = withTime(current);
      cardBody.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
    }));
    const play = document.getElementById('cam-play');
    if (play) play.onclick = () => playLive(d.video, d.videoType, play);
  }
}

// Bust the browser cache so refreshed stills are actually new.
const withTime = url => `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;

// hls.js is only downloaded the first time someone plays a video.
let hlsLib = null;
function loadHls() {
  hlsLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/hls.js@1.5.15/dist/hls.min.js';
    s.onload = () => resolve(window.Hls); s.onerror = reject;
    document.head.append(s);
  });
  return hlsLib;
}

async function playLive(src, type, btn) {
  clearInterval(camTimer);
  const video = Object.assign(document.createElement('video'), { muted: true, autoplay: true, controls: true, playsInline: true, loop: type === 'mp4' });
  document.getElementById('cam-media').replaceChildren(video);
  btn.remove();
  if (type === 'mp4' || video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; return; }
  const Hls = await loadHls();
  if (Hls.isSupported()) { hls = new Hls(); hls.loadSource(src); hls.attachMedia(video); }
}

// ---------- search ----------
// Typing searches what's already loaded. Enter also asks OpenStreetMap for places and
// adsb.lol for flights anywhere (both services ask clients not to search on every keystroke).
const searchBox = document.getElementById('search');
const results = document.getElementById('results');
let resultActions = [];

function localMatches(q) {
  const up = q.toUpperCase(), low = q.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const f of [...(data.flights || []), ...(data.military || [])]) {
    if (seen.has(f.hex) || ![f.call, f.reg, f.hex.toUpperCase()].some(v => v && v.toUpperCase().startsWith(up))) continue;
    seen.add(f.hex);
    out.push({ group: 'Flights on map', icon: ['plane', planeColor(f)], title: f.call || f.reg || f.hex, sub: `${f.type} · ${f.reg} · ${f.alt === 'ground' ? 'on ground' : `${f.alt} ft`}`, go: () => openFlight(f, { fly: true }) });
    if (out.length >= 5) break;
  }
  let n = 0;
  for (const s of data.ships || []) {
    if (n >= 5) break;
    if (!(s.name?.toLowerCase().includes(low) || String(s.mmsi).startsWith(q))) continue;
    n++;
    out.push({ group: 'Ships', icon: ['ship', shipColor(s)], title: s.name || `MMSI ${s.mmsi}`, sub: `${shipType(s.type) || 'Vessel'}${s.dest ? ` → ${s.dest}` : ''}`, go: () => { map.flyTo({ center: [s.lon, s.lat], zoom: 11 }); select('ships', s); } });
  }
  n = 0;
  for (const c of data.cameras || []) {
    if (n >= 5) break;
    if (!`${c.name} ${c.place} ${c.route} ${c.region}`.toLowerCase().includes(low)) continue;
    n++;
    out.push({ group: 'Cameras', icon: ['camera', C.camera], title: c.name, sub: c.place, go: () => { map.flyTo({ center: [c.lon, c.lat], zoom: 13 }); select('cameras', c); } });
  }
  n = 0;
  for (const p of data.news || []) {
    if (n >= 3) break;
    if (!p.place?.toLowerCase().includes(low)) continue;
    n++;
    out.push({ group: 'News places', icon: ['news', NEWS[p.cat]], title: p.place, sub: `${p.n} stories`, go: () => { map.flyTo({ center: [p.lon, p.lat], zoom: 6 }); select('news', p); } });
  }
  return out;
}

function showResults(items, hint) {
  resultActions = items.map(i => i.go);
  let html = '', group = '';
  items.forEach((it, i) => {
    if (it.group !== group) { group = it.group; html += `<div class="head">${esc(group)}</div>`; }
    html += `<button data-i="${i}"><img src="${Icons.url(...it.icon)}" alt=""><span>${esc(it.title)}<small>${esc(it.sub || '')}</small></span></button>`;
  });
  if (hint) html += `<div class="hint">${esc(hint)}</div>`;
  results.innerHTML = html;
  results.hidden = !html;
}

searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim();
  if (q.length < 2) return showResults([]);
  showResults(localMatches(q), 'Press Enter to also search places and flights worldwide');
});

searchBox.addEventListener('keydown', async e => {
  if (e.key === 'Escape') { searchBox.value = ''; showResults([]); searchBox.blur(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); results.querySelector('button')?.focus(); return; }
  if (e.key !== 'Enter') return;
  const q = searchBox.value.trim();
  if (q.length < 2) return;
  const local = localMatches(q);
  showResults(local, 'Searching places and flights…');
  const notes = [];
  const ask = (url, what) => fetch(url).then(r => r.ok ? r.json() : Promise.reject())
    .catch(() => { notes.push(`${what} search is busy right now, try again in a minute`); return []; });
  const [places, flights] = await Promise.all([
    ask(`/api/geocode?q=${encodeURIComponent(q)}`, 'Place'),
    /^[A-Za-z0-9-]{2,10}$/.test(q) ? ask(`/api/find?q=${encodeURIComponent(q)}`, 'Flight') : [],
  ]);
  if (searchBox.value.trim() !== q) return; // user kept typing
  const localHex = new Set(local.filter(i => i.group === 'Flights on map').map(i => i.title));
  const remote = [
    ...flights.filter(f => !localHex.has(f.call || f.reg || f.hex)).map(f => ({
      group: 'Flights worldwide', icon: ['plane', planeColor(f)], title: f.call || f.reg || f.hex,
      sub: `${f.type} · ${f.reg} · ${pos2(f.lat, f.lon)}`, go: () => openFlight(f, { fly: true }),
    })),
    ...places.map(p => ({
      group: 'Places', icon: ['airport', '#e2e8f0'], title: p.name.split(',')[0], sub: p.name,
      go: () => {
        lastPlaceName = p.name.split(',')[0];
        if (p.bbox) map.fitBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], { padding: 60, maxZoom: 13 });
        else map.flyTo({ center: [p.lon, p.lat], zoom: 11 });
      },
    })),
  ];
  const all = [...local, ...remote];
  showResults(all, notes.join('. ') || (all.length ? '' : 'Nothing found'));
});

results.addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  resultActions[+b.dataset.i]?.();
  showResults([]);
  searchBox.blur();
});
results.addEventListener('keydown', e => {
  const all = [...results.querySelectorAll('button')];
  const i = all.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); all[i + 1]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? all[i - 1] : searchBox).focus(); }
  if (e.key === 'Escape') { showResults([]); searchBox.focus(); }
});
document.addEventListener('click', e => { if (!e.target.closest('.search')) results.hidden = true; });

// ---------- watchlist + alerts ----------
let watchItems = [], alerts = [], ruleNames = {}, lastPlaceName = '';
const AREA_COLOR = '#fbbf24';
const watchList = document.getElementById('watch-list');
const unreadBadge = document.getElementById('unread');

const findWatch = (type, id) => watchItems.find(i => i.type === type && (type === 'flight' ? i.hex === id : String(i.mmsi) === String(id)));
const watchButton = item => `<button id="watch-toggle" class="${item ? 'on' : ''}">${item ? 'Watching ✓' : 'Watch'}</button>`;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.status === 204 ? null : r.json();
}

async function loadWatch() {
  try {
    const j = await api('GET', '/api/watch');
    watchItems = j.items; alerts = j.alerts; ruleNames = j.rules;
    renderWatch(); render();
  } catch { setTimeout(loadWatch, 3000); }
}

async function addWatch(body) {
  askNotifyPermission();
  const item = await api('POST', '/api/watch', body);
  watchItems = [...watchItems.filter(i => i.id !== item.id), item];
  renderWatch(); render();
  return item;
}

async function removeWatch(id) {
  await api('DELETE', `/api/watch?id=${encodeURIComponent(id)}`);
  watchItems = watchItems.filter(i => i.id !== id);
  renderWatch(); render();
}

async function toggleWatch(existing, body) {
  try {
    if (existing) await removeWatch(existing.id); else await addWatch(body);
  } catch (err) { toast({ kind: 'error', title: 'Could not update watchlist', detail: err.message }); }
  if (tracked && cardKind === 'flight') showFlightCard();
}

function watchStatus(i) {
  const s = i.status || {};
  if (i.type === 'flight') {
    if (!i.status) return 'checking…';
    if (!s.online) return s.lastSeen ? `lost signal ${since(s.lastSeen)}` : 'not broadcasting right now';
    return `${s.ground ? 'on the ground' : `${Number(s.alt).toLocaleString()} ft · ${Math.round(s.speed || 0)} kt`} · seen ${since(s.lastSeen)}`;
  }
  if (i.type === 'ship') {
    if (!s.online) return 'waiting for a position report';
    if (s.dark) return `<span class="warn">silent since ${since(s.lastSeen)}</span>`;
    return `${s.moving ? `${s.speed} kt` : 'stopped'}${s.dest ? ` → ${esc(s.dest)}` : ''} · seen ${since(s.lastSeen)}`;
  }
  const r = i.rules || {};
  const parts = [r.military && 'military', r.emergency && 'emergencies', r.quake != null && `quakes M${r.quake}+`,
    r.fire && 'wildfires', r.events && 'disasters', r.shipsDark && 'dark ships', r.news && 'violence news'].filter(Boolean);
  const now = s.counts?.military ? ` · ${s.counts.military} military now` : '';
  return `${parts.join(', ')}${now}${s.checked ? ` · checked ${since(s.checked)}` : ''}`;
}

// A time that keeps counting up on its own (see showAges).
const since = t => `<span data-t="${Number(t)}">${shortAge(Date.now() - t)}</span>`;

function watchIcon(i) {
  if (i.type === 'flight') return ['plane', C.planeLow];
  if (i.type === 'ship') return ['ship', i.status?.dark ? '#fbbf24' : SHIP.Cargo];
  return ['diamond', AREA_COLOR];
}

function renderWatch() {
  const unread = alerts.filter(a => !a.read).length;
  unreadBadge.hidden = !unread;
  unreadBadge.textContent = unread;
  if (!watchItems.length) {
    watchList.innerHTML = '<p class="empty">Nothing watched yet. Draw an area, or open a flight or ship and press Watch.</p>';
    return;
  }
  watchList.innerHTML = watchItems.map(i => `
    <div class="witem" data-id="${i.id}">
      <img src="${Icons.url(...watchIcon(i))}" alt="">
      <span>${esc(i.label)}<small>${watchStatus(i)}</small></span>
      <button data-remove="${i.id}" title="Stop watching">×</button>
    </div>`).join('');
}

watchList.addEventListener('click', e => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { e.stopPropagation(); removeWatch(rm.dataset.remove); return; }
  const row = e.target.closest('.witem');
  const i = row && watchItems.find(x => x.id === row.dataset.id);
  if (!i) return;
  if (i.type === 'area') {
    if (i.bbox) map.fitBounds([[i.bbox[0], i.bbox[1]], [i.bbox[2], i.bbox[3]]], { padding: 60 });
    else map.flyTo({ center: [0, 20], zoom: 1.5 });
  } else goTo({ lat: i.status?.lat, lon: i.status?.lon, ref: i.type === 'flight' ? { type: 'flight', id: i.hex || i.status?.hex } : { type: 'ship', id: i.mmsi } });
});

// Areas are drawn as amber boxes.
const boxPolygon = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
function areaLayers() {
  const boxes = watchItems.filter(i => i.type === 'area' && i.bbox)
    .map(i => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [boxPolygon(i.bbox)] }, properties: { label: i.label, id: i.id } }));
  if (drawing?.start && drawing.end) {
    const [a, b] = [drawing.start, drawing.end];
    boxes.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [boxPolygon([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)])] }, properties: { label: 'new area', draft: true } });
  }
  if (!boxes.length) return [];
  return [new GeoJsonLayer({
    id: 'watch-areas', data: { type: 'FeatureCollection', features: boxes }, pickable: true,
    filled: true, stroked: true, lineWidthMinPixels: 2,
    getFillColor: f => [...rgb(AREA_COLOR), f.properties.draft ? 40 : 18],
    getLineColor: [...rgb(AREA_COLOR), 230],
    updateTriggers: { getFillColor: tick },
  })];
}

// ---- drawing an area: press "+ Area", then drag a box on the map ----
let drawing = null;
document.getElementById('watch-area').addEventListener('click', () => {
  drawing = { start: null, end: null };
  map.dragPan.disable();
  map.getCanvasContainer().classList.add('drawing');
  toast({ kind: 'info', title: 'Drag on the map to draw the area', detail: 'Press Esc to cancel. You can also skip drawing and watch the whole world.' }, 6000);
});

function stopDrawing() {
  drawing = null;
  map.dragPan.enable();
  map.getCanvasContainer().classList.remove('drawing');
  render();
}

map.on('mousedown', e => { if (drawing) { drawing.start = e.lngLat; drawing.end = e.lngLat; } });
map.on('mousemove', e => { if (drawing?.start) { drawing.end = e.lngLat; render(); } });
map.on('mouseup', e => {
  if (!drawing?.start) return;
  const a = drawing.start, b = e.lngLat;
  stopDrawing();
  const bbox = [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)].map(n => +n.toFixed(4));
  if (bbox[2] - bbox[0] < 0.01 || bbox[3] - bbox[1] < 0.01) return areaForm(null); // a click, not a drag
  areaForm(bbox);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawing) stopDrawing(); });

function areaForm(bbox) {
  const QUAKE_MAGS = [2.5, 4, 4.5, 5, 6];
  // Whole-world watches default to rare, serious events so they don't flood you.
  const defaults = bbox ? { military: true, emergency: true, quake: true } : { emergency: true, quake: true };
  const defaultMag = bbox ? 4.5 : 6;
  const rulesHtml = Object.entries(ruleNames).map(([k, text]) => `
    <label><input type="checkbox" name="${k}" ${defaults[k] ? 'checked' : ''}> ${esc(text)}
      ${k === 'quake' ? `<select name="mag">${QUAKE_MAGS.map(m => `<option ${m === defaultMag ? 'selected' : ''}>${m}</option>`).join('')}</select>` : ''}</label>`).join('');
  openCard('area-form', `<h2>Watch ${bbox ? 'this area' : 'the whole world'}</h2>
    <div class="sub">${bbox ? `${bbox[1].toFixed(2)}…${bbox[3].toFixed(2)}°, ${bbox[0].toFixed(2)}…${bbox[2].toFixed(2)}°` : 'Every alert rule applies everywhere.'}</div>
    <form class="form" id="area-form">
      <input type="text" name="label" placeholder="Name" value="${esc(bbox ? lastPlaceName : 'Whole world')}" maxlength="60" required>
      <div class="sub">Alert me when:</div>
      ${rulesHtml}
      <div class="actions"><button type="submit" class="on">Start watching</button>${bbox ? '<button type="button" id="area-world">Whole world instead</button>' : ''}</div>
      <p class="sub">Alerts only cover new things from now on. Ship alerts need the Ships layer's key.</p>
    </form>`);
  const form = document.getElementById('area-form');
  document.getElementById('area-world')?.addEventListener('click', () => areaForm(null));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const rules = {};
    for (const k of Object.keys(ruleNames)) if (fd.get(k)) rules[k] = k === 'quake' ? Number(fd.get('mag')) : true;
    try {
      await addWatch({ type: 'area', bbox, rules, label: fd.get('label') || (bbox ? 'Area' : 'Whole world') });
      closeCard();
    } catch (err) { toast({ kind: 'error', title: 'Could not add area', detail: err.message }); }
  });
}

// ---- alerts ----
const ALERT_ICON = {
  flight: ['plane', C.planeLow], military: ['plane', C.military], emergency: ['plane', C.emergency],
  ship: ['ship', SHIP.Cargo], dark: ['ship', '#fbbf24'], quake: ['quake', '#f97316'], fire: ['fire', C.fire],
  event: ['storm', '#a78bfa'], news: ['news', NEWS.violence], info: ['diamond', C.track], error: ['diamond', '#ef4444'],
};
const alertIcon = a => ALERT_ICON[a.kind] || ALERT_ICON.info;

function onAlert(a) {
  alerts.unshift(a);
  alerts = alerts.slice(0, 300);
  renderWatch();
  drawTicks();
  toast(a);
  notify(a);
  if (cardKind === 'alerts') showAlerts();
}

const toasts = document.getElementById('toasts');
function toast(a, ms = 12000) {
  const [shape, color] = alertIcon(a);
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.setProperty('--c', color);
  el.innerHTML = `<img src="${Icons.url(shape, color)}" alt=""><span><b>${esc(a.title)}</b><small>${esc(a.detail || '')}</small></span><button aria-label="Dismiss">×</button>`;
  el.addEventListener('click', e => { el.remove(); if (!e.target.closest('button') && a.lat != null) goTo(a); });
  toasts.prepend(el);
  while (toasts.children.length > 4) toasts.lastElementChild.remove();
  setTimeout(() => el.remove(), ms);
}

function askNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function notify(a) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(a.title, { body: a.detail || '', tag: a.id, icon: Icons.url(...alertIcon(a)) });
  n.onclick = () => { window.focus(); goTo(a); };
}

document.getElementById('alerts-btn').addEventListener('click', showAlerts);

function showAlerts() {
  openCard('alerts', `<h2>Alerts</h2>
    <div class="sub">${alerts.length ? `${alerts.length} saved · newest first` : 'No alerts yet'}</div>
    ${alerts.length ? `<div class="actions"><button id="alerts-clear">Clear all</button></div>` : ''}
    <ul class="alist">${alerts.map(a => `<li data-id="${a.id}" class="${a.read ? '' : 'unread'}">
      <img src="${Icons.url(...alertIcon(a))}" alt="">
      <span><b>${esc(a.title)}</b><small>${esc(a.detail || '')}</small><small>${ago(a.time)} · ${esc(a.watchLabel || '')}</small>
      ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">Open story ↗</a>` : ''}</span></li>`).join('')}</ul>`, true);
  cardBody.querySelector('.alist')?.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    const li = e.target.closest('li[data-id]');
    const a = li && alerts.find(x => x.id === li.dataset.id);
    if (a?.lat != null) goTo(a);
  });
  document.getElementById('alerts-clear')?.addEventListener('click', async () => {
    await api('DELETE', '/api/alerts');
    alerts = [];
    renderWatch(); showAlerts();
  });
  if (alerts.some(a => !a.read)) {
    api('POST', '/api/alerts').catch(() => {});
    alerts.forEach(a => { a.read = true; });
    renderWatch();
  }
}

// Jump to whatever an alert or watch item is about, and open its card when we can.
async function goTo(a) {
  if (a.lat != null) map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), a.ref?.type === 'flight' ? 7 : 6) });
  const ref = a.ref;
  if (!ref) return;
  if (ref.type === 'flight' && ref.id) {
    const local = [...(data.flights || []), ...(data.military || [])].find(f => f.hex === ref.id);
    const hit = local || (await fetch(`/api/find?q=${ref.id}`).then(r => r.ok ? r.json() : []).catch(() => []))[0];
    if (hit) openFlight(hit, { fly: a.lat == null });
  } else if (ref.type === 'ship') {
    const s = (data.ships || []).find(x => String(x.mmsi) === String(ref.id));
    if (s) select('ships', s);
  } else if (ref.type === 'quakes') {
    const q = (data.quakes || []).find(x => x.id === ref.id);
    if (q) select('quakes', q);
  }
}

// ---------- satellites ----------
// The server hands over orbit data (TLEs) every few hours; positions are worked out here
// every second with the standard SGP4 model (satellite.js).
const SAT_GROUP = { stations: 'Space station', 'gps-ops': 'GPS', weather: 'Weather', military: 'Military', geo: 'Geostationary', starlink: 'Starlink' };
let satRecs = null, satLoading = null, satTick = 0, selectedSat = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject });
    document.head.append(s);
  });
}

async function loadSatellites(attempt = 0) {
  satLoading ||= (async () => {
    if (!window.satellite) await loadScript('https://unpkg.com/satellite.js@5.0.0/dist/satellite.min.js');
    const r = await fetch('/api/satellites');
    if (!r.ok) throw new Error(r.status);
    satRecs = (await r.json()).map(s => ({
      name: s.name, group: s.group, id: s.l1.slice(2, 7).trim(), iss: s.name.startsWith('ISS (ZARYA)'),
      satrec: satellite.twoline2satrec(s.l1, s.l2),
      incl: +s.l2.slice(8, 16), period: 1440 / +s.l2.slice(52, 63),
    }));
    setStatus('sats', '');
  })();
  try { await satLoading; updateSats(); }
  catch {
    satLoading = null;
    setStatus('sats', attempt > 1 ? 'Satellite data not ready yet, retrying' : '');
    setTimeout(() => (on.satellites || on.starlink) && loadSatellites(attempt + 1), 5000);
  }
}

function satPosition(rec, date) {
  const pv = satellite.propagate(rec.satrec, date);
  if (!pv.position) return null;
  const g = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  const v = pv.velocity;
  return { lat: satellite.degreesLat(g.latitude), lon: satellite.degreesLong(g.longitude), alt: g.height, speed: Math.hypot(v.x, v.y, v.z) };
}

const satNow = () => new Date(replay.active ? replay.time : Date.now());

function updateSats() {
  if (!satRecs || (!on.satellites && !on.starlink)) return;
  const now = satNow();
  const sats = [], stars = [];
  for (const rec of satRecs) {
    const star = rec.group === 'starlink';
    if (!(star ? on.starlink : on.satellites)) continue;
    const p = satPosition(rec, now);
    if (!p || Number.isNaN(p.lat)) continue;
    (star ? stars : sats).push({ ...p, name: rec.name, group: rec.group, id: rec.id, iss: rec.iss, rec });
  }
  data.satellites = on.satellites ? sats : null;
  data.starlink = on.starlink ? stars : null;
  if (on.satellites) setCount('satellites', sats.length);
  if (on.starlink) setCount('starlink', stars.length);
  setStatus('starlink', on.starlink && !stars.length
    ? 'Starlink orbits not downloaded yet (CelesTrak limits repeat downloads). Retrying automatically every 10 min.' : '');
  satTick++;
  if (selectedSat && (cardKind === 'satellites' || cardKind === 'starlink')) {
    const live = (selectedSat.group === 'starlink' ? stars : sats).find(s => s.id === selectedSat.id);
    if (live) openCard(cardKind, satCard(live), true);
  }
  render();
}
setInterval(updateSats, 1000);

// Ground track: from 45 minutes ago to 90 minutes ahead, split where it crosses the date line.
function selectSat(d) {
  const paths = [[]], t0 = satNow().getTime();
  for (let m = -45; m <= 90; m++) {
    const p = satPosition(d.rec, new Date(t0 + m * 60000));
    if (!p) continue;
    const cur = paths.at(-1), last = cur.at(-1);
    if (last && Math.abs(p.lon - last[0]) > 180) paths.push([]);
    paths.at(-1).push([p.lon, p.lat]);
  }
  selectedSat = { id: d.id, group: d.group, track: paths.filter(p => p.length > 1) };
}

function satCard(d) {
  return `<h2>${esc(d.name)}</h2>
    <div class="sub">${esc(SAT_GROUP[d.group] || d.group)} · NORAD ${esc(d.id)} · CelesTrak</div>
    ${rows([['Altitude', `${Math.round(d.alt).toLocaleString()} km`], ['Speed', `${d.speed.toFixed(2)} km/s (${Math.round(d.speed * 3600).toLocaleString()} km/h)`],
      ['Orbit', `once every ${Math.round(d.rec.period)} min`], ['Inclination', `${d.rec.incl.toFixed(1)}°`], ['Over', pos2(d.lat, d.lon)]])}
    <p class="sub">The line is its path over the ground, from 45 minutes ago to 90 minutes ahead. Positions are calculated from published orbit data and drift slowly between updates.</p>`;
}

// ---------- timeline replay ----------
// The server records flights every minute and ships every 5 minutes (last 24 h). In replay,
// planes and ships come from those recordings (smoothed between snapshots), and quakes, news,
// fires, disasters and satellites are shown as they were at that moment. Layers that weren't
// recorded are hidden while replaying.
const REPLAYABLE = new Set(['flights', 'military', 'ships', 'quakes', 'news', 'fires', 'events', 'satellites', 'starlink', 'cameras', 'cables', 'plants']);
const replay = { active: false, playing: false, time: Date.now(), frames: { flights: null, ships: null }, loading: {} };
let historyTimes = { flights: [], ships: [] };
let V = data; // what render() draws: live data, or the replay view
let viewCache = { key: '', value: null };

const tl = {
  bar: document.getElementById('timeline'), live: document.getElementById('tl-live'), play: document.getElementById('tl-play'),
  speed: document.getElementById('tl-speed'), slider: document.getElementById('tl-slider'),
  label: document.getElementById('tl-label'), ticks: document.getElementById('tl-ticks'),
};

const rangeStart = () => Math.min(historyTimes.flights[0] ?? Infinity, historyTimes.ships[0] ?? Infinity, Date.now() - 10 * 60000);
const timeAt = v => rangeStart() + (v / 1000) * (Date.now() - rangeStart());
const sliderAt = t => Math.round(((t - rangeStart()) / (Date.now() - rangeStart())) * 1000);

async function loadHistoryTimes() {
  try { historyTimes = await api('GET', '/api/history'); } catch { /* server busy, try later */ }
  drawTicks();
  if (!replay.active) tl.label.textContent = historyTimes.flights.length ? 'Live' : 'Live · recording started';
}

function drawTicks() {
  const start = rangeStart(), span = Date.now() - start;
  tl.ticks.innerHTML = alerts.filter(a => a.time >= start)
    .map(a => `<i style="left:${((a.time - start) / span) * 100}%" title="${esc(a.title)}"></i>`).join('');
}

function frameValid(kind) {
  const f = replay.frames[kind];
  return f && f.before && replay.time >= f.before.t && (!f.after || replay.time < f.after.t);
}

async function loadFrame(kind) {
  if (frameValid(kind) || replay.loading[kind]) return;
  replay.loading[kind] = true;
  try {
    let url = `/api/history/at?kind=${kind}&t=${Math.round(replay.time)}`;
    if (kind === 'ships') {
      const b = map.getBounds();
      url += `&bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(n => n.toFixed(2))}`;
    }
    replay.frames[kind] = await api('GET', url);
  } catch { /* keep the old frame */ }
  replay.loading[kind] = false;
  if (replay.active) showReplayTime();
  render();
}

// Rows from a recording -> objects, sliding each one toward its next recorded position.
function framePoints(kind, toObj, maxGap) {
  const f = replay.frames[kind];
  if (!f?.before || replay.time - f.before.t > maxGap) return [];
  const span = f.after ? f.after.t - f.before.t : 0;
  const frac = span ? Math.min(1, (replay.time - f.before.t) / span) : 0;
  f.nextById ||= new Map((f.after?.rows || []).map(r => [r[0], r]));
  return f.before.rows.map(r => {
    const o = toObj(r), n = f.nextById.get(r[0]);
    if (n && frac) {
      o.lat += (n[2] - r[2]) * frac;
      const dl = n[3] - r[3];
      if (Math.abs(dl) < 180) o.lon += dl * frac;
    }
    return o;
  });
}

const flightRow = r => ({ hex: r[0], call: r[1], lat: r[2], lon: r[3], alt: r[4] < 0 ? 'ground' : r[4], track: r[5], speed: r[6],
  mil: Boolean(r[7] & 1), emergency: Boolean(r[7] & 2), sanc: r[7] & 4 ? { by: 'registration' } : null, type: r[8] });
const shipRow = r => ({ mmsi: r[0], name: r[1], lat: r[2], lon: r[3], course: r[4], heading: r[4], speed: r[5], type: r[6], sanc: r[7] ? { by: 'recorded' } : null });

function currentView() {
  if (!replay.active) return data;
  const T = replay.time;
  const key = `${Math.round(T / 500)}|${replay.frames.flights?.before?.t}|${replay.frames.ships?.before?.t}|${satTick}`;
  if (viewCache.key === key) return viewCache.value;
  const flights = framePoints('flights', flightRow, 10 * 60000);
  const v = {
    flights, military: flights.filter(f => f.mil),
    ships: framePoints('ships', shipRow, 15 * 60000),
    quakes: data.quakes?.filter(q => q.time <= T && q.time > T - 24 * 3600000),
    news: data.news?.map(p => {
      const stories = p.stories.filter(s => s.time <= T);
      return stories.length && { ...p, stories, n: Math.round(p.n * stories.length / p.stories.length) || stories.length };
    }).filter(Boolean),
    fires: data.fires?.filter(f => !f.since || f.since <= T),
    events: data.events?.filter(e => !e.date || new Date(e.date).getTime() <= T),
    satellites: data.satellites, starlink: data.starlink,
    cameras: data.cameras, cables: data.cables, plants: data.plants,
  };
  viewCache = { key, value: v };
  for (const id of ['flights', 'military', 'ships', 'quakes', 'fires', 'events']) if (on[id] && v[id]) setCount(id, v[id].length);
  if (on.news && v.news) setCount('news', v.news.reduce((s, p) => s + p.n, 0));
  return v;
}

function showReplayTime() {
  const d = new Date(replay.time);
  const mins = Math.round((Date.now() - replay.time) / 60000);
  const ago = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  const recorded = frameValid('flights') || replay.frames.flights?.before;
  tl.label.textContent = `${d.toUTCString().slice(17, 22)} UTC · ${ago}${recorded ? '' : ' · not recorded'}`;
}

function setReplay(t) {
  const wasLive = !replay.active;
  replay.active = true;
  replay.time = Math.min(t, Date.now());
  tl.bar.classList.add('replaying');
  tl.live.classList.remove('on');
  tl.live.textContent = 'Go live';
  if (wasLive) {
    if (on.radar && map.getLayer('radar')) map.setLayoutProperty('radar', 'visibility', 'none');
    for (const l of LAYERS) if (on[l.id] && !REPLAYABLE.has(l.id)) setCount(l.id, 'live only');
  }
  showReplayTime();
  loadFrame('flights');
  loadFrame('ships');
  updateSats();
  render();
}

function goLive() {
  replay.active = false;
  replay.playing = false;
  replay.frames = { flights: null, ships: null };
  tl.bar.classList.remove('replaying');
  tl.live.classList.add('on');
  tl.live.textContent = '● LIVE';
  tl.play.textContent = '▶';
  tl.slider.value = 1000;
  tl.label.textContent = 'Live';
  if (on.radar) setRadar();
  for (const l of LAYERS) if (on[l.id] && data[l.id]) setCount(l.id, (COUNT[l.id] || (d => d.length))(data[l.id]));
  updateSats();
  render();
}

tl.slider.addEventListener('input', () => {
  if (+tl.slider.value >= 1000) return goLive();
  setReplay(timeAt(+tl.slider.value));
});
tl.live.addEventListener('click', goLive);
tl.play.addEventListener('click', () => {
  if (!replay.active) setReplay(rangeStart()); // start from the beginning of the recording
  replay.playing = !replay.playing;
  tl.play.textContent = replay.playing ? '❚❚' : '▶';
});

setInterval(() => {
  if (!replay.active || !replay.playing) return;
  const t = replay.time + Number(tl.speed.value) * 250;
  if (t >= Date.now() - 30000) return goLive();
  replay.time = t;
  tl.slider.value = sliderAt(t);
  showReplayTime();
  loadFrame('flights');
  loadFrame('ships');
  render();
}, 250);

map.on('moveend', () => { if (replay.active) { replay.frames.ships = null; loadFrame('ships'); } });
loadHistoryTimes();
setInterval(loadHistoryTimes, 60000);

CARDS.replayFlight = d => `<h2>${esc(d.call || d.hex)}${d.mil ? '<span class="flag mil">MILITARY</span>' : ''}${d.emergency ? '<span class="flag emg">EMERGENCY</span>' : ''}${d.sanc ? '<span class="flag emg">SANCTIONED</span>' : ''}</h2>
  <div class="sub">Recorded at ${new Date(replay.time).toUTCString().slice(17, 22)} UTC · ${esc(d.type)} · ICAO ${esc(d.hex)}</div>
  ${rows([['Altitude', d.alt === 'ground' ? 'on ground' : `${Number(d.alt).toLocaleString()} ft`], ['Speed', `${d.speed} kt`], ['Heading', `${d.track}°`], ['Position', pos2(d.lat, d.lon)]])}
  <div class="actions"><button id="replay-track">Track it live now</button></div>`;

// ---------- "updated X ago" timers ----------
const updatedAt = {}; // layer -> time (ms, this browser's clock) its data was last refreshed
const shortAge = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function showAges() {
  const now = Date.now();
  for (const l of LAYERS) {
    const el = document.getElementById(`age-${l.id}`);
    const t = updatedAt[l.id];
    if (!on[l.id] || !t || replay.active) { el.textContent = ''; continue; } // replay shows its time in the timeline
    const age = now - t, stale = age > EVERY[l.id] * 3000;
    el.textContent = shortAge(age);
    el.classList.toggle('stale', stale);
    el.title = `${l.id === 'radar' ? 'Radar picture taken' : 'Last refreshed'} ${new Date(t).toLocaleTimeString()}`
      + ` · normally every ${shortAge(EVERY[l.id] * 1000).replace(' ago', '')}${stale ? ' · running late, the source may be slow or down' : ''}`;
  }
  // Watchlist times
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = shortAge(now - Number(el.dataset.t));
}
setInterval(showAges, 1000);

// ---------- start ----------
loadWatch();
for (const l of LAYERS) if (on[l.id] && l.kind === 'feed') loadFeed(l.id);
if (on.radar) setRadar();
if (on.satellites || on.starlink) loadSatellites();
connect();
setInterval(() => { document.getElementById('clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; }, 1000);
