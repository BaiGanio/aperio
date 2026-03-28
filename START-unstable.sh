#!/bin/bash +x

# This finds the real location of the script, even if run via an alias
SOURCE=${BASH_SOURCE[0]}
while [ -L "$SOURCE" ]; do
  DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
done
DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )

cd "$DIR"
echo "📍 Working in: $(pwd)"

# Exit on error and print the line number
set -e
trap 'echo "❌ Error on line $LINENO. Press any key to exit..."; read -n 1' ERR

# --- CONFIGURATION ---
MIN_NODE_VERSION=18
OLLAMA_MODEL="deepseek-r1:32b"
EMBED_MODEL="mxbai-embed-large"
PORT=31337

# --- CROSS-PLATFORM sed -i WRAPPER ---
# macOS (BSD sed) requires an explicit empty-string backup arg: sed -i ''
# Linux (GNU sed) takes no argument:                             sed -i
sedi() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# --- PORT AVAILABILITY CHECK ---
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>/dev/null; then
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

# ============================================================
# FAST PATH: OLLAMA_MODEL is already set (script patched itself
# on first run) AND the model is present locally — skip all
# installation questions and jump straight to launch.
# grep -F treats the string literally (safe with colons/dots).
# ============================================================
if [ -n "$OLLAMA_MODEL" ] && ollama list 2>/dev/null | grep -qF "$OLLAMA_MODEL"; then
    echo "✨ Model '$OLLAMA_MODEL' already configured and present locally."
    echo "⏩ Skipping setup — launching server..."

    PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$PROJECT_ROOT"
    echo "------------------------------------------"
    echo "🚀 Starting server with model: $OLLAMA_MODEL"
    echo "------------------------------------------"
    OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &

    echo "Waiting for server to start..."
    sleep 3

    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "http://localhost:$PORT"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        xdg-open "http://localhost:$PORT" 2>/dev/null || true
    fi

    echo "------------------------------------------"
    echo "✅ App is running at http://localhost:$PORT"
    echo "---------------------------------------"
    echo "📡 Server is active."
    echo "For EXIT - press [Enter] TWICE!"
    echo "Once to shut down the server."
    echo "Twice to close this window."
    echo "---------------------------------------"
    read
    read -n 1 -s
    exit 0
fi

# ============================================================
# FIRST-TIME SETUP — runs only when OLLAMA_MODEL is empty
# ============================================================

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
        curl -fsSL https://deb.nodesource.com | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [[ "$OSTYPE" == "darwin"* ]]; then
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

# 3. Check if the Ollama server is actually responding
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "🚀 Ollama server not responding. Starting it..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        ollama serve > /dev/null 2>&1 &
    else
        nohup ollama serve > /dev/null 2>&1 &
    fi

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

# --- DYNAMIC MODEL SELECTION ---
# All model names verified against ollama.com/library (March 2026)
if [[ "$OSTYPE" == "darwin"* ]]; then
    RAM_GB=$(($(sysctl -n hw.memsize) / 1024 / 1024 / 1024))
else
    RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
fi

if [ "$RAM_GB" -le 4 ]; then
    # Tier 1: ~2GB download, runs in 4GB RAM
    OLLAMA_MODEL="qwen2.5:3b"
    echo "💡 Low RAM detected. Using Qwen 2.5 (3B)."
elif [ "$RAM_GB" -le 8 ]; then
    # Tier 2: ~4.7GB download, runs in 8GB RAM
    OLLAMA_MODEL="llama3.1:8b"
    echo "⚖️  Balanced performance. Using Llama 3.1 (8B)."
elif [ "$RAM_GB" -ge 32 ]; then
    # Tier 4: ~19GB download, needs 32GB+ RAM
    OLLAMA_MODEL="deepseek-r1:32b"
    echo "🧠 High RAM detected. Using DeepSeek-R1 (32B)."
elif [ "$RAM_GB" -ge 16 ]; then
    # Tier 3b: ~9.3GB download, needs 16GB RAM
    OLLAMA_MODEL="qwen3:14b"
    echo "🧠 Advanced RAM detected. Using Qwen3 (14B)."
else
    # Tier 3a: ~5.2GB download, needs 9-12GB RAM
    OLLAMA_MODEL="qwen3:8b"
    echo "🧠 Good RAM detected. Using Qwen3 (8B)."
fi

# --- DISK SPACE CHECK ---
case $OLLAMA_MODEL in
    *"32b"*)   REQ_GB=20 ;;
    *"14b"*)   REQ_GB=10 ;;
    *"8b"*)    REQ_GB=6  ;;
    *"3b"*)    REQ_GB=3  ;;
    *)         REQ_GB=6  ;;
esac

if [[ "$OSTYPE" == "darwin"* ]]; then
    FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
else
    FREE_GB=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
fi

