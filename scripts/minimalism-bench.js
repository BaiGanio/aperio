#!/usr/bin/env node
// scripts/minimalism-bench.js — WS2 of epic #285 (ponytail-borrow-ws2.md).
//
// Runs the code-minimalism before/after eval matrix (task × arm × repeat)
// in-process: createAgent + makeSinkEmitter + runWithPaths, the same pattern
// tests/harness/run-scenario.js uses. The MCP client is stubbed exactly like
// that harness (no real subprocess, no network, no real DB) — the only tools
// available to the model are the synthetic write_file/read_file/list_files
// below, scoped to the sandbox's workspace/.
//
// --dry-run replays a deterministic mock script built from each fixture's
// reference/ solution, so the whole pipeline (sandbox, metrics, ledger) is
// exercised in CI with no live model. Without --dry-run the provider is live
// llama.cpp (Step 5 — not wired up by WS2; wiring the live run and posting
// the verdict to #285 is a separate, explicitly-gated step).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../lib/agent.js";
import { makeSinkEmitter } from "../lib/emitters/sinkEmitter.js";
import { runWithPaths } from "../lib/routes/paths.js";
import {
  REPO_ROOT, buildSandbox, sha256File, snapshotDir, locDelta, sumUsage, collectCellMetrics,
  runFixtureTests, appendLedgerRow, computeVerdict, isMatrixComplete, renderTranscript, renderReport,
  DUPLICATE_FAILURE_BUDGET, EVAL_MODE,
} from "../lib/helpers/minimalismBench.js";
import {
  LIVE_EVAL_BASE_URL, createLiveEvalPaths, waitForLlamaReadiness,
  assertLiveUsage, startIsolatedLlamaEval, teardownLiveEval,
} from "../lib/helpers/minimalismLiveEval.js";

const FIXTURES_DIR = resolve(REPO_ROOT, "tests/fixtures/minimalism-tasks");
const LEDGER_PATH = resolve(REPO_ROOT, "var/autotune/minimalism.tsv");
const SKILL_MD_PATH = resolve(REPO_ROOT, "skills/code-minimalism/SKILL.md");
const LIVE_BOOTSTRAP_PATH = resolve(REPO_ROOT, "scripts/minimalism-live-server.js");

export function parseArgs(argv) {
  const args = { dryRun: false, tasks: null, repeats: 3, verdict: false, model: null, existingServer: false, provider: "llamacpp" };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verdict") args.verdict = true;
    else if (arg.startsWith("--tasks=")) args.tasks = arg.slice("--tasks=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--repeats=")) args.repeats = parseInt(arg.slice("--repeats=".length), 10);
    else if (arg.startsWith("--model=")) args.model = arg.slice("--model=".length);
    else if (arg === "--existing-server") args.existingServer = true;
    else if (arg.startsWith("--provider=")) args.provider = arg.slice("--provider=".length);
  }
  return args;
}

export function loadFixtures(taskIds) {
  const all = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  const ids = taskIds?.length ? taskIds : all;
  return ids.map(id => {
    const dir = join(FIXTURES_DIR, id);
    const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
    return { ...task, dir, testsDir: join(dir, "tests"), referenceDir: join(dir, "reference"), seedDir: join(dir, "seed") };
  });
}

// Same technique as tests/harness/run-scenario.js's stubMcpTransport: reaching
// the real MCP boundary is a bug in this eval, not a feature — every tool the
// model can call must be one of the synthetic ones below.
function stubMcp() {
  StdioClientTransport.prototype.start = async () => {};
  StdioClientTransport.prototype.close = async () => {};
  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({ tools: [] });
  Client.prototype.callTool = async () => {
    throw new Error("minimalism-bench reached the real MCP boundary — every tool this eval uses must be a host tool");
  };
}

const recallSchema = { type: "object", properties: {}, additionalProperties: false };
const writeFileSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Relative file path inside the workspace, for example debounce.js." },
    content: { type: "string", description: "Complete UTF-8 file contents to write." },
  },
  required: ["path", "content"],
  additionalProperties: false,
};
const readFileSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Relative file path inside the workspace, not the workspace directory itself." },
  },
  required: ["path"],
  additionalProperties: false,
};
const listFilesSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Relative directory path inside the workspace; use . for the workspace root." },
  },
  additionalProperties: false,
};

