// WS2 isolated harness for the T-G2 skill gate (issue #250).
//
//   DOCINT_PHASE=routing    node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
//   DOCINT_PHASE=coverage   node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
//   DOCINT_PHASE=provenance node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
//
// Default evaluation provider/model is DeepSeek deepseek-v4-flash (see
// EVALUATION_PROVIDER/EVALUATION_MODEL below); Codex gpt-5.6-terra is the
// other recorded pair. To instead run against a local llama.cpp model — the
// actual target model, not a cloud proxy for it — set both:
//   DOCINT_PHASE=provenance DOCINT_EVALUATION_PROVIDER=llamacpp \
//     LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL \
//     node trash/plans/document-intelligence-epic/llamacpp-latency/document-intelligence-skill-harness.mjs
// This boots a fully isolated llama-server (own port, own preset/state dir
// under the scratch runtime) and tears it down in the same finally block
// that cleans up everything else — it never touches a shared/dev instance.
//
// Same isolation pattern as the retired T-R5 red harness (deleted 2026-08-14;
// `git log -- trash/plans/document-intelligence-epic/document-intelligence-red-harness.mjs`): scratch
// SQLite DB, non-default ports, a copied fixture set, oracle withheld, full
// teardown. This script is new because the T-G2 gate needs different things per
// phase (a bare-routing check, an oversized-corpus coverage check, and a
// db_execute confirm-flow round-trip) rather than one P2-style prompt.
//
//   routing    — T-G2.1: bare phrasing, June fixture, checks manifest→batch
//                routing and the Utilities figure, without a supplied path.
//   coverage   — T-G2.2: the full nine-period "multi-month" fixture set
//                (200+ documents, far past the 48-candidate bound) — checks the
//                run completes or reports an explicit bound, with disclosed
//                coverage, rather than a silent partial drop.
//   provenance — T-G2.3 + T-G2.4: June fixture (has the EUR travel documents
//                already), asks for a saved/queryable total, drives the
//                db_execute propose→confirm round-trip over the WS protocol,
//                then asks a follow-up turn for the SQL-derived figure. Reuses
//                the T-R5 full-month gate (which already asserts EUR travel is
//                reported separately, not blended) for T-G2.4.
//
// The oracle is read once, in-process, from the tracked fixture — never copied
// into the model-readable corpus. This file's own output artifact reuses the
// same ignored/tracked-but-restored path as the T-R5 harness, per the existing
// convention (restore with `git checkout --` after each run).

import "dotenv/config";
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { WebSocket } from "ws";
import { buildExpectations } from "../../../../tests/fixtures/household-gen/harness-gate.mjs";
import { resolveLadder } from "../../../../tests/docint/provenance-ladder.mjs";
import { hasNarratedDecimalTotal, dbQueryReturnedRows } from "../../../../tests/docint/grading-predicates.mjs";
import { gradePhase } from "../../../../tests/docint/grading.mjs";

