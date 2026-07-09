#!/bin/bash
# ============================================================
# uninstall.sh  —  remove what Aperio-lite installed into this folder.
#
# Removes: the vendored llama.cpp engine, node_modules, local database + logs
# (which includes the downloaded AI model — it lives under var/models by
# default), and the Desktop launcher.
# Leaves alone: Node.js/nvm (you may use it elsewhere).
# ============================================================

set -uo pipefail
DIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
cd "$DIR"

PORT=31337
OS="$(uname -s)"

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'; CY=$'\033[96m'; GR=$'\033[92m'; YL=$'\033[93m'; RD=$'\033[91m'
else R=''; B=''; D=''; CY=''; GR=''; YL=''; RD=''; fi
ok()   { printf "  ${GR}${B}✔${R}  %s\n" "$*"; }
info() { printf "  ${CY}●${R}  %s\n"      "$*"; }
warn() { printf "  ${YL}${B}⚠${R}  %s\n" "$*"; }

printf "\n  ${B}${RD}┌──────────────────────────────────────┐${R}\n"
printf   "  ${B}${RD}│   ${R}${B}Uninstall Aperio-lite${R}             ${B}${RD}│${R}\n"
printf   "  ${B}${RD}└──────────────────────────────────────┘${R}\n\n"
printf "  This removes Aperio's engine, dependencies, database and logs from:\n"
printf "  ${D}  %s${R}\n\n" "$DIR"
read -rp "  Continue? (y/n): " -n 1 REPLY; printf "\n\n"
[[ $REPLY =~ ^[Yy]$ ]] || { info "Cancelled — nothing was removed."; exit 0; }

# Capture facts from the install ledger BEFORE we delete var/: the model name
# (to offer removal) and whether Node pre-existed (for honest final messaging).
MODEL=""; NODE_PREEXISTING=""
if [ -f var/bootstrap.lock ]; then
    MODEL=$(grep -o '"model"[^,}]*' var/bootstrap.lock 2>/dev/null | sed 's/.*"model"[^"]*"\([^"]*\)".*/\1/' || true)
    NODE_PREEXISTING=$(grep -o '"nodePreexisting"[^,}]*' var/bootstrap.lock 2>/dev/null | grep -o 'true\|false' || true)
fi

# 1. Stop the running server (if any).
pids=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null || true; ok "Stopped the Aperio server (port $PORT)."; fi

# 2. Stop only OUR vendored llama.cpp (never touches a system install).
if pkill -f "$DIR/vendor/llamacpp/llama-server" 2>/dev/null; then ok "Stopped the vendored llama.cpp engine."; fi

# 3. Remove the contained pieces.
[ -d node_modules ] && { rm -rf node_modules && ok "Removed node_modules/"; }
[ -d vendor ]       && { rm -rf vendor       && ok "Removed vendor/ (llama.cpp engine)"; }

# 4. Desktop launcher.
if [ "$OS" = "Darwin" ]; then
    rm -f "$HOME/Desktop/Aperio.command" 2>/dev/null && ok "Removed the Desktop launcher." || true
elif [ "$OS" = "Linux" ]; then
    rm -f "$HOME/Desktop/Aperio.desktop" 2>/dev/null && ok "Removed the Desktop launcher." || true
fi

# 5. Offer to keep the downloaded AI model. It lives under var/models
# (LLAMA_CACHE) by default — no separate per-model removal command like
# Ollama had, so "keep" means moving it out before var/ is wiped below.
KEEP_MODEL_DIR=""
if [ -n "$MODEL" ] && [ -d var/models ]; then
    printf "\n"
    read -rp "  Also delete the downloaded AI model '${MODEL}' (frees several GB)? (y/n): " -n 1 REPLY; printf "\n"
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        KEEP_MODEL_DIR=$(mktemp -d)
        mv var/models "$KEEP_MODEL_DIR/models"
        info "Kept the downloaded model — will restore it after cleanup."
    fi
fi

# 6. App data (logs, database, bootstrap lock, sessions). Do this last.
[ -d var ]     && { rm -rf var     && ok "Removed var/ (logs, settings, sessions)"; }
[ -d .sqlite ] && { rm -rf .sqlite && ok "Removed .sqlite/ (memory database)"; }

if [ -n "$KEEP_MODEL_DIR" ]; then
    mkdir -p var
    mv "$KEEP_MODEL_DIR/models" var/models
    rmdir "$KEEP_MODEL_DIR" 2>/dev/null || true
    ok "Restored the kept model to var/models/"
fi

# 7. What we deliberately left behind.
printf "\n"
warn "Left in place (remove yourself if you want):"
if [ "$NODE_PREEXISTING" = "false" ]; then
    printf "  ${D}    • Node.js (Aperio installed it via nvm in ~/.nvm) — kept in case you use it elsewhere${R}\n"
else
    printf "  ${D}    • Node.js — you already had it; untouched${R}\n"
fi
printf "\n"
ok "Aperio-lite uninstalled."
printf "  ${D}Finally, drag this folder to the Trash to remove Aperio itself.${R}\n\n"
