# Ink

Ink is a lightweight, local-first Windows dictation and offline speech-translation companion. A small always-on-top waveform pill records from the selected microphone, transcribes speech locally, and pastes or copies the result without sending audio to a cloud service.

Current source build: **0.2.12**

## Features

- Global hotkeys for dictation, speech translation, and replaying the last translation.
- Local transcription through a managed `whisper.cpp` runtime, with English, Swedish, and mixed English/Swedish handling.
- Offline translation through locally installed Argos Translate packages, with an optional MADLAD-400 quality model on supported CUDA systems.
- Optional Arabic dialect speech pack used before translation.
- Configurable microphone, language, translation target, output behavior, and performance profile.
- A compact recording/processing pill plus a system-tray menu and settings window.
- Local runtime installers and repair actions for speech and translation components.

## Tech Stack

- Electron 44 and Node.js
- Plain HTML, CSS, and JavaScript
- PowerShell setup scripts for managed Windows runtimes
- `whisper.cpp` for speech recognition
- Argos Translate, with optional MADLAD-400 and Arabic ONNX components
- electron-builder for NSIS and portable Windows packages

## Prerequisites

- Windows 10 or 11
- Node.js and npm for development
- PowerShell for the local runtime setup scripts
- A working microphone
- Internet access during first-time runtime/model installation; normal recognition and translation run locally afterward

The optional Arabic speech pack requires roughly 1.4 GB. Other model and runtime requirements depend on the selected speech and translation options.

## Development

```powershell
npm install
npm run dev
```

`npm start` runs the same Electron entry point. Runtime/model downloads are stored in Ink's application-data directory and are not part of this repository.

## Building

Build both the Windows installer and portable executable:

```powershell
npm run build
```

Build only one package type:

```powershell
npm run build:installer
npm run build:portable
```

`Build Ink.bat` is the Windows convenience wrapper. Build output is written to `dist/`.

## Project Status

**Active development.** The current source is usable on Windows and the local speech/translation pipeline is implemented. Runtime installation and language-specific model handling are still being refined between builds.

## Limitations and Notes

- Windows is the only supported desktop platform.
- Initial setup downloads sizable third-party runtimes and models.
- Recognition and translation quality depend on the selected model, microphone quality, language, and available CPU/GPU resources.
- The optional Arabic path is intended for translation; normal dictation remains independent.
- Packaged executables are unsigned, so Windows may show a SmartScreen warning.

## Release Notes

### 0.2.12 — Arabic pack readiness fix

- Fixed a Windows PowerShell UTF-8 BOM issue in `arabic-asr.json` that could make Ink forget the shared Python runtime immediately after a successful Arabic-pack installation.
- Ink now strips a BOM when reading existing Arabic-pack metadata, so already-installed 0.2.11 packs are recognized without reinstalling or redownloading the model.
- New installs write the Arabic-pack metadata as UTF-8 without BOM.
- Added a fallback that reuses Ink's Translation Python runtime if an older marker cannot be parsed.

### 0.2.12 — Arabic speech-pack model-layout fix

This build fixes the Arabic Dialect Speech Pack validation failure where the loader searched one directory above the downloaded OpenVoiceOS INT8 model files.

0.2.12 now:

- points the Arabic ASR worker directly at `arabic-asr\model\int8`;
- validates the model from that same directory;
- checks the vocabulary/token files as well as both large ONNX data files;
- reuses an existing valid model instead of downloading it again;
- stores the resolved model path in the Arabic-pack metadata; and
- preserves the underlying validation error instead of producing a secondary PowerShell error.

No Whisper, MADLAD, Argos, or translation reinstall is required. After updating Ink, use the Arabic-pack install/repair action once so Ink can validate and record the existing model.

### Arabic translation path

When **Translate from → Arabic (automatic dialect)** is selected and the optional Arabic pack is installed, Ink uses the dialect-focused Arabic recognizer before sending the transcript to the translation engine.
