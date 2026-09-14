(() => {
  const els = {
    microphone: document.getElementById('microphone'),
    refreshMics: document.getElementById('refreshMics'),
    hotkey: document.getElementById('hotkey'),
    language: document.getElementById('language'),
    performanceProfile: document.getElementById('performanceProfile'),
    autoPaste: document.getElementById('autoPaste'),
    launchAtLogin: document.getElementById('launchAtLogin'),
    saveState: document.getElementById('saveState'),
    installEngine: document.getElementById('installEngine'),
    engineSummary: document.getElementById('engineSummary'),
    engineBadge: document.getElementById('engineBadge'),
    engineProgress: document.getElementById('engineProgress'),
    openData: document.getElementById('openData'),
    translationSource: document.getElementById('translationSource'),
    translationTarget: document.getElementById('translationTarget'),
    translationQuality: document.getElementById('translationQuality'),
    refreshLanguages: document.getElementById('refreshLanguages'),
    translationHotkey: document.getElementById('translationHotkey'),
    playTranslationHotkey: document.getElementById('playTranslationHotkey'),
    installTranslation: document.getElementById('installTranslation'),
    installArabicAsr: document.getElementById('installArabicAsr'),
    arabicAsrSummary: document.getElementById('arabicAsrSummary'),
    arabicAsrBadge: document.getElementById('arabicAsrBadge'),
    arabicAsrProgress: document.getElementById('arabicAsrProgress'),
    installQualityTranslation: document.getElementById('installQualityTranslation'),
    prepareTranslation: document.getElementById('prepareTranslation'),
    translationSummary: document.getElementById('translationSummary'),
    translationBadge: document.getElementById('translationBadge'),
    translationProgress: document.getElementById('translationProgress'),
    openVoiceSettings: document.getElementById('openVoiceSettings'),
    recentMeta: document.getElementById('recentMeta'),
    recentHeard: document.getElementById('recentHeard'),
    recentTranslated: document.getElementById('recentTranslated'),
    recentErrorRow: document.getElementById('recentErrorRow'),
    recentError: document.getElementById('recentError'),
    copyRecentActivity: document.getElementById('copyRecentActivity')
  };

  const fallbackLanguages = [
    ['ar', 'Arabic'], ['az', 'Azerbaijani'], ['eu', 'Basque'], ['ca', 'Catalan'],
    ['zh', 'Chinese'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'],
    ['en', 'English'], ['eo', 'Esperanto'], ['fi', 'Finnish'], ['fr', 'French'],
    ['gl', 'Galician'], ['de', 'German'], ['el', 'Greek'], ['he', 'Hebrew'],
    ['hi', 'Hindi'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['ga', 'Irish'],
    ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ms', 'Malay'],
    ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ru', 'Russian'],
    ['sk', 'Slovak'], ['es', 'Spanish'], ['sw', 'Swahili'], ['sv', 'Swedish'],
    ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['ur', 'Urdu']
  ];

  const hotkeyButtons = {
    hotkey: els.hotkey,
    translationHotkey: els.translationHotkey,
    playTranslationHotkey: els.playTranslationHotkey
  };

  let settings = null;
  let capturingField = null;
  let saveTimer = 0;
  let translationReady = false;

  function prettyHotkey(value) {
    return String(value || '')
      .replace(/CommandOrControl/gi, 'Ctrl')
      .replace(/Control/gi, 'Ctrl')
      .replace(/\+/g, ' + ');
  }

  function setSaveState(text, error = false) {
    els.saveState.textContent = text;
    els.saveState.classList.toggle('is-error', error);
  }

  function setBadge(el, state, text) {
    el.classList.toggle('is-ready', state === 'ready');
    el.classList.toggle('is-partial', state === 'partial');
    el.textContent = text;
  }

  function sourceModeName(value) {
    const code = String(value || 'auto').toLowerCase();
    if (code === 'auto') return 'Automatic source';
    if (code === 'bilingual') return 'English + Swedish mixed';
    if (code === 'multilingual') return 'Any supported language';
    if (code === 'en') return 'English';
    if (code === 'sv') return 'Swedish';
    if (code === 'ar') return 'Arabic (automatic dialect)';
    return readableLanguageName(code) || code.toUpperCase();
  }

  function renderRecentActivity(activity) {
    const item = activity && typeof activity === 'object' ? activity : null;
    if (!item || (!item.heard && !item.translated && !item.error)) {
      els.recentMeta.textContent = 'Nothing recorded this session yet.';
      els.recentHeard.textContent = '—';
      els.recentTranslated.textContent = '—';
      els.recentErrorRow.hidden = true;
      els.copyRecentActivity.disabled = true;
      els.copyRecentActivity.dataset.copy = '';
      return;
    }

    const detected = item.detectedLanguage && item.detectedLanguage !== 'auto'
      ? (readableLanguageName(item.detectedLanguage) || String(item.detectedLanguage).toUpperCase())
      : 'Automatic / uncertain';
    const source = item.translationSource ? sourceModeName(item.translationSource) : sourceModeName(item.dictationMode);
    const target = item.targetLanguage
      ? (readableLanguageName(item.targetLanguage) || String(item.targetLanguage).toUpperCase())
      : '';
    const engine = item.translationEngine ? ` · ${String(item.translationEngine).toUpperCase()}` : '';
    const recognition = item.recognitionStrategy ? ` · ASR ${String(item.recognitionStrategy)}` : '';
    const recognitionEngine = item.recognitionEngine ? ` · ${String(item.recognitionEngine)}` : '';
    els.recentMeta.textContent = item.action === 'translate'
      ? `${source} · detected ${detected}${recognition}${recognitionEngine} → ${target || 'target'}${engine}`
      : `Dictation · ${source} · detected ${detected}${recognition}${recognitionEngine}`;
    els.recentHeard.textContent = item.heard || '—';
    els.recentTranslated.textContent = item.action === 'translate' ? (item.translated || '—') : '—';
    els.recentErrorRow.hidden = !item.error;
    els.recentError.textContent = item.error || '—';
    const details = [
      els.recentMeta.textContent,
      `Heard: ${item.heard || '—'}`,
      item.action === 'translate' ? `Translated: ${item.translated || '—'}` : '',
      item.error ? `Error: ${item.error}` : ''
    ].filter(Boolean).join('\n');
    els.copyRecentActivity.dataset.copy = details;
    els.copyRecentActivity.disabled = false;
  }

  function buildSettingsPatch() {
    const selectedMic = els.microphone.selectedOptions[0];
    return {
      ...settings,
      microphoneId: els.microphone.value || 'default',
      microphoneLabel: selectedMic?.textContent || 'Windows default microphone',
      language: els.language.value,
      performanceProfile: els.performanceProfile.value,
      translationSource: els.translationSource.value || settings.translationSource || 'auto',
      translationTarget: els.translationTarget.value || settings.translationTarget || 'en',
      translationQuality: els.translationQuality.value || settings.translationQuality || 'auto',
      autoPaste: els.autoPaste.checked,
      launchAtLogin: els.launchAtLogin.checked
    };
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    setSaveState('Saving…');
    const result = await window.ink.saveSettings(buildSettingsPatch());
    if (!result.ok) {
      setSaveState(result.error || 'Could not save', true);
      return false;
    }
    settings = result.settings;
    for (const [field, button] of Object.entries(hotkeyButtons)) {
      button.textContent = prettyHotkey(settings[field]);
    }
    setSaveState('Saved');
    setTimeout(() => setSaveState('Ready'), 900);
    return true;
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 160);
  }

  async function loadMicrophones() {
    const previous = settings?.microphoneId || 'default';
    els.refreshMics.disabled = true;
    try {
      let permissionStream = null;
      try { permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      finally { permissionStream?.getTracks().forEach((track) => track.stop()); }

      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
      els.microphone.innerHTML = '';
      const defaultOption = document.createElement('option');
      defaultOption.value = 'default';
      defaultOption.textContent = 'Windows default microphone';
      els.microphone.appendChild(defaultOption);

      const seen = new Set();
      for (const device of devices) {
        if (!device.deviceId || device.deviceId === 'default' || seen.has(device.deviceId)) continue;
        seen.add(device.deviceId);
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${seen.size}`;
        els.microphone.appendChild(option);
      }
      const exists = [...els.microphone.options].some((option) => option.value === previous);
      els.microphone.value = exists ? previous : 'default';
    } catch (error) {
      els.microphone.innerHTML = '<option value="default">Windows default microphone</option>';
      setSaveState(error?.name === 'NotAllowedError' ? 'Microphone permission blocked' : 'Could not read microphones', true);
    } finally {
      els.refreshMics.disabled = false;
    }
  }

  function acceleratorFromEvent(event) {
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Super');
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
    let key = event.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key === 'Escape') return 'Escape';
    else key = key.replace(/^Arrow/, '');
    if (!modifiers.length && !/^F\d{1,2}$/.test(key)) return null;
    return [...modifiers, key].join('+');
  }

  function beginHotkeyCapture(field) {
    if (capturingField && hotkeyButtons[capturingField]) {
      hotkeyButtons[capturingField].classList.remove('is-capturing');
      hotkeyButtons[capturingField].textContent = prettyHotkey(settings[capturingField]);
    }
    capturingField = field;
    const button = hotkeyButtons[field];
    button.classList.add('is-capturing');
    button.textContent = 'Press shortcut…';
    button.focus();
  }

  async function captureHotkey(event) {
    if (!capturingField) return;
    event.preventDefault();
    event.stopPropagation();
    const field = capturingField;
    const button = hotkeyButtons[field];

    if (event.key === 'Escape') {
      capturingField = null;
      button.classList.remove('is-capturing');
      button.textContent = prettyHotkey(settings[field]);
      button.blur();
      return;
    }

    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) return;
    const old = settings[field];
    settings = { ...settings, [field]: accelerator };
    button.textContent = prettyHotkey(accelerator);
    const ok = await saveNow();
    if (!ok) {
      settings[field] = old;
      button.textContent = prettyHotkey(old);
    }
    capturingField = null;
    button.classList.remove('is-capturing');
    button.blur();
  }

  function renderEngine(status) {
    if (status?.fullyReady) {
      const backend = status.backend === 'cuda' ? 'CUDA' : status.backend === 'cpu' ? 'CPU' : 'Local';
      setBadge(els.engineBadge, 'ready', 'Ready');
      els.engineSummary.textContent = `whisper.cpp ${status.version || ''} · ${backend} · persistent speech server + accuracy models ready`.replace(/\s+/g, ' ').trim();
      els.installEngine.textContent = 'Repair / reinstall';
      return;
    }

    if (status?.ready && !status?.serverInstalled) {
      setBadge(els.engineBadge, 'partial', 'Speed upgrade');
      els.engineSummary.textContent = 'Your models are installed, but Ink 0.1.8 needs the persistent Whisper server to remove repeated model-load delays.';
      els.installEngine.textContent = 'Install speed upgrade';
      return;
    }

    if (status?.ready && !status?.bilingualModelInstalled) {
      setBadge(els.engineBadge, 'partial', 'Accuracy upgrade');
      els.engineSummary.textContent = 'Basic dictation works. Install the high-accuracy multilingual model for stronger English ↔ Swedish switching on capable hardware.';
      els.installEngine.textContent = 'Install accuracy upgrade';
      return;
    }

    if (status?.engineInstalled) {
      const missing = [];
      if (!status.englishModelInstalled) missing.push('English model');
      if (!status.multilingualModelInstalled) missing.push('multilingual model');
      if (!status.bilingualModelInstalled) missing.push('accuracy model');
      if (!status.serverInstalled) missing.push('persistent server');
      setBadge(els.engineBadge, 'partial', 'Incomplete');
      els.engineSummary.textContent = `${missing.join(' + ') || 'Speech components'} still need setup. Existing downloads will be kept.`;
      els.installEngine.textContent = 'Resume setup';
      return;
    }

    setBadge(els.engineBadge, '', 'Not installed');
    els.engineSummary.textContent = 'Install whisper.cpp once. Audio stays local during transcription.';
    els.installEngine.textContent = 'Install speech engine';
  }

  async function refreshEngine() {
    renderEngine(await window.ink.getEngineStatus());
  }

  async function installEngine() {
    els.installEngine.disabled = true;
    els.engineProgress.hidden = false;
    els.engineProgress.textContent = 'Preparing local speech engine…\n';
    setBadge(els.engineBadge, '', 'Installing');
    els.engineSummary.textContent = 'Downloading only missing components. Existing models are kept.';
    const result = await window.ink.installEngine();
    els.installEngine.disabled = false;
    if (result.ok) {
      els.engineProgress.textContent += '\nDone. Persistent speech is ready.\n';
      renderEngine(result.status);
    } else {
      renderEngine(result.status || {});
      setBadge(els.engineBadge, '', 'Setup failed');
      els.engineSummary.textContent = result.error || 'Could not install the speech engine. Retry continues from existing files.';
      els.installEngine.textContent = 'Retry setup';
    }
  }

  const commonTargetCodes = [
    'en', 'sv', 'ar', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'uk', 'tr', 'fa',
    'ur', 'hi', 'zh', 'ja', 'ko', 'nl', 'pl', 'da', 'no', 'fi'
  ];

  const arabicVarietyCodes = ['arb', 'arz', 'ary', 'apc', 'ajp', 'acm', 'afb', 'ars', 'aeb', 'arq', 'shu'];

  function readableLanguageName(code, suppliedName = '') {
    const normalized = String(code || '').toLowerCase();
    const supplied = String(suppliedName || '').trim();
    if (supplied && supplied.toLowerCase() !== normalized) return supplied;

    const mapped = window.INK_LANGUAGE_NAMES?.[normalized];
    if (mapped) return mapped;

    try {
      const resolved = new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized);
      if (resolved && resolved.toLowerCase() !== normalized) return resolved;
    } catch {}
    return '';
  }

  function appendLanguageOptions(group, entries) {
    for (const [code, name] of entries) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = name;
      group.appendChild(option);
    }
  }

  function populateLanguages(languages, selected) {
    const unique = new Map();
    for (const item of languages || []) {
      if (!item?.code) continue;
      const code = String(item.code).toLowerCase();
      const name = readableLanguageName(code, item.name);
      // MADLAD exposes a very broad tag vocabulary. If a tag cannot be turned into
      // an actual human-readable language name, hide it instead of showing cryptic
      // codes such as "tvl" or "acf" in the user-facing picker.
      if (!name) continue;
      unique.set(code, name);
    }
    if (!unique.size) for (const [code, name] of fallbackLanguages) unique.set(code, name);

    const selectedCode = String(selected || '').toLowerCase();
    if (selectedCode && !unique.has(selectedCode)) {
      const selectedName = readableLanguageName(selectedCode);
      if (selectedName) unique.set(selectedCode, selectedName);
    }

    els.translationTarget.innerHTML = '';

    const common = commonTargetCodes
      .filter((code) => unique.has(code))
      .map((code) => [code, unique.get(code)]);
    const arabicVarieties = arabicVarietyCodes
      .filter((code) => unique.has(code))
      .map((code) => [code, unique.get(code)]);
    const reserved = new Set([...commonTargetCodes, ...arabicVarietyCodes]);
    const more = [...unique.entries()]
      .filter(([code]) => !reserved.has(code))
      .sort((a, b) => a[1].localeCompare(b[1]));

    if (common.length) {
      const group = document.createElement('optgroup');
      group.label = 'Common languages';
      appendLanguageOptions(group, common);
      els.translationTarget.appendChild(group);
    }
    if (arabicVarieties.length) {
      const group = document.createElement('optgroup');
      group.label = 'Arabic varieties';
      appendLanguageOptions(group, arabicVarieties);
      els.translationTarget.appendChild(group);
    }
    if (more.length) {
      const group = document.createElement('optgroup');
      group.label = 'More languages';
      appendLanguageOptions(group, more);
      els.translationTarget.appendChild(group);
    }

    els.translationTarget.value = selectedCode && unique.has(selectedCode) ? selectedCode : 'en';
  }

  function renderArabicAsr(status) {
    const ready = Boolean(status?.ready);
    if (ready) {
      setBadge(els.arabicAsrBadge, 'ready', 'Ready');
      els.arabicAsrSummary.textContent = `${status.model || 'Arabic dialect model'} · ${status.dialects || 13} dialects · local INT8 recognition`;
      els.installArabicAsr.textContent = 'Repair / reinstall Arabic pack';
    } else {
      setBadge(els.arabicAsrBadge, '', 'Optional');
      els.arabicAsrSummary.textContent = 'Install this for much stronger Arabic dialect recognition before translation.';
      els.installArabicAsr.textContent = 'Install Arabic dialect pack (~1.4 GB)';
    }
    els.installArabicAsr.disabled = false;
  }

  async function refreshArabicAsr() {
    const status = await window.ink.getArabicAsrStatus();
    renderArabicAsr(status);
  }

  async function installArabicAsr() {
    els.installArabicAsr.disabled = true;
    els.arabicAsrProgress.hidden = false;
    els.arabicAsrProgress.textContent = 'Preparing Arabic dialect speech pack…\n';
    setBadge(els.arabicAsrBadge, '', 'Installing');
    els.arabicAsrSummary.textContent = 'Installing the private CPU speech runtime and downloading the Arabic dialect model. This is a one-time ~1.4 GB model download.';
    const result = await window.ink.installArabicAsr();
    if (result.ok) {
      els.arabicAsrProgress.textContent += '\nDone. Arabic dialect recognition is ready.\n';
      renderArabicAsr(result.status);
    } else {
      renderArabicAsr(result.status || {});
      setBadge(els.arabicAsrBadge, '', 'Setup failed');
      els.arabicAsrSummary.textContent = result.error || 'Arabic speech-pack setup failed. Retry keeps completed files.';
      els.arabicAsrProgress.textContent += `\n${result.error || 'Arabic speech-pack setup failed.'}\n`;
    }
    els.installArabicAsr.disabled = false;
  }

  function renderTranslation(status) {
    translationReady = Boolean(status?.ready);
    const qualityReady = Boolean(status?.qualityModelReady);
    els.prepareTranslation.disabled = !translationReady || qualityReady;
    els.refreshLanguages.disabled = !translationReady;
    els.installQualityTranslation.disabled = !translationReady || qualityReady;

    if (translationReady) {
      setBadge(els.translationBadge, 'ready', qualityReady ? 'Quality ready' : 'Ready');
      els.translationSummary.textContent = qualityReady
        ? `${status.qualityModel || 'MADLAD-400'} + Argos ${status.version || ''} · local multilingual translation`.replace(/\s+/g, ' ').trim()
        : `Argos Translate ${status.version || ''} · install the optional MADLAD model for much stronger natural translation`.replace(/\s+/g, ' ').trim();
      els.installTranslation.textContent = 'Repair / reinstall';
      els.installQualityTranslation.textContent = qualityReady ? 'High-quality model installed' : 'Install high-quality model (~3 GB)';
    } else {
      setBadge(els.translationBadge, '', 'Optional');
      els.translationSummary.textContent = 'Install once to add offline speech translation. Dictation works without it.';
      els.installTranslation.textContent = 'Install translation engine';
      els.installQualityTranslation.textContent = 'Install high-quality model';
    }
  }

  async function loadTranslationLanguages(refresh = false) {
    const selected = els.translationTarget.value || settings?.translationTarget || 'en';
    if (!translationReady) {
      populateLanguages([], selected);
      return;
    }
    els.refreshLanguages.disabled = true;
    try {
      const result = await window.ink.listTranslationLanguages(refresh);
      if (result.ok && result.languages?.length) populateLanguages(result.languages, selected);
      else populateLanguages([], selected);
    } catch {
      populateLanguages([], selected);
    } finally {
      els.refreshLanguages.disabled = !translationReady;
    }
  }

  async function refreshTranslation() {
    const status = await window.ink.getTranslationStatus();
    renderTranslation(status);
    await loadTranslationLanguages(false);
  }

  async function installTranslation() {
    els.installTranslation.disabled = true;
    els.translationProgress.hidden = false;
    els.translationProgress.textContent = 'Preparing offline translation engine…\n';
    setBadge(els.translationBadge, '', 'Installing');
    els.translationSummary.textContent = 'Installing a private local translation runtime. This can take a few minutes the first time.';
    const result = await window.ink.installTranslationEngine();
    els.installTranslation.disabled = false;
    if (result.ok) {
      els.translationProgress.textContent += '\nDone. Choose a target language and download its pack.\n';
      renderTranslation(result.status);
      await loadTranslationLanguages(true);
    } else {
      renderTranslation(result.status || {});
      setBadge(els.translationBadge, '', 'Setup failed');
      els.translationSummary.textContent = result.error || 'Translation setup failed. Retry keeps completed files.';
      els.installTranslation.textContent = 'Retry installation';
    }
  }

  async function installQualityTranslation() {
    if (!translationReady) return;
    els.installQualityTranslation.disabled = true;
    els.translationProgress.hidden = false;
    els.translationProgress.textContent = 'Preparing high-quality multilingual translation…\n';
    setBadge(els.translationBadge, '', 'Downloading');
    els.translationSummary.textContent = 'Downloading MADLAD-400 3B INT8. This is a one-time download of roughly 3 GB.';
    const result = await window.ink.installQualityTranslation();
    if (result.ok) {
      els.translationProgress.textContent += '\nDone. High-quality multilingual translation is ready.\n';
      renderTranslation(result.status);
      settings = { ...settings, translationQuality: 'quality' };
      els.translationQuality.value = 'quality';
      await saveNow();
      await loadTranslationLanguages(false);
    } else {
      renderTranslation(result.status || {});
      setBadge(els.translationBadge, '', 'Setup failed');
      els.translationSummary.textContent = result.error || 'High-quality model setup failed. Retry keeps completed model downloads.';
      els.translationProgress.textContent += `\n${result.error || 'High-quality model setup failed.'}\n`;
    }
    els.installQualityTranslation.disabled = Boolean(result.status?.qualityModelReady);
  }

  async function prepareTranslation() {
    if (!translationReady) return;
    await saveNow();
    els.prepareTranslation.disabled = true;
    els.translationProgress.hidden = false;
    els.translationProgress.textContent = `Preparing ${els.translationTarget.selectedOptions[0]?.textContent || els.translationTarget.value} for offline use…\n`;
    const result = await window.ink.prepareTranslationTarget(els.translationTarget.value);
    els.prepareTranslation.disabled = false;
    if (result.ok) {
      els.translationProgress.textContent += result.result?.qualityModel
        ? '\nSelected target is ready in the high-quality multilingual model.\n'
        : '\nSelected language is ready for available lightweight routes. Other source packs install automatically when first used.\n';
    } else {
      els.translationProgress.textContent += `\n${result.error || 'Could not prepare this language.'}\n`;
    }
  }

  async function init() {
    settings = await window.ink.getSettings();
    for (const [field, button] of Object.entries(hotkeyButtons)) button.textContent = prettyHotkey(settings[field]);
    els.language.value = settings.language || 'bilingual';
    els.performanceProfile.value = settings.performanceProfile || 'auto';
    els.translationSource.value = settings.translationSource || 'auto';
    els.translationQuality.value = settings.translationQuality || 'auto';
    els.autoPaste.checked = Boolean(settings.autoPaste);
    els.launchAtLogin.checked = Boolean(settings.launchAtLogin);
    populateLanguages([], settings.translationTarget || 'en');
    renderRecentActivity(await window.ink.getRecentActivity());

    await Promise.all([loadMicrophones(), refreshEngine(), refreshTranslation(), refreshArabicAsr()]);

    els.microphone.addEventListener('change', queueSave);
    els.language.addEventListener('change', queueSave);
    els.performanceProfile.addEventListener('change', queueSave);
    els.translationSource.addEventListener('change', queueSave);
    els.translationTarget.addEventListener('change', queueSave);
    els.translationQuality.addEventListener('change', queueSave);
    els.autoPaste.addEventListener('change', queueSave);
    els.launchAtLogin.addEventListener('change', queueSave);
    els.refreshMics.addEventListener('click', loadMicrophones);
    els.refreshLanguages.addEventListener('click', () => loadTranslationLanguages(true));
    els.openData.addEventListener('click', () => window.ink.openUserData());
    els.installEngine.addEventListener('click', installEngine);
    els.installTranslation.addEventListener('click', installTranslation);
    els.installArabicAsr.addEventListener('click', installArabicAsr);
    els.installQualityTranslation.addEventListener('click', installQualityTranslation);
    els.prepareTranslation.addEventListener('click', prepareTranslation);
    els.openVoiceSettings.addEventListener('click', () => window.ink.openVoiceSettings());
    els.copyRecentActivity.addEventListener('click', async () => {
      const text = els.copyRecentActivity.dataset.copy || '';
      if (!text) return;
      await window.ink.copyText(text);
      setSaveState('Activity copied');
      setTimeout(() => setSaveState('Ready'), 900);
    });

    for (const [field, button] of Object.entries(hotkeyButtons)) {
      button.addEventListener('click', () => beginHotkeyCapture(field));
    }
    window.addEventListener('keydown', captureHotkey, true);

    window.ink.onArabicAsrInstallProgress((line) => {
      els.arabicAsrProgress.hidden = false;
      els.arabicAsrProgress.textContent += line;
      els.arabicAsrProgress.scrollTop = els.arabicAsrProgress.scrollHeight;
    });

    window.ink.onRecentActivity((activity) => renderRecentActivity(activity));

    window.ink.onEngineInstallProgress((line) => {
      els.engineProgress.hidden = false;
      els.engineProgress.textContent += line;
      els.engineProgress.scrollTop = els.engineProgress.scrollHeight;
    });
    window.ink.onTranslationInstallProgress((line) => {
      els.translationProgress.hidden = false;
      els.translationProgress.textContent += line;
      els.translationProgress.scrollTop = els.translationProgress.scrollHeight;
    });
  }

  init().catch((error) => setSaveState(error?.message || 'Settings failed to load', true));
})();
