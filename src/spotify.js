const { parseSpotifyUrl, pickImage } = require('./util');

const API_BASE = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

let tokenCache = { token: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

function market() {
  return process.env.MARKET || 'FR';
}

async function getAppToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(
      `Authentification Spotify échouée (${res.status}) — vérifie SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET dans .env`
    );
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function api(path, params, userToken) {
  let fellBack = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = (userToken && !fellBack ? userToken : null) || (await getAppToken());
    const url = new URL(API_BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const waitMs = Math.min(Number(res.headers.get('retry-after') || 1) * 1000, 15000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (res.status === 401 && !userToken && attempt < 2) {
      tokenCache.token = null;
      continue;
    }
    if (res.status === 401 && userToken && !fellBack) {
      fellBack = true;
      continue;
    }
    if (res.status === 401 && userToken) {
      throw new Error('Session Spotify expirée — reconnecte-toi');
    }
    if (res.status === 404) {
      throw new Error('Introuvable sur Spotify (lien invalide, privé ou supprimé)');
    }
    if (res.status === 403) {
      if (userToken && !fellBack) {
        fellBack = true;
        continue;
      }
      const body = await res.json().catch(() => null);
      const apiMsg = body && body.error && body.error.message ? body.error.message : '';
      if (/insufficient client scope/i.test(apiMsg)) {
        throw new Error(
          "Accès refusé (403) — scopes insuffisants : déconnecte-toi puis reconnecte-toi pour régénérer le token avec les bons droits."
        );
      }
      if (apiMsg) {
        throw new Error(`Accès refusé (403) : ${apiMsg}`);
      }
      throw new Error(
        "Accès refusé (403) — active l'API Web dans le Dashboard Spotify (Product completion → Web API), puis déconnecte/reconnecte."
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Spotify API ${res.status} : ${text.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error('Spotify API : trop de tentatives (rate limit)');
}

function normalizeTrack(t, coverFallback) {
  const album = t.album || {};
  const id = t.id || (t.uri ? t.uri.split(':').pop() : null);
  return {
    id,
    name: t.name || '(sans titre)',
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: album.name || '',
    releaseDate: album.release_date || '',
    durationMs: t.duration_ms || 0,
    trackNumber: t.track_number != null ? t.track_number : null,
    isrc: (t.external_ids && t.external_ids.isrc) || '',
    popularity: t.popularity != null ? t.popularity : null,
    url:
      (t.external_urls && t.external_urls.spotify) ||
      (id ? `https://open.spotify.com/track/${id}` : ''),
    previewUrl: t.preview_url || null,
    cover: pickImage(album.images) || coverFallback || null,
  };
}

async function fetchPlaylist(id, userToken) {
  const meta = await api(`/playlists/${id}`, { market: market() }, userToken);
  const tracks = [];
  let offset = 0;
  for (;;) {
    const page = await api(
      `/playlists/${id}/tracks`,
      { market: market(), limit: 100, offset },
      userToken
    );
    const items = page.items || [];
    for (const item of items) {
      const t = item && item.track;
      if (!t) continue;
      tracks.push(normalizeTrack(t));
    }
    offset += items.length;
    if (!page.next || items.length === 0) break;
  }
  return {
    type: 'playlist',
    id: meta.id || id,
    name: meta.name || 'Playlist',
    description: meta.description || '',
    cover: pickImage(meta.images),
    owner: meta.owner ? meta.owner.display_name : '',
    trackTotal: tracks.length,
    tracks,
  };
}

async function fetchAlbum(id, userToken) {
  const meta = await api(`/albums/${id}`, { market: market() }, userToken);
  const cover = pickImage(meta.images);
  const items = (meta.tracks && meta.tracks.items ? meta.tracks.items : []).slice();
  let offset = items.length;
  const total = meta.tracks ? meta.tracks.total : items.length;
  while (offset < total) {
    const page = await api(
      `/albums/${id}/tracks`,
      { market: market(), limit: 50, offset },
      userToken
    );
    const pageItems = page.items || [];
    items.push(...pageItems);
    offset += pageItems.length;
    if (pageItems.length === 0) break;
  }
  const full = new Map();
  const ids = items.map((t) => t.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await api('/tracks', { ids: chunk.join(','), market: market() }, userToken);
    for (const t of res.tracks || []) {
      if (t && t.id) full.set(t.id, t);
    }
  }
  const tracks = items.map((s) => full.get(s.id) || s).map((t) => normalizeTrack(t, cover));
  const artists = (meta.artists || []).map((a) => a.name).join(', ');
  return {
    type: 'album',
    id: meta.id || id,
    name: meta.name || 'Album',
    description: [artists, meta.release_date, meta.label].filter(Boolean).join(' · '),
    cover,
    owner: artists,
    trackTotal: tracks.length,
    tracks,
  };
}

async function fetchTrack(id, userToken) {
  const t = await api(`/tracks/${id}`, { market: market() }, userToken);
  const artists = (t.artists || []).map((a) => a.name).join(', ');
  return {
    type: 'track',
    id: t.id || id,
    name: t.name || 'Titre',
    description: artists,
    cover: pickImage(t.album && t.album.images),
    owner: artists,
    trackTotal: 1,
    tracks: [normalizeTrack(t)],
  };
}

async function fetchArtist(id, userToken) {
  const meta = await api(`/artists/${id}`, {}, userToken);
  const top = await api(`/artists/${id}/top-tracks`, { country: market() }, userToken);
  const tracks = (top.tracks || []).map((t) => normalizeTrack(t));
  return {
    type: 'artist',
    id: meta.id || id,
    name: `Populaire — ${meta.name || 'Artiste'}`,
    description: 'Titres les plus écoutés sur Spotify',
    cover: pickImage(meta.images),
    owner: meta.name || '',
    trackTotal: tracks.length,
    tracks,
  };
}

async function fetchCollection(type, id, userToken) {
  switch (type) {
    case 'playlist':
      return fetchPlaylist(id, userToken);
    case 'album':
      return fetchAlbum(id, userToken);
    case 'track':
      return fetchTrack(id, userToken);
    case 'artist':
      return fetchArtist(id, userToken);
    default:
      throw new Error(`Type non supporté : ${type}`);
  }
}

async function resolveCollection(rawUrl, userToken) {
  const { type, id } = parseSpotifyUrl(rawUrl);
  return fetchCollection(type, id, userToken);
}

async function fetchMe(userToken) {
  const me = await api('/me', {}, userToken);
  return {
    id: me.id,
    displayName: me.display_name || me.id,
    image: me.images && me.images.length ? me.images[0].url : null,
  };
}

async function fetchUserPlaylists(userToken, limit = 50) {
  const items = [];
  let offset = 0;
  for (;;) {
    const page = await api('/me/playlists', { limit: 50, offset }, userToken);
    const batch = page.items || [];
    for (const p of batch) {
      items.push({
        id: p.id,
        name: p.name,
        description: p.description || '',
        cover: pickImage(p.images),
        owner: p.owner ? p.owner.display_name : '',
        trackTotal: p.tracks ? p.tracks.total : 0,
        public: p.public,
        collaborative: p.collaborative,
      });
    }
    offset += batch.length;
    if (!page.next || batch.length === 0 || items.length >= limit) break;
  }
  return items.slice(0, limit);
}

async function fetchUserAlbums(userToken, limit = 50) {
  const items = [];
  let offset = 0;
  for (;;) {
    const page = await api('/me/albums', { limit: 50, offset }, userToken);
    const batch = page.items || [];
    for (const entry of batch) {
      const a = entry.album;
      if (!a) continue;
      items.push({
        id: a.id,
        name: a.name,
        artists: (a.artists || []).map((x) => x.name).join(', '),
        cover: pickImage(a.images),
        releaseDate: a.release_date || '',
        trackTotal: a.total_tracks || 0,
      });
    }
    offset += batch.length;
    if (!page.next || batch.length === 0 || items.length >= limit) break;
  }
  return items.slice(0, limit);
}

async function fetchLikedTracksCollection(userToken) {
  const tracks = [];
  let offset = 0;
  for (;;) {
    const page = await api('/me/tracks', { limit: 50, offset }, userToken);
    const items = page.items || [];
    for (const entry of items) {
      const t = entry.track;
      if (!t) continue;
      tracks.push(normalizeTrack(t));
    }
    offset += items.length;
    if (!page.next || items.length === 0) break;
  }
  return {
    type: 'liked',
    id: 'liked',
    name: 'Titres likés',
    description: 'Tes morceaux likés sur Spotify',
    cover: null,
    owner: '',
    trackTotal: tracks.length,
    tracks,
  };
}

async function fetchLibrary(userToken) {
  const [playlists, albums] = await Promise.all([
    fetchUserPlaylists(userToken),
    fetchUserAlbums(userToken),
  ]);
  let likedTotal = 0;
  try {
    const first = await api('/me/tracks', { limit: 1 }, userToken);
    likedTotal = first.total || 0;
  } catch {
    likedTotal = 0;
  }
  return { playlists, albums, likedTotal };
}

async function searchTracks(query, userToken, limit = 20) {
  let effectiveLimit = limit;
  if (!userToken) effectiveLimit = Math.min(limit, 10);
  let data;
  try {
    data = await api('/search', { q: query, type: 'track', limit: effectiveLimit }, userToken);
  } catch (e) {
    if (/invalid limit/i.test(e.message) && effectiveLimit > 10) {
      effectiveLimit = 10;
      data = await api('/search', { q: query, type: 'track', limit: effectiveLimit }, userToken);
    } else {
      throw e;
    }
  }
  const items = (data.tracks && data.tracks.items) || [];
  return items.map((t) => normalizeTrack(t));
}

async function fetchTracksByIds(ids, userToken) {
  const tracks = [];
  const unique = [...new Set(ids.map(String))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const res = await api('/tracks', { ids: chunk.join(',') }, userToken);
    for (const t of res.tracks || []) {
      if (t) tracks.push(normalizeTrack(t));
    }
  }
  const order = new Map(unique.map((id, i) => [id, i]));
  tracks.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
  return tracks;
}

module.exports = {
  isConfigured,
  resolveCollection,
  fetchCollection,
  fetchMe,
  fetchLibrary,
  fetchLikedTracksCollection,
  searchTracks,
  fetchTracksByIds,
};
