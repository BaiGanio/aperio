// lib/routes/api-github-webhook.js
// GitHub webhook ingestion for issue triage (issue-triage.md, Phase 3).
// Captures issue events in real time into the triage ledger — NO model runs,
// capture only; the daily poll backstops it when Aperio isn't reachable.
//
// Auth is the webhook's own HMAC (GITHUB_WEBHOOK_SECRET), NOT the app's
// APERIO_AUTH_TOKEN — GitHub can't present that token — so this path is exempt
// from createAuthGuard and self-verifies every request. Without a secret set the
// route refuses to process anything (503), so no unauthenticated write path is
// opened. The raw request body (req.rawBody, stashed by express.json's verify
// hook in server.js) is required for a correct HMAC.

import crypto from "crypto";
import logger from "../helpers/logger.js";

// Constant-time compare of the X-Hub-Signature-256 header against our own HMAC.
function signatureValid(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const CAPTURE_ACTIONS = new Set(["opened", "edited", "reopened"]);

export function mountGithubWebhookRoutes(router, { store }) {
  router.post("/github/webhook", async (req, res) => {
    // Settings-store value (set via the UI, no restart) wins over the env var.
    const fromSettings = await store.getSetting("github.webhook_secret").catch(() => null);
    const secret = (fromSettings != null && String(fromSettings).trim()) || process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "webhook not configured (set GITHUB_WEBHOOK_SECRET)" });

    if (!signatureValid(req.rawBody, req.get("X-Hub-Signature-256"), secret))
      return res.status(401).json({ error: "invalid signature" });

    // Only issue events with a capture-worthy action touch the ledger.
    if (req.get("X-GitHub-Event") !== "issues") return res.status(204).end();
    const { action, issue, repository } = req.body ?? {};
    if (!CAPTURE_ACTIONS.has(action) || !issue || !repository?.full_name)
      return res.status(204).end();

    try {
      await store.upsertIssue({
        repo:      repository.full_name,
        number:    issue.number,
        title:     issue.title,
        state:     issue.state,
        updatedAt: issue.updated_at,
      });
      logger.info(`📥 webhook captured ${repository.full_name}#${issue.number} (${action})`);
    } catch (err) {
      logger.error("github webhook upsert failed:", err);
      return res.status(500).json({ error: err.message });
    }
    return res.status(204).end();
  });
}
