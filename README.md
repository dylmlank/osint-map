# OSINT Map

A live map built only from free public data: flights (with route and track history), military aircraft, ships, about 9,400 road cameras in 9 regions, world news, earthquakes, natural disasters, wildfires, weather alerts, rain radar, undersea cables, power plants and satellites. On top of that it flags sanctioned ships and planes, ships that go silent, and GPS jamming, and a timeline lets you replay the last 24 hours. You can switch between a dark map and satellite imagery, and search for places, flights, ships and cameras.

## Run it

```bash
node server.js
```

Open http://localhost:8790. You need Node 22 or newer. There's nothing to install.

## Using it

- **Search box:** results from data already on the map show as you type. Press **Enter** to also search places (OpenStreetMap) and flights anywhere in the world by callsign, registration or ICAO hex.
- **Click a plane** to track it. The card shows departure → destination with a progress bar. On the map, the cyan line is the path flown today (from takeoff), the pink line is the remaining route, and pins mark both airports. **Follow** keeps the map centered on the plane.
- **Dark map / Satellite** switches the background (satellite imagery is from Esri).
- **Timeline** (bottom bar): drag the slider to see how things were at any point in the last 24 hours, or press ▶ to play it back at 1, 5 or 30 minutes per second. Red ticks mark alerts. **Go live** returns to now. Flights are recorded every minute and ships every 5 minutes; earthquakes, news, fires, disasters and satellites are shown as they were at that moment. Layers that aren't recorded (radar, weather alerts, GPS jamming, silent ships) are hidden during replay. Recording only happens while the server is running, and it's kept in `data/history/`.
- **Color key** at the bottom of the panel lists every icon.
- **Update timers:** under each layer's count is how long ago its data was last refreshed (for radar, how old the radar picture is). It turns amber when a layer is more than 3× late, which usually means the source is slow or down. Hover over it to see the exact time. Watchlist rows show when each item was last seen or checked.

## Watchlist and alerts

- **Watch a flight or ship:** open its card and press **Watch**. You get an alert when a flight takes off, lands, loses signal, comes back, or squawks an emergency code, and when a ship stops transmitting, starts moving or stops, or changes destination.
- **Watch an area:** press **+ Area** and drag a box on the map (or choose "Whole world instead"). Then pick the rules: military aircraft enters, emergency squawk, earthquake above a magnitude, new US wildfire, new natural disaster, moving ship goes silent, sanctioned ship or plane in the area, suspicious ship activity, or news tagged violence.
- Alerts show up as pop-ups and as browser notifications (allow them when asked), and are saved under **Alerts**. Click an alert to jump to it.
- The checks run on the server every 15 s, so they keep going even with the browser closed. The watchlist and alert history are saved in `data/watch.json`.
- A new watch only alerts on things that show up after you create it. Watching the whole world for military aircraft is noisy (about one alert every 10 s), so whole-world watches default to emergencies and M6+ earthquakes.

## How "live" works

- When the server starts, it loads every feed and keeps refreshing them in the background, so the browser never waits on a slow outside source.
- The browser holds one open connection (`/api/stream`). Flights (every 8 s) and ships (every 5 s) for the area you're looking at are pushed to it. For the other feeds, the server sends a short "changed" note and the browser downloads the new gzipped copy.
- Areas you've looked at in the last 15 minutes stay refreshed, so going back to one or reloading the page shows planes right away. A brand-new area loads in about 0.5 s.
- Between updates, planes keep moving along their heading, so they glide instead of jumping.

## Speed

- **Redraws match zoom.** Planes and satellites are redrawn only as often as they'd move a visible amount: about 10× a second at street level, once every 1–2 s zoomed out. Nothing animates while the tab is hidden or while you drag the map. Icons shrink when zoomed out, and drawing resolution is capped at 1.5× on very sharp screens.
- **Ships are sent lean.** Each ship is one short row (details load when you click it). Zoomed far out, at most 4,000–8,000 ships are sent, moving ones first, every 15 s instead of 5 s. That's about 25× less data than before.
- **Your view comes first.** Flight requests for the area you're looking at skip ahead of background work (jamming hotspots, areas viewed earlier) in the rate-limit queue. Areas viewed in the last 15 min stay cached, so going back is instant.
- **Repeat visits are near-instant.** The page's files are gzipped and answered with "not changed" when nothing changed. A service worker (`public/sw.js`) keeps the map libraries (about 2.5 MB) and the map tiles you've seen (up to 4,000) on your computer. Live data is never cached by it. The page starts downloading the data for your switched-on layers and the right basemap before the map libraries finish loading.

