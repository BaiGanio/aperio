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
  // How far past maxHistory the array may run before the count cap cuts it
  // back — see the comment at the cap itself. Defaults to maxHistory (cut at
  // 2x, back to 1x). 0 restores the old cut-on-every-hop behavior.
  historyCapSlack = maxHistory,
  // Called when the model-facing context sheds or truncates content that was
  // previously visible to the model — the token-pressure trim (dropped > 0),
  // the maxHistory message cap, or capToolResults truncating a tool result
  // (a large doc_batch output is reduced to head+tail, so the middle is no
  // longer model-visible even though no message was dropped). The caller
  // (lib/agent/index.js) uses this to invalidate session-scoped caches whose
  // entries are no longer fully reachable by the model (e.g. the doc_batch
  // dedup cache) — cache validity must follow the model-facing context, not
  // the untrimmed conversation lifetime (llamacpp-multiturn-latency.md Step
  // 3 review, rounds 7 + 9). Receives { dropped, historyCapped,
  // cappedToolResults, pct }. May be async; awaited, and fail-open (a
  // throwing observer never breaks the turn).
  onModelContextShed,
  // The connection's REAL, untrimmed conversation history (the same array
  // reference runAgentLoop received and that the provider loops mutate in
  // place — appending in place keeps this reference current hop over hop
  // within one turn). P1 review finding (llamacpp-multiturn-latency.md Step
  // 2, round 9): by the time this middleware's own skill-injection/tool-
  // profile-selection stages run, `request.messages` has already been
  // replaced by the FIRST stage (context-trimming) with the model-facing
  // trimmed tail. turn-planner.js's sticky pin/carry fold reconstructs
  // purely by scanning whatever `messages` it's given for historical
  // tool-using turns — handed the trimmed tail, it cannot tell "no tool used
  // in the last TOOL_PIN_TURNS turns" apart from "a tool WAS used, but
  // token-pressure trim or the 20-message history cap dropped that turn's
  // messages out of the window" (trimming is driven by token/message
  // budget, entirely independent of TOOL_PIN_TURNS). The latter silently
  // resets the pin early — or, for turnNum via countUserTurns, undercounts
  // it — for every provider, well before the plan's own "gap longer than
  // the pin window" condition was ever met. Falls back to `request.messages`
  // when omitted (e.g. a caller that has no separate untrimmed reference),
  // preserving prior behavior exactly.
  untrimmedMessages,
}) {
  const contextSignals = makeContextSignals();

  return [
    {
      name: MODEL_CONTEXT_MIDDLEWARE_NAMES[0],
      beforeModel: async (request) => {
        const capped = capToolResults(request.messages, request.contextWindow);
        // capToolResults returns a NEW array iff it truncated at least one
        // tool_result (otherwise the same reference) — that identity change is
        // the capping signal. A truncated doc_batch result leaves the omitted
        // middle permanently invisible to the model even though nothing was
        // dropped, so a later "already read" pointer for it would withhold
        // content the model never actually saw (round 9, P1).
        const cappedToolResults = capped !== request.messages;
        const hwm = request.observedInputTokens > 0
          ? request.observedInputTokens
          : capped.reduce((sum, message) => sum + estimateMsgTokens(message), 0);
        const pct = ctxPct(hwm, request.contextWindow);
        contextSignals.emit(emitter, hwm, request.contextWindow);
        const { messages: raw, dropped } = trimByTokens(capped, hwm, request.contextWindow);
        // The message-count cap is a belt-and-braces bound on array growth, not
        // the context guard — trimByTokens above is that, and it fires on the
        // real token budget. The cap deletes from the FRONT, which is exactly
        // the cached prefix, so every cut costs llama.cpp a reprocess of
        // everything behind the cut point. Firing it the moment the array
        // passes maxHistory was the worst possible schedule: a tool-using turn
        // grows the array by 2 messages per hop and the cap took 2 back off on
        // every hop, so a chatty turn paid that reprocess over and over, while
        // token pressure sat far below the trim threshold (measured 2026-08-13
        // on the T-G2.3 gate at ~30-50k of a 104,570-token window: the array
        // oscillated 20↔21 and llama-server reprocessed 24,494 tokens / 233 s,
        // then 25,122 / 240 s on the very next hop — 473 s of one turn spent
        // re-reading content nothing had asked to drop).
        // Hysteresis fixes the schedule without giving up the bound: let the
        // array run to maxHistory + slack, then cut back to maxHistory in ONE
        // bite, so cuts are rare and their cost is amortized instead of paid
        // per hop. With the default slack (= maxHistory) a 20-message cap does
        // not fire until 41 messages.
        const historyCapped = dropped === 0 && raw.length > maxHistory + historyCapSlack;
        const safe = historyCapped
          ? [raw[0], ...raw.slice(-(maxHistory - 1))]
          : raw;
        if (dropped > 0) {
          const label = request.providerLabel ? `${request.providerLabel} ` : "";
          logger.info(`[agent] ${label}context trimmed: dropped ${dropped} messages at ${pct}% pressure`);
          emitter.send({ type: "context_trimmed", dropped, pct });
        }
        // The model-facing context shed content one of three ways — the
        // token-pressure trim above, the history cap, or a tool result
        // truncated in place by capToolResults. Tool results that carried
        // document text (or an offloaded-artifact pointer) may be among the
        // shed/truncated content, so any cache keyed to what this model has
        // "already seen" must be invalidated, or a later call would return a
        // dedup pointer for content the model can no longer actually see.
        // Fires on EVERY qualifying shed — a turn under continuous pressure
        // sheds different content hop after hop (the freshest pair is pinned,
        // but older results keep falling out), so a per-turn latch would leave
        // stale entries for content shed after the first clear (round 9, P1).
        // Await the observer so the shed is fully processed (e.g. the MCP
        // round trip clearing the doc_batch dedup cache) before the trimmed
        // request goes to the model and any follow-up tool call can race
        // ahead of it.
        if ((dropped > 0 || historyCapped || cappedToolResults) && onModelContextShed) {
          try {
            await onModelContextShed({ dropped, historyCapped, cappedToolResults, pct });
          } catch (err) {
            // Fail open: the trim already happened; a failed cache-clear
            // observer must not break the turn.
            logger.warn(`[model-context] onModelContextShed failed: ${err.message}`);
          }
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
        // `request.messages` here is already the trimmed, model-facing tail
        // (context-trimming, the first stage, replaced it) — passed as
        // imageMessages so hasInlineImage/standaloneVision reflect what the
        // model can actually see, distinct from `untrimmedMessages` used for
        // sticky pin/carry reconstruction (P2 review finding: an image far
        // enough back to have been trimmed out must not still be able to
        // classify an unrelated later turn as standalone vision).
        const turn = ensureTurn(untrimmedMessages ?? request.messages, request.userText, request.messages);
        logTurnOnce(turn);
        const skillPrompts = getSkillPrompts(turn);
        // Skills attach to the cached system prompt (promptParts), NOT to the
        // request's newest message (tailAppend).
        //
        // This used to attach to tailAppend, reasoning that "the newest
        // message is never a cache hit regardless of what it contains, so
        // this costs nothing extra in cache terms". That is true *within* a
        // turn and false *across* turns: turn N's newest message is turn
        // N+1's cached prefix, and stripping the skill body back off it
        // rewrites the array at the first user message, so every token after
        // that point has to be reprocessed.
        //
        // Measured on the 2026-08-13 T-G2.3 round-6 msgprint diagnostic:
        // message index 1 went 23,411B → 199B across a turn boundary as a
        // 22,937-byte SKILL.md moved to the new newest message. That capped
        // llama.cpp KV reuse at exactly system+tools (~14.4k tokens) and cost
        // 250-300s of pure prefill on turns 1 and 3 of every run — the
        // dominant cause of the per-turn wall-clock aborts throughout that
        // epic. In the system prompt the block sits in the stable cached
        // prefix and only moves when the matched skill set itself changes,
        // which the skill-block pin (turn-planner.js's resolvePinnedSkills)
        // freezes outright for the life of a flow.
        //
        // getSkillPrompts(turn) is deterministic per turn via ensureTurn's
        // cache, so re-deriving it on every hop within a turn stays
        // byte-identical.
        //
        // Cross-turn stability is the property this placement needs, and it
        // does not come for free: when the matched set changes between turns
        // the system prompt changes at byte 0 and nothing is reused at all —
        // measured on the round-6 verification run at the turn 1→2 boundary,
        // sysBytes 46,134 → 52,810 as one extra skill matched, costing a full
        // ~45k-token reprocess and a 600 s per-turn abort. With a stable set
        // the same placement is a large win (turn 0→1 went from 33,836
        // reprocessed tokens / 306 s to 845 / 11.8 s). Stability is supplied
        // by the skill-block pin in turn-planner.js (resolvePinnedSkills),
        // which freezes a live flow's resolved block for the pin window; this
        // stage stays deliberately dumb about it and just injects whatever
        // getSkillPrompts(turn) resolved to.
        return {
          update: {
            turn,
            promptParts: skillPrompts.length
              ? [...request.promptParts, ...skillPrompts]
              : request.promptParts,
            // Recorded so prepareModelContext can rebuild a skill-free system
            // prompt for the small-context overflow fallback, which used to
            // drop skills by re-splicing the message array instead.
            skillPromptParts: skillPrompts,
          },
        };
      },
    },
    {
      name: MODEL_CONTEXT_MIDDLEWARE_NAMES[3],
      selectTools(request) {
        const turn = request.turn ?? ensureTurn(untrimmedMessages ?? request.messages, request.userText, request.messages);
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
  // Optional: invalidates the docgraph doc_batch session dedup cache
  // (lib/docgraph/retrieval.js's sessionReadFacts, committed inside the MCP
  // child process the instant doc_batch returns — see docgraphHandlers.js's
  // `commitSessionFacts`). That commit happens BEFORE this middleware ever
  // sees the result, so when the result is large enough to be offloaded here,
  // the model only ever receives the head/tail preview text (finalizeToolResult
  // in tool-hooks.js returns THIS function's `result`, not the raw tool
  // output) while the cache already claims the full document was "already
  // read" — a later doc_batch for the same document (a new turn, once
  // read_artifact's turn-scoped exposure has expired) would then return only
  // the dedup pointer, permanently withholding content the model never
  // actually saw (round 14, P1; same root cause as rounds 7/9's
  // onModelContextShed, but offload is an entirely separate shedding path
  // context-trimming's hook was never wired to). Fires on ANY offloaded tool,
  // not just doc_batch — conservative by design, matching round 7's "a trim
  // clears the whole session's cache" precedent: the pointer is only an
  // optimization, so an unrelated tool's offload costs one harmless extra
  // re-read rather than risking a missed invalidation. Awaited so the MCP
  // round trip completes before the offloaded (preview) result is used by any
  // later hop in this turn.
  clearDocSessionCache = null,
  docSessionId = null,
}) {
  return {
    name: TOOL_RESULT_OFFLOAD_MIDDLEWARE_NAME,
    async afterTool(request) {
      if (!offloadToolResult || !artifactContext) return undefined;
      try {
        const offloaded = offloadToolResult(request.result, {
          ...artifactContext,
          toolName: request.name,
        });
        if (offloaded.artifacts.length && clearDocSessionCache && docSessionId) {
          try {
            await clearDocSessionCache(docSessionId);
          } catch (err) {
            logger.warn(`[tool-result-offload] doc-session cache clear failed: ${err.message}`);
          }
        }
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
        // Envelope pointer for the tool_result event (agent-harness-epic WS3):
        // same {id, tokenCount, byteCount} the tool_result_offloaded event and
        // the model-facing preview text carry, just structured for the UI/harness
        // instead of requiring either be parsed. First artifact only — a single
        // string result never produces more than one.
        const [artifact] = offloaded.artifacts;
        return {
          update: {
            result: offloaded.result,
            ...(artifact ? { artifact: { id: artifact.id, tokenCount: artifact.originalTokenCount, byteCount: artifact.byteCount } } : {}),
          },
        };
      } catch (error) {
        // Context pressure is preferable to silently losing the result.
        logger.warn(`[callToolHooked] result offload failed for ${request.name}: ${error.message}`);
        return undefined;
      }
    },
  };
}
