const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.wav', '.webm', '.aac']);
const TMP_BASE = path.join(os.tmpdir(), 'spotload-audio');

class SpotDLService {
  constructor() {
    this._cmd = null;
    this._jobs = new Map();
    fs.mkdirSync(TMP_BASE, { recursive: true });
  }

  async detect() {
    if (this._cmd !== null) return this._cmd;
    const candidates = [
      { cmd: 'spotdl', prefix: [] },
      { cmd: 'python', prefix: ['-m', 'spotdl'] },
      { cmd: 'python3', prefix: ['-m', 'spotdl'] },
      { cmd: 'py', prefix: ['-3', '-m', 'spotdl'] },
    ];
    for (const c of candidates) {
      const ok = await this._probe(c.cmd, [...c.prefix, '--version']);
      if (ok) { this._cmd = c; return c; }
    }
    this._cmd = false;
    return false;
  }

  async isAvailable() {
    const c = await this.detect();
    return Boolean(c);
  }

  async version() {
    const c = await this.detect();
    if (!c) return null;
    return this._run(c.cmd, [...c.prefix, '--version'], 15000);
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
    this._run(job).catch((e) => {
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

  async _run(job) {
    const c = await this.detect();
    if (!c) throw new Error('spotDL n\'est pas installé. Installe avec : pip install spotDL');

    job.status = 'running';
    job.progress.message = 'Démarrage de spotDL…';

    const format = job.options.format || 'mp3';
    const quality = job.options.quality || 'best';
    const template = path.join(job.dir, '%(artist)s - %(title)s.%(ext)s');

    const args = [
      ...c.prefix,
      'download',
      ...job.urls,
      '-o', template,
      '-f', format,
      '-q', quality,
      '--print-errors',
      '--threads', '2',
      '--max-retries', '3',
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn(c.cmd, args, { timeout: 900000, windowsHide: true });
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

  _collect(dir) {
    try {
      return fs.readdirSync(dir)
        .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
        .map((f) => {
          const p = path.join(dir, f);
          return { name: f, path: p, size: fs.statSync(p).size };
        });
    } catch {
      return [];
    }
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
      execFile(cmd, args, { timeout: 12000, windowsHide: true }, (err) => resolve(!err));
    });
  }

  _run(cmd, args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve((stdout || stderr || '').trim());
      });
    });
  }
}

module.exports = new SpotDLService();
