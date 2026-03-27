#****************************************
#*       WELCOME TO XYZ-LITE            *
#*   The world's easiest AI setup       *
#****************************************

# --- CONFIGURATION ---
$MIN_NODE_VERSION = 18
$OLLAMA_MODEL = "llama3"

Write-Host "🔍 Starting xyz-lite environment check..." -ForegroundColor Cyan

# 1. Check Node.js Presence & Version
$nodeInstalled = Get-Command node -ErrorAction SilentlyContinue
if ($nodeInstalled) {
    $currentVer = (node -v).TrimStart('v').Split('.')[0]
    if ([int]$currentVer -lt $MIN_NODE_VERSION) {
        Write-Host "⚠️ Node.js version $currentVer detected. Version $MIN_NODE_VERSION+ is required." -ForegroundColor Yellow
        $nodeInstalled = $false
    }
}

if (!$nodeInstalled) {
    $answer = Read-Host "Node.js $MIN_NODE_VERSION+ is missing or outdated. Install now via winget? (y/n)"
    if ($answer -eq "y") {
        Write-Host "📦 Installing Node.js (LTS)..."
        winget install OpenJS.NodeJS.LTS
        Write-Host "✅ Done. PLEASE RESTART this PowerShell window to refresh environment variables." -ForegroundColor Green
        exit
    } else { Write-Host "Exiting: Node.js required."; exit }
}

# 2. Check/Install Ollama
if (!(Get-Command ollama -ErrorAction SilentlyContinue)) {
    if ((Read-Host "Ollama not found. Install now? (y/n)") -eq "y") {
        Write-Host "📦 Installing Ollama..."
        winget install Ollama.Ollama
        Write-Host "✅ Done. PLEASE RESTART this PowerShell window." -ForegroundColor Green
        exit
    } else { Write-Host "Exiting: Ollama required."; exit }
}

# 3. Setup App
Write-Host "🤖 Ensuring Ollama model ($OLLAMA_MODEL) is available..."
ollama pull $OLLAMA_MODEL

if (!(Test-Path "node_modules")) {
    Write-Host "📦 Installing dependencies (LanceDB, etc.)..." -ForegroundColor Yellow
    npm install --production
}

# 4. Launch
Write-Host "🚀 Launching Express server..." -ForegroundColor Green
# Start the server
Start-Process node -ArgumentList "server.js" -NoNewWindow

# Wait 3 seconds for it to spin up
Write-Host "Waiting for server to start..." -ForegroundColor Gray
Start-Sleep -Seconds 3

# Open the browser
Start-Process "http://localhost:3000"

Write-Host "✅ App is running at http://localhost:3000" -ForegroundColor Green
Write-Host "Close this window to stop the server."

