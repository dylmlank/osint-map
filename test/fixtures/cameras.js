// Trimmed samples in each camera agency's real format (captured 2026-11-05).
export const california = {
  data: [
    { cctv: { index: '27', inService: 'true', location: { locationName: 'I-5 : (27) North of SR-2', nearbyPlace: 'Los Angeles', route: 'I-5', latitude: '34.10472', longitude: '-118.25247' },
      imageData: { streamingVideoURL: 'https://wzmedia.dot.ca.gov/D7/CCTV-27.stream/playlist.m3u8', static: { currentImageURL: 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i527northofsr2/i527northofsr2.jpg' } } } },
    { cctv: { index: '28', inService: 'false', location: { locationName: 'Out of service', nearbyPlace: 'LA', route: 'I-5', latitude: '34.1', longitude: '-118.2' }, imageData: { static: { currentImageURL: 'x.jpg' } } } },
  ],
};

export const drivebc = [
  { id: 170, name: 'Abbotsford-Huntingdon Border Crossing - S', caption: 'Highway 11 at 2 Avenue, looking south.', highway_display: '11',
    region_name: 'Fraser Valley', is_on: true, location: { type: 'Point', coordinates: [-121.679211, 49.256912] } },
];

export const tfl = [
  { commonName: 'A406 Billet Upass E', lat: 51.60067, lon: -0.01594, additionalProperties: [
    { key: 'available', value: 'true' },
    { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg' },
    { key: 'videoUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.mp4' },
    { key: 'view', value: 'West' },
  ] },
];

export const hongKong = `<?xml version="1.0" encoding="UTF-8"?>
<image-list>
	<image>
		<key>H429F</key>
		<region>Hong Kong Island</region>
		<district>Southern</district>
		<description>Aberdeen Praya Road near Fish Market [H429F]</description>
		<easting>833549</easting>
		<northing>812187</northing>
		<latitude>22.24845</latitude>
		<longitude>114.1505</longitude>
		<url>https://tdcctv.data.one.gov.hk/H429F.JPG</url>
	</image>
</image-list>`;

export const finland = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'C01503', geometry: { type: 'Point', coordinates: [23.99616, 60.05374, 0] },
      properties: { id: 'C01503', name: 'kt51_Inkoo', collectionStatus: 'GATHERING', presets: [{ id: 'C0150301', inCollection: true }, { id: 'C0150302', inCollection: true }, { id: 'C0150309', inCollection: false }] } },
  ],
};

export const newZealand = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><camera><description>South along Hinds Highway from Lagmhor Rd</description><direction>Southbound</direction><group>NA</group><highway>SH1</highway><id>714</id><imageUrl>/camera/714.jpg</imageUrl><journey><id>86</id><name>SH1</name><startLatitude>-41.95</startLatitude><startLongitude>174.06</startLongitude></journey><journeyLeg><name>Ashburton to Rangitata</name><totalLength>35.425</totalLength></journeyLeg><latitude>-43.919632</latitude><longitude>171.721055</longitude><name>SH1 Tinwald </name><offline>false</offline><region><id>11</id><name>Canterbury</name></region><sortOrder>0</sortOrder></camera></response>';

export const singapore = {
  items: [{ timestamp: '2026-11-06T05:20:01+08:00', cameras: [
    { timestamp: '2026-11-06T05:16:01+08:00', image: 'https://images.data.gov.sg/api/traffic-images/2026/11/1941b055.jpg', location: { latitude: 1.447023728, longitude: 103.7716543 }, camera_id: '2701' },
  ] }],
};

export const issTle = `ISS (ZARYA)
1 25544U 98067A   26309.50000000  .00016717  00000-0  30307-3 0  9993
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 12345
BROKEN ENTRY
1 99999U
`;
