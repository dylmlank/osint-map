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
