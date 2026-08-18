// Small-model fallback gate. This deliberately bypasses Aperio's agent/tools
// stack: run it only after the hard document-intelligence harness fails, to
// distinguish a model-capacity problem from a large multi-turn workflow issue.
// It uses the same full served context Aperio calculates for the selected model,
// its normal unbounded llama.cpp completion behavior, and a 300s request limit.
// Usage: LLAMACPP_MODEL=unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL node tests/docint/harness/gemma-simple-capability-harness.mjs
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCtxFor } from "../../../lib/helpers/llamacpp/sizing.js";
import { resolveModelCacheDir } from "../../../lib/helpers/modelCache.js";

const model = process.env.LLAMACPP_MODEL || "unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL";
const port = randomInt(20_000, 60_000);
const baseUrl = `http://127.0.0.1:${port}`;
const scratch = mkdtempSync(join(tmpdir(), "aperio-gemma-simple-"));
const env = { ...process.env }; delete env.LLAMACPP_SERVE_CTX;
const serveCtx = serveCtxFor(model, env, { modelCacheDir: resolveModelCacheDir() }, env.APERIO_LOCAL_PERF_PROFILE ?? "balanced");
let server;
const prompts = [
  ["arithmetic", "Calculate 17 × 23 + 19. Reply with only the number.", /\b410\b/],
  ["percentage", "A price falls from $80 to $68. What is the percentage decrease? Reply with only the percentage.", /\b15\s*%/],
  ["weighted-average", "Three items cost $12.50, $7.25, and $10.25. What is their average cost? Reply with only the dollar amount to two decimals.", /\$?10\.00\b/],
  ["logic", "All roses are flowers. Some flowers fade quickly. Does it follow that some roses fade quickly? Reply only yes or no.", /^\s*no\b/i],
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() { for (const until = Date.now() + 180000; Date.now() < until; await sleep(500)) { try { if ((await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch {} } throw new Error("llama-server did not become ready within 180 seconds"); }
async function ask([id, text, expected]) { const start = Date.now(); const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(300000), body: JSON.stringify({ model, messages: [{ role: "system", content: "Answer accurately and follow the requested output format exactly." }, { role: "user", content: text }], temperature: 0 }) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const body = await response.json(); const answer = body.choices?.[0]?.message?.content ?? ""; return { id, wallMs: Date.now() - start, answer, correct: expected.test(answer), timings: body.timings }; }
async function cleanup() { if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch {} await sleep(1000); try { process.kill(-server.pid, "SIGKILL"); } catch {} } rmSync(scratch, { recursive: true, force: true }); }
try { server = spawn("llama-server", ["-hf", model, "--host", "127.0.0.1", "--port", String(port), "--jinja", "--ctx-size", String(serveCtx), "--offline", "-np", "1"], { detached: true, stdio: "ignore" }); await ready(); const results = []; for (const prompt of prompts) results.push(await ask(prompt)); console.log(JSON.stringify({ model, serveCtx, appCtx: Math.max(1, Math.min(Math.floor(serveCtx * .92), serveCtx - 512)), results }, null, 2)); } finally { await cleanup(); }
