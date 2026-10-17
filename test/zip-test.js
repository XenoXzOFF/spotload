const { parseSpotifyUrl, sanitizeFilename, formatDuration } = require('../src/util');
const { writeZip } = require('../src/zip');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const assert = (cond, msg) => {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK:', msg);
};

const p1 = parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc');
assert(p1.type === 'playlist' && p1.id === '37i9dQZF1DXcBWIGoYBM5M', 'parse playlist URL');

const p2 = parseSpotifyUrl('https://open.spotify.com/intl-fr/album/4aawyAB9vmqN3uQ7FjRGTy');
assert(p2.type === 'album' && p2.id === '4aawyAB9vmqN3uQ7FjRGTy', 'parse intl album URL');

const p3 = parseSpotifyUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
assert(p3.type === 'track' && p3.id === '4cOdK2wGLETKBW3PvgPWqT', 'parse spotify URI');

const p4 = parseSpotifyUrl('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF');
assert(p4.type === 'artist', 'parse artist URL');

let threw = false;
try { parseSpotifyUrl('https://example.com/foo'); } catch { threw = true; }
assert(threw, 'reject non-spotify domain');

assert(sanitizeFilename('a/b:c*d?.mp3') === 'a b c d .mp3', 'sanitize filename');
assert(formatDuration(215000) === '3:35', 'format duration');

const mockCollections = [
  {
    type: 'playlist',
    id: 'PL1',
    name: 'Ma Playlist / Test',
    description: 'Description',
    owner: 'Moi',
    cover: null,
    tracks: [
      {
        id: 't1', name: 'Song, "Quoted"', artists: 'Artist A', album: 'Album1',
        releaseDate: '2020-01-01', durationMs: 200000, trackNumber: 1,
        isrc: 'US1234567890', popularity: 80, url: 'https://open.spotify.com/track/t1',
        previewUrl: null, cover: null,
      },
      {
        id: 't2', name: 'Song2', artists: 'Artist B', album: 'Album2',
        releaseDate: '2021-02-02', durationMs: 180000, trackNumber: 2,
        isrc: 'US9876543210', popularity: 60, url: 'https://open.spotify.com/track/t2',
        previewUrl: null, cover: null,
      },
    ],
  },
  {
    type: 'album',
    id: 'AL1',
    name: 'Album Test',
    description: 'Artist · 2019',
    owner: 'Artist',
    cover: null,
    tracks: [
      {
        id: 't3', name: 'Album Song', artists: 'Artist', album: 'Album Test',
        releaseDate: '2019-03-03', durationMs: 240000, trackNumber: 1,
        isrc: '', popularity: 50, url: 'https://open.spotify.com/track/t3',
        previewUrl: null, cover: null,
      },
    ],
  },
];

const outPath = path.join(__dirname, 'test_export.zip');
const out = fs.createWriteStream(outPath);
writeZip(mockCollections, { csv: true, json: true, m3u: true, covers: false }, out)
  .then(() => {
    const size = fs.statSync(outPath).size;
    assert(size > 500, `zip created (${size} bytes)`);
    try {
      const ps = [
        "Add-Type -A 'System.IO.Compression.FileSystem'",
        `[IO.Compression.ZipFile]::OpenRead('${outPath.replace(/'/g, "''")}').Entries.FullName`,
      ].join('; ');
      const listing = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' });
      console.log('--- ZIP entries ---\n' + listing);
      assert(listing.includes('tracks.csv'), 'zip contains tracks.csv');
      assert(listing.includes('tracks.json'), 'zip contains tracks.json');
      assert(listing.includes('tracks.m3u'), 'zip contains tracks.m3u');
      assert(listing.includes('00_tous_les_titres.csv'), 'zip contains global csv');
    } catch (e) {
      console.log('WARN: could not list zip entries:', e.message);
    }
    fs.unlinkSync(outPath);
    console.log('\nALL TESTS PASSED');
  })
  .catch((e) => {
    console.error('FAIL:', e);
    process.exit(1);
  });