export const BENCH_TOOL_ALLOWLIST = Object.freeze(["recall", "read_file", "write_file", "list_files"]);

const WORKSPACE_INSTRUCTIONS = [
  "Work in the temporary workspace. Use relative file paths (for example `debounce.js`), never the workspace directory or an absolute path, with `read_file`/`write_file`.",
  "Use `list_files` with `.` for the workspace root. Finish by writing the requested implementation with `write_file`, not only describing it.",
].join("\n");

export function buildBenchPrompt(fixture) {
  return `${WORKSPACE_INSTRUCTIONS}\n\nTask:\n${fixture.prompt}`;
}

// `emitter` is optional (existing dry-run tests call this with one arg) — when
// given, every call is recorded into its event stream alongside the model's
// stream_start/token/stream_end events, so a transcript built from that
// stream sees tool calls and assistant turns in the order they actually
// happened, not two separately-ordered lists.
//
// `onDuplicateFailureBudgetExceeded` (optional) fires once a given tool
// call's (name, args) signature has failed DUPLICATE_FAILURE_BUDGET times
// across the WHOLE cell — not per turn, unlike tool-safety-middleware's own
// loop-break, which resets every turn and so never bounds a model that gets
// stopped, retries a different way, and repeats the same failure again in a
// later turn (issue #336).
export function createBenchHostTools(workspaceDir, emitter = null, { onDuplicateFailureBudgetExceeded } = {}) {
  // A raw prefix check (`abs.startsWith(workspaceDir + "/")`) breaks on
  // Windows, where resolve() returns backslash-separated paths — relative()
  // is the platform-correct containment check on both POSIX and Windows.
  const safe = (relPath) => {
    const abs = resolve(workspaceDir, relPath ?? "");
    const rel = relative(workspaceDir, abs);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return abs;
  };
  // Display-only: some tool-call plumbing upstream of these handlers resolves
  // a "path" arg to its sandbox-absolute form before the handler ever sees
  // it, which is correct for the actual read/write below but unreadable in a
  // transcript — a temp-dir-prefixed path per cell, every cell.
  const displayPath = (p) => (p && isAbsolute(p) ? (relative(workspaceDir, p) || ".") : p);
  const fileTarget = (abs, requestedPath, operation) => {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return `❌ ${operation} path must name a file, not a directory: ${displayPath(requestedPath) || "."}. Use a filename such as debounce.js.`;
    }
    return null;
  };
  const failureSignatureCounts = new Map();
  let budgetTripped = false;
  const record = (name, args, result) => {
    const displayArgs = args?.path ? { ...args, path: displayPath(args.path) } : args;
    emitter?.send({ type: "tool_call", name, args: displayArgs, result });
    if (!budgetTripped && typeof result === "string" && result.startsWith("❌")) {
      const signature = `${name}:${JSON.stringify(args ?? {})}`;
      const count = (failureSignatureCounts.get(signature) || 0) + 1;
      failureSignatureCounts.set(signature, count);
      if (count >= DUPLICATE_FAILURE_BUDGET) {
        budgetTripped = true;
        onDuplicateFailureBudgetExceeded?.({ name, args, count });
      }
    }
    return result;
  };
  return [
    // createAgent's preflight unconditionally probes "recall" once per turn
    // (lib/agent/preflight.js) — a neutral stub keeps that path quiet, same
    // reason tests/harness/host-tools.js stubs it.
    { name: "recall", description: "Recall stored memories", inputSchema: recallSchema,
      handler: async (args) => record("recall", args, "No memories found.") },
    { name: "write_file", description: "Write a complete file using a relative file path; do not pass the workspace directory", inputSchema: writeFileSchema,
      handler: async (args) => {
        const abs = safe(args?.path);
        const targetError = fileTarget(abs, args?.path, "write_file");
        if (targetError) return record("write_file", args, targetError);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, args?.content ?? "", "utf8");
        return record("write_file", args, `wrote ${displayPath(args?.path)}`);
      } },
    { name: "read_file", description: "Read one file using a relative file path; do not pass the workspace directory", inputSchema: readFileSchema,
      handler: async (args) => {
        const abs = safe(args?.path);
        const targetError = fileTarget(abs, args?.path, "read_file");
        const result = targetError || (existsSync(abs) ? readFileSync(abs, "utf8") : `❌ ${displayPath(args?.path)} not found`);
        return record("read_file", args, result);
      } },
    { name: "list_files", description: "List files in a workspace directory; use . for the workspace root", inputSchema: listFilesSchema,
      handler: async (args) => {
        const abs = safe(args?.path ?? ".");
        const result = !existsSync(abs) ? `❌ ${args?.path ?? "."} not found` : (readdirSync(abs).join("\n") || "(empty)");
        return record("list_files", args, result);
      } },
  ];
}

