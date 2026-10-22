import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  InterruptConflictError,
  InterruptValidationError,
  createInterruptService,
  interruptDigest,
} from "../../../lib/security/interruptService.js";

function makeStore() {
  const rows = new Map();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = id => clone(rows.get(id) ?? null);
  return {
    rows,
    async createAgentInterrupt(input) {
      const row = {
        id: input.id,
        session_id: input.sessionId ?? null,
        run_id: input.runId ?? null,
        tool_name: input.toolName,
        canonical_arguments: clone(input.canonicalArguments ?? null),
        protected_payload_ref: clone(input.protectedPayloadRef ?? null),
        digest: input.digest,
        allowed_decisions: clone(input.allowedDecisions),
        decision: null,
        decision_payload: null,
        claim_id: null,
        status: input.status ?? "pending",
        created_at: input.createdAt ?? "2026-07-07T00:00:00.000Z",
        updated_at: input.updatedAt ?? "2026-07-07T00:00:00.000Z",
        decided_at: null,
        claimed_at: null,
        completed_at: null,
        expires_at: input.expiresAt ?? null,
      };
      rows.set(row.id, row);
      return get(row.id);
    },
    async getAgentInterrupt(id) {
      return get(id);
    },
    async listAgentInterrupts({ sessionId, status = "pending" } = {}) {
      return [...rows.values()]
        .filter(row => !sessionId || row.session_id === sessionId)
        .filter(row => !status || row.status === status)
        .map(row => clone(row));
    },
    async updateAgentInterruptStatus(id, status) {
      const row = rows.get(id);
      if (!row) return null;
      row.status = status;
      row.updated_at = "2026-07-07T00:01:00.000Z";
      return get(id);
    },
    async expireAgentInterrupts(now) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.status === "pending" && row.expires_at && row.expires_at <= now) {
          row.status = "expired";
          row.updated_at = now;
          count++;
        }
      }
      return count;
    },
    async decideAgentInterrupt(id, { decision, status, decisionPayload, now }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending" || (row.expires_at && row.expires_at <= now)) return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return get(id);
    },
    async claimAgentInterrupt(id, { claimId, now }) {
      const row = rows.get(id);
      if (!row || !["approved", "edited"].includes(row.status) || (row.expires_at && row.expires_at <= now)) return null;
      row.status = "claimed";
      row.claim_id = claimId;
      row.claimed_at = now;
      row.updated_at = now;
      return get(id);
    },
    async completeAgentInterrupt(id, { status, now }) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed") return null;
      row.status = status;
      row.completed_at = now;
      row.updated_at = now;
      return get(id);
    },
  };
}

describe("interruptDigest", () => {
  test("is stable across object key order", () => {
    const a = interruptDigest({ toolName: "write_file", canonicalArguments: { b: 2, a: 1 } });
    const b = interruptDigest({ toolName: "write_file", canonicalArguments: { a: 1, b: 2 } });
    assert.equal(a, b);
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
  });
});

