// Analysis helpers: sanctions matching, ships going dark, GPS jamming.
// Pure functions (no network), so they're easy to test.

export const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- geometry ----------
export const km = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export const bearing = (a, b) => {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
};

// Inside a [west, south, east, north] box, including boxes that cross the date line. No box = whole world.
export function inBox(bbox, lat, lon) {
  if (!bbox) return true;
  const [w, s, e, n] = bbox;
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

// ---------- flight routes ----------
// Routes can have stops (BOS-SFO-SNA). Pick the leg the plane is actually flying and say
// whether its position and heading fit that leg.
export function pickLeg(ports, here, takeoff, track) {
  if (!ports || ports.length < 2) return null;
  const legs = ports.slice(0, -1).map((from, i) => ({ from, to: ports[i + 1] }));
  const detour = l => km(l.from, here) + km(here, l.to) - km(l.from, l.to);
  // Prefer the leg starting where the plane took off; otherwise the leg it's flying along.
  const leg = (takeoff && legs.find(l => km(l.from, takeoff) < 25)) || [...legs].sort((a, b) => detour(a) - detour(b))[0];
  const total = km(leg.from, leg.to);
  // Once well clear of the origin, the plane should point roughly at the destination.
  const off = Number.isFinite(track) ? Math.abs(((bearing(here, leg.to) - track + 540) % 360) - 180) : 0;
  const headingOk = off < 100 || km(here, leg.from) < 80 || km(here, leg.to) < 80;
  const plausible = headingOk && detour(leg) < Math.max(150, total * 0.25) && km(here, leg.to) <= total * 1.05;
  return { ...leg, stops: ports.map(p => p.code), plausible };
}

// ---------- news (GDELT) ----------
// GDELT has no headlines, so make one from the link's slug, or fall back to the site name.
export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean)
      .map(p => decodeURIComponent(p).replace(/\.(s?html?|php|aspx?)$/i, ''));
    const slug = parts.reverse().find(p => /[a-z]{3,}[-_][a-z]{3,}/i.test(p)) || '';
    const words = slug.replace(/[-_+]+/g, ' ').replace(/\b[\da-f]{6,}\b|\b\d+\b/gi, '')
      .replace(/(^|\s)[^\p{L}\p{N}]+(?=\s|$)/gu, ' ') // punctuation left behind by removed IDs (e.g. "9.7410624")
      .replace(/\s+/g, ' ').trim();
    return words.length > 12 ? words[0].toUpperCase() + words.slice(1) : u.host.replace(/^www\./, '');
  } catch { return url; }
}

// CAMEO event root codes -> our four news categories.
export function newsCategory(root) {
  if (root >= 18) return 'violence';       // assault, fight, mass violence
  if (root === 14) return 'protest';
  if (root >= 13) return 'tension';        // threaten, posture, sanction, coerce
  return 'other';
}

// Fold one tab-separated GDELT export row into the url -> story map.
// One article yields many machine-coded events; its category is the one most of them agree on.
export function addGdeltRow(stories, line, time) {
  const c = line.split('\t');
  const lat = +c[56], lon = +c[57], url = c[60];
  if (!url || !lat || !lon) return;
  const mentions = +c[31] || 1, cat = newsCategory(+c[28]);
  let s = stories.get(url);
  if (!s) {
    let domain = '';
    try { domain = new URL(url).host.replace(/^www\./, ''); } catch { return; }
    s = { url, title: titleFromUrl(url), domain, votes: {}, mentions: 0, time };
    stories.set(url, s);
  }
  s.votes[cat] = (s.votes[cat] || 0) + 1;
  s.cat = Object.entries(s.votes).sort((a, b) => b[1] - a[1] || (b[0] === 'other') - (a[0] === 'other'))[0][0];
  if (mentions > s.mentions) Object.assign(s, { place: c[52], lat: round(lat, 3), lon: round(lon, 3), tone: round(+c[34], 1), mentions });
}