/** Deterministic dry-run replay: writes the fixture's reference/ solution verbatim. */
export function buildMockScript(fixture) {
  const solution = snapshotDir(fixture.referenceDir);
  const script = [...solution.entries()].map(([relPath, content]) => ({
    tool: "write_file", args: { path: relPath, content },
  }));
  script.push({ text: `Added the minimal solution for ${fixture.id}.` });
  return script;
}

const activeSandboxes = new Set();

async function runOneCell({ fixture, arm, repeat, dryRun, skillSha, model, discard = false, transcriptDir = null, progress = null, provider = "llamacpp" }) {
  const sandbox = buildSandbox({ arm });
  activeSandboxes.add(sandbox);
  const label = `${fixture.id}/${arm}/repeat${repeat}${discard ? " (warm-up)" : ""}`;
  if (progress) console.log(`▶ [${progress.index}/${progress.total}] ${label}`);
  try {
    if (existsSync(fixture.seedDir)) cpSync(fixture.seedDir, sandbox.workspaceDir, { recursive: true });
    const before = snapshotDir(sandbox.workspaceDir);

    // Created before createAgent so the host tools can record into the SAME
    // event stream the model's own stream_start/token/stream_end land in —
    // one chronologically-ordered log, not two lists a transcript has to
    // re-interleave by guesswork.
    const sink = makeSinkEmitter();
    const providerConfig = dryRun ? { name: "mock", script: buildMockScript(fixture) } : { name: provider, model };
    // The provider loops store their in-flight AbortController here via
    // setAbort() every request and check getAbort()?.signal?.aborted at the
    // top of the next iteration (see e.g. lib/agent/providers/llamacpp.js) —
    // the same mechanism a UI "stop" button uses. Tripping the duplicate-
    // failure budget below calls .abort() on whatever's currently stored,
    // which lands between the failing tool call and the loop's next request.
    const abortBox = { controller: null };
    let duplicateFailureBudget = null;
    const agent = await createAgent({
      root: sandbox.root,
      version: "1.0.0-minimalism-bench",
      providerConfig,
      spec: { id: "minimalism-bench", toolAllowlist: BENCH_TOOL_ALLOWLIST },
      hostTools: createBenchHostTools(sandbox.workspaceDir, sink.emitter, {
        onDuplicateFailureBudgetExceeded: (info) => {
          duplicateFailureBudget = info;
          abortBox.controller?.abort();
        },
      }),
    });
    const messages = [{ role: "user", content: buildBenchPrompt(fixture) }];
    const startedAt = Date.now();
    await runWithPaths([sandbox.root], [sandbox.root], sandbox.workspaceDir, () =>
      agent.runAgentLoop(messages, sink.emitter, {}, () => abortBox.controller, (c) => { abortBox.controller = c; }));
    const wallMs = Date.now() - startedAt;
    const outcome = duplicateFailureBudget
      ? `duplicate_failure_budget_exceeded(${duplicateFailureBudget.name},${duplicateFailureBudget.count}x)`
      : "completed";

    const after = snapshotDir(sandbox.workspaceDir);
    const usage = sumUsage(sink.events);
    const metrics = collectCellMetrics(sink.events);
    const correct = runFixtureTests({ testsDir: fixture.testsDir, solutionDir: sandbox.workspaceDir });
    const loc = locDelta(before, after);

    const row = {
      ts: new Date().toISOString(),
      task: fixture.id,
      arm,
      repeat,
      loc,
      input_tokens: usage.input,
      output_tokens: usage.output,
      net_tokens: usage.net,
      request_count: metrics.requestCount,
      tool_call_count: metrics.toolCallCount,
      tool_error_count: metrics.toolErrorCount,
      duplicate_call_count: metrics.duplicateCallCount,
      context_trim_count: metrics.contextTrimCount,
      max_input_tokens: metrics.maxInputTokens,
      correct,
      outcome,
      wall_ms: wallMs,
      model: agent.provider?.model ?? "",
      mode: EVAL_MODE,
      skill_sha: skillSha,
    };
    // A discarded warm-up exists only to pay the cold model-load/cache cost
    // before the recorded matrix starts — it must never land in the ledger.
    if (!discard && !dryRun) assertLiveUsage(row);

    if (transcriptDir) {
      mkdirSync(transcriptDir, { recursive: true });
      const meta = {
        task: fixture.id, arm, repeat, discard, model: row.model, mode: row.mode, correct, outcome, loc,
        inputTokens: usage.input, outputTokens: usage.output, netTokens: usage.net,
        requestCount: metrics.requestCount, toolCallCount: metrics.toolCallCount,
        toolErrorCount: metrics.toolErrorCount, duplicateCallCount: metrics.duplicateCallCount,
        contextTrimCount: metrics.contextTrimCount, maxInputTokens: metrics.maxInputTokens,
        wallMs, prompt: fixture.prompt,
      };
      const transcriptPath = join(transcriptDir, `${fixture.id}-${arm}-repeat${repeat}${discard ? "-warmup" : ""}.md`);
      writeFileSync(transcriptPath, renderTranscript(meta, sink.events), "utf8");
    }
    if (progress) console.log(`  ${correct ? "✔" : "✖"} correct=${correct ? "yes" : "no"} tokens=${usage.input}/${usage.output}/${usage.net} wall=${wallMs}ms`);
    return row;
  } finally {
    sandbox.cleanup();
    activeSandboxes.delete(sandbox);
  }
}

