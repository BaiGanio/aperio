import { existsSync, statSync, chmodSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createRequire } from "module";
import dotenv from "dotenv";

import { createCrashBreaker } from "./lib/helpers/crashBreaker.js";
import logger from "./lib/helpers/logger.js";

// ─── Global error guards ──────────────────────────────────────────────────────
// Prevent a per-connection exception from crashing the whole server.
// uncaughtException covers sync throws inside EventEmitter callbacks (e.g. the
// ws "connection" handler); unhandledRejection covers async leaks (e.g. an
// await inside a ws "message" callback whose rejection escaped the try/catch).
//
// PROC-01: a single blowup is logged and absorbed, but repeated fatal errors in
// a short window mean the process is wedged — trip the breaker and exit so the
// supervisor restarts cleanly instead of serving errors forever.
//
// The global handlers intentionally absorb recoverable throws. Code that detects
// a genuinely unrecoverable invariant (DB corruption, key material loss, memory
// exhaustion) should call process.exit(1) directly — do not rely on throw-to-crash
// for invariants the handler must never mask.
const crashBreaker = createCrashBreaker({ threshold: 5, windowMs: 60_000 });
// Flipped true once gracefulShutdown begins. Late rejections during teardown
// (aborted fetches, "write after end" once the logger is closing) are expected
// noise — route them to the console so we never write to an ended logger.
let isShuttingDown = false;
function handleFatal(label, err) {
  if (isShuttingDown) {
    console.error(`${label} (during shutdown):`, err);
    return;
  }
  logger.error(`${label}:`, err);
  if (crashBreaker.record()) {
    logger.error("PROC-01: too many fatal errors in a short window — exiting for a clean restart.");
    process.exit(1);
  }
}
process.on("uncaughtException", (err) => handleFatal("Uncaught exception", err));
process.on("unhandledRejection", (err) => handleFatal("Unhandled rejection", err));

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Only load a real .env. .env.example holds placeholder/default secrets
// (e.g. POSTGRES_PASSWORD=aperio_secret) and must never be treated as live
// config — before setup we rely on process env + in-code defaults instead.
const envPath = resolve(__dirname, ".env");
if (existsSync(envPath)) dotenv.config({ path: envPath });

// ENV-01: .env must be owner-only. Self-heal on startup so API keys and
// secrets are never readable by other local users.
try {
  const stat = statSync(envPath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    chmodSync(envPath, 0o600);
    logger.warn(`ENV-01: .env was mode ${mode.toString(8)} — tightened to 600.`);
  }
} catch { /* no .env yet (first run before wizard) — nothing to lock down */ }

// llamacpp.md Phase 6: refuse to boot on a pre-migration .env (AI_PROVIDER=ollama
// or any OLLAMA_* var) rather than silently remapping it. Exits the process.
{
  const { checkOllamaMigrationOrExit } = await import("./lib/helpers/ollamaMigrationShim.js");
  checkOllamaMigrationOrExit();
}

const { version } = require("./package.json");
logger.info(`🚀 Starting Aperio server (version ${version})...`);

// ─── Delegate to the composition root ─────────────────────────────────────────
const { createApp } = await import("./lib/server.js");

const app = await createApp({
  root: __dirname,
  version,
  skipBrowser: process.env.APERIO_BENCHMARK_RUN === "1",
});

// Signal handlers are hooked inside bootApp(). When the process receives
// SIGTERM/SIGINT, bootApp's graceful shutdown handles the full teardown
// sequence: stop timers, close WebSocket, drain HTTP, stop llama.cpp,
// dispose embeddings, close DB, flush logger.
//
// A second signal during shutdown escalates to immediate process.exit(130).
