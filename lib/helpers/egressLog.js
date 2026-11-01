// lib/helpers/egressLog.js
// Append-only audit trail of where agent tools reach on the network (EGRESS-01).
// One JSON line per outbound call so the user can review their agent's egress.
// Best-effort: never throw into a tool handler; skipped under NODE_ENV=test.

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR    = "var/logs";
const EGRESS_LOG = join(LOG_DIR, "egress.log");
const EGRESS_ROTATED_LOG = `${EGRESS_LOG}.1`;
const MAX_EGRESS_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(nextBytes) {
  try {
    const currentBytes = statSync(EGRESS_LOG).size;
    if (currentBytes + nextBytes <= MAX_EGRESS_BYTES) return;
    renameSync(EGRESS_LOG, EGRESS_ROTATED_LOG);
    try { chmodSync(EGRESS_ROTATED_LOG, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    // A missing log is the normal first-write case. Other filesystem errors
    // are deliberately ignored: egress auditing must not block the request.
    if (err.code !== "ENOENT") return;
  }
}

export function logEgress({ tool, host, target = null, sessionId = null }) {
  if (process.env.NODE_ENV === "test") return;
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(LOG_DIR, 0o700); } catch { /* best-effort */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, host, target, sessionId }) + "\n";
    rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(
      EGRESS_LOG,
      line,
      { mode: 0o600 },
    );
    try { chmodSync(EGRESS_LOG, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort: egress logging must never break a tool call */ }
}
