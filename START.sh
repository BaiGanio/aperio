#!/bin/bash
# ============================================================
# START.sh  —  Aperio-lite installer / launcher
#
# To test changes without touching your system, run DRY_RUN.sh.
# To add a new install flow: implement it in lib.sh as flow_*(),
# then call it here and in DRY_RUN.sh.
# ============================================================

SOURCE=${BASH_SOURCE[0]}
while [ -L "$SOURCE" ]; do
  _D=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$_D/$SOURCE
done
_SCRIPT_DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )

source "$_SCRIPT_DIR/how-to/assets/lib.sh"

# ── Runtime flags ─────────────────────────────────────────────
DRY_RUN=false
SERVER_STARTED=false
RECONFIGURE=false

# Load previously saved model (fast-path)
OLLAMA_MODEL=""
if [ -f "$INSTALL_LOG" ]; then
    _logged=$(grep "^OLLAMA_MODEL=" "$INSTALL_LOG" 2>/dev/null | cut -d= -f2- || true)
    [ -n "$_logged" ] && OLLAMA_MODEL="$_logged"
fi

# ── Error handling ────────────────────────────────────────────
set -e
trap 'die "Error on line $LINENO — press any key to exit..."; read -rn 1' ERR

cleanup() {
    if [ "$SERVER_STARTED" = true ]; then
        local pids
        pids=$(lsof -ti :$PORT 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
            ok "Server on port $PORT stopped."
        fi
    fi
}
trap cleanup EXIT SIGHUP SIGTERM SIGINT

# ── Main flow ─────────────────────────────────────────────────
flow_check_port

flow_fast_path || true     # returns 1 to continue, exits 0 on launch

if [ -z "$OLLAMA_MODEL" ]; then
    print_pre_install_manifest
    printf "  ${WH}${B}Ready to continue?${R}\n"
    read -rp "  Press [Enter] to start setup, or Ctrl-C to cancel... " _DUMMY
    printf "\n"
fi

flow_env_check
flow_hardware_analysis
flow_model_picker
flow_confirm_install

set +e  # don't exit on error past this point — always reach the final pause

flow_pull_models
flow_npm_install
flow_launch