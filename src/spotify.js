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

const USER_ONLY_PATTERNS = [/^\/me(\/|$)/, /^\/playlists\//, /^\/artists\/[^/]+\/top-tracks/];

function needsUserContext(path) {
  return USER_ONLY_PATTERNS.some((re) => re.test(path));
}

async function api(path, params, userToken) {
  const needsUser = needsUserContext(path);
  if (needsUser && !userToken) {
    throw new Error('Connexion Spotify requise — reconnecte-toi pour lire cet element');
  }
  let fellBack = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = (userToken && !fellBack ? userToken : null) || (await getAppToken());
    const url = new URL(API_BASE + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, v);
      }
    }
    const t0 = Date.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const ms = Date.now() - t0;
    if (ms > 400 || res.status === 429) {
      console.log(`[api] ${ms}ms ${res.status} ${path}`);
    }
    if (res.status === 429) {
      const waitMs = Math.min(Number(res.headers.get('retry-after') || 1) * 1000, 15000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (needsUser && (res.status === 401 || res.status === 403)) {
      throw new Error(`Session Spotify refusee (HTTP ${res.status} sur ${path}) — reconnecte-toi`);
    }
    if (res.status === 401 && !userToken && attempt < 2) {
      tokenCache.token = null;
      continue;
    }
    if ((res.status === 401 || res.status === 403) && userToken && !fellBack) {
      fellBack = true;
      continue;
    }
    if (res.status === 404) {
      throw new Error('Introuvable sur Spotify (lien invalide, prive ou supprime)');
    }
    if (res.status === 401 && userToken) {
      throw new Error('Session Spotify expiree — reconnecte-toi');
    }
    if (res.status === 403) {
      const body = await res.json().catch(() => null);
      const apiMsg = body && body.error && body.error.message ? body.error.message : '';
      if (/insufficient client scope/i.test(apiMsg)) {
        throw new Error(
          'Acces refuse (403) — scopes insuffisants : deconnecte-toi puis reconnecte-toi pour regenerer le token avec les bons droits.'
        );
      }
      if (apiMsg) {
        throw new Error(`Acces refuse (403) sur ${path} : ${apiMsg}`);
      }
      throw new Error(
        `Acces refuse (403) sur ${path} — active l'API Web dans le Dashboard Spotify (Product completion -> Web API), puis deconnecte/reconnecte.`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Spotify API ${res.status} sur ${path} : ${text.slice(0, 200)}`);
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

async function collectPages(path, params, userToken, pageSize, firstPage) {
  const pages = [firstPage];
  const total = firstPage.total != null ? firstPage.total : null;
  const baseOffset = firstPage.offset != null ? firstPage.offset : 0;
  if (firstPage.next && total != null) {
    const offsets = [];
    for (let o = baseOffset + pageSize; o < total; o += pageSize) offsets.push(o);
    if (offsets.length) {
      const out = new Array(offsets.length);
      let cursor = 0;
      const workerCount = Math.min(6, offsets.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const i = cursor++;
            if (i >= offsets.length) break;
            out[i] = await api(path, { ...params, limit: pageSize, offset: offsets[i] }, userToken);
          }
        })
      );
      for (const page of out) if (page) pages.push(page);
    }
  } else if (firstPage.next) {
    let offset = baseOffset + (firstPage.items ? firstPage.items.length : pageSize);
    for (;;) {
      const page = await api(path, { ...params, limit: pageSize, offset }, userToken);
      pages.push(page);
      if (!page.next || !page.items || page.items.length === 0) break;
      offset += page.items.length;
    }
  }
  return pages;
}
async function fetchPlaylist(id, userToken) {
  const meta = await api(`/playlists/${id}`, { market: market() }, userToken);
  const params = { market: market() };
  const first = await api(`/playlists/${id}/tracks`, { ...params, limit: 100, offset: 0 }, userToken);
  const pages = await collectPages(`/playlists/${id}/tracks`, params, userToken, 100, first);
  const tracks = [];
  for (const page of pages) {
    for (const item of page.items || []) {
      const t = item && item.track;
      if (!t) continue;
      tracks.push(normalizeTrack(t));
    }
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
  const total = meta.tracks ? meta.tracks.total : items.length;
  if (items.length < total) {
    const params = { market: market() };
    const first = await api(
      `/albums/${id}/tracks`,
      { ...params, limit: 50, offset: items.length },
      userToken
    );
    const pages = await collectPages(`/albums/${id}/tracks`, params, userToken, 50, first);
    for (const page of pages) items.push(...(page.items || []));
  }
  const full = new Map();
  const ids = items.map((t) => t.id).filter(Boolean);
  for (const t of await fetchTracksBulk(ids, userToken, market())) {
    if (t && t.id) full.set(t.id, t);
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
  const [meta, top] = await Promise.all([
    api(`/artists/${id}`, {}, userToken),
    api(`/artists/${id}/top-tracks`, { country: market() }, userToken),
  ]);
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
  const entries = [];
  let offset = 0;
  for (;;) {
    const page = await api('/me/playlists', { limit: 50, offset }, userToken);
    const batch = page.items || [];
    for (const p of batch) {
      entries.push({
        p,
        trackTotal: p.tracks && p.tracks.total != null ? p.tracks.total : null,
      });
    }
    offset += batch.length;
    if (!page.next || batch.length === 0 || entries.length >= limit) break;
  }
  const missing = entries.filter((x) => x.trackTotal == null);
  await Promise.all(
    missing.map(async (x) => {
      try {
        const full = await api(`/playlists/${x.p.id}`, { fields: 'tracks(total)' }, userToken);
        x.trackTotal = full.tracks && full.tracks.total != null ? full.tracks.total : 0;
      } catch {
        x.trackTotal = 0;
      }
    })
  );
  return entries.slice(0, limit).map(({ p, trackTotal }) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    cover: pickImage(p.images),
    owner: p.owner ? p.owner.display_name : '',
    trackTotal,
    public: p.public,
    collaborative: p.collaborative,
  }));
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
  const first = await api('/me/tracks', { limit: 50, offset: 0 }, userToken);
  const pages = await collectPages('/me/tracks', {}, userToken, 50, first);
  const tracks = [];
  for (const page of pages) {
    for (const entry of page.items || []) {
      const t = entry.track;
      if (!t) continue;
      tracks.push(normalizeTrack(t));
    }
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
  const [playlists, albums, likedFirst] = await Promise.all([
    fetchUserPlaylists(userToken),
    fetchUserAlbums(userToken),
    api('/me/tracks', { limit: 1 }, userToken).catch(() => null),
  ]);
  const likedTotal = likedFirst && likedFirst.total != null ? likedFirst.total : 0;
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

async function fetchTracksBulk(ids, userToken, marketCode) {
  const unique = [...new Set(ids.map(String).filter(Boolean))];
  if (!unique.length) return [];
  if (userToken) {
    try {
      const out = [];
      for (let i = 0; i < unique.length; i += 50) {
        const chunk = unique.slice(i, i + 50);
        const params = { ids: chunk.join(',') };
        if (marketCode) params.market = marketCode;
        const res = await api('/tracks', params, userToken);
        for (const t of res.tracks || []) {
          if (t) out.push(t);
        }
      }
      return out;
    } catch (e) {
      if (/reconnecte-toi|expirée|scope/i.test(e.message || '')) throw e;
    }
  }
  const out = [];
  for (let i = 0; i < unique.length; i += 6) {
    const batch = unique.slice(i, i + 6);
    const settled = await Promise.allSettled(
      batch.map((id) => {
        const params = marketCode ? { market: marketCode } : null;
        return api(`/tracks/${id}`, params, userToken);
      })
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) out.push(r.value);
    }
  }
  return out;
}
async function fetchTracksByIds(ids, userToken) {
  const tracks = [];
  const unique = [...new Set(ids.map(String))];
  const raw = await fetchTracksBulk(unique, userToken);
  for (const t of raw) {
    if (t) tracks.push(normalizeTrack(t));
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
