#!/bin/bash

# This finds the real location of the script, even if run via an alias
SOURCE=${BASH_SOURCE[0]}
while [ -L "$SOURCE" ]; do
  DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$DIR/$SOURCE
done
DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )

cd "$DIR"

# ============================================================
# DRY RUN MODE
# Set DRY_RUN=true  → simulate the full flow, nothing installed.
# Set DRY_RUN=false → normal run, exactly as any user would see.
# ============================================================
DRY_RUN=false

# ============================================================
# INSTALLATION TRACKER
# Every component installed is recorded in installed.log
# so that uninstall.sh can remove exactly what landed here.
#
# Models use the key OLLAMA_MODELS (plural) and are kept as a
# space-separated list so pulling a second or third model just
# appends to the existing list rather than overwriting it.
# ============================================================
INSTALL_LOG="$DIR/assets/installed.log"

track_install() {
    # Usage: track_install KEY VALUE
    # OLLAMA_MODELS → additive (appends if not already present)
    # all other keys → replace (last-write wins)
    local key="$1"
    local val="$2"

    [ "$DRY_RUN" = true ] && return

    if [ "$key" = "OLLAMA_MODELS" ]; then
        local existing=""
        if [ -f "$INSTALL_LOG" ]; then
            existing=$(grep "^OLLAMA_MODELS=" "$INSTALL_LOG" 2>/dev/null | cut -d= -f2- || true)
        fi
        # Skip if already tracked
        echo "$existing" | grep -qF "$val" && return
        local updated
        [ -z "$existing" ] && updated="$val" || updated="$existing $val"
        if [ -f "$INSTALL_LOG" ]; then
            grep -v "^OLLAMA_MODELS=" "$INSTALL_LOG" > "${INSTALL_LOG}.tmp" \
                && mv "${INSTALL_LOG}.tmp" "$INSTALL_LOG" 2>/dev/null || true
        fi
        echo "OLLAMA_MODELS=${updated}" >> "$INSTALL_LOG"
    else
        if [ -f "$INSTALL_LOG" ]; then
            grep -v "^${key}=" "$INSTALL_LOG" > "${INSTALL_LOG}.tmp" \
                && mv "${INSTALL_LOG}.tmp" "$INSTALL_LOG" 2>/dev/null || true
        fi
        echo "${key}=${val}" >> "$INSTALL_LOG"
    fi
}

# ============================================================
# COLOUR / STYLE HELPERS
#
# Using $'...' literals so escape characters are baked in at
# assignment time.  This avoids the "i: command not found" crash
# that happened on macOS bash 3.2 when \033 strings were passed
# through echo -e and then re-evaluated by set -e.
# ============================================================
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    printf '\e[8;40;100t' 2>/dev/null || true   # widen terminal to ~100 cols

    R=$'\033[0m'      # reset
    B=$'\033[1m'      # bold
    D=$'\033[2m'      # dim

    CY=$'\033[96m'    # cyan
    GR=$'\033[92m'    # green
    YL=$'\033[93m'    # yellow
    RD=$'\033[91m'    # red
    MG=$'\033[95m'    # magenta
    WH=$'\033[97m'    # white
    BL=$'\033[94m'    # blue
else
    R=''; B=''; D=''
    CY=''; GR=''; YL=''; RD=''; MG=''; WH=''; BL=''
fi

ok()   { printf "  ${GR}${B}✔${R}  %s\n"          "$*"; }
warn() { printf "  ${YL}${B}⚠${R}  %s\n"          "$*"; }
info() { printf "  ${CY}●${R}  %s\n"               "$*"; }
die()  { printf "  ${RD}${B}✖  %s${R}\n"           "$*"; }
dry()  { printf "  ${MG}${B}[DRY-RUN]${R}  ${D}%s${R}\n" "$*"; }

section() {
    printf "\n  ${B}${BL}┌─────────────────────────────────────────────────┐${R}\n"
    printf   "  ${B}${BL}│  ${WH}${B}  %-47s${R}${B}${BL}│${R}\n" "$1"
    printf   "  ${B}${BL}└─────────────────────────────────────────────────┘${R}\n\n"
}

# run "description" "shell command"
# In DRY_RUN mode prints what it would do; otherwise executes.
run() {
    local desc="$1"; shift
    if [ "$DRY_RUN" = true ]; then
        dry "$desc  →  $*"
    else
        eval "$@"
    fi
}

print_banner() {
    printf "\n"
    printf "  ${B}${CY}┌──────────────────────────────────────┐${R}\n"
    printf "  ${B}${CY}│                                      │${R}\n"
    printf "  ${B}${CY}│   ${WH}${B}Aperio-lite${R}  ${D}· local AI setup${R}    ${B}${CY}│${R}\n"
    printf "  ${B}${CY}│                                      │${R}\n"
    printf "  ${B}${CY}└──────────────────────────────────────┘${R}\n"
    printf "\n"
}

