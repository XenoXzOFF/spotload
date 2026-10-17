const state = {
  collections: [],
  loading: false,
  zipping: false,
  user: null,
  library: null,
  searchResults: [],
  detail: null,
};

const PAGE_SIZES = [10, 20, 30, 40, 50, 100, 250];
const MAX_VISIBLE = 250;

const els = {
  input: document.getElementById('url-input'),
  addBtn: document.getElementById('add-btn'),
  addStatus: document.getElementById('add-status'),
  errors: document.getElementById('errors'),
  collections: document.getElementById('collections'),
  emptyState: document.getElementById('empty-state'),
  bottomBar: document.getElementById('bottom-bar'),
  selectedCount: document.getElementById('selected-count'),
  selectAll: document.getElementById('select-all'),
  selectNone: document.getElementById('select-none'),
  zipBtn: document.getElementById('zip-btn'),
  progressArea: document.getElementById('progress-area'),
  progressFill: document.getElementById('progress-fill'),
  progressLabel: document.getElementById('progress-label'),
  progressText: document.getElementById('progress-text'),
  optCsv: document.getElementById('opt-csv'),
  optJson: document.getElementById('opt-json'),
  optM3u: document.getElementById('opt-m3u'),
  optCovers: document.getElementById('opt-covers'),
  authArea: document.getElementById('auth-area'),
  librarySection: document.getElementById('library-section'),
  libPlaylists: document.getElementById('lib-playlists'),
  libAlbums: document.getElementById('lib-albums'),
  libLiked: document.getElementById('lib-liked'),
  libRefresh: document.getElementById('lib-refresh'),
  banner: document.getElementById('banner'),
  searchInput: document.getElementById('search-input'),
  searchBtn: document.getElementById('search-btn'),
  searchStatus: document.getElementById('search-status'),
  searchResults: document.getElementById('search-results'),
  detailOverlay: document.getElementById('detail-overlay'),
  detailBadge: document.getElementById('detail-badge'),
  detailTitle: document.getElementById('detail-title'),
  detailDesc: document.getElementById('detail-desc'),
  detailClose: document.getElementById('detail-close'),
  detailAll: document.getElementById('detail-all'),
  detailNone: document.getElementById('detail-none'),
  detailCount: document.getElementById('detail-count'),
  detailTbody: document.getElementById('detail-tbody'),
  pageSize: document.getElementById('page-size'),
  pagePrev: document.getElementById('page-prev'),
  pageNext: document.getElementById('page-next'),
  pageInfo: document.getElementById('page-info'),
};

const TYPE_LABELS = { playlist: 'Playlist', album: 'Album', artist: 'Artiste', track: 'Titre', liked: 'Likés', manual: 'Manuel' };

