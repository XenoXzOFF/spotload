require('dotenv').config();

const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  isConfigured,
  resolveCollection,
  fetchCollection,
  fetchMe,
  fetchLibrary,
  fetchLikedTracksCollection,
  searchTracks,
  fetchTracksByIds,
} = require('./src/spotify');
const { writeZip } = require('./src/zip');
const spotdl = require('./src/spotdl');
const {
  getOrCreateSession,
  getSession,
  destroySession,
  buildAuthUrl,
  exchangeCode,
  getValidAccessToken,
} = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

async function userTokenFrom(req) {
  const session = getSession(req);
  if (!session) return null;
  return getValidAccessToken(session);
}

app.get('/api/health', (req, res) => {
  res.json({ configured: isConfigured() });
});

app.get('/auth/login', (req, res) => {
  if (!isConfigured()) {
    return res.redirect('/?error=config');
  }
  const session = getOrCreateSession(req);
  res.redirect(buildAuthUrl(session));
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const session = getSession(req);
  if (error || !code) {
    return res.redirect(`/?error=${encodeURIComponent(error || 'authorization_refused')}`);
  }
  if (!session || !state || session.state !== state) {
    return res.redirect('/?error=state_mismatch');
  }
  try {
    await exchangeCode(session, code);
    session.state = null;
    res.redirect('/?login=ok');
  } catch (e) {
    console.error('Callback error:', e);
    res.redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
});

app.post('/auth/logout', (req, res) => {
  destroySession(req);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!isConfigured()) return res.json({ user: null, configured: false });
  const token = await userTokenFrom(req);
  if (!token) return res.json({ user: null, configured: true });
  try {
    const user = await fetchMe(token);
    res.json({ user, configured: true });
  } catch {
    res.json({ user: null, configured: true });
  }
});

app.get('/api/library', async (req, res) => {
  try {
    const token = await userTokenFrom(req);
    if (!token) return res.status(401).json({ error: 'Non connecté', relogin: true });
    const library = await fetchLibrary(token);
    res.json(library);
  } catch (e) {
    const msg = e.message || '';
    if (/reconnecte-toi|expirée|scope/i.test(msg)) {
      destroySession(req);
      return res.status(401).json({ error: 'Session expirée — reconnecte-toi avec Spotify', relogin: true });
    }
    res.status(500).json({ error: msg });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ tracks: [] });
    const userToken = await userTokenFrom(req);
    const tracks = await searchTracks(q, userToken, 20);
    res.json({ tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/collections', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(500).json({
        error: 'Configurez SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET dans le fichier .env',
      });
    }
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Aucun lien fourni' });
    }
    if (urls.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 liens par requête' });
    }
    const userToken = await userTokenFrom(req);
    const collections = [];
    const errors = [];
    let authFailed = false;
    for (const raw of urls) {
      try {
        collections.push(await resolveCollection(raw, userToken));
      } catch (e) {
        if (/reconnecte-toi|expirée|scope/i.test(e.message || '')) authFailed = true;
        errors.push({ url: String(raw).slice(0, 300), message: e.message });
      }
    }
    if (authFailed && collections.length === 0) {
      destroySession(req);
      return res.status(401).json({ error: 'Session expirée — reconnecte-toi avec Spotify', relogin: true });
    }
    res.json({ collections, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/library-collection', async (req, res) => {
  try {
    const token = await userTokenFrom(req);
    if (!token) return res.status(401).json({ error: 'Non connecté' });
    const { kind } = req.body || {};
    if (kind === 'liked') {
      const col = await fetchLikedTracksCollection(token);
      return res.json({ collection: col });
    }
    return res.status(400).json({ error: 'Type inconnu' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/zip', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(500).json({
        error: 'Configurez SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET dans le fichier .env',
      });
    }
    const { selections, options = {} } = req.body || {};
    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({ error: 'Sélection vide' });
    }
    if (selections.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 collections par ZIP' });
    }
    const userToken = await userTokenFrom(req);
    const collections = [];
    for (const sel of selections) {
      let col;
      if (sel.type === 'liked') {
        col = await fetchLikedTracksCollection(userToken);
      } else if (sel.type === 'manual') {
        const tracks = await fetchTracksByIds(sel.trackIds || [], userToken);
        col = {
          type: 'manual',
          id: 'manual',
          name: 'Sélection manuelle',
          description: 'Titres ajoutés via la recherche',
          cover: null,
          owner: '',
          trackTotal: tracks.length,
          tracks,
        };
      } else {
        col = await fetchCollection(String(sel.type), String(sel.id), userToken);
        if (Array.isArray(sel.trackIds)) {
          const want = new Set(sel.trackIds.map(String));
          col.tracks = col.tracks.filter((t) => want.has(String(t.id)));
        }
      }
      if (col.tracks.length > 0) collections.push(col);
    }
    if (collections.length === 0) {
      return res.status(400).json({ error: 'Aucun titre sélectionné' });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `spotload_export_${stamp}.zip`;
    const tmpPath = path.join(os.tmpdir(), `spotload_${process.pid}_${Date.now()}.zip`);

    try {
      const out = fs.createWriteStream(tmpPath);
      await writeZip(collections, options, out);
      const size = fs.statSync(tmpPath).size;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(tmpPath);
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.pipe(res);
      });
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  } catch (e) {
    console.error('ZIP error:', e);
    if (res.headersSent) return res.destroy(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/spotdl/status', async (req, res) => {
  const available = await spotdl.isAvailable();
  res.json({ available, version: available ? spotdl.versionCached() : null });
});

