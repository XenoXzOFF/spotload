<p align="center">
  <img src="assets/banner.svg" alt="SpotLoad banner" width="100%"/>
</p>

<h1 align="center">SpotLoad</h1>

<p align="center">
  Export your Spotify playlists, albums &amp; tracks into a single ZIP — metadata, covers, CSV, JSON, M3U.
</p>

<p align="center">
  <a href="README.fr.md"><img src="https://img.shields.io/badge/langue-fran%C3%A7ais-green?style=flat-square" alt="Français"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node.js >= 18"/>
  <img src="https://img.shields.io/badge/status-stable-1db954?style=flat-square" alt="Status stable"/>
</p>

---

## Table of contents

- [About](#about)
- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Spotify app setup](#spotify-app-setup)
- [Usage](#usage)
- [ZIP contents](#zip-contents)
- [API endpoints](#api-endpoints)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)
- [Credits](#credits)

---

## About

**SpotLoad** is a self-hosted web app that lets you browse your Spotify library and export any selection of playlists, albums, liked tracks or individual songs into **one single ZIP file**.

The ZIP contains rich **metadata** (CSV / JSON), **M3U playlists**, and optionally **album covers** — ready for your music manager, spreadsheet, or archive.

> SpotLoad does **not** download audio files. Spotify streams are DRM-protected and the official API does not provide any audio download. SpotLoad exports metadata, links and artwork only.

---

## Features

- Paste **any Spotify link** — playlists, albums, artists, tracks (URL or `spotify:track:…`)
- Add links **one at a time** or bulk
- **Connect with Spotify** to access your private playlists, saved albums & liked tracks
- **Search** any song on Spotify and add it to your selection with a single click
- **Library browser** with a refresh button — playlists (private included), saved albums, liked songs
- **Detailed track view** with pagination — display 10 / 20 / 30 / 40 / 50 / 100 / all tracks (capped at 250 per view)
- **Select / deselect** per track, per collection, or globally (select all / deselect all)
- Combine **multiple playlists, albums & tracks into one ZIP**
- ZIP contents (togglable): **CSV**, **JSON**, **M3U**, **album covers**
- Real-time **download progress bar with percentage**
- Smooth dark UI built with the **Unbounded** typeface
- Fully **self-hosted** — your credentials and sessions never leave your machine

---

## Screenshots

| Main view | Library & search | Track detail & progress |
|:---:|:---:|:---:|
| Paste links, search songs, build your selection | Connect with Spotify, browse your library, refresh anytime | Paginated track list (10–250), live ZIP progress with % |

---

## Quick start

### Requirements

- **Node.js** ≥ 18
- A **Spotify account** (free or Premium)
- A free **Spotify Developer app** (see below)

### Install

```bash
git clone https://github.com/XenoXzOFF/spotload.git
cd spotload
npm install
cp .env.example .env
```

### Configure

Open `.env` and fill in your Spotify credentials:

```env
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
PORT=3000
MARKET=FR
```

### Run

```bash
npm start
```

Open **http://localhost:3000** 🎧

---

## Spotify app setup

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Fill in any name & description
4. Add this **Redirect URI** exactly:
   ```
   http://127.0.0.1:3000/callback
   ```
   > ⚠️ Spotify rejects `localhost` since 2025 — use `127.0.0.1` instead.
5. In **Product completion**, enable **Web API**
6. Save, then copy the **Client ID** and **Client Secret** into your `.env`

---

## Usage

1. **Paste a link** (playlist, album, artist or track) and click **Ajouter** — or press Enter
2. **Search a song** by title / artist and click **+** to add it manually
3. **Connect with Spotify** (top right) to unlock your private playlists, saved albums & liked tracks
4. **Click a collection** to open the detailed track view — choose how many tracks to display (10 → 250), tick what you want
5. Use **Tout sélectionner / Tout désélectionner** globally or per collection
6. Pick your ZIP options (CSV / JSON / M3U / Covers)
7. Click **Télécharger le ZIP** and watch the progress bar

---

## ZIP contents

```
spotload_export_2026-01-01.zip
├── 01 - Playlist - My Playlist/
│   ├── tracks.json
│   ├── tracks.csv
│   ├── tracks.m3u
│   ├── cover.jpg
│   └── covers/
│       ├── 01 - Artist - Song.jpg
│       └── …
├── 02 - Album - Some Album/
│   └── …
├── 00_tous_les_titres.csv
└── 00_tous_les_titres.json
```

| File | Format | Content |
|---|---|---|
| `tracks.csv` | CSV (UTF-8 BOM) | #, title, artists, album, release date, duration, ISRC, popularity, Spotify URL, preview URL, cover URL |
| `tracks.json` | JSON | Full track objects + collection metadata |
| `tracks.m3u` | M3U | Playlist with durations & Spotify links |
| `cover.jpg` | JPEG | Collection artwork |
| `covers/` | JPEG | Per-track album artwork (optional) |
| `00_tous_les_titres.*` | CSV / JSON | Flat list of every selected track across all collections |

---

## API endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Server configuration status |
| `GET` | `/auth/login` | Start Spotify OAuth flow |
| `GET` | `/callback` | OAuth redirect handler |
| `POST` | `/auth/logout` | Destroy session |
| `GET` | `/api/me` | Current Spotify user (or `null`) |
| `GET` | `/api/library` | User playlists, saved albums, liked count |
| `GET` | `/api/search?q=` | Search tracks |
| `POST` | `/api/collections` | Resolve URLs → full collections with tracks |
| `POST` | `/api/library-collection` | Fetch liked-songs collection |
| `POST` | `/api/zip` | Build & download ZIP of selected tracks |

---

## Project structure

```
spotload/
├── server.js              Express server + API routes
├── src/
│   ├── auth.js            OAuth (Authorization Code), sessions, token refresh
│   ├── spotify.js         Spotify Web API client (playlists, albums, search, library)
│   ├── zip.js             ZIP builder (archiver) — CSV, JSON, M3U, covers
│   └── util.js            URL parsing, filename sanitizing, CSV helpers
├── public/
│   ├── index.html         Frontend shell
│   ├── app.js             UI logic (minified)
│   └── style.css          Styles (minified)
├── .env.example           Environment template
└── package.json
```

---

## Tech stack

- **Backend** — Node.js, Express, cookie-parser, archiver, dotenv
- **Frontend** — Vanilla JS, CSS animations, [Unbounded](https://fonts.google.com/specimen/Unbounded) (Google Fonts)
- **API** — [Spotify Web API](https://developer.spotify.com/documentation/web-api) (OAuth 2.0 + Client Credentials)

---

## Contributing

Contributions are welcome! Feel free to open an issue or a pull request.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m "Add my feature"`
4. Push and open a Pull Request

---

## License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

---

## Credits

Created by **[XenoXzOFF](https://github.com/XenoXzOFF)** with ❤️

<p align="center">
  <a href="https://github.com/XenoXzOFF">
    <img src="https://img.shields.io/badge/GitHub-XenoXzOFF-181818?style=for-the-badge&logo=github&logoColor=white" alt="GitHub XenoXzOFF"/>
  </a>
</p>
