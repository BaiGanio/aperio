# ==============================================================
# START.ps1 -- Aperio-lite launcher for Windows (PowerShell)
# Mirrors the logic of START.sh exactly.
# Run from PowerShell:  .\START.ps1
# If blocked by policy: powershell -ExecutionPolicy Bypass -File .\START.ps1
# ==============================================================

# Ensure the console can display text properly
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding            = [System.Text.Encoding]::UTF8

# --- Resolve the real script directory (handles symlinks & spaces) ---
$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir  = Split-Path -Parent $ScriptPath
Set-Location $ScriptDir
Write-Host "[*] Working in: $(Get-Location)"

# --- CONFIGURATION ---
# OLLAMA_MODEL is intentionally empty on first run.
# The script patches this line after the user picks a model,
# so subsequent runs hit the fast path automatically.
$MinNodeVersion = 18
$OllamaModel    = ""
$EmbedModel     = "mxbai-embed-large"
$Port           = 31337

# --- HELPER: coloured Write-Host shorthand ---
function Info  ($msg) { Write-Host $msg -ForegroundColor Cyan    }
function Ok    ($msg) { Write-Host $msg -ForegroundColor Green   }
function Warn  ($msg) { Write-Host $msg -ForegroundColor Yellow  }
function Err   ($msg) { Write-Host $msg -ForegroundColor Red     }

# --- HELPER: prompt for a single y/n keypress, return $true for Y ---
function AskYN ($prompt) {
    Write-Host "$prompt (y/n): " -NoNewline
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Write-Host $key.Character
    return ($key.Character -match "^[Yy]$")
}

