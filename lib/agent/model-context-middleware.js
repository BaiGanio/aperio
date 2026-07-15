import {
  capToolResults,
  ctxPct,
  dropOrphanedToolResults,
  estimateMsgTokens,
  makeContextSignals,
  trimByTokens,
} from "../context/trim.js";

export const MODEL_CONTEXT_MIDDLEWARE_NAMES = Object.freeze([
  "context-trimming",
  "memory-pointers",
  "skill-injection",
  "tool-profile-selection",
]);

export const TOOL_RESULT_OFFLOAD_MIDDLEWARE_NAME = "tool-result-offloading";

export function projectObservedInputTokens({
  observedInputTokens = 0,
  previousMessageTokens = 0,
  currentMessageTokens = 0,
} = {}) {
  const observed = Math.max(0, Number(observedInputTokens) || 0);
  const previous = Math.max(0, Number(previousMessageTokens) || 0);
  const current = Math.max(0, Number(currentMessageTokens) || 0);
  return observed + Math.max(0, current - previous);
}

export function createModelContextMiddleware({
  emitter,
  logger,
  getMemoryPointers,
  ensureTurn,
  logTurnOnce,
  getSkillPrompts,
  getSelectedTools,
  maxHistory = 20,
}) {
  const contextSignals = makeContextSignals();

  return [
    {
      name: MODEL_CONTEXT_MIDDLEWARE_NAMES[0],
      beforeModel(request) {
        const capped = capToolResults(request.messages, request.contextWindow);
        const hwm = request.observedInputTokens > 0
          ? request.observedInputTokens
          : capped.reduce((sum, message) => sum + estimateMsgTokens(message), 0);
        const pct = ctxPct(hwm, request.contextWindow);
        contextSignals.emit(emitter, hwm, request.contextWindow);
        const { messages: raw, dropped } = trimByTokens(capped, hwm, request.contextWindow);
        const safe = dropped === 0 && raw.length > maxHistory
          ? [raw[0], ...raw.slice(-(maxHistory - 1))]
          : raw;
        if (dropped > 0) {
          const label = request.providerLabel ? `${request.providerLabel} ` : "";
          logger.info(`[agent] ${label}context trimmed: dropped ${dropped} messages at ${pct}% pressure`);
          emitter.send({ type: "context_trimmed", dropped, pct });
        }
        const messages = dropOrphanedToolResults(safe);
        const lastUser = [...messages].reverse().find(message =>
          (request.userTextRole === "any" || message.role === "user") &&
          (typeof message.content === "string" ||
            (Array.isArray(message.content) && message.content.some(block => block.type === "text")))
        );
        const userText = typeof lastUser?.content === "string"
          ? lastUser.content
          : lastUser?.content?.find?.(block => block.type === "text")?.text ?? "";
        return { update: { messages, hwm, pct, dropped, userText } };
      },
    },
    {
      name: MODEL_CONTEXT_MIDDLEWARE_NAMES[1],
      beforeModel(request) {
        const pointers = getMemoryPointers();
        if (!pointers.length) return undefined;
        return { update: { promptParts: [...request.promptParts, ...pointers] } };
      },
    },
    {
      name: MODEL_CONTEXT_MIDDLEWARE_NAMES[2],
      beforeModel(request) {
        const turn = ensureTurn(request.messages, request.userText);
        logTurnOnce(turn);
        const skillPrompts = getSkillPrompts(turn);
        return {
          update: {
            turn,
            promptParts: skillPrompts.length
              ? [...request.promptParts, ...skillPrompts]
              : request.promptParts,
          },
        };
      },
    },
    {
      name: MODEL_CONTEXT_MIDDLEWARE_NAMES[3],
      selectTools(request) {
        const turn = request.turn ?? ensureTurn(request.messages, request.userText);
        logTurnOnce(turn);
        return { update: { turn, tools: getSelectedTools(turn) } };
      },
    },
  ];
}

export function createToolResultOffloadMiddleware({
  offloadToolResult,
  artifactContext,
  artifactIds,
  emitter,
  logger,
}) {
  return {
    name: TOOL_RESULT_OFFLOAD_MIDDLEWARE_NAME,
    afterTool(request) {
      if (!offloadToolResult || !artifactContext) return undefined;
      try {
        const offloaded = offloadToolResult(request.result, {
          ...artifactContext,
          toolName: request.name,
        });
        for (const artifact of offloaded.artifacts) {
          artifactIds.add(artifact.id);
          logger.info(
            `[tool-result-offload] tool=${request.name} artifact=${artifact.id} ` +
            `scope=${artifact.scope} bytes=${artifact.byteCount} tokens=${artifact.originalTokenCount}`,
          );
          emitter.send({
            type: "tool_result_offloaded",
            name: request.name,
            artifactId: artifact.id,
            scope: artifact.scope,
            byteCount: artifact.byteCount,
            tokenCount: artifact.originalTokenCount,
          });
        }
        return { update: { result: offloaded.result } };
      } catch (error) {
        // Context pressure is preferable to silently losing the result.
        logger.warn(`[callToolHooked] result offload failed for ${request.name}: ${error.message}`);
        return undefined;
      }
    },
  };
}