// ---------- sanctions (US Treasury OFAC SDN list) ----------
// Columns: ent_num, name, type, program, title, call_sign, vess_type, tonnage, grt, vess_flag, vess_owner, remarks
const blank = v => (v && v.trim() !== '-0-' ? v.trim() : '');
export const normalizeReg = r => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parseOfacCsv(csv) {
  const ships = [], aircraft = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line) continue;
    const c = parseCsvLine(line).map(blank);
    if (c.length < 4) continue; // blank or end-of-file lines
    const [, name = '', type = '', program = '', , callSign = '', vessType = '', , , flag = '', owner = '', remarks = ''] = c;
    const programs = program.replace(/[[\]]/g, ' ').split(/\s+/).filter(Boolean);
    if (type === 'vessel') {
      ships.push({
        name, programs, flag, owner, vesselType: vessType, callSign,
        imo: [...remarks.matchAll(/IMO (\d{7})/g)].map(m => m[1]),
        mmsi: [...remarks.matchAll(/MMSI (\d{9})/g)].map(m => m[1]),
      });
    } else if (type === 'aircraft') {
      const tails = [...remarks.matchAll(/Tail Number:? ([A-Z0-9-]+)/gi)].map(m => m[1]);
      if (/^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/i.test(name)) tails.push(name);
      aircraft.push({
        name, programs, regs: [...new Set(tails.map(normalizeReg))].filter(Boolean),
        model: (remarks.match(/Aircraft Model ([^;]+)/) || [])[1] || '',
        operator: (remarks.match(/Aircraft Operator ([^;]+)/) || [])[1] || '',
      });
    }
  }
  return { ships, aircraft };
}

// Lookup tables. Ship IMO numbers are permanent (strong match); MMSIs can be
// reassigned or spoofed, so an MMSI-only match is marked as weaker.
export function buildSanctionsIndex({ ships, aircraft }) {
  const imo = new Map(), mmsi = new Map(), reg = new Map();
  for (const s of ships) {
    const info = { name: s.name, programs: s.programs, flag: s.flag, owner: s.owner };
    for (const n of s.imo) imo.set(n, info);
    for (const n of s.mmsi) mmsi.set(n, info);
  }
  for (const a of aircraft) {
    const info = { name: a.name, programs: a.programs, model: a.model, operator: a.operator };
    for (const r of a.regs) reg.set(r, info);
  }
  return { imo, mmsi, reg, counts: { ships: ships.length, aircraft: aircraft.length } };
}

export function matchShip(index, ship) {
  if (!index) return null;
  const byImo = ship.imo && index.imo.get(String(ship.imo));
  if (byImo) return { ...byImo, by: 'IMO' };
  const byMmsi = ship.mmsi && index.mmsi.get(String(ship.mmsi));
  return byMmsi ? { ...byMmsi, by: 'MMSI' } : null;
}

export function matchAircraft(index, reg) {
  if (!index || !reg) return null;
  const hit = index.reg.get(normalizeReg(reg));
  return hit ? { ...hit, by: 'registration' } : null;
}

// ---------- ships going dark ----------
// A ship that was moving and then stops reporting. If other ships nearby are still being
// heard, a receiver gap is unlikely, so it probably switched its transponder off.
const MIN = 60 * 1000;
const cellOf = (lat, lon, size) => `${Math.floor(lat / size)}:${Math.floor(lon / size)}`;

export function findDarkShips(ships, now = Date.now(), { minSilent = 20 * MIN, maxSilent = 6 * 60 * MIN, minSpeed = 2, cell = 0.25 } = {}) {
  const recent = new Map(); // cell -> ships heard in the last 10 min
  const list = [...ships];
  for (const s of list) {
    if (s.lat == null || now - s.seen > 10 * MIN) continue;
    const k = cellOf(s.lat, s.lon, cell);
    recent.set(k, (recent.get(k) || 0) + 1);
  }
  const out = [];
  for (const s of list) {
    const silent = now - (s.seen || now);
    if (s.lat == null || silent < minSilent || silent > maxSilent || (s.speed || 0) < minSpeed) continue;
    const [r, c] = cellOf(s.lat, s.lon, cell).split(':').map(Number);
    let neighbors = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) neighbors += recent.get(`${r + dr}:${c + dc}`) || 0;
    out.push({
      mmsi: s.mmsi, name: s.name, type: s.type, imo: s.imo, dest: s.dest, lat: s.lat, lon: s.lon,
      speed: s.speed, course: s.course, lastSeen: s.seen, silentMin: Math.round(silent / MIN),
      neighbors, confidence: neighbors >= 3 ? 'high' : 'low', sanc: s.sanc || null,
    });
  }
  return out;
}

