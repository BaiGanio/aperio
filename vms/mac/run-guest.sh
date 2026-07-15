#!/usr/bin/env bash
set -uo pipefail

STAGE="${1:?guest stage path is required}"
INSTALL_DIR="${HOME}/aperio-vmtest-install"
LOG=/tmp/aperio-vmtest.log
exec > >(tee "$LOG") 2>&1

fail() { printf '✖ %s\n' "$1" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || fail "macOS guest required"
[ "$(uname -m)" = "arm64" ] || fail "ARM64 macOS guest required"
[ -r "$STAGE/.github/lite/install.sh" ] || fail "staged installer is missing"
[ -r "$STAGE/vms/smoke.sh" ] || fail "staged smoke contract is missing"

rm -rf "$INSTALL_DIR"
repo_branch="$(git -C "$STAGE" branch --show-current 2>/dev/null || true)"
[ -n "$repo_branch" ] || fail "staged checkout must have a named git branch"

APERIO_HOME="$INSTALL_DIR" \
APERIO_REPO_URL="file://$STAGE" \
APERIO_BRANCH="$repo_branch" \
  bash "$STAGE/.github/lite/install.sh" || fail "one-liner installer failed"

cd "$INSTALL_DIR" || fail "installed directory is missing"
npm install --prefer-offline --no-audit --no-fund || fail "guest dependency install failed"
bash "$STAGE/vms/smoke.sh" "$INSTALL_DIR" || fail "shared smoke contract failed"
printf '✔ macOS ARM64 guest install and smoke\n'
