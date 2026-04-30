#!/usr/bin/env bash

MIN_NODE_MAJOR=18

# Always run from the directory this file lives in
cd "$(dirname "$0")"

LOG_FILE="bootstrap.log"

log() { echo "[aperio] $*"; }
die() {
  echo ""
  echo "[aperio] ERROR: $*"
  echo "[aperio] Check bootstrap.log for details."
  echo ""
  echo "Press Enter to close…"
  read -r
  exit 1
}

echo ""
echo "  ╭─────────────────────────╮"
echo "  │       Aperio            │"
echo "  ╰─────────────────────────╯"
echo ""

# ── 1. Source nvm if present, then check for node ────────────────────────────

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -f "$NVM_DIR/nvm.sh" ]; then
  source "$NVM_DIR/nvm.sh"
fi

needs_node=false

if command -v node >/dev/null 2>&1; then
  major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2>/dev/null || echo "0")
  if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
    log "Node.js $(node -v) — OK"
  else
    log "Node.js $(node -v) too old (need >= $MIN_NODE_MAJOR) — upgrading…"
    needs_node=true
  fi
else
  log "Node.js not found — installing…"
  needs_node=true
fi

# ── 2. Install node via nvm if needed ────────────────────────────────────────

if [ "$needs_node" = true ]; then
  if [ ! -f "$NVM_DIR/nvm.sh" ]; then
    log "Downloading nvm…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh \
      | bash >> "$LOG_FILE" 2>&1 \
      || die "nvm install failed"
    source "$NVM_DIR/nvm.sh"
  fi

  log "Installing Node.js LTS — this takes a minute, hang tight…"
  nvm install --lts >> "$LOG_FILE" 2>&1 || die "node install failed"
  nvm use --lts     >> "$LOG_FILE" 2>&1
  log "Node.js $(node -v) ready"
fi

# ── 3. npm install if node_modules missing ────────────────────────────────────

if [ ! -d "node_modules" ]; then
  log "Installing npm dependencies…"
  npm install --prefer-offline --no-audit --no-fund >> "$LOG_FILE" 2>&1 \
    || die "npm install failed"
fi

# ── 4. Start the server ───────────────────────────────────────────────────────

log "Starting Aperio — opening browser…"
echo ""
node server.js

# ── 5. Keep terminal open if server exits unexpectedly ───────────────────────

echo ""
echo "[aperio] Server stopped (exit code $?)."
echo "Press Enter to close…"
read -r
