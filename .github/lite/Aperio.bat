@echo off
:: Windows — double-click to launch. Runs in the Command Prompt window.
setlocal EnableDelayedExpansion

title Aperio

:: Always run from the folder this file lives in
cd /d "%~dp0"

set LOG_FILE=bootstrap.log
set MIN_NODE_MAJOR=18

echo.
echo   ╭─────────────────────────╮
echo   │       Aperio            │
echo   ╰─────────────────────────╯
echo.

:: ── 1. Check for Node.js ────────────────────────────────────────────────────

where node >nul 2>&1
if %errorlevel% neq 0 goto :install_node

for /f "delims=" %%v in ('node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2^>nul') do set NODE_MAJOR=%%v
if !NODE_MAJOR! geq %MIN_NODE_MAJOR% (
  for /f "delims=" %%v in ('node -v 2^>nul') do echo [aperio] Node.js %%v -- OK
  goto :npm_install
)
echo [aperio] Node.js is too old (need ^>= %MIN_NODE_MAJOR%) -- reinstalling...

:install_node
echo [aperio] Node.js not found -- downloading installer...
echo [aperio] This will open the Node.js installer. Install with default settings, then re-run Aperio.
echo.

:: Download the LTS installer and launch it
where curl >nul 2>&1
if %errorlevel% equ 0 (
  curl -fsSL -o "%TEMP%\node-installer.msi" "https://nodejs.org/dist/lts/node-latest-x64.msi" >> "%LOG_FILE%" 2>&1
) else (
  powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/lts/node-latest-x64.msi' -OutFile '%TEMP%\node-installer.msi'" >> "%LOG_FILE%" 2>&1
)

if not exist "%TEMP%\node-installer.msi" (
  echo [aperio] ERROR: Could not download Node.js installer.
  echo [aperio] Please install Node.js manually from https://nodejs.org then run Aperio again.
  goto :pause_exit
)

start /wait msiexec /i "%TEMP%\node-installer.msi" /qb
del "%TEMP%\node-installer.msi" >nul 2>&1

:: Refresh PATH so the new node is visible without reopening the window
for /f "tokens=*" %%p in ('powershell -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"') do set PATH=%%p

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [aperio] ERROR: Node.js still not found after install.
  echo [aperio] Please close this window, reopen it, and try again.
  goto :pause_exit
)
echo [aperio] Node.js installed successfully.

:: ── 2. npm install ───────────────────────────────────────────────────────────

:npm_install
if not exist "node_modules" (
  echo [aperio] Installing npm dependencies...
  call npm install --prefer-offline --no-audit --no-fund >> "%LOG_FILE%" 2>&1
  if %errorlevel% neq 0 (
    echo [aperio] ERROR: npm install failed -- check bootstrap.log
    goto :pause_exit
  )
)

:: ── 3. Start server ──────────────────────────────────────────────────────────

echo [aperio] Starting Aperio -- opening browser...
echo.
node server.js

echo.
echo [aperio] Server stopped.

:pause_exit
echo.
echo Press any key to close...
pause >nul