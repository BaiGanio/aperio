// lib/routes/api-codegraph.js
// Code graph endpoints — status, index, repos, search, outline, context, callers, callees.
import express from "express";
import { logError } from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { makeRateLimiter } from "../helpers/rateLimit.js";
import { getAllowlist, setAllowlist, isReadPathAllowed } from "./paths.js";
import {
  searchHandler     as cgSearch,
  outlineHandler    as cgOutline,
  contextHandler    as cgContext,
  callersHandler    as cgCallers,
  calleesHandler    as cgCallees,
  reposHandler      as cgRepos,
  deleteRepoHandler as cgDeleteRepo,
} from "../handlers/codegraph/codegraphHandlers.js";

export function mountCodegraphRoutes(router, { store }) {

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

      const existingRepos = unwrap(await cgRepos(cgCtx));
      const covered = (existingRepos.repos || []).find(r => abs === r.root_path || abs.startsWith(r.root_path + "/"));
      if (covered) {
        return res.status(400).json({
          error: `Already covered by the indexed repo at ${covered.root_path}`,
          coveredBy: covered.root_path,
        });
      }

      const current = getAllowlist();
      if (!current.some(p => abs === p || abs.startsWith(p + "/"))) {
        await setAllowlist([...current, abs]);
      }

      const { indexRepo, sweepMissing } = await import("../codegraph/indexer.js");
      const { addRoot, markRootStarted, markRootDone, markRootError, markAllDone } =
        await import("../codegraph/status.js");
      addRoot(abs);

      (async () => {
        markRootStarted(abs);
        try {
          const counts = await indexRepo(store, abs);
          await sweepMissing(store, abs);
          markRootDone(abs, counts);
        } catch (err) {
          logError(`[codegraph] user-triggered index failed`, err, { abs });
          markRootError(abs, err);
        } finally {
          markAllDone();
        }
      })();

      res.status(202).json({ ok: true, path: abs });
    } catch (err) {
      logError(`POST /api/codegraph/index failed`, err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/codegraph/repos",   cgRoute(async ()  => unwrap(await cgRepos(cgCtx))));
  router.delete("/codegraph/repos", express.json(), cgRoute(async (req) => {
    const rootPath = (req.body?.path ?? "").toString().trim();
    if (!rootPath) { const e = new Error("path is required"); e.userFacing = true; throw e; }
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
