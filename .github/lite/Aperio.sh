#!/usr/bin/env bash
# Linux — make executable then double-click (set "Run as program" in file manager)
# or run from terminal: ./Aperio.sh

MIN_NODE_MAJOR=18
cd "$(dirname "$0")"
LOG_FILE="bootstrap.log"

log() { echo "[aperio] $*"; }
die() {
  echo ""; echo "[aperio] ERROR: $*"
  echo "[aperio] Check bootstrap.log for details."
  echo ""; echo "Press Enter to close…"; read -r; exit 1
}

echo ""
echo "  ╭─────────────────────────╮"
echo "  │       Aperio            │"
echo "  ╰─────────────────────────╯"
echo ""

# nvm lives outside PATH in most distros
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -f "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# fnm is another common node manager on Linux
[ -f "$HOME/.local/share/fnm/fnm" ] && eval "$(fnm env 2>/dev/null)"

needs_node=false
if command -v node >/dev/null 2>&1; then
  major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
  if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
    log "Node.js $(node -v) — OK"
  else
    log "Node.js $(node -v) too old — upgrading…"; needs_node=true
  fi
else
  log "Node.js not found — installing…"; needs_node=true
fi

if [ "$needs_node" = true ]; then
  if [ ! -f "$NVM_DIR/nvm.sh" ]; then
    log "Downloading nvm…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh \
      | bash >> "$LOG_FILE" 2>&1 || die "nvm install failed"
    source "$NVM_DIR/nvm.sh"
  fi
  log "Installing Node.js LTS…"
  nvm install --lts >> "$LOG_FILE" 2>&1 || die "node install failed"
  nvm use --lts >> "$LOG_FILE" 2>&1
  log "Node.js $(node -v) ready"
fi

if [ ! -d "node_modules" ]; then
  log "Installing npm dependencies…"
  npm install --prefer-offline --no-audit --no-fund >> "$LOG_FILE" 2>&1 || die "npm install failed"
fi

log "Starting Aperio — opening browser…"
echo ""
node server.js

echo ""; echo "[aperio] Server stopped (exit code $?)."
echo "Press Enter to close…"; read -r