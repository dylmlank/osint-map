import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as I from '../intel.js';

const ofac = readFileSync(new URL('./fixtures/ofac-sample.csv', import.meta.url), 'utf8');

test('OFAC list: ships, aircraft and their IDs are read, other entries skipped', () => {
  const { ships, aircraft } = I.parseOfacCsv(ofac);
  assert.equal(ships.length, 2);
  assert.equal(aircraft.length, 2);
  const tanker = ships.find(s => s.name === 'SHADOW TANKER');
  assert.deepEqual(tanker.imo, ['9187629']);
  assert.deepEqual(tanker.mmsi, ['626123456']);
  assert.deepEqual(tanker.programs, ['RUSSIA-EO14024', 'IRAN']);
  const mahan = aircraft.find(a => a.name === 'MAHAN AIR A340');
  assert.deepEqual(mahan.regs, ['EPMMB']); // from "Tail Number" in the remarks
  assert.equal(mahan.operator, 'MAHAN AIR');
});

test('sanctions matching: IMO beats MMSI, registrations ignore dashes and case', () => {
  const idx = I.buildSanctionsIndex(I.parseOfacCsv(ofac));
  assert.equal(I.matchShip(idx, { imo: 9187629, mmsi: 1 }).by, 'IMO');
  assert.equal(I.matchShip(idx, { mmsi: 626123456 }).by, 'MMSI');
  assert.equal(I.matchShip(idx, { imo: 1234567, mmsi: 111111111 }), null);
  assert.equal(I.matchAircraft(idx, 'ep-gol').model, 'IL-76TD');
  assert.equal(I.matchAircraft(idx, 'EP-MMB').operator, 'MAHAN AIR');
  assert.equal(I.matchAircraft(idx, 'N12345'), null);
  assert.equal(I.matchAircraft(null, 'EP-GOL'), null); // list not loaded yet
});

test('dark ships: confidence depends on whether nearby ships are still heard', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const min = 60000;
  const silentAlone = { mmsi: 1, lat: 10, lon: 10, speed: 12, course: 90, seen: now - 40 * min };
  const silentInCrowd = { mmsi: 2, lat: 50, lon: 2, speed: 10, course: 0, seen: now - 30 * min };
  const neighbors = [3, 4, 5].map(m => ({ mmsi: m, lat: 50.05, lon: 2.05, speed: 8, seen: now - 2 * min }));
  const moored = { mmsi: 6, lat: 50, lon: 2, speed: 0, seen: now - 60 * min };
  const tooRecent = { mmsi: 7, lat: 50, lon: 2, speed: 9, seen: now - 5 * min };
  const dark = I.findDarkShips([silentAlone, silentInCrowd, ...neighbors, moored, tooRecent], now);
  assert.deepEqual(dark.map(d => d.mmsi).sort(), [1, 2]);
  assert.equal(dark.find(d => d.mmsi === 1).confidence, 'low');
  assert.equal(dark.find(d => d.mmsi === 2).confidence, 'high');
  assert.equal(dark.find(d => d.mmsi === 2).neighbors, 4); // the 3 neighbours + the one heard 5 min ago
});

test('GPS jamming: only aircraft-broadcast ADS-B v2 positions count', () => {
  const plane = (hex, nacp, extra = {}) => ({ hex, lat: 55.2, lon: 20.3, alt: 30000, nacp, src: 'adsb_icao', ver: 2, ...extra });
  assert.equal(I.countsForJamming(plane('a', 9)), true);
  assert.equal(I.countsForJamming(plane('a', 0, { src: 'tisb_other' })), false);
  assert.equal(I.countsForJamming(plane('a', 0, { src: 'adsr_icao' })), false);
  assert.equal(I.countsForJamming(plane('a', 0, { ver: 0 })), false);
  assert.equal(I.countsForJamming(plane('a', 0, { alt: 'ground' })), false);
});

test('GPS jamming: levels need both a share and several aircraft', () => {
  assert.equal(I.jammingLevel({ pct: 40, bad: 2 }), 'normal'); // big share but only 2 planes
  assert.equal(I.jammingLevel({ pct: 15, bad: 3 }), 'high');
  assert.equal(I.jammingLevel({ pct: 7, bad: 4 }), 'medium');
  assert.equal(I.jammingLevel({ pct: 5, bad: 2 }), 'normal');  // 2 of 40 over SF Bay: everyday noise
  assert.equal(I.jammingLevel({ pct: 1, bad: 1 }), 'normal');
});

