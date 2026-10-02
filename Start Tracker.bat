@echo off
rem One-click launcher: starts the local server (minimized) and opens the app.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

rem Reuse an already-running server on port 8765 if there is one.
netstat -ano | findstr /r /c:":8765 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  start "Tracker server (close this window to stop)" /min node tools\serve.js
  timeout /t 1 /nobreak >nul
)

start "" http://localhost:8765/
