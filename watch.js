// Watchlist + alerts. Runs on the server so alerts fire even when no browser is open.
// Watch items: a flight, a ship, or an area with rules. Saved to data/watch.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as F from './feeds.js';
import { inBox } from './intel.js';

const MIN = 60 * 1000;
const EMERGENCY = { 7500: 'hijack', 7600: 'radio failure', 7700: 'general emergency' };

export const AREA_RULES = {
  military: 'Military aircraft enters',
  emergency: 'Emergency squawk (7500/7600/7700)',
  quake: 'Earthquake at or above magnitude',
  fire: 'New US wildfire',
  events: 'New natural disaster',
  shipsDark: 'Moving ship stops transmitting',
  sanctioned: 'Sanctioned ship or plane is in the area',
  shipBehaviour: 'Suspicious ship activity (transfers, cable loitering, fake positions)',
  news: 'News tagged violence',
};

export function createWatch({ dir, feeds, broadcast }) {
  const file = join(dir, 'watch.json');
  let state = { items: [], alerts: [] };
  try { if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { console.warn(`[watch] could not read ${file}: ${err.message}`); }

  const memory = new Map(); // item id -> runtime memory (not saved)
  let emergencyList = [], emergencyAt = 0;

  const save = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 1));
  };

  function alert(item, a) {
    const full = { id: randomUUID(), time: Date.now(), watchId: item.id, watchLabel: item.label, read: false, ...a };
    state.alerts.unshift(full);
    state.alerts = state.alerts.slice(0, 300);
    save();
    console.log(`[alert] ${full.title}`);
    broadcast('alert', JSON.stringify(full));
  }

  const inArea = (item, lat, lon) => inBox(item.bbox, lat, lon);
  const name = f => f.call || f.reg || f.hex?.toUpperCase();
  const alt = f => (f.alt === 'ground' ? 'on the ground' : `${Number(f.alt).toLocaleString()} ft`);

  // ---------- one flight ----------
  async function checkFlight(item, mem) {
    if (Date.now() - (mem.polled || 0) < 30000) return;
    mem.polled = Date.now();
    let f;
    try { f = await F.lookupAircraft(item); } catch { return; } // rate limited: try next round
    const prev = item.status || {};
    const now = Date.now();
    if (f) {
      const ground = f.alt === 'ground';
      const st = { online: true, ground, alt: f.alt, speed: f.speed, lat: f.lat, lon: f.lon, squawk: f.squawk, hex: f.hex, lastSeen: now };
      if (mem.primed) {
        const where = { lat: f.lat, lon: f.lon, ref: { type: 'flight', id: f.hex } };
        if (!prev.online) alert(item, { kind: 'flight', title: `${name(f)} is broadcasting`, detail: `${alt(f)}, ${Math.round(f.speed || 0)} kt`, ...where });
        else if (prev.ground && !ground) alert(item, { kind: 'flight', title: `${name(f)} took off`, detail: `Climbing through ${alt(f)}`, ...where });
        else if (!prev.ground && ground) alert(item, { kind: 'flight', title: `${name(f)} landed`, detail: 'Now on the ground', ...where });
        if (EMERGENCY[f.squawk] && f.squawk !== prev.squawk) {
          alert(item, { kind: 'emergency', title: `${name(f)} squawking ${f.squawk} (${EMERGENCY[f.squawk]})`, detail: alt(f), ...where });
        }
      }
      item.status = st;
    } else {
      if (prev.online && now - (prev.lastSeen || 0) > 10 * MIN) {
        item.status = { ...prev, online: false };
        if (mem.primed) alert(item, { kind: 'flight', title: `${item.label} lost signal`, detail: prev.ground ? 'Last seen on the ground' : `Last seen at ${alt(prev)}. It may have landed outside receiver coverage.`, lat: prev.lat, lon: prev.lon });
      } else if (!prev.lastSeen) item.status = { online: false };
    }
    mem.primed = true;
  }

  // ---------- one ship ----------
  function checkShip(item, mem) {
    const s = F.getShip(item.mmsi);
    const prev = item.status || {};
    const now = Date.now();
    const where = s ? { lat: s.lat, lon: s.lon, ref: { type: 'ship', id: item.mmsi } } : { lat: prev.lat, lon: prev.lon };
    if (s?.seen) {
      const moving = (s.speed || 0) > 1;
      if (mem.primed) {
        if (prev.dark) alert(item, { kind: 'ship', title: `${item.label} is transmitting again`, detail: `${s.speed ?? 0} kt`, ...where });
        if (prev.dest !== undefined && s.dest && s.dest !== prev.dest) alert(item, { kind: 'ship', title: `${item.label} changed destination`, detail: `${prev.dest || 'none'} → ${s.dest}`, ...where });
        if (prev.moving !== undefined && moving !== prev.moving && !prev.dark) alert(item, { kind: 'ship', title: `${item.label} ${moving ? 'is under way' : 'has stopped'}`, detail: `${s.speed ?? 0} kt`, ...where });
      }
      item.status = { online: true, dark: false, moving, speed: s.speed, dest: s.dest || prev.dest, lat: s.lat, lon: s.lon, lastSeen: s.seen };
    }
    const st = item.status || {};
    if (st.online && !st.dark && now - (st.lastSeen || now) > 20 * MIN) {
      item.status = { ...st, dark: true };
      if (mem.primed) alert(item, { kind: 'dark', title: `${item.label} stopped transmitting`, detail: st.moving ? `Was moving at ${st.speed} kt. This can mean AIS was switched off, or the ship left receiver coverage.` : 'No position reports for 20 minutes.', lat: st.lat, lon: st.lon });
    }
    if (!item.status) item.status = { online: false };
    mem.primed = true;
  }

  // ---------- an area ----------
  // Each rule remembers what it has already seen, so only new things alert.
  // The first pass after creating a watch just records what's already there.
  function checkArea(item, mem) {
    const r = item.rules || {};
    const seen = key => (mem[key] ||= new Map());
    const fresh = (key, id, cooldown = Infinity) => {
      const m = seen(key), last = m.get(id);
      const isNew = last === undefined || Date.now() - last > cooldown;
      m.set(id, Date.now());
      return isNew && mem.primed;
    };
    const counts = {};

    if (r.military) for (const f of feeds.military?.data || []) {
      if (!inArea(item, f.lat, f.lon)) continue;
      counts.military = (counts.military || 0) + 1;
      if (fresh('mil', f.hex, 60 * MIN)) alert(item, { kind: 'military', title: `Military aircraft in ${item.label}: ${name(f)}`, detail: `${f.type || 'unknown type'} · ${alt(f)}`, lat: f.lat, lon: f.lon, ref: { type: 'flight', id: f.hex } });
    }
    if (r.emergency) for (const f of emergencyList) {
      if (!inArea(item, f.lat, f.lon)) continue;
      counts.emergency = (counts.emergency || 0) + 1;
      if (fresh('emg', `${f.hex}:${f.squawk}`, 60 * MIN)) alert(item, { kind: 'emergency', title: `${name(f)} squawking ${f.squawk} (${EMERGENCY[f.squawk]})`, detail: `${f.type || ''} · ${alt(f)}`, lat: f.lat, lon: f.lon, ref: { type: 'flight', id: f.hex } });
    }
    if (r.quake != null) for (const q of feeds.quakes?.data || []) {
      if (q.mag < r.quake || !inArea(item, q.lat, q.lon)) continue;
      if (fresh('quake', q.id)) alert(item, { kind: 'quake', title: `M${q.mag.toFixed(1)} earthquake in ${item.label}`, detail: q.place, lat: q.lat, lon: q.lon, ref: { type: 'quakes', id: q.id } });
    }
    if (r.fire) for (const f of feeds.fires?.data || []) {
      if (!inArea(item, f.lat, f.lon)) continue;
      if (fresh('fire', `${f.name}:${f.state}`)) alert(item, { kind: 'fire', title: `New wildfire in ${item.label}: ${f.name}`, detail: `${Math.round(f.acres).toLocaleString()} acres`, lat: f.lat, lon: f.lon });
    }
    if (r.events) for (const e of feeds.events?.data || []) {
      if (!inArea(item, e.lat, e.lon)) continue;
      if (fresh('event', e.title)) alert(item, { kind: 'event', title: `${e.cat} in ${item.label}`, detail: e.title, lat: e.lat, lon: e.lon });
    }
    if (r.shipsDark) {
      for (const s of feeds.dark?.data || []) {
        if (!inArea(item, s.lat, s.lon)) continue;
        if (fresh('dark', s.mmsi, 6 * 60 * MIN)) {
          alert(item, { kind: 'dark', title: `${s.name || `MMSI ${s.mmsi}`} stopped transmitting in ${item.label}`,
            detail: `Was moving at ${s.speed} kt, silent for ${s.silentMin} min. ${s.confidence === 'high' ? 'Ships nearby are still being heard, so it likely switched AIS off.' : 'No other ships heard nearby, so it may just be out of receiver range.'}`,
            lat: s.lat, lon: s.lon });
        }
      }
    }
    if (r.sanctioned) {
      for (const s of feeds.sanctioned?.data || []) {
        if (!inArea(item, s.lat, s.lon)) continue;
        counts.sanctioned = (counts.sanctioned || 0) + 1;
        if (fresh('sanc', `ship:${s.mmsi}`, 12 * 60 * MIN)) alert(item, { kind: 'sanctioned', title: `Sanctioned ship in ${item.label}: ${s.name || `MMSI ${s.mmsi}`}`, detail: `${s.sanc.programs.join(', ')} · matched by ${s.sanc.by}`, lat: s.lat, lon: s.lon, ref: { type: 'ship', id: s.mmsi } });
      }
      const planes = [...(feeds.military?.data || []), ...F.knownRegions().flatMap(F.cachedFlights)];
      for (const f of planes) {
        if (!f.sanc || !inArea(item, f.lat, f.lon)) continue;
        if (fresh('sanc', `plane:${f.hex}`, 12 * 60 * MIN)) alert(item, { kind: 'sanctioned', title: `Sanctioned aircraft in ${item.label}: ${name(f)}`, detail: `${f.sanc.model || f.type} · ${f.sanc.operator || f.sanc.name} · ${f.sanc.programs.join(', ')}`, lat: f.lat, lon: f.lon, ref: { type: 'flight', id: f.hex } });
      }
    }
    if (r.shipBehaviour) {
      const what = { sts: 'Possible ship-to-ship transfer', cable: 'Ship loitering over an undersea cable',
        jump: 'Impossible position jump', identity: 'Ship changed its identity', clone: 'Two ships using the same IMO' };
      for (const d of feeds.shipwatch?.data || []) {
        if (!inArea(item, d.lat, d.lon)) continue;
        const id = d.kind === 'sts' ? `${d.a.mmsi}|${d.b.mmsi}` : d.kind === 'clone' ? d.imo : d.mmsi;
        if (!fresh('ship', `${d.kind}:${id}`, 6 * 60 * MIN)) continue;
        const who = d.kind === 'sts' ? `${d.a.name || d.a.mmsi} + ${d.b.name || d.b.mmsi}` : d.kind === 'clone' ? `IMO ${d.imo}` : d.name || `MMSI ${d.mmsi}`;
        const detail = d.kind === 'sts' ? `${d.distM} m apart for ${d.minutes} min`
          : d.kind === 'cable' ? `${d.cable}: ${d.minutes} min within ${d.cableM} m, ${d.speed} kt`
          : d.kind === 'jump' ? `${d.distKm} km in ${d.minutes} min (would need ${d.impliedKn} kt)`
          : d.kind === 'identity' ? `${d.field}: ${d.from} → ${d.to}`
          : `${d.ships.length} ships, ${d.km} km apart`;
        alert(item, { kind: 'shipwatch', title: `${what[d.kind]} in ${item.label}: ${who}`, detail, lat: d.lat, lon: d.lon,
          ref: d.mmsi ? { type: 'ship', id: d.mmsi } : undefined });
      }
    }
    if (r.news) {
      const newOnes = [];
      for (const p of feeds.news?.data || []) {
        if (!inArea(item, p.lat, p.lon)) continue;
        for (const s of p.stories) if (s.cat === 'violence' && fresh('news', s.url)) newOnes.push({ ...s, place: p.place, lat: p.lat, lon: p.lon });
      }
      if (newOnes.length) {
        const top = newOnes.sort((a, b) => b.mentions - a.mentions)[0];
        alert(item, { kind: 'news', title: `${newOnes.length} new violence-tagged ${newOnes.length === 1 ? 'story' : 'stories'} in ${item.label}`, detail: `${top.title} (${top.place})`, url: top.url, lat: top.lat, lon: top.lon });
      }
    }
    item.status = { counts, checked: Date.now() };
    mem.primed = true;
  }

  async function tick() {
    if (state.items.some(i => i.type === 'area' && i.rules?.emergency) && Date.now() - emergencyAt > 60000) {
      emergencyAt = Date.now();
      try { emergencyList = await F.emergencies(); } catch { /* rate limited: keep last list */ }
    }
    const before = JSON.stringify(state.items.map(i => i.status));
    for (const item of state.items) {
      const mem = memory.get(item.id) || {};
      memory.set(item.id, mem);
      try {
        if (item.type === 'flight') await checkFlight(item, mem);
        else if (item.type === 'ship') checkShip(item, mem);
        else if (item.type === 'area') checkArea(item, mem);
      } catch (err) { console.warn(`[watch] ${item.label}: ${err.message}`); }
    }
    if (JSON.stringify(state.items.map(i => i.status)) !== before) {
      save();
      broadcast('watch', JSON.stringify(state.items));
    }
  }
  const loop = async () => { await tick(); setTimeout(loop, 15000).unref(); };
  setTimeout(loop, 5000).unref(); // give the feeds a moment to load first

  // ---------- API ----------
  function add(body) {
    const label = String(body.label || '').trim().slice(0, 60);
    let item;
    if (body.type === 'flight') {
      const hex = /^[0-9a-f]{6}$/i.test(body.hex || '') ? body.hex.toLowerCase() : null;
      const call = String(body.call || '').trim().toUpperCase();
      if (!hex && !call) throw new Error('flight needs hex or callsign');
      item = { type: 'flight', hex, call: hex ? null : call, label: label || call || hex.toUpperCase() };
    } else if (body.type === 'ship') {
      if (!/^\d{6,9}$/.test(String(body.mmsi))) throw new Error('ship needs an MMSI');
      item = { type: 'ship', mmsi: Number(body.mmsi), label: label || `MMSI ${body.mmsi}` };
    } else if (body.type === 'area') {
      const bbox = Array.isArray(body.bbox) && body.bbox.length === 4 && body.bbox.every(Number.isFinite) ? body.bbox : null;
      const rules = {};
      for (const k of Object.keys(AREA_RULES)) if (body.rules?.[k] !== undefined && body.rules[k] !== false) rules[k] = k === 'quake' ? Number(body.rules[k]) || 4 : true;
      if (!Object.keys(rules).length) throw new Error('pick at least one rule');
      item = { type: 'area', bbox, rules, label: label || (bbox ? 'Area' : 'Whole world') };
    } else throw new Error('unknown watch type');
    item.id = randomUUID();
    item.created = Date.now();
    state.items.push(item);
    save();
    broadcast('watch', JSON.stringify(state.items));
    setTimeout(tick, 500); // check the new item right away
    return item;
  }

  function remove(id) {
    state.items = state.items.filter(i => i.id !== id);
    memory.delete(id);
    save();
    broadcast('watch', JSON.stringify(state.items));
  }

  function markRead() {
    for (const a of state.alerts) a.read = true;
    save();
  }

  function clearAlerts() {
    state.alerts = [];
    save();
  }

  return { get: () => state, add, remove, markRead, clearAlerts };
}