// ---------- GPS jamming ----------
// Aircraft report how accurate their GPS position is (NACp). Lots of planes in one area
// reporting poor accuracy at once is the signature of jamming (same idea as gpsjam.org).
export const BAD_NACP = 8; // below 8 = position error over ~93 m

// Only positions the aircraft broadcast itself (ADS-B v2) count: ground rebroadcasts (TIS-B,
// ADS-R) and MLAT always report low accuracy and would look like jamming everywhere.
export const countsForJamming = f =>
  f.nacp != null && f.lat != null && f.alt !== 'ground' && (!f.src || f.src === 'adsb_icao') && (f.ver == null || f.ver >= 2);

// Strong signs need both a high share AND several aircraft, so one odd transponder can't trigger it.
export function jammingLevel({ pct, bad }) {
  if (pct >= 10 && bad >= 3) return 'high';
  if (pct >= 5 && bad >= 3) return 'medium'; // a couple of odd planes (~2–5%) is normal background noise
  return 'normal';
}

export function createJammingTracker({ cell = 1, windowMs = 60 * MIN, minAircraft = 5 } = {}) {
  const cells = new Map(); // key -> Map(hex -> { bad, t })
  return {
    record(flights, now = Date.now()) {
      for (const f of flights) {
        if (!countsForJamming(f)) continue;
        const k = cellOf(f.lat, f.lon, cell);
        if (!cells.has(k)) cells.set(k, new Map());
        cells.get(k).set(f.hex, { bad: f.nacp < BAD_NACP, t: now });
      }
    },
    summary(now = Date.now()) {
      const out = [];
      for (const [k, planes] of cells) {
        let n = 0, bad = 0;
        for (const [hex, p] of planes) {
          if (now - p.t > windowMs) { planes.delete(hex); continue; }
          n++; if (p.bad) bad++;
        }
        if (!planes.size) { cells.delete(k); continue; }
        if (n < minAircraft) continue;
        const [r, c] = k.split(':').map(Number);
        const pct = Math.round((100 * bad) / n);
        out.push({ lat: round(r * cell, 2), lon: round(c * cell, 2), size: cell, n, bad, pct, level: jammingLevel({ pct, bad }) });
      }
      return out;
    },
  };
}

// ---------- suspicious ship behaviour ----------
// Three patterns analysts look for by hand:
//  - ship-to-ship transfer: two ships side by side, slow, away from port, for a long time
//    (how sanctioned oil changes hands at sea)
//  - cable loitering: a ship moving slowly along an undersea cable for a long time
//    (the signature of the 2023-25 Baltic anchor-dragging incidents)
//  - fake or confused identity: impossible position jumps, two ships using the same IMO
//    number far apart, ships changing their name
const KM_PER_DEG_LAT = 110.57;
const KNOTS_PER_KMH = 0.539957;

const isTanker = s => s.type >= 80 && s.type < 90;
const isService = s => s.type >= 50 && s.type < 60; // pilots, tugs, port tenders, SAR, law enforcement
// Ships that do ocean transfers: a seagoing tanker (150 m+) alongside another big ship (100 m+).
// River tank barges and small coastal craft moored together would otherwise flood the list.
const transferPair = (a, b) => [[a, b], [b, a]].some(([t, o]) => isTanker(t) && (t.length || 0) >= 150 && (o.length || 0) >= 100);
// The cable incidents involved cargo ships and tankers. Fishing and pleasure boats sit over
// coastal cables all day, and ferries wait at terminals right where cables come ashore.
const isPassenger = s => s.type >= 60 && s.type < 70;
const commercial = s => !isPassenger(s) && (
  (s.type >= 70 && s.type < 90 && (!s.length || s.length >= 50)) || (s.length || 0) >= 80);
const shipSummary = s => ({ mmsi: s.mmsi, name: s.name || '', type: s.type || 0, imo: s.imo || null, length: s.length || 0,
  lat: s.lat, lon: s.lon, speed: s.speed ?? 0, course: s.course ?? 0, sanc: s.sanc || null });