const HOUSEHOLD = process.env.HOUSEHOLD_ROOT ?? "/Users/lk/Projects/household";
const ORACLE_PATH = resolve(process.env.ORACLE_PATH ?? "tests/fixtures/household-gen/ground-truth.json");
// Two artifact paths, on purpose. ANSWERS_PATH is the historical single-slot
// one every prior run used (gitignored, overwritten at each write); RUN_ID gives
// this run its own accumulating copy under var/, so a transcript survives the
// next run and can be replayed through a later grader. Before this, a run's
// only un-redacted record was clobbered the moment the next run started — which
// is why every grader fix in this epic was hand-validated against one run's
// stdout instead of re-graded (tech-debt.md, "the harness's stdout dump cannot
// be re-graded"). Replay with:
//   node trash/plans/document-intelligence-epic/llamacpp-latency/replay-grading.mjs <path>
const ANSWERS_PATH = resolve("trash/plans/document-intelligence-epic/document-intelligence-run-answers.json");
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const RUN_ARCHIVE_DIR = resolve(process.env.DOCINT_RUN_ARCHIVE_DIR ?? "var/docint-runs");
const SERVER_LOG_CAPTURE_PATH = resolve("trash/plans/document-intelligence-epic/llamacpp-latency/server-log-latest.log");
const PHASE = process.env.DOCINT_PHASE ?? "routing"; // routing | coverage | provenance
const SETUP_ONLY = process.argv.includes("--setup-only");
const FIXTURE_SET = PHASE === "coverage" ? "multi-month" : "T-R5";
let webPort = Number(process.env.APERIO_HARNESS_PORT ?? 0);
let isolatedLlamaPort = 0;
const TIMEOUT_MS = Number(process.env.APERIO_HARNESS_TIMEOUT_MS ?? 600_000);
// T-L4 wall-clock gate (llamacpp-multiturn-latency.md Step 4) — distinct from
// TIMEOUT_MS above, which only aborts a genuinely stuck turn. This gates
// grading.status on real elapsed time so a too-slow-but-eventually-correct
// run fails the same as a wrong answer — but ONLY when explicitly enabled
// (env-set): the plan's own Risk table calls this "a manual/isolated-harness
// gate on the developer's own hardware, not a CI assertion," and the one
// real T-L4.1 run against the actual gemma-4 hero model confirmed why a
// default-on ceiling doesn't work here — 1,920,086ms total and a 461,830ms
// single turn, both far past the originally proposed 600,000ms/90,000ms
// (see the 2026-08-03 evidence log entry in llamacpp-multiturn-latency.md).
// That run also confirmed the fix's OWN mechanism was working correctly
// (`cache_n` held stable, `doc_batch` dedup fired) — the overrun was genuine
// per-turn NEW-content prefill time (23-26K fresh tokens/turn at this
// hardware's ~120-133 tok/s), not a regression the gate was meant to catch.
// A hardcoded default ceiling can't distinguish "this hardware is just slow"
// from "the cache fix broke," so defaulting to Infinity (no gate) avoids
// guaranteeing a known-hardware-throughput failure on every future default
// run; pass APERIO_HARNESS_WALLCLOCK_TOTAL_MS/_PERTURN_MS explicitly,
// informed by a fresh measurement on the hardware actually running the
// check, to opt back into the gate.
const WALLCLOCK_TOTAL_CEILING_MS = Number(process.env.APERIO_HARNESS_WALLCLOCK_TOTAL_MS ?? Infinity);
const WALLCLOCK_PER_TURN_CEILING_MS = Number(process.env.APERIO_HARNESS_WALLCLOCK_PERTURN_MS ?? Infinity);
// WS2 defaults to a cloud-provider verification and stays independent of
// .env's interactive-provider selection. A caller must select one of the
// exact, recorded provider/model pairs below; it cannot silently fall back.
// DOCINT_EVALUATION_PROVIDER=llamacpp is the one additive exception — it
// drives an isolated local llama-server (own port, own preset/state dir, own
// scratch runtime — see isolatedLlamaPort below) so a real run against the
// actual target model can be validated, not just DeepSeek/Codex as a proxy
// for it. The model comes from LLAMACPP_MODEL (the real Aperio config var),
// not a DOCINT_-prefixed one, so an invocation reads the same way any other
// llama.cpp model selection does.
const EVALUATION_PROVIDER = process.env.DOCINT_EVALUATION_PROVIDER ?? "deepseek";
const EVALUATION_MODEL = process.env.DOCINT_EVALUATION_MODEL
  ?? (EVALUATION_PROVIDER === "codex" ? "gpt-5.6-terra"
    : EVALUATION_PROVIDER === "llamacpp" ? process.env.LLAMACPP_MODEL
    : "deepseek-v4-flash");
const PROVENANCE_FOLLOW_UP_CAP = 8;
// DOCINT_PROVENANCE_LADDER=mechanism|natural (default mechanism — so any run
// without this set stays comparable to every historical T-L4 result). See
// provenance-ladder.mjs for the full rationale: "mechanism" is the original
// escalating-to-literal-SQL ladder, kept for diagnosing execution-mechanics
// defects; "natural" is a parallel ladder that never uses SQL/database
// vocabulary at any rung, for measuring realistic-usage behavior instead.
// Resolved eagerly (before any expensive setup) so a typo'd value fails
// loudly at start-up, not silently mid-run.
const { name: PROVENANCE_LADDER_NAME, entries: PROVENANCE_LADDER_ENTRIES } =
  resolveLadder(process.env.DOCINT_PROVENANCE_LADDER);

