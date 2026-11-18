@echo off
setlocal
title OpenSCAD Studio
cd /d "%~dp0"
set PORT=3333
if not "%OSS_PORT%"=="" set PORT=%OSS_PORT%

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org/ then run this again.
  pause & exit /b 1
)
if not exist node_modules\three (
  echo Installing dependencies...
  call npm install || (echo npm install failed & pause & exit /b 1)
)
if not exist "C:\Program Files\OpenSCAD\openscad.exe" if not exist "C:\Program Files\OpenSCAD (Nightly)\openscad.exe" (
  where openscad >nul 2>nul || echo WARNING: OpenSCAD not found. Install with: winget install OpenSCAD.OpenSCAD
)

rem Already running? Just open the browser.
curl -s -o nul http://localhost:%PORT%/api/health && (
  echo OpenSCAD Studio is already running - opening browser.
  start "" http://localhost:%PORT%
  exit /b 0
)

echo Starting OpenSCAD Studio on http://localhost:%PORT%  (close this window to stop it)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
set PORT=%PORT%
node server.js
echo.
echo Server stopped.
pause