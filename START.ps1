# --- INITIALIZATION ---
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $PSScriptRoot
Write-Host "📍 Current Directory: $PSScriptRoot" -ForegroundColor Cyan

# --- CONFIGURATION ---
$MIN_NODE_VERSION = 18
$OLLAMA_MODEL = "qwen3"
$EMBED_MODEL = "mxbai-embed-large"
$PORT = 31337

# --- PORT AVAILABILITY CHECK ---
$portProcess = Get-NetTCPConnection -LocalPort $PORT -ErrorAction SilentlyContinue | 
               Select-Object -ExpandProperty OwningProcess -Unique -First 1

if ($portProcess) {
    Write-Host "------------------------------------------" -ForegroundColor Yellow
    Write-Host "⚠️  PORT CONFLICT DETECTED"
    Write-Host "------------------------------------------"
    $procName = (Get-Process -Id $portProcess).ProcessName
    $choice = Read-Host "Port $PORT is busy ($procName). Kill and restart? (y/n)"
    if ($choice -eq 'y') {
        Stop-Process -Id $portProcess -Force
        Start-Sleep -Seconds 1
        Write-Host "✅ Port cleared." -ForegroundColor Green
    } else {
        exit
    }
}

Write-Host "🔍 Starting Aperio-lite environment check..." -ForegroundColor Cyan

# --- DEPENDENCY CHECKS ---

# 1. Check Node.js
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  Node.js is missing." -ForegroundColor Yellow
    $choice = Read-Host "Would you like to open the Node.js download page? (y/n)"
    if ($choice -eq 'y') { 
        Start-Process "https://nodejs.org"
        Write-Host "Please install Node.js $MIN_NODE_VERSION+ and restart this script."
    }
    exit
}

# 2. Check Ollama
if (!(Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "⚠️  Ollama is missing." -ForegroundColor Yellow
    $choice = Read-Host "Would you like to download Ollama for Windows? (y/n)"
    if ($choice -eq 'y') {
        Start-Process "https://ollama.com"
        Write-Host "Please install Ollama and restart this script."
    }
    exit
}

# 3. Ensure Ollama Server is Running
$ollamaPing = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -ErrorAction SilentlyContinue
if (!$ollamaPing) {
    Write-Host "🚀 Ollama server not responding. Starting it..." -ForegroundColor Cyan
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
    
    $maxRetries = 10
    $count = 0
    while (!$ollamaPing -and $count -lt $maxRetries) {
        Start-Sleep -Seconds 2
        $ollamaPing = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -ErrorAction SilentlyContinue
        $count++
    }
}

# --- HARDWARE ANALYSIS ---
$mem = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory
$RAM_GB = [Math]::Round($mem.TotalVisibleMemorySize / 1MB)
$disk = Get-PSDrive C | Select-Object Free
$FREE_GB = [Math]::Round($disk.Free / 1GB)

# Logic for Model Selection
$ollamaList = ollama list
if ($ollamaList -match $OLLAMA_MODEL) {
    Write-Host "✨ Pre-set model '$OLLAMA_MODEL' found locally!" -ForegroundColor Green
    $SKIP_INSTALL = $true
} else {
    Write-Host "🔍 Estimating best fit for your hardware..." -ForegroundColor Cyan
    $SKIP_INSTALL = $false
    
    if ($RAM_GB -le 4) {
        $OLLAMA_MODEL = "qwen2.5:3b-instruct-q4_0"; $REQ_RAM = 4
    } elseif ($RAM_GB -le 8) {
        $OLLAMA_MODEL = "llama3.1:8b"; $REQ_RAM = 8
    } elseif ($RAM_GB -ge 32) {
        $OLLAMA_MODEL = "deepseek-r1:32b"; $REQ_RAM = 24
    } else {
        $OLLAMA_MODEL = "qwen3.5:7b-instruct"; $REQ_RAM = 8
    }
}

if (!$SKIP_INSTALL) {
    Write-Host "------------------------------------------"
    Write-Host "🖥️  HARDWARE ANALYSIS"
    Write-Host "------------------------------------------"
    Write-Host "📊 Total RAM:    $RAM_GB GB"
    Write-Host "💾 Free Disk:    $FREE_GB GB"
    Write-Host "🥇 Best Fit:     $OLLAMA_MODEL"
    Write-Host "------------------------------------------"

    $useBest = Read-Host "👉 Use the 'Best Fit' model? (y/n)"
    if ($useBest -ne 'y') {
        Write-Host "1) Lite (3B)  2) Medium (7B)  3) Pro (32B)  4) Quit"
        $choice = Read-Host "Select [1-4]"
        switch ($choice) {
            1 { $OLLAMA_MODEL = "qwen2.5:3b"; $REQ_RAM = 4 }
            2 { $OLLAMA_MODEL = "qwen2.5:7b"; $REQ_RAM = 8 }
            3 { $OLLAMA_MODEL = "deepseek-r1:32b"; $REQ_RAM = 24 }
            default { exit }
        }
    }

    if ($RAM_GB -lt $REQ_RAM) {
        Write-Host "⚠️  WARNING: System has ${RAM_GB}GB, model needs ${REQ_RAM}GB." -ForegroundColor Red
        $force = Read-Host "Force anyway? (y/n)"
        if ($force -ne 'y') { exit }
    }

    Write-Host "📥 Pulling models... (this may take a while)" -ForegroundColor Cyan
    ollama pull $OLLAMA_MODEL
    ollama pull $EMBED_MODEL
}

Write-Host "🚀 Environment Ready! Starting server..." -ForegroundColor Green
# Replace with your actual start command, e.g., npm start
# npm start 
Pause
