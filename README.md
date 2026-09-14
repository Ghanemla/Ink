# Ink

Current source build: **0.2.12**

Ink is a lightweight local Windows dictation and offline speech-translation companion with a tiny floating waveform pill.


## 0.2.12 — Arabic pack readiness fix

- Fixed a Windows PowerShell UTF-8 BOM issue in `arabic-asr.json` that could make Ink forget the shared Python runtime immediately after a successful Arabic-pack installation.
- Ink now strips a BOM when reading existing Arabic-pack metadata, so already-installed 0.2.11 packs are recognized without reinstalling or redownloading the ~1.4 GB model.
- New installs write the Arabic-pack metadata as UTF-8 without BOM.
- Added a fallback that reuses Ink's Translation Python runtime if an older marker cannot be parsed.

## 0.2.12 — Arabic speech-pack model-layout fix

This build fixes the Arabic Dialect Speech Pack validation failure:

`ModelFileNotFoundError: File 'vocab.json' not found in ...\\arabic-asr\\model`

The downloaded OpenVoiceOS model is packaged with all INT8 runtime files inside its `int8` directory, including `vocab.json`, `added_tokens.json`, the ONNX graphs, and their external-data files. Ink 0.2.10 downloaded that folder correctly but then pointed `onnx-asr` at its parent directory. The model loader therefore looked for `vocab.json` one level too high.

0.2.12 now:

- points the Arabic ASR worker directly at `arabic-asr\\model\\int8`;
- validates the model from that same directory;
- checks the vocabulary/token files as well as both large ONNX data files;
- reuses the ~1.4 GB model you already downloaded instead of downloading it again when all nine required files are present;
- stores the resolved model path in the Arabic-pack metadata;
- preserves the underlying validation error instead of producing the misleading secondary `null-valued expression` PowerShell error.

No Whisper, MADLAD, Argos, or translation reinstall is required. After updating Ink, press the Arabic-pack install/repair button once. It should detect the existing downloaded model, validate it from the correct folder, write the marker, and finish.

## Arabic translation path

When **Translate from → Arabic (automatic dialect)** is selected and the optional Arabic pack is installed, Ink uses the dialect-focused Arabic recognizer before sending the transcript into the translation engine. Normal Dictation remains independent.

## Build a Windows executable

Run `Build Ink.bat`. Output is written to `dist/`.
