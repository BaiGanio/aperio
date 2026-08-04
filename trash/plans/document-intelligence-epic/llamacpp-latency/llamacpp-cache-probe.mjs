// T-L1 isolated cache-hit probe for llamacpp-multiturn-latency.md Step 1.
//
//   node trash/plans/document-intelligence-epic/llamacpp-latency/llamacpp-cache-probe.mjs
//
// Spawns its OWN llama-server (own port, own log file, offline, killed on
// exit) — does not touch Aperio's app, DB, or the product's managed
// llama-server instance/state.json. Does not import any Aperio module; it
// talks straight to llama-server's OpenAI-compatible /chat/completions so the
// measurement is uncontaminated by lib/agent/providers/llamacpp.js's own
// caching/trimming logic (that logic is what this probe is trying to give an
// independent verdict on).
//
// Sequence per repeat, against a SINGLE slot (-np 1, matching Aperio's own
// choice — see lib/helpers/llamacpp/preset.js):
//   A  — history + tools=X                       (establish baseline; not scored)
//   B  — history + one appended msg + tools=Y     (SCORED: varied tools)
//   A' — history + tools=X (re-baseline)          (identical to A; not scored)
//   C  — history + one appended msg + tools=X      (SCORED: stable tools, control)
// B and C start from the SAME resident slot state (A/A'), so the comparison
// is apples-to-apples: any A/B/C sequence which just ran B, then C would have
// C measured against B's own residue instead of a shared baseline, no longer
// isolating the tools-array variable. Re-running A before C buys back that
// isolation at the cost of one extra request per repeat.
//
// Reads llama.cpp's `timings` block (prompt_ms, prompt_n, cache_n, ...) off
// the final SSE chunk — the same field lib/streaming/llamacppHandler.js
// already parses in production (see its `this.timings = parsed.timings`).
// `cache_n` is the cached-prefix token count for that request; `prompt_n` is
// the request's total prompt size. hit ratio = cache_n / prompt_n.

import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomInt } from "node:crypto";
import { encode } from "gpt-tokenizer";

const MODEL = process.env.LLAMACPP_MODEL || "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL";
const PORT = Number(process.env.PROBE_PORT ?? 0) || randomInt(20_000, 60_000);
const CTX_SIZE = Number(process.env.PROBE_CTX ?? 8192);
const REPEATS = Number(process.env.PROBE_REPEATS ?? 3);
// os.tmpdir() rather than a hardcoded macOS/author-specific path — the only
// portable default across macOS/Linux/Windows; the checked-in reproduction
// command must run as documented on any machine, not just the one it was
// authored on.
const SCRATCH = process.env.PROBE_SCRATCH_DIR || join(tmpdir(), "aperio-llamacpp-cache-probe");
const LOG_PATH = join(SCRATCH, "server.log");
const RESULTS_PATH = join(SCRATCH, "results.json");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HEALTH_TIMEOUT_MS = 180_000;