// Grid index for ports: Map "row:col" -> ports, 1-degree cells.
export function buildPortIndex(ports) {
  const cells = new Map();
  for (const p of ports) {
    const k = `${Math.floor(p.lat)}:${Math.floor(p.lon)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  return cells;
}

export function nearestPort(index, lat, lon) {
  if (!index) return null;
  let best = null;
  const r = Math.floor(lat), c = Math.floor(lon);
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    for (const p of index.get(`${r + dr}:${c + dc}`) || []) {
      const d = km({ lat, lon }, p);
      if (!best || d < best.km) best = { km: d, name: p.name };
    }
  }
  return best;
}
const nearPort = (index, lat, lon, maxKm) => (nearestPort(index, lat, lon)?.km ?? Infinity) < maxKm;

// Undersea cables split into segments and filed in 0.25-degree cells, so "how far is this ship
// from the nearest cable" only looks at a handful of segments.
export function buildCableIndex(geojson, cell = 0.25) {
  const cells = new Map();
  const add = (k, seg) => { if (!cells.has(k)) cells.set(k, []); cells.get(k).push(seg); };
  for (const f of geojson.features || []) {
    const lines = f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.coordinates || [];
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [lon1, lat1] = line[i], [lon2, lat2] = line[i + 1];
        if (Math.abs(lon2 - lon1) > 180) continue; // the jump across the date line
        const seg = { lat1, lon1, lat2, lon2, name: f.properties?.name || 'cable' };
        const r1 = Math.floor(Math.min(lat1, lat2) / cell), r2 = Math.floor(Math.max(lat1, lat2) / cell);
        const c1 = Math.floor(Math.min(lon1, lon2) / cell), c2 = Math.floor(Math.max(lon1, lon2) / cell);
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) add(`${r}:${c}`, seg);
      }
    }
  }
  return { cells, cell };
}

// Distance from a point to a segment in km, using a flat projection around the point
// (accurate to well under 1% at these short distances).
function kmToSegment(lat, lon, s) {
  const kx = Math.cos(lat * Math.PI / 180) * 111.32;
  const ax = (s.lon1 - lon) * kx, ay = (s.lat1 - lat) * KM_PER_DEG_LAT;
  const bx = (s.lon2 - lon) * kx, by = (s.lat2 - lat) * KM_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function nearestCable(index, lat, lon) {
  if (!index) return null;
  const r = Math.floor(lat / index.cell), c = Math.floor(lon / index.cell);
  let best = null;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    for (const seg of index.cells.get(`${r + dr}:${c + dc}`) || []) {
      const d = kmToSegment(lat, lon, seg);
      if (!best || d < best.km) best = { km: d, name: seg.name };
    }
  }
  return best;
}

// A position report that would need an impossible speed to reach from the previous one.
// Usually two transmitters sharing one MMSI, or a faked position.
export function checkJump(prev, cur) {
  if (prev?.lat == null || cur?.lat == null || !prev.t || cur.t <= prev.t) return null;
  // Garbled data, not a ship pretending to be somewhere else, so not reported. Seen live:
  //  - one coordinate unchanged while the other is corrupted (a dropped digit 40.774 -> 0.773,
  //    a flipped sign 122.31 -> -122.31, a field read as 0)
  //  - positions near the poles (-86.9) or near 0,0 ("null island")
  const same = (a, b) => Math.abs(a - b) < 0.05;
  if (same(prev.lat, cur.lat) || same(prev.lon, cur.lon)) return null;
  const implausible = p => Math.abs(p.lat) > 85 || (Math.abs(p.lat) < 3 && Math.abs(p.lon) < 3);
  if (implausible(prev) || implausible(cur)) return null;
  const distKm = km(prev, cur);
  if (distKm < 10) return null;
  const hours = (cur.t - prev.t) / 3.6e6;
  const impliedKn = (distKm / hours) * KNOTS_PER_KMH;
  const limit = Math.max(50, (cur.speed || 0) * 2 + 20); // fast ferries do about 40 kn
  return impliedKn > limit ? { distKm: round(distKm, 1), minutes: Math.max(1, Math.round(hours * 60)), impliedKn: Math.round(impliedKn) } : null;
}

const normName = n => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const validImo = imo => /^\d{7}$/.test(String(imo || '')) && !['0000000', '1234567', '9999999'].includes(String(imo));
// Real ship MMSIs are 9 digits starting 2-7. Placeholders (111111111, 123456789, 200000000)
// are shared by many unrelated boats, so their "jumps" mean nothing.
export const validMmsi = mmsi => {
  const m = String(mmsi || '');
  return /^[2-7]\d{8}$/.test(m) && !/^(\d)\1{8}$/.test(m) && m !== '123456789' && !/0{6}$/.test(m);
};

// Name or IMO changed between two static reports from the same MMSI.
// Names that are radio garbage rather than a real name: "@" is filler in ship radio text
// ("MSC P@@H.P@@II"), web addresses are test transmitters ("WWW.FURUNO.SE").
const junkName = n => /@/.test(n) || /^www\.|\.(com|net|org|se|de|nl|no|uk)$/i.test(n.trim()) || normName(n).length < 3;

export function identityChange(prev, cur) {
  if (!prev) return null;
  if (validImo(prev.imo) && validImo(cur.imo) && String(prev.imo) !== String(cur.imo)) return { field: 'IMO', from: String(prev.imo), to: String(cur.imo) };
  const a = normName(prev.name), b = normName(cur.name);
  if (!a || !b || a === b || junkName(prev.name) || junkName(cur.name)) return null;
  if (a.includes(b) || b.includes(a)) return null; // truncated or padded, same name
  return { field: 'name', from: prev.name, to: cur.name };
}

// Two or more ships reporting the same IMO number far apart: one of them is using a
// borrowed identity (or someone mistyped it).
export function findSharedImo(ships, now = Date.now(), { recentMin = 30, minKm = 50 } = {}) {
  const byImo = new Map();
  for (const s of ships) {
    if (!validImo(s.imo) || s.lat == null || now - s.seen > recentMin * MIN) continue;
    const k = String(s.imo);
    if (!byImo.has(k)) byImo.set(k, []);
    byImo.get(k).push(s);
  }
  const out = [];
  for (const [imo, list] of byImo) {
    if (list.length < 2) continue;
    let far = 0;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) far = Math.max(far, km(list[i], list[j]));
    if (far >= minKm) out.push({ imo, km: Math.round(far), ships: list.map(shipSummary), lat: list[0].lat, lon: list[0].lon });
  }
  return out;
}

export function createStsTracker({ maxKm = 0.5, maxKn = 2, minMinutes = 60, minPortKm = 20, recentMin = 15 } = {}) {
  const pairs = new Map(); // "a|b" -> { first, last, a, b, d }
  const cell = 0.01; // about 1 km
  return {
    update(ships, now, portIndex) {
      const grid = new Map();
      const slow = [];
      for (const s of ships) {
        if (s.lat == null || now - s.seen > recentMin * MIN || (s.speed ?? 99) > maxKn || isService(s) || !validMmsi(s.mmsi)) continue;
        if (nearPort(portIndex, s.lat, s.lon, minPortKm)) continue; // berthed, or at a harbour anchorage
        slow.push(s);
        const k = `${Math.floor(s.lat / cell)}:${Math.floor(s.lon / cell)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
      const together = new Map();
      for (const a of slow) {
        const r = Math.floor(a.lat / cell), c = Math.floor(a.lon / cell);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          for (const b of grid.get(`${r + dr}:${c + dc}`) || []) {
            if (Number(b.mmsi) <= Number(a.mmsi)) continue;
            if (!transferPair(a, b)) continue;
            const d = km(a, b);
            if (d <= maxKm) together.set(`${a.mmsi}|${b.mmsi}`, { a, b, d });
          }
        }
      }
      for (const [key, v] of together) {
        const p = pairs.get(key) || { first: now };
        Object.assign(p, { last: now, a: v.a, b: v.b, d: v.d });
        pairs.set(key, p);
      }
      for (const [key, p] of pairs) if (now - p.last > 20 * MIN) pairs.delete(key); // short gaps are allowed
      const out = [];
      for (const p of pairs.values()) {
        const minutes = Math.round((now - p.first) / MIN);
        if (p.last !== now || minutes < minMinutes) continue;
        out.push({ minutes, distM: Math.round(p.d * 1000), a: shipSummary(p.a), b: shipSummary(p.b),
          lat: (p.a.lat + p.b.lat) / 2, lon: (p.a.lon + p.b.lon) / 2 });
      }
      return out;
    },
  };
}

