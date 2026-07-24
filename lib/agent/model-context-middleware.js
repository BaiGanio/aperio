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

// Splices tailAppend content into a *clone* of a target message, never
// mutating the original message object or array — the original stays safe
// to persist to the conversation store untouched. Skips work entirely when
// there's nothing to append (the common case pre-WS-C).
//
// `targetMessage` identifies the message by reference (e.g. the turn's
// `lastUser`), so content re-attaches at the same logical position on every
// hop of a tool-calling turn — hop 2+'s array's last element is a tool
// result, not the turn's originating message, so defaulting to "the last
// element" would silently attach to the wrong place past hop 1. Falls back
// to the array's last element when no target is given, or when the given
// target isn't found in `messages` (e.g. it was trimmed out of the window).
export function appendTailToMessages(messages, tailAppend, targetMessage) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (!Array.isArray(tailAppend) || tailAppend.length === 0) return messages;
  const text = tailAppend.join("\n\n");
  const found = targetMessage !== undefined ? messages.lastIndexOf(targetMessage) : -1;
  const targetIdx = found >= 0 ? found : messages.length - 1;
  const target = messages[targetIdx];
  const cloned = { ...target };
  if (typeof cloned.content === "string") {
    cloned.content = cloned.content ? `${cloned.content}\n\n${text}` : text;
  } else if (Array.isArray(cloned.content)) {
    const blocks = cloned.content.map(block => ({ ...block }));
    let lastTextIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.type === "text") { lastTextIdx = i; break; }
    }
    if (lastTextIdx >= 0) {
      blocks[lastTextIdx].text = blocks[lastTextIdx].text ? `${blocks[lastTextIdx].text}\n\n${text}` : text;
    } else {
      blocks.push({ type: "text", text });
    }
    cloned.content = blocks;
  } else {
    cloned.content = text;
  }
  const result = [...messages];
  result[targetIdx] = cloned;
  return result;
}

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
        // True only on the turn's first request — the newest message IS the
        // user's own turn, with no assistant/tool hops appended after it yet.
        // Later hops within the same turn append tool_use/tool_result entries
        // after lastUser, so this flips false and stays false for the rest of
        // the turn's tool-calling loop.
        const isFirstHop = messages.length > 0 && messages[messages.length - 1] === lastUser;
        // Exposed so later stages (skill-injection) can target tailAppend
        // splices at this same message on every hop, not just hop 1 — see
        // appendTailToMessages' targetMessage param.
        return { update: { messages, hwm, pct, dropped, userText, isFirstHop, lastUser } };
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
        // Attaches to the request's newest content (tailAppend) instead of
        // the cached system prompt (promptParts): the newest message is
        // never a cache hit regardless of what it contains, so this costs
        // nothing extra in cache terms. getSkillPrompts(turn) is already
        // deterministic per turn via ensureTurn's cache, so it's safe to
        // re-attach unconditionally on every hop rather than gating on
        // isFirstHop — appendTailToMessages targets `lastUser` (found in
        // context-trimming) so it lands at the same position hop over hop.
        return {
          update: {
            turn,
            tailAppend: skillPrompts.length
              ? [...request.tailAppend, ...skillPrompts]
              : request.tailAppend,
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
