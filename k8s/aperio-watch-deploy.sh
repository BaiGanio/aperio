#!/usr/bin/env bash
# aperio-watch-deploy.sh — pull git, build Docker image, redeploy to k3s.
#
# Called by the webhook receiver (aperio-webhook.service) whenever GitHub
# Actions sends a push notification. Idempotent: stores the last-deployed
# SHA in .last-deployed-sha so repeated calls skip redundant builds.
#
# Usage (manual test):
#   ./aperio-watch-deploy.sh
#
# Normal operation:
#   GitHub CI → webhook (port 9001) → this script

set -euo pipefail

# ---- Config ----------------------------------------------------------------
REPO_DIR="${REPO_DIR:-/home/pi/aperio}"
STATE_FILE="$REPO_DIR/.last-deployed-sha"
BRANCH="${WATCH_BRANCH:-main}"
NAMESPACE="${NAMESPACE:-aperio}"
KUBECTL="${KUBECTL:-kubectl}"
WEBHOOK_CONF_DIR="${WEBHOOK_CONF_DIR:-/home/pi/aperio-k3s}"
# ---------------------------------------------------------------------------

log() { echo "[$(date -Iseconds)] $*"; }

# ------------------------------------------------------------------
# 0. Validate prerequisites
# ------------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  log "ERROR: docker not found — install it first"
  exit 1
fi

if ! command -v "$KUBECTL" &>/dev/null; then
  log "ERROR: $KUBECTL not found"
  exit 1
fi

mkdir -p "$REPO_DIR" || { log "ERROR: cannot create repo dir $REPO_DIR"; exit 1; }
cd "$REPO_DIR"

# ------------------------------------------------------------------
# 1. Clone or pull the repo
# ------------------------------------------------------------------
if [ -d "$REPO_DIR/.git" ]; then
  log "Repo exists — fetching origin/$BRANCH ..."
  git fetch origin "$BRANCH" 2>&1 || { log "ERROR: git fetch failed"; exit 1; }
else
  log "Repo not found — cloning ..."
  git clone --depth 1 --branch "$BRANCH" \
    https://github.com/BaiGanio/aperio.git "$REPO_DIR" 2>&1 || { log "ERROR: git clone failed"; exit 1; }
  cd "$REPO_DIR"
fi

# ------------------------------------------------------------------
# 2. Compare SHA — skip if already deployed
# ------------------------------------------------------------------
REMOTE_SHA=$(git rev-parse "origin/$BRANCH" 2>/dev/null) || { log "ERROR: cannot resolve origin/$BRANCH"; exit 1; }
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

# Also check the state file for the last deployed SHA
LAST_SHA=""
if [ -f "$STATE_FILE" ]; then
  LAST_SHA=$(cat "$STATE_FILE")
fi

# If both persisted SHA and current HEAD match remote, skip
if [ "$REMOTE_SHA" = "$LAST_SHA" ] && [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  log "No new commits. HEAD: ${REMOTE_SHA:0:8}"
  exit 0
fi

log "NEW COMMITS: ${LAST_SHA:0:8} → ${REMOTE_SHA:0:8}"

# ------------------------------------------------------------------
# 3. Pull latest code
# ------------------------------------------------------------------
log "Checking out $BRANCH ..."
git checkout "$BRANCH" 2>&1
git pull origin "$BRANCH" 2>&1

# ------------------------------------------------------------------
# 4. Build the Docker image (native ARM64 on the Pi)
# ------------------------------------------------------------------
log "Installing production dependencies ..."
npm ci --omit=dev 2>&1 || npm install --omit=dev 2>&1

log "Building aperio:local (this will take a minute on a Pi) ..."
docker build -f docker/Dockerfile -t aperio:local . 2>&1

# ------------------------------------------------------------------
# 5. Import image into k3s containerd
# ------------------------------------------------------------------
log "Importing image into k3s containerd ..."
docker save aperio:local | sudo k3s ctr images import - 2>&1

# ------------------------------------------------------------------
# 6. Apply any manifest changes
# ------------------------------------------------------------------
if [ -d "$WEBHOOK_CONF_DIR" ]; then
  log "Applying Kubernetes manifests from $WEBHOOK_CONF_DIR ..."
  # We don't re-apply secrets here — they're managed separately
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/namespace.yaml" 2>/dev/null || true
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/postgres.yaml" 2>/dev/null || true
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/aperio.yaml" 2>/dev/null || true
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/ingress.yaml" 2>/dev/null || true
fi

# ------------------------------------------------------------------
# 7. Rollout restart
# ------------------------------------------------------------------
log "Rolling out restart for deploy/aperio ..."
"$KUBECTL" -n "$NAMESPACE" rollout restart deploy/aperio 2>&1

log "Waiting for rollout to complete ..."
if "$KUBECTL" -n "$NAMESPACE" rollout status deploy/aperio --timeout=180s 2>&1; then
  log "Rollout successful."
else
  log "WARNING: rollout did not complete in time. Check with: kubectl -n $NAMESPACE get pods"
fi

# ------------------------------------------------------------------
# 8. Run database migrations
# ------------------------------------------------------------------
log "Running database migrations ..."
if "$KUBECTL" -n "$NAMESPACE" exec deploy/aperio -- node db/migrate.js 2>&1; then
  log "Migrations completed successfully."
else
  log "WARNING: migrations failed. Check with: kubectl -n $NAMESPACE logs deploy/aperio"
fi

# ------------------------------------------------------------------
# 9. Record the deployed SHA
# ------------------------------------------------------------------
echo "$REMOTE_SHA" > "$STATE_FILE"
log "Deployed $REMOTE_SHA — recorded to $STATE_FILE"
log "Done."
