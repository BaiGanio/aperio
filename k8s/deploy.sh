#!/usr/bin/env bash
# deploy.sh — apply all Aperio k3s manifests in order.
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Or apply a single file:
#   kubectl apply -f aperio.yaml

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBECTL="${KUBECTL:-kubectl}"

echo "=== Aperio k3s deploy ==="
echo "Using kubectl: $(command -v "$KUBECTL")"
echo

apply() {
  local file="$1"
  echo "→ Applying $file ..."
  "$KUBECTL" apply -f "$SCRIPT_DIR/$file"
}

# Order matters: namespace first, then secrets, then infrastructure, then app.
apply namespace.yaml
apply secrets.yaml
apply configmap.yaml
apply postgres.yaml
# Optional — uncomment if you need external DB access:
# apply postgres-nodeport.yaml

echo
echo "→ Waiting for PostgreSQL to be ready..."
"$KUBECTL" -n aperio wait --for=condition=ready pod -l app=postgres --timeout=300s

apply aperio.yaml
apply ingress.yaml

echo
echo "→ Waiting for Aperio to be ready..."
"$KUBECTL" -n aperio wait --for=condition=ready pod -l app=aperio --timeout=120s

echo
echo "=== Deploy complete ==="
echo
"$KUBECTL" -n aperio get pods,svc,ingressroute
echo
echo "Port-forward to test:  kubectl -n aperio port-forward svc/aperio 31337:31337"
echo "Ingress (if DNS set):  http://aperio.local"
echo
echo "Run migrations:"
echo "  # Build the migration image or exec into the pod:"
echo "  kubectl -n aperio exec deploy/aperio -- node db/migrate.js"
echo
echo "First-run setup:"
echo "  # Aperio's bootstrap wizard runs on first request. Open http://aperio.local"
