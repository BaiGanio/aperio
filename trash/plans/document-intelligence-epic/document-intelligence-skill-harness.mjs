// WS2 isolated harness for the T-G2 skill gate (issue #250).
//
//   DOCINT_PHASE=routing    node trash/plans/document-intelligence-epic/document-intelligence-skill-harness.mjs
//   DOCINT_PHASE=coverage   node trash/plans/document-intelligence-epic/document-intelligence-skill-harness.mjs
//   DOCINT_PHASE=provenance node trash/plans/document-intelligence-epic/document-intelligence-skill-harness.mjs
//
// Same isolation pattern as document-intelligence-red-harness.mjs (T-R5): scratch
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
import {
  buildExpectations,
  evaluateAnswer,
  parseCategoryClaims,
} from "../../../tests/fixtures/household-gen/harness-gate.mjs";

const HOUSEHOLD = process.env.HOUSEHOLD_ROOT ?? "/Users/lk/Projects/household";
const ORACLE_PATH = resolve(process.env.ORACLE_PATH ?? "tests/fixtures/household-gen/ground-truth.json");
const ANSWERS_PATH = resolve("trash/plans/document-intelligence-epic/document-intelligence-run-answers.json");
const PHASE = process.env.DOCINT_PHASE ?? "routing"; // routing | coverage | provenance
const SETUP_ONLY = process.argv.includes("--setup-only");
const FIXTURE_SET = PHASE === "coverage" ? "multi-month" : "T-R5";
let webPort = Number(process.env.APERIO_HARNESS_PORT ?? 0);
let isolatedLlamaPort = 0;
const TIMEOUT_MS = Number(process.env.APERIO_HARNESS_TIMEOUT_MS ?? 600_000);
// WS2 provenance is deliberately a cloud-provider verification. Keep this
// independent of .env's interactive-provider selection and never provide a
// llama.cpp setting from this harness. A caller must select one of the exact,
// recorded provider/model pairs below; it cannot silently fall back.
const EVALUATION_PROVIDER = process.env.DOCINT_EVALUATION_PROVIDER ?? "deepseek";
const EVALUATION_MODEL = process.env.DOCINT_EVALUATION_MODEL
  ?? (EVALUATION_PROVIDER === "codex" ? "gpt-5.6-terra" : "deepseek-v4-flash");
const PROVENANCE_FOLLOW_UP_CAP = 8;

const PHASE_PROMPTS = {
  // T-G2.1 bare-routing. Anchored to June 2026 (not "last month") because the
  // T-R5 fixture is graded against June and real wall-clock time has moved past
  // it — the epic's own evidence log used this same anchoring adjustment.
  routing: ["How much did I pay for utilities in June 2026?"],
  // T-G2.2 convergence-and-coverage against the oversized nine-period corpus.
  coverage: ["What did I spend on utilities across all of 2026? Tell me what you found and what you couldn't cover."],
  // T-G2.3/T-G2.4: full month, explicitly asked to be saved/queryable so the
  // skill has a reason to reach for db_execute/db_query instead of reporting a
  // one-shot figure.
  provenance: [
    "Add up everything I spent on documented bills and receipts for June 2026, broken down by category. Save the results so I can query them again later, and give me the total.",
  ],
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
  const { SqliteStore } = await import("../../../db/sqlite.js");
  const { indexRepo } = await import("../../../lib/docgraph/indexer.js");
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
    ws.send(JSON.stringify({ type: "chat", text: prompt, turnId: randomUUID() }));
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
  await writeFile(ANSWERS_PATH, `${JSON.stringify({
    harness: "document-intelligence-skill-harness",
    phase: PHASE,
    fixtureSet: FIXTURE_SET,
    provider: EVALUATION_PROVIDER,
    model: EVALUATION_MODEL,
    period: expectations?.period ?? null,
    timeoutMs: TIMEOUT_MS,
    generatedAt: new Date().toISOString(),
    prompts: PHASE_PROMPTS[PHASE],
    results,
    ...extra,
  }, null, 2)}\n`);
}