if [ "$FREE_GB" -lt "$REQ_GB" ]; then
    echo "❌ ERROR: Not enough disk space! You need at least ${REQ_GB}GB free."
    echo "Please clean up your drive and try again."
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
    echo "1) Lite      (3B  - qwen2.5:3b)      [Needs ~4GB RAM,  ~2GB disk]"
    echo "2) Medium    (8B  - llama3.1:8b)      [Needs ~8GB RAM,  ~5GB disk]"
    echo "3) Smart     (8B  - qwen3:8b)         [Needs ~10GB RAM, ~5GB disk]"
    echo "4) Reasoning (14B - qwen3:14b)        [Needs ~16GB RAM, ~9GB disk]"
    echo "5) Pro       (32B - deepseek-r1:32b)  [Needs ~32GB RAM, ~19GB disk]"
    echo "6) Quit"

    while true; do
        read -p "Select a number [1-6]: " choice
        case $choice in
            1) OLLAMA_MODEL="qwen2.5:3b";       REQ_RAM=4;  break ;;
            2) OLLAMA_MODEL="llama3.1:8b";      REQ_RAM=8;  break ;;
            3) OLLAMA_MODEL="qwen3:8b";         REQ_RAM=10; break ;;
            4) OLLAMA_MODEL="qwen3:14b";        REQ_RAM=16; break ;;
            5) OLLAMA_MODEL="deepseek-r1:32b";  REQ_RAM=32; break ;;
            6) echo "❌ Exiting..."; exit 1 ;;
            *) echo "Invalid selection. Please choose 1-6."; continue ;;
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
            exec "$0"
        fi
    fi
fi

echo "🚀 Selected Model: $OLLAMA_MODEL. Starting setup..."

read -p "🤔 Based on your RAM, this is the best setup you can get. Proceed with install? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Installation cancelled by user. exiting..."
    exit 1
fi

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
npm install @lancedb/lancedb uuid ollama

if [ ! -d "node_modules" ]; then
    echo "📦 Installing app dependencies (LanceDB, Vector utils)..."
    npm install --production
fi

# ============================================================
# SELF-PATCH: Write the chosen model back into this script so
# the next run hits the fast path with no prompts.
# ============================================================
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
sedi "s|^OLLAMA_MODEL=\"\"|OLLAMA_MODEL=\"$OLLAMA_MODEL\"|" "$SCRIPT_PATH"
echo "✅ Script updated — future runs will skip setup automatically."

# ============================================================
# ICON SETUP — runs once after first install
# Creates a proper launcher with your custom icon on both
# macOS (.app bundle) and Linux (.desktop file).
# The icon.ico must be in the same folder as START.sh.
# ============================================================
ICON_ICO="$DIR/icon.ico"
APP_NAME="Aperio-lite"

if [ ! -f "$ICON_ICO" ]; then
    echo "⚠️  icon.ico not found in $DIR — skipping icon setup."
else

    # ----------------------------------------------------------
    # macOS: Build an .app bundle with a proper .icns icon
    # Uses only sips and iconutil — both built into macOS,
    # no Homebrew or extra tools required.
    # ----------------------------------------------------------
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "------------------------------------------"
        echo "🎨 CREATING macOS APP BUNDLE"
        echo "------------------------------------------"

        APP_BUNDLE="$DIR/${APP_NAME}.app"
        CONTENTS="$APP_BUNDLE/Contents"
        MACOS_DIR="$CONTENTS/MacOS"
        RESOURCES_DIR="$CONTENTS/Resources"
        ICONSET_DIR="$DIR/icon.iconset"

        # 1. Convert icon.ico → multi-size .icns via an iconset folder
        #    sips reads .ico natively on macOS
        mkdir -p "$ICONSET_DIR"

        for SIZE in 16 32 64 128 256 512; do
            sips -z $SIZE $SIZE "$ICON_ICO" \
                --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}.png" \
                > /dev/null 2>&1
        done
        # Retina (@2x) variants — iconutil expects these
        for SIZE in 16 32 64 128 256; do
            DOUBLE=$((SIZE * 2))
            sips -z $DOUBLE $DOUBLE "$ICON_ICO" \
                --out "$ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" \
                > /dev/null 2>&1
        done

        iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns" 2>/dev/null \
            || { mkdir -p "$RESOURCES_DIR"; iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns"; }

        rm -rf "$ICONSET_DIR"

        # 2. Build the bundle structure
        mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

        # launcher stub — opens a Terminal window running START.sh
        cat > "$MACOS_DIR/${APP_NAME}" << LAUNCHER
#!/bin/bash
open -a Terminal "$DIR/START.sh"
LAUNCHER
        chmod +x "$MACOS_DIR/${APP_NAME}"

        # Info.plist — tells macOS which icon to use
        cat > "$CONTENTS/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>             <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>      <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>       <string>com.aperio.lite</string>
    <key>CFBundleVersion</key>          <string>1.0</string>
    <key>CFBundleIconFile</key>         <string>AppIcon</string>
    <key>CFBundlePackageType</key>      <string>APPL</string>
    <key>CFBundleSignature</key>        <string>????</string>
    <key>LSMinimumSystemVersion</key>   <string>10.13</string>
    <key>LSUIElement</key>              <false/>
