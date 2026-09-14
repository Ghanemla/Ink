@echo off
setlocal
cd /d "%~dp0"
echo Preparing Ink Arabic dialect speech pack...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-arabic-asr.ps1" -Destination "%APPDATA%\ink-dictation\arabic-asr"
if errorlevel 1 (
  echo.
  echo Arabic speech-pack setup failed. The completed downloads are kept for retry.
  pause
  exit /b 1
)
echo.
echo Arabic dialect speech pack is ready.
pause
