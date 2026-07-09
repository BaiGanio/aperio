# ==============================================================
# start.ps1  --  Aperio-lite ignition for Windows (PowerShell)
#
# Mirrors START.sh: does ONLY what a browser can't -- make sure Node.js and the
# app's dependencies exist -- then starts the server, which opens your browser
# to the setup wizard (setup.html). llama.cpp, the AI model, the database and
# provider/API-key config all happen in that browser wizard, not here.
# ==============================================================

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$MinNodeVersion = 18

# --- Resolve the app root (the folder that holds package.json) ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot   = $ScriptDir
while (-not (Test-Path (Join-Path $AppRoot 'package.json'))) {
    $parent = Split-Path -Parent $AppRoot
    if (-not $parent -or $parent -eq $AppRoot) { break }
    $AppRoot = $parent
}
Set-Location $AppRoot

$InstallDir = Join-Path $AppRoot 'var\install'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Log       = Join-Path $InstallDir 'ignition.log'
$ServerLog = Join-Path $InstallDir 'server.log'

function Info ($m) { Write-Host "  * $m"  -ForegroundColor Cyan   }
function Ok   ($m) { Write-Host "  + $m"  -ForegroundColor Green  }
function Warn ($m) { Write-Host "  ! $m"  -ForegroundColor Yellow }
function Die  ($m) { Write-Host "`n  x $m`n`n  Details: $Log`n" -ForegroundColor Red; Read-Host "  Press Enter to close"; exit 1 }

Write-Host ""
Write-Host "  +--------------------------------------+" -ForegroundColor Cyan
Write-Host "  |   Aperio-lite  - starting up...      |" -ForegroundColor Cyan
Write-Host "  +--------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# --- 1. Node.js (>= 18) -----------------------------------------------------
$major = 0
if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = ((node -v) -replace 'v','').Split('.')[0] -as [int]
}
if ($major -ge $MinNodeVersion) {
    Ok "Node.js $(node -v)"
} else {
    Warn "Node.js $MinNodeVersion+ not found - installing (one time)..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent *>> $Log
        # Pick up the freshly installed node without opening a new shell.
        $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    } else {
        Warn "Automatic install needs 'winget' (Windows 10/11). Opening the Node.js download page."
        Start-Process "https://nodejs.org/en/download"
        Die "Please install Node.js LTS, then double-click Aperio again."
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Warn "Node.js was installed but isn't active yet."
        Read-Host "  Please double-click Aperio again to continue. Press Enter to close"
        exit 0
    }
    Ok "Node.js $(node -v) ready"
}

# --- 2. Dependencies (needed before server.js can boot) ---------------------
if (Test-Path 'node_modules') {
    Ok "Dependencies present"
} else {
    Info "Installing dependencies (one time - this can take a minute)..."
    npm install --prefer-offline --no-audit --no-fund *>> $Log
    if ($LASTEXITCODE -ne 0) { Die "Dependency install failed." }
    Ok "Dependencies installed"
}

# --- 3. Desktop shortcut for next time (starts Aperio with NO window) --------
# A tiny VBScript runs the hidden launcher with a hidden window; the Desktop
# shortcut points at it via wscript. Stop Aperio from the app's "Quit" button.
try {
    $vbs  = Join-Path $AppRoot 'launch-hidden.vbs'
    $ps1  = Join-Path $AppRoot 'assets\launch-hidden.ps1'
    # Placeholder avoids VBScript/PowerShell quote-escaping headaches.
    $vbsText = (@(
        'Set sh = CreateObject("WScript.Shell")'
        'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""__PS1__""", 0, False'
    ) -join "`r`n") -replace '__PS1__', $ps1
    Set-Content -Path $vbs -Value $vbsText -Encoding ASCII

    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'Aperio.lnk'
    $ws  = New-Object -ComObject WScript.Shell
    $sc  = $ws.CreateShortcut($lnk)
    $sc.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
    $sc.Arguments        = """$vbs"""
    $sc.WorkingDirectory = $AppRoot
    $sc.Description       = 'Launch Aperio (no window)'
    $sc.Save()
    Ok "Added an 'Aperio' shortcut to your Desktop (opens with no window)"
} catch { Warn "Could not create a Desktop shortcut (not critical)." }

# --- 4. Launch --------------------------------------------------------------
# NOTE: npm's start:lite uses UNIX inline env vars, which don't work on Windows,
# so we set them here and run node directly. Same result as start:lite.
$env:AI_PROVIDER        = 'llamacpp'
$env:PORT               = '31337'
$env:DB_BACKEND         = 'sqlite'
$env:EMBEDDING_PROVIDER = 'transformers'
$env:IDLE_SHUTDOWN      = 'on'    # windowless-safe: self-stop after the tab closes, any provider
$env:APERIO_LITE        = 'on'    # lite profile: non-coder starter memories

Write-Host ""
Write-Host "  + Aperio is starting - your browser will open in a moment." -ForegroundColor Green
Write-Host ""
Write-Host "  ! Keep this window open the whole time you use Aperio." -ForegroundColor Yellow
Write-Host "      It is Aperio's engine - closing it stops the app, even after setup." -ForegroundColor DarkGray
Write-Host "      Next time, just double-click the 'Aperio' icon on your Desktop." -ForegroundColor DarkGray
Write-Host ""
Write-Host "    If your browser doesn't open, go to  http://localhost:31337" -ForegroundColor DarkGray
Write-Host "    Technical logs: $ServerLog" -ForegroundColor DarkGray
Write-Host ""

node server.js *>> $ServerLog
Write-Host "`n  Aperio has stopped. You can close this window now.`n" -ForegroundColor DarkGray