# Exit on error; print line number
set -e
trap 'die "Error on line $LINENO — press any key to exit..."; read -rn 1' ERR

# --- CONFIGURATION ---
MIN_NODE_VERSION=18
OLLAMA_MODEL=""
EMBED_MODEL="mxbai-embed-large"
PORT=31337

sedi() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# ============================================================
# PRE-INSTALL MANIFEST  (first-time runs only)
# ============================================================
print_pre_install_manifest() {
    print_banner

    if [ "$DRY_RUN" = true ]; then
        printf "  ${MG}${B}╔══════════════════════════════════════════════╗${R}\n"
        printf "  ${MG}${B}║       🧪  DRY-RUN MODE IS ACTIVE            ║${R}\n"
        printf "  ${MG}${B}║  Nothing will be installed or downloaded.   ║${R}\n"
        printf "  ${MG}${B}║  Set  DRY_RUN=false  to run for real.       ║${R}\n"
        printf "  ${MG}${B}╚══════════════════════════════════════════════╝${R}\n\n"
    fi

    section "WHAT THIS INSTALLER WILL SET UP"

    printf "  ${WH}${B}Everything that may land on your Mac — nothing hidden, nothing extra.${R}\n\n"

    printf "  ${B}${CY}  %-22s  %-42s  %s${R}\n" "COMPONENT" "WHERE ON YOUR MAC" "SIZE"
    printf "  ${D}  %s${R}\n" "───────────────────────────────────────────────────────────────────────────────"
    printf "  ${GR}${B}  %-22s${R}  %-42s  %s\n" "Node.js + npm"     "via Homebrew  (if not present)"              "~80 MB"
    printf "  ${GR}${B}  %-22s${R}  %-42s  %s\n" "Ollama"            "/usr/local/bin/ollama  (if not present)"     "~50 MB"
    printf "  ${GR}${B}  %-22s${R}  %-42s  %s\n" "AI language model" "~/.ollama/models/"                          "3–20 GB"
    printf "  ${GR}${B}  %-22s${R}  %-42s  %s\n" "Embedding model"   "~/.ollama/models/  ($EMBED_MODEL)"          "~670 MB"
    printf "  ${GR}${B}  %-22s${R}  %-42s  %s\n" "npm packages"      "./node_modules/"                            "~50 MB"
    printf "  ${GR}${B}  %-22s${R}  %-42s  %s\n" "Install log"       "./.aperio_installed.log"                    "< 1 KB"
    printf "  ${D}  %s${R}\n" "───────────────────────────────────────────────────────────────────────────────"
    printf "\n  ${YL}${B}  Total (estimate):${R}  4–21 GB depending on the AI model you choose.\n"
    printf "\n  ${WH}  To remove Aperio-lite completely later, just run:${R}\n"
    printf   "  ${CY}${B}      ./uninstall.sh${R}\n"
    printf   "  ${D}  It reads the install log and removes only what this script placed here.${R}\n\n"
}

if [ -z "$OLLAMA_MODEL" ]; then
    print_pre_install_manifest
    printf "  ${WH}${B}Ready to continue?${R}\n"
    read -rp "  Press [Enter] to start setup, or Ctrl-C to cancel... " _DUMMY
    printf "\n"
fi

# --- PORT AVAILABILITY CHECK ---
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>/dev/null; then
    printf "\n  ${YL}${B}⚠  PORT CONFLICT DETECTED${R}\n"
    printf "  Port ${B}%s${R} is already in use — the server may already be running.\n\n" "$PORT"
    read -rp "  Kill existing process and restart? (y/n): " -n 1 REPLY
    printf "\n"
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        run "Kill process on port $PORT" "lsof -ti :$PORT | xargs kill -9"
        sleep 1
        ok "Port cleared."
    else
        exit 1
    fi
fi

