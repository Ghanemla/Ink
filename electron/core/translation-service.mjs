import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function looksLikeCudaRuntimeError(message) {
  return /cublas|cudnn|cudart|cuda[^\n]*(?:not found|cannot|failed)|library[^\n]*cuda/i.test(String(message || ''));
}

export class TranslationService {
  constructor({ root, workerPath, deviceType = 'auto', cudaSearchPaths = [] }) {
    this.root = root;
    this.workerPath = workerPath;
    this.pythonPath = path.join(root, 'python', 'python.exe');
    this.markerPath = path.join(root, 'translation.json');
    this.qualityMarkerPath = path.join(root, 'madlad.json');
    this.qualityModelPath = path.join(root, 'madlad400-3b-int8');
    this.deviceType = deviceType;
    this.cudaSearchPaths = [...new Set((cudaSearchPaths || []).filter(Boolean))];
    this.forceCpu = false;
    this.child = null;
    this.stdoutBuffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.onProgress = null;
  }

  status() {
    let metadata = null;
    let qualityMetadata = null;
    try { metadata = JSON.parse(fs.readFileSync(this.markerPath, 'utf8')); } catch {}
    try { qualityMetadata = JSON.parse(fs.readFileSync(this.qualityMarkerPath, 'utf8')); } catch {}
    const qualityModelReady = exists(path.join(this.qualityModelPath, 'model.bin')) &&
      (exists(path.join(this.qualityModelPath, 'spiece.model')) || exists(path.join(this.qualityModelPath, 'sentencepiece.model')));
    return {
      ready: exists(this.pythonPath) && exists(this.markerPath),
      python: exists(this.pythonPath),
      pythonPath: this.pythonPath,
      root: this.root,
      version: metadata?.argosVersion || null,
      installedAt: metadata?.installedAt || null,
      device: this.forceCpu ? 'cpu' : this.deviceType,
      qualityModelReady,
      qualityModel: qualityMetadata?.model || (qualityModelReady ? 'MADLAD-400-3B-MT INT8' : null),
      qualityInstalledAt: qualityMetadata?.installedAt || null
    };
  }

  env() {
    const pathParts = [
      ...this.cudaSearchPaths,
      process.env.PATH || ''
    ].filter(Boolean);
    return {
      ...process.env,
      PATH: pathParts.join(path.delimiter),
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      ARGOS_PACKAGES_DIR: path.join(this.root, 'packages'),
      XDG_DATA_HOME: path.join(this.root, 'data'),
      XDG_CONFIG_HOME: path.join(this.root, 'config'),
      XDG_CACHE_HOME: path.join(this.root, 'cache'),
      ARGOS_DEVICE_TYPE: this.forceCpu ? 'cpu' : this.deviceType,
      ARGOS_COMPUTE_TYPE: 'int8',
      ARGOS_CHUNK_TYPE: 'ARGOSTRANSLATE',
      ARGOS_INTER_THREADS: '1',
      ARGOS_INTRA_THREADS: '0',
      ARGOS_BATCH_SIZE: '8',
      INK_MADLAD_MODEL: this.qualityModelPath
    };
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    for (const { reject } of this.pending.values()) reject(new Error('Translation engine stopped.'));
    this.pending.clear();
  }

  ensureWorker() {
    const status = this.status();
    if (!status.ready) throw new Error('Translation engine is not installed. Open Ink Settings and install it first.');
    if (this.child && !this.child.killed && this.child.exitCode === null) return;

    const child = spawn(this.pythonPath, ['-u', this.workerPath], {
      windowsHide: true,
      env: this.env(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.stdoutBuffer = '';

    child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString();
      let newline;
      while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.event === 'progress') {
          this.onProgress?.(message.message || 'Working…');
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'Translation failed.'));
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-8000); });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      const error = new Error(stderr.trim() || `Translation worker exited with code ${code}.`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  request(command, payload = {}) {
    this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  listLanguages({ refresh = false } = {}) {
    return this.request('languages', { refresh });
  }

  prepareTarget(target) {
    return this.request('prepare_target', { target });
  }

  warmQualityModel() {
    if (!this.status().qualityModelReady) return Promise.resolve({ ready: false });
    return this.request('warm_quality');
  }

  async translateSegments(segments, target, { quality = 'auto' } = {}) {
    const payload = { segments, target, autoInstall: true, quality };
    try {
      return await this.request('translate', payload);
    } catch (error) {
      if (!this.forceCpu && looksLikeCudaRuntimeError(error?.message)) {
        this.forceCpu = true;
        this.onProgress?.('GPU translation runtime is unavailable; retrying on CPU…');
        this.stop();
        return this.request('translate', payload);
      }
      throw error;
    }
  }
}
