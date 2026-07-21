// mcp/tools/files/interrupt.js — write/edit/append/delete confirm-before-write
// (WRITE-01). Mirrors delete_file's two-phase commit, but only for the
// untrusted-content case. write_file / edit_file / append_file run directly for
// any target already inside APERIO_ALLOWED_PATHS_TO_WRITE (isWritePathAllowed()
// is a hard gate the caller has already checked by the time needsWriteConfirm()
// runs — a write outside the allowlist is rejected outright, never offered a
// confirm flow). The one case that still stashes the write under a token for the
// user to confirm is a turn that already read untrusted content (__tainted, set
// by the agent's tool-hook per INJECT-01) — e.g. a web page, GitHub issue, or
// file that could have tried to steer the edit. Without this, a model editing
// 100 allowed fields in a clean turn would otherwise deadlock behind 100 clicks
// (#299 follow-up).

import { createHash } from "crypto";
import { existsSync } from "fs";
import fs from "fs/promises";
import { basename } from "path";
import { isWritePathAllowed } from "../../../lib/routes/paths.js";
import { createInterruptService } from "../../../lib/security/interruptService.js";
import { ALLOWED_EXTENSIONS, isSecretFile, textOut } from "./helpers.js";
import { performWrite, performAppend, performEdit, performDelete } from "./perform.js";

const WRITE_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const FILE_INTERRUPT_SESSION_ID = "mcp-file-actions";
const fallbackInterruptStore = makeMemoryInterruptStore();

