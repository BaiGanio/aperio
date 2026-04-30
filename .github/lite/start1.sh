#!/usr/bin/env bash
# No set -e / -u — we handle errors explicitly so the terminal stays open on failure

MIN_NODE_MAJOR=18

# ── Always run from the directory that contains this script ──────────────────
cd "$(dirname "$0")"

LOG_FILE="bootstrap.log"

log() { echo "[aperio] $*"; }
die() { echo "[aperio] ERROR: $*" >&2; echo; echo "Press Enter to close…"; read -r; exit 1; }

# ── 1. Ensure Node.js exists ──────────────────────────────────────────────────

ensure_node() {
  # Try to load nvm first — it may have node even if PATH doesn't
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -f "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
  fi

  if command -v node >/dev/null 2>&1; then
    local major
    major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      log "Node.js $(node -v) — OK"
      return 0
    fi
    log "Node.js $(node -v) is too old (need >= $MIN_NODE_MAJOR), upgrading…"
  else
    log "Node.js not found — installing via nvm…"
  fi

  if [ ! -f "$NVM_DIR/nvm.sh" ]; then
    log "Downloading nvm…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh \
      | bash >> "$LOG_FILE" 2>&1 \
      || die "nvm download failed — check $LOG_FILE"
    source "$NVM_DIR/nvm.sh"
  fi

  log "Installing Node.js LTS (this may take a minute)…"
  nvm install --lts >> "$LOG_FILE" 2>&1 || die "nvm install failed — check $LOG_FILE"
  nvm use --lts     >> "$LOG_FILE" 2>&1
  log "Node.js $(node -v) installed"
}

ensure_node

# ── 2. Install npm deps if node_modules is absent ────────────────────────────

if [ ! -d "node_modules" ]; then
  log "Running npm install…"
  npm install --prefer-offline --no-audit --no-fund >> "$LOG_FILE" 2>&1 \
    || die "npm install failed — check $LOG_FILE"
fi

# ── 3. Start the server ───────────────────────────────────────────────────────
# 'node' not 'exec node' — keeps the shell alive as parent so terminal
# launchers (double-click .command, macOS open, etc.) don't close immediately.

log "Starting Aperio…"
node server.js
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo
  echo "[aperio] Server exited with code $EXIT_CODE — check bootstrap.log"
  echo "Press Enter to close…"
  read -r
fi