describe("createInterruptService", () => {
  test("creates, lists, approves, claims, and completes an interrupt", async () => {
    const store = makeStore();
    const revalidated = [];
    const service = createInterruptService({
      store,
      now: () => "2026-07-07T00:00:00.000Z",
      idFactory: () => "interrupt-1",
      claimIdFactory: () => "claim-1",
      revalidate: async input => {
        revalidated.push(input.phase);
        return input.canonicalArguments;
      },
    });

    const created = await service.create({
      sessionId: "session-a",
      toolName: "write_file",
      canonicalArguments: { path: "/tmp/a.txt", content: "hello" },
      allowedDecisions: ["approve", "edit", "reject", "respond"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(created.id, "interrupt-1");
    assert.equal((await service.list({ sessionId: "session-a" })).length, 1);

    const approved = await service.decide("interrupt-1", { decision: "approve" });
    assert.equal(approved.status, "approved");

    const claimed = await service.claim("interrupt-1");
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claim_id, "claim-1");
    assert.deepEqual(claimed.execution_arguments, { path: "/tmp/a.txt", content: "hello" });

    const completed = await service.complete("interrupt-1");
    assert.equal(completed.status, "executed");
    assert.deepEqual(revalidated, ["create", "decide", "claim"]);
  });

  test("edit decisions revalidate edited arguments and execute the edited payload", async () => {
    const store = makeStore();
    const service = createInterruptService({
      store,
      idFactory: () => "interrupt-edit",
      claimIdFactory: () => "claim-edit",
      revalidate: async input => ({ ...input.canonicalArguments, normalized: true }),
    });
    await service.create({
      sessionId: "session-a",
      toolName: "write_file",
      canonicalArguments: { path: "/tmp/a.txt", content: "old" },
      allowedDecisions: ["edit", "reject"],
    });

    const edited = await service.decide("interrupt-edit", {
      decision: "edit",
      editedArguments: { path: "/tmp/a.txt", content: "new" },
    });
    assert.equal(edited.status, "edited");
    assert.deepEqual(edited.decision_payload.editedArguments, {
      path: "/tmp/a.txt",
      content: "new",
      normalized: true,
    });

    const claimed = await service.claim("interrupt-edit");
    assert.deepEqual(claimed.execution_arguments, {
      path: "/tmp/a.txt",
      content: "new",
      normalized: true,
    });
  });

  test("decisions are idempotent for the same decision and conflict otherwise", async () => {
    const store = makeStore();
    const service = createInterruptService({ store, idFactory: () => "interrupt-replay" });
    await service.create({
      sessionId: "session-a",
      toolName: "delete_file",
      canonicalArguments: { path: "/tmp/a.txt" },
      allowedDecisions: ["reject", "approve"],
    });

    const first = await service.decide("interrupt-replay", { decision: "reject" });
    const replay = await service.decide("interrupt-replay", { decision: "reject" });
    assert.equal(replay.status, first.status);

    await assert.rejects(
      () => service.decide("interrupt-replay", { decision: "approve" }),
      InterruptConflictError,
    );
  });

  test("rejects disallowed decisions before changing state", async () => {
    const store = makeStore();
    const service = createInterruptService({ store, idFactory: () => "interrupt-disallowed" });
    await service.create({
      sessionId: "session-a",
      toolName: "delete_file",
      canonicalArguments: { path: "/tmp/a.txt" },
      allowedDecisions: ["reject"],
    });

    await assert.rejects(
      () => service.decide("interrupt-disallowed", { decision: "approve" }),
      InterruptValidationError,
    );
    assert.equal((await store.getAgentInterrupt("interrupt-disallowed")).status, "pending");
  });

  test("claim revalidates immediately before execution and does not claim on failure", async () => {
    const store = makeStore();
    const service = createInterruptService({
      store,
      idFactory: () => "interrupt-invalid",
      revalidate: async input => {
        if (input.phase === "claim") throw new InterruptValidationError("target changed");
        return input.canonicalArguments;
      },
    });
    await service.create({
      sessionId: "session-a",
      toolName: "write_file",
      canonicalArguments: { path: "/tmp/a.txt", content: "hello" },
      allowedDecisions: ["approve"],
    });
    await service.decide("interrupt-invalid", { decision: "approve" });

    await assert.rejects(() => service.claim("interrupt-invalid"), /target changed/);
    assert.equal((await store.getAgentInterrupt("interrupt-invalid")).status, "approved");
  });

  test("claimAndExecute marks failed executions and prevents duplicate execution", async () => {
    const store = makeStore();
    let calls = 0;
    const service = createInterruptService({
      store,
      idFactory: () => "interrupt-exec",
      executeTool: async () => {
        calls++;
        return "done";
      },
    });
    await service.create({
      sessionId: "session-a",
      toolName: "write_file",
      canonicalArguments: { path: "/tmp/a.txt", content: "hello" },
      allowedDecisions: ["approve"],
    });
    await service.decide("interrupt-exec", { decision: "approve" });

    const executed = await service.claimAndExecute("interrupt-exec");
    assert.equal(executed.result, "done");
    assert.equal(executed.interrupt.status, "executed");
    assert.equal(calls, 1);

    await assert.rejects(
      () => service.claimAndExecute("interrupt-exec"),
      InterruptConflictError,
    );
    assert.equal(calls, 1);
  });

  test("expires pending interrupts before list and decision", async () => {
    const store = makeStore();
    const service = createInterruptService({
      store,
      idFactory: () => "interrupt-expired",
      now: () => "2026-07-07T00:00:00.000Z",
    });
    await service.create({
      sessionId: "session-a",
      toolName: "delete_file",
      canonicalArguments: { path: "/tmp/a.txt" },
      allowedDecisions: ["approve"],
      expiresAt: "2026-07-06T00:00:00.000Z",
    });

    assert.deepEqual(await service.list({ sessionId: "session-a" }), []);
    const expired = await service.decide("interrupt-expired", { decision: "approve" });
    assert.equal(expired.status, "expired");
  });
});
