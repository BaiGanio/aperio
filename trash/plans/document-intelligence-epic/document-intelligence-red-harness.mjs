// WS0-R isolated harness for the T-R5 gate.
//
//   node trash/plans/document-intelligence-epic/document-intelligence-red-harness.mjs
//
// Repaired 2026-07-26 against ground-truth-review.md §9. What changed and why:
//
//  * ONE oracle path. The oracle is read from the tracked test fixture, in this
//    process only. The previous build read /Users/lk/Projects/household/
//    ground-truth.json — a file that did not exist, inside the very folder the
//    model is allowed to read. Editing the repo copy had no effect on the gate.
//  * A CONTROLLED fixture set. The corpus now spans nine months; copying every
//    top-level household entry would silently change what T-R5 measures every
//    time the corpus grows. The fixture set is declared in the oracle and copied
//    path by path.
//  * A period-ANCHORED prompt. The harness runs in late July 2026 against a
//    corpus containing July records, so "this month" no longer meant June.
//  * A STRUCTURED gate. Bare numeral regexes are gone; harness-gate.mjs
//    associates each figure with the category it was claimed for, checks the
//    known failure signatures, exclusions and per-event coverage, and reports the
//    reason a run failed. Its mutation tests live beside it.
//  * TEARDOWN that holds. Scratch creation and oracle loading sit inside the
//    guarded region, `prompts` is declared before the try (it was referenced in
//    `finally` from a `const` inside `try`, so writing the final artifact threw),
//    and cleanup tolerates partial initialisation.

import "dotenv/config";
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomInt, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  buildExpectations,
  evaluateAnswer,
} from "../../../tests/fixtures/household-gen/harness-gate.mjs";

const HOUSEHOLD = process.env.HOUSEHOLD_ROOT ?? "/Users/lk/Projects/household";
const ORACLE_PATH = resolve(process.env.ORACLE_PATH ?? "tests/fixtures/household-gen/ground-truth.json");
// `--setup-only` exercises everything except the model: fixture copy, oracle
// fence, indexing and teardown. It is how the plumbing gets verified without
// spending a 300s model run, and how the failure paths get tested.
const SETUP_ONLY = process.argv.includes("--setup-only");
const ANSWERS_PATH = resolve("trash/plans/document-intelligence-epic/document-intelligence-run-answers.json");
const FIXTURE_SET = process.env.FIXTURE_SET ?? "T-R5";
let webPort = Number(process.env.APERIO_HARNESS_PORT ?? 0);
// Avoid a fixed shared llama port: concurrent harness/runtime sessions may
// legitimately occupy it. An explicit override remains available for probes
// that need a stable endpoint; otherwise choose a high localhost port without
// opening a probe socket (which is restricted in some sandboxed runners).
const LLAMA_PORT = Number(process.env.APERIO_HARNESS_LLAMA_PORT ?? 0) || randomInt(20_000, 60_000);
const TIMEOUT_MS = Number(process.env.APERIO_HARNESS_TIMEOUT_MS ?? 600_000);

// T-R5.1 (bare utilities) passed 2026-07-24 (4760b55/8baa106). T-R5.2 asks for
// the full month with no dedup or exclusion rules spelled out — the prompt names
// the period and nothing else. T-R5.3 (steered diagnostic) stays deferred.
const PROMPTS = [
  "How much did I spend in total in June 2026, broken down by category?",
];

let scratch = null;
let app;
let gracefulShutdown;
const results = [];
let expectations = null;
let oracle = null;

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
      // Directories keep their own name; single files are flattened into the
      // destination root so the model sees a plain folder of documents.
      const target = info.isDirectory()
        ? join(destination, relPath.split("/").pop())
        : join(destination, relPath.split("/").pop());
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
      copied[role].push(relPath);
    }
  }
  // The oracle must never reach a model-readable path.
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
    const secondaryStats = await indexRepo(store, secondary, { generateEmbedding: async () => null });
    return { primary: primaryStats, secondary: secondaryStats };
  } finally {
    await store.close();
  }
}

