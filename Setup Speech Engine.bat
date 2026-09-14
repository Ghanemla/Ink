@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-whisper.ps1" -Destination "%APPDATA%\ink-dictation\runtime" -Backend auto
pause
