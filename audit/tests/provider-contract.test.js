// T2.1 — audit/scripts/provider-contract.js (aperio-continuous-audit-tests.md, T2.1).
//
// The plan's fixture: a registry listing six providers against a dispatch that
// handles five. The gate must name the provider missing from dispatch, and
// must reach that verdict from the five stages of the provider path plus the
// three cross-provider capability contracts — not from a file count. The
// reviewed-exception case is exercised in both directions: a delegation on
// record passes, and an exemption whose stated reason no longer holds in the
// code fails.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseKnownProviders,
  parseResolverNames,
  parseDispatch,
  parseLoopImports,
  parseConfigOptions,
  checkProviderMatrix,
  checkProviderContract,
  CAPABILITY_MARKERS,
  REVIEWED_CAPABILITY_EXEMPTIONS,
} from "../scripts/provider-contract.js";

// A loop module that satisfies all three capability contracts, so a fixture
// only has to state what it is MISSING.
const COMPLETE_LOOP = `
  export async function runLoop(messages, emitter, opts, getAbort, setAbort, ctx) {
    if (getAbort()?.signal?.aborted) return "";
    const trimmed = redactMessages(messages);
    emitter.send({ type: "stream_end", text: "ok", usage: streamUsage });
  }
`;

const SIX = ["anthropic", "deepseek", "gemini", "llamacpp", "claude-code", "codex"];

/** A fixture matrix where every stage agrees on `names`. */
function fixture(names = SIX, overrides = {}) {
  const dispatch = {};
  const loopImports = {};
  const loopSources = {};
  for (const name of names) {
    const fn = `run_${name.replace(/-/g, "_")}_loop`;
    const file = `lib/agent/providers/${name}.js`;
    dispatch[name] = fn;
    loopImports[fn] = file;
    loopSources[file] = COMPLETE_LOOP;
  }
  return {
    registryNames: names,
    resolverNames: names,
    dispatch,
    loopImports,
    loopSources,
    configOptions: names,
    testFiles: names.map((n) => `tests/unit/providers/${n}.test.js`),
    exemptions: {},
    delegations: {},
    isLocal: () => false,
    ...overrides,
  };
}

