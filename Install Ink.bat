@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Ink needs Node.js 22 or newer to build the Windows installer.
  pause
  exit /b 1
)

if not exist node_modules\electron\package.json (
  echo Installing Ink build dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

for /f %%v in ('node -p "require('./package.json').version"') do set "INK_VERSION=%%v"

echo Building the Ink Windows installer...
call npm run build:installer
if errorlevel 1 (
  echo.
  echo Installer build failed.
  pause
  exit /b 1
)

set "INSTALLER=%CD%\dist\Ink-Setup-%INK_VERSION%.exe"
if not exist "%INSTALLER%" (
  echo.
  echo Build finished, but the installer was not found at:
  echo %INSTALLER%
  pause
  exit /b 1
)

echo.
echo Opening Ink Setup %INK_VERSION%...
start "" "%INSTALLER%"
exit /b 0
