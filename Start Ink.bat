@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Ink needs Node.js 22 or newer to run from source.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules\electron\package.json (
  echo Installing Ink dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist node_modules\electron\dist\electron.exe (
  echo.
  echo Downloading the Electron runtime. This only happens once...
  node node_modules\electron\install.js
  if errorlevel 1 (
    echo.
    echo Electron runtime download failed.
    pause
    exit /b 1
  )
)

echo Starting Ink...
start "" "%CD%\node_modules\electron\dist\electron.exe" "%CD%"
exit /b 0
