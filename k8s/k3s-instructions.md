# Aperio on k3s (Raspberry Pi 5) — Deployment Guide

> Deploy Aperio to your local k3s cluster running on a Raspberry Pi 5.
> Part of the [k3s-pi5](https://github.com/BaiGanio/aperio) infrastructure.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Manifests Overview](#3-manifests-overview)
4. [Initial Deploy on the Pi](#4-initial-deploy-on-the-pi)
5. [Connect via Ingress](#5-connect-via-ingress)
6. [CI/CD — Automatic Deploy from GitHub](#6-cicd---automatic-deploy-from-github)
   - [Pi-side: Webhook Setup](#61-pi-side-webhook-setup)
   - [GitHub-side: Workflow Secrets](#62-github-side-workflow-secrets)
   - [GitHub-side: The Workflow](#63-github-side-the-workflow)
7. [Manual Deploy (no webhook)](#7-manual-deploy-no-webhook)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Raspberry Pi 5 (ARM64, 8 GB)                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  k3s (lightweight Kubernetes)                        │  │
│  │                                                      │  │
│  │  ┌──────────────┐ ┌──────────────┐                  │  │
│  │  │  postgres    │ │   aperio     │                  │  │
│  │  │  StatefulSet │ │  Deployment  │                  │  │
│  │  │  :5432┬┘     │ │  :31337      │                  │  │
│  │  │  svc:8008    │ │  svc:31337   │                  │  │
│  │  │    pgvector  │ │  Node.js    │                  │  │
│  │  └──────┬───────┘ └──────┬──────┘                  │  │
│  │         │  aperio DB     │                          │  │
│  │         └────────────────┘                          │  │
│  │                                                      │  │
│  │  ┌────────────────────────────────────────────┐      │  │
│  │  │  Traefik Ingress (built into k3s)          │      │  │
│  │  │  aperio.local → aperio:31337                │      │  │
│  │  └────────────────────────────────────────────┘      │  │
│  │                                                      │  │
│  │  ┌────────────────────────────────────────────┐      │  │
│  │  │  Webhook Receiver (port 9001)              │      │  │
│  │  │  GitHub → POST → aperio-watch-deploy.sh   │      │  │
│  │  │  → git pull → docker build → rollout       │      │  │
│  │  └────────────────────────────────────────────┘      │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Port mapping for PostgreSQL

The Aperio Postgres uses **port 8008** on the Kubernetes Service level to avoid
collisions with any other Postgres in the cluster (e.g. the bgapi Postgres on
port 5432).

```
Postgres container:       5432  (internal)
Kubernetes Service:       8008  (in-cluster DNS)
NodePort (external):     30808  (host → cluster)
```

The Aperio app connects to `postgres.aperio.svc.cluster.local:8008`.

---

## 2. Prerequisites

- Raspberry Pi 5 with **64-bit OS** (Raspberry Pi OS Lite or Ubuntu Server)
- **k3s** installed and running
- `kubectl` configured to reach the cluster
- **Docker** installed on the Pi (for building images)
- `node` and `npm` on the Pi (for dependency install before Docker build)
- Access to [BaiGanio/aperio](https://github.com/BaiGanio/aperio) on GitHub

---

## 3. Manifests Overview

All Kubernetes manifests live in `aperio-k3s/` on the Pi (or in this repo
under `k8s/`). Copy them to the Pi before deploying.

| File | What it creates | Port |
|------|----------------|------|
| `namespace.yaml` | `aperio` namespace | — |
| `secrets.yaml` | Postgres password + API key secrets | — |
| `postgres.yaml` | **StatefulSet** (pgvector/pg16, 5Gi PVC) + **headless Service** | container: 5432, svc: **8008** |
| `postgres-nodeport.yaml` | **NodePort** (optional, for external DB access) | host: **30808** → svc: **8008** |
| `aperio.yaml` | **Deployment** (1 replica, 1Gi mem) + **ClusterIP Service** + PVC | container: **31337**, svc: **31337** |
| `ingress.yaml` | **Traefik IngressRoute** (k3s-native) | host: **80** → svc: **31337** |
| `deploy.sh` | Applies everything in order + waits for readiness | — |

### CI/CD files

| File | What it does |
|------|-------------|
| `.github/workflows/cd.k3s-deploy.yml` | GitHub Actions — on push to `main`, notifies Pi via webhook |
| `aperio-webhook.conf` | Webhook receiver config (HMAC-signed) |
| `aperio-webhook.service` | systemd service for the webhook (port **9001**) |
| `aperio-watch-deploy.sh` | Build + deploy script (git pull → docker build → k3s import → rollout) |

---

## 4. Initial Deploy on the Pi

### 4.1 Copy manifests to the Pi

```bash
# On your Mac:
scp -r k8s/* pi@<pi-ip>:/home/pi/aperio-k3s/
```

### 4.2 Set the Postgres password

```bash
# On your Mac (or any machine):
echo -n "YourStrongPassword" | base64
# → e.g. WW91clN0cm9uZ1Bhc3N3b3Jk
```

Edit `secrets.yaml` on the Pi and replace `YXBlcmlvX3NlY3JldA==` with your
real base64-encoded password. Set any API keys you'll need (Anthropic, etc.).

### 4.3 Build the Docker image on the Pi

```bash
# On the Pi:
cd /home/pi
git clone --depth 1 https://github.com/BaiGanio/aperio.git
cd aperio
npm ci --omit=dev
docker build -f docker/Dockerfile -t aperio:local .
docker save aperio:local | sudo k3s ctr images import -
```

### 4.4 Deploy

```bash
# On the Pi:
cd /home/pi/aperio-k3s
chmod +x deploy.sh
./deploy.sh
```

### 4.5 Run database migrations

```bash
kubectl -n aperio exec deploy/aperio -- node db/migrate.js
```

### 4.6 Verify

```bash
kubectl -n aperio get pods,svc,ingressroute
```

Expected output:

```
NAME                           READY   STATUS    RESTARTS   AGE
pod/aperio-xxxxxxxxx-yyyyy     1/1     Running   0          1m
pod/postgres-0                 1/1     Running   0          2m

NAME                         TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
service/aperio               ClusterIP   10.43.x.x      <none>        31337/TCP   1m
service/postgres             ClusterIP   None           <none>        8008/TCP   2m

NAME                                        AGE
ingressroute.traefik.io/aperio              1m
```

---

## 5. Connect via Ingress

### 5.1 Add DNS

On your laptop, add to `/etc/hosts`:

```
<raspberry-pi-ip>  aperio.local
```

### 5.2 Open in browser

[http://aperio.local](http://aperio.local) → Aperio's first-run setup wizard.

### 5.3 Port-forward (if no ingress DNS yet)

```bash
kubectl -n aperio port-forward svc/aperio 31337:31337
```

Open [http://localhost:31337](http://localhost:31337).

---

## 6. CI/CD — Automatic Deploy from GitHub

The pipeline works in two halves:

1. **GitHub**: on push to `main`, a workflow sends an HMAC-signed POST to your Pi.
2. **Pi**: the `webhook` receiver validates the signature and runs the deploy script.

### 6.1 Pi-side: Webhook Setup

These steps mirror the existing `bgapi` webhook setup.

#### a) Install the `webhook` binary

```bash
sudo apt install -y webhook
```

#### b) Copy the webhook config

```bash
sudo mkdir -p /etc/webhook.d
sudo cp /home/pi/aperio-k3s/aperio-webhook.conf /etc/webhook.d/aperio.conf
```

#### c) Set a real HMAC secret

Edit `/etc/webhook.d/aperio.conf` and replace `CHANGE-ME-long-random-secret`
with a real random string:

```bash
# Generate one:
openssl rand -hex 32
# Copy the output and paste it into the "secret" field in aperio-webhook.conf
```

Save the same value — you'll need it for the GitHub secret in step 6.2.

#### d) Install and start the webhook service

```bash
sudo cp /home/pi/aperio-k3s/aperio-webhook.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aperio-webhook
sudo journalctl -u aperio-webhook -f   # watch logs
```

#### e) Verify the webhook is running

```bash
curl -s http://localhost:9001 | head -5
# → {"status":"ok"} or similar
```

#### f) Make the webhook reachable (choose one)

The GitHub runner must be able to POST to the Pi. Options:

**Option 1 — Cloudflare Tunnel** (if you already have access for bgapi):
Add another ingress to your tunnel config pointing at `localhost:9001`.

**Option 2 — Tailscale Funnel**:
```bash
sudo tailscale funnel 9001
```

**Option 3 — Local LAN only** (simplest for testing):
Use a GitHub self-hosted runner on the Pi itself — then the webhook is
reachable at `http://localhost:9001`.

### 6.2 GitHub-side: Workflow Secrets

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret name | Value |
|------------|-------|
| `APERIO_PI_WEBHOOK_URL` | `http://<pi-ip-or-hostname>:9001` or your tunnel URL |
| `APERIO_PI_WEBHOOK_SECRET` | The same HMAC secret from `aperio-webhook.conf` |

### 6.3 GitHub-side: The Workflow

The workflow `.github/workflows/cd.k3s-deploy.yml` was already added to the
aperio repo. It triggers on:

- **Push to `main`** — automatically
- **Manual dispatch** — from the Actions tab in GitHub UI

What it does:

1. Checks out the pushed commit
2. Sends an HMAC-signed POST to the Pi webhook URL with the commit info
3. The Pi validates the signature and runs `aperio-watch-deploy.sh`

#### The deploy script on the Pi (`aperio-watch-deploy.sh`)

```mermaid
graph TD
    A[Webhook received] --> B[git fetch origin/main]
    B --> C{SHA changed?}
    C -->|No| D[Exit - already deployed]
    C -->|Yes| E[git pull]
    E --> F[npm ci]
    F --> G[docker build -t aperio:local]
    G --> H[docker save | k3s ctr import]
    H --> I[kubectl apply -f manifests]
    I --> J[kubectl rollout restart]
    J --> K[kubectl rollout status]
    K --> L[Run db migrations]
    L --> M[Record SHA → .last-deployed-sha]
```

The script is idempotent — if no new commits exist, it exits immediately.

### Alternative: Build in CI (faster, skip building on the Pi)

The workflow has an **Option A** block (commented out) that builds the Docker
image on GitHub's AMD64 runners using QEMU to cross-compile for ARM64, then
pushes to GitHub Container Registry (ghcr.io). If you enable it:

1. Uncomment the `Option A` block in `cd.k3s-deploy.yml`
2. Add `imagePullSecrets` to the `aperio.yaml` Deployment for ghcr.io auth
3. Change the `image` in `aperio.yaml` from `aperio:local` to
   `ghcr.io/<your-user>/aperio:latest`

---

## 7. Manual Deploy (no webhook)

If you don't want to set up the webhook, use `deploy.sh` directly:

```bash
# On the Pi:
cd /home/pi/aperio-k3s
./deploy.sh
```

Or for a quick image rebuild and restart:

```bash
cd /home/pi/aperio
git pull
docker build -f docker/Dockerfile -t aperio:local .
docker save aperio:local | sudo k3s ctr images import -
kubectl -n aperio rollout restart deploy/aperio
kubectl -n aperio rollout status deploy/aperio --timeout=180s
kubectl -n aperio exec deploy/aperio -- node db/migrate.js
```

---

## 8. Troubleshooting

### Pod stuck in `ImagePullBackOff` or `ErrImageNeverPull`

The default `imagePullPolicy: Never` expects a local image named `aperio:local`.
If you haven't imported it:

```bash
docker save aperio:local | sudo k3s ctr images import -
```

If you're using a registry image, change `imagePullPolicy` to `Always` and
add `imagePullSecrets`.

### Postgres won't start

Check the logs:

```bash
kubectl -n aperio logs postgres-0
```

Common issues:
- PersistentVolumeClaim stuck — check `kubectl get pvc -n aperio`
- Password mismatch — `secrets.yaml` value doesn't match what's expected

### Aperio can't connect to Postgres

```bash
kubectl -n aperio logs deploy/aperio
```

Check the `DATABASE_URL` env var:

```bash
kubectl -n aperio exec deploy/aperio -- env | grep DATABASE_URL
```

Expected: `postgresql://aperio:<password>@postgres.aperio.svc.cluster.local:8008/aperio`

### Webhook not firing

On the Pi:

```bash
sudo journalctl -u aperio-webhook -f
# Trigger a test:
curl -X POST http://localhost:9001 \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$(echo -n '{"test":true}' | openssl sha256 -hmac 'your-secret' | awk '{print $2}')" \
  -d '{"test":true}'
```

On GitHub, check the Actions run logs for the HTTP response code.

### Port already in use on the Pi

If port 9001 is already taken, change to 9002 (or any free port):

```bash
# Edit the service file
sudo sed -i 's/-port 9001/-port 9002/' /etc/systemd/system/aperio-webhook.service
# Update the webhook config to match
sudo sed -i 's/localhost:9001/localhost:9002/' /etc/webhook.d/aperio.conf
# Restart
sudo systemctl daemon-reload && sudo systemctl restart aperio-webhook
```

Also update `APERIO_PI_WEBHOOK_URL` in GitHub secrets to match.

### NodePort not accessible

If you need external DB access via `30808`:

```bash
kubectl -n aperio apply -f /home/pi/aperio-k3s/postgres-nodeport.yaml
```

Check the node's firewall — port 30808 must be open.

---

## File Inventory

### In `aperio/.github/workflows/` (stays in the aperio repo)

- `cd.k3s-deploy.yml` — GitHub Actions workflow

### In `k3s-pi5/aperio-k3s/` or `aperio/k8s/` (move to the Pi)

```
aperio-k3s/
├── namespace.yaml                # aperio namespace
├── secrets.yaml                  # Postgres password + API keys
├── postgres.yaml                 # StatefulSet + headless svc (8008)
├── postgres-nodeport.yaml        # NodePort (30808 → 8008)
├── aperio.yaml                   # Deployment + ClusterIP (31337)
├── ingress.yaml                  # Traefik IngressRoute
├── deploy.sh                     # Initial deploy script
├── aperio-webhook.conf           # Webhook receiver config
├── aperio-webhook.service        # systemd unit for webhook
├── aperio-watch-deploy.sh        # CI/CD deploy script
└── k3s-instructions.md           # This file
```
