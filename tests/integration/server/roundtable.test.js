// Tests for roundtable.js — parses ROUNDTABLE_AGENTS, gates on
// shouldEnableRoundtable(), and boots the primary+verifier agent pair.
//
// parseRoundtableAgents is a pure function.
// bootRoundtable uses dynamic imports and createAgent — integration test.

import { describe, test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import logger from "../../../lib/helpers/logger.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

before(() => {
  mock.method(logger, "info",  () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "error", () => {});
  mock.method(logger, "debug", () => {});
});

after(() => {
  mock.restoreAll();
});

// ═══════════════════════════════════════════════════════════════════════════
// Import SUT
// ═══════════════════════════════════════════════════════════════════════════

let bootRoundtable, parseRoundtableAgents;

before(async () => {
  const mod = await import("../../../lib/server/roundtable.js");
  bootRoundtable        = mod.bootRoundtable;
  parseRoundtableAgents = mod.parseRoundtableAgents;
});

// ═══════════════════════════════════════════════════════════════════════════
// parseRoundtableAgents
// ═══════════════════════════════════════════════════════════════════════════

describe("parseRoundtableAgents", () => {
  beforeEach(() => {
    logger.warn.mock.resetCalls();
  });

  test("returns [] for null, undefined, and empty string", () => {
    assert.deepStrictEqual(parseRoundtableAgents(null), []);
    assert.deepStrictEqual(parseRoundtableAgents(undefined), []);
    assert.deepStrictEqual(parseRoundtableAgents(""), []);
  });

  test("returns [] for non-string input (number)", () => {
    assert.deepStrictEqual(parseRoundtableAgents(123), []);
  });

  test("parses a single valid provider:model pair", () => {
    const result = parseRoundtableAgents("anthropic:claude-sonnet-4");
    assert.deepStrictEqual(result, [
      { name: "anthropic", model: "claude-sonnet-4" },
    ]);
  });

  test("parses two comma-separated provider:model pairs", () => {
    const result = parseRoundtableAgents("anthropic:claude-sonnet-4, deepseek:deepseek-chat");
    assert.deepStrictEqual(result, [
      { name: "anthropic", model: "claude-sonnet-4" },
      { name: "deepseek",  model: "deepseek-chat" },
    ]);
  });

  test("trims whitespace around pairs and values", () => {
    const result = parseRoundtableAgents("  anthropic:claude-sonnet-4  ,  deepseek:deepseek-chat  ");
    assert.deepStrictEqual(result, [
      { name: "anthropic", model: "claude-sonnet-4" },
      { name: "deepseek",  model: "deepseek-chat" },
    ]);
  });

  test("normalizes provider name to lowercase", () => {
    const result = parseRoundtableAgents("Anthropic:Claude-Sonnet-4");
    assert.strictEqual(result[0].name, "anthropic");
    assert.strictEqual(result[0].model, "Claude-Sonnet-4");
  });

  test("skips malformed entries without a colon and logs warning", () => {
    const result = parseRoundtableAgents("no-colon-here");
    assert.deepStrictEqual(result, []);
    const warn = logger.warn.mock.calls.find(c =>
      c.arguments[0].includes("malformed agent spec")
    );
    assert.ok(warn, "expected warn about malformed spec");
  });

  test("skips entries with unsupported provider and logs warning", () => {
    const result = parseRoundtableAgents("openai:gpt-4");
    assert.deepStrictEqual(result, []);
    const warn = logger.warn.mock.calls.find(c =>
      c.arguments[0].includes("unsupported provider")
    );
    assert.ok(warn, "expected warn about unsupported provider");
  });

  test("supports all supported providers: anthropic, deepseek, gemini, claude-code, codex, llamacpp", () => {
    const result = parseRoundtableAgents(
      "anthropic:model-a, deepseek:model-b, gemini:model-c, claude-code:model-d, codex:model-e, llamacpp:model-f"
    );
    assert.strictEqual(result.length, 6);
    assert.strictEqual(result[0].name, "anthropic");
    assert.strictEqual(result[1].name, "deepseek");
    assert.strictEqual(result[2].name, "gemini");
    assert.strictEqual(result[3].name, "claude-code");
    assert.strictEqual(result[4].name, "codex");
    assert.strictEqual(result[5].name, "llamacpp");
  });

  test("skips entry with empty model and logs warning", () => {
    const result = parseRoundtableAgents("anthropic:");
    assert.deepStrictEqual(result, []);
    const warn = logger.warn.mock.calls.find(c =>
      c.arguments[0].includes("model is empty")
    );
    assert.ok(warn, "expected warn about empty model");
  });

  test("skips empty segments from trailing commas", () => {
    const result = parseRoundtableAgents("anthropic:model-a, ");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "anthropic");
  });

  test("filters out nulls from invalid entries — returns only valid pairs", () => {
    const result = parseRoundtableAgents(
      "anthropic:model-a, invalid, deepseek:model-b, unsupported:bad"
    );
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, "anthropic");
    assert.strictEqual(result[1].name, "deepseek");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// bootRoundtable
// ═══════════════════════════════════════════════════════════════════════════

describe("bootRoundtable", () => {
  /** Mock createAgent returning a resolved-agent promise. */
  function makeCreateAgent(agent) {
    return mock.fn(async () => agent);
  }

  function defaultAgent() {
    return {
      provider: { name: "anthropic", model: "claude-sonnet-4" },
    };
  }

  const ROOT    = PROJECT_ROOT;
  const VERSION = "0.68.0";

  beforeEach(() => {
    delete process.env.ROUNDTABLE_AGENTS;
    delete process.env.ROUNDTABLE_CHARACTERS;
    delete process.env.APERIO_ROUNDTABLE_RESERVE_GB;
    delete process.env.APERIO_ROUNDTABLE_RESERVE_FRACTION;
    logger.warn.mock.resetCalls();
    logger.error.mock.resetCalls();
    logger.info.mock.resetCalls();
  });

  // ─── Shape ────────────────────────────────────────────────────────────

  test("returns the expected 4-field shape", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:claude-sonnet-4, deepseek:deepseek-chat";
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });

    assert.ok(result);
    assert.ok("primaryRoundtable" in result);
    assert.ok("verifier" in result);
    assert.ok("roundtableAvailable" in result);
    assert.ok("roundtableUnavailableReason" in result);
  });

  // ─── Disabled (no ROUNDTABLE_AGENTS set) ─────────────────────────────

  test("returns null agents and roundtableAvailable=false when ROUNDTABLE_AGENTS not set", async () => {
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });

    assert.strictEqual(result.roundtableAvailable, false);
    assert.strictEqual(result.primaryRoundtable, null);
    assert.strictEqual(result.verifier, null);
    assert.ok(result.roundtableUnavailableReason);
  });

  test("warns when roundtable is unavailable", async () => {
    const createAgent = makeCreateAgent(defaultAgent());

    await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });

    const warnMsg = logger.warn.mock.calls.find(c =>
      c.arguments[0].includes("[roundtable] Discuss unavailable")
    );
    assert.ok(warnMsg, "expected warn about Discuss unavailable");
  });

  // ─── Full flow — agents created ──────────────────────────────────────

  test("creates primary and verifier lazily when first requested", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:claude-sonnet-4, deepseek:deepseek-chat";
    const mockAgent = defaultAgent();
    const createAgent = makeCreateAgent(mockAgent);

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });

    assert.strictEqual(result.roundtableAvailable, true);
    assert.strictEqual(result.primaryRoundtable, null);
    assert.strictEqual(result.verifier, null);
    assert.strictEqual(createAgent.mock.callCount(), 0);

    const agents = await result.getAgents();
    assert.strictEqual(agents.primaryRoundtable, mockAgent);
    assert.strictEqual(agents.verifier, mockAgent);
    assert.strictEqual(createAgent.mock.callCount(), 2);
  });

  test("single-flights concurrent first-use initialization", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const createAgent = makeCreateAgent(defaultAgent());
    const result = await bootRoundtable({
      root: ROOT, version: VERSION, provider: { name: "anthropic" }, createAgent,
    });

    const [first, second] = await Promise.all([result.getAgents(), result.getAgents()]);

    assert.strictEqual(first, second);
    assert.strictEqual(createAgent.mock.callCount(), 2);
  });

  test("shares one compatible MCP connection across both roles", async () => {
    process.env.ROUNDTABLE_AGENTS = "llamacpp:model-x, llamacpp:model-x";
    const shared = { providerIsLocal: true };
    const createAgent = mock.fn(async (opts) => ({
      provider: opts.spec.provider,
      getMcpConnection: () => opts.mcpConnection,
    }));
    const result = await bootRoundtable({
      root: ROOT, version: VERSION, provider: { name: "llamacpp", model: "model-x" }, createAgent,
      mcpConnections: [shared],
    });

    await result.getAgents();

    assert.strictEqual(createAgent.mock.calls[0].arguments[0].mcpConnection, shared);
    assert.strictEqual(createAgent.mock.calls[1].arguments[0].mcpConnection, shared);
  });

  test("does not share an MCP connection across the local/cloud privacy boundary", async () => {
    process.env.ROUNDTABLE_AGENTS = "llamacpp:model-x, anthropic:model-y";
    const localConnection = { providerIsLocal: true };
    const cloudConnection = { providerIsLocal: false };
    const createAgent = mock.fn(async (opts) => {
      const connection = opts.mcpConnection ?? cloudConnection;
      return {
        provider: opts.spec.provider,
        getMcpConnection: () => connection,
      };
    });
    const result = await bootRoundtable({
      root: ROOT, version: VERSION, provider: { name: "llamacpp", model: "model-x" }, createAgent,
      mcpConnections: [localConnection],
    });

    await result.getAgents();

    assert.strictEqual(createAgent.mock.calls[0].arguments[0].mcpConnection, localConnection);
    assert.strictEqual(createAgent.mock.calls[1].arguments[0].mcpConnection, null);
  });

  test("closes a partially created primary when verifier creation fails", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const close = mock.fn(async () => {});
    let call = 0;
    const createAgent = mock.fn(async () => {
      if (++call === 1) return { provider: { name: "anthropic", model: "model-x" }, close };
      throw new Error("verifier failed");
    });
    const result = await bootRoundtable({
      root: ROOT, version: VERSION, provider: { name: "anthropic" }, createAgent,
    });

    await assert.rejects(result.getAgents(), /verifier failed/);

    assert.strictEqual(close.mock.callCount(), 1);
    assert.strictEqual(result.primaryRoundtable, null);
  });

  test("does not reuse a failed pair's closed MCP connection on retry", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const firstConnection = { providerIsLocal: false };
    const secondConnection = { providerIsLocal: false };
    const firstClose = mock.fn(async () => {});
    let call = 0;
    const createAgent = mock.fn(async (opts) => {
      call++;
      if (call === 1) {
        assert.strictEqual(opts.mcpConnection, null);
        return {
          provider: opts.spec.provider,
          getMcpConnection: () => firstConnection,
          close: firstClose,
        };
      }
      if (call === 2) throw new Error("verifier failed");
      if (call === 3) {
        assert.strictEqual(opts.mcpConnection, null, "retry must not receive the closed first connection");
        return {
          provider: opts.spec.provider,
          getMcpConnection: () => secondConnection,
          close: async () => {},
        };
      }
      return { provider: opts.spec.provider, close: async () => {} };
    });
    const result = await bootRoundtable({
      root: ROOT, version: VERSION, provider: { name: "anthropic" }, createAgent,
    });

    await assert.rejects(result.getAgents(), /verifier failed/);
    await result.getAgents();

    assert.strictEqual(firstClose.mock.callCount(), 1);
    assert.strictEqual(createAgent.mock.callCount(), 4);
  });

  test("passes root and version to createAgent", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });
    await result.getAgents();

    // Both calls should have root and version
    for (const call of createAgent.mock.calls) {
      assert.strictEqual(call.arguments[0].root,    ROOT);
      assert.strictEqual(call.arguments[0].version, VERSION);
    }
  });

  test("passes clientName and spec to createAgent", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });
    await result.getAgents();

    const calls = createAgent.mock.calls;
    assert.strictEqual(calls.length, 2);

    // Primary agent
    assert.ok(calls[0].arguments[0].clientName.includes("rt-primary"));
    assert.ok(calls[0].arguments[0].spec, "primary agent has spec");
    // buildRoundtableAgentSpec uses makeSpecId("roundtable", id) → "roundtable.primary"
    assert.ok(calls[0].arguments[0].spec.id.includes("roundtable.primary"), `expected roundtable.primary, got ${calls[0].arguments[0].spec.id}`);

    // Verifier agent
    assert.ok(calls[1].arguments[0].clientName.includes("rt-verifier"));
    assert.ok(calls[1].arguments[0].spec, "verifier agent has spec");
    assert.ok(calls[1].arguments[0].spec.id.includes("roundtable.verifier"), `expected roundtable.verifier, got ${calls[1].arguments[0].spec.id}`);
  });

  test("logs info when roundtable boots successfully", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:claude-sonnet-4, deepseek:deepseek-chat";
    const createAgent = makeCreateAgent(defaultAgent());
    logger.info.mock.resetCalls();

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });
    await result.getAgents();

    const bootLog = logger.info.mock.calls.find(c =>
      c.arguments[0].includes("🤝 Round-table")
    );
    assert.ok(bootLog, "expected roundtable boot log");
  });

  // ─── Single config ───────────────────────────────────────────────────

  test("logs warn and returns disabled when only one agent config is provided", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x";
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });

    assert.strictEqual(result.roundtableAvailable, false);
    assert.strictEqual(result.primaryRoundtable, null);
    assert.strictEqual(result.verifier, null);
    // shouldEnableRoundtable returns disabled with the reason message
    const warnMsg = logger.warn.mock.calls.find(c =>
      c.arguments[0].includes("Discuss unavailable")
    );
    assert.ok(warnMsg, "expected warn about Discuss unavailable");
    assert.ok(warnMsg.arguments[0].includes("needs two"),
      "reason explains that two pairs are needed");
  });

  // ─── createAgent failure ─────────────────────────────────────────────

  test("surfaces a lazy createAgent error and leaves no cached agents", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const createAgent = mock.fn(async () => { throw new Error("agent factory failed"); });

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });

    assert.strictEqual(result.roundtableAvailable, true);
    assert.strictEqual(result.primaryRoundtable, null);
    assert.strictEqual(result.verifier, null);
    await assert.rejects(result.getAgents(), /agent factory failed/);

    const errLog = logger.error.mock.calls.find(c =>
      c.arguments[0].includes("Could not boot round-table agents")
    );
    assert.ok(errLog, "expected error log about boot failure");
  });

  // ─── ROUNDTABLE_CHARACTERS ───────────────────────────────────────────

  test("uses ROUNDTABLE_CHARACTERS to set agent personas", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    process.env.ROUNDTABLE_CHARACTERS = "professor-cruncher, skeptic-bot";
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });
    await result.getAgents();

    const calls = createAgent.mock.calls;
    assert.strictEqual(calls.length, 2);
    // Primary should have first character, verifier second
    assert.strictEqual(calls[0].arguments[0].spec.character, "professor-cruncher");
    assert.strictEqual(calls[1].arguments[0].spec.character, "skeptic-bot");
  });

  test("handles missing ROUNDTABLE_CHARACTERS (null character)", async () => {
    process.env.ROUNDTABLE_AGENTS = "anthropic:model-x, deepseek:model-y";
    const createAgent = makeCreateAgent(defaultAgent());

    const result = await bootRoundtable({
      root: ROOT, version: VERSION,
      provider: "anthropic", createAgent,
    });
    await result.getAgents();

    const calls = createAgent.mock.calls;
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].arguments[0].spec.character, null);
    assert.strictEqual(calls[1].arguments[0].spec.character, null);
  });
});
