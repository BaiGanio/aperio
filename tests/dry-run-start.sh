#!/bin/bash
# ============================================================
# DRY_RUN.sh  —  Simulates the full Aperio-lite setup flow.
#
# Nothing is installed, downloaded, or modified.
# To test a new flow: implement it in lib.sh as flow_*(),
# then add the call below — one line per flow.
# ============================================================

SOURCE=${BASH_SOURCE[0]}
while [ -L "$SOURCE" ]; do
  _D=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )
  SOURCE=$(readlink "$SOURCE")
  [[ $SOURCE != /* ]] && SOURCE=$_D/$SOURCE
done
_SCRIPT_DIR=$( cd -P "$( dirname "$SOURCE" )" >/dev/null 2>&1 && pwd )

source "$_SCRIPT_DIR/lib.sh"

# ── Dry-run flags ─────────────────────────────────────────────
DRY_RUN=true
SERVER_STARTED=false
RECONFIGURE=false
OLLAMA_MODEL=""   # always simulate first-time setup

# ── Error handling ────────────────────────────────────────────
set -e
trap 'die "Error on line $LINENO — press any key to exit..."; read -rn 1' ERR

cleanup() { true; }   # nothing to clean up in a dry run
trap cleanup EXIT SIGHUP SIGTERM SIGINT

# ── Simulated flow ────────────────────────────────────────────
# Mirror the call order in START.sh exactly.
# To test a new flow, add its flow_*() call here.

flow_check_port
print_pre_install_manifest
flow_env_check
flow_hardware_analysis
flow_model_picker
flow_confirm_install
flow_pull_models
flow_npm_install
flow_launch