// DOCINT_FORCE_SKILLS=document-intelligence — diagnostic only, default off, so
// every historical T-L4/T-G2.3 result stays comparable. Rides in as the same
// `data.forcedSkills` one-shot the UI Skills panel uses (wsHandler.js), which
// is consumed once per turn — so it must be sent on EVERY chat message, not
// just the first. Exists because the 2026-08-13 root-cause finding showed
// `document-intelligence` attaches only on turn 0 of the provenance ladder:
// its curated keywords are all first-turn discovery phrasing, and follow-up
// turns match `reasoning-planning` or nothing at all (see tech-debt.md,
// "Skill matching — a workflow skill does not survive its own follow-up
// turns"). Forcing it isolates "the skill's wording doesn't work" from "the
// skill wasn't in context", which no prior run could distinguish.
const FORCED_SKILLS = (process.env.DOCINT_FORCE_SKILLS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

const PHASE_PROMPTS = {
  // T-G2.1 bare-routing. Anchored to June 2026 (not "last month") because the
  // T-R5 fixture is graded against June and real wall-clock time has moved past
  // it — the epic's own evidence log used this same anchoring adjustment.
  routing: ["How much did I pay for utilities in June 2026?"],
  // T-G2.2 convergence-and-coverage against the oversized nine-period corpus.
  coverage: ["What did I spend on utilities across all of 2026? Tell me what you found and what you couldn't cover."],
  // T-G2.3/T-G2.4: full month, explicitly asked to be saved/queryable (or, on
  // the natural ladder, just "kept track of") so the skill has a reason to
  // reach for db_execute/db_query instead of reporting a one-shot figure.
  // Only the ladder's opening rung lives here — the rest is consumed
  // directly from PROVENANCE_LADDER_ENTRIES in runModelPhase, where the tier
  // metadata is needed for grading.
  provenance: [PROVENANCE_LADDER_ENTRIES[0].text],
};

let scratch = null;
let app;
let gracefulShutdown;
const results = [];
let expectations = null;
let oracle = null;

async function freePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

function connect(port) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const handshake = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WS handshake timeout"));
    }, 15_000);
    ws.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      handshake.push(message);
      if (message.type === "session_created") {
        clearTimeout(timer);
        resolvePromise({ ws, handshake });
      }
    });
  });
}

function summarizeToolCalls(events) {
  const starts = events.filter(event => event.type === "tool_start");
  const outcomes = events.filter(event => event.type === "tool_result");
  return starts.map(start => {
    const outcome = outcomes.find(candidate => candidate.seq === start.seq);
    return {
      seq: start.seq,
      name: start.name,
      arguments: start.arguments,
      ok: outcome?.ok,
      summary: outcome?.summary,
      // Full (capped) result text — db_query's rowCount/rows and db_execute's
      // rowsAffected live here, not in `summary` (see toolActivity.js's
      // withDetail: a short ack like "✅ Executed on..." can fit entirely in
      // `summary`, but db_query's JSON payload almost always exceeds the
      // 80-char cutoff and collapses `summary` to a byte-size string instead).
      detail: outcome?.detail,
      ms: outcome?.ms,
      pending: !outcome,
    };
  });
}

async function copyFixtureSet(fixture, primary, secondary) {
  await mkdir(primary, { recursive: true });
  await mkdir(secondary, { recursive: true });
  const copied = { primary: [], secondary: [] };
  for (const [role, paths, destination] of [
    ["primary", fixture.primary_paths, primary],
    ["secondary", fixture.secondary_paths, secondary],
  ]) {
    for (const relPath of paths) {
      const source = join(HOUSEHOLD, relPath);
      const info = await stat(source).catch(() => null);
      if (!info) throw new Error(`fixture set ${FIXTURE_SET} declares a missing path: ${relPath}`);
      const target = join(destination, relPath.split("/").pop());
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
      copied[role].push(relPath);
    }
  }
  const leaked = join(primary, "ground-truth.json");
  if (await stat(leaked).catch(() => null)) {
    throw new Error("the oracle was copied into the model-readable corpus — aborting");
  }
  return copied;
}