# ============================================================
# FAST PATH — already configured from a previous run
# ============================================================
if [ -n "$OLLAMA_MODEL" ] && ollama list 2>/dev/null | grep -qF "$OLLAMA_MODEL"; then
    print_banner
    printf "  ${GR}${B}✨  Existing configuration found${R}\n\n"
    info "Model : ${B}$OLLAMA_MODEL${R}"
    info "Port  : ${B}$PORT${R}"
    printf "\n"
    read -rp "  ▶  Launch with this model? (y = start now / n = reconfigure): " -n 1 REPLY
    printf "\n"
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [ ! -d "node_modules" ]; then
            warn "Missing dependencies — installing..."
            run "npm install" "npm install"
        fi
        PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        cd "$PROJECT_ROOT"
        section "STARTING  ·  $OLLAMA_MODEL  ·  port $PORT"
        run "Start server" "OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &"
        info "Waiting for server to start..."
        sleep 3
        if [ "$DRY_RUN" = false ]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                open "http://localhost:$PORT"
            elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
                xdg-open "http://localhost:$PORT" 2>/dev/null || true
            fi
        fi
        printf "\n"
        ok "App is running at  ${CY}http://localhost:$PORT${R}"
        printf "\n  ${D}For EXIT — press [Enter] TWICE\n  Once to shut down, twice to close this window.${R}\n\n"
        read -r
        read -rn 1
        exit 0
    else
        warn "Entering reconfiguration mode..."
        SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
        run "Reset OLLAMA_MODEL in script" \
            "sedi 's|^OLLAMA_MODEL=\"[^\"]*\"|OLLAMA_MODEL=\"\"|' \"$SCRIPT_PATH\""
        OLLAMA_MODEL=""
        ok "Configuration reset — continuing to setup..."
        printf "\n"
    fi
fi

# ============================================================
# FIRST-TIME SETUP
# ============================================================
section "ENVIRONMENT CHECK"

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    die "Windows detected! Please run './START.ps1' in PowerShell instead."
    exit 1
fi

install_node() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        run "Install Node.js (Linux)" \
            "curl -fsSL https://deb.nodesource.com | sudo -E bash - && sudo apt-get install -y nodejs"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        if ! command -v brew &> /dev/null; then
            run "Install Homebrew" \
                '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            track_install HOMEBREW true
        fi
        run "Install Node.js (macOS)" "brew install node@$MIN_NODE_VERSION"
        track_install NODEJS "node@${MIN_NODE_VERSION}_brew"
    fi
}

# 1. Node.js
if ! command -v node &> /dev/null; then
    warn "Node.js is not installed."
    read -rp "  Install Node.js $MIN_NODE_VERSION and NPM now? (y/n) " -n 1 REPLY
    printf "\n"
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        install_node
    else
        die "Exiting: Node.js is required." && exit 1
    fi
else
    ok "Node.js found: $(node -v)"
fi

# 2. Ollama
if ! command -v ollama &> /dev/null; then
    warn "Ollama is not installed."
    read -rp "  Install Ollama now? (y/n) " -n 1 REPLY
    printf "\n"
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        run "Install Ollama" "curl -fsSL https://ollama.com/install.sh | sh"
        track_install OLLAMA true
    else
        die "Exiting: Ollama is required for AI features." && exit 1
    fi
else
    ok "Ollama found: $(ollama --version 2>/dev/null || printf 'installed')"
fi

# 3. Ollama server
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    info "Ollama server not responding — starting it..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        run "Start ollama serve" "ollama serve > /dev/null 2>&1 &"
    else
        run "Start ollama serve" "nohup ollama serve > /dev/null 2>&1 &"
    fi
    info "Waiting for Ollama on port 11434..."
    MAX_RETRIES=10; COUNT=0
    while ! curl -s http://localhost:11434/api/tags > /dev/null; do
        sleep 2
        COUNT=$((COUNT + 1))
        if [ "$COUNT" -ge "$MAX_RETRIES" ]; then
            die "Ollama failed to start after 20 seconds."
            exit 1
        fi
    done
    ok "Ollama is awake!"
else
    ok "Ollama server is already running."
fi

# ============================================================
# HARDWARE ANALYSIS & MODEL SELECTION
# ============================================================
section "HARDWARE ANALYSIS"

if [[ "$OSTYPE" == "darwin"* ]]; then
    RAM_GB=$(($(sysctl -n hw.memsize) / 1024 / 1024 / 1024))
else
    RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
fi

if [ "$RAM_GB" -le 4 ]; then
    OLLAMA_MODEL="qwen2.5:3b"
    info "${RAM_GB}GB RAM — using lightest model: ${B}Qwen 2.5 (3B)${R}"
elif [ "$RAM_GB" -le 8 ]; then
    OLLAMA_MODEL="qwen2.5:3b"
    info "${RAM_GB}GB RAM — recommending ${B}Qwen 2.5 (3B)${R} to keep your system comfortable."
elif [ "$RAM_GB" -ge 32 ]; then
    OLLAMA_MODEL="qwen3:14b"
    info "${RAM_GB}GB RAM — recommending ${B}Qwen3 (14B)${R} for a smooth experience."
elif [ "$RAM_GB" -ge 16 ]; then
    OLLAMA_MODEL="qwen3:8b"
    info "${RAM_GB}GB RAM — recommending ${B}Qwen3 (8B)${R} for a balanced experience."
else
    OLLAMA_MODEL="llama3.1:8b"
    info "${RAM_GB}GB RAM — recommending ${B}Llama 3.1 (8B)${R} for a stable experience."
