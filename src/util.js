const SPOTIFY_TYPES = ['playlist', 'album', 'track', 'artist'];

function parseSpotifyUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Lien vide');
  const uriMatch = raw.match(/^spotify:(playlist|album|track|artist):([A-Za-z0-9]+)$/i);
  if (uriMatch) return { type: uriMatch[1].toLowerCase(), id: uriMatch[2] };
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Lien invalide : ${raw}`);
  }
  if (!/(^|\.)spotify\.com$/i.test(url.hostname)) {
    throw new Error(`Domaine non Spotify : ${url.hostname}`);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i].toLowerCase();
    if (SPOTIFY_TYPES.includes(seg) && /^[A-Za-z0-9]+$/.test(parts[i + 1])) {
      return { type: seg, id: parts[i + 1] };
    }
  }
  throw new Error(`Type de lien non reconnu (playlist, album, track ou artist) : ${raw}`);
}

function sanitizeFilename(name, fallback = 'sans-nom') {
  let s = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s || fallback;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const withUrl = images.filter((i) => i && i.url);
  if (!withUrl.length) return null;
  const sorted = [...withUrl].sort(
    (a, b) => Math.abs((a.width || 0) - 300) - Math.abs((b.width || 0) - 300)
  );
  return sorted[0].url;
}

module.exports = { parseSpotifyUrl, sanitizeFilename, formatDuration, csvEscape, pickImage };