describe("audit/scripts/provider-contract.js", () => {
  test("a fixture where every stage agrees passes", () => {
    const result = checkProviderMatrix(fixture());
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(Object.keys(result.matrix), SIX);
  });

  test("T2.1 — registry lists six providers, dispatch handles five: the gate fails " +
    "and names the provider missing from dispatch", () => {
    const base = fixture();
    delete base.dispatch.codex;
    const result = checkProviderMatrix(base);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.length, 1, JSON.stringify(result.errors));
    assert.ok(result.errors[0].startsWith("codex:"));
    assert.ok(result.errors[0].includes("no dispatch branch"));
    // The one finding is the missing branch. Its capability contracts report
    // "unknown", not "missing" — there is no loop to have checked.
    assert.deepStrictEqual(result.matrix.codex.capabilities, {
      usage: "unknown", abort: "unknown", redaction: "unknown",
    });
    // The other five are untouched — one missing branch is not a suite-wide alarm.
    assert.strictEqual(result.matrix.anthropic.loopFn, "run_anthropic_loop");
  });

  test("T2.1 — the reverse drift (a dispatch branch for a name the registry " +
    "does not know) is reported as a dead branch", () => {
    const base = fixture();
    base.dispatch.mistral = "runMistralLoop";
    base.loopImports.runMistralLoop = "lib/agent/providers/mistral.js";
    base.loopSources["lib/agent/providers/mistral.js"] = COMPLETE_LOOP;
    const result = checkProviderMatrix(base);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("mistral:") && e.includes("KNOWN_PROVIDERS")));
  });

  test("T2.1 — the gate checks resolver, config option and per-provider tests, " +
    "not file count: each stage fails on its own", () => {
    const missingResolver = checkProviderMatrix(fixture(SIX, { resolverNames: SIX.filter((n) => n !== "gemini") }));
    assert.ok(missingResolver.errors.some((e) => e.startsWith("gemini:") && e.includes("resolveProvider")));

    const missingOption = checkProviderMatrix(fixture(SIX, { configOptions: SIX.filter((n) => n !== "deepseek") }));
    assert.ok(missingOption.errors.some((e) => e.startsWith("deepseek:") && e.includes("AI_PROVIDER's options")));

    const missingTest = checkProviderMatrix(fixture(SIX, { testFiles: [] }));
    assert.strictEqual(missingTest.errors.filter((e) => e.includes("no provider-specific test file")).length, 6);
  });

  test("T2.1 — a loop missing a capability contract fails on that capability alone", () => {
    for (const capability of Object.keys(CAPABILITY_MARKERS)) {
      const stripped = COMPLETE_LOOP.replace(CAPABILITY_MARKERS[capability], "/* removed */");
      const base = fixture();
      base.loopSources["lib/agent/providers/codex.js"] = stripped;
      const result = checkProviderMatrix(base);
      assert.strictEqual(result.ok, false, `expected ${capability} drift to fail`);
      assert.ok(result.errors.some((e) => e.startsWith("codex:") && e.includes(`no ${capability} marker`)),
        `expected a codex ${capability} error, got ${JSON.stringify(result.errors)}`);
      assert.strictEqual(result.matrix.codex.capabilities[capability], "missing");
      assert.strictEqual(result.matrix.anthropic.capabilities[capability], "present");
    }
  });

  test("T2.1 edge case — a reviewed exemption passes only while its stated reason " +
    "still holds: local-only survives, and stops surviving when the provider " +
    "is no longer local", () => {
    const noRedaction = COMPLETE_LOOP.replace(/redactMessages\(messages\)/, "messages");
    const exemptions = { llamacpp: { redaction: { reason: "local-only", localOnly: true } } };

    const local = checkProviderMatrix(fixture(SIX, {
      loopSources: { ...fixture().loopSources, "lib/agent/providers/llamacpp.js": noRedaction },
      exemptions,
      isLocal: (n) => n === "llamacpp",
    }));
    assert.strictEqual(local.ok, true, JSON.stringify(local.errors));
    assert.strictEqual(local.matrix.llamacpp.capabilities.redaction, "exempt");

    const noLongerLocal = checkProviderMatrix(fixture(SIX, {
      loopSources: { ...fixture().loopSources, "lib/agent/providers/llamacpp.js": noRedaction },
      exemptions,
      isLocal: () => false,
    }));
    assert.strictEqual(noLongerLocal.ok, false);
    assert.ok(noLongerLocal.errors.some((e) => e.includes("stated reason no longer holds")));
  });

  test("T2.1 edge case — a provider that delegates to another provider's loop " +
    "needs to be on record: unreviewed fails, reviewed passes", () => {
    const shared = fixture();
    shared.loopImports[shared.dispatch.codex] = "lib/agent/providers/claude-code.js";

    const unreviewed = checkProviderMatrix(shared);
    assert.strictEqual(unreviewed.ok, false);
    assert.ok(unreviewed.errors.some((e) => e.includes("manual classification required")));

    const reviewed = checkProviderMatrix({
      ...shared,
      delegations: { codex: { reason: "thin variant of the claude-code loop" } },
    });
    assert.strictEqual(reviewed.ok, true, JSON.stringify(reviewed.errors));
  });

  test("a dispatch branch calling a function that is not a provider loop import fails, " +
    "rather than silently reporting the loop as contract-clean", () => {
    const base = fixture();
    base.dispatch.gemini = "runSomethingElse";
    const result = checkProviderMatrix(base);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("gemini:") && e.includes("not imported")));
    assert.strictEqual(result.matrix.gemini.capabilities.usage, "unknown");
  });

  test("importing the redaction helper without calling it does not satisfy the " +
    "redaction contract — the import specifier itself names the helper", () => {
    const importOnly = `
      import { redactMessages } from "../../helpers/redactSecrets.js";
      export async function runLoop(messages, emitter, opts, getAbort) {
        if (getAbort()?.signal?.aborted) return "";
        emitter.send({ type: "stream_end", text: "ok", usage: streamUsage });
      }
    `;
    const base = fixture();
    base.loopSources["lib/agent/providers/deepseek.js"] = importOnly;
    const result = checkProviderMatrix(base);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("deepseek:") && e.includes("no redaction marker")));
  });

  test("a stale exemption for a provider that no longer exists fails", () => {
    const result = checkProviderMatrix(fixture(SIX, {
      exemptions: { ollama: { redaction: { reason: "removed provider" } } },
    }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("ollama:") && e.includes("stale")));
  });

  test("parsers read the real registry, dispatch ladder and config registry, and " +
    "exclude the non-provider names (not-configured, mock)", () => {
    const registrySource = `
      const KNOWN_PROVIDERS = new Set(["anthropic", "codex"]);
      export function resolveProvider(overrides = {}) {
        if (PROVIDER === "mock") return { name: "mock", model: "mock" };
        if (!KNOWN_PROVIDERS.has(PROVIDER)) return { name: "not-configured", notConfigured: true };
        if (PROVIDER === "codex") return { name: "codex", model: "gpt-5.5" };
        return { name: "anthropic", model: ANTHROPIC_MODEL };
      }
      function somethingElse() { return { name: "decoy" }; }
    `;
    assert.deepStrictEqual(parseKnownProviders(registrySource), ["anthropic", "codex"]);
    assert.deepStrictEqual(parseResolverNames(registrySource), ["codex", "anthropic"]);

    const dispatchSource = `
      import { runAnthropicLoop } from "./providers/anthropic.js";
      import { runCodexLoop } from "./providers/codex.js";
      if (ctx.provider.name === "anthropic") finalText = await runAnthropicLoop(messages);
      else if (ctx.provider.name === "codex") finalText = await runCodexLoop(messages);
      else if (ctx.provider.name === "mock") { const { runMockLoop } = await import("x"); }
    `;
    assert.deepStrictEqual(parseDispatch(dispatchSource), {
      anthropic: "runAnthropicLoop", codex: "runCodexLoop",
    });
    assert.deepStrictEqual(parseLoopImports(dispatchSource), {
      runAnthropicLoop: "lib/agent/providers/anthropic.js",
      runCodexLoop: "lib/agent/providers/codex.js",
    });
    assert.ok(parseConfigOptions().includes("llamacpp"));
  });

  test("T5.1 red/green proof — removing a dispatch branch fails, restoring it passes", () => {
    const base = fixture();
    const withoutBranch = { ...base, dispatch: { ...base.dispatch } };
    delete withoutBranch.dispatch.llamacpp;
    assert.strictEqual(checkProviderMatrix(withoutBranch).ok, false);
    assert.strictEqual(checkProviderMatrix(base).ok, true);
  });

  test("current real state — all six provider loops reconcile across registry, " +
    "resolver, dispatch, config options, tests and capabilities", () => {
    const result = checkProviderContract();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors, null, 2));
    assert.deepStrictEqual(Object.keys(result.matrix).sort(), [...SIX].sort());
    for (const [name, entry] of Object.entries(result.matrix)) {
      assert.ok(entry.loopFn, `${name} has no dispatch branch`);
      assert.ok(entry.tests.length, `${name} has no provider-specific test`);
      assert.strictEqual(entry.capabilities.usage, "present");
      assert.strictEqual(entry.capabilities.abort, "present");
    }
    // llamacpp is the one redaction exemption, and it is the local provider.
    assert.deepStrictEqual(Object.keys(REVIEWED_CAPABILITY_EXEMPTIONS), ["llamacpp"]);
    assert.strictEqual(result.matrix.llamacpp.capabilities.redaction, "exempt");
    for (const name of SIX.filter((n) => n !== "llamacpp")) {
      assert.strictEqual(result.matrix[name].capabilities.redaction, "present",
        `${name} is a cloud provider and must redact at its send boundary`);
    }
  });
});