function runPrompt(port, prompt, promptId) {
  return new Promise((resolvePromise, reject) => {
    connect(port).then(({ ws }) => {
      const events = [];
      const started = Date.now();
      const finish = status => {
        const toolSequence = events.filter(event => event.type === "tool_start").map(event => event.name).filter(Boolean);
        const answer = events.filter(event => event.type === "stream_end").at(-1)?.text
          ?? events.filter(event => event.type === "token").map(event => event.text ?? "").join("");
        resolvePromise({
          promptId,
          prompt,
          wallMs: Date.now() - started,
          toolSequence,
          toolCalls: summarizeToolCalls(events),
          answerRaw: String(answer),
          status,
        });
      };
      const timer = setTimeout(() => {
        ws.close();
        finish("timeout");
      }, TIMEOUT_MS);
      ws.on("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      ws.on("message", raw => {
        const message = JSON.parse(raw.toString());
        events.push(message);
        if (message.type === "tool_start") {
          console.error(`HARNESS tool_start ${message.name} args=${JSON.stringify(message.arguments).slice(0, 300)}`);
        }
        if (message.type === "tool_result") {
          console.error(`HARNESS tool_result ${message.name} ok=${message.ok} ms=${message.ms} summary=${String(message.summary).slice(0, 200)}`);
        }
        if (message.type === "turn_complete") {
          clearTimeout(timer);
          ws.close();
          finish(message.status);
        }
      });
      ws.send(JSON.stringify({ type: "chat", text: prompt, turnId: randomUUID() }));
    }, reject);
  });
}

async function writeArtifact(extra = {}, { path = ANSWERS_PATH } = {}) {
  await writeFile(path, `${JSON.stringify({
    model: process.env.LLAMACPP_MODEL ?? null,
    fixtureSet: FIXTURE_SET,
    period: expectations?.period ?? null,
    timeoutMs: TIMEOUT_MS,
    generatedAt: new Date().toISOString(),
    oraclePath: ORACLE_PATH,
    expected: expectations
      ? { categoryTotals: expectations.categoryTotals, monthlyTotal: expectations.monthlyTotal }
      : null,
    prompts: PROMPTS.map((prompt, index) => ({ promptId: `P${index + 1}`, prompt })),
    results,
    ...extra,
  }, null, 2)}\n`);
}

