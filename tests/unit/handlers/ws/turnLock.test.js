import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTurnLock } from "../../../../lib/emitters/handlers/ws/turnLock.js";

/** Run one full chat dispatch the way wsHandler's "chat" case does. */
async function dispatch(lock, id, startFn) {
  const turn = lock.beginChatTurn(id);
  try {
    await lock.awaitPrevious(turn);
    lock.startChatTurn(turn, startFn);
    await turn.promise;
  } catch { /* aborted turn */ } finally {
    lock.finishChatTurn(turn);
  }
  return turn;
}

describe("createTurnLock", () => {
  describe("getAbort / setAbort", () => {
    test("round-trips the controller reference", () => {
      const lock = createTurnLock();
      assert.strictEqual(lock.getAbort(), null);

      const controller = new AbortController();
      lock.setAbort(controller);
      assert.strictEqual(lock.getAbort(), controller);

      lock.setAbort(null);
      assert.strictEqual(lock.getAbort(), null);
    });

    test("does not abort a controller registered by a live turn", () => {
      const lock = createTurnLock();
      const turn = lock.beginChatTurn("t1");
      lock.startChatTurn(turn, () => new Promise(() => {}));

      const controller = new AbortController();
      lock.setAbort(controller);

      assert.strictEqual(controller.signal.aborted, false);
    });

    test("aborts immediately when the running turn was superseded while queued", () => {
      const lock = createTurnLock();
      const turn1 = lock.beginChatTurn("t1");
      lock.startChatTurn(turn1, () => new Promise(() => {}));
      lock.beginChatTurn("t2"); // supersedes turn1 before it registered a controller

      const controller = new AbortController();
      lock.setAbort(controller);

      assert.ok(controller.signal.aborted, "a superseded turn must never start generating");
    });
  });

  describe("beginChatTurn()", () => {
    test("returns false wasGenerating and does nothing when no controller is set", () => {
      const lock = createTurnLock();
      const turn = lock.beginChatTurn("t1");
      assert.strictEqual(turn.wasGenerating, false);
      assert.strictEqual(turn.interrupted, false);
      assert.strictEqual(turn.promise, null);
      assert.strictEqual(turn.id, "t1");
      assert.strictEqual(lock.getAbort(), null);
    });

    test("reports wasGenerating, aborts, and nulls the controller when one is set", () => {
      const lock = createTurnLock();
      const controller = new AbortController();
      lock.setAbort(controller);

      const turn = lock.beginChatTurn("t1");

      assert.strictEqual(turn.wasGenerating, true);
      assert.ok(controller.signal.aborted);
      assert.strictEqual(lock.getAbort(), null);
    });

    test("marks the currently running chat turn as interrupted", () => {
      const lock = createTurnLock();
      const turn1 = lock.beginChatTurn("t1");
      lock.startChatTurn(turn1, () => new Promise(() => {}));
      assert.strictEqual(turn1.interrupted, false);

      lock.beginChatTurn("t2");

      assert.strictEqual(turn1.interrupted, true);
    });

    test("marks a turn that has been claimed but has NOT started yet", () => {
      // Regression for T46: the previous implementation created the turn handle
      // only after awaiting the in-flight turn, so a chat arriving during that
      // window was invisible to the next chat's preempt and went on to report
      // `completed` despite having been superseded.
      const lock = createTurnLock();
      const queued = lock.beginChatTurn("t2");
      assert.strictEqual(queued.interrupted, false);

      lock.beginChatTurn("t3");

      assert.strictEqual(queued.interrupted, true);
    });

    test("hands an unstarted predecessor's wasGenerating forward", () => {
      // t2 is superseded before it generates anything, so it has nothing to
      // report as cut off — the fact belongs to t3, the turn that will answer.
      const lock = createTurnLock();
      const turn1 = lock.beginChatTurn("t1");
      lock.startChatTurn(turn1, () => new Promise(() => {}));
      lock.setAbort(new AbortController());

      const turn2 = lock.beginChatTurn("t2");
      assert.strictEqual(turn2.wasGenerating, true);

      const turn3 = lock.beginChatTurn("t3"); // t2 never started
      assert.strictEqual(turn3.wasGenerating, true, "the flag follows the turn that will generate");
    });

    test("does not inherit from a predecessor that already started", () => {
      const lock = createTurnLock();
      const turn1 = lock.beginChatTurn("t1");
      lock.startChatTurn(turn1, () => new Promise(() => {}));
      // turn1 started but never registered a controller (e.g. it finished its
      // pre-provider work and returned) — there was nothing to interrupt.
      const turn2 = lock.beginChatTurn("t2");
      assert.strictEqual(turn2.wasGenerating, false);
    });

    test("is unguarded — a throwing abort() propagates", () => {
      const lock = createTurnLock();
      lock.setAbort({ abort: () => { throw new Error("boom"); } });
      assert.throws(() => lock.beginChatTurn("t1"), /boom/);
    });
  });

  describe("awaitPrevious()", () => {
    test("resolves immediately when there is no earlier dispatch", async () => {
      const lock = createTurnLock();
      const turn = lock.beginChatTurn("t1");
      await assert.doesNotReject(() => lock.awaitPrevious(turn));
    });

    test("waits for the previous turn and swallows its rejection", async () => {
      const lock = createTurnLock();
      let reject;
      const pending = new Promise((_resolve, r) => { reject = r; });
      const first = lock.beginChatTurn("t1");
      lock.startChatTurn(first, () => pending);
      first.promise.catch(() => {});

      const second = lock.beginChatTurn("t2");
      let settled = false;
      const awaitPromise = lock.awaitPrevious(second).then(() => { settled = true; });

      await null;
      assert.strictEqual(settled, false);

      reject(new Error("aborted"));
      await pending.catch(() => {});
      lock.finishChatTurn(first);

      await assert.doesNotReject(() => awaitPromise);
      assert.strictEqual(settled, true);
    });

    test("serializes dispatches in arrival order, not in wake-up order", async () => {
      // Two chats arriving while a third is in flight must start one after the
      // other. Before the gate chain they both waited on the same promise and
      // then raced, letting two turns generate into one connection at once.
      const lock = createTurnLock();
      const order = [];
      let releaseFirst;
      const firstBody = new Promise((resolve) => { releaseFirst = resolve; });

      const first = lock.beginChatTurn("t1");
      lock.startChatTurn(first, () => firstBody);

      const second = dispatch(lock, "t2", async () => { order.push("t2-start"); });
      const third = dispatch(lock, "t3", async () => { order.push("t3-start"); });

      await null;
      assert.deepEqual(order, [], "neither queued turn starts while t1 is in flight");

      releaseFirst();
      await firstBody;
      lock.finishChatTurn(first);
      await Promise.all([second, third]);

      assert.deepEqual(order, ["t2-start", "t3-start"], "queued turns start in arrival order");
    });
  });

  describe("startChatTurn()", () => {
    test("calls startFn() exactly once, synchronously, and stores its promise", () => {
      const lock = createTurnLock();
      let calls = 0;
      const turn = lock.beginChatTurn("t1");
      lock.startChatTurn(turn, () => { calls++; return Promise.resolve("x"); });

      assert.strictEqual(calls, 1);
      assert.strictEqual(turn.id, "t1");
      assert.strictEqual(turn.interrupted, false);
      assert.ok(turn.promise instanceof Promise);
    });
  });

  describe("finishChatTurn() — identity-guard proof", () => {
    test("a late finishChatTurn() for a superseded turn does not clobber the newer turn's pointers", () => {
      const lock = createTurnLock();
      const turn1 = lock.beginChatTurn("t1");
      lock.startChatTurn(turn1, () => new Promise(() => {})); // never settles
      // Simulate turn1 being superseded by turn2: beginChatTurn marks turn1
      // interrupted, clears the controller, and takes over the active pointer.
      const turn2 = lock.beginChatTurn("t2");
      lock.startChatTurn(turn2, () => new Promise(() => {}));

      // turn1's cleanup runs late (its aborted promise finally-settles after
      // turn2 has already taken over) — this must not clear turn2's pointers.
      lock.finishChatTurn(turn1);

      // Proof: turn2 is still the active chat turn — a further arrival must
      // mark turn2 interrupted, not silently no-op.
      lock.beginChatTurn("t3");
      assert.strictEqual(turn2.interrupted, true);
    });

    test("clears the pointers when the finishing turn is still the active one", () => {
      const lock = createTurnLock();
      const turn = lock.beginChatTurn("t1");
      lock.startChatTurn(turn, () => Promise.resolve());
      lock.finishChatTurn(turn);

      // With no active turn left, the next arrival must report wasGenerating: false.
      assert.strictEqual(lock.beginChatTurn("t2").wasGenerating, false);
    });

    test("releases the gate so a queued chat is never stranded", async () => {
      const lock = createTurnLock();
      const first = lock.beginChatTurn("t1");
      // The dispatch throws before ever starting a turn — wsHandler's finally
      // still calls finishChatTurn, which must unblock everything behind it.
      lock.finishChatTurn(first);

      const second = lock.beginChatTurn("t2");
      await assert.doesNotReject(() => lock.awaitPrevious(second));
    });
  });

  describe("runInit()", () => {
    test("registers and awaits the given promise, then self-clears", async () => {
      const lock = createTurnLock();
      let resolveInit;
      const initPromise = new Promise(resolve => { resolveInit = resolve; });

      const returned = lock.runInit(() => initPromise);
      assert.strictEqual(returned, initPromise);

      // While init is pending, a chat's awaitPrevious() must wait for it.
      const turn = lock.beginChatTurn("t1");
      let awaited = false;
      const waiter = lock.awaitPrevious(turn).then(() => { awaited = true; });
      await null;
      assert.strictEqual(awaited, false);

      resolveInit();
      await initPromise;
      await waiter;
      assert.strictEqual(awaited, true);
    });

    test("a rejected init promise is swallowed by a subsequent awaitPrevious()", async () => {
      const lock = createTurnLock();
      lock.runInit(() => Promise.reject(new Error("init failed"))).catch(() => {});
      const turn = lock.beginChatTurn("t1");
      await assert.doesNotReject(() => lock.awaitPrevious(turn));
    });
  });

  describe("stop()", () => {
    test("aborts and nulls the controller", () => {
      const lock = createTurnLock();
      const controller = new AbortController();
      lock.setAbort(controller);

      lock.stop();

      assert.ok(controller.signal.aborted);
      assert.strictEqual(lock.getAbort(), null);
    });

    test("is a no-op when no controller is set", () => {
      const lock = createTurnLock();
      assert.doesNotThrow(() => lock.stop());
    });

    test("is unguarded — a throwing abort() propagates", () => {
      const lock = createTurnLock();
      lock.setAbort({ abort: () => { throw new Error("boom"); } });
      assert.throws(() => lock.stop(), /boom/);
    });
  });

  describe("abortForClose()", () => {
    test("aborts and nulls the controller", () => {
      const lock = createTurnLock();
      const controller = new AbortController();
      lock.setAbort(controller);

      lock.abortForClose();

      assert.ok(controller.signal.aborted);
      assert.strictEqual(lock.getAbort(), null);
    });

    test("is guarded — a throwing abort() is swallowed and the controller still ends up null", () => {
      const lock = createTurnLock();
      lock.setAbort({ abort: () => { throw new Error("boom"); } });

      assert.doesNotThrow(() => lock.abortForClose());
      assert.strictEqual(lock.getAbort(), null);
    });

    test("is a no-op when no controller is set", () => {
      const lock = createTurnLock();
      assert.doesNotThrow(() => lock.abortForClose());
    });
  });
});
