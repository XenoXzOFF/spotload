const archiver = require('archiver');
const { sanitizeFilename, csvEscape } = require('./util');

const TYPE_LABELS = { playlist: 'Playlist', album: 'Album', artist: 'Artiste', track: 'Titre', liked: 'Likés' };
const TRACK_HEADER = [
  'track_number',
  'title',
  'artists',
  'album',
  'release_date',
  'duration_ms',
  'isrc',
  'popularity',
  'spotify_url',
  'preview_url',
  'cover_url',
];

const coverCache = new Map();

async function fetchCover(url) {
  if (coverCache.has(url)) return coverCache.get(url);
  let result = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const type = res.headers.get('content-type') || 'image/jpeg';
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0) result = { buf, ext };
    }
  } catch {
    result = null;
  }
  coverCache.set(url, result);
  return result;
}

async function mapPool(items, limit, fn) {
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  };
  const count = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: count }, runner));
}

function trackRow(t) {
  return [
    t.trackNumber,
    t.name,
    t.artists,
    t.album,
    t.releaseDate,
    t.durationMs,
    t.isrc,
    t.popularity,
    t.url,
    t.previewUrl || '',
    t.cover || '',
  ];
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))];
  return Buffer.from('﻿' + lines.join('\n'), 'utf8');
}

function tracksCsv(tracks) {
  return toCsv(TRACK_HEADER, tracks.map(trackRow));
}

function allTracksCsv(entries) {
  const header = ['collection', ...TRACK_HEADER];
  const rows = entries.map(({ collection, track }) => [collection, ...trackRow(track)]);
  return toCsv(header, rows);
}

function buildM3u(tracks) {
  let out = '#EXTM3U\n';
  for (const t of tracks) {
    const dur = Math.round((t.durationMs || 0) / 1000);
    out += `#EXTINF:${dur},${t.artists} - ${t.name}\n`;
    out += `${t.url}\n`;
  }
  return Buffer.from(out, 'utf8');
}

async function appendCollectionCovers(archive, col, folder) {
  const jobs = [];
  if (col.cover) jobs.push({ url: col.cover, name: `${folder}/cover` });
  const seen = new Set();
  col.tracks.forEach((t, idx) => {
    if (!t.cover || seen.has(t.cover)) return;
    seen.add(t.cover);
    const base = `${String(idx + 1).padStart(2, '0')} - ${sanitizeFilename(
      `${t.artists} - ${t.name}`
    )}`;
    jobs.push({ url: t.cover, name: `${folder}/covers/${base}` });
  });
  await mapPool(jobs, 6, async (job) => {
    const cover = await fetchCover(job.url);
    if (cover) archive.append(cover.buf, { name: `${job.name}.${cover.ext}` });
  });
}

async function buildEntries(archive, collections, options) {
  const opt = {
    csv: options.csv !== false,
    json: options.json !== false,
    m3u: options.m3u !== false,
    covers: options.covers !== false,
  };
  const flat = [];
  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    const label = TYPE_LABELS[col.type] || col.type;
    const folder = `${String(i + 1).padStart(2, '0')} - ${label} - ${sanitizeFilename(col.name)}`;
    archive.append(
      Buffer.from(
        JSON.stringify(
          {
            type: col.type,
            id: col.id,
            name: col.name,
            description: col.description || '',
            owner: col.owner || '',
            trackTotal: col.tracks.length,
            exportedAt: new Date().toISOString(),
            tracks: col.tracks,
          },
          null,
          2
        ),
        'utf8'
      ),
      { name: `${folder}/tracks.json` }
    );
    if (opt.csv) archive.append(tracksCsv(col.tracks), { name: `${folder}/tracks.csv` });
    if (opt.m3u) archive.append(buildM3u(col.tracks), { name: `${folder}/tracks.m3u` });
    if (opt.covers) await appendCollectionCovers(archive, col, folder);
    for (const t of col.tracks) flat.push({ collection: col.name, track: t });
  }
  if (opt.csv) archive.append(allTracksCsv(flat), { name: '00_tous_les_titres.csv' });
  if (opt.json) {
    archive.append(
      Buffer.from(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            collections: collections.map((c) => ({
              type: c.type,
              id: c.id,
              name: c.name,
              trackCount: c.tracks.length,
            })),
            tracks: flat.map(({ collection, track }) => ({ collection, ...track })),
          },
          null,
          2
        ),
        'utf8'
      ),
      { name: '00_tous_les_titres.json' }
    );
  }
}

function writeZip(collections, options, out) {
  return new Promise(async (resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    archive.on('error', fail);
    out.on('error', fail);
    out.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    archive.pipe(out);
    try {
      await buildEntries(archive, collections, options || {});
      await archive.finalize();
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = { writeZip };
