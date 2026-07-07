import { createInterruptService, InterruptConflictError, InterruptValidationError } from "../security/interruptService.js";
import { decideFileInterrupt } from "../../mcp/tools/files.js";
import { decideDatabaseInterrupt } from "../handlers/database/databaseHandlers.js";
import { logError } from "../helpers/logger.js";

const CONFIRMABLE_TOOLS = new Set(["delete_file", "write_file", "edit_file", "append_file", "db_execute"]);

function textFromToolResult(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.find(b => b?.type === "text")?.text ?? "Done.";
  return result.content?.find?.(b => b?.type === "text")?.text ?? "Done.";
}

export function serializeInterrupt(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    runId: row.run_id ?? null,
    tool: row.tool_name,
    status: row.status,
    decision: row.decision ?? null,
    allowedDecisions: row.allowed_decisions ?? [],
    arguments: row.canonical_arguments ?? null,
    decisionPayload: row.decision_payload ?? null,
    digest: row.digest,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    decidedAt: row.decided_at ?? null,
    claimedAt: row.claimed_at ?? null,
    completedAt: row.completed_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

async function decideGeneric(store, id, body = {}) {
  const service = createInterruptService({ store });
  const row = await service.decide(id, {
    decision: body.decision,
    response: body.response,
    editedArguments: body.editedArguments,
  });
  return { row, result: null };
}

export async function decideAndMaybeExecute({ store, id, body }) {
  if (!store?.getAgentInterrupt) return { status: 404, body: { error: "interrupt not found" } };
  const current = await store.getAgentInterrupt(id);
  if (!current) return { status: 404, body: { error: "interrupt not found" } };
  if (!CONFIRMABLE_TOOLS.has(current.tool_name)) {
    return { status: 400, body: { error: "interrupt tool is not exposed for API decisions" } };
  }

  const decision = body?.decision;
  if (decision === "approve" || decision === "edit") {
    const input = { decision, editedArguments: body.editedArguments };
    const handled = current.tool_name === "db_execute"
      ? await decideDatabaseInterrupt({ store }, id, input)
      : await decideFileInterrupt({ store }, id, input);
    return {
      status: 200,
      body: {
        interrupt: serializeInterrupt(handled.row),
        result: textFromToolResult(handled.result),
      },
    };
  }

  const handled = await decideGeneric(store, id, {
    decision,
    response: body?.response,
  });
  if (!handled.row) return { status: 404, body: { error: "interrupt not found" } };
  return {
    status: 200,
    body: {
      interrupt: serializeInterrupt(handled.row),
      result: null,
    },
  };
}

export function mountInterruptRoutes(router, { store }) {
  router.get("/interrupts", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "pending";
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
      const rows = await store.listAgentInterrupts({ sessionId, runId, status, limit });
      res.json({ interrupts: rows.map(serializeInterrupt) });
    } catch (err) {
      logError("interrupts/list", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/interrupts/:id/decision", async (req, res) => {
    try {
      const { status, body } = await decideAndMaybeExecute({
        store,
        id: req.params.id,
        body: req.body ?? {},
      });
      res.status(status).json(body);
    } catch (err) {
      if (err instanceof InterruptValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof InterruptConflictError) {
        return res.status(409).json({ error: err.message });
      }
      logError("interrupts/decision", err);
      res.status(500).json({ error: err.message });
    }
  });
}
