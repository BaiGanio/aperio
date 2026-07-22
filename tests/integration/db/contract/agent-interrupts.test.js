// tests/integration/db/contract/agent-interrupts.test.js
// Shared contract: durable agent interrupts (agent_interrupts table), run
// identically against a real SqliteStore and (opt-in) a real PostgresStore.
// See backends.js for why.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`agent interrupts store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("createAgentInterrupt -> getAgentInterrupt roundtrips a pending descriptor", async () => {
      const id = contractId("interrupt");
      const sessionId = contractId("session");
      const interrupt = await store.createAgentInterrupt({
        id, sessionId, runId: contractId("run"),
        toolName: "write_file",
        canonicalArguments: { path: "notes/todo.md", content: "hello" },
        digest: "sha256:abc",
        allowedDecisions: ["approve", "edit", "reject", "respond"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      assert.equal(interrupt.id, id);
      assert.equal(interrupt.session_id, sessionId);
      assert.equal(interrupt.tool_name, "write_file");
      assert.deepEqual(interrupt.canonical_arguments, { path: "notes/todo.md", content: "hello" });
      assert.equal(interrupt.protected_payload_ref, null);
      assert.deepEqual(interrupt.allowed_decisions, ["approve", "edit", "reject", "respond"]);
      assert.equal(interrupt.status, "pending");

      const fetched = await store.getAgentInterrupt(id);
      assert.deepEqual(fetched.canonical_arguments, interrupt.canonical_arguments);
    });

    test("stores protected payload references when arguments are offloaded", async () => {
      const id = contractId("interrupt-payload");
      const interrupt = await store.createAgentInterrupt({
        id, sessionId: contractId("session"),
        toolName: "write_file",
        protectedPayloadRef: { artifactId: "artifact-1", mediaType: "application/json" },
        digest: "sha256:def",
        allowedDecisions: ["approve", "reject"],
      });
      assert.equal(interrupt.canonical_arguments, null);
      assert.deepEqual(interrupt.protected_payload_ref, { artifactId: "artifact-1", mediaType: "application/json" });
    });

    test("rejects descriptors that cannot be durably reconstructed as JSON", async () => {
      await assert.rejects(
        () => store.createAgentInterrupt({
          id: contractId("interrupt-bad"),
          sessionId: contractId("session"),
          toolName: "write_file",
          canonicalArguments: { run: () => {} },
          digest: "sha256:function",
          allowedDecisions: ["approve"],
        }),
        /JSON-serializable/
      );
    });

    test("listAgentInterrupts filters by session and excludes expired rows by default", async () => {
      const sessionId = contractId("session-list");
      const pendingId = contractId("interrupt-pending");
      const expiredId = contractId("interrupt-expired");
      const otherId = contractId("interrupt-other-session");

      await store.createAgentInterrupt({
        id: pendingId, sessionId, toolName: "write_file",
        canonicalArguments: { path: "a.txt" }, digest: "sha256:a",
        allowedDecisions: ["approve", "reject"], expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await store.createAgentInterrupt({
        id: expiredId, sessionId, toolName: "delete_file",
        canonicalArguments: { path: "old.txt" }, digest: "sha256:expired",
        allowedDecisions: ["approve", "reject"], expiresAt: "2000-01-01T00:00:00.000Z",
      });
      await store.createAgentInterrupt({
        id: otherId, sessionId: contractId("session-other"), toolName: "write_file",
        canonicalArguments: { path: "other.txt" }, digest: "sha256:other",
        allowedDecisions: ["approve", "reject"],
      });

      const pending = await store.listAgentInterrupts({ sessionId });
      assert.ok(pending.some((i) => i.id === pendingId));
      assert.ok(!pending.some((i) => i.id === expiredId), "expired rows excluded by default");
      assert.ok(!pending.some((i) => i.id === otherId), "other session excluded");

      const withExpired = await store.listAgentInterrupts({ sessionId, includeExpired: true });
      assert.ok(withExpired.some((i) => i.id === expiredId));
    });

    test("updateAgentInterruptStatus moves a row out of the pending set", async () => {
      const id = contractId("interrupt-status");
      const sessionId = contractId("session-status");
      await store.createAgentInterrupt({
        id, sessionId, toolName: "write_file",
        canonicalArguments: { path: "a.txt" }, digest: "sha256:a",
        allowedDecisions: ["approve", "reject"],
      });

      const updated = await store.updateAgentInterruptStatus(id, "rejected");
      assert.equal(updated.status, "rejected");
      assert.equal((await store.getAgentInterrupt(id)).status, "rejected");

      const pending = await store.listAgentInterrupts({ sessionId });
      assert.ok(!pending.some((i) => i.id === id));
      const rejected = await store.listAgentInterrupts({ sessionId, status: "rejected" });
      assert.ok(rejected.some((i) => i.id === id));
    });

    test("full lifecycle: expire, decide, claim, complete — each conditionally", async () => {
      const sessionId = contractId("session-lifecycle");
      const liveId = contractId("interrupt-live");
      const staleId = contractId("interrupt-stale");

      await store.createAgentInterrupt({
        id: liveId, sessionId, toolName: "write_file",
        canonicalArguments: { path: "notes.md", content: "hello" }, digest: "sha256:live",
        allowedDecisions: ["approve", "reject"], expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await store.createAgentInterrupt({
        id: staleId, sessionId, toolName: "delete_file",
        canonicalArguments: { path: "old.md" }, digest: "sha256:stale",
        allowedDecisions: ["approve"], expiresAt: "2000-01-01T00:00:00.000Z",
      });

      assert.ok(await store.expireAgentInterrupts("2026-07-07T00:00:00.000Z") >= 1);
      assert.equal((await store.getAgentInterrupt(staleId)).status, "expired");

      const decided = await store.decideAgentInterrupt(liveId, {
        decision: "approve", status: "approved", decisionPayload: null,
        now: "2026-07-07T00:00:00.000Z",
      });
      assert.equal(decided.status, "approved");
      assert.equal(decided.decision, "approve");
      assert.ok(decided.decided_at);

      assert.equal(await store.decideAgentInterrupt(liveId, {
        decision: "reject", status: "rejected", now: "2026-07-07T00:01:00.000Z",
      }), null, "already decided — no double-decide");

      const claimed = await store.claimAgentInterrupt(liveId, {
        claimId: contractId("claim"), now: "2026-07-07T00:02:00.000Z",
      });
      assert.equal(claimed.status, "claimed");
      assert.ok(claimed.claimed_at);

      assert.equal(await store.claimAgentInterrupt(liveId, {
        claimId: contractId("claim-replay"), now: "2026-07-07T00:03:00.000Z",
      }), null, "already claimed — no double-claim");

      const completed = await store.completeAgentInterrupt(liveId, {
        status: "executed", now: "2026-07-07T00:04:00.000Z",
      });
      assert.equal(completed.status, "executed");
      assert.ok(completed.completed_at);
    });
  });
}
