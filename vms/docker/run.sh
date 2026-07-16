#!/usr/bin/env bash
set -uo pipefail

IMAGE=""
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/vms/out"
CONTAINER="aperio-vmtest-$$"
VOLUME="aperio-vmtest-$$"
PORT="${VMTEST_DOCKER_PORT:-}"
LOG=""
BOOTSTRAP_JSON="/tmp/aperio-docker-bootstrap.$$.json"
status=1

usage() {
  printf 'usage: %s --image IMAGE\n' "${0##*/}" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      IMAGE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[ -n "$IMAGE" ] || { usage; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

is_registry_reference() {
  case "$1" in
    ghcr.io/*|docker.io/*|index.docker.io/*|quay.io/*|registry.*/*|localhost:*/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Fail fast on a missing LOCAL image BEFORE creating any resources (the tee'd
# log file, the reserved host port, the cleanup trap). A local tag is never
# pulled, so if it is not already present there is nothing to do — and rejecting
# here, before the `exec … 2>&1` redirect below folds every stream onto stdout,
# keeps the message on stderr where callers (and the smoke test) expect it.
if ! is_registry_reference "$IMAGE"; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "local image is missing (no pull attempted): $IMAGE" >&2
    exit 1
  }
fi

mkdir -p "$OUT"
LOG="$OUT/docker-$(date +%Y%m%d-%H%M%S)-$$.log"
exec > >(tee "$LOG") 2>&1

choose_port() {
  if [ -n "$PORT" ]; then
    case "$PORT" in *[!0-9]*|'') return 1 ;; esac
    [ "$PORT" -ne 31337 ] || return 1
    return 0
  fi
  PORT="$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})" 2>/dev/null)" || return 1
  [ -n "$PORT" ] && [ "$PORT" -ne 31337 ]
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  printf '\n--- docker inspect (best effort) ---\n'
  docker inspect "$CONTAINER" 2>&1 || true
  printf '\n--- docker logs (best effort) ---\n'
  docker logs "$CONTAINER" 2>&1 || true
  printf '\n--- cleanup ---\n'
  docker rm -f "$CONTAINER" 2>&1 || true
  docker volume rm "$VOLUME" 2>&1 || true
  rm -f "$BOOTSTRAP_JSON"
  printf 'Docker log: %s\n' "$LOG" >&2
  exit "$status"
}
trap cleanup EXIT INT TERM

choose_port || { echo "choose a valid non-default host port" >&2; exit 1; }
printf 'Image: %s\nHost port: %s\n' "$IMAGE" "$PORT"

# Registry references are pulled here (they need the log/port context set up
# above); a missing LOCAL image was already rejected before any of that.
if is_registry_reference "$IMAGE"; then
  docker pull "$IMAGE" || { echo "could not pull registry image: $IMAGE" >&2; exit 1; }
fi

printf '\n--- image metadata ---\n'
docker image inspect --format 'id={{.Id}}\narchitecture={{.Architecture}}\nos={{.Os}}\nrepo_digests={{json .RepoDigests}}' "$IMAGE"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$CONTAINER" \
  --mount "type=volume,source=$VOLUME,target=/app/var" \
  -e DB_BACKEND=sqlite \
  -e SQLITE_PATH=/app/var/vms.db \
  -e EMBEDDING_PROVIDER=transformers \
  -e APERIO_LITE=on \
  -e APERIO_CONFIG_PRECEDENCE=env \
  -p "127.0.0.1:${PORT}:31337" \
  "$IMAGE"

ready=0
for _ in $(seq 1 "${VMTEST_DOCKER_READY_ATTEMPTS:-90}"); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/bootstrap/state" >"$BOOTSTRAP_JSON" 2>/dev/null; then
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$BOOTSTRAP_JSON"
    ready=1
    break
  fi
  sleep 1
done
rm -f "$BOOTSTRAP_JSON"
[ "$ready" -eq 1 ] || { echo "container did not answer bootstrap state" >&2; exit 1; }
printf '✔ HTTP bootstrap state\n'

html="$(curl -fsS "http://127.0.0.1:${PORT}/setup.html")" || { echo "setup page was not served" >&2; exit 1; }
grep -q '<html' <<<"$html" || { echo "setup page is not HTML" >&2; exit 1; }
grep -q 'setup' <<<"$html" || { echo "setup page lacks setup markers" >&2; exit 1; }
printf '✔ UI shell: /setup.html\n'
status=0
