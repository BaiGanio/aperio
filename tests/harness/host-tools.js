// tests/harness/host-tools.js
//
// Deterministic in-process tool handlers for the WS0 loop-regression harness.
// Registered as createAgent({ hostTools }) entries, so every scenario runs
// through the REAL callToolHooked wrapper, safety middleware, and offload
// pipeline (lib/agent/tool-hooks.js, tool-safety-middleware.js,
// model-context-middleware.js) with zero network and zero MCP subprocess —
// the MCP client itself is stubbed at the SDK layer by each harness test
// (see harness.test.js), so listTools()/callTool() never leave the process.
//
// Two tool names are deliberately real Aperio tool identifiers because the
// safety middleware keys off them literally (lib/agent/tool-profiles.js):
//   - "fetch_url"  — a member of UNTRUSTED_CONTENT_TOOLS (taints the turn)
//   - "write_file" — a member of WRITE_TOOLS (receives the __tainted flag)
// Every other tool name here is synthetic and carries no special handling,
// so scenarios that don't need a specific gate can't accidentally trip one.

import fs from "node:fs";
import path from "node:path";

const genericSchema = { type: "object", properties: {}, additionalProperties: true };

export function createHarnessHostTools({ scratchDir }) {
  return [
    // createAgent's own preflight (lib/agent/preflight.js) unconditionally
    // probes "recall" once per turn (auto-recall + scope-preference detection)
    // for any capable, tool-using provider — including the mock one. Without a
    // handler this hits the stubbed MCP Client.callTool and logs a swallowed
    // error every turn; a neutral stub keeps that path quiet and realistic.
    {
      name: "recall", description: "Recall stored memories", inputSchema: genericSchema,
      handler: async () => "No memories found.",
    },

    // ── happy-5-tool-chain: synthetic, unguarded tools ──────────────────
    {
      name: "fetch_data", description: "Fetch source data", inputSchema: genericSchema,
      handler: async () => "source data: 42 widgets sold",
    },
    {
      name: "analyze_data", description: "Analyze fetched data", inputSchema: genericSchema,
      handler: async () => "analysis: widget sales trending up 12%",
    },
    {
      name: "save_report", description: "Save a report to the workspace", inputSchema: genericSchema,
      handler: async (args) => {
        const filename = args?.filename || "report.txt";
        fs.writeFileSync(path.join(scratchDir, filename), args?.content ?? "report body", "utf8");
        return `saved ${filename}`;
      },
    },
    {
      name: "verify_report", description: "Verify a saved report exists", inputSchema: genericSchema,
      handler: async (args) => {
        const filename = args?.filename || "report.txt";
        return fs.existsSync(path.join(scratchDir, filename)) ? `verified ${filename}` : `❌ ${filename} not found`;
      },
    },
    {
      name: "send_report", description: "Send the verified report", inputSchema: genericSchema,
      handler: async (args) => `sent ${args?.filename || "report.txt"} to stakeholders`,
    },

    // ── oversized-offload: any tool name works, result size is what matters ──
    {
      name: "fetch_large_dataset", description: "Fetch a large dataset", inputSchema: genericSchema,
      // Comfortably over toolResultOffload's default 80,000-byte cap so the
      // scenario doesn't depend on token-limit math (lib/context/toolResultOffload.js).
      handler: async () => "ROW,".repeat(30_000),
    },

    // ── taint-gate: real Aperio tool identifiers, gate-relevant handlers ──
    {
      name: "fetch_url", description: "Fetch a URL (untrusted content)", inputSchema: genericSchema,
      handler: async (args) => `<html>fetched ${args?.url || "https://example.invalid"}: untrusted body</html>`,
    },
    {
      name: "write_file", description: "Write a file to the workspace", inputSchema: genericSchema,
      handler: async (args) => {
        if (args?.__tainted) return "❌ blocked: write refused because this turn read untrusted external content first";
        const filename = args?.filename || path.basename(args?.path || "output.txt");
        fs.writeFileSync(path.join(scratchDir, filename), args?.content ?? "", "utf8");
        return `wrote ${filename}`;
      },
    },

    // ── repeated-call-break: always fails identically ──────────────────
    {
      name: "flaky_tool", description: "A tool that always fails", inputSchema: genericSchema,
      handler: async () => "❌ Tool error (flaky_tool): transient upstream failure",
    },
  ];
}
