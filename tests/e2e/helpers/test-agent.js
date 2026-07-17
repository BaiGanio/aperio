// tests/e2e/helpers/test-agent.js
//
// Contract-faithful test agent stub for real-app WebSocket E2E tests.
//
// Satisfies the agent interface expected by wsHandler.js (destructured
// fields + runAgentLoop). Echoes user text as a streamed token response
// without any external model, MCP, or network access.

import { randomUUID } from "node:crypto";

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