try {
  const evaluationIsDeepSeek = EVALUATION_PROVIDER === "deepseek" && EVALUATION_MODEL === "deepseek-v4-flash";
  const evaluationIsCodexTerra = EVALUATION_PROVIDER === "codex" && EVALUATION_MODEL === "gpt-5.6-terra";
  if (!evaluationIsDeepSeek && !evaluationIsCodexTerra) {
    throw new Error("provenance harness requires DeepSeek deepseek-v4-flash or Codex gpt-5.6-terra; refusing a fallback");
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
  const { createApp } = await import("../../../lib/server.js");
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
    // Capped, condition-driven follow-up loop (see runPromptSequence) — a
    // fixed 2-turn budget observed the model finish the confirmed write and
    // then run out of turns before narrating the SQL-derived total back.
    const followUpPrompts = [
      "Now give me the category breakdown and the grand total you just saved — query it per category (SUM grouped by category and currency), not from your own arithmetic.",
      "If the rows aren't in the table yet, finish saving them now (a single multi-row INSERT is fine — it's still one statement), then run the per-category SQL query and give me the breakdown and total.",
      "The rows should be saved by now — run SELECT category, currency, SUM(amount) GROUP BY category, currency against the extraction table now and give me the resulting breakdown and total.",
      "Run the per-category SQL query against the extraction table now and state the breakdown and total it returns, in your own words.",
      "You already ran that query earlier in this conversation — just restate its breakdown and total in your own words now, without calling any more tools.",
      "Answer now, in plain prose: what is the category breakdown and grand total from the extraction table you already queried?",
    ];
    const followUpSatisfied = turns => {
      const last = turns.at(-1);
      if (!last || last.status !== "completed" || !last.toolSequence.includes("db_query")) return false;
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

  const grading = gradePhase();
  await writeArtifact({ grading });
  console.log(JSON.stringify({
    phase: PHASE,
    status: grading.status,
    checks: grading.checks,
    failures: grading.failures,
    results: results.map(({ answerRaw, ...rest }) => ({
      ...rest,
      answer: String(answerRaw).replace(/\d[\d,. ]*/g, "[number]"),
    })),
  }, null, 2));
  if (grading.status !== "pass") process.exitCode = 2;
}

function gradePhase() {
  const failures = [];
  const checks = {};
  const RETRIEVAL_TOOLS = ["doc_manifest", "doc_batch", "doc_repos", "doc_search"];

  if (PHASE === "routing") {
    const r = results[0];
    const claims = parseCategoryClaims(r.answerRaw);
    const utilities = claims.get("Utilities") ?? [];
    // The auto doc_manifest→doc_batch preflight (WS0-R) resolves the manifest
    // step server-side and feeds its bounded, scored candidate list straight
    // into doc_batch's own arguments — it does not necessarily appear as a
    // second, separately-visible tool_start. A manifest-shaped candidate list
    // (selection_reason/score per entry, more than one document, no single
    // hardcoded path) is equally strong evidence that discovery preceded
    // reading; see the 2026-08-01/08-02 T-R5 evidence log, which records this
    // exact toolSequence:[doc_batch] shape as the passing pattern.
    const batchCall = r.toolCalls.find(c => c.name === "doc_batch");
    const candidates = batchCall?.arguments?.candidates ?? [];
    const manifestShaped = candidates.length > 0 && candidates.every(c => "selection_reason" in c || "score" in c);
    checks.usedManifestThenBatch =
      r.toolSequence.includes("doc_batch") &&
      (r.toolSequence.indexOf("doc_manifest") === -1
        ? manifestShaped
        : r.toolSequence.indexOf("doc_manifest") < r.toolSequence.indexOf("doc_batch"));
    checks.noPerFileLoop = r.toolSequence.filter(t => t === "doc_batch").length <= 1;
    checks.utilitiesExact = utilities.some(v => Math.abs(v - 260.5) < 0.005);
    checks.noHardcodedFolderPath = !r.answerRaw.includes(HOUSEHOLD);
    checks.completed = r.status === "completed";
    if (!checks.usedManifestThenBatch) failures.push("did not route through a bounded manifest before doc_batch");
    if (!checks.noPerFileLoop) failures.push("doc_batch was called more than once (per-file loop)");
    if (!checks.utilitiesExact) failures.push(`Utilities not exact — found ${utilities.join("/") || "nothing"}`);
    if (!checks.noHardcodedFolderPath) failures.push("answer leaked the private corpus path");
    if (!checks.completed) failures.push(`turn did not complete (status=${r.status})`);
  }

  if (PHASE === "coverage") {
    const r = results[0];
    checks.completedOrBounded = r.status === "completed" || r.status === "timeout";
    // See the routing-phase comment: the auto-preflight may resolve the
    // manifest step server-side and surface only doc_batch, with the bounded
    // candidate list visible in its own arguments.
    const batchCall = r.toolCalls.find(c => c.name === "doc_batch");
    const candidates = batchCall?.arguments?.candidates ?? [];
    const manifestShaped = candidates.length > 0 && candidates.every(c => "selection_reason" in c || "score" in c);
    checks.enumeratedBeforeReading =
      r.toolSequence.includes("doc_manifest") || r.toolSequence.includes("doc_repos") ||
      (r.toolSequence.includes("doc_batch") && manifestShaped);
    // With 200+ documents against a 48-candidate bound, an honest answer must
    // disclose that it did not cover everything — either explicit coverage
    // counts (found/read/skipped) or plain language admitting a partial scope.
    checks.disclosesCoverageOrBound = /\b\d+\s*(of|out of)\s*\d+|found|read|skipped|covered|not all|partial|limited to|only (checked|read)/i.test(r.answerRaw);
    checks.noOracleExposure = !/ground[- ]truth|oracle|answer key/i.test(r.answerRaw);
    checks.noHardcodedFolderPath = !r.answerRaw.includes(HOUSEHOLD);
    if (r.status === "timeout") failures.push(`timed out at ${TIMEOUT_MS}ms without reporting a bound before the cutoff`);
    if (!checks.enumeratedBeforeReading) failures.push("did not build a manifest before batch-reading");
    if (!checks.disclosesCoverageOrBound) failures.push("answer does not disclose coverage or an explicit bound over the oversized corpus");
    if (!checks.noOracleExposure) failures.push("the answer references the oracle");
    if (!checks.noHardcodedFolderPath) failures.push("answer leaked the private corpus path");
  }

  if (PHASE === "provenance") {
    const proposeTurn = results[0];
    const followUpTurn = results.at(-1);
    const allToolNames = results.flatMap(r => r.toolSequence);
    checks.calledDbExecute = allToolNames.includes("db_execute");
    checks.interruptApproved = results.some(r => r.interruptApproved);
    checks.calledDbQueryAfterConfirm = followUpTurn?.toolSequence.includes("db_query") ?? false;
    checks.followUpCitesSql = /sql|query|db_query/i.test(followUpTurn?.answerRaw ?? "");
    checks.followUpNarratesDecimalTotal = hasNarratedDecimalTotal(followUpTurn?.answerRaw);
    checks.completed = results.every(r => r.status === "completed");
    if (!checks.calledDbExecute) failures.push("db_execute was never proposed — no writable-destination path exercised");
    if (checks.calledDbExecute && !checks.interruptApproved) failures.push("db_execute was proposed but the confirm interrupt was never observed/approved");
    if (!checks.calledDbQueryAfterConfirm) failures.push("follow-up turn did not call db_query for the SQL-derived total");
    if (!checks.followUpCitesSql) failures.push("follow-up answer does not cite SQL as the source of the figure");
    if (!checks.followUpNarratesDecimalTotal) failures.push("follow-up answer does not narrate an actual decimal total");
    if (!checks.completed) failures.push("one or more turns did not complete");

    if (expectations) {
      const combinedAnswer = results.map(r => r.answerRaw).join("\n---\n");
      const evaluation = evaluateAnswer({
        answer: combinedAnswer,
        toolSequence: allToolNames,
        toolCalls: results.flatMap(r => r.toolCalls),
        expectations,
      });
      checks.fullMonthGate = evaluation.status === "pass";
      checks.noFxBlend = evaluation.gate.noExcludedLeak;
      if (!checks.fullMonthGate) failures.push(...evaluation.failures.map(f => `full-month gate: ${f}`));
    }
  }

  return { status: failures.length === 0 ? "pass" : "fail", checks, failures };
}

function hasNarratedDecimalTotal(answer) {
  const text = String(answer ?? "").trim();
  if (!text || /^✅\s*Executed on/i.test(text)) return false;
  const amount = "(?:BGN|EUR|USD|GBP|\\$|€|£)?\\s*\\d{1,3}(?:[ .]\\d{3})*[.,]\\d{2}";
  return new RegExp(`(?:grand\\s+)?total(?:\\s+\\w+){0,5}\\s*(?:is|:|=|was)?\\s*${amount}|${amount}\\s*(?:BGN|EUR|USD|GBP)?\\s*(?:grand\\s+)?total`, "i").test(text);
}
