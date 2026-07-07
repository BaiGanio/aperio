import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SPEC_VERSION,
  normalizeAgentSpec,
  validateAgentSpec,
} from "../../../lib/agent/spec.js";

test("normalizes a complete AgentSpec without mutating the input", () => {
  const input = {
    id: "reviewer.security",
    description: "Security review agent",
    provider: { name: "ollama", model: "qwen3:4b" },
    identity: { name: "Aperio reviewer", persona: "reviewer", prompt: "Review narrowly." },
    character: "security-engineer",
    skills: ["code-review", "code-review", "security"],
    memoryScopes: ["project", { name: "self", access: "none" }],
    toolAllowlist: ["read_file", "code_search", "read_file"],
    filesystem: {
      read: ["/repo"],
      write: ["/repo/var/scratch"],
      execute: ["/repo/scripts"],
    },
    interruptPolicy: { mode: "always", allowEdit: false, timeoutMs: 60_000 },
    timeoutMs: 120_000,
    recursionDepth: 2,
    concurrency: 3,
    outputSchema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
  };

  const spec = normalizeAgentSpec(input);

  assert.equal(spec.version, AGENT_SPEC_VERSION);
  assert.equal(spec.id, "reviewer.security");
  assert.deepEqual(spec.provider, { name: "ollama", model: "qwen3:4b" });
  assert.deepEqual(spec.identity, {
    name: "Aperio reviewer",
    persona: "reviewer",
    prompt: "Review narrowly.",
  });
  assert.deepEqual(spec.skills, ["code-review", "security"]);
  assert.deepEqual(spec.memoryScopes, [
    { name: "project", access: "read" },
    { name: "self", access: "none" },
  ]);
  assert.deepEqual(spec.toolAllowlist, ["read_file", "code_search"]);
  assert.deepEqual(spec.filesystem.execute, ["/repo/scripts"]);
  assert.equal(spec.interruptPolicy.allowEdit, false);
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.filesystem.read), true);

  input.skills.push("late");
  input.outputSchema.properties.verdict.type = "number";
  assert.deepEqual(spec.skills, ["code-review", "security"]);
  assert.equal(spec.outputSchema.properties.verdict.type, "string");
});

test("applies conservative defaults for optional policy fields", () => {
  const spec = normalizeAgentSpec({ id: "default" });

  assert.deepEqual(spec.provider, { name: null, model: null });
  assert.deepEqual(spec.identity, { name: null, persona: null, prompt: null });
  assert.deepEqual(spec.skills, []);
  assert.deepEqual(spec.memoryScopes, []);
  assert.deepEqual(spec.toolAllowlist, []);
  assert.deepEqual(spec.filesystem, { read: [], write: [], execute: [] });
  assert.deepEqual(spec.interruptPolicy, { mode: "default", allowEdit: true, timeoutMs: null });
  assert.equal(spec.timeoutMs, null);
  assert.equal(spec.recursionDepth, 0);
  assert.equal(spec.concurrency, 1);
  assert.equal(spec.outputSchema, null);
});

test("accepts top-level model/persona compatibility aliases", () => {
  const spec = normalizeAgentSpec({
    id: "compat",
    provider: { name: "codex" },
    model: "gpt-5.5",
    persona: "primary",
  });

  assert.deepEqual(spec.provider, { name: "codex", model: "gpt-5.5" });
  assert.equal(spec.identity.persona, "primary");
});

test("rejects unknown security-sensitive fields at every policy boundary", () => {
  assert.throws(
    () => normalizeAgentSpec({ id: "bad", permissions: { shell: true } }),
    /unknown field "permissions"/,
  );
  assert.throws(
    () => normalizeAgentSpec({ id: "bad", provider: { name: "ollama", apiKey: "secret" } }),
    /Invalid AgentSpec \.provider: unknown field "apiKey"/,
  );
  assert.throws(
    () => normalizeAgentSpec({ id: "bad", filesystem: { read: [], network: ["*"] } }),
    /Invalid AgentSpec \.filesystem: unknown field "network"/,
  );
  assert.throws(
    () => normalizeAgentSpec({ id: "bad", interruptPolicy: { mode: "default", autoApprove: true } }),
    /Invalid AgentSpec \.interruptPolicy: unknown field "autoApprove"/,
  );
  assert.throws(
    () => normalizeAgentSpec({ id: "bad", memoryScopes: [{ name: "user", widen: true }] }),
    /Invalid AgentSpec \.memoryScopes\[0\]: unknown field "widen"/,
  );
});

test("validates identifiers, providers, limits, and conflicts", () => {
  assert.throws(() => normalizeAgentSpec({}), /\.id: is required/);
  assert.throws(() => normalizeAgentSpec({ id: "../escape" }), /\.id: contains unsupported characters/);
  assert.throws(() => normalizeAgentSpec({ id: "x", provider: { name: "unknown" } }), /\.provider\.name: must be one of/);
  assert.throws(() => normalizeAgentSpec({ id: "x", provider: { model: "a" }, model: "b" }), /\.model: conflicts/);
  assert.throws(() => normalizeAgentSpec({ id: "x", timeoutMs: 0 }), /\.timeoutMs: must be an integer between 1/);
  assert.throws(() => normalizeAgentSpec({ id: "x", recursionDepth: 17 }), /\.recursionDepth: must be an integer between 0 and 16/);
  assert.throws(() => normalizeAgentSpec({ id: "x", concurrency: 65 }), /\.concurrency: must be an integer between 1 and 64/);
});

test("allows arbitrary JSON Schema keywords only inside outputSchema", () => {
  const spec = normalizeAgentSpec({
    id: "structured",
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      unevaluatedProperties: false,
      properties: {
        items: {
          type: "array",
          prefixItems: [{ type: "string" }],
        },
      },
    },
  });

  assert.equal(spec.outputSchema.unevaluatedProperties, false);
  assert.equal(validateAgentSpec(spec), true);
  assert.throws(() => normalizeAgentSpec({ id: "bad", outputSchema: [] }), /\.outputSchema: must be a JSON Schema object/);
});
