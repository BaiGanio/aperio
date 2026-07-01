// lib/helpers/egressLog.js
// Append-only audit trail of where agent tools reach on the network (EGRESS-01).
// One JSON line per outbound call so the user can review their agent's egress.
// Best-effort: never throw into a tool handler; skipped under NODE_ENV=test.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR    = "var/logs";
const EGRESS_LOG = join(LOG_DIR, "egress.log");

export function logEgress({ tool, host, sessionId = null }) {
  if (process.env.NODE_ENV === "test") return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      EGRESS_LOG,
      JSON.stringify({ ts: new Date().toISOString(), tool, host, sessionId }) + "\n",
    );
  } catch { /* best-effort: egress logging must never break a tool call */ }
}
