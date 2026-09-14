import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ArabicAsrService {
  constructor({ root, workerPath, tempRoot }) {
    this.root = root;
    this.workerPath = workerPath;
    this.tempRoot = tempRoot;
    this.defaultPythonPath = path.join(root, 'python', 'python.exe');
    this.defaultPackagesPath = path.join(root, 'python-packages');
    this.markerPath = path.join(root, 'arabic-asr.json');
    this.defaultModelRoot = path.join(root, 'model', 'int8');
    this.child = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
  }

  metadata() {
    try {
      const raw = fs.readFileSync(this.markerPath, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  runtimeConfig() {
    const metadata = this.metadata();
    return {
      metadata,
      pythonPath: metadata?.pythonPath || this.defaultPythonPath,
      packagesPath: metadata?.packagesPath || this.defaultPackagesPath,
      modelRoot: metadata?.modelPath || this.defaultModelRoot
    };
  }

  status() {
    const { metadata, pythonPath, packagesPath, modelRoot } = this.runtimeConfig();
    const encoderData = path.join(modelRoot, 'encoder_model_int8.onnx.data');
    const decoderData = path.join(modelRoot, 'decoder_model_merged_int8.onnx.data');
    const vocab = path.join(modelRoot, 'vocab.json');
    const addedTokens = path.join(modelRoot, 'added_tokens.json');
    const modelReady = exists(encoderData) && exists(decoderData) && exists(vocab) && exists(addedTokens);
    return {
      ready: exists(pythonPath) && exists(this.markerPath) && modelReady,
      pythonReady: exists(pythonPath),
      modelReady,
      root: this.root,
      modelRoot,
      pythonPath,
      packagesPath,
      runtimeSource: metadata?.runtimeSource || null,
      model: metadata?.model || null,
      runtime: metadata?.runtime || null,
      installedAt: metadata?.installedAt || null,
      dialects: metadata?.dialects || 13,
      precision: 'int8'
    };
  }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.startPromise = null;
    const error = new Error('Arabic speech engine stopped.');
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  async ensureWorker() {
    const status = this.status();
    if (!status.ready) {
      throw new Error('Arabic dialect speech pack is not installed. Open Ink Settings → Translation and install it once.');
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const pythonPath = status.pythonPath;
      const pythonPathEnv = [status.packagesPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      const child = spawn(pythonPath, ['-u', this.workerPath], {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
          PYTHONPATH: pythonPathEnv,
          INK_ARABIC_ASR_MODEL: status.modelRoot
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child;
      this.stdoutBuffer = '';
      this.stderrTail = '';

      let settled = false;
      const failStart = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.stdout.on('data', (chunk) => {
        this.stdoutBuffer += chunk.toString();
        let newline;
        while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.event === 'ready') {
            if (!settled) {
              settled = true;
              resolve();
            }
            continue;
          }
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error || 'Arabic speech recognition failed.'));
        }
      });

      child.stderr.on('data', (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-8000);
      });
      child.on('error', (error) => failStart(error));
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        const error = new Error(this.stderrTail.trim() || `Arabic speech worker exited with code ${code}.`);
        failStart(error);
        for (const { reject: rejectPending } of this.pending.values()) rejectPending(error);
        this.pending.clear();
      });

      setTimeout(() => {
        if (!settled && this.child === child) {
          failStart(new Error('Arabic dialect model took too long to load.'));
          try { child.kill(); } catch {}
        }
      }, 120000);
    });

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request(command, payload = {}) {
    await this.ensureWorker();
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

  warm() {
    if (!this.status().ready) return Promise.resolve({ ready: false });
    return this.request('warm');
  }

  async transcribe(buffer) {
    await fsp.mkdir(this.tempRoot, { recursive: true });
    const wavPath = path.join(this.tempRoot, `arabic-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
    await fsp.writeFile(wavPath, Buffer.from(buffer));
    try {
      const result = await this.request('transcribe', { wavPath });
      return {
        text: cleanText(result?.text),
        language: 'ar',
        engine: result?.engine || 'arabic-dialect-onnx-int8',
        confidence: Number(result?.confidence) || 0
      };
    } finally {
      await fsp.rm(wavPath, { force: true }).catch(() => {});
    }
  }
}