async function indexCorpus(primary, secondary, dbPath) {
  process.env.DB_BACKEND = "sqlite";
  process.env.SQLITE_PATH = dbPath;
  process.env.APERIO_CONFIG_PRECEDENCE = "env";
  process.env.APERIO_ALLOWED_PATHS_TO_READ = `${primary},${secondary}`;
  const { SqliteStore } = await import("../../../../db/sqlite.js");
  const { indexRepo } = await import("../../../../lib/docgraph/indexer.js");
  const store = await SqliteStore.init();
  try {
    const primaryStats = await indexRepo(store, primary, { generateEmbedding: async () => null });
    const secondaryStats = secondary
      ? await indexRepo(store, secondary, { generateEmbedding: async () => null })
      : null;
    return { primary: primaryStats, secondary: secondaryStats };
  } finally {
    await store.close();
  }
}

// Drives one chat turn to completion. When a db_execute proposal surfaces as a
// pending interrupt mid-turn (the turn itself ends without executing, per the
// tool's own "propose, then end your turn" contract), this approves it and
// keeps listening on the SAME connection for the resulting confirmation
// stream_end, then returns a merged event log so the gate can see both halves.
function runTurn(ws, prompt, { approveInterrupts = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const events = [];
    const started = Date.now();
    const approvedIds = new Set();
    const approved = () => approvedIds.size > 0;
    let turnComplete = false;
    let pendingGrace = null;
    let settled = false;
    // Each runTurn call registers its own message/error listeners on a WS
    // connection shared across a whole prompt sequence (see
    // runPromptSequence) — without removing them on finish, every prior
    // turn's listener stays attached, so turn N re-processes every message
    // N times (duplicate tool_start/tool_result logs, and — worse —
    // duplicate interrupt-approval sends that the server correctly rejects
    // with InterruptConflictError, but which still cost a round trip). Strip
    // both listeners the moment this turn settles, on every exit path.
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pendingGrace);
      ws.off("message", onMessage);
      ws.off("error", onError);
      const toolSequence = events.filter(e => e.type === "tool_start").map(e => e.name).filter(Boolean);
      const lastStreamEnd = events.filter(e => e.type === "stream_end").at(-1);
      const answer = lastStreamEnd?.text
        ?? events.filter(e => e.type === "token").map(e => e.text ?? "").join("");
      // T-G2.3 problem #3: per-turn wall time was observed climbing as context
      // grew, but nobody confirmed whether that tracks prompt size. The
      // provider already reports usage on stream_end (see
      // lib/agent/providers/deepseek.js) — surface it instead of guessing
      // from wall-clock time alone.
      const usage = lastStreamEnd?.usage ?? null;
      const wallMs = Date.now() - started;
      console.error(`HARNESS turn wallMs=${wallMs} input_tokens=${usage?.input_tokens ?? "?"} output_tokens=${usage?.output_tokens ?? "?"} thinking_tokens=${usage?.thinking_tokens ?? "?"}`);
      resolvePromise({
        prompt,
        wallMs,
        toolSequence,
        toolCalls: summarizeToolCalls(events),
        interruptApproved: approved(),
        approvedCount: approvedIds.size,
        answerRaw: String(answer),
        usage,
        status,
      });
    };
    const timer = setTimeout(() => {
      finish("timeout");
    }, TIMEOUT_MS);
    const onError = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pendingGrace);
      ws.off("message", onMessage);
      ws.off("error", onError);
      reject(error);
    };
    ws.on("error", onError);
    // Any pending db_execute interrupt gets approved, however many arrive —
    // a real user session confirms every proposal it sees, not just the
    // first. Once the turn has ended, wait a short grace window after each
    // approval for a possible next proposal (e.g. CREATE TABLE then INSERT)
    // before declaring the turn done.
    const armGrace = () => {
      clearTimeout(pendingGrace);
      pendingGrace = setTimeout(() => finish("completed"), 4000);
    };
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      events.push(message);
      if (message.type === "tool_start") {
        console.error(`HARNESS tool_start ${message.name} args=${JSON.stringify(message.arguments).slice(0, 300)}`);
      }
      if (message.type === "tool_result") {
        console.error(`HARNESS tool_result ${message.name} ok=${message.ok} ms=${message.ms} summary=${String(message.summary).slice(0, 200)}`);
      }
      if (message.type === "interrupts" && approveInterrupts) {
        const pending = (message.interrupts ?? []).filter(i => i.tool === "db_execute" && i.status === "pending" && !approvedIds.has(i.id));
        for (const p of pending) {
          approvedIds.add(p.id);
          console.error(`HARNESS approving db_execute interrupt ${p.id}`);
          ws.send(JSON.stringify({ type: "interrupt_decision", id: p.id, decision: "approve" }));
        }
        if (pending.length && turnComplete) armGrace();
      }
      if (message.type === "turn_complete") {
        turnComplete = true;
        // A db_execute proposal may still be in flight (the "interrupts" push
        // can arrive slightly after turn_complete) — give it a short grace
        // window before declaring the turn done.
        if (approveInterrupts) armGrace();
        else finish(message.status);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({
      type: "chat",
      text: prompt,
      turnId: randomUUID(),
      ...(FORCED_SKILLS.length ? { forcedSkills: FORCED_SKILLS } : {}),
    }));
  });
}