## Layers

| Layer | Source | Refresh | Notes |
|---|---|---|---|
| Flights near view | adsb.fi, with adsb.lol as backup | 8 s | Within ~460 km of the map's center |
| Military | adsb.lol `/v2/mil` | 15 s | Worldwide |
| Flight track and route | adsb.lol traces and route list | when clicked | Route list is community-made and can be wrong; mismatches are flagged |
| Ships | aisstream.io | 5 s | Needs a free key (see below) |
| Road cameras | Caltrans, WSDOT, Seattle DOT, DriveBC, TfL, HK Transport Dept, Fintraffic, NZTA, Singapore LTA | 10 min | California and London have video |
| News | GDELT 2.0 event export | 15 min | Last 6 h, grouped by place |
| Earthquakes | USGS | 1 min | Past 24 h |
| Natural disasters | NASA EONET | 15 min | Volcanoes, storms, ice, fires worldwide |
| Wildfires | NIFC WFIGS | 5 min | US only |
| Weather alerts | NWS | 2 min | US only. Only alerts that come with their own outline are drawn |
| Rain radar | RainViewer | 5 min | Map tiles |
| Undersea cables | TeleGeography | daily | |
| Power plants | WRI Global Power Plant Database | daily | About 35,000 plants |
| Sanctioned ships / planes | US Treasury OFAC SDN list | daily | Ships matched by IMO number (strong) or MMSI (weaker, since MMSIs get reused or faked); planes by registration. Red ring on any layer |
| Ships gone silent | Worked out from the ship feed | 1 min | Was moving, then no reports for 20 min–6 h. "Likely switched off" if ships nearby are still being heard, "maybe out of range" if not |
| Suspicious ship activity | Worked out from the ship feed, cables and Natural Earth ports | 1 min | See below |
| GPS jamming | Worked out from aircraft GPS accuracy (NACp) | 1 min | 1° squares, last hour. Only planes broadcasting their own ADS-B v2 position count. Areas you've viewed plus known hotspots (Baltic, Black Sea, E. Mediterranean, Middle East, Korea) are sampled |
| Satellites / Starlink | CelesTrak orbit data, positions computed in the browser | every 6 h | Space stations, GPS, weather, military, geostationary, plus ~10,000 Starlink. Click one for its path over the ground |

## Ship risk profiles

Click any ship (or a ship in a detection, sanctions or chokepoint card) and choose **Profile & risk**. You get:

