import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneExpiredRunWorkspaces } from "../../../lib/helpers/artifactWorkspace.js";

const created = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("standalone MCP artifact workspace cleanup", () => {
  test("removes expired mcp-* workspaces but preserves sessions and current runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "aperio-artifacts-"));
    created.push(root);
    const oldRun = join(root, "mcp-old");
    const currentRun = join(root, "mcp-current");
    const session = join(root, "session-123");
    await Promise.all([oldRun, currentRun, session].map(path => mkdir(path)));
    await writeFile(join(oldRun, "report.xlsx"), "old");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(oldRun, old, old);

    const previous = process.env.SESSION_RETENTION_DAYS;
    process.env.SESSION_RETENTION_DAYS = "1";
    try { await pruneExpiredRunWorkspaces(root); }
    finally {
      if (previous === undefined) delete process.env.SESSION_RETENTION_DAYS;
      else process.env.SESSION_RETENTION_DAYS = previous;
    }

    await assert.rejects(stat(oldRun), { code: "ENOENT" });
    assert.ok((await stat(currentRun)).isDirectory());
    assert.ok((await stat(session)).isDirectory());
  });
});
