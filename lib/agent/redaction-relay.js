// lib/agent/redaction-relay.js
//
// Privacy Shield redact mode (issue #531): wraps a turn's emitter so every
// "token"/"stream_end" event has placeholder tokens restored to their real
// values before being forwarded — the one and only place a redacted reply
// becomes readable again, right before it reaches the user.
//
// Two ways a token's correlation id reaches `redactionMap`:
//  1. Proactively — lib/agent/tool-hooks.js's callToolHooked merges it in as
//     soon as a recall/self_recall call returns, well before the model's
//     answer streams. This is the fast path for every provider whose tool
//     calls actually go through callToolHooked.
//  2. On demand — Codex runs its OWN mcp/index.js subprocess and calls tools
//     directly, bypassing callToolHooked entirely (lib/agent/providers/
//     codex.js), so redactionMap is never proactively populated for it. Its
//     "token"/"stream_end" text is scanned for embedded correlation ids
//     (lib/privacy/redact.js's extractCorrelationIds) and each unseen one is
//     redeemed via takeRedactionMap() the moment it's observed — which is
//     also a valid (if redundant) path for every other provider, since a
//     redeemed id is a no-op the second time (memoryHandlers.js's
//     takeRedactionMap() is single-use).
//
// Redemption is async (an MCP round trip); emitter.send() is not. Every
// send is threaded through one promise chain so events still reach the
// socket in order, but the actual forwarding can now land a tick later than
// the synchronous call — callers that need to know every in-flight send has
// actually gone out (e.g. before reading finalText, which may itself need
// restoring) must await drain().

import { restore, createStreamRestorer, extractCorrelationIds } from "../privacy/redact.js";

/**
 * Mutates `emitter.send` IN PLACE (same object identity, never swapped for a
 * new object) — tool-hooks.js sets `emitter._confirmPending` on this exact
 * reference and the provider loops read it back off the same one, so a
 * different emitter object would silently break that gate. Always undo via
 * the returned `drain()`, not by re-assigning `emitter.send` yourself — the
 * original function reference must be restored exactly (not `.bind()`'d —
 * see drain()'s own comment) for callers relying on function identity (e.g.
 * a test's `t.mock.fn()`, whose `.mock.calls` tracking lives on that exact
 * object).
 *
 * @param {{send: (msg: object) => void}} emitter — mutated in place
 * @param {Map<string,string>} redactionMap — turn-wide token → original map;
 *   read AND written here (the on-demand path adds entries as it discovers them)
 * @param {(correlationId: string) => Promise<Record<string,string>|null>} [takeRedactionMap]
 *   redeems a correlation id over the private MCP side channel — omit to
 *   disable the on-demand path (proactive-only restoration still applies)
 * @returns {{ drain: () => Promise<void> }}
 */
export function installRedactionRelay(emitter, redactionMap, takeRedactionMap) {
  const originalSend = emitter.send;
  const streamRestorer = createStreamRestorer(redactionMap);
  const seenCorrelationIds = new Set();
  let chain = Promise.resolve();
  // Raw text held back from correlation-id scanning, separate from
  // streamRestorer's own buffer: a «…» token's UUID can land split across two
  // "token" chunks, and scanning each chunk in isolation (as msg.text alone)
  // never sees a complete id in either half. Held back the same way
  // streamRestorer holds back an unclosed placeholder — from the last
  // unmatched opening guillemet onward — until a later chunk closes it or the
  // stream ends (review round 5, P2).
  let idBuffer = "";

  function withheldFromLastOpenGuillemet(buf) {
    const lastOpen = buf.lastIndexOf("«");
    const lastClose = buf.lastIndexOf("»");
    const safeEnd = lastOpen > lastClose ? lastOpen : buf.length;
    return { safe: buf.slice(0, safeEnd), rest: buf.slice(safeEnd) };
  }

  // True when redactionMap already has an entry this id would resolve to —
  // either seeded before install, or merged in later by the PROACTIVE path
  // (tool-hooks.js's callToolHooked, running concurrently with this relay
  // for every provider except Codex) before this particular chunk of text
  // was observed. Checked live against the map (never a one-time snapshot)
  // so a late proactive merge is still seen — skips a redundant MCP round
  // trip for an id the fast path already resolved.
  function hasKnownEntryForId(id) {
    const prefix = `«${id}_`;
    for (const token of redactionMap.keys()) {
      if (token.startsWith(prefix)) return true;
    }
    return false;
  }

  async function resolveEmbedded(text) {
    if (typeof takeRedactionMap !== "function") return;
    const unknown = extractCorrelationIds(text).filter(id => !seenCorrelationIds.has(id) && !hasKnownEntryForId(id));
    if (!unknown.length) return;
    for (const id of unknown) seenCorrelationIds.add(id);
    await Promise.all(unknown.map(async (id) => {
      const rm = await takeRedactionMap(id).catch(() => null);
      if (rm && typeof rm === "object") {
        for (const [token, original] of Object.entries(rm)) redactionMap.set(token, original);
      }
    }));
  }

  emitter.send = (msg) => {
    if (msg?.type === "token" && typeof msg.text === "string") {
      chain = chain.then(async () => {
        const { safe, rest } = withheldFromLastOpenGuillemet(idBuffer + msg.text);
        idBuffer = rest;
        if (!safe) return; // entire chunk might be an in-progress placeholder/id — wait for more
        await resolveEmbedded(safe);
        const restored = streamRestorer.push(safe);
        if (restored) originalSend.call(emitter, { ...msg, text: restored });
      });
      return;
    }
    if (msg?.type === "stream_end") {
      chain = chain.then(async () => {
        const tail = idBuffer;
        idBuffer = "";
        await resolveEmbedded(tail);
        await resolveEmbedded(typeof msg.text === "string" ? msg.text : "");
        const restoredTail = tail ? streamRestorer.push(tail) : "";
        if (restoredTail) originalSend.call(emitter, { type: "token", text: restoredTail });
        const remainder = streamRestorer.flush();
        if (remainder) originalSend.call(emitter, { type: "token", text: remainder });
        originalSend.call(emitter, typeof msg.text === "string" ? { ...msg, text: restore(msg.text, redactionMap) } : msg);
      });
      return;
    }
    chain = chain.then(() => originalSend.call(emitter, msg));
  };

  return {
    // Awaits every send queued so far (including ones still resolving an
    // on-demand redemption) THEN restores emitter.send to the exact original
    // reference. Saved as a plain reference, not `.bind()`'d — a bound
    // function is a new object, and restoring `emitter.send` to one would
    // replace the caller's original function identity instead of truly
    // putting it back.
    async drain() {
      await chain;
      emitter.send = originalSend;
    },
  };
}