- **Identity:** name, flag country (from the MMSI's first three digits, using the ITU list via [powers9/MIDs](https://github.com/powers9/MIDs)), type, size, IMO and MMSI.
- **Risk score (0–100)** with every point explained, for example "+60 on the US sanctions list, matched by IMO", "+20 ship-to-ship transfer away from port", "+15 went silent while ships nearby kept transmitting", "+10 tanker flagged in a registry often linked to the shadow fleet". 20+ is *elevated*, 50+ is *high*. It sorts ships worth a closer look; it isn't a verdict.
- **History (14 days):** transfers, silent periods, cable loitering, jumps, identity changes and chokepoint crossings, with markers on the map.
- **24-hour track** drawn on the map, plus a VesselFinder link for photos and ownership.

**Riskiest ships** (button under the map style) lists ships currently heard with a score of 20+.

## Chokepoint traffic

**Chokepoints** (button under the map style) counts ships crossing a line drawn across 11 strategic straits and canals: Hormuz, Bab-el-Mandeb, Suez, Panama, Singapore, Bosporus, Gibraltar, Dover, Skagen, Taiwan and the Cape of Good Hope. For each one it shows the last 24 h, the change from normal (the median of earlier full days, after 3 days of counting), tankers, sanctioned ships, traffic each way, a 14-day trend, and the latest ships through. Turn on **Chokepoint gates** to see the lines on the map (red = 25%+ below normal, green = 25%+ above). Counts are saved to `data/chokepoints.json`, so the normal builds up across restarts. A "thin coverage" warning means few ships are heard there right now, so the count is incomplete.

## Suspicious ship activity

Turn on **Suspicious ship activity** (Intelligence group) to see five kinds of detection, each with a warning icon and a line showing what happened:

| Detection | Rule | Why it matters |
|---|---|---|
| **Ship-to-ship transfer** | A seagoing tanker (150 m+) and another big ship (100 m+) within 500 m, both at 2 kt or less, more than 20 km from a major port, for over an hour | How cargo, often sanctioned oil, changes hands at sea ("shadow fleet") |
| **Loitering over a cable** | A cargo ship, tanker or 80 m+ vessel (not fishing) moving at 0.5–7 kt within 1 km of an undersea cable, more than 15 km from a major port, for 30+ minutes | Matches the 2023–25 Baltic cable cuts, where ships dragged anchors along the seabed. A normal crossing takes minutes. Anchored ships aren't counted: published cable routes are only accurate to a few hundred metres, so that mostly flagged ordinary anchorages. |
| **Impossible jump** | Two position reports that would need more than ~50 kt (or twice the ship's speed + 20 kt) to connect, judged on the time the ship sent them | Usually two transmitters sharing one MMSI, or a faked position |
| **Changed identity** | A ship's broadcast name or IMO number changes at sea | IMO numbers are permanent, so a change is a strong sign of a fake identity |
| **Shared IMO** | Two ships broadcasting the same IMO number 50+ km apart | At least one is using a borrowed or fake identity |

What's filtered out on purpose, after testing against live traffic (40-minute runs): river barges and small craft moored together, fishing and pleasure boats over coastal cables, ferries at terminals where cables come ashore, anchored ships near cables, placeholder MMSIs (111111111, 200000000…), invalid positions (91/181, 0,0, near the poles), garbled positions where one coordinate stays put and the other is corrupted (a dropped digit or flipped sign), and garbled names ("@" filler, test transmitters).

## Turn on ships

1. Sign in at https://aisstream.io with GitHub and copy your API key.
2. Copy `.env.example` to `.env` and paste the key into `AISSTREAM_KEY=`.
3. Restart the server.

## Add a layer

1. Write a fetcher in `feeds.js` that returns slim JSON.
2. Register it in `FEEDS` in `server.js` and set how often it refreshes.
3. Add a row to `LAYERS` in `public/app.js`, plus a draw call in `render()` and a card in `CARDS`. Icons live in `public/icons.js`.

To add another camera region, add a download function to `CAMERA_FETCH` and a parser to `CAMERA_PARSERS` in `feeds.js` that returns `{ name, place, route, lat, lon, image, on, source }`, then add a small sample to `test/fixtures/cameras.js`.

## Tests

```bash
npm test
```

These run offline in under a second. They check that every source's real format still parses (cameras, OFAC, orbit data, GDELT rows) and test the decision logic: sanctions matching, silent-ship confidence, GPS-jamming thresholds, flight-leg choice, date-line boxes and timeline storage.

```bash
npm run check-sources
```

This tries every outside source once, live, and reports which ones answer and how much data they return. Run it when a layer looks empty. It exits with an error if any source is down.

## Code layout

| File | What it does |
|---|---|
| `server.js` | HTTP server, keeps feeds warm, live stream, timeline recording |
| `feeds.js` | Downloads each outside source |
| `intel.js` | Pure logic: sanctions, silent ships, suspicious ship activity, GPS jamming, routes, news rows |
| `watch.js` | Watchlist rules and alerts |
| `history.js` | Timeline snapshots on disk |
| `public/` | The map (MapLibre + deck.gl), icons, styles |

## Limits

- GDELT's places and categories are guessed by software from article text, and they're often wrong. Treat a news dot as a lead, not a fact.
- **Sanctions, silent ships, suspicious ship activity and jamming are leads, not proof.** Only the US list is used (not EU/UK). A ship can go quiet because it left receiver range. Ship detections only cover what aisstream's coastal receivers hear, so transfers far offshore are often missed, and small or unlisted harbours aren't excluded the way major ports are. Jamming coverage is only as good as the number of planes flying there, so it's thin at night.
- CelesTrak refuses repeat downloads of the same orbit data within 2 hours. If a group is missing, the server retries it every 10 minutes.
- Some aircraft are hidden from public trackers on purpose, and ships can switch AIS off. If something is missing from the map, that doesn't prove it isn't there.
- Flight coverage depends on volunteer receivers, so it's thin in some places (Japan, for example). Ship coverage from aisstream is thin far from shore and in the Persian Gulf.
- Every adsb.lol and adsb.fi request goes through a queue that spaces requests out and pauses for 30 s after a "too many requests" error. When that happens the map keeps showing the last good data.
- The free feeds are for personal or non-commercial use. Check each source's terms before you build anything commercial on this.