// Only ships MOVING slowly along a cable count (the anchor-dragging pattern). Anchored ships
// were tried and dropped: published cable routes are only accurate to several hundred metres,
// so "anchored within 1 km of a cable" mostly flagged ordinary anchorages.
export function createCableWatch({ maxKm = 1, minKn = 0.5, maxKn = 7, minMinutes = 30, minPortKm = 15, recentMin = 15, gapMin = 10 } = {}) {
  const state = new Map(); // mmsi -> { since, last, startLat, startLon, ship, cable, cableKm }
  return {
    update(ships, now, cableIndex, portIndex) {
      for (const s of ships) {
        if (s.lat == null || now - s.seen > recentMin * MIN || (s.speed ?? 99) > maxKn || (s.speed ?? 0) < minKn || isService(s) || !validMmsi(s.mmsi)) continue;
        if (!commercial(s) || s.type === 30) continue; // fishing vessels work over cables all day
        if (nearPort(portIndex, s.lat, s.lon, minPortKm)) continue; // cables come ashore next to ports
        const c = nearestCable(cableIndex, s.lat, s.lon);
        if (!c || c.km > maxKm) continue;
        const st = state.get(s.mmsi) || { since: now, startLat: s.lat, startLon: s.lon };
        Object.assign(st, { last: now, ship: s, cable: c.name, cableKm: c.km });
        state.set(s.mmsi, st);
      }
      const out = [];
      for (const [mmsi, st] of state) {
        if (now - st.last > gapMin * MIN) { state.delete(mmsi); continue; }
        const minutes = Math.round((now - st.since) / MIN);
        if (st.last !== now || minutes < minMinutes) continue;
        const s = st.ship;
        out.push({ ...shipSummary(s), cable: st.cable, cableM: Math.round(st.cableKm * 1000), minutes,
          alongKm: round(km({ lat: st.startLat, lon: st.startLon }, s), 1), startLat: st.startLat, startLon: st.startLon,
          mode: (s.speed ?? 0) < 0.5 ? 'stopped' : 'moving' });
      }
      return out;
    },
  };
}

