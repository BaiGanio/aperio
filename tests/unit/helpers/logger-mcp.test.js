// tests/unit/helpers/logger-mcp.test.js
// A stdio MCP server speaks JSON-RPC on stdout — any stray log line there is a
// protocol violation (the Node SDK client skips it; strict clients drop the
// connection). The logger must route its Console transport to stderr whenever
// the process is the MCP server: APERIO_PROC_ROLE=mcp (Aperio's own spawner,
// lib/agent/mcp-connect.js) or direct execution of mcp/index.js (standalone
// `npm run mcp`, e.g. registered in Codex/Claude).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const LOGGER = fileURLToPath(new URL("../../../lib/helpers/logger.js", import.meta.url));
const MCP_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../../../mcp/index.js");

function runLoggerProbe({ env = {}, argv1 } = {}) {
  const prelude = argv1 ? `process.argv[1] = ${JSON.stringify(argv1)};` : "";
  const script =
    `${prelude}import("file://${LOGGER}").then(({ default: logger }) => { ` +
    `logger.info("mcp-stdout-probe"); setTimeout(() => process.exit(0), 20); });`;
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", ...env },
    timeout: 15000,
  });
}

test("routes console logs to stderr when APERIO_PROC_ROLE=mcp (Aperio-spawned child)", () => {
  const res = runLoggerProbe({ env: { APERIO_PROC_ROLE: "mcp" } });
  assert.equal(res.stdout, "", "stdout must stay clean for the JSON-RPC channel");
  assert.match(res.stderr, /mcp-stdout-probe/);
});

test("detects standalone mcp/index.js execution via the entry argv", () => {
  const res = runLoggerProbe({ argv1: MCP_ENTRY });
  assert.equal(res.stdout, "", "stdout must stay clean for the JSON-RPC channel");
  assert.match(res.stderr, /mcp-stdout-probe/);
});

test("keeps logging to stdout for ordinary processes", () => {
  const res = runLoggerProbe();
  assert.match(res.stdout, /mcp-stdout-probe/);
});

test("mcp/index.js itself writes nothing to stdout at boot", () => {
  // NODE_ENV=test skips the execution guard, so this covers module top-level
  // only — exactly where dotenv's injection line and the logger live.
  const res = spawnSync(process.execPath, [MCP_ENTRY], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
    timeout: 15000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "", "module boot must not touch stdout");
});

test("mcp/index.js boot stays silent even with dotenv debug enabled", () => {
  // DOTENV_CONFIG_DEBUG overrides dotenv's `quiet: true` and would otherwise
  // print its diagnostics/injection line to stdout — the JSON-RPC channel.
  const res = spawnSync(process.execPath, [MCP_ENTRY], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", DOTENV_CONFIG_DEBUG: "true" },
    timeout: 15000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "", "dotenv debug output must not reach stdout");
});
