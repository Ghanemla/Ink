import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ipcMain,
  screen,
  clipboard,
  shell,
  session
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WhisperService } from './core/whisper-service.mjs';
import { TranslationService } from './core/translation-service.mjs';
import { TtsService } from './core/tts-service.mjs';
import { ArabicAsrService } from './core/arabic-asr-service.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.ink.dictation');
}

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

const FAST_AUDIO_CTX = 768;

const DEFAULT_SETTINGS = {
  hotkey: 'Control+Alt+Space',
  microphoneId: 'default',
  microphoneLabel: 'Windows default microphone',
  language: 'bilingual',
  performanceProfile: 'auto',
  autoPaste: true,
  launchAtLogin: false,
  translationHotkey: 'Control+Alt+T',
  translationSource: 'auto',
  translationTarget: 'en',
  translationQuality: 'auto',
  playTranslationHotkey: 'Control+Alt+L'
};

let settings = { ...DEFAULT_SETTINGS };
let pillWindow = null;
let settingsWindow = null;
let tray = null;
let mode = 'idle'; // idle | recording | processing
let mainHotkey = null;
let translationHotkey = null;
let playTranslationHotkey = null;
let recordingAction = 'dictate';
let lastTranslation = null;
let recentActivity = null;
let lastError = '';
let whisperService = null;
let translationService = null;
let ttsService = null;
let arabicAsrService = null;
let escapeRegistered = false;
let isQuitting = false;
let pillHasBeenPositioned = false;

function settingsPath() {
  return path.join(app.getPath('userData'), 'ink-settings.json');
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsPath(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...parsed };
    // Older builds called the code-switch mode 'auto'. Preserve that user's intent.
    if (settings.language === 'auto') settings.language = 'bilingual';
    if (!settings.translationSource) settings.translationSource = 'auto';
    // 0.1.8 used ordinary letter shortcuts that can collide with apps/games.
    // Migrate only those old defaults; custom shortcuts remain untouched.
    // 0.2.0 restores the simpler translation shortcuts used before 0.1.9.
    // Only migrate Ink's 0.1.9 defaults; preserve any user-selected custom shortcuts.
    if (settings.translationHotkey === 'Control+Alt+Shift+F10') settings.translationHotkey = DEFAULT_SETTINGS.translationHotkey;
    if (settings.playTranslationHotkey === 'Control+Alt+Shift+F11') settings.playTranslationHotkey = DEFAULT_SETTINGS.playTranslationHotkey;
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings() {
  await fsp.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function appAsset(name) {
  return path.join(ROOT, 'assets', name);
}

function createPillWindow() {
  pillWindow = new BrowserWindow({
    width: 180,
    height: 48,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  pillWindow.setAlwaysOnTop(true, 'screen-saver');
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the pill non-focusable so dictation never steals keyboard focus, but
  // allow mouse input so the whole surface can act as a draggable region.
  pillWindow.setIgnoreMouseEvents(false);
  pillWindow.loadFile(path.join(ROOT, 'src', 'pill.html'));

  pillWindow.on('closed', () => {
    pillWindow = null;
  });
}

function positionPill({ force = false } = {}) {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  if (pillHasBeenPositioned && !force) return;
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const bounds = pillWindow.getBounds();
  const x = Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2);
  const y = Math.round(display.workArea.y + display.workArea.height - bounds.height - 18);
  pillWindow.setPosition(x, y, false);
  pillHasBeenPositioned = true;
}

function showPill(state, payload = {}) {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  positionPill();
  pillWindow.webContents.send('pill-state', { state, ...payload });
  pillWindow.showInactive();
}

function hidePill(delay = 0) {
  const win = pillWindow;
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.hide();
  }, delay);
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 610,
    height: 820,
    minWidth: 560,
    minHeight: 620,
    frame: true,
    title: 'Ink Settings',
    backgroundColor: '#111111',
    icon: appAsset('icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (process.platform === 'win32') {
    const relaunchCommand = app.isPackaged
      ? `"${process.execPath}"`
      : `"${process.execPath}" "${ROOT}"`;
    settingsWindow.setAppDetails({
      appId: 'com.ink.dictation',
      appIconPath: app.isPackaged ? process.execPath : appAsset('icon.ico'),
      appIconIndex: 0,
      relaunchCommand,
      relaunchDisplayName: 'Ink'
    });
  }

  settingsWindow.loadFile(path.join(ROOT, 'src', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function translationSourceTrayLabel() {
  const source = String(settings.translationSource || 'auto').toLowerCase();
  if (source === 'auto') return 'AUTO';
  if (source === 'bilingual') return 'EN/SV';
  if (source === 'ar') return 'AR';
  return source.toUpperCase();
}

function pushRecentActivity(activity) {
  recentActivity = activity ? { ...activity, updatedAt: Date.now() } : null;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('recent-activity-updated', recentActivity);
  }
}

function buildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'Ink', enabled: false },
    { type: 'separator' },
    { label: `Dictate  (${settings.hotkey})`, click: () => toggleAction('dictate') },
    { label: `Translate ${translationSourceTrayLabel()} → ${String(settings.translationTarget || 'en').toUpperCase()}  (${settings.translationHotkey})`, click: () => toggleAction('translate') }
  ];
  if (lastTranslation?.text) {
    items.push({ label: `Listen to last translation  (${settings.playTranslationHotkey})`, click: () => playLastTranslation() });
  }
  if (lastError) {
    items.push({ label: 'Copy last error', click: () => clipboard.writeText(lastError) });
  }
  items.push(
    { label: 'Settings…', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit Ink', click: () => { isQuitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  const source = nativeImage.createFromPath(appAsset('tray.png'));
  const image = source.isEmpty() ? nativeImage.createFromPath(appAsset('icon.png')) : source;
  tray = new Tray(image);
  tray.setToolTip('Ink — local dictation');
  buildTrayMenu();
  tray.on('double-click', () => createSettingsWindow());
}

function unregisterEscape() {
  if (escapeRegistered) {
    globalShortcut.unregister('Escape');
    escapeRegistered = false;
  }
}

function registerEscape() {
  unregisterEscape();
  escapeRegistered = globalShortcut.register('Escape', () => cancelRecording());
}

function registerMainHotkey(accelerator = settings.hotkey) {
  if (mainHotkey) globalShortcut.unregister(mainHotkey);
  const ok = globalShortcut.register(accelerator, () => toggleAction('dictate'));
  if (ok) {
    mainHotkey = accelerator;
    return true;
  }
  return false;
}

function registerTranslationHotkey(accelerator = settings.translationHotkey) {
  if (translationHotkey) globalShortcut.unregister(translationHotkey);
  const ok = globalShortcut.register(accelerator, () => toggleAction('translate'));
  if (ok) {
    translationHotkey = accelerator;
    return true;
  }
  return false;
}

function registerPlayTranslationHotkey(accelerator = settings.playTranslationHotkey) {
  if (playTranslationHotkey) globalShortcut.unregister(playTranslationHotkey);
  const ok = globalShortcut.register(accelerator, () => playLastTranslation());
  if (ok) {
    playTranslationHotkey = accelerator;
    return true;
  }
  return false;
}

function toggleAction(action = 'dictate') {
  if (mode === 'idle') startRecording(action);
  else if (mode === 'recording' && recordingAction === action) stopRecording();
}

function startRecording(action = 'dictate') {
  if (mode !== 'idle') return;
  mode = 'recording';
  recordingAction = action === 'translate' ? 'translate' : 'dictate';
  registerEscape();
  showPill('listening');
  pillWindow?.webContents.send('begin-recording', {
    microphoneId: settings.microphoneId || 'default',
    action: recordingAction
  });
}

function stopRecording() {
  if (mode !== 'recording') return;
  mode = 'processing';
  unregisterEscape();
  showPill('processing');
  pillWindow?.webContents.send('finish-recording');
}

function cancelRecording() {
  if (mode !== 'recording') return;
  mode = 'idle';
  unregisterEscape();
  pillWindow?.webContents.send('cancel-recording');
  showPill('cancelled');
  hidePill(280);
}

function runtimeRoot() {
  return path.join(app.getPath('userData'), 'runtime');
}

function findFileRecursive(root, fileName, depth = 4) {
  if (depth < 0 || !fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, fileName, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
}

function getEngineStatus() {
  const root = runtimeRoot();
  const exe = findFileRecursive(path.join(root, 'engine'), 'whisper-cli.exe');
  const serverExe = findFileRecursive(path.join(root, 'engine'), 'whisper-server.exe');
  const modelEn = path.join(root, 'models', 'ggml-base.en.bin');
  const modelMulti = path.join(root, 'models', 'ggml-base.bin');
  const modelBilingual = path.join(root, 'models', 'ggml-large-v3-turbo-q5_0.bin');
  const modelLooksComplete = (file, minimumMiB = 140) => {
    try {
      return fs.statSync(file).size > minimumMiB * 1024 * 1024;
    } catch {
      return false;
    }
  };
  const engineInstalled = Boolean(exe && fs.existsSync(exe));
  const serverInstalled = Boolean(serverExe && fs.existsSync(serverExe));
  const englishModelInstalled = modelLooksComplete(modelEn);
  const multilingualModelInstalled = modelLooksComplete(modelMulti);
  const bilingualModelInstalled = modelLooksComplete(modelBilingual, 500);
  let metadata = null;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8'));
  } catch {}
  return {
    ready: engineInstalled && englishModelInstalled && multilingualModelInstalled,
    fullyReady: engineInstalled && serverInstalled && englishModelInstalled && multilingualModelInstalled && bilingualModelInstalled,
    engineInstalled,
    serverInstalled,
    englishModelInstalled,
    multilingualModelInstalled,
    bilingualModelInstalled,
    executable: exe,
    serverExecutable: serverExe,
    modelEn,
    modelMulti,
    modelBilingual,
    backend: metadata?.backend || 'unknown',
    version: metadata?.version || null
  };
}

function setupScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'setup-whisper.ps1')
    : path.join(ROOT, 'scripts', 'setup-whisper.ps1');
}

