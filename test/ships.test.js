import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../intel.js';

const MIN = 60000;
const now = Date.UTC(2026, 10, 6, 12);
const ship = (mmsi, lat, lon, extra = {}) => ({ mmsi, lat, lon, speed: 0.3, course: 90, type: 80, length: 180, seen: now - MIN, name: `SHIP ${mmsi}`, ...extra });
const ports = I.buildPortIndex([{ name: 'Rotterdam', lat: 51.95, lon: 4.14 }]);

test('ports: nearest port and distance', () => {
  const p = I.nearestPort(ports, 51.9, 4.1);
  assert.equal(p.name, 'Rotterdam');
  assert.ok(p.km < 10);
  assert.equal(I.nearestPort(ports, 10, 10), null); // nothing within the search area
});

test('ship-to-ship: a tanker pair side by side offshore for an hour is flagged', () => {
  const sts = I.createStsTracker();
  const pair = () => [ship(211000001, 36.40, 22.90), ship(211000002, 36.4015, 22.9005)];
  assert.deepEqual(sts.update(pair(), now - 70 * MIN, ports), []); // first sighting: too early to say
  const [hit] = sts.update(pair(), now, ports);
  assert.ok(hit, 'flagged after 70 minutes together');
  assert.equal(hit.minutes, 70);
  assert.ok(hit.distM < 500);
  assert.deepEqual([hit.a.mmsi, hit.b.mmsi].sort(), [211000001, 211000002]);
});

test('ship-to-ship: ignores ships in port, moving ships, small craft and tugs', () => {
  const cases = {
    'next to a port': [ship(211000001, 51.95, 4.15), ship(211000002, 51.951, 4.151)],
    'one is moving': [ship(211000001, 36.4, 22.9), ship(211000002, 36.401, 22.9, { speed: 9 })],
    'two small boats': [ship(211000001, 36.4, 22.9, { type: 30, length: 20 }), ship(211000002, 36.401, 22.9, { type: 30, length: 20 })],
    'tanker with a tug': [ship(211000001, 36.4, 22.9), ship(211000002, 36.401, 22.9, { type: 52, length: 30 })],
    'two river tank barges': [ship(211000001, 36.4, 22.9, { length: 110 }), ship(211000002, 36.401, 22.9, { length: 110 })],
    'two cargo ships, no tanker': [ship(211000001, 36.4, 22.9, { type: 70 }), ship(211000002, 36.401, 22.9, { type: 70 })],
    'too far apart': [ship(211000001, 36.4, 22.9), ship(211000002, 36.42, 22.9)],
  };
  for (const [name, ships] of Object.entries(cases)) {
    const sts = I.createStsTracker();
    sts.update(ships, now - 90 * MIN, ports);
    assert.deepEqual(sts.update(ships, now, ports), [], name);
  }
});

test('ship-to-ship: a short gap is forgiven, a long one starts over', () => {
  const pair = [ship(211000001, 36.4, 22.9), ship(211000002, 36.4012, 22.9)];
  const run = gapMinutes => {
    const sts = I.createStsTracker();
    let last = [];
    for (let m = 80; m >= 0; m -= 5) { // checked every 5 minutes, like the server (it checks every minute)
      const inGap = m <= 40 && m > 40 - gapMinutes;
      last = sts.update(inGap ? [] : pair, now - m * MIN, ports);
    }
    return last;
  };
  assert.equal(run(10).length, 1, '10 minutes of missed reports are forgiven');
  assert.deepEqual(run(30), [], 'apart for 30 minutes: the clock restarts');
});

const cables = I.buildCableIndex({ type: 'FeatureCollection', features: [
  { properties: { name: 'Balticconnector' }, geometry: { type: 'MultiLineString', coordinates: [[[24.0, 59.6], [24.4, 59.9]]] } },
] });

