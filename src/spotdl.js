const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.wav', '.webm', '.aac']);
const TMP_BASE = path.join(os.tmpdir(), 'spotload-audio');

class SpotDLService {
  constructor() {
    this._cmd = null;
    this._ver = null;
    this._detectP = null;
    this._jobs = new Map();
    fs.mkdirSync(TMP_BASE, { recursive: true });
  }

  detect() {
    if (this._cmd !== null) return Promise.resolve(this._cmd);
    if (!this._detectP) {
      this._detectP = this._doDetect().then((c) => {
        this._cmd = c || false;
        if (c) this._run(c.cmd, [...c.prefix, '--version'], 30000).then((v) => { this._ver = v; }).catch(() => {});
        return this._cmd;
      });
    }
    return this._detectP;
  }

  async _doDetect() {
    const m = (cmd) => ({ cmd, prefix: ['-m', 'spotdl'] });
    const pathCands = [
      { cmd: 'spotdl', prefix: [] },
      m('python'), m('python3'),
      { cmd: 'py', prefix: ['-3', '-m', 'spotdl'] },
    ];
    const found = await this._anyOk(pathCands);
    if (found) return found;
    return this._anyOk(this._pythonHomes().map((py) => m(py)));
  }

  _anyOk(cands) {
    if (!cands.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let pending = cands.length;
      for (const c of cands) {
        this._probe(c.cmd, [...c.prefix, '--version']).then((ok) => {
          if (ok) resolve(c);
          else if (--pending === 0) resolve(null);
        });
      }
    });
  }

  _pythonHomes() {
    const roots = [];
    const glob = (base) => {
      try {
        for (const e of fs.readdirSync(base)) {
          if (/^Python\d+/i.test(e)) roots.push(path.join(base, e));
        }
      } catch {}
    };
    glob('C:\\');
    glob('C:\\Program Files');
    glob(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'));
    return roots
      .map((r) => path.join(r, 'python.exe'))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  }

  _env() {
    const env = { ...process.env };
    const extras = [];
    const probeFfmpeg = (dir) => {
      try { if (fs.statSync(path.join(dir, 'ffmpeg.exe')).isFile()) extras.push(dir); } catch {}
    };
    probeFfmpeg('C:\\ffmpeg\\bin');
    for (const root of ['C:\\ffmpeg', os.homedir()]) {
      try {
        for (const e of fs.readdirSync(root)) {
          if (/^ffmpeg/i.test(e)) probeFfmpeg(path.join(root, e, 'bin'));
        }
      } catch {}
    }
    if (extras.length && !(env.PATH || '').includes(extras[0])) env.PATH = `${extras.join(';')};${env.PATH || ''}`;
    return env;
  }

  async isAvailable() {
    const c = await this.detect();
    return Boolean(c);
  }

  versionCached() {
    return this._ver;
  }

  async version() {
    const c = await this.detect();
    if (!c) return null;
    if (this._ver) return this._ver;
    try {
      const v = await this._run(c.cmd, [...c.prefix, '--version'], 30000);
      this._ver = v;
      return v;
    } catch { return null; }
  }

  createJob(urls, options = {}) {
    const id = `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      status: 'queued',
      progress: { current: 0, total: 0, message: 'En file d\'attente…' },
      files: [],
      error: null,
      partial: false,
      dir: path.join(TMP_BASE, id),
      createdAt: Date.now(),
      urls,
      options,
    };
    fs.mkdirSync(job.dir, { recursive: true });
    this._jobs.set(id, job);
    this._execute(job).catch((e) => {
      job.status = 'error';
      job.error = e.message;
      job.progress.message = e.message;
    });
    return job;
  }

  getJob(id) {
    const j = this._jobs.get(id);
    if (!j) return null;
    return {
      id: j.id,
      status: j.status,
      progress: j.progress,
      fileCount: j.files.length,
      error: j.error,
      partial: j.partial,
      format: j.options?.format || 'mp3',
      bitrate: j.options?.bitrate || 'auto',
      totalBytes: j.files.reduce((s, f) => s + f.size, 0),
    };
  }

  getJobDir(id) {
    const j = this._jobs.get(id);
    return j ? j.dir : null;
  }

  getJobFiles(id) {
    const j = this._jobs.get(id);
    return j ? j.files : [];
  }

  async _execute(job) {
    const c = await this.detect();
    if (!c) throw new Error('spotDL n\'est pas installé. Installe avec : pip install spotDL');

    job.status = 'running';
    job.progress.message = 'Démarrage de spotDL…';

    const format = job.options.format || 'mp3';
    const bitrate = job.options.bitrate || 'auto';
    const template = path.join(job.dir, '{artist} - {title}.{output-ext}');

    const args = [
      ...c.prefix,
      'download',
      ...job.urls,
      '--output', template,
      '--format', format,
      '--bitrate', bitrate,
      '--print-errors',
      '--threads', '2',
      '--max-retries', '3',
      '--restrict', 'ascii',
    ];
    const ffmpeg = this._ffmpegPath();
    if (ffmpeg) args.push('--ffmpeg', ffmpeg);

    return new Promise((resolve, reject) => {
      const proc = spawn(c.cmd, args, { timeout: 900000, windowsHide: true, env: this._env() });
      let stderr = '';
      let stdout = '';
      let lastLine = '';

      proc.stdout.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          lastLine = t;
          const m = t.match(/(?:Downloading|Processing)\s+(\d+)\/(\d+)/i)
            || t.match(/(\d+)\/(\d+)\s+(?:tracks?|songs?)/i);
          if (m) {
            job.progress.current = parseInt(m[1], 10);
            job.progress.total = parseInt(m[2], 10);
          }
          job.progress.message = t.slice(0, 200);
        }
      });

      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        job.files = this._collect(job.dir);
        if (code !== 0 && job.files.length === 0) {
          const detail = (stderr || lastLine || '').slice(-600);
          job.status = 'error';
          job.error = `spotDL a échoué (code ${code}) : ${detail}`;
          reject(new Error(job.error));
          return;
        }
        job.status = code === 0 ? 'done' : 'partial';
        job.partial = code !== 0;
        if (code !== 0) job.error = (stderr || '').slice(-400) || null;
        job.progress.message = `${job.files.length} fichier(s) prêt(s)`;
        job.progress.current = job.files.length;
        job.progress.total = job.files.length;
        resolve();
      });

      proc.on('error', (e) => {
        job.status = 'error';
        job.error = `Impossible de lancer spotDL : ${e.message}`;
        reject(new Error(job.error));
      });
    });
  }

  _ffmpegPath() {
    if (this._ffmpeg !== undefined) return this._ffmpeg;
    const candidates = ['C:\\ffmpeg\\bin\\ffmpeg.exe'];
    const roots = ['C:\\ffmpeg', os.homedir(), 'C:\\'];
    for (const root of roots) {
      try {
        for (const e of fs.readdirSync(root)) {
          if (/^ffmpeg/i.test(e)) candidates.push(path.join(root, e, 'bin', 'ffmpeg.exe'));
        }
      } catch {}
    }
    for (const p of candidates) {
      try { if (fs.statSync(p).isFile()) { this._ffmpeg = p; return p; } } catch {}
    }
    this._ffmpeg = null;
    return null;
  }

  _collect(dir) {
    const out = [];
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
          try { out.push({ name: e.name, path: p, size: fs.statSync(p).size }); } catch {}
        }
      }
    };
    walk(dir);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  cleanup(id) {
    const j = this._jobs.get(id);
    if (!j) return;
    this._jobs.delete(id);
    try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch {}
  }

  cleanupOld(maxAgeMs = 3600000) {
    const now = Date.now();
    for (const [id, j] of this._jobs) {
      if (now - j.createdAt > maxAgeMs && (j.status === 'done' || j.status === 'error' || j.status === 'partial')) {
        this.cleanup(id);
      }
    }
  }

  _probe(cmd, args) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 15000, windowsHide: true, env: this._env() }, (err) => resolve(!err));
    });
  }

  _run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout, windowsHide: true, env: this._env() }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve((stdout || stderr || '').trim());
      });
    });
  }
}

module.exports = new SpotDLService();