function installEngine(event) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'The Ink speech-engine installer is Windows-only.' });
      return;
    }

    // Release the resident model before replacing/repairing whisper.cpp binaries.
    whisperService?.stop();
    const script = setupScriptPath();
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Destination', runtimeRoot(),
      '-Backend', 'auto'
    ], { windowsHide: true });

    let tail = '';
    const forward = (chunk) => {
      const text = chunk.toString();
      tail = `${tail}${text}`.slice(-5000);
      event.sender.send('engine-install-progress', text);
    };

    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => resolve({ ok: false, error: error.message, status: getEngineStatus() }));
    child.on('close', (code) => {
      const status = getEngineStatus();
      if (code === 0 && status.fullyReady) {
        prewarmSpeechEngine().catch(() => {});
        resolve({ ok: true, status });
        return;
      }

      const lines = tail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const useful = [...lines].reverse().find((line) =>
        !line.startsWith('+') &&
        !line.startsWith('At ') &&
        !line.startsWith('CategoryInfo') &&
        !line.startsWith('FullyQualifiedErrorId')
      );
      resolve({
        ok: false,
        error: useful || `Speech engine setup exited with code ${code}.`,
        status
      });
    });
  });
}

function resourceScript(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', name)
    : path.join(ROOT, 'scripts', name);
}

function translationRoot() {
  return path.join(app.getPath('userData'), 'translation');
}

function arabicAsrRoot() {
  return path.join(app.getPath('userData'), 'arabic-asr');
}

function getArabicAsrStatus() {
  if (arabicAsrService) return arabicAsrService.status();
  const root = arabicAsrRoot();
  const marker = path.join(root, 'arabic-asr.json');
  const modelRoot = path.join(root, 'model', 'int8');
  let metadata = null;
  try { metadata = JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const largeEnough = (file, minimumMiB = 500) => {
    try { return fs.statSync(file).size > minimumMiB * 1024 * 1024; } catch { return false; }
  };
  const modelReady = largeEnough(path.join(modelRoot, 'encoder_model_int8.onnx.data')) &&
    largeEnough(path.join(modelRoot, 'decoder_model_merged_int8.onnx.data'));
  const translationPython = path.join(translationRoot(), 'python', 'python.exe');
  const arabicPrivatePython = path.join(root, 'python', 'python.exe');
  const pythonPath = metadata?.pythonPath || (fs.existsSync(translationPython) ? translationPython : arabicPrivatePython);
  const packagesPath = metadata?.packagesPath || path.join(root, 'python-packages');
  return {
    ready: fs.existsSync(pythonPath) && fs.existsSync(marker) && modelReady,
    pythonReady: fs.existsSync(pythonPath),
    modelReady,
    root,
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

function installArabicAsr(event) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'The Ink Arabic speech-pack installer is Windows-only.' });
      return;
    }
    arabicAsrService?.stop();
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', resourceScript('setup-arabic-asr.ps1'),
      '-Destination', arabicAsrRoot()
    ], { windowsHide: true });

    let tail = '';
    const forward = (chunk) => {
      const text = chunk.toString();
      tail = `${tail}${text}`.slice(-8000);
      event.sender.send('arabic-asr-install-progress', text);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => resolve({ ok: false, error: error.message, status: getArabicAsrStatus() }));
    child.on('close', (code) => {
      const status = getArabicAsrStatus();
      if (code === 0 && status.ready) {
        arabicAsrService?.warm().catch(() => {});
        resolve({ ok: true, status });
        return;
      }
      const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const useful = [...lines].reverse().find((line) =>
        !line.startsWith('+') && !line.startsWith('At ') && !line.startsWith('CategoryInfo')
      );
      resolve({ ok: false, error: useful || `Arabic speech-pack setup exited with code ${code}.`, status });
    });
  });
}

