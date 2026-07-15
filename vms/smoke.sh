#!/usr/bin/env bash
set -uo pipefail

ROOT="${1:-.}"
PORT="${VMTEST_PORT:-$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})") }"
PORT="${PORT// /}"
ROOT="$(cd "$ROOT" 2>/dev/null && pwd)" || { echo "✖ install directory not found" >&2; exit 1; }
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/aperio-vms-home.XXXXXX")"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_HOME"
}
trap cleanup EXIT INT TERM
pass() { printf '✔ %s\n' "$1"; }
fail() { printf '✖ %s\n' "$1" >&2; exit 1; }
run() { (cd "$ROOT" && HOME="$TMP_HOME" "$@"); }

cd "$ROOT" || fail "cannot enter $ROOT"
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$major" -ge 22 ] || fail "Node.js 22+ required (found ${major:-unknown})"
command -v npm >/dev/null 2>&1 || fail "npm is not available"
pass "toolchain: Node $(node --version), npm $(npm --version)"
[ -d node_modules ] || fail "node_modules is missing"
for module in better-sqlite3 sqlite-vec sharp; do
  run node --input-type=module -e "await import('$module')" || fail "native module failed to load: $module"
  pass "native module: $module"
done

mkdir -p "$ROOT/.sqlite"
if ! run env DB_BACKEND=sqlite SQLITE_PATH=.sqlite/vms.db npm run migrate:sqlite >/tmp/aperio-vms-migrate.$$.log 2>&1; then
  cat /tmp/aperio-vms-migrate.$$.log >&2
  rm -f /tmp/aperio-vms-migrate.$$.log
  fail "SQLite migrations failed"
fi
rm -f /tmp/aperio-vms-migrate.$$.log
[ -f "$ROOT/.sqlite/vms.db" ] || fail "migration did not create .sqlite/vms.db"
pass "SQLite migrations"

LOG="$ROOT/.sqlite/vms-server.log"
env HOME="$TMP_HOME" PORT="$PORT" HOST=127.0.0.1 DB_BACKEND=sqlite SQLITE_PATH=.sqlite/vms.db \
  EMBEDDING_PROVIDER=transformers APERIO_LITE=on APERIO_CONFIG_PRECEDENCE=env node server.js >"$LOG" 2>&1 &
SERVER_PID=$!
ready=0
for _ in $(seq 1 90); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat "$LOG" >&2
    fail "server exited before answering"
  fi
  if state="$(curl -fsS "http://127.0.0.1:${PORT}/api/bootstrap/state" 2>/dev/null)"; then
    printf '%s\n' "$state" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' || fail "bootstrap state was not valid JSON"
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { cat "$LOG" >&2; fail "no bootstrap response within 90 seconds"; }
pass "HTTP bootstrap state"
html="$(curl -fsS "http://127.0.0.1:${PORT}/setup.html")" || fail "setup.html was not served"
printf '%s' "$html" | grep -q '<html' || fail "setup.html is not HTML"
printf '%s' "$html" | grep -q 'setup' || fail "setup.html lacks setup markers"
pass "UI shell: /setup.html"
[ ! -e "$TMP_HOME/sqlite" ] || fail "runtime wrote outside install directory: $TMP_HOME/sqlite"
pass "runtime hygiene"