function toolSchema(name, i) {
  return {
    type: "function",
    function: {
      name,
      description: `Synthetic probe tool #${i} — mimics the token footprint of a real Aperio MCP tool schema (name, multi-sentence description, nested object parameters) without depending on any real tool definition.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Primary query or identifier argument for this synthetic tool." },
          limit: { type: "number", description: "Maximum number of results to return; optional bound used for pagination-shaped calls." },
          filters: {
            type: "object",
            description: "Optional structured filter object, mirroring the nested-object shape common in real tool schemas.",
            properties: {
              tag: { type: "string" },
              since: { type: "string", description: "ISO-8601 date lower bound." },
            },
          },
        },
        required: ["query"],
      },
    },
  };
}

// X: small stable profile set (order-of-magnitude match to the observed
// "turn 0 attached 15/74 schemas" from the plan's evidence).
const TOOLS_X = Array.from({ length: 15 }, (_, i) => toolSchema(`probe_tool_x_${i}`, i));
// Y: materially different/larger profile set ("turn 1 attached 40/74").
// Deliberately does NOT reuse TOOLS_X's names — a real intent-reclassification
// mid-conversation can drop tools as well as add them, and a shared-name
// "same tool, moved position" case is not the scenario under test here.
const TOOLS_Y = Array.from({ length: 40 }, (_, i) => toolSchema(`probe_tool_y_${i}`, i));
// Y': X plus exactly ONE extra tool — the edge case from the plan
// ("even a small tools-array change still breaks the prefix match").
const TOOLS_X_PLUS_ONE = [...TOOLS_X, toolSchema("probe_tool_extra_one", 999)];

// Padded to land in the ~2-3K token range the plan specifies as
// representative of a real early-conversation size.
const FILLER_PARAGRAPH = "The household ledger for this quarter tracks recurring subscriptions, " +
  "one-off purchases, and shared expenses across two people, split by category " +
  "(groceries, utilities, transport, entertainment, and miscellaneous) so that " +
  "month-end reconciliation only requires reviewing exceptions rather than " +
  "re-deriving the whole picture from raw statements. ";

function buildHistory(targetTokens) {
  const messages = [
    { role: "user", content: "I'd like help reviewing our household spending for this quarter. Can you walk me through how you'd approach it?" },
    { role: "assistant", content: "Sure — I'd start by pulling the categorized transactions for the quarter, checking for duplicates or misclassified entries, then summing by category before comparing against last quarter's totals." },
  ];
  let filler = "";
  while (encode(JSON.stringify(messages) + filler).length < targetTokens) filler += FILLER_PARAGRAPH;
  messages.push({ role: "user", content: `Here is additional context you may need: ${filler}` });
  messages.push({ role: "assistant", content: "Understood — I've noted that context and will factor it into the review." });
  return messages;
}

const HISTORY = buildHistory(2500);
const APPENDED_MESSAGE = { role: "user", content: "Great — now give me the total for just the transport category." };

function withSystem(messages) {
  return [{ role: "system", content: "You are a careful household-finance assistant. Keep answers to one short sentence." }, ...messages];
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Sends one request, drains the SSE stream, returns { wallMs, timings, usage }.
// max_tokens is small and temperature 0 with thinking disabled so B/C's
// generation cost stays roughly equal — the whole point is isolating prefill
// (prompt reprocessing) time, not confounding it with output-length variance.
async function sendProbeRequest(label, messages, tools) {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: withSystem(messages),
      tools,
      max_tokens: 8,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[${label}] HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timings = null;
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.timings) timings = parsed.timings;
      if (parsed.usage) usage = parsed.usage;
    }
  }
  const wallMs = Date.now() - started;
  return { label, wallMs, timings, usage };
}

// llama.cpp's `timings.prompt_n` is the count of NEWLY processed prompt
// tokens for this request, not the total prompt length — `timings.cache_n` is
// the count served from the slot's KV cache on top of that. Total prompt
// length = cacheN + promptN; hit ratio must be measured against that total,
// not against promptN alone (dividing by promptN alone can exceed 1 and is
// meaningless — confirmed against this probe's own first run's raw numbers).
function summarize(result) {
  const { label, wallMs, timings, usage } = result;
  const promptN = timings?.prompt_n ?? usage?.prompt_tokens ?? null;
  const cacheN = timings?.cache_n ?? null;
  const totalPromptTokens = (typeof cacheN === "number" && typeof promptN === "number")
    ? cacheN + promptN
    : null;
  const hitRatio = (typeof cacheN === "number" && totalPromptTokens > 0)
    ? cacheN / totalPromptTokens
    : null;
  return { label, wallMs, promptN, cacheN, totalPromptTokens, hitRatio, promptMs: timings?.prompt_ms ?? null, timings };
}

let serverProc = null;
let logFd = null;

async function stopServer() {
  if (!serverProc) return;
  try { process.kill(-serverProc.pid, "SIGTERM"); } catch { try { serverProc.kill("SIGTERM"); } catch { /* already gone */ } }
  await new Promise(r => setTimeout(r, 1500));
  try { process.kill(-serverProc.pid, "SIGKILL"); } catch { /* already gone */ }
  serverProc = null;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  logFd = openSync(LOG_PATH, "w");
  console.error(`PROBE model=${MODEL} port=${PORT} ctx=${CTX_SIZE} log=${LOG_PATH}`);
  serverProc = spawn("llama-server", [
    "-hf", MODEL,
    "--host", "127.0.0.1",
    "--port", String(PORT),
    "--jinja",
    "--ctx-size", String(CTX_SIZE),
    "--offline",
    "-np", "1",
  ], { detached: true, stdio: ["ignore", logFd, logFd] });
  serverProc.on("error", (e) => console.error(`PROBE spawn error: ${e.message}`));

  const up = await waitForHealth();
  if (!up) throw new Error(`llama-server did not become healthy within ${HEALTH_TIMEOUT_MS}ms — check ${LOG_PATH}`);
  console.error("PROBE server healthy");

  const runs = [];
  const variants = [
    { name: "wide-diff", toolsY: TOOLS_Y },
    { name: "one-tool-diff", toolsY: TOOLS_X_PLUS_ONE },
  ];
  for (const variant of variants) {
    for (let i = 0; i < REPEATS; i++) {
      console.error(`PROBE variant=${variant.name} repeat=${i + 1}/${REPEATS}`);
      await sendProbeRequest(`A(${variant.name},${i})`, HISTORY, TOOLS_X);
      const b = await sendProbeRequest(`B(${variant.name},${i})`, [...HISTORY, APPENDED_MESSAGE], variant.toolsY);
      await sendProbeRequest(`A'(${variant.name},${i})`, HISTORY, TOOLS_X);
      const c = await sendProbeRequest(`C(${variant.name},${i})`, [...HISTORY, APPENDED_MESSAGE], TOOLS_X);
      const bSummary = summarize(b);
      const cSummary = summarize(c);
      console.error(`PROBE ${variant.name}#${i} B hit=${bSummary.hitRatio} (${bSummary.cacheN}/${bSummary.promptN}) wallMs=${bSummary.wallMs}`);
      console.error(`PROBE ${variant.name}#${i} C hit=${cSummary.hitRatio} (${cSummary.cacheN}/${cSummary.promptN}) wallMs=${cSummary.wallMs}`);
      runs.push({ variant: variant.name, repeat: i, B: bSummary, C: cSummary });
    }
  }

  await writeFile(RESULTS_PATH, JSON.stringify({ model: MODEL, ctxSize: CTX_SIZE, repeats: REPEATS, runs }, null, 2));
  console.log(JSON.stringify({ resultsPath: RESULTS_PATH, runs }, null, 2));
}

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  console.error("PROBE cleanup");
  await stopServer();
  if (logFd !== null) { try { closeSync(logFd); } catch { /* best effort */ } }
}

// Node's default SIGINT/SIGTERM behavior (no listener registered) terminates
// the process immediately, WITHOUT draining pending promises — so a bare
// Ctrl-C or `kill` during the probe would skip main()'s own .finally() below
// entirely, leaving the detached llama-server (its own process group, still
// holding the port and consuming GPU/CPU) as an orphan. Explicit handlers
// make an interrupted run clean up exactly like a completed one.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`PROBE received ${sig} — cleaning up before exit`);
    cleanup().finally(() => process.exit(1));
  });
}

main()
  .catch(e => { console.error(`PROBE failure: ${e?.stack ?? e}`); process.exitCode = 1; })
  .finally(cleanup);