function nowIso() { return new Date().toISOString(); }
function expiresAtFromNow() { return new Date(Date.now() + WRITE_TOKEN_TTL_MS).toISOString(); }
export function fileToken(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 8)}`; }

export function readConfirmToken(args) {
  return args.confirmation_token ?? args.token ?? args.confirm ?? args.confirmationToken ?? null;
}

// A write needs confirmation only when the turn is tainted by untrusted
// content. The target path itself is already vetted by isWritePathAllowed()
// before this is called, so no separate scratch-vs-real-location distinction
// is needed here.
export function needsWriteConfirm(args) {
  // Benchmark runs are headless — no user exists to answer, so a stashed write
  // deadlocks the turn and invalidates the observation (#282). The bench
  // sandbox is already isolated by an allowlist scoped to its temp workspace,
  // so skipping the gate does not widen what the model can touch.
  if (process.env.APERIO_BENCHMARK_RUN === "1") return false;
  return args.__tainted === true;
}

export function taintNote(args) {
  return args.__tainted === true
    ? ["", "⚠️ This turn read untrusted external content (web page / GitHub issue / file) before this write — confirm it is intended."]
    : [];
}

function digestText(text) {
  return "sha256:" + createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

async function targetDigest(path) {
  try {
    const text = await fs.readFile(path, "utf8");
    return digestText(text);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
    throw err;
  }
}

export async function currentTargetDigest(path) {
  return existsSync(path) ? targetDigest(path) : null;
}

function makeMemoryInterruptStore() {
  const rows = new Map();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = id => clone(rows.get(id) ?? null);
  return {
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
        status: "pending",
        created_at: nowIso(),
        updated_at: nowIso(),
        decided_at: null,
        claimed_at: null,
        completed_at: null,
        expires_at: input.expiresAt ?? null,
      };
      rows.set(row.id, row);
      return get(row.id);
    },
    async getAgentInterrupt(id) { return get(id); },
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
      row.updated_at = nowIso();
      return get(id);
    },
    async expireAgentInterrupts(now = nowIso()) {
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
    async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = nowIso() }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending" || (row.expires_at && row.expires_at <= now)) return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return get(id);
    },
    async claimAgentInterrupt(id, { claimId, now = nowIso() }) {
      const row = rows.get(id);
      if (!row || !["approved", "edited"].includes(row.status) || (row.expires_at && row.expires_at <= now)) return null;
      row.status = "claimed";
      row.claim_id = claimId;
      row.claimed_at = now;
      row.updated_at = now;
      return get(id);
    },
    async completeAgentInterrupt(id, { status = "executed", now = nowIso() } = {}) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed") return null;
      row.status = status;
      row.completed_at = now;
      row.updated_at = now;
      return get(id);
    },
  };
}

function interruptStore(ctx) {
  const store = ctx?.store;
  return store?.createAgentInterrupt && store?.decideAgentInterrupt && store?.claimAgentInterrupt
    ? store
    : fallbackInterruptStore;
}

async function revalidateFileInterrupt({ canonicalArguments }) {
  const args = canonicalArguments ?? {};
  if (!isWritePathAllowed(args.path)) throw new Error(`Write not allowed: ${args.path}`);
  if (args.path && isSecretFile(args.path)) throw new Error(`Secret/credential files cannot be modified: ${basename(args.path)}`);
  if (args.ext && !ALLOWED_EXTENSIONS.has(args.ext)) throw new Error(`File type not allowed: ${args.ext}`);
  // edit_file has no targetDigest — it revalidates by reapplying old_string/new_string
  // against the file's live content at execution time (see performEdit), so two
  // sequential edits proposed in the same turn can chain instead of clobbering
  // each other (#299). write_file/append_file/delete_file still snapshot a
  // whole-file digest at propose time, since a full overwrite/delete has no
  // narrower target to revalidate against.
  if (args.targetDigest !== undefined) {
    const current = await currentTargetDigest(args.path);
    if (current !== args.targetDigest) {
      throw new Error(`Target changed since confirmation was requested: ${args.path}`);
    }
  }
  return args;
}

export function fileInterruptService(ctx) {
  return createInterruptService({
    store: interruptStore(ctx),
    revalidate: revalidateFileInterrupt,
    executeTool: executeFileInterrupt,
  });
}

async function executeFileInterrupt(toolName, args) {
  switch (toolName) {
    case "write_file": return performWrite(args);
    case "append_file": return performAppend(args);
    case "edit_file": return performEdit(args);
    case "delete_file": return performDelete(args);
    default: throw new Error(`Unsupported file interrupt tool: ${toolName}`);
  }
}

export async function commitFileInterrupt(ctx, token, invalidText) {
  const service = fileInterruptService(ctx);
  try {
    const row = await service.decide(token, { decision: "approve" });
    if (!row || row.status === "expired") return textOut(invalidText);
    const { result } = await service.claimAndExecute(token);
    return result;
  } catch (err) {
    return textOut(`${invalidText} ${err.message}`);
  }
}

export async function decideFileInterrupt(ctx, token, decisionInput = {}) {
  const service = fileInterruptService(ctx);
  const decision = decisionInput.decision;
  if (decision === "approve" || decision === "edit") {
    const row = await service.decide(token, {
      decision,
      editedArguments: decisionInput.editedArguments,
    });
    if (!row || row.status === "expired") return { row, result: textOut("❌ Confirmation token invalid or expired. Nothing was written.") };
    const executed = await service.claimAndExecute(token);
    return { row: executed.interrupt, result: executed.result };
  }
  const row = await service.decide(token, {
    decision,
    response: decisionInput.response,
  });
  return { row, result: null };
}

// Phase 1: persist the write and return a preview whose `Token:` line the agent
// turns into a confirm button (and strips from the model's view).
export async function proposeWrite(ctx, { kind, label, summaryLines, canonicalArguments }) {
  const token = fileToken("wr");
  await fileInterruptService(ctx).create({
    id: token,
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? FILE_INTERRUPT_SESSION_ID,
    runId: ctx?.runId ?? process.env.APERIO_RUN_ID ?? null,
    toolName: kind,
    canonicalArguments,
    allowedDecisions: ["approve", "edit", "reject", "respond"],
    expiresAt: expiresAtFromNow(),
  });
  return { content: [{ type: "text", text: [
    `⚠️ ${kind} pending your confirmation — nothing has been written yet.`,
    "",
    ...summaryLines,
    "",
    `Action: ${label}`,
    `Token: ${token}`,
  ].join("\n") }] };
}