test('GPS jamming tracker: summarises cells and forgets old sightings', () => {
  const t = I.createJammingTracker({ cell: 1, windowMs: 60 * 60000, minAircraft: 5 });
  const now = Date.UTC(2026, 10, 5, 12);
  const planes = Array.from({ length: 10 }, (_, i) => ({ hex: `h${i}`, lat: 55.5, lon: 20.5, alt: 30000, nacp: i < 4 ? 3 : 10, src: 'adsb_icao', ver: 2 }));
  t.record(planes, now);
  t.record([{ hex: 'tisb', lat: 55.5, lon: 20.5, alt: 3000, nacp: 0, src: 'tisb_other' }], now); // ignored
  const [cell] = t.summary(now);
  assert.equal(cell.n, 10);
  assert.equal(cell.bad, 4);
  assert.equal(cell.pct, 40);
  assert.equal(cell.level, 'high');
  assert.deepEqual([cell.lat, cell.lon], [55, 20]);
  assert.deepEqual(t.summary(now + 2 * 60 * 60000), []); // an hour later it's all expired
});

test('inBox handles normal boxes, date-line boxes and "whole world"', () => {
  assert.equal(I.inBox([-120, 30, -110, 40], 35, -115), true);
  assert.equal(I.inBox([-120, 30, -110, 40], 35, -100), false);
  assert.equal(I.inBox([170, -20, -170, 0], -10, 179), true);  // crosses the date line
  assert.equal(I.inBox([170, -20, -170, 0], -10, -175), true);
  assert.equal(I.inBox([170, -20, -170, 0], -10, 0), false);
  assert.equal(I.inBox(null, 89, 179), true);
});

test('flight legs: multi-stop route picks the leg being flown and flags mismatches', () => {
  const BOS = { code: 'BOS', lat: 42.36, lon: -71.0 }, SFO = { code: 'SFO', lat: 37.62, lon: -122.38 }, SNA = { code: 'SNA', lat: 33.68, lon: -117.87 };
  // Between SFO and SNA heading south-east: the SFO-SNA leg, plausible.
  const leg = I.pickLeg([BOS, SFO, SNA], { lat: 35.9, lon: -120.5 }, null, 130);
  assert.equal(`${leg.from.code}-${leg.to.code}`, 'SFO-SNA');
  assert.equal(leg.plausible, true);
  assert.deepEqual(leg.stops, ['BOS', 'SFO', 'SNA']);
  // Same spot but flying north-west (the return flight): flagged as not matching.
  assert.equal(I.pickLeg([SFO, SNA], { lat: 35.9, lon: -120.5 }, null, 310).plausible, false);
  // Takeoff point decides the leg when we saw it leave the ground.
  assert.equal(I.pickLeg([BOS, SFO, SNA], { lat: 40, lon: -100 }, { lat: 42.37, lon: -71.01 }, 270).from.code, 'BOS');
  assert.equal(I.pickLeg([SFO], { lat: 0, lon: 0 }), null);
});

test('news: titles come from link slugs, categories from CAMEO codes, votes pick the category', () => {
  assert.equal(I.titleFromUrl('https://www.cbc.ca/news/canada/north/repatriation-legislation-tabled-nwt-9.7410624'), 'Repatriation legislation tabled nwt');
  assert.equal(I.titleFromUrl('https://example.com/123456'), 'example.com');
  assert.equal(I.newsCategory(19), 'violence');
  assert.equal(I.newsCategory(14), 'protest');
  assert.equal(I.newsCategory(16), 'tension');
  assert.equal(I.newsCategory(4), 'other');

  const row = (root, mentions) => {
    const c = Array(61).fill('');
    Object.assign(c, { 28: String(root), 31: String(mentions), 34: '-2.5', 52: 'Kyiv, Ukraine', 56: '50.45', 57: '30.52', 60: 'https://news.example/story-about-talks-today' });
    return c.join('\t');
  };
  const stories = new Map();
  for (const line of [row(19, 3), row(4, 1), row(4, 2), row(4, 1), '', 'garbage']) I.addGdeltRow(stories, line, 1000);
  const s = stories.get('https://news.example/story-about-talks-today');
  assert.equal(stories.size, 1);
  assert.equal(s.cat, 'other');      // 3 "other" votes beat 1 "violence"
  assert.equal(s.mentions, 3);       // place/details come from the most-mentioned row
  assert.equal(s.place, 'Kyiv, Ukraine');
});