fi

case $OLLAMA_MODEL in
    *"32b"*) REQ_GB=20 ;;
    *"14b"*) REQ_GB=10 ;;
    *"8b"*)  REQ_GB=6  ;;
    *"3b"*)  REQ_GB=3  ;;
    *)       REQ_GB=6  ;;
esac

if [[ "$OSTYPE" == "darwin"* ]]; then
    FREE_GB=$(df -g . | awk 'NR==2 {print $4}')
else
    FREE_GB=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
fi

if [ "$FREE_GB" -lt "$REQ_GB" ]; then
    die "Not enough disk space — need ${REQ_GB}GB free, you have ${FREE_GB}GB."
    die "Free up space and try again."
    read -rp "  Press any key to exit..." -n 1
    exit 1
fi

printf "\n"
printf "  ${B}${CY}  %-20s  %s${R}\n" "ITEM" "VALUE"
printf "  ${D}  %s${R}\n" "────────────────────────────────────────────"
printf "  ${CY}  %-20s${R}  %s\n"  "OS"          "$OSTYPE"
printf "  ${CY}  %-20s${R}  %s\n"  "Total RAM"   "${RAM_GB} GB"
printf "  ${CY}  %-20s${R}  %s\n"  "Free Disk"   "${FREE_GB} GB"
printf "  ${CY}  %-20s${R}  ${GR}${B}%s${R}  ${D}← one tier below max${R}\n" "Recommended AI" "$OLLAMA_MODEL"
printf "  ${CY}  %-20s${R}  %s\n"  "Embeddings"  "$EMBED_MODEL"
printf "  ${CY}  %-20s${R}  %s\n"  "Port"        "$PORT"
printf "  ${D}  %s${R}\n\n" "────────────────────────────────────────────"

ok "Auto-selected model: ${B}$OLLAMA_MODEL${R}"
printf "\n"

read -rp "  🤔  Proceed with install? (y/n): " -n 1 REPLY
printf "\n"
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    die "Installation cancelled."
    exit 1
fi

set +e  # From here on, don't exit on error — we want to always reach the final pause

# ── Pull AI model ─────────────────────────────────────────────────────────────
section "DOWNLOADING AI MODEL  —  $OLLAMA_MODEL"

run "Pull $OLLAMA_MODEL" "ollama pull '$OLLAMA_MODEL'"
if [ "$DRY_RUN" = false ]; then
    ok "AI model ready!"
fi
track_install OLLAMA_MODELS "$OLLAMA_MODEL"

# ── Pull embedding model ──────────────────────────────────────────────────────
section "DOWNLOADING EMBEDDING MODEL  —  $EMBED_MODEL"

run "Pull $EMBED_MODEL" "ollama pull '$EMBED_MODEL'"
if [ "$DRY_RUN" = false ]; then
    ok "Embeddings ready!"
fi
track_install OLLAMA_MODELS "$EMBED_MODEL"

# ── npm dependencies ──────────────────────────────────────────────────────────
section "INSTALLING APP DEPENDENCIES"

run "npm install core packages" "npm install @lancedb/lancedb uuid ollama"
track_install NPM_PACKAGES "@lancedb/lancedb uuid ollama"

if [ ! -d "node_modules" ]; then
    run "npm install (full)" "npm install --production"
fi

if [ "$DRY_RUN" = false ]; then
    ok "Dependencies installed."
fi

# ── Self-patch ────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = false ]; then
    SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    sedi "s|^OLLAMA_MODEL=\"\"|OLLAMA_MODEL=\"$OLLAMA_MODEL\"|" "$SCRIPT_PATH"
    ok "Script updated — future runs skip setup automatically."
else
    dry "Would self-patch OLLAMA_MODEL=\"$OLLAMA_MODEL\" into this script."
fi

# ── Final launch ──────────────────────────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

section "LAUNCHING  ·  $OLLAMA_MODEL  ·  port $PORT"

run "Start server" "OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &"
info "Waiting for server to start..."

if [ "$DRY_RUN" = false ]; then
    sleep 3

    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "http://localhost:$PORT"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        xdg-open "http://localhost:$PORT" 2>/dev/null || true
    fi

    printf "\n"
    ok "App is running at  ${CY}${B}http://localhost:$PORT${R}"
    printf "\n  ${D}For EXIT — press [Enter] TWICE\n  Once to shut down, twice to close this window.${R}\n\n"
    read -r
    read -rn 1
else
    printf "\n"
    dry "Server would start at  http://localhost:$PORT"
    dry "Browser would open automatically."
    printf "\n"
    ok "Dry-run complete — nothing was changed on your system."
    printf "\n"
    printf "  Press [Enter] to close..."
    read -r _DUMMY
    printf "\n"
fi