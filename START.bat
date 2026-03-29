# --- INITIALIZATION ---
# $PSScriptRoot is an automatic variable in PowerShell 3+; redefine only for PS 2 compatibility
if (-not $PSScriptRoot) {
    $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
Set-Location $PSScriptRoot
Write-Host "📍 Working in: $PSScriptRoot" -ForegroundColor Cyan

# Exit immediately on any terminating error
$ErrorActionPreference = "Stop"

# --- CONFIGURATION ---
$MIN_NODE_VERSION = 18
$OLLAMA_MODEL     = ""          # Left empty; self-patched after first successful setup
$EMBED_MODEL      = "mxbai-embed-large"
$PORT             = 31337

# --- PORT AVAILABILITY CHECK ---
$portProcess = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
               Select-Object -ExpandProperty OwningProcess -Unique -First 1

if ($portProcess) {
    Write-Host "------------------------------------------" -ForegroundColor Yellow
    Write-Host "⚠️  PORT CONFLICT DETECTED"               -ForegroundColor Yellow
    Write-Host "------------------------------------------" -ForegroundColor Yellow
    Write-Host "The port $PORT is already in use by another process."
    Write-Host "This usually means the server is already running."
    Write-Host "------------------------------------------" -ForegroundColor Yellow
    $procName = (Get-Process -Id $portProcess -ErrorAction SilentlyContinue).ProcessName
    $choice = Read-Host "Port $PORT is busy ($procName). Kill existing process and restart? (y/n)"
    if ($choice -eq 'y') {
        Stop-Process -Id $portProcess -Force
        Start-Sleep -Seconds 1
        Write-Host "✅ Port cleared." -ForegroundColor Green
    } else {
        exit 1
    }
}

# ============================================================
# FAST PATH: OLLAMA_MODEL is already set (script patched itself
# on first run) AND the model is present locally — skip all
# installation questions and jump straight to launch.
# ============================================================
$ollamaListOutput = & ollama list 2>$null
$modelAlreadyPresent = $OLLAMA_MODEL -ne "" -and ($ollamaListOutput -match [regex]::Escape($OLLAMA_MODEL))

if ($modelAlreadyPresent) {
    Write-Host "✨ Model '$OLLAMA_MODEL' already configured and present locally." -ForegroundColor Green

    if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
        Write-Host "📦 Missing dependencies. Installing..." -ForegroundColor Cyan
        npm install
    }

    Write-Host "⏩ Skipping setup — launching server..." -ForegroundColor Cyan
    Write-Host "------------------------------------------"
    Write-Host "🚀 Starting server with model: $OLLAMA_MODEL"
    Write-Host "------------------------------------------"

    $env:OLLAMA_MODEL = $OLLAMA_MODEL
    $serverJob = Start-Process -FilePath "npm" -ArgumentList "run", "start:lite" -NoNewWindow -PassThru

    Write-Host "Waiting for server to start..."
    Start-Sleep -Seconds 3

    Start-Process "http://localhost:$PORT"

    Write-Host "------------------------------------------"
    Write-Host "✅ App is running at http://localhost:$PORT" -ForegroundColor Green
    Write-Host "---------------------------------------"
    Write-Host "📡 Server is active."
    Write-Host "For EXIT - press [Enter] TWICE!"
    Write-Host "Once to shut down the server."
    Write-Host "Twice to close this window."
    Write-Host "---------------------------------------"
    Read-Host | Out-Null
    Read-Host | Out-Null
    exit 0
}

# ============================================================
# FIRST-TIME SETUP — runs only when OLLAMA_MODEL is empty
# ============================================================

Write-Host "🔍 Starting Aperio-lite environment check..." -ForegroundColor Cyan

# 1. Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  Node.js is missing." -ForegroundColor Yellow
    $choice = Read-Host "Would you like to open the Node.js download page? (y/n)"
    if ($choice -eq 'y') {
        Start-Process "https://nodejs.org"
        Write-Host "Please install Node.js $MIN_NODE_VERSION+ and re-run this script."
    } else {
        Write-Host "Exiting: Node.js is required."
    }
    exit 1
}

# 2. Check Ollama
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  Ollama is missing." -ForegroundColor Yellow
    $choice = Read-Host "Would you like to open the Ollama download page? (y/n)"
    if ($choice -eq 'y') {
        Start-Process "https://ollama.com/download/windows"
        Write-Host "Please install Ollama and re-run this script."
    } else {
        Write-Host "Exiting: Ollama is required for the LLM features."
    }
    exit 1
}

