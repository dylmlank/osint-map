import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory, floorIndex } from '../history.js';

test('floorIndex finds the last time at or before t', () => {
  const times = [10, 20, 30];
  assert.equal(floorIndex(times, 5), -1);
  assert.equal(floorIndex(times, 10), 0);
  assert.equal(floorIndex(times, 25), 1);
  assert.equal(floorIndex(times, 99), 2);
  assert.equal(floorIndex([], 5), -1);
});

test('history saves snapshots, serves before/after pairs, filters, and survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osint-history-'));
  try {
    let n = 0;
    const sources = { flights: { every: 1e9, collect: () => [['abc', 'T1', 10 + n, 20, 30000, 90, 450, 0, 'B738'], ['def', 'T2', 50, 50, -1, 0, 0, 1, 'C17']] } };
    const h = createHistory({ dir, sources, autoRecord: false });
    h.record('flights');
    await new Promise(r => setTimeout(r, 5));
    n = 1;
    h.record('flights');
    const [t1, t2] = h.list().flights;
    assert.ok(t2 > t1);

    const mid = h.at('flights', t1 + 1);
    assert.equal(mid.before.t, t1);
    assert.equal(mid.after.t, t2);
    assert.equal(mid.before.rows[0][2], 10);
    assert.equal(mid.after.rows[0][2], 11);

    assert.equal(h.at('flights', t1 - 1000).before, null); // before the recording started
    const filtered = h.at('flights', t2, row => row[0] === 'def');
    assert.equal(filtered.before.rows.length, 1);

    // A new instance (server restart) picks up what's on disk.
    const again = createHistory({ dir, sources, autoRecord: false });
    assert.deepEqual(again.list().flights, [t1, t2]);
    assert.throws(() => again.at('nope', 0), /no history/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history deletes snapshots older than the keep window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osint-history-'));
  try {
    const h = createHistory({ dir, keepMs: -1, sources: { ships: { every: 1e9, collect: () => [[1, 'A', 0, 0, 0, 0, 0, 0]] } }, autoRecord: false });
    h.record('ships'); // keepMs < 0: anything older than "now + 1 ms" goes, including this one
    h.record('ships');
    assert.ok(h.list().ships.length <= 1);
    assert.ok(readdirSync(join(dir, 'ships')).length <= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
