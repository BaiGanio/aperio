# ============================================================
# launch-hidden.ps1  --  start Aperio with NO visible window (Windows).
#
# Invoked (via launch-hidden.vbs, hidden) by the Desktop "Aperio" shortcut on
# SECOND and later runs, once first-run setup (START.bat) installed Node, deps
# and the model. Starts the server detached and opens the browser, then exits.
#
# To stop Aperio: click "Quit Aperio" in the app, or close the browser tab and
# the server auto-stops after the idle timeout (~180 s).
# ============================================================

$ErrorActionPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot   = $ScriptDir
while (-not (Test-Path (Join-Path $AppRoot 'package.json'))) {
    $parent = Split-Path -Parent $AppRoot
    if (-not $parent -or $parent -eq $AppRoot) { break }
    $AppRoot = $parent
}
Set-Location $AppRoot
$url = 'http://localhost:31337'

# Already running (icon double-clicked twice)? Just open the browser.
try { Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing | Out-Null; Start-Process $url; exit } catch {}

$env:AI_PROVIDER        = 'ollama'
$env:PORT               = '31337'
$env:DB_BACKEND         = 'sqlite'
$env:EMBEDDING_PROVIDER = 'transformers'
$env:IDLE_SHUTDOWN      = 'on'    # windowless-safe: self-stop after the tab closes, any provider
$env:Path               = "$AppRoot\vendor\ollama;$env:Path"
New-Item -ItemType Directory -Force -Path "$AppRoot\var\install" | Out-Null

# Detached, hidden server process (survives after this script exits).
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WindowStyle Hidden `
    -RedirectStandardOutput "$AppRoot\var\install\server.log" `
    -RedirectStandardError  "$AppRoot\var\install\server.err.log"

# Open the browser once the server answers.
for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -Uri $url -TimeoutSec 1 -UseBasicParsing | Out-Null; Start-Process $url; break }
    catch { Start-Sleep -Seconds 1 }
}
