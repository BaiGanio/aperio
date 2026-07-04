#!/bin/bash
# ============================================================
# launch-hidden.sh  —  start Aperio with NO terminal window (macOS + Linux).
#
# Invoked by the Desktop "Aperio" launcher on SECOND and later runs, once the
# first-run setup (via START.sh) has already installed Node, deps and the model.
# It starts the server detached and opens your browser, then returns at once.
#
# To stop Aperio: click "Quit Aperio" in the app, or just close the browser tab
# and the server auto-stops after the idle timeout (~180 s).
# ============================================================

cd "$(dirname "$0")" || exit 1
URL="http://localhost:31337"

open_url() {
    if   command -v open      >/dev/null 2>&1; then open "$1"
    elif command -v xdg-open  >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
    fi
}

# Already running (icon double-clicked twice)? Just focus the browser.
if curl -s "$URL" >/dev/null 2>&1; then open_url "$URL"; exit 0; fi

# Make Node (nvm) and the vendored Ollama discoverable in this bare environment.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$PWD/vendor/ollama:$PATH"

mkdir -p var/install
# Start the server detached so this script (and the launcher app) can exit.
nohup npm run start:lite >> var/install/server.log 2>&1 &

# Open the browser once the server answers — backgrounded so we return now.
( for _ in $(seq 1 60); do curl -s "$URL" >/dev/null 2>&1 && { open_url "$URL"; break; }; sleep 1; done ) &

exit 0
