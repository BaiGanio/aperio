import { createHash, randomUUID } from "node:crypto";

const DECISIONS = new Set(["approve", "edit", "reject", "respond"]);
const EXECUTABLE_STATUSES = new Set(["approved", "edited"]);
const FINAL_STATUSES = new Set(["rejected", "responded", "expired", "claimed", "executed", "failed"]);

export class InterruptConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "InterruptConflictError";
  }
}

export class InterruptValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "InterruptValidationError";
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

export function interruptDigest({ toolName, canonicalArguments = null, protectedPayloadRef = null }) {
  return "sha256:" + createHash("sha256")
    .update(stableJson({ toolName, canonicalArguments, protectedPayloadRef }))
    .digest("hex");
}

function assertAllowedDecisions(allowedDecisions) {
  if (!Array.isArray(allowedDecisions) || allowedDecisions.length === 0) {
    throw new InterruptValidationError("allowedDecisions must be a non-empty array");
  }
  for (const decision of allowedDecisions) {
    if (!DECISIONS.has(decision)) throw new InterruptValidationError(`unsupported interrupt decision "${decision}"`);
  }
}

function decisionStatus(decision) {
  switch (decision) {
    case "approve": return "approved";
    case "edit": return "edited";
    case "reject": return "rejected";
    case "respond": return "responded";
    default: throw new InterruptValidationError(`unsupported interrupt decision "${decision}"`);
  }
}

function nowIso(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isExpired(row, now) {
  return row?.expires_at && new Date(row.expires_at).getTime() <= new Date(now).getTime();
}

function sameDecision(row, decision, payload) {
  return row?.decision === decision && stableJson(row?.decision_payload ?? null) === stableJson(payload ?? null);
}

function executionArguments(row) {
  if (row.status === "edited") return row.decision_payload?.editedArguments ?? null;
  return row.canonical_arguments;
}

async function defaultRevalidate({ canonicalArguments }) {
  return canonicalArguments;
}

export function createInterruptService({
  store,
  revalidate = defaultRevalidate,
  executeTool = null,
  now = () => new Date(),
  idFactory = randomUUID,
  claimIdFactory = randomUUID,
} = {}) {
  if (!store) throw new TypeError("Interrupt service requires a store");

  async function expire() {
    return store.expireAgentInterrupts(nowIso(now));
  }

  async function create(input) {
    assertAllowedDecisions(input.allowedDecisions);
    const canonicalArguments = input.canonicalArguments !== undefined
      ? await revalidate({ phase: "create", toolName: input.toolName, canonicalArguments: input.canonicalArguments, tainted: input.tainted === true })
      : undefined;
    const protectedPayloadRef = input.protectedPayloadRef;
    const digest = input.digest ?? interruptDigest({
      toolName: input.toolName,
      canonicalArguments: canonicalArguments ?? null,
      protectedPayloadRef: protectedPayloadRef ?? null,
    });
    return store.createAgentInterrupt({
      ...input,
      id: input.id ?? idFactory(),
      canonicalArguments,
      protectedPayloadRef,
      digest,
    });
  }

  async function list(scope = {}) {
    await expire();
    return store.listAgentInterrupts(scope);
  }

  async function decide(id, { decision, editedArguments = undefined, response = undefined } = {}) {
    if (!DECISIONS.has(decision)) throw new InterruptValidationError(`unsupported interrupt decision "${decision}"`);
    const row = await store.getAgentInterrupt(id);
    if (!row) return null;
    const currentNow = nowIso(now);
    if (isExpired(row, currentNow) && row.status === "pending") {
      await store.updateAgentInterruptStatus(id, "expired");
      return store.getAgentInterrupt(id);
    }
    if (row.status === "expired") return row;
    if (!row.allowed_decisions.includes(decision)) {
      throw new InterruptValidationError(`decision "${decision}" is not allowed for interrupt ${id}`);
    }
    if (row.status !== "pending") {
      const payload = decision === "edit"
        ? { editedArguments }
        : decision === "respond"
          ? { response: response ?? "" }
          : null;
      if (sameDecision(row, decision, payload)) return row;
      if (FINAL_STATUSES.has(row.status)) {
        throw new InterruptConflictError(`interrupt ${id} has already been decided`);
      }
      throw new InterruptConflictError(`interrupt ${id} has already been decided`);
    }

    let payload = null;
    if (decision === "edit") {
      if (editedArguments === undefined) throw new InterruptValidationError("edit decision requires editedArguments");
      const validated = await revalidate({
        phase: "decide",
        decision,
        toolName: row.tool_name,
        canonicalArguments: editedArguments,
        original: row,
      });
      payload = { editedArguments: validated };
    } else if (decision === "approve") {
      await revalidate({
        phase: "decide",
        decision,
        toolName: row.tool_name,
        canonicalArguments: row.canonical_arguments,
        protectedPayloadRef: row.protected_payload_ref,
        original: row,
      });
    } else if (decision === "respond") {
      payload = { response: response ?? "" };
    }

    const updated = await store.decideAgentInterrupt(id, {
      decision,
      status: decisionStatus(decision),
      decisionPayload: payload,
      now: currentNow,
    });
    if (updated) return updated;
    const after = await store.getAgentInterrupt(id);
    if (sameDecision(after, decision, payload)) return after;
    throw new InterruptConflictError(`interrupt ${id} could not be decided`);
  }

  async function claim(id) {
    const row = await store.getAgentInterrupt(id);
    if (!row) return null;
    const currentNow = nowIso(now);
    if (isExpired(row, currentNow)) {
      if (row.status === "pending") await store.updateAgentInterruptStatus(id, "expired");
      return store.getAgentInterrupt(id);
    }
    if (!EXECUTABLE_STATUSES.has(row.status)) {
      if (row.status === "claimed") return row;
      throw new InterruptConflictError(`interrupt ${id} is not executable in status "${row.status}"`);
    }
    const args = executionArguments(row);
    const validated = await revalidate({
      phase: "claim",
      decision: row.decision,
      toolName: row.tool_name,
      canonicalArguments: args,
      protectedPayloadRef: row.protected_payload_ref,
      original: row,
    });
    const digest = interruptDigest({
      toolName: row.tool_name,
      canonicalArguments: row.status === "edited" ? validated : row.canonical_arguments,
      protectedPayloadRef: row.protected_payload_ref,
    });
    if (row.status === "approved" && digest !== row.digest) {
      throw new InterruptValidationError(`interrupt ${id} payload digest changed before execution`);
    }
    const claimed = await store.claimAgentInterrupt(id, { claimId: claimIdFactory(), now: currentNow });
    if (!claimed) throw new InterruptConflictError(`interrupt ${id} was already claimed or changed`);
    return { ...claimed, execution_arguments: validated };
  }

  async function complete(id, { status = "executed" } = {}) {
    if (status !== "executed" && status !== "failed") {
      throw new InterruptValidationError(`unsupported completion status "${status}"`);
    }
    return store.completeAgentInterrupt(id, { status, now: nowIso(now) });
  }

  async function claimAndExecute(id) {
    if (typeof executeTool !== "function") throw new TypeError("Interrupt service requires executeTool for claimAndExecute()");
    const claimed = await claim(id);
    if (!claimed) return null;
    try {
      const result = await executeTool(claimed.tool_name, claimed.execution_arguments, claimed);
      await complete(id, { status: "executed" });
      return { interrupt: await store.getAgentInterrupt(id), result };
    } catch (err) {
      await complete(id, { status: "failed" });
      throw err;
    }
  }

  return Object.freeze({
    create,
    list,
    expire,
    decide,
    claim,
    complete,
    claimAndExecute,
  });
}