# --- HELPER: self-patch -- rewrite $OllamaModel line in this script ---
function PatchModel ($newModel) {
    $raw     = Get-Content $ScriptPath -Raw -Encoding UTF8
    $patched = $raw -replace '(\$OllamaModel\s*=\s*)"[^"]*"', "`$1`"$newModel`""
    # Write back as UTF-8 with BOM so PowerShell always reads it cleanly
    $utf8bom = New-Object System.Text.UTF8Encoding $true
    [System.IO.File]::WriteAllText($ScriptPath, $patched, $utf8bom)
}

# ==============================================================
# PORT AVAILABILITY CHECK
# ==============================================================
$portInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Host "------------------------------------------"
    Warn "[!] PORT CONFLICT DETECTED"
    Write-Host "------------------------------------------"
    Warn "The port $Port is already in use by another process."
    Warn "This usually means the server is already running."
    Write-Host "------------------------------------------"
    if (AskYN "Port $Port is busy. Kill existing process and restart?") {
        $portInUse | ForEach-Object {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
        Ok "[OK] Port cleared."
    } else {
        exit 1
    }
}

# ==============================================================
# FAST PATH: $OllamaModel is already set (self-patched on first
# run) AND the model is present locally in ollama list.
# Ask the user: launch now, or reconfigure?
# ==============================================================
if ($OllamaModel -ne "") {
    $ollamaList   = & ollama list 2>$null
    $modelPresent = $ollamaList | Select-String -SimpleMatch $OllamaModel -Quiet
    if ($modelPresent) {
        Write-Host "------------------------------------------"
        Ok "[**] EXISTING CONFIGURATION FOUND"
        Write-Host "------------------------------------------"
        Write-Host "   Model : $OllamaModel"
        Write-Host "   Port  : $Port"
        Write-Host "------------------------------------------"
        if (AskYN "[>] Launch with this model? (y = start now / n = reconfigure)") {
            if (-not (Test-Path "node_modules")) {
                Info "[+] Missing dependencies. Installing..."
                npm install
            }
            Info "[>>] Launching server..."
            Write-Host "------------------------------------------"
            Info "[>>] Starting server with model: $OllamaModel"
            Write-Host "------------------------------------------"
            $env:OLLAMA_MODEL = $OllamaModel
            $env:AI_PROVIDER  = "ollama"
            $env:DB_BACKEND   = "lancedb"
            $env:CHECK_RAM    = "false"
            $env:PORT         = "$Port"
            Start-Process -FilePath "cmd.exe" -ArgumentList "/c","node","server.js" -NoNewWindow -PassThru | Out-Null
            Write-Host "Waiting for server to start..."
            Start-Sleep -Seconds 3
            Start-Process "http://localhost:$Port"
            Write-Host "------------------------------------------"
            Ok "[OK] App is running at http://localhost:$Port"
            Write-Host "------------------------------------------"
            Write-Host "[~] Server is active."
            Write-Host "For EXIT - press [Enter] TWICE!"
            Write-Host "Once to shut down the server."
            Write-Host "Twice to close this window."
            Write-Host "------------------------------------------"
            Read-Host | Out-Null
            $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
            exit 0
        } else {
            # User wants to reconfigure -- reset saved model and fall through to full setup.
            Info "[~] Entering reconfiguration mode..."
            PatchModel ""
            $OllamaModel = ""
            Ok "[OK] Configuration reset. Continuing to setup..."
            Write-Host ""
        }
    }
}

# ==============================================================
# FIRST-TIME SETUP -- only reached when $OllamaModel is empty
# ==============================================================
Info "[?] Starting Aperio-lite environment check..."

# --- 1. Check / Install Node.js ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Warn "[!] Node.js is missing."
    if (AskYN "Would you like to install Node.js $MinNodeVersion and NPM now?") {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        $choco  = Get-Command choco  -ErrorAction SilentlyContinue
        if ($winget) {
            Info "[+] Installing Node.js via winget..."
            winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        } elseif ($choco) {
            Info "[+] Installing Node.js via Chocolatey..."
            choco install nodejs-lts -y
        } else {
            Err "[X] Neither winget nor Chocolatey found."
            Err "    Please install Node.js $MinNodeVersion manually from https://nodejs.org"
            Read-Host "Press Enter to exit"
            exit 1
        }
        # Refresh PATH so node is visible in this session immediately
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        Err "Exiting: Node.js is required."
        exit 1
    }
}

# --- 2. Check / Install Ollama ---
$ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCmd) {
    Warn "[!] Ollama is missing."
    if (AskYN "Would you like to install Ollama now?") {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        $choco  = Get-Command choco  -ErrorAction SilentlyContinue
        if ($winget) {
            Info "[+] Installing Ollama via winget..."
            winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
        } elseif ($choco) {
            Info "[+] Installing Ollama via Chocolatey..."
            choco install ollama -y
        } else {
            Err "[X] Neither winget nor Chocolatey found."
            Err "    Please install Ollama manually from https://ollama.com/download"
            Read-Host "Press Enter to exit"
            exit 1
        }
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        Err "Exiting: Ollama is required for the LLM features."
        exit 1
    }
}

# --- 3. Ensure the Ollama server is actually responding ---
$ollamaAlive = $false
try {
    $resp        = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $ollamaAlive = ($resp.StatusCode -eq 200)
} catch {}

if (-not $ollamaAlive) {
    Info "[>>] Ollama server not responding. Starting it..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Info "[..] Waiting for Ollama to respond on port 11434..."
    $maxRetries = 10
    $count      = 0
    $ready      = $false
    while (-not $ready -and $count -lt $maxRetries) {
        Start-Sleep -Seconds 2
        $count++
        try {
            $r     = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            $ready = ($r.StatusCode -eq 200)
        } catch {}
    }
    if (-not $ready) {
        Err "[X] Error: Ollama failed to start after 20 seconds."
        exit 1
    }
    Ok "[OK] Ollama is awake!"
}

# ==============================================================
# DYNAMIC MODEL SELECTION
# All model names verified against ollama.com/library (March 2026)
#
# Strategy: recommend ONE TIER BELOW the system max capacity.
# Keeps the system responsive; user can still go higher manually.
# ==============================================================
$totalRamBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$RamGB         = [math]::Floor($totalRamBytes / 1GB)

if ($RamGB -le 4) {
    # Only one option at this RAM level -- no room to go lower
    $OllamaModel = "qwen2.5:3b"
    Info "[i] Low RAM (${RamGB}GB). Using the lightest model: Qwen 2.5 (3B)."
} elseif ($RamGB -le 8) {
    # Can handle 8B, recommend 3B (one tier down) to keep system responsive
    $OllamaModel = "qwen2.5:3b"
    Info "[i] ${RamGB}GB RAM -- recommending Qwen 2.5 (3B) to keep your system comfortable."
    Info "    (Your system could handle an 8B model, but lighter = snappier experience.)"
} elseif ($RamGB -ge 32) {
    # Can handle 32B, recommend 14B (one tier down)
    $OllamaModel = "qwen3:14b"
    Info "[i] ${RamGB}GB RAM -- recommending Qwen3 (14B) for a smooth experience."
    Info "    (Your system could handle DeepSeek-R1 32B, but 14B leaves headroom for other apps.)"
} elseif ($RamGB -ge 16) {
    # Can handle 14B, recommend 8B (one tier down)
    $OllamaModel = "qwen3:8b"
    Info "[i] ${RamGB}GB RAM -- recommending Qwen3 (8B) for a balanced experience."
    Info "    (Your system could handle a 14B model, but 8B is faster and leaves RAM free.)"
} else {
    # 9-15GB: can handle qwen3:8b, recommend llama3.1:8b as the lighter 8B variant
    $OllamaModel = "llama3.1:8b"
    Info "[i] ${RamGB}GB RAM -- recommending Llama 3.1 (8B) for a stable experience."
    Info "    (A good balance between capability and system breathing room.)"
}

# --- DISK SPACE CHECK ---
switch -Wildcard ($OllamaModel) {
    "*32b*" { $ReqGB = 20 }
    "*14b*" { $ReqGB = 10 }
    "*8b*"  { $ReqGB =  6 }
    "*3b*"  { $ReqGB =  3 }
    default { $ReqGB =  6 }
}

$driveLetter = (Get-Location).Drive.Name
$freeGB      = [math]::Floor((Get-PSDrive $driveLetter).Free / 1GB)

if ($freeGB -lt $ReqGB) {
    Err "[X] ERROR: Not enough disk space! You need at least ${ReqGB}GB free."
    Err "    Please clean up your drive and try again."
    Read-Host "Press Enter to exit"
    exit 1
}

# --- HARDWARE SUMMARY & USER CONFIRMATION ---
Write-Host "------------------------------------------"
Info "[*] HARDWARE ANALYSIS"
Write-Host "------------------------------------------"
Write-Host "    OS Detected : Windows"
Write-Host "    Total RAM   : $RamGB GB"
Write-Host "    Free Disk   : $freeGB GB"
Write-Host "    Recommended : $OllamaModel  (one tier below max, for comfort)"
Write-Host "    Embeddings  : $EmbedModel"
Write-Host "    Port        : $Port"
Write-Host "------------------------------------------"

if (-not (AskYN "[>] Use the recommended model above?")) {
    Info "[~] Entering Manual Selection..."
    Write-Host "Choose a model size that fits your needs:"
    Write-Host "1) Lite      (3B  - qwen2.5:3b)      [Needs ~4GB RAM,  ~2GB disk]"
    Write-Host "2) Medium    (8B  - llama3.1:8b)      [Needs ~8GB RAM,  ~5GB disk]"
    Write-Host "3) Smart     (8B  - qwen3:8b)         [Needs ~10GB RAM, ~5GB disk]"
    Write-Host "4) Reasoning (14B - qwen3:14b)        [Needs ~16GB RAM, ~9GB disk]"
    Write-Host "5) Pro       (32B - deepseek-r1:32b)  [Needs ~32GB RAM, ~19GB disk]"
    Write-Host "6) Quit"

    $ReqRam = 0
    while ($true) {
        $choice = Read-Host "Select a number [1-6]"
        switch ($choice) {
            "1" { $OllamaModel = "qwen2.5:3b";      $ReqRam = 4;  break }
            "2" { $OllamaModel = "llama3.1:8b";     $ReqRam = 8;  break }
            "3" { $OllamaModel = "qwen3:8b";        $ReqRam = 10; break }
            "4" { $OllamaModel = "qwen3:14b";       $ReqRam = 16; break }
            "5" { $OllamaModel = "deepseek-r1:32b"; $ReqRam = 32; break }
            "6" { Err "[X] Exiting..."; exit 1 }
            default { Warn "Invalid selection. Please choose 1-6."; continue }
        }
        break
    }

    # --- SAFETY WARNING ---
    if ($RamGB -lt $ReqRam) {
        Warn "[!] WARNING: Your system has ${RamGB}GB RAM, but $OllamaModel needs at least ${ReqRam}GB."
        Warn "    It will run EXTREMELY slowly (approx. 1 word per minute)."
        if (-not (AskYN "Are you SURE you want to force this model?")) {
            Info "Restarting selection..."
            & $ScriptPath
            exit
        }
    }
}

Info "[>>] Selected Model: $OllamaModel. Starting setup..."

if (-not (AskYN "Proceed with install?")) {
    Err "[X] Installation cancelled by user. Exiting..."
    exit 1
}

# ==============================================================
# DOWNLOAD AI MODEL
# ==============================================================
Write-Host "------------------------------------------"
Info "[*] PREPARING AI MODEL"
Write-Host "------------------------------------------"
Write-Host "    Model : $OllamaModel"
Write-Host "    Task  : Downloading AI model..."

ollama pull $OllamaModel
if ($LASTEXITCODE -ne 0) {
    Err "[X] Error: Could not download $OllamaModel. Check your internet connection."
    exit 1
}
Ok "[OK] AI model is ready!"

# ==============================================================
# DOWNLOAD EMBEDDING MODEL
# ==============================================================
Write-Host "------------------------------------------"
Info "[*] PREPARING VECTOR ENGINE"
Write-Host "------------------------------------------"
Write-Host "    Model : $EmbedModel"
Write-Host "    Task  : Downloading embeddings for LanceDB..."

ollama pull $EmbedModel
if ($LASTEXITCODE -ne 0) {
    Err "[X] Error: Could not download $EmbedModel. Check your internet connection."
    exit 1
}
Ok "[OK] Embeddings ready!"

# ==============================================================
# INSTALL / UPDATE NODE DEPENDENCIES
# ==============================================================
Write-Host "------------------------------------------"
Info "[+] UPDATING SPECIFIC DEPENDENCIES"
Write-Host "------------------------------------------"
npm install "@lancedb/lancedb" uuid ollama

if (-not (Test-Path "node_modules")) {
    Info "[+] Installing app dependencies (LanceDB, Vector utils)..."
    npm install --production
}

# ==============================================================
# SELF-PATCH: bake the chosen model into this script so the
# next run hits the fast path and skips setup entirely.
# Targets the line:  $OllamaModel    = ""
# ==============================================================
PatchModel $OllamaModel
Ok "[OK] Script updated -- future runs will skip setup automatically."

# ==============================================================
# FINAL LAUNCH
# ==============================================================
Write-Host "------------------------------------------"
Write-Host "[*] Working in: $(Get-Location)"
Info "[>>] Environment ready! Starting server..."
Write-Host "------------------------------------------"

$env:OLLAMA_MODEL = $OllamaModel
$env:AI_PROVIDER  = "ollama"
$env:DB_BACKEND   = "lancedb"
$env:CHECK_RAM    = "false"
$env:PORT         = "$Port"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","node","server.js" -NoNewWindow -PassThru | Out-Null

Write-Host "Waiting for server to start..."
Start-Sleep -Seconds 3

Start-Process "http://localhost:$Port"

Write-Host "------------------------------------------"
Ok "[OK] App is running at http://localhost:$Port"
Write-Host "------------------------------------------"
Write-Host "[~] Server is active."
Write-Host "For EXIT - press [Enter] TWICE!"
Write-Host "Once to shut down the server."
Write-Host "Twice to close this window."
Write-Host "------------------------------------------"
Read-Host | Out-Null
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null