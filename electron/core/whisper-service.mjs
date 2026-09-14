import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function findOpenPort(start = 17843) {
  for (let port = start; port < start + 40; port += 1) {
    if (!(await canConnect(port))) return port;
  }
  throw new Error('Ink could not find a free local port for the speech engine.');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSegments(payload) {
  const raw = Array.isArray(payload?.segments)
    ? payload.segments
    : Array.isArray(payload?.transcription)
      ? payload.transcription
      : [];

  return raw
    .map((segment) => ({
      text: cleanText(segment?.text || ''),
      start: Number.isFinite(segment?.start) ? segment.start : null,
      end: Number.isFinite(segment?.end) ? segment.end : null,
      avgLogprob: Number.isFinite(segment?.avg_logprob)
        ? segment.avg_logprob
        : Number.isFinite(segment?.avgLogprob)
          ? segment.avgLogprob
          : null,
      noSpeechProb: Number.isFinite(segment?.no_speech_prob)
        ? segment.no_speech_prob
        : Number.isFinite(segment?.noSpeechProb)
          ? segment.noSpeechProb
          : null
    }))
    .filter((segment) => segment.text);
}

function confidenceFromPayload(payload) {
  const segments = extractSegments(payload);
  const logprobs = segments
    .map((segment) => segment.avgLogprob)
    .filter(Number.isFinite);
  if (logprobs.length) {
    const mean = logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length;
    return Math.max(0, Math.min(1, Math.exp(mean)));
  }

  const transcription = Array.isArray(payload?.transcription) ? payload.transcription : [];
  const probs = [];
  for (const segment of transcription) {
    for (const token of Array.isArray(segment?.tokens) ? segment.tokens : []) {
      const text = String(token?.text || '');
      if (!Number.isFinite(token?.p) || /^<\|.*\|>$/.test(text) || !text.trim()) continue;
      probs.push(Math.max(0.0001, Math.min(1, token.p)));
    }
  }
  if (!probs.length) return 0;
  return Math.exp(probs.reduce((sum, p) => sum + Math.log(p), 0) / probs.length);
}

function normalizePayload(payload, requestedLanguage = 'auto') {
  const segments = extractSegments(payload);
  const text = cleanText(
    payload?.text ||
    payload?.result?.text ||
    segments.map((segment) => segment.text).join(' ') ||
    (Array.isArray(payload?.transcription)
      ? payload.transcription.map((segment) => segment?.text || '').join(' ')
      : '')
  );

  const language = String(
    payload?.language ||
    payload?.result?.language ||
    payload?.detected_language ||
    requestedLanguage ||
    'auto'
  ).toLowerCase();

  return {
    payload,
    text,
    language,
    confidence: confidenceFromPayload(payload),
    segments
  };
}

export class WhisperService {
  constructor() {
    this.child = null;
    this.port = null;
    this.model = null;
    this.serverExecutable = null;
    this.flashAttention = false;
    this.audioCtx = 0;
    this.stderrTail = '';
    this.startPromise = null;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.port = null;
    this.model = null;
    this.serverExecutable = null;
    this.flashAttention = false;
    this.audioCtx = 0;
    this.startPromise = null;
    if (!child || child.killed) return;
    try { child.kill(); } catch {}
    await delay(70);
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  async ensure({ serverExecutable, model, threads = 4, flashAttention = false, audioCtx = 0 }) {
    if (!serverExecutable) throw new Error('whisper-server.exe is not installed. Run Repair speech engine in Ink Settings.');
    if (!model) throw new Error('Ink could not find the requested Whisper model.');

    const desiredAudioCtx = Number.isFinite(Number(audioCtx)) ? Math.max(0, Math.round(Number(audioCtx))) : 0;
    if (
      this.child && !this.child.killed && this.port &&
      this.model === model && this.serverExecutable === serverExecutable &&
      this.flashAttention === Boolean(flashAttention) && this.audioCtx === desiredAudioCtx
    ) {
      return this.port;
    }

    if (this.startPromise) {
      await this.startPromise;
      if (
        this.child && this.model === model && this.serverExecutable === serverExecutable &&
        this.flashAttention === Boolean(flashAttention) && this.audioCtx === desiredAudioCtx
      ) return this.port;
    }

    this.startPromise = (async () => {
      await this.stop();
      const port = await findOpenPort();
      this.stderrTail = '';
      const serverArgs = [
        '-m', model,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(threads),
        '-l', 'auto',
        '-np'
      ];
      if (desiredAudioCtx > 0) serverArgs.push('-ac', String(desiredAudioCtx));
      if (flashAttention) serverArgs.push('-fa');

      const child = spawn(serverExecutable, serverArgs, {
        windowsHide: true,
        cwd: path.dirname(serverExecutable),
        stdio: ['ignore', 'ignore', 'pipe']
      });

      this.child = child;
      this.port = port;
      this.model = model;
      this.serverExecutable = serverExecutable;
      this.flashAttention = Boolean(flashAttention);
      this.audioCtx = desiredAudioCtx;

      child.stderr?.on('data', (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-5000);
      });
      child.on('exit', () => {
        if (this.child === child) {
          this.child = null;
          this.port = null;
          this.model = null;
          this.serverExecutable = null;
          this.flashAttention = false;
          this.audioCtx = 0;
        }
      });

      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(this.stderrTail.trim() || `whisper-server exited with code ${child.exitCode}.`);
        }
        if (await canConnect(port)) return;
        await delay(150);
      }
      throw new Error('The local Whisper server took too long to start.');
    })();

    try {
      await this.startPromise;
      return this.port;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  async infer(buffer, {
    serverExecutable,
    model,
    threads = 4,
    flashAttention = false,
    audioCtx = 0,
    language = 'auto',
    prompt = '',
    carryPrompt = false,
    responseFormat = 'verbose_json'
  } = {}) {
    const port = await this.ensure({ serverExecutable, model, threads, flashAttention, audioCtx });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(buffer)], { type: 'audio/wav' }), 'ink.wav');
    form.append('language', language || 'auto');
    form.append('response_format', responseFormat);
    form.append('temperature', '0.0');
    form.append('temperature_inc', '0.2');
    form.append('no_speech_thold', '0.55');
    // We do not need token/word timestamps for dictation. Avoiding split-on-word
    // keeps the response lighter and leaves Whisper focused on the transcript.
    form.append('split_on_word', 'false');
    if (prompt) form.append('prompt', prompt);
    if (carryPrompt) form.append('carry_initial_prompt', 'true');

    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10 * 60 * 1000)
      });
    } catch (error) {
      await this.stop();
      throw new Error(`Local Whisper server failed: ${error?.message || error}`);
    }

    const body = await response.text();
    if (!response.ok) throw new Error(body.trim() || `Whisper server returned HTTP ${response.status}.`);

    if (responseFormat === 'text') {
      return { text: cleanText(body), language, confidence: 0, segments: [], payload: body };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`Whisper returned invalid JSON: ${body.slice(0, 300)}`);
    }
    return normalizePayload(payload, language);
  }
}

export { cleanText, normalizePayload };
