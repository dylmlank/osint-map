import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../intel.js';

const MIN = 60000, DAY = 24 * 60 * MIN;
const now = Date.UTC(2026, 10, 6, 12);
const mids = { 636: ['LR', 'LBR', '', 'Liberia'], 626: ['GA', 'GAB', '', 'Gabonese Republic'], 244: ['NL', 'NLD', '', 'Netherlands'] };

test('flag from MMSI', () => {
  assert.deepEqual(I.flagOf(636012345, mids), { code: 'LR', name: 'Liberia' });
  assert.equal(I.flagOf(999999999, mids), null);   // placeholder MMSI
  assert.equal(I.flagOf(301000001, mids), null);   // MID not in the table
  assert.equal(I.flagOf(636012345, null), null);   // table not loaded yet
});

test('risk: a clean ship scores low with no reasons', () => {
  const r = I.shipRisk({ mmsi: 244000001, type: 70, length: 120, imo: 9187629 }, [], { flag: { code: 'NL', name: 'Netherlands' }, now });
  assert.equal(r.score, 0);
  assert.equal(r.level, 'low');
  assert.deepEqual(r.reasons, []);
});

test('risk: sanctioned shadow-fleet tanker with transfers and dark periods scores high, with reasons', () => {
  const tanker = { mmsi: 626000001, type: 80, length: 240, imo: 9187629, sanc: { by: 'IMO', programs: ['RUSSIA-EO14024'] } };
  const events = [
    { kind: 'sts', time: now - DAY, partnerSanctioned: true },
    { kind: 'dark', time: now - 2 * DAY, confidence: 'high' },
    { kind: 'dark', time: now - 3 * DAY, confidence: 'high' },
    { kind: 'dark', time: now - 20 * DAY, confidence: 'high' }, // outside the 7-day window
  ];
  const r = I.shipRisk(tanker, events, { flag: { code: 'GA', name: 'Gabonese Republic' }, now });
  assert.equal(r.score, 100); // capped
  assert.equal(r.level, 'high');
  const texts = r.reasons.map(x => x.text).join(' | ');
  assert.match(texts, /sanctions list.*IMO/);
  assert.match(texts, /1 ship-to-ship transfer/);
  assert.match(texts, /sanctioned ship/);
  assert.match(texts, /silent 2 times/);
  assert.match(texts, /Gabonese Republic/);
  assert.ok(r.reasons[0].points >= r.reasons.at(-1).points, 'biggest reasons first');
});

test('risk: smaller signals add up to "elevated", flag only counts for tankers', () => {
  const cargo = { mmsi: 626000002, type: 70, length: 150, imo: null };
  const r = I.shipRisk(cargo, [{ kind: 'identity', field: 'name', time: now - DAY }, { kind: 'jump', time: now - DAY }], { flag: { code: 'GA', name: 'Gabon' }, now });
  assert.equal(r.score, 25); // name change 10 + jump 10 + large ship without IMO 5; no flag points (not a tanker)
  assert.equal(r.level, 'elevated');
});

const dover = I.CHOKEPOINTS.find(g => g.id === 'dover');
const bab = I.CHOKEPOINTS.find(g => g.id === 'bab');

test('gates: crossing the line counts, passing beside it does not', () => {
  assert.equal(I.crossedGate(bab.line, { lat: 12.7, lon: 43.3 }, { lat: 12.5, lon: 43.3 }), 0);   // southbound
  assert.equal(I.crossedGate(bab.line, { lat: 12.5, lon: 43.3 }, { lat: 12.7, lon: 43.3 }), 1);   // northbound
  assert.equal(I.crossedGate(bab.line, { lat: 12.7, lon: 44.0 }, { lat: 12.5, lon: 44.0 }), -1);  // east of the line's end
  assert.equal(I.crossedGate(bab.line, { lat: 12.7, lon: 43.3 }, { lat: 12.65, lon: 43.3 }), -1); // didn't reach it
  assert.notEqual(I.crossedGate(dover.line, { lat: 51.2, lon: 1.7 }, { lat: 50.9, lon: 1.4 }), -1); // diagonal line
});

test('chokepoint counter: counts by class and direction, ignores jitter and jumps', () => {
  const c = I.createChokepointCounter({ since: now - 10 * DAY });
  const tanker = { mmsi: 211000001, type: 80, name: 'TANKER A' };
  const north = { lat: 12.7, lon: 43.3 }, south = { lat: 12.5, lon: 43.3 };
  assert.equal(c.record(tanker, { ...north, t: now - 10 * MIN }, { ...south, t: now }, now).length, 1);
  assert.equal(c.record(tanker, south, north, now + 5 * MIN).length, 0, 'crossing back within 30 min is jitter');
  assert.equal(c.record({ mmsi: 211000002, type: 70 }, north, south, now).length, 1);
  assert.equal(c.record({ mmsi: 211000003, type: 70 }, { lat: 20, lon: 43.3 }, south, now).length, 0, 'a 7-degree jump is not a voyage');
  const s = c.summary(now + 6 * MIN).find(g => g.id === 'bab');
  assert.equal(s.last24, 2);
  assert.equal(s.tankers24, 1);
  assert.deepEqual(s.dir24, [2, 0]);
  assert.equal(s.normal, null, 'no normal yet without 3 full days of data');
});

test('chokepoint counter: "normal" is the median of earlier full days, and survives a restart', () => {
  const days = {};
  const key = t => new Date(t).toISOString().slice(0, 10);
  [40, 50, 60, 55, 45].forEach((n, i) => { days[key(now - (i + 1) * DAY)] = { suez: { total: n, tanker: 0, cargo: n, other: 0, dir0: n, dir1: 0 } }; });
  const c = I.createChokepointCounter({ days, since: now - 10 * DAY });
  for (let i = 0; i < 25; i++) c.record({ mmsi: 211000100 + i, type: 70 }, { lat: 30.7, lon: 32.33 }, { lat: 30.5, lon: 32.33 }, now);
  const s = c.summary(now).find(g => g.id === 'suez');
  assert.equal(s.normal, 50);
  assert.equal(s.last24, 25);
  assert.equal(s.vsNormal, -50);
  assert.equal(s.series.length, 14);
  const restored = I.createChokepointCounter(JSON.parse(JSON.stringify(c.state)));
  assert.equal(restored.summary(now).find(g => g.id === 'suez').last24, 25);
});
