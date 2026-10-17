const crypto = require('crypto');

const sessions = new Map();

const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

function redirectUri() {
  if (process.env.REDIRECT_URI) return process.env.REDIRECT_URI;
  const port = process.env.PORT || 3000;
  return `http://127.0.0.1:${port}/callback`;
}

function createSession(req) {
  const sid = crypto.randomBytes(24).toString('hex');
  const session = { sid, accessToken: null, refreshToken: null, expiresAt: 0, user: null, state: null };
  sessions.set(sid, session);
  req.res.cookie('sid', sid, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
  return session;
}

function getSession(req) {
  const sid = req.cookies && req.cookies.sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function getOrCreateSession(req) {
  return getSession(req) || createSession(req);
}

function destroySession(req) {
  const sid = req.cookies && req.cookies.sid;
  if (sid) sessions.delete(sid);
  req.res.clearCookie('sid', { path: '/' });
}

function buildAuthUrl(session) {
  const state = crypto.randomBytes(16).toString('hex');
  session.state = state;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function spotifyTokenRequest(body) {
  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Échange de token échoué (${res.status}) : ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function exchangeCode(session, code) {
  const data = await spotifyTokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  session.accessToken = data.access_token;
  session.refreshToken = data.refresh_token;
  session.expiresAt = Date.now() + data.expires_in * 1000;
  return data;
}

async function getValidAccessToken(session) {
  if (!session || !session.accessToken) return null;
  if (Date.now() < session.expiresAt - 60000) return session.accessToken;
  if (!session.refreshToken) return null;
  try {
    const data = await spotifyTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    });
    session.accessToken = data.access_token;
    if (data.refresh_token) session.refreshToken = data.refresh_token;
    session.expiresAt = Date.now() + data.expires_in * 1000;
    return session.accessToken;
  } catch {
    session.accessToken = null;
    session.refreshToken = null;
    return null;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.expiresAt && now > s.expiresAt + 7 * 24 * 3600 * 1000) sessions.delete(sid);
  }
}, 3600 * 1000).unref();

module.exports = {
  getOrCreateSession,
  getSession,
  destroySession,
  buildAuthUrl,
  exchangeCode,
  getValidAccessToken,
  redirectUri,
};
