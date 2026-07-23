import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTurnLock } from "../../../../lib/emitters/handlers/ws/turnLock.js";

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
  });

  describe("preempt()", () => {
    test("returns false and does nothing when no controller is set", () => {
      const lock = createTurnLock();
      const wasGenerating = lock.preempt();
      assert.strictEqual(wasGenerating, false);
      assert.strictEqual(lock.getAbort(), null);
    });

    test("returns true, aborts, and nulls the controller when one is set", () => {
      const lock = createTurnLock();
      const controller = new AbortController();
      lock.setAbort(controller);

      const wasGenerating = lock.preempt();

      assert.strictEqual(wasGenerating, true);
      assert.ok(controller.signal.aborted);
      assert.strictEqual(lock.getAbort(), null);
    });

    test("marks the currently registered chat turn as interrupted", () => {
      const lock = createTurnLock();
      const turn = lock.registerChatTurn("t1", () => Promise.resolve());
      assert.strictEqual(turn.interrupted, false);

      lock.preempt();

      assert.strictEqual(turn.interrupted, true);
    });

    test("is unguarded — a throwing abort() propagates", () => {
      const lock = createTurnLock();
      lock.setAbort({ abort: () => { throw new Error("boom"); } });
      assert.throws(() => lock.preempt(), /boom/);
    });
  });

  describe("awaitPrevious()", () => {
    test("resolves immediately when there is no active turn", async () => {
      const lock = createTurnLock();
      await assert.doesNotReject(() => lock.awaitPrevious());
    });

    test("waits for the pending turn and swallows its rejection", async () => {
      const lock = createTurnLock();
      let reject;
      const pending = new Promise((_resolve, r) => { reject = r; });
      lock.registerChatTurn("t1", () => pending);

      let settled = false;
      const awaitPromise = lock.awaitPrevious().then(() => { settled = true; });

      assert.strictEqual(settled, false);
      reject(new Error("aborted"));
      await assert.doesNotReject(() => awaitPromise);
      assert.strictEqual(settled, true);
    });
  });

  describe("registerChatTurn()", () => {
    test("calls startFn() exactly once, synchronously, before returning", () => {
      const lock = createTurnLock();
      let calls = 0;
      const turn = lock.registerChatTurn("t1", () => { calls++; return Promise.resolve("x"); });

      assert.strictEqual(calls, 1);
      assert.deepStrictEqual(Object.keys(turn).sort(), ["id", "interrupted", "promise"]);
      assert.strictEqual(turn.id, "t1");
      assert.strictEqual(turn.interrupted, false);
      assert.ok(turn.promise instanceof Promise);
    });
  });

  describe("finishChatTurn() — identity-guard proof", () => {
    test("a late finishChatTurn() for a superseded turn does not clobber the newer turn's pointers", () => {
      const lock = createTurnLock();
      const turn1 = lock.registerChatTurn("t1", () => new Promise(() => {})); // never settles
      // Simulate turn1 being superseded by turn2 (as the "chat" case does):
      // preempt() marks turn1 interrupted and clears the controller, then a
      // new turn is registered, replacing the internal active-turn pointers.
      lock.preempt();
      const turn2 = lock.registerChatTurn("t2", () => new Promise(() => {}));

      // turn1's cleanup runs late (e.g. its aborted promise finally-settles
      // after turn2 has already taken over) — this must be a no-op.
      lock.finishChatTurn(turn1);

      // Proof: turn2 is still the active chat turn — preempting again must
      // mark turn2 interrupted, not silently no-op because turn1's stale
      // finishChatTurn already cleared the pointers.
      lock.preempt();
      assert.strictEqual(turn2.interrupted, true);
    });

    test("clears the pointers when the finishing turn is still the active one", () => {
      const lock = createTurnLock();
      const turn = lock.registerChatTurn("t1", () => Promise.resolve());
      lock.finishChatTurn(turn);

      // With no active turn left, preempt() must report wasGenerating: false.
      assert.strictEqual(lock.preempt(), false);
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
      let awaited = false;
      const waiter = lock.awaitPrevious().then(() => { awaited = true; });
      assert.strictEqual(awaited, false);

      resolveInit();
      await initPromise;
      await waiter;
      assert.strictEqual(awaited, true);
    });

    test("a rejected init promise is swallowed by a subsequent awaitPrevious()", async () => {
      const lock = createTurnLock();
      lock.runInit(() => Promise.reject(new Error("init failed"))).catch(() => {});
      await assert.doesNotReject(() => lock.awaitPrevious());
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
