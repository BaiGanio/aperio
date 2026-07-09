#!/usr/bin/env bash
# aperio-watch-deploy.sh — pull new image from ghcr.io and redeploy to k3s.
#
# Called by the webhook receiver (aperio-webhook.service) after GitHub CI
# builds and pushes the ARM64 image to ghcr.io. This script just applies
# manifest changes, triggers a rollout (which pulls the new image), and
# runs migrations.
#
# Usage (manual test):
#   ./aperio-watch-deploy.sh

set -euo pipefail

# ---- Config ----------------------------------------------------------------
NAMESPACE="${NAMESPACE:-aperio}"
KUBECTL="${KUBECTL:-kubectl}"
WEBHOOK_CONF_DIR="${WEBHOOK_CONF_DIR:-/home/pi/aperio-k3s}"
# ---------------------------------------------------------------------------

log() { echo "[$(date -Iseconds)] $*"; }

# ------------------------------------------------------------------
# 0. Validate prerequisites
# ------------------------------------------------------------------
if ! command -v "$KUBECTL" &>/dev/null; then
  log "ERROR: $KUBECTL not found"
  exit 1
fi

# ------------------------------------------------------------------
# 1. Apply any manifest changes
# ------------------------------------------------------------------
if [ -d "$WEBHOOK_CONF_DIR" ]; then
  log "Applying Kubernetes manifests from $WEBHOOK_CONF_DIR ..."
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/namespace.yaml" 2>/dev/null || true
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/postgres.yaml" 2>/dev/null || true
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/aperio.yaml" 2>/dev/null || true
  "$KUBECTL" apply -f "$WEBHOOK_CONF_DIR/ingress.yaml" 2>/dev/null || true
fi

# ------------------------------------------------------------------
# 2. Rollout restart — k3s pulls the new ghcr.io image
# ------------------------------------------------------------------
log "Rolling out restart for deploy/aperio ..."
"$KUBECTL" -n "$NAMESPACE" rollout restart deploy/aperio 2>&1

log "Waiting for rollout to complete ..."
if "$KUBECTL" -n "$NAMESPACE" rollout status deploy/aperio --timeout=180s 2>&1; then
  log "Rollout successful — new image pulled and running."
else
  log "WARNING: rollout did not complete in time. Check with: kubectl -n $NAMESPACE get pods"
fi

# ------------------------------------------------------------------
# 3. Run database migrations
# ------------------------------------------------------------------
log "Running database migrations ..."
if "$KUBECTL" -n "$NAMESPACE" exec deploy/aperio -- node db/migrate.js 2>&1; then
  log "Migrations completed successfully."
else
  log "WARNING: migrations failed. Check with: kubectl -n $NAMESPACE logs deploy/aperio"
fi

log "Done."
