#!/bin/bash
# ============================================================
# uninstall.sh  —  remove what Aperio-lite installed into this folder.
#
# Removes: the vendored Ollama engine, node_modules, local database + logs,
# and the Desktop launcher. Optionally removes the AI model Aperio downloaded.
# Leaves alone: Node.js/nvm (you may use it elsewhere) and, on Linux, a
# system-wide Ollama (remove that yourself if you want).
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

# 2. Stop only OUR vendored Ollama (never touches a system Ollama).
if pkill -f "$DIR/vendor/ollama/ollama" 2>/dev/null; then ok "Stopped the vendored Ollama engine."; fi

# 3. Remove the contained pieces.
[ -d node_modules ] && { rm -rf node_modules && ok "Removed node_modules/"; }
[ -d vendor ]       && { rm -rf vendor       && ok "Removed vendor/ (Ollama engine)"; }

# 4. Desktop launcher.
if [ "$OS" = "Darwin" ]; then
    rm -f "$HOME/Desktop/Aperio.command" 2>/dev/null && ok "Removed the Desktop launcher." || true
elif [ "$OS" = "Linux" ]; then
    rm -f "$HOME/Desktop/Aperio.desktop" 2>/dev/null && ok "Removed the Desktop launcher." || true
fi

# 5. Offer to remove the downloaded AI model (only the one Aperio pulled).
if [ -n "$MODEL" ] && command -v ollama >/dev/null 2>&1; then
    printf "\n"
    read -rp "  Also delete the downloaded AI model '${MODEL}' (frees several GB)? (y/n): " -n 1 REPLY; printf "\n"
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ollama rm "$MODEL" >/dev/null 2>&1 && ok "Removed model $MODEL." || warn "Could not remove $MODEL (is Ollama running?)."
    else
        info "Kept the model — remove it later with: ollama rm $MODEL"
    fi
fi

# 6. App data (logs, database, bootstrap lock, sessions). Do this last.
[ -d var ]     && { rm -rf var     && ok "Removed var/ (logs, settings, sessions)"; }
[ -d .sqlite ] && { rm -rf .sqlite && ok "Removed .sqlite/ (memory database)"; }

# 7. What we deliberately left behind.
printf "\n"
warn "Left in place (remove yourself if you want):"
if [ "$NODE_PREEXISTING" = "false" ]; then
    printf "  ${D}    • Node.js (Aperio installed it via nvm in ~/.nvm) — kept in case you use it elsewhere${R}\n"
else
    printf "  ${D}    • Node.js — you already had it; untouched${R}\n"
fi
[ "$OS" = "Linux" ] && printf "  ${D}    • System Ollama — remove with your package manager if you installed it only for Aperio${R}\n"
printf "\n"
ok "Aperio-lite uninstalled."
printf "  ${D}Finally, drag this folder to the Trash to remove Aperio itself.${R}\n\n"
