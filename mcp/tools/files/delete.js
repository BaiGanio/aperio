// mcp/tools/files/delete.js — delete_file, two-phase commit (always requires
// confirmation; there is no confirm-bypass path for deletes).

import { existsSync } from "fs";
import { isWritePathAllowed } from "../../../lib/routes/paths.js";
import { formatPathError } from "./helpers.js";
import {
  fileInterruptService, commitFileInterrupt, currentTargetDigest,
  fileToken, FILE_INTERRUPT_SESSION_ID,
} from "./interrupt.js";

const DELETE_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

export async function deleteFileHandler(args, ctx = {}) {
  // Normalize token aliases — models frequently use "token", "confirm", etc.
  const confirmation_token =
    args.confirmation_token ?? args.token ?? args.confirm ??
    args.auth_token ?? args.confirmationToken ?? null;

  // Phase 2: commit. The token maps to the path stashed at propose time, so the
  // confirmation needs only the token — the web button click executes this
  // directly on the server, and a terminal user can reply with the token.
  if (confirmation_token) {
    return commitFileInterrupt(ctx, confirmation_token, "❌ Confirmation token invalid or expired. Deletion aborted.");
  }

  // Phase 1: propose.
  const filePath = args.path;
  if (!isWritePathAllowed(filePath))
    return formatPathError("Write", filePath);
  if (!existsSync(filePath))
    return { content: [{ type: "text", text: `❌ File not found: ${filePath}` }] };

  // If a live token was already issued for this path, re-surface it so the
  // user doesn't have to re-confirm with yet another token.
  const service = fileInterruptService(ctx);
  const pending = await service.list({
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? FILE_INTERRUPT_SESSION_ID,
  });
  const existing = pending.find(row =>
    row.tool_name === "delete_file" && row.canonical_arguments?.path === filePath
  );
  if (existing) {
    const expiresAt = existing.expires_at ? new Date(existing.expires_at).getTime() : Date.now() + DELETE_TOKEN_TTL_MS;
      return {
        content: [{
        type: "text",
        text: `⚠️ Deletion pending confirmation\nTarget: ${filePath}\nToken: ${existing.id}\n\nA token was already issued. Confirm with token "${existing.id}". It expires in ${Math.ceil((expiresAt - Date.now()) / 1000)}s.`,
        }],
      };
  }

  const token = fileToken("del");
  await service.create({
    id: token,
    sessionId: ctx?.sessionId ?? process.env.APERIO_SESSION_ID ?? FILE_INTERRUPT_SESSION_ID,
    runId: ctx?.runId ?? process.env.APERIO_RUN_ID ?? null,
    toolName: "delete_file",
    canonicalArguments: {
      path: filePath,
      targetDigest: await currentTargetDigest(filePath),
    },
    allowedDecisions: ["approve", "reject", "respond"],
    expiresAt: new Date(Date.now() + DELETE_TOKEN_TTL_MS).toISOString(),
  });

  return {
    content: [{
      type: "text",
      text: `⚠️ Deletion pending confirmation\nTarget: ${filePath}\nToken: ${token}\n\nTo complete this deletion, confirm with token "${token}". This token expires in 2 minutes.`,
    }],
  };
}
