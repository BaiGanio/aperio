#!/usr/bin/env bash
set -uo pipefail

VM_NAME="${VMTEST_WINDOWS_VM:-aperio-win-test}"
SNAPSHOT_NAME="${VMTEST_WINDOWS_SNAPSHOT:-clean}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/vms/out"
STAGE=""
LOG=""
status=1

mkdir -p "$OUT"
LOG="$OUT/windows-${VM_NAME}-$(date +%Y%m%d-%H%M%S).log"

cleanup() {
  trap - EXIT INT TERM
  {
    printf '\n--- guest log (best effort) ---\n'
    prlctl exec "$VM_NAME" powershell.exe -NoProfile -NonInteractive -Command \
      'if (Test-Path C:\aperio-vmtest.log) { Get-Content C:\aperio-vmtest.log -Tail 300 }' 2>&1 || true
    printf '\n--- stop ---\n'
    prlctl stop "$VM_NAME" --kill 2>&1 || true
    printf '\n--- restore snapshot ---\n'
    if [ -n "${CLEAN_SNAPSHOT_ID:-}" ]; then
      prlctl snapshot-switch "$VM_NAME" -i "$CLEAN_SNAPSHOT_ID" --skip-resume 2>&1 || true
    fi
    if [ -n "$STAGE" ]; then
      prlctl set "$VM_NAME" --shf-host-del AperioVmtest 2>&1 || true
      rm -rf "$STAGE"
    fi
  } >>"$LOG"
  printf 'VM log: %s\n' "$LOG" >&2
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v prlctl >/dev/null 2>&1 || { echo "prlctl is required (Parallels Pro/Business)" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "rsync is required" >&2; exit 1; }

snapshot_list="$(prlctl snapshot-list "$VM_NAME" 2>&1)" || {
  printf '%s\n' "$snapshot_list" >&2
  exit 1
}
CLEAN_SNAPSHOT_ID="${VMTEST_WINDOWS_SNAPSHOT_ID:-$(printf '%s\n' "$snapshot_list" | awk -v name="$SNAPSHOT_NAME" '$0 ~ name { print $1; exit }')}"
[ -n "$CLEAN_SNAPSHOT_ID" ] || { echo "snapshot not found: $SNAPSHOT_NAME" >&2; exit 1; }

STAGE="$(mktemp -d "$HOME/aperio-vmtest-stage.XXXXXX")"
rsync -a --delete \
  --exclude node_modules/ --exclude var/ --exclude .sqlite/ --exclude vms/out/ \
  "$ROOT/" "$STAGE/"
GUEST_STAGE="${VMTEST_WINDOWS_GUEST_STAGE:-C:\\Mac\\Home${STAGE#/Users}}"

prlctl snapshot-switch "$VM_NAME" -i "$CLEAN_SNAPSHOT_ID" --skip-resume 2>&1 | tee "$LOG"
prlctl set "$VM_NAME" --shf-host-add AperioVmtest --path "$STAGE" --mode ro --enable 2>&1 | tee -a "$LOG"
prlctl start "$VM_NAME" 2>&1 | tee -a "$LOG"

ready=0
for _ in $(seq 1 60); do
  if prlctl exec "$VM_NAME" cmd.exe /c exit >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { echo "Windows guest tools did not become ready" >&2; exit 1; }

prlctl exec "$VM_NAME" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -Command "& '$GUEST_STAGE\\vms\\win\\run-guest.ps1' '$GUEST_STAGE'" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
