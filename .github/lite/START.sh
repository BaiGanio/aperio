#!/bin/bash
# ============================================================
# START.sh  —  Aperio-lite ignition  (macOS + Linux)
#
#   First run:  bash START.sh   (from Terminal — no Gatekeeper prompt)
#   Later:      double-click the "Aperio" launcher this drops on your Desktop.
#   Windows:    run START.bat.
#
# This script does the ONLY things a browser can't: make sure Node.js exists
# and the app's dependencies are installed, then start the server. Everything
# else — llama.cpp, the AI model, the database, provider/API-key config —
# happens in the friendly browser wizard (setup.html) the server opens for you.
# ============================================================

set -uo pipefail

# ── Resolve our own directory (follow the Desktop-launcher symlink) ──
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
    _D=$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)
    SOURCE=$(readlink "$SOURCE"); [[ $SOURCE != /* ]] && SOURCE="$_D/$SOURCE"
done
DIR=$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)
cd "$DIR"

MIN_NODE_VERSION=24
OS="$(uname -s)"
LOG="$DIR/var/install/ignition.log"
mkdir -p "$DIR/var/install"

# ── Minimal UI ───────────────────────────────────────────────
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'; CY=$'\033[96m'; GR=$'\033[92m'; YL=$'\033[93m'; RD=$'\033[91m'
else R=''; B=''; D=''; CY=''; GR=''; YL=''; RD=''; fi
ok()   { printf "  ${GR}${B}✔${R}  %s\n" "$*"; }
info() { printf "  ${CY}●${R}  %s\n"      "$*"; }
warn() { printf "  ${YL}${B}⚠${R}  %s\n" "$*"; }
die()  { printf "\n  ${RD}${B}✖  %s${R}\n\n  ${D}Details: $LOG${R}\n\n" "$*"; read -rp "  Press Enter to close… " _ 2>/dev/null || true; exit 1; }

printf "\n  ${B}${CY}┌──────────────────────────────────────┐${R}\n"
printf   "  ${B}${CY}│   ${R}${B}Aperio-lite${R}  ${D}· starting up…${R}       ${B}${CY}│${R}\n"
printf   "  ${B}${CY}└──────────────────────────────────────┘${R}\n\n"

# ── 1. Node.js — user-local via nvm (no Homebrew, no admin) ──
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +u
    . "$NVM_DIR/nvm.sh"
    set -u
fi
_major=0
command -v node >/dev/null 2>&1 && _major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$_major" -ge "$MIN_NODE_VERSION" ]; then
    ok "Node.js $(node -v)"
else
    warn "Node.js $MIN_NODE_VERSION+ not found — installing (user-local, one time)…"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        set +u
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >>"$LOG" 2>&1
        _nvm_bootstrap_status=$?
        set -u
        [ "$_nvm_bootstrap_status" -eq 0 ] || die "Could not install nvm."
        set +u
        . "$NVM_DIR/nvm.sh"
        set -u
    fi
    set +u
    nvm install --lts >>"$LOG" 2>&1 && nvm use --lts >>"$LOG" 2>&1
    _node_bootstrap_status=$?
    set -u
    if [ "$_node_bootstrap_status" -ne 0 ]; then
        tail -40 "$LOG" >&2 2>/dev/null || true
        die "Could not install Node.js."
    fi
    ok "Node.js $(node -v) ready"
fi

# ── 2. Dependencies — needed before server.js can even boot ──
if [ -d node_modules ]; then
    ok "Dependencies present"
else
    info "Installing dependencies (one time — this can take a minute)…"
    npm install --prefer-offline --no-audit --no-fund >>"$LOG" 2>&1 || die "Dependency install failed."
    ok "Dependencies installed"
fi

# ── 3. Desktop launcher for next time — starts Aperio with NO terminal window ──
# (locally generated → no Gatekeeper warning). Stop from the app's "Quit" button.
chmod +x "$DIR/launch-hidden.sh" 2>/dev/null || true
if [ "$OS" = "Darwin" ]; then
    if command -v osacompile >/dev/null 2>&1; then
        app="$HOME/Desktop/Aperio.app"; rm -rf "$app"
        osacompile -o "$app" -e "do shell script \"cd \\\"$DIR\\\" && ./launch-hidden.sh\"" >/dev/null 2>&1 \
            && ok "Added 'Aperio' to your Desktop (opens with no terminal window)" \
            || warn "Could not create the Desktop app (not critical)."
    else
        f="$HOME/Desktop/Aperio.command"
        printf '#!/bin/bash\ncd "%s" || exit 1\nexec ./START.sh\n' "$DIR" > "$f" && chmod +x "$f" \
            && ok "Added 'Aperio' to your Desktop for next time"
    fi
elif [ "$OS" = "Linux" ]; then
    mkdir -p "$HOME/Desktop"
    f="$HOME/Desktop/Aperio.desktop"
    printf '[Desktop Entry]\nType=Application\nName=Aperio\nExec=%s/launch-hidden.sh\nPath=%s\nTerminal=false\n' "$DIR" "$DIR" > "$f" \
        && chmod +x "$f" && ok "Added an 'Aperio' launcher to your Desktop (no terminal window)"
fi

# ── 4. Launch ────────────────────────────────────────────────
# Automation and installers can validate the complete runtime bootstrap without
# starting a long-running server process.
if [ "${APERIO_START_NO_RUN:-}" = "1" ]; then
    ok "Runtime prepared (automation mode)"
    exit 0
fi

# The server hosts BOTH the setup wizard and the app itself, and opens your
# browser. It runs in THIS window: server logs go to a file so the window stays
# calm, and setup progress appears in the browser — not here.
SERVER_LOG="$DIR/var/install/server.log"
printf "\n  ${GR}${B}✔  Aperio is starting — your browser will open in a moment.${R}\n\n"
printf   "  ${YL}${B}⚠  Keep this window open the whole time you use Aperio.${R}\n"
printf   "  ${D}     It is Aperio's engine — closing it (or pressing Ctrl-C) stops the app,\n"
printf   "  ${D}     even after setup is finished. Next time, just double-click the\n"
printf   "  ${D}     'Aperio' icon on your Desktop.${R}\n\n"
printf   "  ${D}  If your browser doesn't open, go to  ${CY}http://localhost:31337${R}\n"
printf   "  ${D}  Technical logs: $SERVER_LOG${R}\n\n"
npm run start:lite >>"$SERVER_LOG" 2>&1
printf "\n  ${D}Aperio has stopped. You can close this window now.${R}\n\n"