app.post('/api/spotdl/start', async (req, res) => {
  try {
    const available = await spotdl.isAvailable();
    if (!available) {
      return res.status(500).json({
        error: 'spotDL n\'est pas installé. Installe avec : pip install spotDL (et ffmpeg dans le PATH)',
      });
    }
    const { urls, format = 'mp3', bitrate = 'auto' } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Aucune URL fournie' });
    }
    if (urls.length > 25) {
      return res.status(400).json({ error: 'Maximum 25 URLs par téléchargement' });
    }
    const valid = /^https:\/\/open\.spotify\.com\/(track|album|playlist)\//;
    const validUri = /^spotify:(track|album|playlist):/;
    for (const u of urls) {
      const s = String(u);
      if (!valid.test(s) && !validUri.test(s)) {
        return res.status(400).json({ error: `URL Spotify invalide : ${s.slice(0, 120)}` });
      }
    }
    spotdl.cleanupOld();
    const job = spotdl.createJob(urls.map(String), { format, bitrate });
    res.json({ jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/spotdl/job/:id', (req, res) => {
  const job = spotdl.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Téléchargement introuvable ou expiré' });
  res.json(job);
});

app.get('/api/spotdl/file/:id', async (req, res) => {
  const job = spotdl.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Téléchargement introuvable' });
  if (job.status !== 'done' && job.status !== 'partial') {
    return res.status(409).json({ error: 'Le téléchargement n\'est pas terminé' });
  }
  const files = spotdl.getJobFiles(req.params.id);
  if (files.length === 0) return res.status(404).json({ error: 'Aucun fichier téléchargé' });
  const archiver = require('archiver');
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="spotload_audio_${stamp}.zip"`);
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); else res.destroy(err); });
  archive.pipe(res);
  for (const f of files) archive.file(f.path, { name: f.name });
  const manifest = {
    tool: 'spotDL',
    format: job.options.format || 'mp3',
    bitrate: job.options.bitrate || 'auto',
    urls: job.urls,
    downloadedAt: new Date().toISOString(),
    files: files.map((f) => ({ name: f.name, size: f.size })),
    partial: job.partial,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  await archive.finalize();
  setTimeout(() => spotdl.cleanup(req.params.id), 10000);
});

app.listen(PORT, () => {
  console.log(`SpotLoad ready → http://localhost:${PORT}`);
  console.log(`OAuth callback → http://127.0.0.1:${PORT}/callback`);
  if (!isConfigured()) {
    console.log('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing — copy .env.example to .env');
  }
  spotdl.detect().then((c) => {
    console.log(c ? `spotDL ready → ${c.cmd} ${c.prefix.join(' ')}` : 'spotDL not installed (audio download disabled)');
  }).catch(() => {});
});