</dict>
</plist>
PLIST

        # Force Finder to refresh and display the new icon
        touch "$APP_BUNDLE"
        # Clear the icon cache so macOS picks up the new .icns immediately
        /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
            -f "$APP_BUNDLE" > /dev/null 2>&1 || true

        echo "✅ App bundle created: ${APP_BUNDLE}"
        echo "   Double-click '${APP_NAME}.app' in Finder to launch."
        echo "   Drag it to your Dock or Desktop to create a shortcut."

    # ----------------------------------------------------------
    # Linux: Convert icon.ico → PNG, then create .desktop files
    # for both the application menu and the desktop.
    # Requires ImageMagick (convert). Installs it if missing.
    # ----------------------------------------------------------
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "------------------------------------------"
        echo "🎨 CREATING LINUX DESKTOP SHORTCUT"
        echo "------------------------------------------"

        # Ensure ImageMagick is available for .ico → .png conversion
        if ! command -v convert &> /dev/null; then
            echo "📦 ImageMagick not found. Installing..."
            sudo apt-get install -y imagemagick > /dev/null 2>&1 \
                || sudo dnf install -y imagemagick > /dev/null 2>&1 \
                || sudo pacman -S --noconfirm imagemagick > /dev/null 2>&1 \
                || { echo "⚠️  Could not install ImageMagick automatically."; \
                     echo "    Please run: sudo apt install imagemagick"; \
                     echo "    Then re-run START.sh to create the desktop shortcut."; }
        fi

        ICON_DIR="$HOME/.local/share/icons"
        ICON_PNG="$ICON_DIR/${APP_NAME}.png"
        APPS_DIR="$HOME/.local/share/applications"
        DESKTOP_FILE_APPS="$APPS_DIR/${APP_NAME}.desktop"
        DESKTOP_DIR="$HOME/Desktop"
        DESKTOP_FILE_DESK="$DESKTOP_DIR/${APP_NAME}.desktop"

        mkdir -p "$ICON_DIR" "$APPS_DIR"

        # Convert .ico → .png at 256×256 (best quality from .ico)
        if command -v convert &> /dev/null; then
            convert "$ICON_ICO"[0] -resize 256x256 "$ICON_PNG" > /dev/null 2>&1 \
                && echo "✅ Icon converted: $ICON_PNG" \
                || { echo "⚠️  Icon conversion failed. Using fallback icon path.";
                     ICON_PNG="$ICON_ICO"; }
        else
            # Fallback: point directly at the .ico (some DEs support it)
            ICON_PNG="$ICON_ICO"
        fi

        # Write the .desktop file content to a variable for reuse
        DESKTOP_CONTENT="[Desktop Entry]
Version=1.0
Type=Application
Name=${APP_NAME}
Comment=Local AI assistant — no cloud, no subscriptions
Exec=bash -c 'cd \"$DIR\" && bash \"$DIR/START.sh\"'
Icon=${ICON_PNG}
Terminal=true
Categories=Utility;Application;
StartupWMClass=${APP_NAME}"

        # Install to application menu (~/.local/share/applications)
        echo "$DESKTOP_CONTENT" > "$DESKTOP_FILE_APPS"
        chmod +x "$DESKTOP_FILE_APPS"
        echo "✅ App menu shortcut created: $DESKTOP_FILE_APPS"

        # Install to Desktop
        if [ -d "$DESKTOP_DIR" ]; then
            echo "$DESKTOP_CONTENT" > "$DESKTOP_FILE_DESK"
            chmod +x "$DESKTOP_FILE_DESK"

            # Mark as trusted on GNOME (removes the "untrusted" shield)
            if command -v gio &> /dev/null; then
                gio set "$DESKTOP_FILE_DESK" metadata::trusted true > /dev/null 2>&1 || true
            fi

            echo "✅ Desktop shortcut created: $DESKTOP_FILE_DESK"
        else
            echo "⚠️  No Desktop folder found at $DESKTOP_DIR — skipping desktop shortcut."
        fi

        # Refresh the application menu cache
        if command -v update-desktop-database &> /dev/null; then
            update-desktop-database "$APPS_DIR" > /dev/null 2>&1 || true
        fi

        echo "   The '${APP_NAME}' icon should now appear in your app menu and Desktop."
    fi

fi # end icon.ico exists check

# ============================================================
# FINAL LAUNCH
# ============================================================
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
echo "------------------------------------------"
echo "📍 Working in: ${PROJECT_ROOT}"
echo "🚀 Environment ready! Starting server..."
echo "------------------------------------------"
OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &
SERVER_PID=$!

echo "Waiting for server to start..."
sleep 3

if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:$PORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:$PORT" 2>/dev/null || true
fi

echo "------------------------------------------"
echo "✅ App is running at http://localhost:$PORT"
echo "------------------------------------------"
echo "---------------------------------------"
echo "📡 Server is active."
echo "For EXIT - press [Enter] TWICE! - Once to shut down the server. Twice to close this window."
echo "---------------------------------------"
read
read -n 1 -s