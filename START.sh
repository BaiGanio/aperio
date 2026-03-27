#!/bin/bash +x

# This forces the script to "see" the folder it is sitting in
cd "$(dirname "$0")"
echo "📍 Current Directory: $(pwd)"

# Exit on error and print the line number
set -e
trap 'echo "❌ Error on line $LINENO. Press any key to exit..."; read -n 1' ERR

# --- CONFIGURATION ---
MIN_NODE_VERSION=18
OLLAMA_MODEL="qwen3"
EMBED_MODEL="mxbai-embed-large"
PORT=31337

# --- PORT AVAILABILITY CHECK ---
# Check if something is already listening on your PORT (31337)
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "------------------------------------------"
    echo "⚠️  PORT CONFLICT DETECTED"
    echo "------------------------------------------"
    echo "The port $PORT is already in use by another process."
    echo "This usually means the server is already running."
    echo "------------------------------------------"
    read -p "Port $PORT is busy. Kill existing process and restart? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        lsof -ti :$PORT | xargs kill -9
        sleep 1
        echo "✅ Port cleared."
    else
        exit 1
    fi
fi

echo "🔍 Starting Aperio-lite environment check..."

# Check if we are running in a Windows-like environment (Git Bash / MSYS)
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    echo "🪟 Windows detected! Please run './START.ps1' in PowerShell for the best experience."
    exit 1
fi

# Function to install Node.js & NPM
install_node() {
    echo "📦 Installing Node.js and NPM..."
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux (Ubuntu/Debian) via NodeSource
        curl -fsSL https://deb.nodesource.com | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS via Homebrew (installs Brew if missing)
        if ! command -v brew &> /dev/null; then
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install node@$MIN_NODE_VERSION
    fi
}

# 1. Check/Install Node.js & NPM
if ! command -v node &> /dev/null; then
    echo "⚠️  Node.js is missing."
    read -p "Would you like to install Node.js $MIN_NODE_VERSION and NPM now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        install_node
    else
        echo "Exiting: Node.js is required." && exit 1
    fi
fi

# 2. Check/Install Ollama
if ! command -v ollama &> /dev/null; then
    echo "⚠️  Ollama is missing."
    read -p "Would you like to install Ollama now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        curl -fsSL https://ollama.com/install.sh | sh
    else
        echo "Exiting: Ollama is required for the LLM features." && exit 1
    fi
fi

# 3. Check if the server is actually responding
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "🚀 Ollama server not responding. Starting it..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # On Mac, we run it in the background using &
        # We redirect output so it doesn't clutter your terminal
        ollama serve > /dev/null 2>&1 &
    else
        # On Linux, nohup is safer to keep it alive
        nohup ollama serve > /dev/null 2>&1 &
    fi

    # CRITICAL: Don't just sleep; wait for a response
    echo "⏳ Waiting for Ollama to respond on port 11434..."
    MAX_RETRIES=10
    COUNT=0
    while ! curl -s http://localhost:11434/api/tags > /dev/null; do
        sleep 2
        COUNT=$((COUNT + 1))
        if [ $COUNT -ge $MAX_RETRIES ]; then
            echo "❌ Error: Ollama failed to start after 20 seconds."
            exit 1
        fi
    done
    echo "✅ Ollama is awake!"
fi

# --- PRE-SET CHECK ---
# Check if the model is already installed locally
if ollama list | grep -q "$OLLAMA_MODEL"; then
    echo "✨ Pre-set model '$OLLAMA_MODEL' found locally!"
    echo "⏩ Skipping RAM estimation and manual selection..."
    SKIP_INSTALL=true
else
    echo "🔍 Pre-set model '$OLLAMA_MODEL' not found. Estimating best fit..."
    SKIP_INSTALL=false
fi