# 3. Ensure Ollama server is responding
$ollamaPing = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -ErrorAction SilentlyContinue
if (-not $ollamaPing) {
    Write-Host "🚀 Ollama server not responding. Starting it..." -ForegroundColor Cyan
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden

    Write-Host "⏳ Waiting for Ollama to respond on port 11434..."
    $maxRetries = 10
    $count = 0
    while (-not $ollamaPing -and $count -lt $maxRetries) {
        Start-Sleep -Seconds 2
        $ollamaPing = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -ErrorAction SilentlyContinue
        $count++
    }
    if (-not $ollamaPing) {
        Write-Host "❌ Error: Ollama failed to start after 20 seconds." -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Ollama is awake!" -ForegroundColor Green
}

# --- DYNAMIC MODEL SELECTION ---
# All model names verified against ollama.com/library (March 2026)
$mem    = Get-CimInstance Win32_ComputerSystem | Select-Object -ExpandProperty TotalPhysicalMemory
$RAM_GB = [Math]::Floor($mem / 1GB)

$diskInfo = Get-PSDrive -Name (Split-Path $PSScriptRoot -Qualifier).TrimEnd(':') -ErrorAction SilentlyContinue
if (-not $diskInfo) { $diskInfo = Get-PSDrive C }
$FREE_GB = [Math]::Floor($diskInfo.Free / 1GB)

if ($RAM_GB -le 4) {
    # Tier 1: ~2GB download, runs in 4GB RAM
    $OLLAMA_MODEL = "qwen2.5:3b"
    $REQ_RAM      = 4
    Write-Host "💡 Low RAM detected. Using Qwen 2.5 (3B)." -ForegroundColor Cyan
} elseif ($RAM_GB -le 8) {
    # Tier 2: ~4.7GB download, runs in 8GB RAM
    $OLLAMA_MODEL = "llama3.1:8b"
    $REQ_RAM      = 8
    Write-Host "⚖️  Balanced performance. Using Llama 3.1 (8B)." -ForegroundColor Cyan
} elseif ($RAM_GB -ge 32) {
    # Tier 4: ~19GB download, needs 32GB+ RAM
    $OLLAMA_MODEL = "deepseek-r1:32b"
    $REQ_RAM      = 32
    Write-Host "🧠 High RAM detected. Using DeepSeek-R1 (32B)." -ForegroundColor Cyan
} elseif ($RAM_GB -ge 16) {
    # Tier 3b: ~9.3GB download, needs 16GB RAM
    $OLLAMA_MODEL = "qwen3:14b"
    $REQ_RAM      = 16
    Write-Host "🧠 Advanced RAM detected. Using Qwen3 (14B)." -ForegroundColor Cyan
} else {
    # Tier 3a: ~5.2GB download, needs 9-12GB RAM
    $OLLAMA_MODEL = "qwen3:8b"
    $REQ_RAM      = 10
    Write-Host "🧠 Good RAM detected. Using Qwen3 (8B)." -ForegroundColor Cyan
}

# --- DISK SPACE CHECK ---
switch -Wildcard ($OLLAMA_MODEL) {
    "*32b*" { $REQ_GB = 20 }
    "*14b*" { $REQ_GB = 10 }
    "*8b*"  { $REQ_GB = 6  }
    "*3b*"  { $REQ_GB = 3  }
    default { $REQ_GB = 6  }
}

if ($FREE_GB -lt $REQ_GB) {
    Write-Host "❌ ERROR: Not enough disk space! You need at least ${REQ_GB}GB free." -ForegroundColor Red
    Write-Host "Please clean up your drive and try again."
    Read-Host "Press Enter to exit"
    exit 1
}

# --- HARDWARE SUMMARY & USER CONFIRMATION ---
Write-Host "------------------------------------------"
Write-Host "🖥️  HARDWARE ANALYSIS"
Write-Host "------------------------------------------"
Write-Host "👽 OS Detected:  Windows"
Write-Host "📊 Total RAM:    $RAM_GB GB"
Write-Host "💾 Free Disk:    $FREE_GB GB"
Write-Host "🥇 Best Fit:     $OLLAMA_MODEL"
Write-Host "🤖 Embeddings:   $EMBED_MODEL"
Write-Host "✨ Port:         $PORT"
Write-Host "------------------------------------------"

$useBest = Read-Host "👉 Use the 'Best Fit' model above? (y/n)"
if ($useBest -ne 'y') {
    Write-Host "⚙️  Entering Manual Selection..."
    Write-Host "Choose a model size that fits your needs:"
    Write-Host "1) Lite      (3B  - qwen2.5:3b)      [Needs ~4GB RAM,  ~2GB disk]"
    Write-Host "2) Medium    (8B  - llama3.1:8b)      [Needs ~8GB RAM,  ~5GB disk]"
    Write-Host "3) Smart     (8B  - qwen3:8b)         [Needs ~10GB RAM, ~5GB disk]"
    Write-Host "4) Reasoning (14B - qwen3:14b)        [Needs ~16GB RAM, ~9GB disk]"
    Write-Host "5) Pro       (32B - deepseek-r1:32b)  [Needs ~32GB RAM, ~19GB disk]"
    Write-Host "6) Quit"

    $validChoice = $false
    while (-not $validChoice) {
        $choice = Read-Host "Select a number [1-6]"
        switch ($choice) {
            '1' { $OLLAMA_MODEL = "qwen2.5:3b";      $REQ_RAM = 4;  $validChoice = $true }
            '2' { $OLLAMA_MODEL = "llama3.1:8b";     $REQ_RAM = 8;  $validChoice = $true }
            '3' { $OLLAMA_MODEL = "qwen3:8b";        $REQ_RAM = 10; $validChoice = $true }
            '4' { $OLLAMA_MODEL = "qwen3:14b";       $REQ_RAM = 16; $validChoice = $true }
            '5' { $OLLAMA_MODEL = "deepseek-r1:32b"; $REQ_RAM = 32; $validChoice = $true }
            '6' { Write-Host "❌ Exiting..."; exit 1 }
            default { Write-Host "Invalid selection. Please choose 1-6." }
        }
    }

    # --- THE SAFETY WARNING ---
    if ($RAM_GB -lt $REQ_RAM) {
        Write-Host "⚠️  WARNING: Your system has ${RAM_GB}GB RAM, but $OLLAMA_MODEL needs at least ${REQ_RAM}GB." -ForegroundColor Red
        Write-Host "It will run EXTREMELY slowly (approx. 1 word per minute)."
        $force = Read-Host "🤔 Are you SURE you want to force this model? (y/n)"
        if ($force -ne 'y') {
            Write-Host "Restarting selection..."
            & $MyInvocation.MyCommand.Path
            exit
        }
    }
}

Write-Host "🚀 Selected Model: $OLLAMA_MODEL. Starting setup..." -ForegroundColor Cyan

$proceed = Read-Host "🤔 Based on your RAM, this is the best setup you can get. Proceed with install? (y/n)"
if ($proceed -ne 'y') {
    Write-Host "❌ Installation cancelled by user. Exiting..." -ForegroundColor Red
    exit 1
}

Write-Host "------------------------------------------"
Write-Host "🧠 PREPARING AI MODEL"
Write-Host "------------------------------------------"
Write-Host "🤖 Model: $OLLAMA_MODEL"
Write-Host "📦 Task:  Downloading AI model..."
Write-Host "🚀 Starting setup..."

ollama pull $OLLAMA_MODEL
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error: Could not download $OLLAMA_MODEL. Check your internet connection." -ForegroundColor Red
    exit 1
}
Write-Host "✅ AI model is ready!" -ForegroundColor Green

