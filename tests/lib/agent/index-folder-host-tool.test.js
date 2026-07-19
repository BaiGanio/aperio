import { test } from "node:test";
import assert from "node:assert/strict";

import { createIndexFolderTool } from "../../../lib/agent/host-tools/index-folder.js";
import { createFolderIndexingService } from "../../../lib/services/folder-indexing.js";

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