function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colKey(c) {
  return `${c.type}:${c.id}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function showBanner(msg, type) {
  els.banner.textContent = msg;
  els.banner.className = `banner ${type}`;
  setTimeout(() => els.banner.classList.add('hidden'), 6000);
}

function setStatus(msg, isError = false, isOk = false) {
  els.addStatus.textContent = msg;
  els.addStatus.classList.toggle('error', isError);
  els.addStatus.classList.toggle('ok', isOk && !isError);
  if (isOk || isError) {
    setTimeout(() => {
      if (els.addStatus.textContent === msg) setStatus('');
    }, 5000);
  }
}

function initFromUrl() {
  const params = new URLSearchParams(location.search);
  if (params.get('login') === 'ok') showBanner('Connecté avec succès !', 'ok');
  const err = params.get('error');
  if (err) {
    const messages = {
      config: "Configure d'abord .env (Client ID / Secret) puis relance le serveur.",
      state_mismatch: 'Session expirée pendant la connexion — réessaie.',
      access_denied: 'Connexion annulée sur Spotify.',
    };
    showBanner(messages[err] || `Erreur de connexion : ${err}`, 'error');
  }
  if (params.toString()) history.replaceState(null, '', '/');
}

async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    state.user = data.user;
    renderAuth();
    if (state.user) loadLibrary();
  } catch {
    state.user = null;
    renderAuth();
  }
}

function renderAuth() {
  if (state.user) {
    const u = state.user;
    els.authArea.innerHTML = `
      <div class="user-chip">
        ${u.image ? `<img src="${escapeHtml(u.image)}" alt="">` : ''}
        <span title="${escapeHtml(u.displayName)}">${escapeHtml(u.displayName)}</span>
        <button id="logout-btn" class="btn btn-ghost btn-sm">Déconnexion</button>
      </div>
    `;
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await fetch('/auth/logout', { method: 'POST' });
      state.user = null;
      state.library = null;
      els.librarySection.classList.add('hidden');
      renderAuth();
    });
  } else {
    els.authArea.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'btn btn-spotify btn-sm';
    btn.textContent = 'Se connecter avec Spotify';
    btn.addEventListener('click', () => (window.location.href = '/auth/login'));
    els.authArea.appendChild(btn);
  }
}

async function loadLibrary() {
  els.libRefresh.disabled = true;
  els.libRefresh.textContent = 'Chargement…';
  try {
    const res = await fetch('/api/library');
    if (!res.ok) return;
    state.library = await res.json();
    renderLibrary();
  } catch {
  } finally {
    els.libRefresh.disabled = false;
    els.libRefresh.textContent = 'Rafraîchir';
  }
}

function renderLibrary() {
  const lib = state.library;
  if (!lib) return;
  els.librarySection.classList.remove('hidden');

  els.libPlaylists.innerHTML = lib.playlists.length ? '' : '<p class="hint">Aucune playlist trouvée</p>';
  lib.playlists.forEach((p, i) => {
    els.libPlaylists.appendChild(
      libItem({
        key: `playlist:${p.id}`,
        cover: p.cover,
        name: p.name,
        meta: `${p.owner} · ${p.trackTotal} titre(s)${p.public === false ? ' · privée' : ''}`,
        add: () => addFromLibrary('playlist', p.id),
        delay: i * 0.03,
      })
    );
  });

  els.libAlbums.innerHTML = lib.albums.length ? '' : '<p class="hint">Aucun album enregistré</p>';
  lib.albums.forEach((a, i) => {
    els.libAlbums.appendChild(
      libItem({
        key: `album:${a.id}`,
        cover: a.cover,
        name: a.name,
        meta: `${a.artists} · ${a.releaseDate?.slice(0, 4) || ''} · ${a.trackTotal} piste(s)`,
        add: () => addFromLibrary('album', a.id),
        delay: i * 0.03,
      })
    );
  });

  els.libLiked.innerHTML = '';
  if (lib.likedTotal > 0) {
    els.libLiked.appendChild(
      libItem({
        key: 'liked:liked',
        cover: null,
        name: 'Titres likés',
        meta: `${lib.likedTotal} titre(s)`,
        add: async () => {
          setStatus('Chargement des titres likés…');
          try {
            const res = await fetch('/api/library-collection', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'liked' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            mergeCollection(data.collection);
            setStatus(`${data.collection.tracks.length} titres likés ajoutés.`, false, true);
          } catch (e) {
            setStatus(e.message, true);
          }
        },
        delay: 0,
      })
    );
  } else {
    els.libLiked.innerHTML = '<p class="hint">Aucun titre liké</p>';
  }

  updateLibAddedState();
}

function libItem({ key, cover, name, meta, add, delay }) {
  const div = document.createElement('div');
  div.className = 'lib-item';
  div.dataset.key = key;
  div.style.animationDelay = `${delay}s`;
  div.innerHTML = `
    ${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy">` : '<div class="lib-placeholder">♪</div>'}
    <div class="lib-info">
      <strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
      <span>${escapeHtml(meta)}</span>
    </div>
    <button class="lib-add" title="Ajouter à la sélection">+</button>
  `;
  const btn = div.querySelector('.lib-add');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await add();
    } finally {
      btn.disabled = false;
      updateLibAddedState();
    }
  });
  return div;
}

function updateLibAddedState() {
  document.querySelectorAll('.lib-item').forEach((item) => {
    const btn = item.querySelector('.lib-add');
    if (!btn) return;
    const added = state.collections.some((c) => colKey(c) === item.dataset.key);
    btn.classList.toggle('added', added);
    btn.textContent = added ? '✓' : '+';
    btn.title = added ? 'Déjà dans la sélection' : 'Ajouter à la sélection';
  });
}

async function addFromLibrary(type, id) {
  setStatus('Ajout depuis la bibliothèque…');
  try {
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [`spotify:${type}:${id}`] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.collections.length) {
      mergeCollection(data.collections[0]);
      setStatus(`« ${data.collections[0].name} » ajouté.`, false, true);
    }
    if (data.errors.length) setStatus(data.errors[0].message, true);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function mergeCollection(col) {
  const key = colKey(col);
  const existing = state.collections.find((c) => colKey(c) === key);
  if (existing) {
    Object.assign(existing, col);
    const validIds = new Set(col.tracks.map((t) => String(t.id)));
    existing.selected = new Set([...existing.selected].filter((id) => validIds.has(id)));
    if (existing.selected.size === 0) {
      col.tracks.forEach((t) => existing.selected.add(String(t.id)));
    }
  } else {
    state.collections.push({
      ...col,
      selected: new Set(col.tracks.map((t) => String(t.id))),
    });
  }
  render();
}

async function addCollections() {
  const url = els.input.value.trim();
  if (!url) {
    setStatus('Colle un lien Spotify.');
    return;
  }
  state.loading = true;
  els.addBtn.disabled = true;
  setStatus('Récupération depuis Spotify…');
  els.errors.classList.add('hidden');
  try {
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    if (data.collections.length) {
      mergeCollection(data.collections[0]);
      els.input.value = '';
      setStatus(`« ${data.collections[0].name} » ajouté (${data.collections[0].tracks.length} titres).`, false, true);
    }
    if (data.errors.length) {
      els.errors.innerHTML = data.errors
        .map((e) => `<p>Échec : <strong>${escapeHtml(e.url)}</strong> — <span>${escapeHtml(e.message)}</span></p>`)
        .join('');
      els.errors.classList.remove('hidden');
      setStatus(data.errors[0].message, true);
    }
    els.input.focus();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    state.loading = false;
    els.addBtn.disabled = false;
  }
}

async function doSearch() {
  const q = els.searchInput.value.trim();
  if (q.length < 2) {
    els.searchStatus.textContent = 'Entre au moins 2 caractères.';
    els.searchStatus.className = 'status';
    return;
  }
  els.searchBtn.disabled = true;
  els.searchStatus.textContent = 'Recherche en cours…';
  els.searchStatus.className = 'status';
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.searchResults = data.tracks;
    renderSearchResults();
    els.searchStatus.textContent = `${data.tracks.length} résultat(s)`;
    els.searchStatus.className = 'status ok';
  } catch (e) {
    els.searchStatus.textContent = e.message;
    els.searchStatus.className = 'status error';
  } finally {
    els.searchBtn.disabled = false;
  }
}

function getManualCollection() {
  let col = state.collections.find((c) => c.type === 'manual' && c.id === 'manual');
  if (!col) {
    col = {
      type: 'manual',
      id: 'manual',
      name: 'Sélection manuelle',
      description: 'Titres ajoutés via la recherche',
      cover: null,
      owner: '',
      trackTotal: 0,
      tracks: [],
      selected: new Set(),
    };
    state.collections.push(col);
  }
  return col;
}

function addManualTrack(track) {
  const col = getManualCollection();
  const id = String(track.id);
  if (col.tracks.some((t) => String(t.id) === id)) return false;
  col.tracks.push(track);
  col.trackTotal = col.tracks.length;
  col.selected.add(id);
  render();
  return true;
}

function renderSearchResults() {
  if (!state.searchResults.length) {
    els.searchResults.classList.add('hidden');
    els.searchResults.innerHTML = '';
    return;
  }
  els.searchResults.classList.remove('hidden');
  els.searchResults.innerHTML = '';
  const manual = state.collections.find((c) => c.type === 'manual');
  state.searchResults.forEach((t, i) => {
    const added = manual && manual.tracks.some((x) => String(x.id) === String(t.id));
    const div = document.createElement('div');
    div.className = 'lib-item';
    div.style.animationDelay = `${Math.min(i, 20) * 0.02}s`;
    div.innerHTML = `
      ${t.cover ? `<img src="${escapeHtml(t.cover)}" alt="" loading="lazy">` : '<div class="lib-placeholder">♪</div>'}
      <div class="lib-info">
        <strong title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</strong>
        <span>${escapeHtml(t.artists)}${t.album ? ' · ' + escapeHtml(t.album) : ''} · ${formatDuration(t.durationMs)}</span>
      </div>
      <button class="lib-add ${added ? 'added' : ''}" title="${added ? 'Déjà ajouté' : 'Ajouter à la sélection'}">${added ? '✓' : '+'}</button>
    `;
    div.querySelector('.lib-add').addEventListener('click', () => {
      if (addManualTrack(t)) {
        div.querySelector('.lib-add').classList.add('added');
        div.querySelector('.lib-add').textContent = '✓';
        div.querySelector('.lib-add').title = 'Déjà ajouté';
        setStatus(`« ${t.name} » ajouté.`, false, true);
      }
    });
    els.searchResults.appendChild(div);
  });
}

function toggleTrack(col, trackId, checked) {
  if (checked) col.selected.add(trackId);
  else col.selected.delete(trackId);
  render();
  if (state.detail) renderDetailTable();
  els.selectedCount.classList.add('bump');
  setTimeout(() => els.selectedCount.classList.remove('bump'), 300);
}

function setCollectionSelection(col, all) {
  if (all) col.tracks.forEach((t) => col.selected.add(String(t.id)));
  else col.selected.clear();
  render();
  if (state.detail) renderDetailTable();
}

function removeCollection(key) {
  state.collections = state.collections.filter((c) => colKey(c) !== key);
  if (state.detail && colKey(state.detail.col) === key) closeDetail();
  render();
}

function selectAll() {
  state.collections.forEach((c) => c.tracks.forEach((t) => c.selected.add(String(t.id))));
  render();
  if (state.detail) renderDetailTable();
}

function selectNone() {
  state.collections.forEach((c) => c.selected.clear());
  render();
  if (state.detail) renderDetailTable();
}

function openDetail(col) {
  state.detail = { col, page: 1, pageSize: 50 };
  els.detailBadge.textContent = TYPE_LABELS[col.type] || col.type;
  els.detailTitle.textContent = col.name;
  els.detailDesc.textContent = [col.description || col.owner, `${col.tracks.length} titre(s)`].filter(Boolean).join(' · ');
  els.detailOverlay.classList.remove('hidden');
  renderDetailTable();
}

function closeDetail() {
  state.detail = null;
  els.detailOverlay.classList.add('hidden');
}

function visibleTracks() {
  const d = state.detail;
  return d.col.tracks.slice(0, MAX_VISIBLE);
}

function renderDetailTable() {
  const d = state.detail;
  if (!d) return;
  const tracks = visibleTracks();
  const total = tracks.length;
  const size = d.pageSize >= total ? total : d.pageSize;
  const pages = Math.max(1, Math.ceil(total / size));
  if (d.page > pages) d.page = pages;
  const start = (d.page - 1) * size;
  const pageTracks = tracks.slice(start, start + size);

  els.detailCount.textContent = `${d.col.selected.size}/${d.col.tracks.length} sélectionné(s)`;
  els.detailCount.classList.toggle('has-selection', d.col.selected.size > 0);
  els.pageInfo.textContent = `Page ${d.page}/${pages}`;
  els.pagePrev.disabled = d.page <= 1;
  els.pageNext.disabled = d.page >= pages;

  els.detailTbody.innerHTML = '';
  pageTracks.forEach((t, i) => {
    const id = String(t.id);
    const checked = d.col.selected.has(id);
    const tr = document.createElement('tr');
    if (!checked) tr.className = 'unselected';
    tr.style.animationDelay = `${Math.min(i, 25) * 0.015}s`;
    tr.innerHTML = `
      <td><input type="checkbox" ${checked ? 'checked' : ''}></td>
      <td class="num">${start + i + 1}</td>
      <td class="track-title">${
        t.url ? `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a>` : escapeHtml(t.name)
      }</td>
      <td class="track-artists">${escapeHtml(t.artists)}</td>
      <td class="track-album">${escapeHtml(t.album)}</td>
      <td class="dur">${formatDuration(t.durationMs)}</td>
    `;
    tr.querySelector('input').addEventListener('change', (e) => toggleTrack(d.col, id, e.target.checked));
    els.detailTbody.appendChild(tr);
  });
}

function render() {
  const hasCols = state.collections.length > 0;
  els.emptyState.classList.toggle('hidden', hasCols);
  els.bottomBar.classList.toggle('hidden', !hasCols);

  els.collections.innerHTML = '';
  state.collections.forEach((col) => {
    els.collections.appendChild(renderCollection(col));
  });

  const total = state.collections.reduce((n, c) => n + c.selected.size, 0);
  els.selectedCount.textContent = total;
  els.zipBtn.disabled = total === 0 || state.zipping;
  updateLibAddedState();
  renderSearchResults();
}

function renderCollection(col) {
  const key = colKey(col);
  const section = document.createElement('section');
  section.className = 'collection';

  const selectedCount = col.selected.size;
  const totalCount = col.tracks.length;
  const label = TYPE_LABELS[col.type] || col.type;

  const header = document.createElement('div');
  header.className = 'col-header';
  header.innerHTML = `
    ${
      col.cover
        ? `<img class="col-cover" src="${escapeHtml(col.cover)}" alt="" loading="lazy">`
        : `<div class="col-cover placeholder">♪</div>`
    }
    <div class="col-meta">
      <span class="badge">${escapeHtml(label)}</span>
      <h3 title="${escapeHtml(col.name)}">${escapeHtml(col.name)}</h3>
      <p>${escapeHtml(col.description || col.owner || '')} · ${totalCount} titre(s)</p>
    </div>
    <div class="col-controls">
      <span class="col-count ${selectedCount > 0 ? 'has-selection' : ''}">${selectedCount}/${totalCount}</span>
      <button class="btn btn-primary btn-tiny" data-action="detail">Voir les titres</button>
      <button class="btn btn-ghost btn-tiny" data-action="remove" title="Retirer">✕</button>
    </div>
  `;
  header.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'detail') {
      e.stopPropagation();
      openDetail(col);
    } else if (action === 'remove') {
      e.stopPropagation();
      removeCollection(key);
    } else if (!e.target.closest('button')) {
      openDetail(col);
    }
  });
  section.appendChild(header);
  return section;
}

function setProgress(pct, text) {
  const clamped = Math.max(0, Math.min(100, pct));
  els.progressFill.classList.remove('indeterminate');
  els.progressFill.style.width = `${clamped}%`;
  els.progressLabel.textContent = `${Math.round(clamped)}%`;
  if (text) els.progressText.textContent = text;
}

function setIndeterminate(text) {
  els.progressFill.classList.add('indeterminate');
  els.progressFill.style.width = '';
  els.progressLabel.textContent = '…';
  els.progressText.textContent = text;
}

async function downloadZip() {
  const selections = state.collections
    .map((c) => ({
      type: c.type,
      id: c.id,
      trackIds: [...c.selected],
    }))
    .filter((s) => s.trackIds.length > 0);
  if (!selections.length) return;

  state.zipping = true;
  els.zipBtn.disabled = true;
  els.progressArea.classList.remove('hidden');
  setIndeterminate('Préparation du ZIP sur le serveur…');
  try {
    const res = await fetch('/api/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selections,
        options: {
          csv: els.optCsv.checked,
          json: els.optJson.checked,
          m3u: els.optM3u.checked,
          covers: els.optCovers.checked,
        },
      }),
    });
    if (!res.ok) {
      let msg = `Erreur ${res.status}`;
      try {
        const data = await res.json();
        if (data.error) msg = data.error;
      } catch {
      }
      throw new Error(msg);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const filename =
      (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/)?.[1] || 'spotload_export.zip';

    let blob;
    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        setProgress((received / total) * 100, `Téléchargement… ${formatBytes(received)} / ${formatBytes(total)}`);
      }
      setProgress(100, 'Terminé !');
      blob = new Blob(chunks, { type: 'application/zip' });
    } else {
      setIndeterminate('Téléchargement…');
      blob = await res.blob();
      setProgress(100, 'Terminé !');
    }

    await new Promise((r) => setTimeout(r, 400));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showBanner(`Échec du téléchargement : ${e.message}`, 'error');
  } finally {
    state.zipping = false;
    setTimeout(() => {
      els.progressArea.classList.add('hidden');
      els.progressFill.style.width = '0%';
    }, 600);
    render();
  }
}

els.addBtn.addEventListener('click', addCollections);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addCollections();
  }
});
els.searchBtn.addEventListener('click', doSearch);
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doSearch();
  }
});
els.libRefresh.addEventListener('click', loadLibrary);
els.selectAll.addEventListener('click', selectAll);
els.selectNone.addEventListener('click', selectNone);
els.zipBtn.addEventListener('click', downloadZip);
els.detailClose.addEventListener('click', closeDetail);
els.detailOverlay.addEventListener('click', (e) => {
  if (e.target === els.detailOverlay) closeDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.detail) closeDetail();
});
els.detailAll.addEventListener('click', () => setCollectionSelection(state.detail.col, true));
els.detailNone.addEventListener('click', () => setCollectionSelection(state.detail.col, false));
els.pageSize.addEventListener('change', () => {
  state.detail.pageSize = Number(els.pageSize.value);
  state.detail.page = 1;
  renderDetailTable();
});
els.pagePrev.addEventListener('click', () => {
  state.detail.page--;
  renderDetailTable();
});
els.pageNext.addEventListener('click', () => {
  state.detail.page++;
  renderDetailTable();
});

initFromUrl();
checkAuth();
render();