// ---------- flag (registry country) from the MMSI ----------
// The first three digits of a ship's MMSI are its Maritime Identification Digits (MID),
// assigned per country by the ITU. mids: { "636": ["LR", "LBR", "", "Liberia"], ... }
export function flagOf(mmsi, mids) {
  const m = String(mmsi || '');
  if (!validMmsi(m) || !mids) return null;
  const hit = mids[m.slice(0, 3)];
  return hit ? { code: hit[0], name: hit[3] } : null;
}

// Registries that public reporting (Lloyd's List, S&P Global, Windward) repeatedly links to the
// "shadow fleet" of tankers moving sanctioned oil. Only counted for tankers.
export const SHADOW_FLAGS = new Set(['GA', 'CM', 'KM', 'CK', 'SL', 'DJ', 'BJ', 'PW', 'TZ', 'MN']);

// ---------- ship risk score ----------
// A transparent 0-100 score: every point comes with a plain-language reason. It's a way to
// sort ships worth a closer look, not a verdict. events: [{ kind, time, ... }] from the ship log.
export function shipRisk(ship, events = [], { flag = null, now = Date.now(), days = 7 } = {}) {
  const reasons = [];
  const add = (points, text) => reasons.push({ points, text });
  const recent = events.filter(e => now - e.time <= days * 24 * 60 * MIN);
  const count = kind => recent.filter(e => e.kind === kind).length;

  if (ship.sanc?.by === 'IMO') add(60, `On the US sanctions list (${(ship.sanc.programs || []).join(', ') || 'OFAC'}), matched by IMO number`);
  else if (ship.sanc) add(35, 'On the US sanctions list, matched by MMSI only (MMSIs get reused, so check the IMO)');

  if (count('clone')) add(30, 'Another ship was broadcasting the same IMO number far away');
  const ids = recent.filter(e => e.kind === 'identity');
  if (ids.some(e => e.field === 'IMO')) add(30, 'Changed its IMO number, which should never change');
  else if (ids.length) add(10, `Changed its name at sea${ids.length > 1 ? ` (${ids.length} times)` : ''}`);

  const sts = recent.filter(e => e.kind === 'sts');
  if (sts.length) add(Math.min(40, 20 * sts.length), `${sts.length} ship-to-ship transfer${sts.length > 1 ? 's' : ''} away from port in the last ${days} days`);
  if (sts.some(e => e.partnerSanctioned)) add(20, 'Transferred cargo with a sanctioned ship');

  const darkHigh = recent.filter(e => e.kind === 'dark' && e.confidence === 'high').length;
  const darkLow = recent.filter(e => e.kind === 'dark' && e.confidence !== 'high').length;
  if (darkHigh) add(Math.min(30, 15 * darkHigh), `Went silent ${darkHigh} time${darkHigh > 1 ? 's' : ''} while ships nearby kept transmitting`);
  if (darkLow) add(Math.min(10, 5 * darkLow), `Went silent ${darkLow} time${darkLow > 1 ? 's' : ''} (possibly just out of range)`);

  if (count('cable')) add(15, 'Loitered slowly over an undersea cable');
  if (count('jump')) add(10, 'Reported impossible position jumps (shared MMSI or faked position)');

  if (flag && SHADOW_FLAGS.has(flag.code) && isTanker(ship)) add(10, `Tanker flagged in ${flag.name}, a registry often linked to the shadow fleet`);
  if ((ship.length || 0) >= 100 && !validImo(ship.imo)) add(5, 'Large ship not broadcasting an IMO number');

  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  return { score, level: score >= 50 ? 'high' : score >= 20 ? 'elevated' : 'low', reasons: reasons.sort((a, b) => b.points - a.points) };
}

