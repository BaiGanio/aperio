#!/bin/bash
# ============================================================
# lib.sh  —  Shared helpers for START.sh and DRY_RUN.sh
#
# Source this file; do not execute it directly.
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# ============================================================

# ── Resolve script directory ─────────────────────────────────
_resolve_dir() {
    local src="${BASH_SOURCE[1]}"          # caller's path
    while [ -L "$src" ]; do
        local d
        d=$( cd -P "$( dirname "$src" )" >/dev/null 2>&1 && pwd )
        src=$(readlink "$src")
        [[ $src != /* ]] && src=$d/$src
    done
    cd -P "$( dirname "$src" )" >/dev/null 2>&1 && pwd
}
DIR=$(_resolve_dir)
cd "$DIR"

# ── Shared constants ─────────────────────────────────────────
MIN_NODE_VERSION=18
EMBED_MODEL="mxbai-embed-large"
PORT=31337
INSTALL_LOG="$DIR/installed.log"

# ── Colour / style helpers ────────────────────────────────────
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    printf '\e[8;40;100t' 2>/dev/null || true

    R=$'\033[0m'
    B=$'\033[1m'
    D=$'\033[2m'
    CY=$'\033[96m'
    GR=$'\033[92m'
    YL=$'\033[93m'
    RD=$'\033[91m'
    MG=$'\033[95m'
    WH=$'\033[97m'
    BL=$'\033[94m'
else
    R=''; B=''; D=''
    CY=''; GR=''; YL=''; RD=''; MG=''; WH=''; BL=''
fi

ok()   { printf "  ${GR}${B}✔${R}  %s\n"                    "$*"; }
warn() { printf "  ${YL}${B}⚠${R}  %s\n"                    "$*"; }
info() { printf "  ${CY}●${R}  %s\n"                         "$*"; }
die()  { printf "  ${RD}${B}✖  %s${R}\n"                     "$*"; }
dry()  { printf "  ${MG}${B}[DRY-RUN]${R}  ${D}%s${R}\n"    "$*"; }

section() {
    printf "\n  ${B}${BL}┌─────────────────────────────────────────────────┐${R}\n"
    printf   "  ${B}${BL}│  ${WH}${B}  %-47s${R}${B}${BL}│${R}\n" "$1"
    printf   "  ${B}${BL}└─────────────────────────────────────────────────┘${R}\n\n"
}

# run "description" cmd [args…]
# Dry-run → prints what it would do; live → executes.
run() {
    local desc="$1"; shift
    if [ "${DRY_RUN:-false}" = true ]; then
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

# ── Installation tracker ──────────────────────────────────────
track_install() {
    local key="$1"
    local val="$2"

    [ "${DRY_RUN:-false}" = true ] && return

    if [ "$key" = "OLLAMA_MODELS" ]; then
        local existing=""
        if [ -f "$INSTALL_LOG" ]; then
            existing=$(grep "^OLLAMA_MODELS=" "$INSTALL_LOG" 2>/dev/null | cut -d= -f2- || true)
        fi
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

# ── Cross-platform sed -i ─────────────────────────────────────
sedi() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# ── Pre-install manifest ──────────────────────────────────────
print_pre_install_manifest() {
    print_banner

    if [ "${DRY_RUN:-false}" = true ]; then
        printf "  ${MG}${B}╔══════════════════════════════════════════════╗${R}\n"
        printf "  ${MG}${B}║       🧪  DRY-RUN MODE IS ACTIVE            ║${R}\n"
        printf "  ${MG}${B}║  Nothing will be installed or downloaded.   ║${R}\n"
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

# ── Shared install flows ──────────────────────────────────────
# Each function below is one logical "flow" that both START.sh
# and DRY_RUN.sh call.  DRY_RUN=true makes run() a no-op printer.
# Add new flows here and reference them from both entry points.

flow_check_port() {
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
}

flow_fast_path() {
    # Returns 0 (handled/exit) or 1 (continue to first-time setup).
    [ -z "$OLLAMA_MODEL" ] && return 1

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
        local project_root
        project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        cd "$project_root"
        section "STARTING  ·  $OLLAMA_MODEL  ·  port $PORT"
        run "Start server" "OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &"
        SERVER_STARTED=true
        info "Waiting for server to start..."
        sleep 3
        if [ "${DRY_RUN:-false}" = false ]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                open "http://localhost:$PORT"
            elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
                xdg-open "http://localhost:$PORT" 2>/dev/null || true
            fi
        fi
        printf "\n"
        ok "App is running at  ${CY}http://localhost:$PORT${R}"
        printf "\n  ${D}Press [Enter] TWICE to stop the server and close this window.${R}\n\n"
        read -r; read -r
        cleanup
        exit 0
    else
        warn "Entering reconfiguration mode..."
        if [ "${DRY_RUN:-false}" = true ]; then
            dry "Would remove OLLAMA_MODEL from $INSTALL_LOG"
        else
            if [ -f "$INSTALL_LOG" ]; then
                grep -v "^OLLAMA_MODEL=" "$INSTALL_LOG" > "${INSTALL_LOG}.tmp" \
                    && mv "${INSTALL_LOG}.tmp" "$INSTALL_LOG" 2>/dev/null || true
            fi
        fi
        OLLAMA_MODEL=""
        RECONFIGURE=true
        ok "Configuration reset — continuing to setup..."
        printf "\n"
        return 1
    fi
}

flow_env_check() {
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

    if ! curl -s http://localhost:11434/api/tags > /dev/null; then
        info "Ollama server not responding — starting it..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            run "Start ollama serve" "ollama serve > /dev/null 2>&1 &"
        else
            run "Start ollama serve" "nohup ollama serve > /dev/null 2>&1 &"
        fi
        if [ "${DRY_RUN:-false}" = true ]; then
            dry "Would wait for Ollama on port 11434..."
            dry "Ollama is awake! (simulated)"
        else
            info "Waiting for Ollama on port 11434..."
            local max=10 count=0
            while ! curl -s http://localhost:11434/api/tags > /dev/null; do
                sleep 2
                count=$((count + 1))
                if [ "$count" -ge "$max" ]; then
                    die "Ollama failed to start after 20 seconds."
                    exit 1
                fi
            done
            ok "Ollama is awake!"
        fi
    else
        ok "Ollama server is already running."
    fi
}

flow_hardware_analysis() {
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

    local req_gb
    case $OLLAMA_MODEL in
        *"32b"*) req_gb=20 ;;
        *"14b"*) req_gb=10 ;;
        *"8b"*)  req_gb=6  ;;
        *"3b"*)  req_gb=3  ;;
        *)       req_gb=6  ;;
    esac

    local free_gb
    if [[ "$OSTYPE" == "darwin"* ]]; then
        free_gb=$(df -g . | awk 'NR==2 {print $4}')
    else
        free_gb=$(df -BG . | awk 'NR==2 {print $4}' | sed 's/G//')
    fi
    FREE_GB=$free_gb

    if [ "$FREE_GB" -lt "$req_gb" ]; then
        die "Not enough disk space — need ${req_gb}GB free, you have ${FREE_GB}GB."
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
}

flow_model_picker() {
    [ "$RECONFIGURE" != true ] && return

    printf "  ${WH}${B}Choose a model to install:${R}\n\n"
    printf "  ${CY}  1)${R}  qwen2.5:3b   ${D}~2 GB   — lightest, fast${R}\n"
    printf "  ${CY}  2)${R}  qwen3:8b     ${D}~5 GB   — balanced${R}\n"
    printf "  ${CY}  3)${R}  qwen3:14b    ${D}~9 GB   — recommended for 32 GB RAM${R}\n"
    printf "  ${CY}  4)${R}  llama3.1:8b  ${D}~5 GB   — stable alternative${R}\n"
    printf "  ${D}  (press Enter to keep the auto-selected: ${B}$OLLAMA_MODEL${R}${D})${R}\n\n"
    read -rp "  Your choice [1-4]: " -n 1 MODEL_CHOICE
    printf "\n"
    case "$MODEL_CHOICE" in
        1) OLLAMA_MODEL="qwen2.5:3b"  ;;
        2) OLLAMA_MODEL="qwen3:8b"    ;;
        3) OLLAMA_MODEL="qwen3:14b"   ;;
        4) OLLAMA_MODEL="llama3.1:8b" ;;
        *) info "Keeping auto-selected model: ${B}$OLLAMA_MODEL${R}" ;;
    esac
    ok "Selected model: ${B}$OLLAMA_MODEL${R}"
    printf "\n"
}

flow_confirm_install() {
    read -rp "  🤔  Proceed with install? (y/n): " -n 1 REPLY
    printf "\n"
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        die "Installation cancelled."
        read -rp "  Press any key to exit..." -n 1
        exit 1
    fi
}

flow_pull_models() {
    section "DOWNLOADING AI MODEL  —  $OLLAMA_MODEL"
    run "Pull $OLLAMA_MODEL" "ollama pull '$OLLAMA_MODEL'"
    [ "${DRY_RUN:-false}" = false ] && ok "AI model ready!"
    track_install OLLAMA_MODELS "$OLLAMA_MODEL"
    track_install OLLAMA_MODEL  "$OLLAMA_MODEL"

    section "DOWNLOADING EMBEDDING MODEL  —  $EMBED_MODEL"
    run "Pull $EMBED_MODEL" "ollama pull '$EMBED_MODEL'"
    [ "${DRY_RUN:-false}" = false ] && ok "Embeddings ready!"
    track_install OLLAMA_MODELS "$EMBED_MODEL"
}

flow_npm_install() {
    section "INSTALLING APP DEPENDENCIES"
    run "npm install core packages" "npm install @lancedb/lancedb uuid ollama"
    track_install NPM_PACKAGES "@lancedb/lancedb uuid ollama"
    if [ ! -d "node_modules" ]; then
        run "npm install (full)" "npm install --production"
    fi
    [ "${DRY_RUN:-false}" = false ] && ok "Dependencies installed."
}

flow_launch() {
    local project_root
    project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cd "$project_root"

    section "LAUNCHING  ·  $OLLAMA_MODEL  ·  port $PORT"
    run "Start server" "OLLAMA_MODEL=$OLLAMA_MODEL npm run start:lite &"
    SERVER_STARTED=true
    info "Waiting for server to start..."

    if [ "${DRY_RUN:-false}" = false ]; then
        sleep 3
        if [[ "$OSTYPE" == "darwin"* ]]; then
            open "http://localhost:$PORT"
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            xdg-open "http://localhost:$PORT" 2>/dev/null || true
        fi
        printf "\n"
        ok "App is running at  ${CY}${B}http://localhost:$PORT${R}"
        printf "\n  ${D}Press [Enter] TWICE to stop the server and close this window.${R}\n\n"
        read -r; read -r
        cleanup
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
}