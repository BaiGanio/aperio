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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../lib/agent.js";
import { makeSinkEmitter } from "../lib/emitters/sinkEmitter.js";
import { runWithPaths } from "../lib/routes/paths.js";
import {
  REPO_ROOT, buildSandbox, sha256File, snapshotDir, locDelta, sumUsage,
  runFixtureTests, appendLedgerRow, computeVerdict,
} from "../lib/helpers/minimalismBench.js";

const FIXTURES_DIR = resolve(REPO_ROOT, "tests/fixtures/minimalism-tasks");
const LEDGER_PATH = resolve(REPO_ROOT, "var/autotune/minimalism.tsv");
const SKILL_MD_PATH = resolve(REPO_ROOT, "skills/code-minimalism/SKILL.md");

export function parseArgs(argv) {
  const args = { dryRun: false, tasks: null, repeats: 3, verdict: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--verdict") args.verdict = true;
    else if (arg.startsWith("--tasks=")) args.tasks = arg.slice("--tasks=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--repeats=")) args.repeats = parseInt(arg.slice("--repeats=".length), 10);
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

const genericSchema = { type: "object", properties: {}, additionalProperties: true };

export function createBenchHostTools(workspaceDir) {
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
  return [
    // createAgent's preflight unconditionally probes "recall" once per turn
    // (lib/agent/preflight.js) — a neutral stub keeps that path quiet, same
    // reason tests/harness/host-tools.js stubs it.
    { name: "recall", description: "Recall stored memories", inputSchema: genericSchema,
      handler: async () => "No memories found." },
    { name: "write_file", description: "Write a file in the workspace", inputSchema: genericSchema,
      handler: async (args) => {
        const abs = safe(args?.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, args?.content ?? "", "utf8");
        return `wrote ${args?.path}`;
      } },
    { name: "read_file", description: "Read a file from the workspace", inputSchema: genericSchema,
      handler: async (args) => {
        const abs = safe(args?.path);
        return existsSync(abs) ? readFileSync(abs, "utf8") : `❌ ${args?.path} not found`;
      } },
    { name: "list_files", description: "List files in the workspace", inputSchema: genericSchema,
      handler: async (args) => {
        const abs = safe(args?.path ?? ".");
        if (!existsSync(abs)) return `❌ ${args?.path ?? "."} not found`;
        return readdirSync(abs).join("\n") || "(empty)";
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

async function runOneCell({ fixture, arm, repeat, dryRun, skillSha, discard = false }) {
  const sandbox = buildSandbox({ arm });
  activeSandboxes.add(sandbox);
  try {
    if (existsSync(fixture.seedDir)) cpSync(fixture.seedDir, sandbox.workspaceDir, { recursive: true });
    const before = snapshotDir(sandbox.workspaceDir);

    const providerConfig = dryRun ? { name: "mock", script: buildMockScript(fixture) } : { name: "llamacpp" };
    const agent = await createAgent({
      root: sandbox.root,
      version: "1.0.0-minimalism-bench",
      providerConfig,
      hostTools: createBenchHostTools(sandbox.workspaceDir),
    });
    const sink = makeSinkEmitter();
    const messages = [{ role: "user", content: fixture.prompt }];
    const startedAt = Date.now();
    await runWithPaths([sandbox.root], [sandbox.root], sandbox.workspaceDir, () =>
      agent.runAgentLoop(messages, sink.emitter, {}, () => null, () => {}));
    const wallMs = Date.now() - startedAt;

    const after = snapshotDir(sandbox.workspaceDir);
    const usage = sumUsage(sink.events);
    const correct = runFixtureTests({ testsDir: fixture.testsDir, solutionDir: sandbox.workspaceDir });

    const row = {
      ts: new Date().toISOString(),
      task: fixture.id,
      arm,
      repeat,
      loc: locDelta(before, after),
      input_tokens: usage.input,
      output_tokens: usage.output,
      net_tokens: usage.net,
      correct,
      wall_ms: wallMs,
      model: agent.provider?.model ?? "",
      skill_sha: skillSha,
    };
    // A discarded warm-up exists only to pay the cold model-load/cache cost
    // before the recorded matrix starts — it must never land in the ledger.
    if (!discard) appendLedgerRow(LEDGER_PATH, row);
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
 * Per-fixture cell plan: a discarded warm-up (live runs only) ahead of the
 * recorded A/B/B/A matrix. Without it, the first measured cell for every
 * fixture is always arm A on a cold model/cache (arm A always runs first —
 * see buildRunPlan), biasing the comparison in arm B's favor. The mock
 * provider has no cache/thermal state, so a dry run skips the warm-up.
 */
export function buildFixtureCellPlan({ dryRun, repeats }) {
  const plan = [];
  if (!dryRun) plan.push({ repeat: 0, arm: "A", discard: true });
  for (const cell of buildRunPlan(repeats)) plan.push({ ...cell, discard: false });
  return plan;
}

export async function runMatrix({ dryRun, taskIds, repeats }) {
  if (dryRun) {
    // The mock provider refuses to resolve outside NODE_ENV=test
    // (lib/providers/index.js) — set it rather than silently falling through
    // to a real provider.
    process.env.NODE_ENV = "test";
  }
  stubMcp();
  const fixtures = loadFixtures(taskIds);
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  const skillSha = sha256File(SKILL_MD_PATH);

  const rows = [];
  for (const fixture of fixtures) {
    for (const { repeat, arm, discard } of buildFixtureCellPlan({ dryRun, repeats })) {
      const row = await runOneCell({ fixture, arm, repeat, dryRun, skillSha, discard });
      if (!discard) rows.push(row);
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const onSignal = () => {
    for (const sandbox of activeSandboxes) sandbox.cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const rows = await runMatrix({ dryRun: args.dryRun, taskIds: args.tasks, repeats: args.repeats });
  if (args.verdict) console.log(computeVerdict(rows));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(err => { console.error(err); process.exit(1); });
}
