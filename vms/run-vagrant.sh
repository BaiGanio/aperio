#!/usr/bin/env bash
set -uo pipefail

PROFILE="${1:-}"
case "$PROFILE" in
  ubuntu-lite|debian-dev) ;;
  *) echo "usage: $0 ubuntu-lite|debian-dev" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/vms/out"
mkdir -p "$OUT"
LOG="$OUT/linux-${PROFILE}-$(date +%Y%m%d-%H%M%S).log"
export VAGRANT_DEFAULT_PROVIDER=parallels
export VAGRANT_CWD="$ROOT/vms"
export APERIO_BRANCH="${APERIO_BRANCH:-$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)}"

status=1
cleanup() {
  trap - EXIT INT TERM
  {
    printf '\n--- guest log (best effort) ---\n'
    vagrant ssh "$PROFILE" -c 'for f in /tmp/aperio-vmtest.log /root/aperio/var/install/*.log /home/vagrant/aperio/var/install/*.log; do [ -f "$f" ] || continue; printf "\\n--- %s ---\\n" "$f"; tail -200 "$f"; done' 2>&1 || true
    printf '\n--- destroy ---\n'
    vagrant destroy -f "$PROFILE" 2>&1 || true
  } >>"$LOG"
  printf 'VM log: %s\n' "$LOG" >&2
  exit "$status"
}
trap cleanup EXIT INT TERM

if ! vagrant plugin list | grep -q '^vagrant-parallels'; then
  echo "vagrant-parallels plugin is required" >&2
  exit 1
fi

set -o pipefail
vagrant up "$PROFILE" --provider=parallels --provision 2>&1 | tee "$LOG"
status=${PIPESTATUS[0]}
