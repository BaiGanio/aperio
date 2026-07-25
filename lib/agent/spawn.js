// lib/agent/spawn.js — sub-agent spawn/delegation (WS2, agent-harness-epic).
//
// Consumes the latent recursionDepth/concurrency fields on AgentSpec
// (lib/agent/spec.js) and the permission-narrowing machinery in
// lib/agent/bundle.js (narrowAgentSpec — added for exactly this purpose) to
// turn a parent AgentSpec into a strictly narrower child spec, then runs the
// child through the same createAgent()/runAgentLoop() path every other agent
// uses. Nothing here is a new execution engine — it is delegation.
//
// Two invariants, both enforced structurally rather than by convention:
//   - recursionDepth only ever decreases by exactly one per spawn, and a
//     spec with no budget left (recursionDepth <= 0) refuses to spawn at
//     all — a graceful, parent-visible refusal, not a thrown error.
//   - a child's toolAllowlist (and every other permission-relevant field)
//     can never widen beyond the parent's — narrowAgentSpec throws
//     AgentBundleError if a caller tries, the same as an on-disk bundle
//     attempting to widen an administrator policy.
//
// Roundtable (lib/workers/roundtable.js) — the only existing multi-agent
// runtime — is deliberately not refactored onto this. It hard-codes exactly
// two pre-created agents with no delegation, narrowing, or recursion
// semantics; folding it onto spawnChild is a separate, future change.
//
// A child failing (including tripping its own tool-failure budget) never
// rejects spawnChild/spawnParallel — it resolves with `ok: false` so a
// parent turn driving several children completes with whichever results
// landed, exactly like a single turn survives a failed tool call today.

import { randomUUID } from "node:crypto";
import { createAgent } from "./index.js";
import { narrowAgentSpec } from "./bundle.js";
import { makeSinkEmitter } from "../emitters/sinkEmitter.js";
import logger from "../helpers/logger.js";

export class AgentSpawnError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AgentSpawnError";
    this.code = code;
  }
}

/** Wraps an emitter so every event forwarded through it carries `agent_id`. */
function taggedEmitter(target, agentId) {
  return {
    send(event) {
      target.send({ ...event, agent_id: agentId });
    },
  };
}

/** Non-permission identity fields carried over as-is from parent to child. */
function buildChildBaseSpec(parentSpec, { id, name }) {
  return {
    version: parentSpec.version,
    id,
    description: parentSpec.description,
    provider: parentSpec.provider,
    identity: { ...parentSpec.identity, name: name || parentSpec.identity?.name },
    character: parentSpec.character,
    skills: parentSpec.skills,
    memoryScopes: parentSpec.memoryScopes,
    toolAllowlist: parentSpec.toolAllowlist,
    filesystem: parentSpec.filesystem,
    interruptPolicy: parentSpec.interruptPolicy,
    timeoutMs: parentSpec.timeoutMs,
    recursionDepth: parentSpec.recursionDepth,
    concurrency: parentSpec.concurrency,
    outputSchema: parentSpec.outputSchema,
  };
}

/**
 * Spawns one child agent, narrowed from `spec` (the calling/parent agent's
 * AgentSpec), and runs it through a single runAgentLoop turn seeded with
 * `prompt`. Never throws for child-side failures (bad tool calls, budget
 * exhaustion, thrown provider errors) — those come back as `{ ok: false }`.
 * Throws AgentSpawnError for caller mistakes (missing name/spec) and
 * AgentBundleError (re-thrown from narrowAgentSpec) for narrowing violations
 * — both are caller bugs, not child-runtime failures, so they reject.
 *
 * @param {object} opts
 * @param {object} opts.spec - the parent AgentSpec (narrowing ceiling)
 * @param {string} opts.root - project root, forwarded to createAgent
 * @param {string} opts.version - app version, forwarded to createAgent
 * @param {string} opts.name - child identifier (unique per spawn, not per name)
 * @param {string} [opts.prompt] - the child's task, sent as its first user message
 * @param {string[]|null} [opts.tools] - narrower toolAllowlist for the child
 * @param {object} [opts.providerConfig] - forwarded to createAgent
 * @param {Array} [opts.hostTools] - forwarded to createAgent
 * @param {{send:Function}} [opts.emitter] - parent emitter; child events are tagged and forwarded here
 * @param {Function} [opts.getAbort]
 * @param {Function} [opts.setAbort]
 */
