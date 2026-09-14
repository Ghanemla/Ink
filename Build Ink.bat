@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Ink needs Node.js 22 or newer to build.
  pause
  exit /b 1
)
if not exist node_modules\electron\package.json (
  echo Installing Ink dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
echo Building Ink for Windows...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo.
echo Done. Check the dist folder.
pause
