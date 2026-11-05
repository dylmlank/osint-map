# OSINT Map

A live map built only from free public data: flights (with route and track history), military aircraft, ships, about 7,400 road cameras in 7 regions, world news, earthquakes, natural disasters, wildfires, weather alerts, rain radar, undersea cables and power plants. It has a dark map or satellite view, and you can search for places, flights, ships and cameras.

## Run it

```bash
node server.js
```

Open http://localhost:8790. You need Node 22 or newer. There's nothing to install.

## Using it

- **Search box:** results from data already on the map show as you type. Press **Enter** to also search places (OpenStreetMap) and flights anywhere in the world by callsign, registration or ICAO hex.
- **Click a plane** to track it. The card shows departure → destination with a progress bar. On the map, the cyan line is the path flown today (from takeoff), the pink line is the remaining route, and pins mark both airports. **Follow** keeps the map centered on the plane.
- **Dark map / Satellite** switches the background (satellite imagery is from Esri).
- **Color key** at the bottom of the panel lists every icon.
- **Update timers:** under each layer's count is how long ago its data was last refreshed (for radar, how old the radar picture is). It turns amber when a layer is more than 3× late, which usually means the source is slow or down. Hover over it to see the exact time. Watchlist rows show when each item was last seen or checked.

## Watchlist and alerts

- **Watch a flight or ship:** open its card and press **Watch**. You get an alert when a flight takes off, lands, loses signal, comes back, or squawks an emergency code, and when a ship stops transmitting, starts moving or stops, or changes destination.
- **Watch an area:** press **+ Area** and drag a box on the map (or choose "Whole world instead"). Then pick the rules: military aircraft enters, emergency squawk, earthquake above a magnitude, new US wildfire, new natural disaster, moving ship goes silent, or news tagged violence.
- Alerts show up as pop-ups and as browser notifications (allow them when asked), and are saved under **Alerts**. Click an alert to jump to it.
- The checks run on the server every 15 s, so they keep going even with the browser closed. The watchlist and alert history are saved in `data/watch.json`.
- A new watch only alerts on things that show up after you create it. Watching the whole world for military aircraft is noisy (about one alert every 10 s), so whole-world watches default to emergencies and M6+ earthquakes.

## How "live" works

- When the server starts, it loads every feed and keeps refreshing them in the background, so the browser never waits on a slow outside source.
- The browser holds one open connection (`/api/stream`). Flights (every 8 s) and ships (every 5 s) for the area you're looking at are pushed to it. For the other feeds, the server sends a short "changed" note and the browser downloads the new gzipped copy.
- Areas you've looked at in the last 15 minutes stay refreshed, so going back to one or reloading the page shows planes right away. A brand-new area loads in about 0.5 s.
- Between updates, planes keep moving along their heading, so they glide instead of jumping.

## Layers

| Layer | Source | Refresh | Notes |
|---|---|---|---|
| Flights near view | adsb.fi, with adsb.lol as backup | 8 s | Within ~460 km of the map's center |
| Military | adsb.lol `/v2/mil` | 15 s | Worldwide |
| Flight track and route | adsb.lol traces and route list | when clicked | Route list is community-made and can be wrong; mismatches are flagged |
| Ships | aisstream.io | 5 s | Needs a free key (see below) |
| Road cameras | Caltrans, DriveBC, TfL, HK Transport Dept, Fintraffic, NZTA, Singapore LTA | 10 min | California and London have video |
| News | GDELT 2.0 event export | 15 min | Last 6 h, grouped by place |
| Earthquakes | USGS | 1 min | Past 24 h |
| Natural disasters | NASA EONET | 15 min | Volcanoes, storms, ice, fires worldwide |
| Wildfires | NIFC WFIGS | 5 min | US only |
| Weather alerts | NWS | 2 min | US only. Only alerts that come with their own outline are drawn |
| Rain radar | RainViewer | 5 min | Map tiles |
| Undersea cables | TeleGeography | daily | |
| Power plants | WRI Global Power Plant Database | daily | About 35,000 plants |

## Turn on ships

1. Sign in at https://aisstream.io with GitHub and copy your API key.
2. Copy `.env.example` to `.env` and paste the key into `AISSTREAM_KEY=`.
3. Restart the server.

## Add a layer

1. Write a fetcher in `feeds.js` that returns slim JSON.
2. Register it in `FEEDS` in `server.js` and set how often it refreshes.
3. Add a row to `LAYERS` in `public/app.js`, plus a draw call in `render()` and a card in `CARDS`. Icons live in `public/icons.js`.

To add another camera region, add a function to `CAMERA_SOURCES` in `feeds.js` that returns `{ name, place, route, lat, lon, image, on, source }`.

## Limits

- GDELT's places and categories are guessed by software from article text, and they're often wrong. Treat a news dot as a lead, not a fact.
- Some aircraft are hidden from public trackers on purpose, and ships can switch AIS off. If something is missing from the map, that doesn't prove it isn't there.
- Flight coverage depends on volunteer receivers, so it's thin in some places (Japan, for example). Ship coverage from aisstream is thin far from shore and in the Persian Gulf.
- Every adsb.lol and adsb.fi request goes through a queue that spaces requests out and pauses for 30 s after a "too many requests" error. When that happens the map keeps showing the last good data.
- The free feeds are for personal or non-commercial use. Check each source's terms before you build anything commercial on this.