function getTranslationStatus() {
  if (!translationService) {
    const root = translationRoot();
    const marker = path.join(root, 'translation.json');
    let metadata = null;
    try { metadata = JSON.parse(fs.readFileSync(marker, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    const qualityModelPath = path.join(root, 'madlad400-3b-int8');
    return {
      ready: fs.existsSync(path.join(root, 'python', 'python.exe')) && fs.existsSync(marker),
      version: metadata?.argosVersion || null,
      root,
      qualityModelReady: fs.existsSync(path.join(qualityModelPath, 'model.bin')) &&
        (fs.existsSync(path.join(qualityModelPath, 'spiece.model')) || fs.existsSync(path.join(qualityModelPath, 'sentencepiece.model'))),
      qualityModel: fs.existsSync(path.join(root, 'madlad.json')) ? 'MADLAD-400-3B-MT INT8' : null
    };
  }
  return translationService.status();
}

function installTranslationEngine(event) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'The Ink translation-engine installer is Windows-only.' });
      return;
    }
    translationService?.stop();
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', resourceScript('setup-translation.ps1'),
      '-Destination', translationRoot()
    ], { windowsHide: true });

    let tail = '';
    const forward = (chunk) => {
      const text = chunk.toString();
      tail = `${tail}${text}`.slice(-6000);
      event.sender.send('translation-install-progress', text);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => resolve({ ok: false, error: error.message, status: getTranslationStatus() }));
    child.on('close', (code) => {
      const status = getTranslationStatus();
      if (code === 0 && status.ready) {
        resolve({ ok: true, status });
        return;
      }
      const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const useful = [...lines].reverse().find((line) =>
        !line.startsWith('+') && !line.startsWith('At ') && !line.startsWith('CategoryInfo')
      );
      resolve({ ok: false, error: useful || `Translation setup exited with code ${code}.`, status });
    });
  });
}

function installHighQualityTranslation(event) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: 'The Ink high-quality translation installer is Windows-only.' });
      return;
    }
    if (!getTranslationStatus().ready) {
      resolve({ ok: false, error: 'Install the base translation engine first.', status: getTranslationStatus() });
      return;
    }
    translationService?.stop();
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', resourceScript('setup-madlad.ps1'),
      '-Destination', translationRoot()
    ], { windowsHide: true });

    let tail = '';
    const forward = (chunk) => {
      const text = chunk.toString();
      tail = `${tail}${text}`.slice(-8000);
      event.sender.send('translation-install-progress', text);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => resolve({ ok: false, error: error.message, status: getTranslationStatus() }));
    child.on('close', (code) => {
      const status = getTranslationStatus();
      if (code === 0 && status.qualityModelReady) {
        resolve({ ok: true, status });
        return;
      }
      const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const useful = [...lines].reverse().find((line) =>
        !line.startsWith('+') && !line.startsWith('At ') && !line.startsWith('CategoryInfo')
      );
      resolve({ ok: false, error: useful || `High-quality translation setup exited with code ${code}.`, status });
    });
  });
}

function effectiveTranslationQuality() {
  const requested = settings.translationQuality || 'auto';
  if (requested === 'fast' || requested === 'quality') return requested;
  const status = getTranslationStatus();
  const engine = getEngineStatus();
  return status.qualityModelReady && engine.backend === 'cuda' && settings.performanceProfile !== 'lightweight'
    ? 'quality'
    : 'fast';
}

async function prewarmTranslationEngine() {
  if (!translationService?.status().ready) return;
  if (effectiveTranslationQuality() !== 'quality') return;
  try {
    await translationService.warmQualityModel();
  } catch (error) {
    console.warn('[Ink] translation prewarm skipped:', error?.message || error);
  }
}

async function listTranslationLanguages(refresh = false) {
  if (!translationService?.status().ready) return { ok: false, languages: [], error: 'Translation engine is not installed.' };
  try {
    const result = await translationService.listLanguages({ refresh });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, languages: [], error: error?.message || String(error) };
  }
}

async function prepareTranslationTarget(target, event) {
  if (!translationService?.status().ready) return { ok: false, error: 'Install the translation engine first.' };
  try {
    translationService.onProgress = (message) => event.sender.send('translation-install-progress', `[Ink] ${message}\n`);
    const result = await translationService.prepareTarget(target);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    translationService.onProgress = null;
  }
}

