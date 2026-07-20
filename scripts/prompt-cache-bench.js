// scripts/prompt-cache-bench.js
//
// Prompt-cache hygiene: reads a llama-server debug log — a session-scoped
// var/llamacpp/<id>.log, or the shared var/llamacpp/server.log when no
// argument is given — and reports
// each request's slot-cache reuse (selection kind, sim_best, f_keep,
// reprocessed tokens/ms). Pure parsing/formatting lives in
// lib/helpers/promptCacheLog.js (fixture-tested); this script only does I/O.
//
//   node scripts/prompt-cache-bench.js [session-id | path-to-log]
//
// With no argument, reads var/llamacpp/server.log — the shared, current log,
// which may contain unrelated activity; prefer a session id when known (see
// AGENTS.md's Diagnostics and Runtime Logs section).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseServerLog, formatPromptCacheReport } from "../lib/helpers/promptCacheLog.js";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveLogPath(arg) {
  if (!arg) return resolve("var/llamacpp/server.log");
  if (SESSION_ID_RE.test(arg)) return resolve(`var/llamacpp/${arg}.log`);
  return resolve(arg);
}

function main() {
  const logPath = resolveLogPath(process.argv[2]);
  if (!existsSync(logPath)) {
    console.error(`prompt-cache-bench: no such log file: ${logPath}`);
    process.exit(1);
  }
  const text = readFileSync(logPath, "utf-8");
  const records = parseServerLog(text);
  console.log(`Parsed ${logPath}\n`);
  console.log(formatPromptCacheReport(records));
}

main();
