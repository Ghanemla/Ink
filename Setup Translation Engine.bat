@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\setup-translation.ps1"
if errorlevel 1 (
  echo.
  echo Translation setup failed. Keep this window open and copy the error into Ink support.
  pause
)
