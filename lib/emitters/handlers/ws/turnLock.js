// lib/emitters/handlers/ws/turnLock.js
//
// Single-writer turn-interruption mutex for one WebSocket connection. Extracted
// from wsHandler.js's onConnection closure (Phase 5b, issue #307). The
// identity-guard semantics below (startChatTurn/finishChatTurn comparing the
// SAME object reference, not a copy) are what let a superseded turn's delayed
// cleanup run without clobbering a newer turn's state. This is a stateful
// factory, not the "return deltas" convention used by the other ws/*.js
// modules: those run start-to-finish within one message event, while this
// lock's entire purpose is holding state across separate, later invocations
// of ws.on("message", ...) so a later chat can supersede an earlier one.
//
// Two rules make that safe when chats arrive faster than turns unwind (T46):
//
//   1. A turn is claimed at ARRIVAL (beginChatTurn), not at start. The original
//      code created the turn handle only after awaiting the previous turn, so
//      two chats arriving while a third was in flight both waited on the same
//      promise and then both registered — the older one registering *last* and
//      therefore never being marked interrupted. It reported `completed` even
//      though a newer chat had superseded it.
//   2. Dispatches are serialized in arrival order by an internal gate chain
//      (`tail`), so a queued turn cannot start generating alongside the newer
//      turn that already superseded it. A turn superseded while queued has its
//      controller aborted the moment the provider registers it (see setAbort),
//      so it unwinds immediately instead of streaming a stale reply into the
//      connection's shared transcript.
//
// The prompt-cache warm-up controller is deliberately NOT part of this lock —
// it has its own lifecycle (owned by init()'s agent.warmCache() call, not
// handleChat) and must never affect this lock's "was a real turn interrupted"
// bookkeeping. It stays a separate local in wsHandler.js.

const noop = () => {};

export function createTurnLock() {
  let abortController = null; // "real" turn's live AbortController (init or chat)
  let activeChatTurn = null;  // newest chat turn — claimed at arrival, may not have started yet
  let runningTurn = null;     // chat turn whose startFn() has actually begun
  // Settles when the currently-last dispatch (init or chat) is done. Every new
  // chat chains behind it and installs its own gate, which keeps dispatch order
  // identical to arrival order. Gates never reject.
  let tail = Promise.resolve();

  return {
    getAbort: () => abortController,

    /**
     * Registers the running turn's controller. If that turn was already
     * superseded while it waited its turn in the queue, abort immediately —
     * the provider must not generate for a turn the user has already replaced.
     */
    setAbort: (c) => {
      abortController = c;
      if (c && runningTurn?.interrupted) c.abort();
    },

    /**
     * Registers a bare turn promise (the "init" case). Chats arriving during
     * init queue behind it. Returns the same promise so the caller can await
     * it directly.
     */
    runInit(promiseFactory) {
      const previous = tail;
      const initPromise = promiseFactory();
      tail = Promise.allSettled([previous, initPromise]).then(noop);
      return initPromise;
    },

    /**
     * Chat case step 1 — synchronous, runs the instant the message arrives.
     * Snapshots whether a turn was generating, marks the current newest chat
     * turn (in flight OR still queued) interrupted, aborts the live controller,
     * and claims the arrival slot for this turn. Deliberately unguarded — a
     * throw here must propagate to the caller.
     *
     * @returns {{id: string|null, interrupted: boolean, wasGenerating: boolean, promise: Promise|null}}
     */
    beginChatTurn(id) {
      // A predecessor that was claimed but never started produced nothing to cut
      // off, so it does not tell the model it was interrupted — it hands that
      // fact to whichever turn finally generates, which is the one that needs it.
      const wasGenerating = !!abortController
        || !!(activeChatTurn && !activeChatTurn.started && activeChatTurn.wasGenerating);
      if (activeChatTurn) activeChatTurn.interrupted = true;
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      const turn = { id, interrupted: false, started: false, wasGenerating, promise: null, _previous: previous, _release: release };
      activeChatTurn = turn;
      return turn;
    },

    /** Chat case step 2: wait for every earlier dispatch to finish, swallowing rejection. */
    async awaitPrevious(turn) {
      try { await turn._previous; } catch { /* aborted turn */ }
    },

    /**
     * Chat case step 3: mark this turn as the running one and invoke startFn()
     * synchronously to obtain its promise (NOT awaited here).
     */
    startChatTurn(turn, startFn) {
      runningTurn = turn;
      turn.started = true;
      turn.promise = startFn();
      return turn;
    },

    /**
     * Chat case finally: identity-guarded clear, then release the gate so the
     * next queued chat can start. Only clears the shared pointers if they still
     * point at THIS turn — a newer turn may have already replaced them, in
     * which case that part must be a no-op. Releasing is always safe (a
     * resolved gate cannot un-resolve) and MUST happen on every path, or the
     * connection's remaining chats would queue forever.
     */
    finishChatTurn(turn) {
      if (runningTurn === turn) runningTurn = null;
      if (activeChatTurn === turn) activeChatTurn = null;
      turn._release();
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
