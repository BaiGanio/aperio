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
// Four tool names are deliberately real Aperio tool identifiers because the
// safety middleware keys off them literally (lib/agent/tool-profiles.js):
//   - "fetch_url"    — a member of UNTRUSTED_CONTENT_TOOLS (taints the turn)
//   - "write_file"   — a member of WRITE_TOOLS (receives the __tainted flag)
//   - "delete_file"  — a member of CONFIRM_TOOLS, and the one name tool-hooks
//                      styles as destructive with a path-derived label
//   - "index_folder" — a member of CONFIRM_TOOLS, non-destructive, whose label
//                      comes from the result's own "Action:" line
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

    // ── confirm-pending: results carrying a `Token:` line ───────────────
    // Both handlers mirror the real producers' output format verbatim, because
    // tool-hooks.js parses that text to build the confirm payload:
    //   delete_file  → mcp/tools/files/delete.js (Target:/Token:, no Action:)
    //   index_folder → lib/agent/host-tools/index-folder.js (📋/Target:/Action:/Token:)
    // Neither handler performs its action — a `Token:` result means nothing has
    // happened yet, which is precisely the state under test.
    {
      name: "delete_file", description: "Delete a file (confirm-before-act)", inputSchema: genericSchema,
      handler: async (args) => {
        const target = args?.path || "unknown";
        return `⚠️ Deletion pending confirmation\nTarget: ${target}\nToken: del_h4rn3s\n\n`
          + `To complete this deletion, confirm with token "del_h4rn3s". This token expires in 2 minutes.`;
      },
    },
    {
      name: "index_folder", description: "Authorize and index a folder (confirm-before-act)", inputSchema: genericSchema,
      handler: async (args) => {
        const target = args?.path || "unknown";
        return [
          "📋 Folder authorization required — nothing has been changed yet.",
          "",
          `Target: ${target}`,
          "Index: Code Graph",
          "",
          `Action: Authorize and index ${target}`,
          "Token: idx_h4rn3s",
        ].join("\n");
      },
    },
  ];
}