export async function spawnChild({
  spec,
  root,
  version,
  name,
  prompt = "",
  tools,
  providerConfig = null,
  hostTools = [],
  emitter = null,
  getAbort = () => null,
  setAbort = () => {},
} = {}) {
  if (!spec) throw new AgentSpawnError("spawnChild requires the parent's spec", "missing-parent-spec");
  if (!name || typeof name !== "string") throw new AgentSpawnError("spawnChild requires a child name", "missing-name");

  const agentId = `${spec.id}:${name}:${randomUUID().slice(0, 8)}`;

  if (!(spec.recursionDepth > 0)) {
    const message = `Agent "${spec.id}" is at its recursion-depth limit and cannot spawn "${name}"`;
    logger.warn(`[agent-spawn] ${message}`);
    if (emitter) taggedEmitter(emitter, agentId).send({ type: "spawn_refused", name, code: "recursion-depth-exceeded", message });
    return { agentId, name, ok: false, refused: true, code: "recursion-depth-exceeded", error: message, finalText: "", events: [] };
  }

  const patch = { recursionDepth: spec.recursionDepth - 1 };
  if (tools !== undefined) patch.toolAllowlist = tools;

  // Throws AgentBundleError if `tools` (or anything else patched) would widen
  // beyond `spec` — this is the invariant bundle.js already enforces for
  // on-disk permission bundles; spawn.js applies the same check in memory.
  const childSpec = narrowAgentSpec(buildChildBaseSpec(spec, { id: agentId, name }), patch, spec);

  const sink = makeSinkEmitter();
  const forward = emitter ? taggedEmitter(emitter, agentId) : null;
  const childEmitter = {
    send(event) {
      sink.emitter.send(event);
      if (forward) forward.send(event);
    },
  };

  let finalText = "";
  let ok = true;
  let error = null;
  try {
    const childAgent = await createAgent({
      root, version, clientName: agentId, providerConfig, spec: childSpec, hostTools,
    });
    const messages = [{ role: "user", content: prompt }];
    finalText = await childAgent.runAgentLoop(messages, childEmitter, {}, getAbort, setAbort);
  } catch (err) {
    ok = false;
    error = err.message;
    logger.error(`[agent-spawn] child "${agentId}" failed: ${err.message}`);
  }

  const budgetExhausted = sink.events.some(e => e.type === "tool_budget_exhausted");
  if (budgetExhausted) ok = false;

  return { agentId, name, ok, finalText, error, events: sink.events, budgetExhausted, childSpec };
}

/**
 * Runs a batch of spawnChild descriptors concurrently, capped at the
 * spawning agent's own `spec.concurrency` (the other latent AgentSpec field
 * this workstream consumes). Resolves once every child has settled — a
 * failed or budget-exhausted child never causes a sibling's result to be
 * lost, matching spawnChild's own no-throw contract for child-side failures.
 *
 * @param {object} opts
 * @param {object} opts.spec - the parent AgentSpec, shared narrowing ceiling for every child
 * @param {Array<object>} opts.children - spawnChild descriptors ({name, prompt, tools, providerConfig, hostTools})
 * @returns {Promise<object[]>} one result per child, in input order
 */
export async function spawnParallel({
  spec,
  root,
  version,
  children = [],
  hostTools = [],
  emitter = null,
  getAbort = () => null,
  setAbort = () => {},
} = {}) {
  if (!spec) throw new AgentSpawnError("spawnParallel requires the parent's spec", "missing-parent-spec");
  const limit = Math.max(1, Math.min(children.length || 1, spec.concurrency || 1));

  const results = new Array(children.length);
  let cursor = 0;
  async function worker() {
    while (cursor < children.length) {
      const index = cursor++;
      const child = children[index];
      results[index] = await spawnChild({
        spec, root, version, emitter, getAbort, setAbort,
        ...child,
        hostTools: child.hostTools ?? hostTools,
      });
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/** Turns one WS1 plan step into a spawnChild descriptor — see planning-middleware.js for the plan shape. */
export function planStepToChildDescriptor(step, index) {
  return {
    name: `plan-step-${index}`,
    prompt: step.purpose
      ? `${step.purpose} — call the "${step.tool}" tool with arguments: ${JSON.stringify(step.args ?? {})}`
      : `Call the "${step.tool}" tool with arguments: ${JSON.stringify(step.args ?? {})}`,
    tools: [step.tool],
  };
}
