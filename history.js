// Timeline recorder: saves compact, gzipped snapshots to data/history/<kind>/<time>.json.gz
// and serves the snapshot nearest any moment in the last 24 hours.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

// Find the last time <= t in a sorted list (binary search). Returns -1 if none.
export function floorIndex(times, t) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function createHistory({ dir, keepMs = 24 * 60 * 60 * 1000, sources, autoRecord = true }) {
  const times = {};      // kind -> sorted snapshot times
  const memo = new Map(); // recent decoded snapshots: `${kind}/${t}` -> rows

  for (const kind of Object.keys(sources)) {
    const folder = join(dir, kind);
    mkdirSync(folder, { recursive: true });
    times[kind] = readdirSync(folder).map(f => Number(f.split('.')[0])).filter(Number.isFinite).sort((a, b) => a - b);
  }

  function prune(kind, now) {
    while (times[kind].length && times[kind][0] < now - keepMs) {
      const t = times[kind].shift();
      try { unlinkSync(join(dir, kind, `${t}.json.gz`)); } catch { /* already gone */ }
      memo.delete(`${kind}/${t}`);
    }
  }

  function record(kind) {
    const rows = sources[kind].collect();
    if (!rows.length) return;
    const t = Date.now();
    writeFileSync(join(dir, kind, `${t}.json.gz`), zlib.gzipSync(JSON.stringify(rows)));
    times[kind].push(t);
    prune(kind, t);
  }

  if (autoRecord) for (const [kind, src] of Object.entries(sources)) {
    setTimeout(() => record(kind), src.firstAfter ?? 30000).unref(); // let feeds warm up first
    setInterval(() => record(kind), src.every).unref();
  }

  function load(kind, t) {
    const key = `${kind}/${t}`;
    if (!memo.has(key)) {
      const file = join(dir, kind, `${t}.json.gz`);
      if (!existsSync(file)) return null;
      memo.set(key, JSON.parse(zlib.gunzipSync(readFileSync(file))));
      if (memo.size > 30) memo.delete(memo.keys().next().value);
    }
    return memo.get(key);
  }

  return {
    record,
    list: () => Object.fromEntries(Object.entries(times).map(([k, v]) => [k, v])),
    // The snapshot at or before t, plus the one after it (for smooth in-between positions).
    at(kind, t, filter) {
      const list = times[kind];
      if (!list) throw new Error(`no history for ${kind}`);
      const i = floorIndex(list, t);
      const pick = j => {
        if (j < 0 || j >= list.length) return null;
        const rows = load(kind, list[j]);
        return rows && { t: list[j], rows: filter ? rows.filter(filter) : rows };
      };
      return { before: pick(i), after: pick(i + 1) };
    },
  };
}
