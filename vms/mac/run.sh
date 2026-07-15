#!/usr/bin/env bash
set -uo pipefail

PRISTINE_VM="${VMTEST_MAC_PRISTINE_VM:-aperio-mac-pristine}"
RUN_VM="${VMTEST_MAC_RUN_VM:-aperio-mac-run}"
SHARE_NAME="${VMTEST_MAC_SHARE_NAME:-AperioVmtest}"
GUEST_STAGE="${VMTEST_MAC_GUEST_STAGE:-/Volumes/psf/AperioVmtest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/vms/out"
STAGE=""
LOG=""
status=1
clone_created=0

mkdir -p "$OUT"
LOG="$OUT/macos-${RUN_VM}-$(date +%Y%m%d-%H%M%S).log"

vm_exists() {
  prlctl list -a 2>/dev/null | awk '{print $NF}' | grep -Fxq "$1"
}

delete_run_vm() {
  if vm_exists "$RUN_VM"; then
    prlctl stop "$RUN_VM" --kill >>"$LOG" 2>&1 || true
    prlctl set "$RUN_VM" --shf-host-del "$SHARE_NAME" >>"$LOG" 2>&1 || true
    prlctl delete "$RUN_VM" --yes >>"$LOG" 2>&1 || true
  fi
}

cleanup() {
  trap - EXIT INT TERM
  {
    printf '\n--- guest log (best effort) ---\n'
    prlctl exec "$RUN_VM" /bin/bash -lc 'if [ -f /tmp/aperio-vmtest.log ]; then tail -300 /tmp/aperio-vmtest.log; fi' 2>&1 || true
    printf '\n--- stop and delete disposable clone ---\n'
    if [ "$clone_created" -eq 1 ]; then
      prlctl stop "$RUN_VM" --kill 2>&1 || true
      prlctl set "$RUN_VM" --shf-host-del "$SHARE_NAME" 2>&1 || true
      prlctl delete "$RUN_VM" --yes 2>&1 || true
    fi
  } >>"$LOG"
  rm -rf "$STAGE"
  printf 'VM log: %s\n' "$LOG" >&2
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v prlctl >/dev/null 2>&1 || { echo "prlctl is required (Parallels Desktop)" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "rsync is required" >&2; exit 1; }
[ "$PRISTINE_VM" != "$RUN_VM" ] || { echo "pristine and run VM names must differ" >&2; exit 1; }
vm_exists "$PRISTINE_VM" || { echo "pristine VM not found: $PRISTINE_VM" >&2; exit 1; }

# A killed invocation may leave the fixed-name clone behind. Remove only that
# disposable name; the pristine parent is never started or deleted.
delete_run_vm

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/aperio-vmtest-mac.XXXXXX")"
rsync -a --delete \
  --exclude node_modules/ --exclude var/ --exclude .sqlite/ --exclude vms/out/ \
  "$ROOT/" "$STAGE/"

clone_created=1
prlctl clone "$PRISTINE_VM" --name "$RUN_VM" --linked 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] || exit "$status"
prlctl set "$RUN_VM" --shf-host-add "$SHARE_NAME" --path "$STAGE" --mode ro --enable 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] || exit "$status"
prlctl start "$RUN_VM" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
[ "$status" -eq 0 ] || exit "$status"

ready=0
for _ in $(seq 1 "${VMTEST_MAC_READY_ATTEMPTS:-90}"); do
  if prlctl exec "$RUN_VM" /bin/true >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || { echo "macOS guest tools did not become ready" >&2; exit 1; }

prlctl exec "$RUN_VM" /bin/bash "$GUEST_STAGE/vms/mac/run-guest.sh" "$GUEST_STAGE" 2>&1 | tee -a "$LOG"
status=${PIPESTATUS[0]}
