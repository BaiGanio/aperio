# ==============================================================
# uninstall.ps1  --  remove what Aperio-lite installed into this folder (Windows).
#
# Mirrors uninstall.sh. Removes: the vendored llama.cpp engine, node_modules, the
# local database + logs, and the Desktop launcher (Aperio.lnk + launch-hidden.vbs).
# Optionally keeps the AI model Aperio downloaded. Leaves Node.js alone (you may
# use it elsewhere).
# ==============================================================

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Port = 31337

# --- Resolve the app root (the folder that holds package.json) ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot   = $ScriptDir
while (-not (Test-Path (Join-Path $AppRoot 'package.json'))) {
    $parent = Split-Path -Parent $AppRoot
    if (-not $parent -or $parent -eq $AppRoot) { break }
    $AppRoot = $parent
}
Set-Location $AppRoot

function Info ($m) { Write-Host "  * $m"  -ForegroundColor Cyan   }
function Ok   ($m) { Write-Host "  + $m"  -ForegroundColor Green  }
function Warn ($m) { Write-Host "  ! $m"  -ForegroundColor Yellow }

Write-Host ""
Write-Host "  +--------------------------------------+" -ForegroundColor Red
Write-Host "  |   Uninstall Aperio-lite              |" -ForegroundColor Red
Write-Host "  +--------------------------------------+" -ForegroundColor Red
Write-Host ""
Write-Host "  This removes Aperio's engine, dependencies, database and logs from:"
Write-Host "    $AppRoot" -ForegroundColor DarkGray
Write-Host ""
$reply = Read-Host "  Continue? (y/n)"
if ($reply -notmatch '^[Yy]') { Info "Cancelled - nothing was removed."; exit 0 }
Write-Host ""

# Capture facts from the install ledger BEFORE we delete var/: the model name
# (to offer removal) and whether Node pre-existed (for honest final messaging).
$model = ""; $nodePreexisting = $null
$lock = Join-Path $AppRoot 'var\bootstrap.lock'
if (Test-Path $lock) {
    try {
        $meta = Get-Content $lock -Raw | ConvertFrom-Json
        $model = $meta.model
        if ($null -ne $meta.nodePreexisting) { $nodePreexisting = [bool]$meta.nodePreexisting }
    } catch { }
}

# 1. Stop the running server (if any).
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
    Ok "Stopped the Aperio server (port $Port)."
}

# 2. Stop only OUR vendored llama.cpp (never touches a system install).
$vendorLlamaCpp = Join-Path $AppRoot 'vendor\llamacpp'
Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($vendorLlamaCpp, [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }

# 3. Remove the contained pieces.
if (Test-Path (Join-Path $AppRoot 'node_modules')) {
    Remove-Item -Recurse -Force (Join-Path $AppRoot 'node_modules'); Ok "Removed node_modules/"
}
if (Test-Path (Join-Path $AppRoot 'vendor')) {
    Remove-Item -Recurse -Force (Join-Path $AppRoot 'vendor'); Ok "Removed vendor/ (llama.cpp engine)"
}

# 4. Desktop launcher (Aperio.lnk shortcut + the launch-hidden.vbs it points at).
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Aperio.lnk'
if (Test-Path $lnk) { Remove-Item -Force $lnk; Ok "Removed the Desktop launcher." }
$vbs = Join-Path $AppRoot 'launch-hidden.vbs'
if (Test-Path $vbs) { Remove-Item -Force $vbs }

# 5. Offer to keep the downloaded AI model. It lives under var\models
# (LLAMA_CACHE) by default -- no separate per-model removal command like
# Ollama had, so "keep" means moving it out before var\ is wiped below.
$modelsDir = Join-Path $AppRoot 'var\models'
$keepModelDir = $null
if ($model -and (Test-Path $modelsDir)) {
    Write-Host ""
    $rm = Read-Host "  Also delete the downloaded AI model '$model' (frees several GB)? (y/n)"
    if ($rm -notmatch '^[Yy]') {
        $keepModelDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
        New-Item -ItemType Directory -Force -Path $keepModelDir | Out-Null
        Move-Item $modelsDir (Join-Path $keepModelDir 'models')
        Info "Kept the downloaded model - will restore it after cleanup."
    }
}

# 6. App data (logs, database, bootstrap lock, sessions). Do this last.
if (Test-Path (Join-Path $AppRoot 'var')) {
    Remove-Item -Recurse -Force (Join-Path $AppRoot 'var'); Ok "Removed var/ (logs, settings, sessions)"
}
if (Test-Path (Join-Path $AppRoot '.sqlite')) {
    Remove-Item -Recurse -Force (Join-Path $AppRoot '.sqlite'); Ok "Removed .sqlite/ (memory database)"
}
if ($keepModelDir) {
    New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'var') | Out-Null
    Move-Item (Join-Path $keepModelDir 'models') $modelsDir
    Remove-Item -Recurse -Force $keepModelDir -ErrorAction SilentlyContinue
    Ok "Restored the kept model to var/models/"
}

# 7. What we deliberately left behind.
Write-Host ""
Warn "Left in place (remove yourself if you want):"
if ($nodePreexisting -eq $false) {
    Write-Host "      - Node.js (Aperio installed it) - kept in case you use it elsewhere" -ForegroundColor DarkGray
} else {
    Write-Host "      - Node.js - you already had it; untouched" -ForegroundColor DarkGray
}
Write-Host ""
Ok "Aperio-lite uninstalled."
Write-Host "  Finally, delete this folder to remove Aperio itself." -ForegroundColor DarkGray
Write-Host ""
Read-Host "  Press Enter to close"