/** A/B/B/A alternation across repeats, so cache/thermal drift never lands on one arm. */
export function buildRunPlan(repeats) {
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    plan.push(...(repeat % 2 === 1 ? [{ repeat, arm: "A" }, { repeat, arm: "B" }] : [{ repeat, arm: "B" }, { repeat, arm: "A" }]));
  }
  return plan;
}

/**
 * Per-fixture cell plan: a discarded warm-up per arm (live runs only) ahead
 * of the recorded A/B/B/A matrix. Arm A and arm B load a DIFFERENT skills/
 * tree (code-minimalism/ present vs. removed — see buildSandbox), so they
 * warm a different prompt cache; warming only arm A (the original approach)
 * left arm B measured cold on every fixture, biasing latency/cache-sensitive
 * results in arm A's favor. Warming both arms independently keeps the
 * treatment symmetric. The mock provider has no cache/thermal state, so a
 * dry run skips both warm-ups.
 */
export function buildFixtureCellPlan({ dryRun, repeats }) {
  const plan = [];
  if (!dryRun) plan.push({ repeat: 0, arm: "A", discard: true }, { repeat: 0, arm: "B", discard: true });
  for (const cell of buildRunPlan(repeats)) plan.push({ ...cell, discard: false });
  return plan;
}

export async function runMatrix({ dryRun, taskIds, repeats, model = process.env.LLAMACPP_MODEL, ledgerPath = LEDGER_PATH, live = {}, provider = "llamacpp", verdict = false }) {
  if (dryRun) {
    // The mock provider refuses to resolve outside NODE_ENV=test
    // (lib/providers/index.js) — set it rather than silently falling through
    // to a real provider.
    process.env.NODE_ENV = "test";
  }
  stubMcp();
  const fixtures = loadFixtures(taskIds);
    const liveHandle = dryRun ? null : live.handle;
  const liveUrl = live.baseURL || LIVE_EVAL_BASE_URL;
  const isCloud = provider !== "llamacpp";
  if (!dryRun && !isCloud && !model) throw new Error("live eval requires --model=<huggingface-repo[:quant]>");
  if (!dryRun && !isCloud && !liveHandle) throw new Error("live eval server was not started by the evaluator");
  if (!dryRun && !isCloud) await waitForLlamaReadiness({ baseURL: liveUrl, model, fetchImpl: live.fetchImpl });
  const skillSha = sha256File(SKILL_MD_PATH);

  // resolveProvider() (lib/providers/index.js) reads process.env.LLAMACPP_BASE_URL
  // directly and has no override path through providerConfig — the isolated
  // server's port only reaches the evaluator-owned CHILD process's env
  // (startIsolatedLlamaEval's spawn). Without this, every inference call in
  // THIS process falls back to the hardcoded default 127.0.0.1:8080 instead
  // of the isolated evaluator server, silently defeating the isolation.
  const priorBaseURL = process.env.LLAMACPP_BASE_URL;
  if (!dryRun && !isCloud) process.env.LLAMACPP_BASE_URL = liveUrl;

  try {
    const outputLedger = ledgerPath || LEDGER_PATH;
    mkdirSync(dirname(outputLedger), { recursive: true });
    const ledgerName = basename(outputLedger, ".tsv");
    // Sibling to the ledger, not inside it — a browser or `less` opens these
    // directly; nothing here is a server this eval has any business running.
    const transcriptDir = join(dirname(outputLedger), "transcripts", ledgerName);
    const reportPath = join(dirname(outputLedger), `${ledgerName}.report.md`);

    const cellPlan = [];
    for (const fixture of fixtures) {
      for (const cell of buildFixtureCellPlan({ dryRun, repeats })) cellPlan.push({ fixture, ...cell });
    }

    // Each completed cell is appended to the ledger and the report re-rendered
    // IMMEDIATELY, not batched until the whole matrix finishes — an
    // interrupted run (killed, crashed, out of budget) otherwise has
    // transcripts on disk but no ledger row and no report for the cells it
    // did complete, discarding real (and expensive) evidence.
    const rows = [];
    let index = 0;
    for (const { fixture, repeat, arm, discard } of cellPlan) {
      index++;
      const row = await runOneCell({
        fixture, arm, repeat, dryRun, skillSha, model, discard, transcriptDir,
        progress: { index, total: cellPlan.length }, provider,
      });
      if (!discard) {
        rows.push(row);
        appendLedgerRow(outputLedger, row);
        writeFileSync(reportPath, renderReport(rows, { fixtures, repeats }), "utf8");
      }
    }

    console.log(`[minimalism-bench] ledger:      ${outputLedger}`);
    console.log(`[minimalism-bench] report:      ${reportPath}`);
    console.log(`[minimalism-bench] transcripts: ${transcriptDir}`);
    if (verdict) {
      console.log(isMatrixComplete(rows, fixtures, repeats)
        ? computeVerdict(rows)
        : `INCOMPLETE — ${rows.length}/${fixtures.length * repeats * 2} expected cells recorded, verdict withheld`);
    }
    return rows;
  } finally {
    if (!dryRun && !isCloud) {
      if (priorBaseURL === undefined) delete process.env.LLAMACPP_BASE_URL;
      else process.env.LLAMACPP_BASE_URL = priorBaseURL;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isCloudProvider = args.provider !== "llamacpp";
  let liveHandle = null;
  const onSignal = () => {
    for (const sandbox of activeSandboxes) sandbox.cleanup();
    void teardownLiveEval(liveHandle).finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (!args.dryRun && !args.existingServer && !isCloudProvider) {
      const model = args.model || process.env.LLAMACPP_MODEL;
      const paths = createLiveEvalPaths(model);
      liveHandle = startIsolatedLlamaEval({ model, paths, bootstrapPath: LIVE_BOOTSTRAP_PATH });
      liveHandle.child.on("exit", (code) => {
        if (code !== null && code !== 0) console.error(`isolated llama-server exited before matrix completion (code ${code})`);
      });
    }
    const liveInfo = { handle: liveHandle };
    if (args.existingServer) {
      liveInfo.handle = { noop: true };
      liveInfo.baseURL = `http://127.0.0.1:8080`;
      liveInfo.fetchImpl = globalThis.fetch;
    }
    await runMatrix({ dryRun: args.dryRun, taskIds: args.tasks, repeats: args.repeats, model: args.model, ledgerPath: liveHandle?.ledgerPath, live: liveInfo, provider: args.provider, verdict: args.verdict });
  } finally {
    if (!args.existingServer && !isCloudProvider) await teardownLiveEval(liveHandle);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(err => { console.error(err); process.exit(1); });
}
