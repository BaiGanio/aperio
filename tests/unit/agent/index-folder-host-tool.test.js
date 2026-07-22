import { test } from "node:test";
import assert from "node:assert/strict";

import { createIndexFolderTool } from "../../../lib/agent/host-tools/index-folder.js";
import { createFolderIndexingService } from "../../../lib/services/folder-indexing.js";

test("index_folder tells the model to invoke it for paths outside Allowed Paths", () => {
  const tool = createIndexFolderTool({ start: async () => ({ targets: [] }) });

  assert.match(tool.description, /call this tool for every explicit indexing request/i);
  assert.match(tool.description, /do not tell the user to add it manually/i);
  assert.match(tool.inputSchema.properties.path.description, /may be outside Allowed Paths/i);
  assert.doesNotMatch(tool.inputSchema.properties.path.description, /inside Allowed Paths/i);
});

test("index_folder exercises the main-process queue and names the progress panel", async () => {
  const registered = [];
  const kind = {
    panel: "Code Graph",
    registryKind: "codegraph",
    async listRoots() { return []; },
    addRoot() {},
    async startWatcher(_store, path) { return { root: path, stop: async () => {} }; },
    markAllDone() {},
  };
  const service = createFolderIndexingService({
    store: { db: {} },
    watcherRegistry: {
      async register(indexKind, path) { registered.push({ indexKind, path }); },
    },
    deps: {
      kinds: { code: kind, documents: { ...kind, panel: "Document Graph", registryKind: "docgraph" } },
      logError: () => {},
    },
  });
  const tool = createIndexFolderTool(service);

  const output = await tool.handler({ path: process.cwd(), target: "code" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(output, /Indexing started/);
  assert.match(output, /Code Graph/);
  assert.deepEqual(registered, [{ indexKind: "codegraph", path: process.cwd() }]);
});

test("index_folder confirmation authorizes an outside path and immediately starts indexing", async () => {
  let allowed = false;
  const authorized = [];
  const starts = [];
  const folderIndexer = {
    async start(args) {
      starts.push(args);
      if (!allowed) {
        const error = new Error(`Path is outside Allowed Paths: ${args.path}`);
        error.code = "PATH_NOT_ALLOWED";
        error.path = args.path;
        throw error;
      }
      return {
        ok: true,
        path: args.path,
        targets: [{ target: args.target, status: "started", panel: "Code Graph" }],
      };
    },
  };
  const tool = createIndexFolderTool(folderIndexer, {
    createToken: () => "idx_confirm123",
    authorizePath: async (path) => { authorized.push(path); allowed = true; },
    runWithUpdatedPaths: (fn) => fn(),
  });

  const proposal = await tool.handler({ path: "/Users/me/outside-repo", target: "code" });
  assert.match(proposal, /Authorize and index/);
  assert.match(proposal, /Token: idx_confirm123/);
  assert.deepEqual(authorized, [], "the first call must not silently widen Allowed Paths");

  const result = await tool.handler({ confirmation_token: "idx_confirm123" });
  assert.deepEqual(authorized, ["/Users/me/outside-repo"]);
  assert.match(result, /Authorized.*outside-repo/);
  assert.match(result, /Indexing started/);
  assert.equal(starts.length, 2);

  const replay = await tool.handler({ confirmation_token: "idx_confirm123" });
  assert.match(replay, /expired|invalid/i, "confirmation tokens are single-use");
});

// ── Pending-authorization lifecycle ──────────────────────────────────────────
// A proposal the user never confirms must not keep a validated host path in
// memory for the process lifetime.

function outsidePathIndexer() {
  return {
    async start(args) {
      const error = new Error(`Path is outside Allowed Paths: ${args.path}`);
      error.code = "PATH_NOT_ALLOWED";
      error.path = args.path;
      throw error;
    },
  };
}

test("abandoned folder authorizations expire without being submitted", async () => {
  let clock = 0;
  let issued = 0;
  const authorized = [];
  const tool = createIndexFolderTool(outsidePathIndexer(), {
    createToken: () => `idx_${issued++}`,
    authorizePath: async (path) => { authorized.push(path); },
    runWithUpdatedPaths: (fn) => fn(),
    now: () => clock,
    authorizationTtlMs: 1000,
  });

  await tool.handler({ path: "/Users/me/abandoned", target: "code" });

  clock = 1001;                     // the window closes with nothing submitted
  // A later proposal prunes the abandoned entry; the stale token is then unusable.
  await tool.handler({ path: "/Users/me/other", target: "code" });
  const replay = await tool.handler({ confirmation_token: "idx_0" });

  assert.match(replay, /invalid or expired/i);
  assert.deepEqual(authorized, [], "an expired proposal never widens Allowed Paths");
});

test("a flood of unanswered proposals stays bounded", async () => {
  let issued = 0;
  const tool = createIndexFolderTool(outsidePathIndexer(), {
    createToken: () => `idx_${issued++}`,
    authorizePath: async () => {},
    runWithUpdatedPaths: (fn) => fn(),
    maxPendingAuthorizations: 3,
  });

  for (let i = 0; i < 10; i++) {
    await tool.handler({ path: `/Users/me/folder-${i}`, target: "code" });
  }

  // The oldest proposals were shed; only the most recent ones still confirm.
  const stale = await tool.handler({ confirmation_token: "idx_0" });
  assert.match(stale, /invalid or expired/i);
  const recent = await tool.handler({ confirmation_token: "idx_9" });
  assert.doesNotMatch(recent, /invalid or expired/i);
});