try {
  oracle = JSON.parse(await readFile(ORACLE_PATH, "utf8"));
  const fixture = oracle.fixture_sets?.[FIXTURE_SET];
  if (!fixture) throw new Error(`oracle declares no fixture set named ${FIXTURE_SET}`);
  if (!fixture.target_period) throw new Error(`fixture set ${FIXTURE_SET} has no target period to grade against`);
  expectations = buildExpectations(oracle, fixture.target_period, { corpusRoot: HOUSEHOLD });

  scratch = mkdtempSync(join(tmpdir(), "aperio-document-intelligence-"));
  const corpus = join(scratch, "corpus");
  const primary = join(corpus, "primary");
  const secondary = join(corpus, "secondary");
  const dbPath = join(scratch, "retrieval.sqlite");

  console.error(`HARNESS fixture ${FIXTURE_SET} → ${fixture.target_period}`);
  const copied = await copyFixtureSet(fixture, primary, secondary);
  console.error(`HARNESS copied primary=${copied.primary.join(",")} secondary=${copied.secondary.join(",")}`);

  console.error("HARNESS index");
  const indexed = await indexCorpus(primary, secondary, dbPath);

  if (SETUP_ONLY) {
    console.log(JSON.stringify({
      status: "setup-ok",
      fixtureSet: FIXTURE_SET,
      period: fixture.target_period,
      copied,
      indexed,
      expected: { categoryTotals: expectations.categoryTotals, monthlyTotal: expectations.monthlyTotal },
      coverageDocuments: expectations.coverage.length,
      excludedDocuments: expectations.excluded.length,
      failureSignatures: expectations.signatures,
    }, null, 2));
  } else await runModelPhase({ primary, secondary, dbPath, fixture });
} catch (error) {
  console.error(`HARNESS failure ${error?.stack ?? error}`);
  // A setup failure produced no answers, so it must not overwrite the artifact of
  // the last real run — that artifact is the epic's evidence record. Errors before
  // any prompt completes go to a sidecar instead.
  const failedBeforeAnyAnswer = results.length === 0;
  await writeArtifact(
    { harnessError: String(error?.message ?? error) },
    { path: failedBeforeAnyAnswer ? ANSWERS_PATH.replace(/\.json$/, ".error.json") : ANSWERS_PATH },
  ).catch(() => {});
  process.exitCode = 1;
} finally {
  console.error("HARNESS cleanup");
  await gracefulShutdown?.().catch(() => {});
  try { app?.httpServer?.close?.(); } catch { /* already closed */ }
  if (scratch) {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function runModelPhase({ primary, secondary, dbPath, fixture }) {
  console.error("HARNESS start");
  Object.assign(process.env, {
    PORT: String(webPort), APERIO_CONFIG_PRECEDENCE: "env", DB_BACKEND: "sqlite",
    // Keep the llama-server child off the product default port. The harness
    // already owns a dedicated port; publish it before importing lib/server.js
    // because llamacpp/constants.js snapshots LLAMACPP_PORT at module load.
    LLAMACPP_PORT: String(LLAMA_PORT),
    LLAMACPP_BASE_URL: `http://127.0.0.1:${LLAMA_PORT}`,
    SQLITE_PATH: dbPath, APERIO_ALLOWED_PATHS_TO_READ: `${primary},${secondary}`,
    APERIO_ALLOWED_PATHS_TO_WRITE: scratch, APERIO_DOCGRAPH: "off", APERIO_CODEGRAPH: "off",
    // Isolates the claude-code provider's Agent SDK subprocess (if used) away
    // from this repo's real AGENTS.md/CLAUDE.md/git state — see APERIO_CLAUDE_CODE_CWD.
    APERIO_CLAUDE_CODE_CWD: scratch,
    AI_PROVIDER: process.env.AI_PROVIDER ?? "deepseek",
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
    LLAMACPP_MODEL: process.env.LLAMACPP_MODEL ?? "unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL",
    APERIO_CAPABLE_MODELS: process.env.APERIO_CAPABLE_MODELS ?? (
      process.env.AI_PROVIDER === "anthropic"
        ? (process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001")
        : process.env.AI_PROVIDER === "llamacpp"
          ? (process.env.LLAMACPP_MODEL ?? "unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL")
          : "deepseek-v4-pro"
    ),
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
  for (const [index, prompt] of PROMPTS.entries()) {
    console.error(`HARNESS prompt ${prompt.slice(0, 40)}`);
    results.push(await runPrompt(webPort, prompt, `P${index + 1}`));
    await writeArtifact();
    console.error(`HARNESS prompt done status=${results.at(-1).status}`);
    if (results.at(-1).status !== "completed") break;
  }

  const primaryResult = results[0] ?? { answerRaw: "", toolSequence: [], toolCalls: [] };
  const evaluation = evaluateAnswer({
    answer: primaryResult.answerRaw,
    toolSequence: primaryResult.toolSequence,
    toolCalls: primaryResult.toolCalls,
    expectations,
  });

  await writeArtifact({ evaluation });
  console.log(JSON.stringify({
    status: evaluation.status,
    period: fixture.target_period,
    expected: { categoryTotals: expectations.categoryTotals, monthlyTotal: expectations.monthlyTotal },
    gate: evaluation.gate,
    failures: evaluation.failures,
    detail: evaluation.detail,
    results: results.map(({ answerRaw, ...rest }) => ({
      ...rest,
      // Figures are masked in the console summary so a pasted log cannot become a
      // second, unreviewed copy of the answer key.
      answer: String(answerRaw).replace(/\d[\d,. ]*/g, "[number]"),
    })),
  }, null, 2));
  if (evaluation.status !== "pass") process.exitCode = 2;
}
