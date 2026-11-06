// Shape icons for every layer. Each is a small SVG, filled with the item's color and
// outlined in dark so it reads on both the dark map and satellite imagery.
(function () {
  const INK = '#0b0f14';
  const SHAPES = {
    plane: c => `<path fill="${c}" d="M12 1.5c.9 0 1.4 1 1.4 2.2v5.4l8.6 4.8v2.3l-8.6-2.5v4.7l2.3 1.8v1.4L12 20.7l-3.7.9v-1.4l2.3-1.8v-4.7L2 16.2v-2.3l8.6-4.8V3.7c0-1.2.5-2.2 1.4-2.2z"/>`,
    ship: c => `<path fill="${c}" d="M12 1.5 18.5 20 12 16.8 5.5 20z"/>`,
    camera: c => `<rect fill="${c}" x="2" y="6.5" width="14" height="11" rx="2.2"/><path fill="${c}" d="M16 10.3 22 6.8v10.4L16 13.7z"/><circle fill="${INK}" stroke="none" cx="9" cy="12" r="2.4"/>`,
    news: c => `<rect fill="${c}" x="4" y="2.5" width="16" height="19" rx="2.5"/><path fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" d="M8 8h8M8 12h8M8 16h5"/>`,
    quake: c => `<circle fill="${c}" cx="12" cy="12" r="10"/><path fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="M4.5 12.5h2.8l1.8-5 3 10.5 2.2-8 1.4 2.5h3.8"/>`,
    fire: c => `<path fill="${c}" d="M12.5 1.5c.8 4.2 6.5 6.3 6.5 12.5a7 7 0 0 1-14 0c0-3.4 2-5.6 3.3-7.6.1 2.2 1 3.4 2.3 3.6-.3-3.4.2-6 1.9-8.5z"/>`,
    volcano: c => `<path fill="${c}" d="M1.5 21.5 8.8 9.5h6.4l7.3 12z"/><path fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" d="M10.5 6.5c0-2 1.5-2 1.5-4M14 6.5c0-1.6 1.5-1.8 1.5-3.6"/>`,
    storm: c => `<path fill="${c}" d="M14.5 2.5C9 2 5.2 4.8 4 8.5c2-1.6 4.4-1.9 6-1.2A5.5 5.5 0 0 0 9.5 17.6c-.6 1.6-2 3-4 3.9 5.5.5 9.3-2.3 10.5-6 -2 1.6-4.4 1.9-6 1.2A5.5 5.5 0 0 0 14.5 6.4c.6-1.6 2-3 4-3.9z"/><circle fill="${INK}" stroke="none" cx="12" cy="12" r="2"/>`,
    ice: c => `<path fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round" d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6"/><path fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6"/>`,
    drop: c => `<path fill="${c}" d="M12 1.8S4.5 10.5 4.5 15.2a7.5 7.5 0 0 0 15 0C19.5 10.5 12 1.8 12 1.8z"/>`,
    diamond: c => `<path fill="${c}" d="M12 1.5 22.5 12 12 22.5 1.5 12z"/>`,
    bolt: c => `<circle fill="${c}" cx="12" cy="12" r="10"/><path fill="${INK}" stroke="none" d="M13.2 4.5 7.5 13.2h4l-1 6.3 6-9h-4.1z"/>`,
    satellite: c => `<path fill="${c}" d="M1.5 9.5h6v5h-6zM16.5 9.5h6v5h-6z"/><rect fill="${c}" x="8.5" y="8" width="7" height="8" rx="1.5"/><path fill="none" stroke="${c}" stroke-width="2" d="M7.5 12h1M15.5 12h1"/>`,
    alert: c => `<path fill="${c}" d="M12 2.2 22.6 20.8H1.4z"/><path fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" d="M12 9v5.2"/><circle fill="${INK}" stroke="none" cx="12" cy="17.4" r="1.4"/>`,
    grid: c => `<rect fill="${c}" x="3" y="3" width="18" height="18" rx="2"/><path fill="none" stroke="${INK}" stroke-width="1.6" d="M3 12h18M12 3v18"/>`,
    airport: c => `<path fill="${c}" d="M12 22.5s-7.5-7.3-7.5-12.6a7.5 7.5 0 0 1 15 0c0 5.3-7.5 12.6-7.5 12.6z"/><circle fill="${INK}" stroke="none" cx="12" cy="9.9" r="2.8"/>`,
  };

  const url = (shape, color) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-1 -1 26 26">`
    + `<g stroke="${INK}" stroke-width="1.5" stroke-linejoin="round">${SHAPES[shape](color)}</g></svg>`);

  const memo = new Map();
  // deck.gl IconLayer descriptor; deck packs each distinct id into its atlas once.
  function icon(shape, color) {
    const id = `${shape}|${color}`;
    if (!memo.has(id)) {
      memo.set(id, { id, url: url(shape, color), width: 64, height: 64, anchorY: shape === 'airport' ? 62 : 32 });
    }
    return memo.get(id);
  }

  window.Icons = { url, icon };
})();
