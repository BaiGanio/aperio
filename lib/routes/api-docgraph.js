// lib/routes/api-docgraph.js
// Document graph endpoints — status, index, repos, search, context.
import express from "express";
import { logError } from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { makeRateLimiter } from "../helpers/rateLimit.js";
import { getAllowlist, setAllowlist, isReadPathAllowed } from "./paths.js";
import {
  searchHandler     as dgSearch,
  contextHandler    as dgContext,
  reposHandler      as dgRepos,
  deleteRepoHandler as dgDeleteRepo,
} from "../handlers/docgraph/docgraphHandlers.js";

export function mountDocgraphRoutes(router, { store, watcherEvents, watcherRegistry } = {}) {
  // Null-safe stub when no registry is wired (e.g. unit tests that mount routes
  // without the server's watcher plumbing).
  const registry = watcherRegistry ?? { register: async () => {}, stop: async () => false };

  const cgCtx = {
    store,
    vectorEnabled: () => !!(store?.pool || store?.db),
    generateEmbedding,
  };

  function unwrap(result) {
    if (result?.isError) {
      const err = new Error(result.content?.[0]?.text || "docgraph error");
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

  router.get("/docgraph/status", async (_req, res) => {
    try {
      const { getDocgraphStatus } = await import("../docgraph/status.js");
      res.json(getDocgraphStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // NET-03: indexing parses + embeds whole documents — throttle it.
  const indexLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: "docgraph-index" });
  router.post("/docgraph/index", indexLimiter, express.json(), async (req, res) => {
    if (!store?.pool && !store?.db) {
      return res.status(400).json({ error: "The document graph requires the SQLite or Postgres backend." });
    }
    const raw = (req.body?.path ?? "").toString().trim();
    if (!raw) return res.status(400).json({ error: "path is required" });

    try {
      const { resolve } = await import("path");
      const { homedir } = await import("os");
      const { existsSync, statSync } = await import("fs");
      const abs = resolve(raw.replace(/^~/, homedir()));
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return res.status(400).json({ error: `Not a directory: ${abs}` });
      }
      if (!isReadPathAllowed(abs)) {
        return res.status(403).json({
          error: `Path is outside the read ceiling. Add it to APERIO_ALLOWED_PATHS_TO_READ in .env and restart, then try again.`,
          path: abs,
        });
      }

      const existingRepos = unwrap(await dgRepos(cgCtx));
      const covered = (existingRepos.repos || []).find(r => abs === r.root_path || abs.startsWith(r.root_path + "/"));
      if (covered) {
        return res.status(400).json({
          error: `Already covered by the indexed folder at ${covered.root_path}`,
          coveredBy: covered.root_path,
        });
      }

      const current = getAllowlist();
      if (!current.some(p => abs === p || abs.startsWith(p + "/"))) {
        await setAllowlist([...current, abs]);
      }

      const { startWatcher } = await import("../docgraph/watcher.js");
      const { addRoot, markAllDone } = await import("../docgraph/status.js");
      addRoot(abs);

      // Reuse the live watcher rather than a one-shot index: it defers embeddings
      // to its own queue and keeps watching the folder, so a folder added at
      // runtime behaves exactly like one present at boot (no restart needed).
      // startWatcher handles markRootStarted/Done/Error and sweepMissing itself.
      (async () => {
        try {
          const handle = await startWatcher(store, abs, watcherEvents);
          await registry.register('docgraph', abs, handle);
        } catch (err) {
          logError(`[docgraph] user-triggered watch failed`, err, { abs });
          // startWatcher marks the root errored before throwing.
        } finally {
          markAllDone();
        }
      })();

      res.status(202).json({ ok: true, path: abs });
    } catch (err) {
      logError(`POST /api/docgraph/index failed`, err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/docgraph/repos", cgRoute(async () => unwrap(await dgRepos(cgCtx))));
  router.delete("/docgraph/repos", express.json(), cgRoute(async (req) => {
    const rootPath = (req.body?.path ?? "").toString().trim();
    if (!rootPath) { const e = new Error("path is required"); e.userFacing = true; throw e; }
    await registry.stop('docgraph', rootPath); // stop the live watcher before dropping its rows
    const result = unwrap(await dgDeleteRepo(cgCtx, { path: rootPath }));
    const updated = getAllowlist().filter(p => p !== rootPath);
    await setAllowlist(updated);
    return result;
  }));
  router.get("/docgraph/search", cgRoute(async (r) => unwrap(await dgSearch(cgCtx, {
    query: r.query.q, folder: r.query.folder, mime: r.query.mime,
    limit: r.query.limit ? parseInt(r.query.limit, 10) : undefined,
  }))));
  router.get("/docgraph/context", cgRoute(async (r) => unwrap(await dgContext(cgCtx, {
    path: r.query.path,
    chunk_id:   r.query.chunk_id   != null ? parseInt(r.query.chunk_id, 10)   : undefined,
    section_id: r.query.section_id != null ? parseInt(r.query.section_id, 10) : undefined,
    folder: r.query.folder,
  }))));
}
