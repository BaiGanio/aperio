// lib/routes/api-codegraph.js
// Code graph endpoints — status, index, repos, search, outline, context, callers, callees.
import express from "express";
import { logError } from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { makeRateLimiter } from "../helpers/rateLimit.js";
import { FolderIndexingError, createFolderIndexingService } from "../services/folder-indexing.js";
import {
  searchHandler     as cgSearch,
  outlineHandler    as cgOutline,
  contextHandler    as cgContext,
  callersHandler    as cgCallers,
  calleesHandler    as cgCallees,
  reposHandler      as cgRepos,
  deleteRepoHandler as cgDeleteRepo,
} from "../handlers/codegraph/codegraphHandlers.js";

export function mountCodegraphRoutes(router, { store, watcherEvents, watcherRegistry, folderIndexer } = {}) {
  // Null-safe stub when no registry is wired (e.g. unit tests that mount routes
  // without the server's watcher plumbing).
  const registry = watcherRegistry ?? { register: async () => {}, stop: async () => false };
  const indexing = folderIndexer ?? createFolderIndexingService({ store, watcherEvents, watcherRegistry: registry });

  const cgCtx = {
    store,
    vectorEnabled: () => !!(store?.pool || store?.db),
    generateEmbedding,
  };

  function unwrap(result) {
    if (result?.isError) {
      const err = new Error(result.content?.[0]?.text || "codegraph error");
      err.userFacing = true;
      throw err;
    }
    return JSON.parse(result.content[0].text);
  }

  function cgRoute(fn) {
    return async (req, res) => {
      if (!store?.pool && !store?.db) return res.json({ enabled: false });
      try { res.json({ enabled: true, ...await fn(req) }); }
      catch (err) {
        if (err.userFacing) return res.status(400).json({ error: err.message });
        logError(`GET ${req.path} failed`, err, { query: req.query });
        res.status(500).json({ error: err.message });
      }
    };
  }

  router.get("/codegraph/status", async (_req, res) => {
    try {
      const { getCodegraphStatus } = await import("../codegraph/status.js");
      res.json(getCodegraphStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NET-03: indexing is heavy (parse + embed an entire repo) — throttle it.
  const indexLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: "codegraph-index" });
  router.post("/codegraph/index", indexLimiter, express.json(), async (req, res) => {
    if (!store?.pool && !store?.db) {
      return res.status(400).json({ error: "Code graph requires the SQLite or Postgres backend." });
    }
    try {
      res.status(202).json(await indexing.start({ path: req.body?.path, target: "code" }));
    } catch (err) {
      if (err instanceof FolderIndexingError) {
        return res.status(err.status).json({ error: err.message, ...(err.path ? { path: err.path } : {}) });
      }
      logError(`POST /api/codegraph/index failed`, err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/codegraph/repos",   cgRoute(async ()  => unwrap(await cgRepos(cgCtx))));
  router.delete("/codegraph/repos", express.json(), cgRoute(async (req) => {
    const rootPath = (req.body?.path ?? "").toString().trim();
    if (!rootPath) { const e = new Error("path is required"); e.userFacing = true; throw e; }
    await registry.stop('codegraph', rootPath); // stop the live watcher before dropping its rows
    const result = unwrap(await cgDeleteRepo(cgCtx, { path: rootPath }));
    const updated = getAllowlist().filter(p => p !== rootPath);
    await setAllowlist(updated);
    return result;
  }));
  router.get("/codegraph/search",  cgRoute(async (r) => unwrap(await cgSearch(cgCtx, {
    query: r.query.q, kind: r.query.kind, repo: r.query.repo,
    limit: r.query.limit ? parseInt(r.query.limit, 10) : undefined,
  }))));
  router.get("/codegraph/outline", cgRoute(async (r) => unwrap(await cgOutline(cgCtx, { path: r.query.path }))));
  router.get("/codegraph/context", cgRoute(async (r) => unwrap(await cgContext(cgCtx, {
    qualified: r.query.qualified,
    padding: r.query.padding ? parseInt(r.query.padding, 10) : undefined,
  }))));
  router.get("/codegraph/callers", cgRoute(async (r) => unwrap(await cgCallers(cgCtx, {
    qualified: r.query.qualified,
    depth: r.query.depth ? parseInt(r.query.depth, 10) : undefined,
  }))));
  router.get("/codegraph/callees", cgRoute(async (r) => unwrap(await cgCallees(cgCtx, {
    qualified: r.query.qualified,
    depth: r.query.depth ? parseInt(r.query.depth, 10) : undefined,
  }))));
}
