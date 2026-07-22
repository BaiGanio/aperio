// tests/e2e/helpers/test-agent.js
//
// Contract-faithful test agent stub for real-app WebSocket E2E tests.
//
// Satisfies the agent interface expected by wsHandler.js (destructured
// fields + runAgentLoop). Echoes user text as a streamed token response
// without any external model, MCP, or network access.
//
// WS-0 (e2e-coverage-expansion plan): `injectAgent` mode never spawns
// mcp/index.js — createAgent()/connectMcp() are skipped entirely when an
// agent is injected (see lib/server.js). That leaves surfaces reachable only
// through a real MCP tool call (propose_memory, write_file) with no path in
// the fixture at all. This stub gains an opt-in escape hatch: a chat message
// matching a reserved sentinel lazily connects its own MCP client — reusing
// the same stdio-spawn pattern as lib/agent/mcp-connect.js's connectMcp() —
// calls the named tool for real against the fixture's own DB, and closes the
// connection after the turn. Default behavior (no sentinel) is unchanged.

import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const SENTINEL_RE = /^__e2e_call_tool__:([^:]+):([\s\S]*)$/;

/**
 * Spawn a scoped MCP client, call one tool, and close it. Mirrors
 * lib/agent/mcp-connect.js's connectMcp() but lives only for a single call —
 * tests pay the child-process cost only when they opt into the sentinel.
 *
 * @param {string} name  MCP tool name
 * @param {object} args  Tool arguments
 * @returns {Promise<string>} The tool result's text content (or an error string)
 */
async function callMcpToolForReal(name, args) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  // mcp/index.js's execution guard skips startServer() whenever
  // NODE_ENV === "test" (so unit tests can import it without side effects) —
  // but this whole e2e fixture process runs under NODE_ENV=test, which the
  // grandchild would otherwise inherit and silently no-op. Production's
  // connectMcp() never spawns under NODE_ENV=test either, so stripping it
  // here matches real usage rather than working around it.
  const { NODE_ENV: _unused, ...envWithoutNodeEnv } = process.env;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings=ExperimentalWarning", resolve(REPO_ROOT, "mcp/index.js")],
    env: { ...envWithoutNodeEnv, APERIO_PROC_ROLE: "mcp" },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "e2e-test-agent", version: "0.0.0-test" });
  let mcpStderr = "";
  transport.stderr?.on("data", (chunk) => { mcpStderr += chunk.toString(); });

  try {
    await mcp.connect(transport);
    const result = await mcp.callTool({ name, arguments: args });
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    return result.isError ? `❌ ${text || "tool error"}` : (text || "No result");
  } catch (err) {
    const detail = mcpStderr.trim();
    return `❌ MCP call failed: ${err.message}${detail ? `\n${detail}` : ""}`;
  } finally {
    await mcp.close().catch(() => {});
  }
}

/**
 * Create a test agent stub for use with createApp({ injectAgent }).
 *
 * @param {object}  [opts]
 * @param {string=} opts.model         Provider model name (default "e2e-stub")
 * @param {number=} opts.contextWindow Context window (default 4096)
 * @param {number=} opts.delayMs       Artificial delay before replying (default 0)
 * @returns {object} Agent stub matching the createAgent() contract
 */
export function createTestAgent(opts = {}) {
  const {
    model = "e2e-stub",
    contextWindow = 4096,
    delayMs = 0,
  } = opts;

  const provider = {
    name: "test-stub",
    model,
    contextWindow,
  };

  let onDelayConfig = null; // callback for configurable delay tests

  return {
    // ── Provider metadata ────────────────────────────────────────────────
    provider,
    canStream: true,
    THINKS: false,
    persona: null,
    character: null,
    toolsEnabled: false,
    mcpTools: [],
    version: "0.0.0-test",
    NO_TOOLS: true,
    reasoningAdapter: { match: "__noop__" },

    // ── Stub methods ─────────────────────────────────────────────────────
    getToolCount: () => 0,
    getStartupBreakdown: () => "test agent ready",
    getSkillList: () => [],
    setPendingForcedSkills: () => {},
    setProvider: () => {},
    resetProviderSession: () => {},
    handleRememberIntent: async () => {},

    // ── Configurable delay (for interrupt/stop tests) ─────────────────────
    _setOnDelayConfig(fn) { onDelayConfig = fn; },

    // ── runAgentLoop: the core turn handler ──────────────────────────────
    async runAgentLoop(messages, emitter, _opts = {}, getAbort = () => null, setAbort = () => {}) {
      // Create and register an abort controller so external `stop` messages work
      const ctrl = new AbortController();
      setAbort(ctrl);
      const abortSignal = () => getAbort()?.signal?.aborted ?? ctrl.signal.aborted;

      // Emit stream start
      emitter.send({ type: "stream_start" });

      // Find the last user message
      const lastUser = [...messages].reverse().find(m => m.role === "user");
      const userText = typeof lastUser?.content === "string"
        ? lastUser.content
        : "Hello from test agent";

      // WS-0 sentinel: "__e2e_call_tool__:<name>:<jsonArgs>" triggers a real
      // MCP tool call instead of the echo behavior below.
      const sentinelMatch = userText.match(SENTINEL_RE);
      if (sentinelMatch) {
        const [, toolName, rawArgs] = sentinelMatch;
        let args;
        try {
          args = JSON.parse(rawArgs);
        } catch (err) {
          emitter.send({ type: "stream_end", text: `❌ sentinel args parse error: ${err.message}` });
          return;
        }
        const resultText = await callMcpToolForReal(toolName, args);
        emitter.send({ type: "token", text: resultText });
        emitter.send({ type: "stream_end", text: resultText });
        return;
      }

      // Simulate streaming token-by-token
      const words = userText.split(/(\s+)/).filter(Boolean);
      for (const word of words) {
        // Yield to the event loop so external `stop` messages can arrive
        await new Promise(resolve => setImmediate(resolve));

        // Check for abort
        if (abortSignal()) {
          emitter.send({ type: "stream_end", text: "" });
          return;
        }

        // Configurable delay per-word (for interrupt timing tests)
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          if (abortSignal()) {
            emitter.send({ type: "stream_end", text: "" });
            return;
          }
        }

        emitter.send({ type: "token", text: word });
      }

      emitter.send({ type: "stream_end", text: userText });
    },

    // ── buildGreeting: initial greeting for new sessions ─────────────────
    // Always static — no model call (prompt-cache hygiene, WS2).
    async buildGreeting(_lang) {
      return {
        memCtx: "",
        preloadedMemCount: 0,
        staticGreeting: "Hello! I'm the test agent. How can I help?",
      };
    },

    // ── warmCache: background KV-cache warm-up (WS2) — no-op for the stub ──
    async warmCache() { return false; },
  };
}