Write-Host "------------------------------------------"
Write-Host "🧠 PREPARING VECTOR ENGINE"
Write-Host "------------------------------------------"
Write-Host "🤖 Model: $EMBED_MODEL"
Write-Host "📦 Task:  Downloading embeddings for LanceDB..."

ollama pull $EMBED_MODEL
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Error: Could not download $EMBED_MODEL. Check your internet connection." -ForegroundColor Red
    exit 1
}
Write-Host "✅ Embeddings ready!" -ForegroundColor Green

Write-Host "------------------------------------------"
Write-Host "📦 UPDATING SPECIFIC DEPENDENCIES"
Write-Host "------------------------------------------"
npm install @lancedb/lancedb uuid ollama

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "📦 Installing app dependencies (LanceDB, Vector utils)..."
    npm install --production
}

# ============================================================
# SELF-PATCH: Write the chosen model back into this script so
# the next run hits the fast path with no prompts.
#
# Targets exactly the line:  $OLLAMA_MODEL     = ""
# Replaces it with:          $OLLAMA_MODEL     = "<chosen-model>"
# ============================================================
$scriptPath    = $MyInvocation.MyCommand.Path
$scriptContent = Get-Content $scriptPath -Raw
$patched       = $scriptContent -replace '(\$OLLAMA_MODEL\s*=\s*)""\s*(#[^\r\n]*)?', "`$1`"$OLLAMA_MODEL`" # patched"
Set-Content -Path $scriptPath -Value $patched -Encoding UTF8
Write-Host "✅ Script updated — future runs will skip setup automatically." -ForegroundColor Green

# --- FINAL LAUNCH ---
Write-Host "------------------------------------------"
Write-Host "📍 Working in: $PSScriptRoot"
Write-Host "🚀 Environment ready! Starting server..."
Write-Host "------------------------------------------"

$env:OLLAMA_MODEL = $OLLAMA_MODEL
$serverJob = Start-Process -FilePath "npm" -ArgumentList "run", "start:lite" -NoNewWindow -PassThru

Write-Host "Waiting for server to start..."
Start-Sleep -Seconds 3

Start-Process "http://localhost:$PORT"

Write-Host "------------------------------------------"
Write-Host "✅ App is running at http://localhost:$PORT" -ForegroundColor Green
Write-Host "---------------------------------------"
Write-Host "📡 Server is active."
Write-Host "For EXIT - press [Enter] TWICE!"
Write-Host "Once to shut down the server."
Write-Host "Twice to close this window."
Write-Host "---------------------------------------"
Read-Host | Out-Null
Read-Host | Out-Null