async function runPromptSequence(port, prompts, { approveInterrupts = false, followUps = [], dynamicFollowUp = null } = {}) {
  const { ws } = await connect(port);
  const turnResults = [];
  for (const prompt of prompts) {
    turnResults.push(await runTurn(ws, prompt, { approveInterrupts }));
  }
  if (dynamicFollowUp) {
    // Persisting to a fresh table is naturally multi-round (CREATE TABLE,
    // then discovering it's empty, then INSERT, then the SQL narration
    // itself) — a fixed-length follow-up list can end right after the
    // confirmed write, before the model reaches for db_query. Keep asking
    // until a turn's own toolSequence shows db_query AND its answer states
    // an actual figure, rather than guessing "done" from a keyword (an
    // honest "I haven't inserted the rows yet" answer still mentions SQL).
    let next = dynamicFollowUp(turnResults);
    while (next) {
      turnResults.push(await runTurn(ws, next, { approveInterrupts: true }));
      next = dynamicFollowUp(turnResults);
    }
  } else {
    for (const prompt of followUps) {
      turnResults.push(await runTurn(ws, prompt, { approveInterrupts: true }));
    }
  }
  ws.close();
  return turnResults;
}

async function writeArtifact(extra = {}) {
  const payload = `${JSON.stringify({
    harness: "document-intelligence-skill-harness",
    runId: RUN_ID,
    phase: PHASE,
    fixtureSet: FIXTURE_SET,
    provider: EVALUATION_PROVIDER,
    model: EVALUATION_MODEL,
    period: expectations?.period ?? null,
    timeoutMs: TIMEOUT_MS,
    generatedAt: new Date().toISOString(),
    prompts: PHASE_PROMPTS[PHASE],
    ...(PHASE === "provenance" ? { provenanceLadder: PROVENANCE_LADDER_NAME } : {}),
    ...(FORCED_SKILLS.length ? { forcedSkills: FORCED_SKILLS } : {}),
    // Everything the grader reads that is NOT in `results`, so a replay grades
    // under the run's own conditions rather than the replaying shell's env.
    // Infinity is not representable in JSON (JSON.stringify writes null), and
    // null is exactly what the replay reads back as "no ceiling" — but record
    // it explicitly rather than leaning on that coincidence.
    gradingInputs: {
      household: HOUSEHOLD,
      oraclePath: ORACLE_PATH,
      wallClockTotalCeilingMs: Number.isFinite(WALLCLOCK_TOTAL_CEILING_MS) ? WALLCLOCK_TOTAL_CEILING_MS : null,
      wallClockPerTurnCeilingMs: Number.isFinite(WALLCLOCK_PER_TURN_CEILING_MS) ? WALLCLOCK_PER_TURN_CEILING_MS : null,
    },
    results,
    ...extra,
  }, null, 2)}\n`;
  await writeFile(ANSWERS_PATH, payload);
  // Per-run copy. Best effort on purpose: an un-writable archive dir must not
  // fail a run that otherwise completed — the single-slot artifact above is
  // still written, which is exactly the behaviour every earlier run had.
  try {
    await mkdir(RUN_ARCHIVE_DIR, { recursive: true });
    await writeFile(join(RUN_ARCHIVE_DIR, `${PHASE}-${RUN_ID}.json`), payload);
  } catch (error) {
    console.error(`HARNESS could not archive the per-run transcript: ${error?.message ?? error}`);
  }
}

