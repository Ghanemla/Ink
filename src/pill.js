(() => {
  const BAR_COUNT = 40;
  const pill = document.getElementById('pill');
  const waveform = document.getElementById('waveform');
  const statusText = document.getElementById('statusText');
  const statusGlyph = document.getElementById('statusGlyph');
  const bars = [];
  const history = new Array(BAR_COUNT).fill(0.035);

  let stream = null;
  let audioContext = null;
  let analyser = null;
  let processor = null;
  let muteGain = null;
  let chunks = [];
  let animationFrame = 0;
  let lastHistoryPush = 0;
  let cancelled = false;
  let recording = false;
  let sourceRate = 48000;
  let currentAction = 'dictate';

  for (let i = 0; i < BAR_COUNT; i += 1) {
    const bar = document.createElement('span');
    bar.className = 'bar';
    waveform.appendChild(bar);
    bars.push(bar);
  }

  function setState(state, message = '') {
    pill.className = `pill is-visible is-${state}`;
    pill.setAttribute('aria-label', `Ink ${state}`);

    if (state === 'success') {
      statusGlyph.textContent = '✓';
      statusText.textContent = message || 'Pasted';
    } else if (state === 'error') {
      statusGlyph.textContent = '!';
      statusText.textContent = message || 'Something went wrong';
    } else if (state === 'cancelled') {
      statusGlyph.textContent = '×';
      statusText.textContent = message || 'Cancelled';
    } else if (state === 'translated') {
      statusGlyph.textContent = '▶';
      statusText.textContent = message || 'Listen';
    } else {
      statusGlyph.textContent = '';
      statusText.textContent = '';
    }
  }

  function setBarHeights(levels = history) {
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const amplitude = Math.max(0, Math.min(1, levels[i] || 0));
      const shaped = Math.pow(amplitude, 0.72);
      const height = 4 + shaped * 23;
      const centerBias = 0.94 + 0.06 * Math.sin((i / (BAR_COUNT - 1)) * Math.PI);
      bars[i].style.height = `${Math.round(height * centerBias)}px`;
      bars[i].style.opacity = String(0.48 + shaped * 0.47);
    }
  }

  function stopVisualization() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }

  function visualize() {
    if (!analyser || !recording) return;
    const data = new Float32Array(analyser.fftSize);

    const loop = (time) => {
      if (!analyser || !recording) return;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      const level = Math.max(0.02, Math.min(1, (rms - 0.006) * 11));

      if (time - lastHistoryPush > 24) {
        history.shift();
        history.push(level);
        lastHistoryPush = time;
      }

      setBarHeights(history);
      animationFrame = requestAnimationFrame(loop);
    };

    animationFrame = requestAnimationFrame(loop);
  }

  function audioConstraints(deviceId) {
    const base = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    if (deviceId && deviceId !== 'default') base.deviceId = { exact: deviceId };
    return base;
  }

  async function beginRecording({ microphoneId = 'default', action = 'dictate' } = {}) {
    if (recording) return;
    cancelled = false;
    currentAction = action === 'translate' ? 'translate' : 'dictate';
    chunks = [];
    history.fill(0.035);
    setBarHeights();
    setState('listening');

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(microphoneId) });
      audioContext = new AudioContext();
      await audioContext.resume();
      sourceRate = audioContext.sampleRate;

      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.45;

      processor = audioContext.createScriptProcessor(4096, 1, 1);
      muteGain = audioContext.createGain();
      muteGain.gain.value = 0;

      source.connect(analyser);
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioContext.destination);

      processor.onaudioprocess = (event) => {
        if (!recording) return;
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };

      recording = true;
      visualize();
    } catch (error) {
      recording = false;
      await releaseAudio();
      window.ink?.reportRecordingError?.(friendlyMicError(error));
    }
  }

  function friendlyMicError(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError') return 'Microphone access is blocked in Windows privacy settings.';
    if (name === 'NotFoundError') return 'No microphone was found.';
    if (name === 'NotReadableError') return 'Your microphone is already in use or unavailable.';
    return error?.message || 'Could not open your microphone.';
  }

  async function releaseAudio() {
    stopVisualization();
    if (processor) processor.onaudioprocess = null;
    try { processor?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    try { muteGain?.disconnect(); } catch {}
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    analyser = null;
    processor = null;
    muteGain = null;
    if (audioContext) {
      try { await audioContext.close(); } catch {}
    }
    audioContext = null;
  }

  function flattenChunks(parts) {
    const total = parts.reduce((n, part) => n + part.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function resample(input, fromRate, toRate = 16000) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const length = Math.max(1, Math.round(input.length / ratio));
    const output = new Float32Array(length);

    for (let i = 0; i < length; i += 1) {
      const start = i * ratio;
      const end = Math.min((i + 1) * ratio, input.length);
      const startIndex = Math.floor(start);
      const endIndex = Math.max(startIndex + 1, Math.floor(end));
      let sum = 0;
      let weight = 0;

      for (let j = startIndex; j < endIndex && j < input.length; j += 1) {
        const segmentStart = Math.max(start, j);
        const segmentEnd = Math.min(end, j + 1);
        const w = Math.max(0, segmentEnd - segmentStart);
        sum += input[j] * w;
        weight += w;
      }
      output[i] = weight > 0 ? sum / weight : input[startIndex] || 0;
    }
    return output;
  }

  function encodeWav(samples, sampleRate = 16000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return buffer;
  }

  async function finishRecording() {
    if (!recording) return;
    recording = false;
    setState('processing');
    stopVisualization();

    const captured = chunks;
    chunks = [];
    await releaseAudio();
    if (cancelled) return;

    const flat = flattenChunks(captured);
    if (flat.length < sourceRate * 0.12) {
      window.ink?.reportRecordingError?.('That was too short to transcribe.');
      return;
    }

    const pcm16k = resample(flat, sourceRate, 16000);
    const wav = encodeWav(pcm16k, 16000);

    try {
      const result = await window.ink.transcribe(wav, currentAction);
      if (!result?.ok) setState('error', result?.error || 'Transcription failed');
    } catch (error) {
      window.ink?.reportRecordingError?.(error?.message || 'Transcription failed.');
    }
  }

  async function cancelRecording() {
    cancelled = true;
    recording = false;
    chunks = [];
    await releaseAudio();
    setState('cancelled');
  }

  document.getElementById('status')?.addEventListener('click', async () => {
    if (!pill.classList.contains('is-translated')) return;
    const result = await window.ink?.playLastTranslation?.();
    if (result && !result.ok) setState('error', result.error || 'Could not play voice');
  });

  window.ink?.onBeginRecording?.(beginRecording);
  window.ink?.onFinishRecording?.(finishRecording);
  window.ink?.onCancelRecording?.(cancelRecording);
  window.ink?.onPillState?.(({ state, message }) => setState(state, message));

  // Browser-only visual preview used for design QA.
  if (!window.ink) {
    let tick = 0;
    recording = true;
    setState('listening');
    const preview = () => {
      tick += 0.14;
      history.shift();
      const voiceEnvelope = 0.22 + 0.52 * Math.abs(Math.sin(tick * 0.73));
      const texture = 0.22 * Math.abs(Math.sin(tick * 2.9 + Math.sin(tick)));
      history.push(Math.min(0.9, voiceEnvelope + texture));
      setBarHeights(history);
      requestAnimationFrame(preview);
    };
    preview();
  }
})();
