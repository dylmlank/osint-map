import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../feeds.js';
import * as fx from './fixtures/cameras.js';

test('camera parsers turn every agency format into the same shape', () => {
  const cases = {
    California: fx.california, 'British Columbia': fx.drivebc, London: fx.tfl, 'Hong Kong': fx.hongKong,
    Finland: fx.finland, 'New Zealand': fx.newZealand, Singapore: fx.singapore,
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(F.CAMERA_PARSERS).sort(), 'every source has a test sample');
  for (const [name, raw] of Object.entries(cases)) {
    const cams = F.CAMERA_PARSERS[name](raw);
    assert.ok(cams.length > 0, `${name}: parsed something`);
    for (const c of cams.filter(x => x.on !== false)) { // out-of-service cameras are dropped by cameras()
      assert.ok(c.name, `${name}: name`);
      assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `${name}: coordinates are numbers`);
      assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180, `${name}: coordinates in range`);
      assert.match(c.image, /^https:\/\//, `${name}: image link`);
      assert.ok(c.source, `${name}: source`);
    }
  }
});

test('camera parsers keep the details that matter', () => {
  const [la, broken] = F.CAMERA_PARSERS.California(fx.california);
  assert.equal(la.videoType, 'hls');
  assert.equal(broken.on, false); // out-of-service cameras are marked so cameras() drops them

  const [hk] = F.CAMERA_PARSERS['Hong Kong'](fx.hongKong);
  assert.equal(hk.name, 'Aberdeen Praya Road near Fish Market'); // "[H429F]" code removed
  assert.equal(hk.place, 'Southern, Hong Kong Island');

  const [fi] = F.CAMERA_PARSERS.Finland(fx.finland);
  assert.equal(fi.name, 'Inkoo');
  assert.equal(fi.route, 'Road 51');
  assert.equal(fi.views.length, 2); // the preset not in collection is skipped

  const [nz] = F.CAMERA_PARSERS['New Zealand'](fx.newZealand);
  assert.equal(nz.lat, -43.919632); // the camera's own position, not the journey start
  assert.equal(nz.place, 'Canterbury');

  const [ldn] = F.CAMERA_PARSERS.London(fx.tfl);
  assert.equal(ldn.videoType, 'mp4');
  assert.equal(ldn.route, 'facing West');
});

test('flights: emergency and military flags, GPS accuracy kept for the jamming map', () => {
  const f = F.slimFlight({ hex: 'abc123', flight: 'TEST1  ', r: 'N1', t: 'B738', lat: 1, lon: 2, alt_baro: 30000, gs: 450, track: 90, squawk: '7700', dbFlags: 1, nac_p: 9, type: 'adsb_icao', version: 2 });
  assert.equal(f.call, 'TEST1');
  assert.equal(f.emergency, true);
  assert.equal(f.mil, true);
  assert.equal(f.nacp, 9);
  assert.equal(f.src, 'adsb_icao');
  const quiet = F.slimFlight({ hex: 'def456', lat: 1, lon: 2, squawk: '1200' });
  assert.equal(quiet.emergency, false);
  assert.equal(quiet.mil, false);
  assert.equal(quiet.nacp, null);
});

test('satellite orbit data: three-line entries are read, broken ones skipped', () => {
  const sats = F.parseTle(fx.issTle, 'stations');
  assert.equal(sats.length, 1);
  assert.equal(sats[0].name, 'ISS (ZARYA)');
  assert.ok(sats[0].l1.startsWith('1 25544'));
  assert.ok(sats[0].l2.startsWith('2 25544'));
});

test('xml helpers', () => {
  assert.deepEqual(F.xmlItems('<a><b>1</b></a><a><b>2</b></a>', 'a'), ['<b>1</b>', '<b>2</b>']);
  assert.equal(F.xmlField('<b> x </b>', 'b'), 'x');
  assert.equal(F.xmlField('<b></b>', 'missing'), '');
});