// ---------- chokepoints ----------
// A line across each strait or canal. A ship's track crossing the line is one transit; which
// side it came from gives the direction. Lines are [lon, lat] pairs, drawn across the shipping lane.
export const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', line: [[56.42, 26.25], [56.42, 26.98]], dirs: ['into the Gulf', 'out of the Gulf'], note: 'About a fifth of the world\'s oil passes here' },
  { id: 'bab', name: 'Bab-el-Mandeb', line: [[43.05, 12.6], [43.55, 12.6]], dirs: ['southbound (to the Gulf of Aden)', 'northbound (into the Red Sea)'], note: 'Red Sea route to Suez' },
  { id: 'suez', name: 'Suez Canal', line: [[32.2, 30.58], [32.45, 30.58]], dirs: ['southbound', 'northbound'], note: 'Europe-Asia shortcut' },
  { id: 'panama', name: 'Panama Canal', line: [[-79.78, 9.12], [-79.6, 9.12]], dirs: ['southbound (to the Pacific)', 'northbound (to the Atlantic)'], note: 'Atlantic-Pacific shortcut' },
  { id: 'singapore', name: 'Singapore Strait', line: [[104.4, 1.12], [104.4, 1.5]], dirs: ['westbound (to Malacca)', 'eastbound (to the South China Sea)'], note: 'Busiest shipping lane in Asia' },
  { id: 'bosporus', name: 'Bosporus', line: [[28.98, 41.1], [29.12, 41.1]], dirs: ['southbound (to the Mediterranean)', 'northbound (to the Black Sea)'], note: 'Only sea route out of the Black Sea' },
  { id: 'gibraltar', name: 'Strait of Gibraltar', line: [[-5.6, 35.82], [-5.6, 36.12]], dirs: ['eastbound (into the Mediterranean)', 'westbound (to the Atlantic)'], note: 'Mediterranean-Atlantic gateway' },
  { id: 'dover', name: 'Dover Strait', line: [[1.33, 51.12], [1.85, 50.96]], dirs: ['southwest-bound', 'northeast-bound'], note: 'Busiest strait in the world by traffic' },
  { id: 'skagen', name: 'Skagen (Baltic exit)', line: [[10.75, 57.75], [10.75, 58.35]], dirs: ['into the Baltic', 'out of the Baltic'], note: 'Route of Russian oil from Baltic ports' },
  { id: 'taiwan', name: 'Taiwan Strait', line: [[118.6, 24.5], [120.4, 24.5]], dirs: ['southbound', 'northbound'], note: 'Main route along the China coast' },
  { id: 'goodhope', name: 'Cape of Good Hope', line: [[20.0, -34.85], [20.0, -37.0]], dirs: ['eastbound (to the Indian Ocean)', 'westbound (to the Atlantic)'], note: 'Detour when the Red Sea is avoided' },
];

// Which side of the line a point is on (sign of the cross product).
const side = ([[x1, y1], [x2, y2]], [x, y]) => Math.sign((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1));