test('cables: distance from a ship to the nearest cable', () => {
  const on = I.nearestCable(cables, 59.75, 24.2);
  assert.equal(on.name, 'Balticconnector');
  assert.ok(on.km < 1);
  assert.ok(I.nearestCable(cables, 59.75, 24.6).km > 10);
  assert.equal(I.nearestCable(cables, 0, 0), null);
});

test('cables: slow ship along a cable for 30+ minutes is flagged, a normal crossing is not', () => {
  const watch = I.createCableWatch();
  // moves along the cable line (59.6,24.0)->(59.9,24.4) at 3 kn
  const dragger = t => ship(230000001, 59.70 + t * 0.002, 24.1333 + t * 0.00267, { speed: 3, type: 70, seen: now - (40 - t) * MIN });
  for (let t = 0; t <= 40; t += 5) watch.update([dragger(t)], now - (40 - t) * MIN, cables, ports);
  const [hit] = watch.update([dragger(40)], now, cables, ports);
  assert.ok(hit, 'flagged');
  assert.equal(hit.cable, 'Balticconnector');
  assert.ok(hit.minutes >= 40);
  assert.equal(hit.mode, 'moving');

  const fishing = I.createCableWatch(); // small fishing boats work over coastal cables all day
  const boat = t => ship(230000003, 59.70 + t * 0.002, 24.1333 + t * 0.00267, { speed: 3, type: 30, length: 15, seen: now - (40 - t) * MIN });
  for (let t = 0; t <= 40; t += 5) fishing.update([boat(t)], now - (40 - t) * MIN, cables, ports);
  assert.deepEqual(fishing.update([boat(40)], now, cables, ports), []);

  const anchored = I.createCableWatch(); // anchored near a cable: cable maps are too rough to tell, so not flagged
  for (let t = 0; t <= 40; t += 5) anchored.update([ship(230000004, 59.75, 24.2, { speed: 0, type: 70, length: 200 })], now - (40 - t) * MIN, cables, ports);
  assert.deepEqual(anchored.update([ship(230000004, 59.75, 24.2, { speed: 0, type: 70, length: 200 })], now, cables, ports), []);

  const fast = I.createCableWatch(); // a ship crossing at speed is never "slow over the cable"
  for (let t = 0; t <= 40; t += 5) fast.update([ship(230000002, 59.75, 24.2, { speed: 14 })], now - (40 - t) * MIN, cables, ports);
  assert.deepEqual(fast.update([ship(230000002, 59.75, 24.2, { speed: 14 })], now, cables, ports), []);
});

test('impossible jumps: flags teleporting positions, not normal sailing', () => {
  const t0 = now - 10 * MIN;
  assert.ok(I.checkJump({ lat: 50, lon: 0, t: t0 }, { lat: 51, lon: 1, t: now, speed: 12 })); // ~130 km in 10 min
  assert.equal(I.checkJump({ lat: 50, lon: 0, t: t0 }, { lat: 50.05, lon: 0, t: now, speed: 12 }), null); // 5.5 km: fine
  assert.equal(I.checkJump({ lat: 50, lon: 0, t: now - 3 * 3600000 }, { lat: 50.6, lon: 0, t: now, speed: 12 }), null); // 67 km in 3 h: fine
  assert.equal(I.checkJump(null, { lat: 1, lon: 1, t: now }), null);
  // Seen live: same latitude, longitude briefly read as ~0. A glitch, not a fake position.
  assert.equal(I.checkJump({ lat: 52.3631, lon: 4.8586, t: t0 }, { lat: 52.3631, lon: 0.0074, t: now, speed: 0 }), null);
  assert.equal(I.checkJump({ lat: 0.02, lon: 4.85, t: t0 }, { lat: 52.1, lon: 4.85, t: now, speed: 0 }), null);
  assert.equal(I.checkJump({ lat: 52.38221, lon: 4.85907, t: t0 }, { lat: 52.38264, lon: 0.00728, t: now }), null); // same glitch, tiny lat change
  // More garbled data seen in a 40-minute live run:
  assert.equal(I.checkJump({ lat: 40.774, lon: 14.053, t: t0 }, { lat: 0.773, lon: 14.075, t: now }), null);     // dropped digit
  assert.equal(I.checkJump({ lat: 47.645, lon: 122.310, t: t0 }, { lat: 47.645, lon: -122.310, t: now }), null); // flipped sign
  assert.equal(I.checkJump({ lat: -86.948, lon: 110.420, t: t0 }, { lat: -6.948, lon: 110.421, t: now }), null); // near the pole
  assert.equal(I.checkJump({ lat: 37.464, lon: 126.593, t: t0 }, { lat: -1.754, lon: -2.115, t: now }), null);  // to near 0,0
  // ...and ones worth reporting: both coordinates move to another real stretch of sea.
  assert.ok(I.checkJump({ lat: 55.742, lon: 20.946, t: now - 6 * MIN }, { lat: 55.911, lon: 15.704, t: now })); // near Kaliningrad, 328 km in 6 min
  assert.ok(I.checkJump({ lat: 26.072, lon: -80.115, t: now - 4 * MIN }, { lat: 36.042, lon: -74.711, t: now }));
});