# >>> START WRAPPING HERE >>>
if [ "$SKIP_INSTALL" = false ]; then
    # --- DYNAMIC MODEL SELECTION (March 2026 Reasoning Logic) ---
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # Get RAM in GB on macOS
        RAM_GB=$(($(sysctl -n hw.memsize) / 1024 / 1024 / 1024))
    else
        # Get RAM in GB on Linux
        RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
    fi

    if [ "$RAM_GB" -le 4 ]; then
        # Tier 1: Lite Reasoning (4GB or less)
        OLLAMA_MODEL="qwen2.5:3b-instruct-q4_0"
        echo "💡 Low RAM detected. Falling back to Qwen 2.5 (3B)."
    elif [ "$RAM_GB" -le 8 ]; then
        # Tier 2: Mainstream (8GB or less)
        OLLAMA_MODEL="llama3.1:8b"
        echo "⚖️ Balanced performance. Using Llama 3.1 (8B)."
    else
        # Tier 3: Advanced Reasoning (Above 8GB)
        # Prefers Qwen 3.5 or DeepSeek-R1 Distill based on tier
        if [ "$RAM_GB" -ge 32 ]; then
            OLLAMA_MODEL="deepseek-r1:32b" # High-end reasoning
        elif [ "$RAM_GB" -ge 16 ]; then
            OLLAMA_MODEL="qwen3.5:14b-instruct" # Mid-range reasoning
        else
            OLLAMA_MODEL="qwen3.5:7b-instruct" # Entry-level reasoning
        fi
        echo "🧠 Advanced RAM detected. Using reasoning model: $OLLAMA_MODEL"
    fi

    # --- DISK SPACE CHECK ---
    # Estimate required space in GB based on the selected model
    case $OLLAMA_MODEL in
        *"32b"*) REQ_RAM="24GB+" ;;
        *"14b"*) REQ_RAM="12GB+" ;;
        *"7b"*|*"8b"*) REQ_RAM="8GB+" ;;
        *)       REQ_RAM="4GB+" ;;
    esac

    # Get available disk space in GB (works for Mac and Linux)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
    else
        FREE_GB=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
    fi

    if [ "$FREE_GB" -lt "$REQ_GB" ]; then
    echo "❌ ERROR: Not enough disk space! You need at least ${REQ_GB}GB free."
    echo "Please clean up your drive and try again."
    # We pause here so the window doesn't vanish if they double-clicked
    read -p "Press any key to exit..." -n 1 -s
    exit 1
    fi

    # --- HARDWARE SUMMARY & USER CONFIRMATION ---
    echo "------------------------------------------"
    echo "🖥️  HARDWARE ANALYSIS"
    echo "------------------------------------------"
    echo "👽 OS Detected:  $OSTYPE"
    echo "📊 Total RAM:    ${RAM_GB} GB"
    echo "💾 Free Disk:    ${FREE_GB} GB"
    echo "🥇 Best Fit:     $OLLAMA_MODEL"
    echo "🤖 Embeddings:   $EMBED_MODEL"
    echo "✨ Port:         $PORT"
    echo "------------------------------------------"

    read -p "👉 Use the 'Best Fit' model above? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "⚙️  Entering Manual Selection..."
    echo "Choose a model size that fits your needs:"
    echo "1) Lite (3B - qwen2.5:3b-instruct)        [Needs 4GB RAM]"
    echo "2) Medium (7B - qwen2.5:7b-instruct)      [Needs 8GB RAM]"
    echo "3) Reasoning (14B - qwen3.5:14b-instruct) [Needs 16GB RAM]"
    echo "4) Pro (32B - deepseek-r1:32b)            [Needs 24GB+ RAM]"
    echo "5) Quit"

    while true; do
        read -p "Select a number [1-5]: " choice
        case $choice in
            1) OLLAMA_MODEL="qwen2.5:3b-instruct"; REQ_RAM=4; break ;;
            2) OLLAMA_MODEL="qwen2.5:7b-instruct"; REQ_RAM=8; break ;;
            3) OLLAMA_MODEL="qwen3.5:14b-instruct"; REQ_RAM=16; break ;;
            4) OLLAMA_MODEL="deepseek-r1:32b"; REQ_RAM=24; break ;;
            5) echo "❌ Exiting..."; exit 1 ;;
            *) echo "Invalid selection. Please choose 1-5."; continue ;;
        esac
    done

    # --- THE SAFETY WARNING ---
    if [ "$RAM_GB" -lt "$REQ_RAM" ]; then
        echo "⚠️  WARNING: Your system has ${RAM_GB}GB RAM, but $OLLAMA_MODEL needs at least ${REQ_RAM}GB."
        echo "It will run EXTREMELY slowly (approx. 1 word per minute)."
        read -p "🤔 Are you SURE you want to force this model? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Restarting selection..."
            exec "$0" # This restarts the whole script so they can pick again
        fi
    fi
    fi

    echo "🚀 Selected Model: $OLLAMA_MODEL. Starting setup..."

    # Ask for explicit permission
    read -p "🤔 Based on your RAM, this is the best setup you can get. Proceed with install? (y/n): " -n 1 -r
    echo # Move to a new line
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Installation cancelled by user. exiting..."
    exit 1
    fi

fi 
# <<< END WRAPPING HERE <<<

echo "------------------------------------------"
echo "🧠 PREPARING AI MODEL"
echo "------------------------------------------"
echo "🤖 Model: $OLLAMA_MODEL"
echo "📦 Task:  Downloading AI model..."
echo "🚀 Starting setup..."

ollama pull "$OLLAMA_MODEL"

if [ $? -eq 0 ]; then
    echo "✅ AI model is ready!"
else
    echo "❌ Error: Could not download $OLLAMA_MODEL. Check your internet connection."
    exit 1
fi

echo "------------------------------------------"
echo "🧠 PREPARING VECTOR ENGINE"
echo "------------------------------------------"
echo "🤖 Model: $EMBED_MODEL"
echo "📦 Task:  Downloading embeddings for LanceDB..."

ollama pull "$EMBED_MODEL"

if [ $? -eq 0 ]; then
    echo "✅ Embeddings ready!"
else
    echo "❌ Error: Could not download $EMBED_MODEL. Check your internet connection."
    exit 1
fi

echo "------------------------------------------"
echo "📦 UPDATING SPECIFIC DEPENDENCIES"
echo "------------------------------------------"
# This ensures these 3 are present even if they aren't in package.json yet
npm install @lancedb/lancedb uuid ollama

if [ ! -d "node_modules" ]; then
    echo "📦 Installing app dependencies (LanceDB, Vector utils)..."
    npm install --production
fi

# 5. Final Launch 
# Move to the root directory where server.js and package.json live
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE}")" && pwd)"
cd "$PROJECT_ROOT"
echo "------------------------------------------"
echo "📍 Working in: ${PROJECT_ROOT}"
echo "🚀 Environment ready! Starting server..."
echo "------------------------------------------"
# Start the server in the background
OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &
SERVER_PID=$!

# Wait for server to initialize
echo "Waiting for server to start..."
sleep 3

# Open the browser based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:$PORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:$PORT"
fi

echo "------------------------------------------"
echo "✅ App is running at http://localhost:$PORT"
echo "------------------------------------------"

# Keep the script alive so the server doesn't close
#wait $SERVER_PID
# Instead of just 'wait', use this to keep the window open
echo "---------------------------------------"
echo "📡 Server is active."
echo "For EXIT - press [Enter] TWICE!"
echo "Once to shut down the server."
echo "Twice to close this window."
echo "---------------------------------------"
read
read -n 1 -s
