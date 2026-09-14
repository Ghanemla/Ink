import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

export class TtsService {
  constructor({ scriptPath, tempRoot }) {
    this.scriptPath = scriptPath;
    this.tempRoot = tempRoot;
    this.child = null;
  }

  stop() {
    if (!this.child) return;
    try { this.child.kill(); } catch {}
    this.child = null;
  }

  async speak(text, language = 'en') {
    if (process.platform !== 'win32') throw new Error('Ink voice playback is currently Windows-only.');
    const clean = String(text || '').trim();
    if (!clean) throw new Error('There is no translated text to play.');

    this.stop();
    await fsp.mkdir(this.tempRoot, { recursive: true });
    const textPath = path.join(this.tempRoot, `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    await fsp.writeFile(textPath, clean, 'utf8');

    return new Promise((resolve, reject) => {
      let stderr = '';
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath,
        '-TextPath', textPath,
        '-Language', language || 'en'
      ], { windowsHide: true });
      this.child = child;
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-2500); });
      child.on('error', async (error) => {
        this.child = null;
        await fsp.rm(textPath, { force: true }).catch(() => {});
        reject(error);
      });
      child.on('close', async (code) => {
        if (this.child === child) this.child = null;
        await fsp.rm(textPath, { force: true }).catch(() => {});
        if (code === 0) resolve({ ok: true });
        else reject(new Error(stderr.trim() || 'Windows could not play the translated voice.'));
      });
    });
  }
}
