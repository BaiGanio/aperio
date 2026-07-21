import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  FolderIndexingError,
  createFolderIndexingService,
} from "../../../lib/services/folder-indexing.js";

function harness({ allowed = true, directory = true, roots = {}, startWatchers = {} } = {}) {
  const calls = [];
  const registrations = [];
  const kinds = Object.fromEntries(["code", "documents"].map((kind) => [kind, {
    panel: kind === "code" ? "Code Graph" : "Document Graph",
    registryKind: kind === "code" ? "codegraph" : "docgraph",
    async listRoots() { return roots[kind] ?? []; },
    addRoot(path) { calls.push(["addRoot", kind, path]); },
    async startWatcher(_store, path, events) {
      if (startWatchers[kind]) return startWatchers[kind](_store, path, events);
      calls.push(["startWatcher", kind, path, events]);
      return { root: path, stop: async () => {} };
    },
    markAllDone() { calls.push(["markAllDone", kind]); },
  }]));
  const watcherRegistry = {
    async register(kind, path, handle) { registrations.push({ kind, path, handle }); },
  };
  const service = createFolderIndexingService({
    store: { db: {} },
    watcherEvents: { name: "events" },
    watcherRegistry,
    deps: {
      resolveDirectory: (path) => ({ abs: path, exists: true, isDirectory: directory }),
      isReadPathAllowed: () => allowed,
      kinds,
      logError: () => {},
    },
  });
  return { service, calls, registrations };
}

describe("folder indexing service", () => {
  test("queues code indexing and registers its live watcher", async () => {
    const { service, calls, registrations } = harness();

    const result = await service.start({ path: "/work/repo", target: "code" });
    await result.settled;

    assert.equal(result.path, "/work/repo");
    assert.deepEqual(result.targets, [{ target: "code", status: "started", panel: "Code Graph" }]);
    assert.deepEqual(calls.slice(0, 2), [
      ["addRoot", "code", "/work/repo"],
      ["startWatcher", "code", "/work/repo", { name: "events" }],
    ]);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].kind, "codegraph");
  });

  test("queues both indexes independently", async () => {
    const { service, calls } = harness();

    const result = await service.start({ path: "/work/mixed", target: "both" });
    await result.settled;

    assert.deepEqual(result.targets.map((entry) => entry.target), ["code", "documents"]);
    assert.equal(calls.filter(([name]) => name === "startWatcher").length, 2);
  });

  test("treats an already covered folder as an idempotent success", async () => {
    const { service, calls } = harness({ roots: { code: ["/work"] } });

    const result = await service.start({ path: "/work/repo", target: "code" });

    assert.deepEqual(result.targets, [{
      target: "code",
      status: "already_indexed",
      panel: "Code Graph",
      coveredBy: "/work",
    }]);
    assert.equal(calls.length, 0);
  });

  test("does not queue the same root twice while its first index is running", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const { service } = harness({
      startWatchers: {
        code: async () => {
          calls.push(["startWatcher", "code", "/work/repo"]);
          await pending;
          return { root: "/work/repo", stop: async () => {} };
        },
      },
    });

    const first = await service.start({ path: "/work/repo", target: "code" });
    const second = await service.start({ path: "/work/repo", target: "code" });
    assert.equal(second.targets[0].status, "in_progress");

    release();
    await first.settled;
    assert.equal(calls.filter(([name]) => name === "startWatcher").length, 1);
  });

  test("rejects paths outside Allowed Paths without expanding access", async () => {
    const { service } = harness({ allowed: false });

    await assert.rejects(
      service.start({ path: "/private/repo", target: "code" }),
      (err) => err instanceof FolderIndexingError && err.status === 403 && err.code === "PATH_NOT_ALLOWED",
    );
  });

  test("rejects missing directories and invalid targets", async () => {
    const { service } = harness({ directory: false });
    await assert.rejects(service.start({ path: "/missing", target: "documents" }), /Not a directory/);
    await assert.rejects(service.start({ path: "/work", target: "auto" }), /target must be/);
  });
});
