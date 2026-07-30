# Tests — Aperio public at aperio.live

> Companion to [`aperio-live-public-deploy.md`](aperio-live-public-deploy.md).
> Domain: infrastructure/ops — "test" here means a provable health/security
> criterion, mostly `curl`/`kubectl` assertions run from the Mac or the Pi.
> **Verify-first:** before implementation, T1–T6 must FAIL (aperio.live
> unresolvable / 403 / webhook step commented out). Red first, then build.

## 1. Coverage map

| Plan step | Test group | Coverage |
|-----------|-----------|----------|
| 1 (WS0 issues) | T0 | EPIC exists, #19/#51/#49 closed with pointers |
| 3–4 (WS1 tunnel) | T1 | DNS + tunnel reachability, both paths |
| 5–6 (WS2 ingress/netGuard) | T2 | Host routing, allowlist, bogus-Host rejection |
| 7 (WS2 auth token) | T3 | API 401→200, WS token auth |
| 9, 12 (WS3 Access, posture) | T4 | Access wall, container posture checklist |
| 8, 11 (WS2/WS3 runtime) | T5 | Memory budget, real-IP rate limiting, WS keepalive |
| 10, 14 (WS3/WS5 webhook + CD) | T6 | HMAC gate, end-to-end deploy loop |
| 13, 15 (WS4/WS6 docs) | T7 | Split done, stale-claims grep gate, doc-sync approvals |

## 2. Test cases

### T0 — Issue housekeeping
- **T0.1 EPIC created**
  - Setup: `gh issue list --repo BaiGanio/aperio --label EPIC --state open`
  - Expected: new EPIC "aperio.live" issue present with workstream checklists.
  - Assertions: body references #19, #51, #49, #208; labels include `EPIC`.
- **T0.2 Old issues closed with pointers**
  - Setup: `gh issue view 19|51|49 --json state,comments`
  - Expected: all three `CLOSED`; last comment links the new EPIC.
  - Edge: #54 must NOT be touched (already closed, unrelated).

### T1 — Tunnel reachability
- **T1.1 DNS routed**
  - Setup: after `cloudflared tunnel route dns …`.
  - Expected: `dig +short aperio.live` returns Cloudflare IPs (proxied).
  - Assertions: no NXDOMAIN; CNAME target is `<tunnel-id>.cfargotunnel.com`
    (visible in dashboard).
- **T1.2 Edge → Pi path up**
  - Setup: tunnel restarted with the new ingress rule.
  - Expected: `curl -sI https://aperio.live` returns an origin response
    (or the Access 302 once T4 is in place).
  - Assertions: NOT Cloudflare error 1033/530 (tunnel down) or 502.
  - Edge: `curl -sI https://aperio.live -H 'Connection: Upgrade'` — WS
    upgrade not rejected at the edge.
- **T1.3 (Path B only) Both tunnels coexist**
  - Setup: `systemctl status cloudflared cloudflared-aperio`.
  - Expected: both `active (running)`; bgapi domain still serves.
  - Edge: reboot the Pi → both come back (enabled units).

### T2 — Ingress + netGuard host allowlist
- **T2.1 Public host routes**
  - Setup: from LAN, bypass Cloudflare: `curl -s -o /dev/null -w '%{http_code}' -H 'Host: aperio.live' http://<pi-ip>/`
  - Expected: 200 (app HTML), not Traefik 404, not netGuard 403.
- **T2.2 LAN host still works**
  - Expected: `curl -H 'Host: aperio.local' http://<pi-ip>/` → 200.
- **T2.3 Bogus host rejected**
  - Expected: `curl -H 'Host: evil.example' http://<pi-ip>/` → 403
    `host_not_allowed` (netGuard) or Traefik 404 — must NOT serve the app.
  - Edge: `Host: aperio.live:443`, mixed-case `Host: APERIO.LIVE` — still
    routed correctly (netGuard lowercases; verify).

### T3 — Auth token (AUTH-01)
- **T3.1 API gated**
  - Setup: token set in Secret + Deployment env; pod restarted.
  - Expected: state-changing `/api/*` without token → 401/403; with
    `Authorization`/token → 2xx.
  - Assertions: response body names the auth failure, no stack traces.
- **T3.2 WS gated**
  - Expected: WS connect without token query param → closed/refused; with
    token → open, chat round-trip streams.
  - Edge: token with special chars survives URL-encoding in the query string.
- **T3.3 Secrets rotated**
  - Expected: live Postgres password ≠ `aperio_secret`; auth token ≠ any
    committed placeholder. `kubectl -n aperio get secret aperio-secrets -o json`
    values differ from repo `secrets.yaml`.