// Did the move from a to b cross the gate line? Returns 0 or 1 (the direction), or -1 for no.
export function crossedGate(line, a, b) {
  const p = [a.lon, a.lat], q = [b.lon, b.lat];
  const s1 = side(line, p), s2 = side(line, q);
  if (!s1 || !s2 || s1 === s2) return -1;
  const segLine = [p, q];
  if (side(segLine, line[0]) === side(segLine, line[1])) return -1; // crossed the line's extension, not the line
  return s1 > 0 ? 0 : 1;
}

const vesselClass = s => (isTanker(s) ? 'tanker' : s.type >= 70 && s.type < 80 ? 'cargo' : 'other');
const dayKey = t => new Date(t).toISOString().slice(0, 10);

// Counts transits per chokepoint per day (by class and direction). state is plain JSON so
// it can be saved to disk and survive restarts.
export function createChokepointCounter(state = {}) {
  const st = { days: state.days || {}, recent: state.recent || [], since: state.since || Date.now() };
  const lastCross = new Map(); // `${gate}:${mmsi}` -> time, to ignore back-and-forth jitter
  return {
    state: st,
    // Call with a ship's previous and new position. Returns the transits it made (usually none).
    record(ship, prev, cur, now = cur.t || Date.now()) {
      if (prev?.lat == null || cur?.lat == null) return [];
      if (Math.abs(cur.lon - prev.lon) > 5 || Math.abs(cur.lat - prev.lat) > 5) return []; // a jump, not a voyage
      const out = [];
      for (const g of CHOKEPOINTS) {
        const dir = crossedGate(g.line, prev, cur);
        if (dir < 0) continue;
        const key = `${g.id}:${ship.mmsi}`;
        if (now - (lastCross.get(key) || 0) < 30 * MIN) continue;
        lastCross.set(key, now);
        const cls = vesselClass(ship);
        const d = (st.days[dayKey(now)] ||= {});
        const c = (d[g.id] ||= { total: 0, tanker: 0, cargo: 0, other: 0, dir0: 0, dir1: 0 });
        c.total++; c[cls]++; c[`dir${dir}`]++;
        const t = { gate: g.id, mmsi: ship.mmsi, name: ship.name || '', cls, dir, time: now, sanc: Boolean(ship.sanc) };
        st.recent.push(t);
        out.push(t);
      }
      return out;
    },
    // Per chokepoint: last 24 h, today, the normal day (median of earlier full days) and a 14-day series.
    summary(now = Date.now(), { keepDays = 60 } = {}) {
      st.recent = st.recent.filter(t => now - t.time <= 24 * 60 * MIN);
      const today = dayKey(now);
      const allDays = Object.keys(st.days).sort();
      for (const d of allDays.slice(0, Math.max(0, allDays.length - keepDays))) delete st.days[d];
      const firstFull = dayKey(st.since + 24 * 60 * MIN); // the start day was partial
      const fullDays = Object.keys(st.days).filter(d => d < today && d >= firstFull).sort().slice(-30);
      const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
      return CHOKEPOINTS.map(g => {
        const last24 = st.recent.filter(t => t.gate === g.id);
        const normal = fullDays.length >= 3 ? median(fullDays.map(d => st.days[d][g.id]?.total || 0)) : null;
        const series = [];
        for (let i = 13; i >= 0; i--) { const d = dayKey(now - i * 24 * 60 * MIN); series.push({ day: d, total: st.days[d]?.[g.id]?.total ?? null }); }
        return {
          id: g.id, name: g.name, note: g.note, line: g.line, dirs: g.dirs,
          last24: last24.length, tankers24: last24.filter(t => t.cls === 'tanker').length,
          dir24: [last24.filter(t => t.dir === 0).length, last24.filter(t => t.dir === 1).length],
          sanctioned24: last24.filter(t => t.sanc).length,
          today: st.days[today]?.[g.id]?.total || 0,
          normal, vsNormal: normal ? Math.round(((last24.length - normal) / normal) * 100) : null,
          baselineDays: fullDays.length, series,
          latest: last24.slice(-8).reverse().map(t => ({ name: t.name, mmsi: t.mmsi, cls: t.cls, dir: g.dirs[t.dir], time: t.time, sanc: t.sanc })),
        };
      });
    },
  };
}
