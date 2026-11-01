// lib/agent/planning-middleware.js — planning lifecycle middleware (WS1,
// agent-harness-epic). Follows the model-context-middleware.js pattern: pure
// factory functions returning lifecycle-runner entries, no module-level
// mutable state.
//
// Config-gated (APERIO_AGENT_PLANNING=on, see lib/config.js) and fail-safe by
// construction: when no plan marker ever appears in the model's output, or a
// plan fails to parse, every hook here is a no-op and the loop behaves
// exactly as it does with planning off. The only externally visible effects
// are the plan_created / plan_step / plan_drift events and a request/
// reflection instruction appended to the model-facing prompt — never a
// blocked or altered tool call.
//
// A plan is the model's own text, so the two lifecycle halves — the
// model-facing "beforeModel"/"afterModel" hooks and the tool-facing
// "afterTool" hook — need to see the same per-turn state despite living in
// two separate lifecycle-runner instances (lib/agent/index.js's
// prepareModelContext runner vs. lib/agent/tool-hooks.js's per-tool-call
// runner). createPlanningState() is the shared object the caller threads
// through both createPlanningContextMiddleware() and
// createPlanningToolMiddleware().

export const PLANNING_CONTEXT_MIDDLEWARE_NAME = "agent-planning";
export const PLANNING_TOOL_MIDDLEWARE_NAME = "agent-planning-drift";

const PLAN_MARKER = "APERIO_PLAN:";

const PLAN_REQUEST_INSTRUCTION =
  "Optional: for a multi-step task, you may begin your response with a machine-readable plan " +
  "before calling any tools. Format: a single line starting with `APERIO_PLAN:` followed by JSON " +
  'matching { "steps": [{ "tool": "<tool_name>", "args": {}, "purpose": "<short reason>" }], ' +
  '"parallel": [[<step_index>, ...]] }. Only name tools that are actually available to you. ' +
  "This is optional — you may also proceed directly with tool calls without a plan.";

/** Fresh per-turn state, shared between the context and tool middleware. */
export function createPlanningState() {
  return {
    plan: null,              // { steps: [{tool,args,purpose}], parallel } once a valid plan is extracted
    invalid: false,          // true once an invalid plan has been seen — stop re-requesting this turn
    currentStepIndex: 0,
    processedMessageCount: 0,
    pendingDrift: null,      // reflection text queued for the next beforeModel pass
  };
}

/** Scans messages[fromIndex..] for the first assistant text block starting with PLAN_MARKER. */
function extractPlanMarker(messages, fromIndex) {
  for (let i = fromIndex; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const blocks = typeof message.content === "string"
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.filter(b => b?.type === "text").map(b => b.text)
        : [];
    for (const text of blocks) {
      if (typeof text !== "string") continue;
      const trimmed = text.trim();
      if (trimmed.startsWith(PLAN_MARKER)) return trimmed.slice(PLAN_MARKER.length);
    }
  }
  return null;
}

/** Parses + normalizes a plan body. Returns null on any malformed shape (fail-safe, not an error). */
function parsePlan(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps = parsed.steps.map(step => ({
    tool: typeof step?.tool === "string" ? step.tool : "",
    args: step?.args && typeof step.args === "object" ? step.args : {},
    purpose: typeof step?.purpose === "string" ? step.purpose : "",
  }));
  const parallel = Array.isArray(parsed.parallel) ? parsed.parallel : [];
  return { steps, parallel };
}

/**
 * beforeModel: requests a plan (while none is active) and extracts/validates
 * one from the model's own prior text once it appears in `messages`.
 * afterModel: turns a drift recorded by the tool middleware into a reflection
 * prompt for the *next* model call.
 */
export function createPlanningContextMiddleware({ state, emitter, logger, getToolNames }) {
  return {
    name: PLANNING_CONTEXT_MIDDLEWARE_NAME,
    afterModel(request) {
      if (!state.pendingDrift) return undefined;
      const reflection = state.pendingDrift;
      state.pendingDrift = null;
      return { update: { tailAppend: [...(request.tailAppend ?? []), reflection] } };
    },
    beforeModel(request) {
      const messages = request.messages ?? [];
      let update = null;

      if (state.plan === null && !state.invalid) {
        update = { promptParts: [...request.promptParts, PLAN_REQUEST_INSTRUCTION] };
      }

      if (state.processedMessageCount < messages.length) {
        const raw = extractPlanMarker(messages, state.processedMessageCount);
        state.processedMessageCount = messages.length;
        if (raw !== null) {
          const parsed = parsePlan(raw);
          if (parsed) {
            const known = getToolNames();
            const invalidTools = [...new Set(parsed.steps.map(s => s.tool).filter(tool => !known.has(tool)))];
            if (invalidTools.length > 0) {
              state.invalid = true;
              logger.warn(`[agent-planning] plan referenced unknown tool(s): ${invalidTools.join(", ")}`);
              emitter.send({
                type: "plan_created",
                valid: false,
                invalidTools,
                steps: parsed.steps.map(s => s.tool),
              });
              update = {
                ...(update ?? {}),
                tailAppend: [
                  ...(update?.tailAppend ?? request.tailAppend ?? []),
                  `⚠️ Your plan referenced unknown tool(s): ${invalidTools.join(", ")}. ` +
                  "These tools do not exist — ignore that plan and proceed using only the tools actually available to you.",
                ],
              };
            } else {
              state.plan = parsed;
              state.currentStepIndex = 0;
              emitter.send({
                type: "plan_created",
                valid: true,
                steps: parsed.steps.map(s => ({ tool: s.tool, purpose: s.purpose })),
                parallel: parsed.parallel,
              });
            }
          }
        }
      }

      return update ? { update } : undefined;
    },
  };
}

/** afterTool: compares each executed tool against the plan's next step and records drift. Never blocks. */
export function createPlanningToolMiddleware({ state, emitter, logger }) {
  return {
    name: PLANNING_TOOL_MIDDLEWARE_NAME,
    afterTool(request) {
      if (!state.plan) return undefined;
      const expected = state.plan.steps[state.currentStepIndex];
      if (!expected) return undefined; // plan already exhausted — nothing left to compare against

      if (expected.tool === request.name) {
        emitter.send({ type: "plan_step", index: state.currentStepIndex, tool: request.name, status: "on-track" });
        state.currentStepIndex++;
        return undefined;
      }

      logger.warn(`[agent-planning] drift at step ${state.currentStepIndex}: expected "${expected.tool}", got "${request.name}"`);
      emitter.send({
        type: "plan_drift",
        index: state.currentStepIndex,
        expectedTool: expected.tool,
        actualTool: request.name,
      });
      state.pendingDrift =
        `⚠️ Plan drift: step ${state.currentStepIndex + 1} of your plan expected tool "${expected.tool}" ` +
        `but you called "${request.name}". Continue if this was intentional, or return to the plan.`;
      return undefined;
    },
  };
}