function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code}`));
    });
  });
}

async function sendPasteKeystroke() {
  if (process.platform !== 'win32') return;
  const script = [
    "Add-Type -Namespace InkNative -Name Keyboard -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'",
    '[InkNative.Keyboard]::keybd_event(0x11,0,0,[UIntPtr]::Zero)',
    '[InkNative.Keyboard]::keybd_event(0x56,0,0,[UIntPtr]::Zero)',
    '[InkNative.Keyboard]::keybd_event(0x56,0,2,[UIntPtr]::Zero)',
    '[InkNative.Keyboard]::keybd_event(0x11,0,2,[UIntPtr]::Zero)'
  ].join('; ');

  await waitForProcess(spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script
  ], { windowsHide: true }));
}

function cleanTranscript(raw) {
  let text = String(raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^\[(blank_audio|silence|music)\]$/i.test(text)) text = '';
  if (/^\((music|silence)\)$/i.test(text)) text = '';
  return text;
}

function parsePcm16MonoWav(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Ink received an invalid WAV recording.');
  }

  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let data = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + size <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data' && body + size <= buffer.length) {
      data = buffer.subarray(body, body + size);
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!data || channels !== 1 || bitsPerSample !== 16) {
    throw new Error('Ink expected a 16-bit mono WAV recording.');
  }
  return { sampleRate, pcm: data };
}

function makePcm16MonoWav(pcm, sampleRate = 16000) {
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out;
}

function wavDurationSeconds(input) {
  const { sampleRate, pcm } = parsePcm16MonoWav(Buffer.from(input));
  return sampleRate > 0 ? (pcm.length / 2) / sampleRate : 0;
}

// 0.1.7 cut bilingual speech into ~2.8 s clips and reloaded Whisper for each
// attempt. 0.1.8 keeps the model resident, so we can use moderately longer quiet-
// boundary chunks: enough context for accuracy without hiding language switches in
// a long 8-10 second window.
function splitSpeechWav(input, {
  targetSeconds = 4.4,
  minSeconds = 2.7,
  maxSeconds = 5.8,
  searchSeconds = 1.0
} = {}) {
  const source = Buffer.from(input);
  const { sampleRate, pcm } = parsePcm16MonoWav(source);
  const totalSamples = Math.floor(pcm.length / 2);
  const seconds = totalSamples / sampleRate;
  if (seconds <= maxSeconds) return [source];

  const target = Math.round(sampleRate * targetSeconds);
  const minChunk = Math.round(sampleRate * minSeconds);
  const maxChunk = Math.round(sampleRate * maxSeconds);
  const searchRadius = Math.round(sampleRate * searchSeconds);
  const energyRadius = Math.max(80, Math.round(sampleRate * 0.045));
  const searchStep = Math.max(80, Math.round(sampleRate * 0.015));
  const sampleAt = (i) => pcm.readInt16LE(i * 2) / 32768;

  const localEnergy = (center) => {
    const a = Math.max(0, center - energyRadius);
    const b = Math.min(totalSamples, center + energyRadius);
    let sum = 0;
    let n = 0;
    for (let i = a; i < b; i += 8) {
      const v = sampleAt(i);
      sum += v * v;
      n += 1;
    }
    return n ? sum / n : 1;
  };

  const cuts = [0];
  let current = 0;
  while (totalSamples - current > maxChunk) {
    const wanted = current + target;
    const lo = Math.max(current + minChunk, wanted - searchRadius);
    const hi = Math.min(current + maxChunk, wanted + searchRadius);
    let best = Math.min(hi, wanted);
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = lo; i <= hi; i += searchStep) {
      const energy = localEnergy(i);
      const distancePenalty = Math.abs(i - wanted) / searchRadius * 0.0000025;
      const score = energy + distancePenalty;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    cuts.push(best);
    current = best;
  }
  cuts.push(totalSamples);

  if (cuts.length > 2 && cuts.at(-1) - cuts.at(-2) < Math.round(sampleRate * 1.35)) {
    cuts.splice(-2, 1);
  }

  return cuts.slice(0, -1).map((start, index) => {
    const end = cuts[index + 1];
    return makePcm16MonoWav(pcm.subarray(start * 2, end * 2), sampleRate);
  });
}

function threadCount() {
  return Math.max(4, Math.min(12, Math.floor(os.cpus().length / 2)));
}

function modelForMode(engine, mode) {
  if (mode === 'en') return engine.modelEn;
  if (mode === 'sv') return engine.modelMulti;
  const lightweight = settings.performanceProfile === 'lightweight';
  const high = settings.performanceProfile === 'high';
  const autoWantsHigh = settings.performanceProfile === 'auto' && engine.backend === 'cuda';
  if (!lightweight && engine.bilingualModelInstalled && (high || autoWantsHigh)) return engine.modelBilingual;
  return engine.modelMulti;
}

async function runWhisperCliFallback(engine, wavBuffer, language, model, prompt = '', audioCtx = FAST_AUDIO_CTX) {
  const tempDir = path.join(app.getPath('temp'), 'Ink');
  await fsp.mkdir(tempDir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const wavPath = path.join(tempDir, `${id}.wav`);
  const outBase = path.join(tempDir, `${id}-out`);
  const outJson = `${outBase}.json`;
  await fsp.writeFile(wavPath, Buffer.from(wavBuffer));
  const args = [
    '-m', model,
    '-f', wavPath,
    '-l', language,
    '-t', String(threadCount()),
    '-ac', String(audioCtx || FAST_AUDIO_CTX),
    '-nt', '-np', '-ojf', '-of', outBase
  ];
  if (prompt) args.push('--prompt', prompt);
  try {
    await waitForProcess(spawn(engine.executable, args, {
      windowsHide: true,
      cwd: path.dirname(engine.executable)
    }));
    const payload = JSON.parse(await fsp.readFile(outJson, 'utf8'));
    const transcription = Array.isArray(payload?.transcription) ? payload.transcription : [];
    const text = cleanTranscript(transcription.map((segment) => segment?.text || '').join(' '));
    return {
      text,
      language: String(payload?.result?.language || language || 'auto').toLowerCase(),
      confidence: 0,
      segments: []
    };
  } finally {
    await Promise.allSettled([
      fsp.rm(wavPath, { force: true }),
      fsp.rm(outJson, { force: true })
    ]);
  }
}

async function inferSpeech(engine, wavBuffer, {
  language = 'auto',
  model,
  prompt = '',
  audioCtx = FAST_AUDIO_CTX,
  responseFormat = 'verbose_json'
} = {}) {
  if (engine.serverInstalled && whisperService) {
    try {
      return await whisperService.infer(wavBuffer, {
        serverExecutable: engine.serverExecutable,
        model,
        threads: threadCount(),
        flashAttention: engine.backend === 'cuda',
        audioCtx,
        language,
        prompt,
        carryPrompt: Boolean(prompt),
        responseFormat
      });
    } catch (error) {
      // Keep Ink usable on an older/odd whisper.cpp package. Settings will still
      // offer Repair so the persistent server can be restored on the next run.
      console.warn('[Ink] whisper-server fallback:', error?.message || error);
    }
  }
  return runWhisperCliFallback(engine, wavBuffer, language, model, prompt, audioCtx);
}

async function transcribeFixedLanguage(arrayBuffer, engine, language) {
  const model = modelForMode(engine, language);
  const input = Buffer.from(arrayBuffer);
  const duration = wavDurationSeconds(input);
  // whisper.cpp's partial encoder context is substantially faster on short audio.
  // Keep every inference comfortably below that context by splitting only long
  // dictations at quiet boundaries. Normal short sentences remain one request.
  const chunks = duration > 10.5
    ? splitSpeechWav(input, { targetSeconds: 7.0, minSeconds: 4.5, maxSeconds: 9.5, searchSeconds: 1.2 })
    : [input];
  const parts = [];
  let previousText = '';
  for (const chunk of chunks) {
    const prompt = previousText ? `Previous context: ${previousText.slice(-220)}` : '';
    const result = await inferSpeech(engine, chunk, {
      language,
      model,
      prompt,
      audioCtx: FAST_AUDIO_CTX,
      responseFormat: 'text'
    });
    const text = cleanTranscript(result.text);
    if (!text) continue;
    parts.push({ text, language });
    previousText = `${previousText} ${text}`.trim();
  }
  return {
    text: cleanTranscript(parts.map((part) => part.text).join(' ')),
    segments: parts,
    detectedLanguage: language
  };
}

async function transcribeCodeSwitch(arrayBuffer, engine) {
  const input = Buffer.from(arrayBuffer);
  const utteranceSeconds = wavDurationSeconds(input);
  const shortUtterance = utteranceSeconds > 0 && utteranceSeconds <= 4.25;
  const model = modelForMode(engine, 'bilingual');
  if (model === engine.modelBilingual && !engine.bilingualModelInstalled) {
    throw new Error('High-accuracy bilingual mode needs the multilingual accuracy model. Open Settings and repair the speech engine.');
  }

  const chunks = splitSpeechWav(input);
  const parts = [];
  let previousText = '';
  let previousLanguage = '';

  for (const chunk of chunks) {
    const context = previousText ? ` Previous context: ${previousText.slice(-220)}` : '';
    const prompt = shortUtterance
      ? 'English or Swedish. Preserve the language exactly as spoken.'
      : `English and Swedish; engelska och svenska. The speaker may switch naturally between English and Swedish. Preserve each language exactly as spoken.${context}`;
    let result = await inferSpeech(engine, chunk, { language: 'auto', model, prompt });
    let language = String(result.language || '').toLowerCase();
    if (language === 'english') language = 'en';
    if (language === 'swedish') language = 'sv';

    // The resident server makes a *selective* recovery pass cheap. Only retry when
    // auto-detection escapes English/Swedish or reports genuinely low confidence;
    // normal chunks stay one-pass, unlike 0.1.7's repeated CLI/model launches.
    if (!['en', 'sv'].includes(language)) {
      const guesses = previousLanguage === 'sv' ? ['sv', 'en'] : ['en', 'sv'];
      const candidates = [result];
      for (const guess of guesses) {
        const forced = await inferSpeech(engine, chunk, { language: guess, model, prompt });
        if (forced.text) candidates.push({ ...forced, language: guess });
      }
      const scored = candidates.filter((item) => Number(item.confidence) > 0);
      const best = scored.length
        ? scored.sort((a, b) => Number(b.confidence) - Number(a.confidence))[0]
        : candidates.find((item) => ['en', 'sv'].includes(item.language)) || result;
      result = best;
      language = ['en', 'sv'].includes(best.language) ? best.language : (previousLanguage || 'en');
    } else if (!shortUtterance && Number(result.confidence) > 0 && Number(result.confidence) < 0.52) {
      const alternative = language === 'en' ? 'sv' : 'en';
      const forced = await inferSpeech(engine, chunk, { language: alternative, model, prompt });
      if (forced.text && Number(forced.confidence) > Number(result.confidence) + 0.045) {
        result = forced;
        language = alternative;
      }
    }

    const text = cleanTranscript(result.text);
    if (!text) continue;
    if (!['en', 'sv'].includes(language)) language = previousLanguage || 'en';
    parts.push({ text, language });
    previousText = `${previousText} ${text}`.trim();
    previousLanguage = language;
  }

  return {
    text: cleanTranscript(parts.map((part) => part.text).join(' ')),
    segments: parts,
    detectedLanguage: parts.length ? parts[0].language : 'auto'
  };
}

function normalizeWhisperLanguage(value) {
  const raw = String(value || 'auto').trim().toLowerCase().replace('_', '-');
  const names = {
    english: 'en', swedish: 'sv', arabic: 'ar', russian: 'ru', german: 'de',
    french: 'fr', spanish: 'es', italian: 'it', portuguese: 'pt', japanese: 'ja',
    korean: 'ko', chinese: 'zh', turkish: 'tr', polish: 'pl', dutch: 'nl',
    ukrainian: 'uk', persian: 'fa', farsi: 'fa', hebrew: 'he', hindi: 'hi'
  };
  if (names[raw]) return names[raw];
  return raw.split('-')[0] || 'auto';
}

function hasArabicScript(text) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(String(text || ''));
}

async function transcribeMultilingual(arrayBuffer, engine) {
  const model = modelForMode(engine, 'multilingual');
  const input = Buffer.from(arrayBuffer);
  const duration = wavDurationSeconds(input);
  // Most multilingual requests are short. Keep the utterance intact whenever we
  // can so language ID and dialect context are not destroyed by tiny chunks.
  const chunks = duration > 10.5
    ? splitSpeechWav(input, {
        targetSeconds: 6.8,
        minSeconds: 4.4,
        maxSeconds: 9.2,
        searchSeconds: 1.2
      })
    : [input];
  const parts = [];
  let previousText = '';

  for (const chunk of chunks) {
    const context = previousText ? `Continue the same utterance. Previous context: ${previousText.slice(-220)}` : '';
    let result = await inferSpeech(engine, chunk, {
      language: 'auto',
      model,
      prompt: context,
      audioCtx: FAST_AUDIO_CTX
    });

    let text = cleanTranscript(result.text);
    if (!text) continue;
    let language = normalizeWhisperLanguage(result.language);
    if (language === 'auto' && hasArabicScript(text)) language = 'ar';

    // Whisper's automatic language selection is useful for routing, but Arabic
    // dialects are a hard ASR case. Once the first pass identifies Arabic, run one
    // *resident-model* Arabic-forced pass. This does not reload the model and usually
    // preserves colloquial Arabic more faithfully than letting auto-language decoding
    // drift toward MSA or another language. Keep the auto result if the forced pass is
    // clearly worse.
    if (language === 'ar') {
      const arabicPrompt = previousText
        ? `Arabic speech, including colloquial dialect. Preserve the words as spoken; do not translate or rewrite into another language. Previous context: ${previousText.slice(-180)}`
        : 'Arabic speech, including colloquial dialect. Preserve the words as spoken; do not translate or rewrite into another language.';
      try {
        const forced = await inferSpeech(engine, chunk, {
          language: 'ar',
          model,
          prompt: arabicPrompt,
          audioCtx: FAST_AUDIO_CTX
        });
        const forcedText = cleanTranscript(forced.text);
        const autoConfidence = Number(result.confidence) || 0;
        const forcedConfidence = Number(forced.confidence) || 0;
        if (forcedText && (!autoConfidence || !forcedConfidence || forcedConfidence >= autoConfidence - 0.08)) {
          result = forced;
          text = forcedText;
        }
      } catch (error) {
        console.warn('[Ink] Arabic dialect assist skipped:', error?.message || error);
      }
      language = 'ar';
    }

    parts.push({ text, language });
    previousText = `${previousText} ${text}`.trim();
  }

  return {
    text: cleanTranscript(parts.map((part) => part.text).join(' ')),
    segments: parts,
    detectedLanguage: parts.length ? parts[0].language : 'auto'
  };
}

async function transcribeArabicSource(arrayBuffer, engine) {
  const pack = getArabicAsrStatus();
  if (!pack.ready || !arabicAsrService) {
    throw new Error('Arabic translation needs the Arabic dialect speech pack. Open Ink Settings → Translation and install the ~1.4 GB Arabic speech pack once.');
  }

  const input = Buffer.from(arrayBuffer);
  const duration = wavDurationSeconds(input);
  // The dedicated model supports short/medium utterances directly. Split only
  // longer speech at quiet boundaries so dialect context stays intact.
  const chunks = duration > 22
    ? splitSpeechWav(input, { targetSeconds: 15, minSeconds: 9, maxSeconds: 20, searchSeconds: 1.8 })
    : [input];
  const parts = [];
  const confidences = [];

  for (const chunk of chunks) {
    const result = await arabicAsrService.transcribe(chunk);
    const text = cleanTranscript(result.text);
    if (!text) continue;
    // Never send clearly broken non-Arabic output into the translator. The pack is
    // Arabic-only, so a result with almost no Arabic script is a recognition failure.
    const arabicLetters = (text.match(/[\u0621-\u064A]/gu) || []).length;
    const visibleLetters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (visibleLetters >= 4 && arabicLetters / visibleLetters < 0.55) {
      throw new Error('Ink could not understand that Arabic clearly enough to translate it. Please try the sentence again.');
    }
    parts.push({ text, language: 'ar' });
    if (Number(result.confidence) > 0) confidences.push(Number(result.confidence));
  }

  const text = cleanTranscript(parts.map((part) => part.text).join(' '));
  if (!text) throw new Error('Ink did not catch enough Arabic speech to translate.');
  return {
    text,
    segments: parts,
    detectedLanguage: 'ar',
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
    recognitionStrategy: 'arabic-dialect-pack',
    recognitionEngine: 'Arabic Dialect Pack v2 · ONNX INT8'
  };
}

async function transcribeLockedTranslationSource(arrayBuffer, engine, language) {
  const normalizedLanguage = normalizeWhisperLanguage(language);
  const model = modelForMode(engine, 'multilingual');
  const input = Buffer.from(arrayBuffer);
  const duration = wavDurationSeconds(input);
  const chunks = duration > 10.5
    ? splitSpeechWav(input, { targetSeconds: 7.0, minSeconds: 4.5, maxSeconds: 9.5, searchSeconds: 1.2 })
    : [input];
  const parts = [];
  const confidences = [];
  let previousText = '';

  for (const chunk of chunks) {
    const languageName = {
      sv: 'Swedish', en: 'English', ru: 'Russian', de: 'German', fr: 'French',
      es: 'Spanish', it: 'Italian', pt: 'Portuguese', uk: 'Ukrainian', tr: 'Turkish',
      fa: 'Persian', ur: 'Urdu', hi: 'Hindi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
      nl: 'Dutch', pl: 'Polish', da: 'Danish', no: 'Norwegian', fi: 'Finnish'
    }[normalizedLanguage] || normalizedLanguage;
    const context = previousText ? ` Previous context: ${previousText.slice(-220)}` : '';
    const prompt = `Transcribe exactly as spoken in ${languageName}. Do not translate, paraphrase, summarize, or add information.${context}`;
    const result = await inferSpeech(engine, chunk, {
      language: normalizedLanguage,
      model,
      prompt,
      audioCtx: FAST_AUDIO_CTX
    });
    const text = cleanTranscript(result.text);
    if (!text) continue;
    parts.push({ text, language: normalizedLanguage });
    if (Number(result.confidence) > 0) confidences.push(Number(result.confidence));
    previousText = `${previousText} ${text}`.trim();
  }

  return {
    text: cleanTranscript(parts.map((part) => part.text).join(' ')),
    segments: parts,
    detectedLanguage: normalizedLanguage,
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
    recognitionStrategy: 'language-locked'
  };
}

async function transcribeAutoTranslationSource(arrayBuffer, engine) {
  const input = Buffer.from(arrayBuffer);
  const model = modelForMode(engine, 'multilingual');

  // Automatic translation is intentionally a two-stage ASR path: use only the
  // beginning of the utterance to identify the language, then decode the complete
  // recording with that language locked. The old full-auto decode could identify
  // Swedish correctly while still hearing words such as "hans medicin" as unrelated
  // Swedish words. Locking the decoder after language ID improves lexical accuracy
  // without paying for two complete Whisper passes.
  const detectionChunks = splitSpeechWav(input, {
    targetSeconds: 3.2,
    minSeconds: 1.6,
    maxSeconds: 4.2,
    searchSeconds: 0.6
  });
  const probe = detectionChunks[0] || input;
  const detected = await inferSpeech(engine, probe, {
    language: 'auto',
    model,
    prompt: 'Transcribe the speech exactly as spoken. Do not translate or paraphrase.',
    audioCtx: FAST_AUDIO_CTX
  });
  let language = normalizeWhisperLanguage(detected.language);
  const probeText = cleanTranscript(detected.text);
  if ((language === 'auto' || !language) && hasArabicScript(probeText)) language = 'ar';

  if (!language || language === 'auto') {
    const fallback = await transcribeMultilingual(arrayBuffer, engine);
    return { ...fallback, recognitionStrategy: 'automatic-fallback' };
  }
  if (language === 'ar') {
    const arabic = await transcribeArabicSource(arrayBuffer, engine);
    return { ...arabic, recognitionStrategy: 'automatic→arabic-locked' };
  }

  const locked = await transcribeLockedTranslationSource(arrayBuffer, engine, language);
  if (locked.text) return { ...locked, recognitionStrategy: `automatic→${language}-locked` };

  const fallback = await transcribeMultilingual(arrayBuffer, engine);
  return { ...fallback, recognitionStrategy: 'automatic-fallback' };
}

async function transcribeTranslationSource(arrayBuffer, engine) {
  const source = String(settings.translationSource || 'auto').toLowerCase();
  if (source === 'auto') return transcribeAutoTranslationSource(arrayBuffer, engine);
  if (source === 'bilingual') return transcribeCodeSwitch(arrayBuffer, engine);
  if (source === 'ar') return transcribeArabicSource(arrayBuffer, engine);
  return transcribeLockedTranslationSource(arrayBuffer, engine, source);
}

async function translateResult(transcription) {
  if (!translationService?.status().ready) {
    throw new Error('Translation engine is not installed. Open Ink Settings → Translation and install it once.');
  }
  const target = settings.translationTarget || 'en';
  const translated = await translationService.translateSegments(transcription.segments, target, { quality: effectiveTranslationQuality() });
  const text = cleanTranscript(translated?.text);
  if (!text) throw new Error('Ink could not produce a translation.');
  lastTranslation = { text, language: target, source: transcription.text, createdAt: Date.now() };
  buildTrayMenu();
  return { text, engine: translated?.engine || 'unknown' };
}

async function playLastTranslation() {
  if (!lastTranslation?.text) return { ok: false, error: 'There is no translation to play yet.' };
  try {
    await ttsService?.speak(lastTranslation.text, lastTranslation.language);
    return { ok: true };
  } catch (error) {
    showPill('error', { message: error?.message || 'Could not play the translated voice.' });
    hidePill(2400);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function prewarmSpeechEngine() {
  if (!whisperService) return;
  const engine = getEngineStatus();
  if (!engine.ready || !engine.serverInstalled) return;
  const mode = settings.language === 'bilingual' ? 'bilingual' : settings.language || 'en';
  const model = modelForMode(engine, mode);
  try {
    await whisperService.ensure({
      serverExecutable: engine.serverExecutable,
      model,
      threads: threadCount(),
      flashAttention: engine.backend === 'cuda',
      audioCtx: FAST_AUDIO_CTX
    });
  } catch (error) {
    // Prewarming is an optimization only. Dictation still has the CLI fallback and
    // Settings can repair an older runtime that does not contain whisper-server.
    console.warn('[Ink] speech prewarm skipped:', error?.message || error);
  }
}

async function transcribeWav(arrayBuffer, action = 'dictate') {
  const engine = getEngineStatus();
  if (!engine.ready) {
    return { ok: false, error: 'Speech engine is not installed. Open Ink Settings and install it first.' };
  }

  let transcription = null;
  try {
    if (action === 'translate') {
      // Translation has its own source-language configuration. A fixed source skips
      // generic language detection, which is both faster and more reliable for cases
      // such as dialectal Arabic → Swedish.
      transcription = await transcribeTranslationSource(arrayBuffer, engine);
    } else if (settings.language === 'bilingual') {
      transcription = await transcribeCodeSwitch(arrayBuffer, engine);
    } else if (settings.language === 'multilingual') {
      // 'multilingual' is an Ink UI mode, not a Whisper language code. Older builds
      // accidentally passed the literal word to Whisper, which could make Automatic
      // language dictation fail outright.
      transcription = await transcribeMultilingual(arrayBuffer, engine);
    } else {
      transcription = await transcribeFixedLanguage(arrayBuffer, engine, settings.language || 'en');
    }

    if (!transcription.text) return { ok: false, error: 'I didn’t catch any speech.' };

    const translation = action === 'translate' ? await translateResult(transcription) : null;
    const outputText = translation ? translation.text : transcription.text;

    pushRecentActivity({
      action,
      heard: transcription.text,
      translated: translation?.text || '',
      detectedLanguage: transcription.detectedLanguage || transcription.segments?.[0]?.language || 'auto',
      dictationMode: settings.language,
      translationSource: action === 'translate' ? settings.translationSource : null,
      targetLanguage: action === 'translate' ? settings.translationTarget : null,
      translationEngine: translation?.engine || null,
      recognitionStrategy: transcription.recognitionStrategy || '',
      recognitionEngine: transcription.recognitionEngine || '',
      recognitionConfidence: Number(transcription.confidence) || 0,
      error: ''
    });

    if (settings.autoPaste) {
      clipboard.writeText(outputText);
      await new Promise((resolve) => setTimeout(resolve, 35));
      await sendPasteKeystroke();
    } else {
      clipboard.writeText(outputText);
    }

    return {
      ok: true,
      text: outputText,
      originalText: transcription.text,
      translated: action === 'translate',
      targetLanguage: action === 'translate' ? settings.translationTarget : null,
      pasted: settings.autoPaste,
      segments: transcription.segments
    };
  } catch (error) {
    const message = error?.message || String(error);
    if (action === 'translate') {
      pushRecentActivity({
        action,
        heard: transcription?.text || '',
        translated: '',
        detectedLanguage: transcription?.detectedLanguage || transcription?.segments?.[0]?.language || 'auto',
        translationSource: settings.translationSource || 'auto',
        targetLanguage: settings.translationTarget || 'en',
        translationEngine: null,
        recognitionStrategy: transcription?.recognitionStrategy || '',
        recognitionEngine: transcription?.recognitionEngine || '',
        recognitionConfidence: Number(transcription?.confidence) || 0,
        error: message
      });
    }
    return { ok: false, error: message };
  }
}

function sanitizeSettings(candidate) {
  const next = { ...settings };
  if (typeof candidate.hotkey === 'string' && candidate.hotkey.trim()) next.hotkey = candidate.hotkey.trim();
  if (typeof candidate.translationHotkey === 'string' && candidate.translationHotkey.trim()) next.translationHotkey = candidate.translationHotkey.trim();
  if (typeof candidate.playTranslationHotkey === 'string' && candidate.playTranslationHotkey.trim()) next.playTranslationHotkey = candidate.playTranslationHotkey.trim();
  if (typeof candidate.microphoneId === 'string') next.microphoneId = candidate.microphoneId;
  if (typeof candidate.microphoneLabel === 'string') next.microphoneLabel = candidate.microphoneLabel;
  if (['en', 'sv', 'bilingual', 'multilingual'].includes(candidate.language)) next.language = candidate.language;
  if (['auto', 'lightweight', 'high'].includes(candidate.performanceProfile)) next.performanceProfile = candidate.performanceProfile;
  if (typeof candidate.translationSource === 'string' && /^[a-z]{2,3}$|^(auto|bilingual)$/.test(candidate.translationSource.trim().toLowerCase())) next.translationSource = candidate.translationSource.trim().toLowerCase();
  if (typeof candidate.translationTarget === 'string' && candidate.translationTarget.trim()) next.translationTarget = candidate.translationTarget.trim().toLowerCase();
  if (['auto', 'fast', 'quality'].includes(candidate.translationQuality)) next.translationQuality = candidate.translationQuality;
  if (typeof candidate.autoPaste === 'boolean') next.autoPaste = candidate.autoPaste;
  if (typeof candidate.launchAtLogin === 'boolean') next.launchAtLogin = candidate.launchAtLogin;
  return next;
}

function setupIpc() {
  ipcMain.handle('get-settings', () => ({ ...settings }));
  ipcMain.handle('get-recent-activity', () => recentActivity ? { ...recentActivity } : null);
  ipcMain.handle('copy-text', (_event, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
  ipcMain.handle('get-engine-status', () => getEngineStatus());
  ipcMain.handle('get-translation-status', () => getTranslationStatus());
  ipcMain.handle('get-arabic-asr-status', () => getArabicAsrStatus());
  ipcMain.handle('list-translation-languages', (_event, refresh) => listTranslationLanguages(Boolean(refresh)));
  ipcMain.handle('open-user-data', async () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('save-settings', async (_event, candidate) => {
    const previous = { ...settings };
    const next = sanitizeSettings(candidate || {});

    const restoreHotkeys = () => {
      if (mainHotkey) globalShortcut.unregister(mainHotkey);
      if (translationHotkey) globalShortcut.unregister(translationHotkey);
      if (playTranslationHotkey) globalShortcut.unregister(playTranslationHotkey);
      mainHotkey = translationHotkey = playTranslationHotkey = null;
      registerMainHotkey(previous.hotkey);
      registerTranslationHotkey(previous.translationHotkey);
      registerPlayTranslationHotkey(previous.playTranslationHotkey);
    };

    if (next.hotkey !== settings.hotkey) {
      if (mainHotkey) globalShortcut.unregister(mainHotkey);
      mainHotkey = null;
      if (!registerMainHotkey(next.hotkey)) {
        restoreHotkeys();
        return { ok: false, error: `Windows would not register ${next.hotkey}. Try another shortcut.` };
      }
    }
    if (next.translationHotkey !== settings.translationHotkey) {
      if (translationHotkey) globalShortcut.unregister(translationHotkey);
      translationHotkey = null;
      if (!registerTranslationHotkey(next.translationHotkey)) {
        restoreHotkeys();
        return { ok: false, error: `Windows would not register ${next.translationHotkey}. Try another shortcut.` };
      }
    }
    if (next.playTranslationHotkey !== settings.playTranslationHotkey) {
      if (playTranslationHotkey) globalShortcut.unregister(playTranslationHotkey);
      playTranslationHotkey = null;
      if (!registerPlayTranslationHotkey(next.playTranslationHotkey)) {
        restoreHotkeys();
        return { ok: false, error: `Windows would not register ${next.playTranslationHotkey}. Try another shortcut.` };
      }
    }

    const speechProfileChanged = next.language !== settings.language || next.performanceProfile !== settings.performanceProfile;
    settings = next;
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
    await saveSettings();
    buildTrayMenu();
    if (speechProfileChanged) {
      await whisperService?.stop();
      prewarmSpeechEngine().catch(() => {});
    }
    if (next.translationQuality !== previous.translationQuality || speechProfileChanged) {
      translationService?.stop();
      prewarmTranslationEngine().catch(() => {});
  if (settings.translationSource === 'ar' && getArabicAsrStatus().ready) {
    arabicAsrService?.warm().catch(() => {});
  }
    }
    return { ok: true, settings: { ...settings } };
  });

  ipcMain.handle('install-engine', (event) => installEngine(event));
  ipcMain.handle('install-translation-engine', (event) => installTranslationEngine(event));
  ipcMain.handle('install-quality-translation', (event) => installHighQualityTranslation(event));
  ipcMain.handle('install-arabic-asr', (event) => installArabicAsr(event));
  ipcMain.handle('prepare-translation-target', (event, target) => prepareTranslationTarget(target, event));
  ipcMain.handle('play-last-translation', () => playLastTranslation());
  ipcMain.handle('open-voice-settings', () => shell.openExternal('ms-settings:speech'));

  ipcMain.on('recording-error', (_event, message) => {
    mode = 'idle';
    unregisterEscape();
    showPill('error', { message: message || 'Microphone error' });
    hidePill(1800);
  });

  ipcMain.handle('transcribe', async (_event, arrayBuffer, action = recordingAction) => {
    mode = 'processing';
    const result = await transcribeWav(arrayBuffer, action);
    mode = 'idle';
    if (result.ok) {
      if (result.translated) {
        showPill('translated', { message: 'Listen' });
        hidePill(3200);
      } else {
        showPill('success', { message: result.pasted ? 'Pasted' : 'Copied' });
        hidePill(520);
      }
    } else {
      lastError = String(result.error || 'Unknown Ink error');
      buildTrayMenu();
      showPill('error', { message: action === 'translate' ? 'Translation failed' : result.error });
      hidePill(6500);
    }
    return result;
  });
}

if (isPrimaryInstance) {
  app.on('second-instance', () => {
    createSettingsWindow();
  });
}

if (isPrimaryInstance) app.whenReady().then(async () => {
  await loadSettings();

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  ses.setPermissionCheckHandler((_webContents, permission) => permission === 'media');

  whisperService = new WhisperService();
  const speechEngineForTranslation = getEngineStatus();
  const cudaSearchPaths = [
    speechEngineForTranslation.executable ? path.dirname(speechEngineForTranslation.executable) : null,
    speechEngineForTranslation.serverExecutable ? path.dirname(speechEngineForTranslation.serverExecutable) : null
  ].filter(Boolean);
  translationService = new TranslationService({
    root: translationRoot(),
    workerPath: resourceScript('translator-worker.py'),
    deviceType: speechEngineForTranslation.backend === 'cuda' ? 'auto' : 'cpu',
    cudaSearchPaths
  });
  arabicAsrService = new ArabicAsrService({
    root: arabicAsrRoot(),
    workerPath: resourceScript('arabic-asr-worker.py'),
    tempRoot: path.join(app.getPath('temp'), 'Ink')
  });
  ttsService = new TtsService({
    scriptPath: resourceScript('speak.ps1'),
    tempRoot: path.join(app.getPath('temp'), 'Ink')
  });

  setupIpc();
  createPillWindow();
  createTray();

  let hotkeysChanged = false;
  if (!registerMainHotkey(settings.hotkey)) {
    settings.hotkey = DEFAULT_SETTINGS.hotkey;
    registerMainHotkey(settings.hotkey);
    hotkeysChanged = true;
  }
  if (!registerTranslationHotkey(settings.translationHotkey)) {
    const fallback = 'Control+Alt+T';
    settings.translationHotkey = fallback;
    registerTranslationHotkey(fallback);
    hotkeysChanged = true;
  }
  if (!registerPlayTranslationHotkey(settings.playTranslationHotkey)) {
    const fallback = 'Control+Alt+L';
    settings.playTranslationHotkey = fallback;
    registerPlayTranslationHotkey(fallback);
    hotkeysChanged = true;
  }
  if (hotkeysChanged) {
    await saveSettings();
    buildTrayMenu();
  }

  // Keep the selected speech model resident so the first dictation does not pay
  // the model-load cost. On a CPU-only/low-end machine Automatic chooses base.
  prewarmSpeechEngine().catch(() => {});
  prewarmTranslationEngine().catch(() => {});
  if (settings.translationSource === 'ar' && getArabicAsrStatus().ready) {
    arabicAsrService?.warm().catch(() => {});
  }

  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });

  screen.on('display-metrics-changed', () => positionPill({ force: true }));
  screen.on('display-added', () => positionPill({ force: true }));
  screen.on('display-removed', () => positionPill({ force: true }));
});

app.on('window-all-closed', () => {
  // Ink is a tray app. Keep running until the user chooses Quit Ink.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  whisperService?.stop();
  translationService?.stop();
  arabicAsrService?.stop();
  ttsService?.stop();
});

app.on('activate', () => createSettingsWindow());