### T4 — Cloudflare Access + container posture
- **T4.1 Access wall**
  - Setup: Access application active on aperio.live.
  - Expected: fresh browser/incognito → Cloudflare Access login, NOT the app.
  - Assertions: allowlisted email + OTP → app loads; non-allowlisted email →
    refusal page.
  - Edge: static assets (`/styles/...`) also behind Access — no leak of app
    HTML/JS to unauthenticated clients.
- **T4.2 Posture checklist (live pod)**
  - `kubectl -n aperio exec deploy/aperio -- env` shows:
    `APERIO_ENABLE_SHELL` unset/off, `APERIO_ALLOWED_PATHS_TO_READ=/app`,
    `..._WRITE=/app/var`, `APERIO_ALLOWED_HOSTS=aperio.live`,
    `APERIO_AUTH_TOKEN` present (non-empty).
  - `kubectl -n aperio exec deploy/aperio -- id` → non-root uid.

### T5 — Runtime behavior on the Pi
- **T5.1 Memory budget**
  - Setup: one full chat round-trip via aperio.live (cloud provider).
  - Expected: `kubectl -n aperio top pod` — aperio pod < 1 Gi limit, no
    OOMKilled events (`kubectl -n aperio get events | grep -i oom` empty).
- **T5.2 Real client IP / rate limiting**
  - Setup: two clients (e.g. phone on LTE + laptop) hit a rate-limited route.
  - Expected: limits key per client, not shared via the tunnel's IP.
  - Assertions: app log / limiter sees distinct IPs (CF-Connecting-IP or
    X-Forwarded-For honored). If it sees 127.0.0.1 for everyone → FAIL, fix
    `trust proxy`.
- **T5.3 WS keepalive through Cloudflare**
  - Setup: open a chat, leave the tab idle 6 minutes, then send a message.
  - Expected: same WS still open (no reconnect banner), message streams.
  - Edge: if it dropped, verify ping interval < 60 s was actually deployed.

### T6 — Webhook + CD end-to-end
- **T6.1 HMAC gate**
  - Expected: unsigned/badly-signed POST to the webhook URL → 401/403;
    correctly signed test POST (openssl hmac recipe) → 200 and script runs.
- **T6.2 Full loop**
  - Setup: `git commit --allow-empty -m "chore: CD e2e" && git push`.
  - Expected: Actions run green → webhook step logs 200 → Pi journal shows
    receipt → `kubectl -n aperio rollout status deploy/aperio` completes →
    migrations logged → `curl https://aperio.live` serves the new pod.
  - Assertions: total push→live < 15 min; no manual step in between.
  - Edge: workflow with `skip ci` in message does NOT trigger; missing
    `APERIO_PI_WEBHOOK_URL` secret degrades to a warning, not a red build.

### T7 — Docs split + sync
- **T7.1 Split structure**
  - Expected: `k8s/README.md` and `k8s/ALTERNATIVES.md` exist;
    `k8s/k3s-instructions.md` deleted; README links to ALTERNATIVES.
- **T7.2 Stale-claims grep gate**
  - Assertions (all must return nothing):
    - `grep -ri "ollama\|lancedb" k8s/`
    - `grep -rn "docker build" k8s/README.md` (Pi never builds)
    - `grep -rn "node.*npm.*on the Pi\|Docker installed on the Pi" k8s/`
    - `grep -rn "push to \`main\`\|branches: \[main\]" k8s/ .github/workflows/cd.k3s-deploy.yml`
    - `grep -rn "git pull → docker build\|k3s import" k8s/`
- **T7.3 Doc-sync approvals**
  - Expected: for each file in the plan's §6 table, an explicit user
    approve/decline exists before any write. No silent doc edits.

## 3. Test execution order

1. **T0** — standalone (planning phase, already executable).
2. **T1** → **T2** → **T3** — strictly ordered: routing before host rules
   before auth (each earlier layer must pass or later failures are ambiguous).
3. **T4**, **T5** — after T3; independent of each other.
4. **T6** — after T2 (webhook hostname rides the tunnel), before T7.
5. **T7** — last; docs describe what was actually built.

## 4. Required setup

- Cloudflare dashboard access for the account(s) holding both zones; the
  aperio.live zone active (nameservers moved).
- `cloudflared` ≥ 2024.x on the Pi; existing tunnel healthy (baseline:
  bgapi domain serves before any change).
- `kubectl` context to the Pi cluster from the Mac; `gh` authenticated.
- Secrets generated fresh: `openssl rand -hex 32` × 2 (webhook HMAC exists
  already; auth token new), new Postgres password.
- One cloud-provider API key for the chat round-trip tests.
- A second network vantage point (phone on LTE) for T5.2.