try {
  const evaluationIsDeepSeek = EVALUATION_PROVIDER === "deepseek" && EVALUATION_MODEL === "deepseek-v4-flash";
  const evaluationIsCodexTerra = EVALUATION_PROVIDER === "codex" && EVALUATION_MODEL === "gpt-5.6-terra";
  const evaluationIsLlamaCpp = EVALUATION_PROVIDER === "llamacpp" && !!EVALUATION_MODEL;
  if (!evaluationIsDeepSeek && !evaluationIsCodexTerra && !evaluationIsLlamaCpp) {
    throw new Error("provenance harness requires DeepSeek deepseek-v4-flash, Codex gpt-5.6-terra, or an explicit llamacpp model (DOCINT_EVALUATION_PROVIDER=llamacpp + LLAMACPP_MODEL=...); refusing a fallback");
  }
  if (evaluationIsDeepSeek && !process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error("DeepSeek credentials are unavailable; refusing to fall back to a local model");
  }
  console.error(`HARNESS verified provider=${EVALUATION_PROVIDER} model=${EVALUATION_MODEL}`);
  oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const fixture = oracle.fixture_sets?.[FIXTURE_SET];
  if (!fixture) throw new Error(`oracle declares no fixture set named ${FIXTURE_SET}`);
  if (fixture.target_period) {
    expectations = buildExpectations(oracle, fixture.target_period, { corpusRoot: HOUSEHOLD });
  }

  scratch = mkdtempSync(join(tmpdir(), "aperio-document-intelligence-skill-"));
  const corpus = join(scratch, "corpus");
  const primary = join(corpus, "primary");
  const secondary = join(corpus, "secondary");
  const dbPath = join(scratch, "retrieval.sqlite");

  // The app imports local-runtime lifecycle helpers even for cloud providers.
  // Point their state, log-pruning, and shutdown lookup at an empty harness
  // root and unused port so this cloud run cannot inspect or stop a shared
  // llama.cpp process. No local engine is started or queried.
  isolatedLlamaPort = await freePort();
  Object.assign(process.env, {
    APERIO_LLAMACPP_RUNTIME_DIR: join(scratch, "isolated-local-runtime"),
    LLAMACPP_PORT: String(isolatedLlamaPort),
    LLAMACPP_BASE_URL: `http://127.0.0.1:${isolatedLlamaPort}`,
  });

  console.error(`HARNESS phase=${PHASE} fixture=${FIXTURE_SET}`);
  const copied = await copyFixtureSet(fixture, primary, secondary);
  console.error(`HARNESS copied primary=${copied.primary.join(",")} secondary=${copied.secondary.join(",") || "(none)"}`);

  console.error("HARNESS index");
  const indexed = await indexCorpus(primary, secondary, dbPath);
  console.error(`HARNESS indexed ${JSON.stringify(indexed)}`);

  if (SETUP_ONLY) {
    console.log(JSON.stringify({ status: "setup-ok", phase: PHASE, fixtureSet: FIXTURE_SET, copied, indexed }, null, 2));
  } else {
    await runModelPhase({ primary, secondary, dbPath, fixture });
  }
} catch (error) {
  console.error(`HARNESS failure ${error?.stack ?? error}`);
  const failedBeforeAnyAnswer = results.length === 0;
  await writeArtifact({ harnessError: String(error?.message ?? error) }).catch(() => {});
  process.exitCode = 1;
} finally {
  console.error("HARNESS cleanup");
  // The isolated llama-server's own stdout/stderr (var/llamacpp/server.log
  // under APERIO_LLAMACPP_RUNTIME_DIR — see startLlamaCpp.js's SERVER_LOG_PATH)
  // carries the per-request "slot get_availabl"/"slot launch_slot_"/"slot
  // print_timing" lines lib/helpers/promptCacheLog.js parses for real
  // cache-reuse evidence (selection kind, sim_best, f_keep) — richer than the
  // cache_n the OpenAI-shaped `timings` block alone exposes. Copy it out
  // BEFORE gracefulShutdown: stopLlamaCpp() (startLlamaCpp.js line ~236)
  // unlinks SERVER_LOG_PATH itself as part of normal shutdown bookkeeping, so
  // capturing after that call silently copies nothing (confirmed empty-handed
  // on the 2026-08-13 T-L4.3 run — the file was already gone by the time this
  // ran after gracefulShutdown).
  if (scratch) {
    try {
      await cp(join(scratch, "isolated-local-runtime", "server.log"), SERVER_LOG_CAPTURE_PATH);
      console.error(`HARNESS captured llama-server log -> ${SERVER_LOG_CAPTURE_PATH}`);
    } catch { /* e.g. non-llamacpp evaluation provider never wrote one */ }
  }
  await gracefulShutdown?.().catch(() => {});
  try { app?.httpServer?.close?.(); } catch { /* already closed */ }
  if (scratch) {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function runModelPhase({ primary, secondary, dbPath }) {
  console.error("HARNESS start");
  Object.assign(process.env, {
    PORT: String(webPort), APERIO_CONFIG_PRECEDENCE: "env", DB_BACKEND: "sqlite",
    SQLITE_PATH: dbPath,
    APERIO_ALLOWED_PATHS_TO_READ: `${primary},${secondary}`,
    APERIO_ALLOWED_PATHS_TO_WRITE: scratch,
    APERIO_DOCGRAPH: "off", APERIO_CODEGRAPH: "off",
    IDLE_SHUTDOWN: "off",
    APERIO_CLAUDE_CODE_CWD: scratch,
    AI_PROVIDER: EVALUATION_PROVIDER,
    ...(EVALUATION_PROVIDER === "deepseek"
      ? { DEEPSEEK_MODEL: EVALUATION_MODEL }
      : EVALUATION_PROVIDER === "llamacpp"
      ? { LLAMACPP_MODEL: EVALUATION_MODEL }
      : { CODEX_MODEL: EVALUATION_MODEL }),
    // The database tool writes only through Aperio's scratch runtime. Keep
    // Codex's native tools read-only so this shared repository cannot be
    // changed by an evaluation turn.
    CODEX_SANDBOX: "read-only",
    CODEX_APPROVAL_POLICY: "never",
    CODEX_MCP_APPROVAL_MODE: "approve",
    CODEX_IGNORE_RULES: "1",
    APERIO_ENABLE_SHELL: "off",
    // A boot-time wiki refresh must not inherit a local provider from .env.
    WIKI_REFRESH_AUTOSTART_LLAMACPP: "false",
    EMBEDDING_PROVIDER: "none",
  });
  const { createApp } = await import("../../../../lib/server.js");
  app = await createApp({ root: resolve("."), runtimeRoot: scratch, skipBoot: false, skipBrowser: true, autoListen: false });
  const boot = await app.bootAppOnce();
  gracefulShutdown = boot.gracefulShutdown;
  await new Promise((resolvePromise, reject) => {
    app.httpServer.once("error", reject);
    app.httpServer.listen(webPort, "127.0.0.1", resolvePromise);
  });
  webPort = app.httpServer.address().port;
  console.error(`HARNESS ready ${webPort}`);
  const stateRes = await fetch(`http://127.0.0.1:${webPort}/api/bootstrap/state`);
  console.error(`HARNESS bootstrap ${stateRes.status} ${(await stateRes.text()).slice(0, 180)}`);

  await writeArtifact();

  if (PHASE === "provenance") {
    console.error(`HARNESS provenance ladder=${PROVENANCE_LADDER_NAME}`);
    // Capped, condition-driven follow-up loop (see runPromptSequence) — a
    // fixed 2-turn budget observed the model finish the confirmed write and
    // then run out of turns before narrating the SQL-derived total back.
    // Follow-ups come from the resolved ladder (mechanism or natural, see
    // DOCINT_PROVENANCE_LADDER above) — index 0 is the opening turn already
    // in PHASE_PROMPTS.provenance, so the follow-up list starts at index 1.
    const followUpPrompts = PROVENANCE_LADDER_ENTRIES.slice(1).map(entry => entry.text);
    const followUpSatisfied = turns => {
      const last = turns.at(-1);
      if (!last || last.status !== "completed" || !last.toolSequence.includes("db_query")) return false;
      // The 2026-08-02 gemma4 run stopped the escalation ladder right here:
      // db_query ran, the answer was decimal-shaped prose, but the query had
      // come back empty (no INSERT had ever landed) and the model was openly
      // reciting a remembered breakdown instead. Require the db_query in THIS
      // turn to have actually returned rows before any prose is trusted —
      // otherwise the 2nd–8th escalation prompts (written for exactly this
      // scenario) never get sent.
      if (!dbQueryReturnedRows(last.toolCalls)) return false;
      const answer = String(last.answerRaw ?? "").trim();
      // A raw "✅ Executed on <connection>..." confirmation is the tool's own
      // ack for a write the model made mid-turn (e.g. fixing a missed row) —
      // it always contains digits (rowsAffected/lastInsertRowid), which made
      // the old bare /\d/ check false-positive on a turn that never actually
      // narrated a total back in prose. Require an actual decimal figure
      // (a stated amount, not just any digit) outside that ack shape.
      return hasNarratedDecimalTotal(answer);
    };
    const dynamicFollowUp = turns => {
      if (followUpSatisfied(turns)) return null;
      const askedSoFar = turns.length - PHASE_PROMPTS.provenance.length;
      return askedSoFar < Math.min(followUpPrompts.length, PROVENANCE_FOLLOW_UP_CAP)
        ? followUpPrompts[askedSoFar]
        : null;
    };
    const turns = await runPromptSequence(webPort, PHASE_PROMPTS.provenance, {
      approveInterrupts: true,
      dynamicFollowUp,
    });
    results.push(...turns);
  } else {
    for (const prompt of PHASE_PROMPTS[PHASE]) {
      results.push(...(await runPromptSequence(webPort, [prompt])));
    }
  }
  await writeArtifact();

  const grading = gradePhase({
    phase: PHASE,
    results,
    expectations,
    household: HOUSEHOLD,
    timeoutMs: TIMEOUT_MS,
    ladderName: PROVENANCE_LADDER_NAME,
    ladderEntries: PROVENANCE_LADDER_ENTRIES,
    wallClockTotalCeilingMs: WALLCLOCK_TOTAL_CEILING_MS,
    wallClockPerTurnCeilingMs: WALLCLOCK_PER_TURN_CEILING_MS,
  });
  await writeArtifact({ grading });
  // Per-gate verdicts print before the bundled ones: `status` ORs three
  // separate claims together (see grading.mjs), so on a fail it says only that
  // something in the flow went wrong, not which gate owns it.
  if (grading.gates) {
    for (const [id, gate] of Object.entries(grading.gates)) {
      console.error(`HARNESS gate ${id} ${gate.status.toUpperCase()}${gate.failures.length ? ` — ${gate.failures.length} failure(s)` : ""}`);
    }
  }
  console.log(JSON.stringify({
    phase: PHASE,
    status: grading.status,
    ...(grading.gates ? { gates: grading.gates } : {}),
    checks: grading.checks,
    failures: grading.failures,
    results: results.map(({ answerRaw, ...rest }) => ({
      ...rest,
      answer: String(answerRaw).replace(/\d[\d,. ]*/g, "[number]"),
    })),
  }, null, 2));
  if (grading.status !== "pass") process.exitCode = 2;
}
