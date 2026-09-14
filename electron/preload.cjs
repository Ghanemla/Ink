const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ink', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getRecentActivity: () => ipcRenderer.invoke('get-recent-activity'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  getEngineStatus: () => ipcRenderer.invoke('get-engine-status'),
  installEngine: () => ipcRenderer.invoke('install-engine'),
  onEngineInstallProgress: (callback) => ipcRenderer.on('engine-install-progress', (_event, line) => callback(line)),

  getTranslationStatus: () => ipcRenderer.invoke('get-translation-status'),
  getArabicAsrStatus: () => ipcRenderer.invoke('get-arabic-asr-status'),
  installTranslationEngine: () => ipcRenderer.invoke('install-translation-engine'),
  installQualityTranslation: () => ipcRenderer.invoke('install-quality-translation'),
  installArabicAsr: () => ipcRenderer.invoke('install-arabic-asr'),
  listTranslationLanguages: (refresh = false) => ipcRenderer.invoke('list-translation-languages', refresh),
  prepareTranslationTarget: (target) => ipcRenderer.invoke('prepare-translation-target', target),
  onTranslationInstallProgress: (callback) => ipcRenderer.on('translation-install-progress', (_event, line) => callback(line)),
  onArabicAsrInstallProgress: (callback) => ipcRenderer.on('arabic-asr-install-progress', (_event, line) => callback(line)),
  playLastTranslation: () => ipcRenderer.invoke('play-last-translation'),
  openVoiceSettings: () => ipcRenderer.invoke('open-voice-settings'),

  openUserData: () => ipcRenderer.invoke('open-user-data'),
  transcribe: (arrayBuffer, action = 'dictate') => ipcRenderer.invoke('transcribe', arrayBuffer, action),
  reportRecordingError: (message) => ipcRenderer.send('recording-error', message),
  onBeginRecording: (callback) => ipcRenderer.on('begin-recording', (_event, payload) => callback(payload)),
  onFinishRecording: (callback) => ipcRenderer.on('finish-recording', () => callback()),
  onCancelRecording: (callback) => ipcRenderer.on('cancel-recording', () => callback()),
  onPillState: (callback) => ipcRenderer.on('pill-state', (_event, payload) => callback(payload)),
  onRecentActivity: (callback) => ipcRenderer.on('recent-activity-updated', (_event, payload) => callback(payload))
});