test('identity: IMO and name changes, ignoring blanks and spacing', () => {
  assert.deepEqual(I.identityChange({ name: 'OCEAN STAR', imo: 9187629 }, { name: 'OCEAN STAR', imo: 9300001 }), { field: 'IMO', from: '9187629', to: '9300001' });
  assert.equal(I.identityChange({ name: 'OCEAN STAR' }, { name: 'NEW DAWN' }).field, 'name');
  assert.equal(I.identityChange({ name: 'OCEAN  STAR' }, { name: 'OCEAN STAR' }), null);
  assert.equal(I.identityChange({ name: '' }, { name: 'OCEAN STAR' }), null);
  assert.equal(I.identityChange(null, { name: 'X' }), null);
  // radio garbage seen live is ignored
  assert.equal(I.identityChange({ name: 'MSC P@@H.P@@II' }, { name: 'MSC PAMIRA III' }), null);
  assert.equal(I.identityChange({ name: 'BOSHIHANG8' }, { name: 'BOSHIHANG8@ 8' }), null);
  assert.equal(I.identityChange({ name: 'WWW.FURUNO.SE' }, { name: 'FURUNO SVERIGE AB' }), null);
  assert.equal(I.identityChange({ name: 'NORDIC STAR' }, { name: 'NORDIC STAR 2' }), null); // padded, same name
  assert.equal(I.identityChange({ name: 'S_ANNA' }, { name: 'TPS ALPHA' }).field, 'name'); // a real rename
});

test('shared IMO: two ships far apart with the same IMO are flagged', () => {
  const twins = [ship(211000001, 36.4, 22.9, { imo: 9187629, seen: now }), ship(636000002, 25.0, 55.0, { imo: 9187629, seen: now })];
  const [hit] = I.findSharedImo(twins, now);
  assert.equal(hit.imo, '9187629');
  assert.ok(hit.km > 1000);
  const neighbours = [ship(211000001, 36.4, 22.9, { imo: 9187629, seen: now }), ship(211000003, 36.41, 22.9, { imo: 9187629, seen: now })];
  assert.deepEqual(I.findSharedImo(neighbours, now), []); // same place: likely one ship with two transponders
  assert.deepEqual(I.findSharedImo([ship(1, 0, 0, { imo: 1234567, seen: now }), ship(2, 40, 40, { imo: 1234567, seen: now })], now), []); // placeholder IMO
});

test('MMSI and IMO sanity checks', () => {
  assert.equal(I.validMmsi(211000001), true);
  assert.equal(I.validMmsi(111111111), false);
  assert.equal(I.validMmsi(123456789), false);
  assert.equal(I.validMmsi(200000000), false); // placeholder seen live
  assert.equal(I.validMmsi(244032287), true);
  assert.equal(I.validMmsi(1234), false);
  assert.equal(I.validImo(9187629), true);
  assert.equal(I.validImo(0), false);
});
