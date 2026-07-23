// lib/emitters/handlers/ws/turnLock.js
//
// Single-writer turn-interruption mutex for one WebSocket connection. Extracted
// verbatim from wsHandler.js's onConnection closure (Phase 5b, issue #307) — the
// identity-guard semantics below (registerChatTurn/finishChatTurn comparing the
// SAME object reference, not a copy) are what let a superseded turn's delayed
// cleanup run without clobbering a newer turn's state. This is a stateful
// factory, not the "return deltas" convention used by the other ws/*.js
// modules: those run start-to-finish within one message event, while this
// lock's entire purpose is holding state across separate, later invocations
// of ws.on("message", ...) so a later chat can supersede an earlier one.
//
// The prompt-cache warm-up controller is deliberately NOT part of this lock —
// it has its own lifecycle (owned by init()'s agent.warmCache() call, not
// handleChat) and must never affect this lock's "was a real turn interrupted"
// bookkeeping. It stays a separate local in wsHandler.js.

export function createTurnLock() {
  let abortController = null; // "real" turn's live AbortController (init or chat)
  let activeTurn = null;      // Promise of whichever turn (init OR chat) is in flight
  let activeChatTurn = null;  // { id, interrupted, promise } — chat turns only

  return {
    getAbort: () => abortController,
    setAbort: (c) => { abortController = c; },

    /**
     * Registers a bare turn promise (the "init" case) — self-clears via
     * identity-guarded settlement, same as a chat turn's finally block.
     * Returns the same promise so the caller can await it directly.
     */
    runInit(promiseFactory) {
      const initPromise = promiseFactory();
      activeTurn = initPromise;
      initPromise.then(
        () => { if (activeTurn === initPromise) activeTurn = null; },
        () => { if (activeTurn === initPromise) activeTurn = null; },
      );
      return initPromise;
    },

    /**
     * Chat case step 1: snapshot whether a turn was generating, mark the
     * currently registered chat turn (if any) interrupted, abort+null the
     * live controller. Deliberately unguarded — a throw here must propagate
     * to the caller, matching the original inline code exactly.
     */
    preempt() {
      const wasGenerating = !!abortController;
      if (activeChatTurn) activeChatTurn.interrupted = true;
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      return wasGenerating;
    },

    /** Chat case step 2: wait for whatever turn is currently in flight, swallowing rejection. */
    async awaitPrevious() {
      if (activeTurn) {
        try { await activeTurn; } catch { /* aborted turn */ }
      }
    },

    /**
     * Chat case step 3: build the turn handle, invoke startFn() synchronously
     * to obtain its promise (mirrors `turn.promise = handleChat(data)` — NOT
     * awaited here), then register it as the active chat/turn pointers.
     */
    registerChatTurn(id, startFn) {
      const turn = { id, interrupted: false, promise: null };
      turn.promise = startFn();
      activeChatTurn = turn;
      activeTurn = turn.promise;
      return turn;
    },

    /**
     * Chat case finally: identity-guarded clear. Only clears the shared
     * pointers if they still point at THIS turn — a newer turn may have
     * already replaced them, in which case this must be a no-op.
     */
    finishChatTurn(turn) {
      if (activeTurn === turn.promise) activeTurn = null;
      if (activeChatTurn === turn) activeChatTurn = null;
    },

    /** "stop" case: unguarded abort+null. */
    stop() {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },

    /** ws close handler: guarded abort+null — a throw must never block the rest of teardown. */
    abortForClose() {
      if (abortController) {
        try { abortController.abort(); } catch { /* best-effort */ }
        abortController = null;
      }
    },
  };
}
