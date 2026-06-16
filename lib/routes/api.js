import { readdirSync, statSync, existsSync } from "fs";
import { join, relative, basename } from "path";
import express, { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import logger, { logError } from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { listSessions, getSession, deleteSession, pinSession } from "../helpers/sessions.js";
import { getAllowlist, getUserPaths, setAllowlist } from "./paths.js";
import { loadJobs } from "../workers/agent-scheduler.js";
import { searchArticles, listArticles, getArticle } from "../handlers/wiki/wikiQueries.js";
import {
  searchHandler     as cgSearch,
  outlineHandler    as cgOutline,
  contextHandler    as cgContext,
  callersHandler    as cgCallers,
  calleesHandler    as cgCallees,
  reposHandler      as cgRepos,
  deleteRepoHandler as cgDeleteRepo,
} from "../handlers/codegraph/codegraphHandlers.js";
import {
  searchHandler     as dgSearch,
  contextHandler    as dgContext,
  reposHandler      as dgRepos,
  deleteRepoHandler as dgDeleteRepo,
} from "../handlers/docgraph/docgraphHandlers.js";

const execAsync = promisify(exec);

const VALID_MEMORY_TYPES = new Set(["fact", "preference", "project", "decision", "solution", "source", "person"]);

// ── File search helper for @ autocomplete ─────────────────────────────────────
// Recursively collects files and dirs whose basename matches `q` (case-insensitive
// substring), up to `max`. Returns short relative paths from the root dir.
// Skips hidden entries (starting with `.`) and common noise dirs.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "target", "vendor", ".DS_Store"]);
function _collectFiles(dir, q, out, max, rootDir, depth = 0) {
  if (out.length >= max || depth > 6) return;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (out.length >= max) return;
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    const rel = relative(rootDir, full);
    if (name.toLowerCase().includes(q)) out.push({ name, path: rel, isDir });
    if (isDir) _collectFiles(full, q, out, max, rootDir, depth + 1);
  }
}

/**
 * All Express REST routes.
 * Mounted at /api in server.js:  app.use("/api", apiRouter({ agent, store, watchdog }))
 *
 * @param {object} opts
 * @param {object} opts.agent    - Agent instance from createAgent()
 * @param {object} opts.store    - DB store instance from getStore()
 * @param {object} opts.watchdog - Ollama watchdog from createOllamaWatchdog()
 */
export function apiRouter({ agent, store, watchdog, scheduler }) {
  const { provider } = agent;
  const router = Router();

  // ── Info endpoints ──────────────────────────────────────────────────────────
  router.get("/version",  (_, res) => res.json({ version: agent.version }));
  router.get("/provider", (_, res) => res.json({ provider: agent.provider.name, model: agent.provider.model }));
  router.get("/config",   (_, res) => res.json({ backend: process.env.DB_BACKEND || "sqlite" }));

  // ── Background agents ─────────────────────────────────────────────────────
  // Run-now: trigger a defined job immediately (see docs/background-agents.md).
  // Gated by APERIO_AGENT_JOBS=on — the same master switch as interval auto-run,
  // so the whole feature is one toggle for non-code users.
  router.post("/agents/:id/run", async (req, res) => {
    if (process.env.APERIO_AGENT_JOBS !== "on") {
      return res.status(403).json({ error: "background agents disabled — set APERIO_AGENT_JOBS=on" });
    }
    if (!scheduler?.runJob) {
      return res.status(503).json({ error: "scheduler unavailable" });
    }
    const job = loadJobs().find(j => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: `no job with id "${req.params.id}"` });
    try {
      const result = await scheduler.runJob(job, { kind: "manual" });
      if (!result) return res.status(409).json({ error: "job skipped (already running or invalid)" });
      const status = result.verdict === "ok" ? 200 : 500;
      res.status(status).json(result);
    } catch (err) {
      logError("agents/run", err);
      res.status(500).json({ error: err.message });
    }
  });

  // On-demand SKILL.md body — the skills chip fetches this only when a row is
  // expanded, so full skill content isn't streamed over the WS every turn.
  router.get("/skill", (req, res) => {
    const doc = agent.getSkillDoc(String(req.query.name || ""));
    if (!doc) return res.status(404).json({ error: "skill not found" });
    res.json(doc);
  });

  // List all skill names + descriptions (for /skill autocomplete in the chat input).
  router.get("/skills", (_, res) => {
    try {
      const list = agent.getSkillList();
      res.json({ skills: list });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search files/folders in allowed paths (for @ autocomplete in the chat input).
  // Accepts ?q=<query> and returns matching relative paths.
  router.get("/files", (req, res) => {
    const q = (req.query.q || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json({ files: [] });
    try {
      const allowed = getUserPaths();
      const results = [];
      const MAX_RESULTS = 20;
      for (const dir of allowed) {
        if (results.length >= MAX_RESULTS) break;
        _collectFiles(dir, q, results, MAX_RESULTS, dir);
      }
      res.json({ files: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/models", async (_, res) => {
    const providers = {};
    const ollamaBase = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    try {
      const r = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const data = await r.json();
        providers.ollama = (data.models || []).map(m => m.name);
      }
    } catch { /* ollama not running */ }
    if (process.env.ANTHROPIC_API_KEY) {
      providers.anthropic = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    }
    if (process.env.DEEPSEEK_API_KEY) {
      providers.deepseek = ["deepseek-v4-flash", "deepseek-v4-pro"];
    }
    // Gemini hidden from the model picker — uncomment to expose it in the UI.
    // if (process.env.GEMINI_API_KEY) {
    //   providers.gemini = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"];
    // }
    res.json({ provider: agent.provider.name, model: agent.provider.model, providers });
  });

  router.put("/provider", express.json({ limit: "4kb" }), (req, res) => {
    const { provider: providerName, model } = req.body || {};
    if (!providerName || !model) return res.status(400).json({ error: "provider and model are required" });
    try {
      agent.setProvider({ name: providerName, model });
      res.json({ ok: true, provider: providerName, model });
    } catch (err) {
      logger.error("PUT /api/provider error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  let _cachedMetrics = { rss: 0, heap: 0, cpu: 0, embedding_queue_size: 0 };
  let _prevCpu = process.cpuUsage();
  let _prevCpuTime = Date.now();
  setInterval(async () => {
    const mem = process.memoryUsage();
    const now = Date.now();
    const cur = process.cpuUsage(_prevCpu);
    const elapsed = (now - _prevCpuTime) * 1000;
    let embedding_queue_size = 0;
    try {
      const { total, embedded } = await store.counts();
      embedding_queue_size = total - embedded;
    } catch {}
    _cachedMetrics = {
      rss:  Math.round(mem.rss / 1024 / 1024),
      heap: Math.round(mem.heapUsed / 1024 / 1024),
      cpu:  elapsed > 0 ? Math.round((cur.user + cur.system) / elapsed * 100) : 0,
      embedding_queue_size,
    };
    _prevCpu = process.cpuUsage();
    _prevCpuTime = now;
  }, 2000).unref();
  router.get("/metrics", (_, res) => res.json(_cachedMetrics));

  // ── Allowed folders — app-wide, DB-persisted allowlist (read == write) ─────
  router.get("/paths", (_, res) => {
    res.json({ paths: getUserPaths() });
  });

  // Replace the allowed-folders list. Normally driven via the WebSocket set_paths
  // message; this is a non-WS fallback. Persists to the DB via setAllowlist.
  router.post("/paths", express.json({ limit: "16kb" }), async (req, res) => {
    const { paths } = req.body ?? {};
    if (!Array.isArray(paths))
      return res.status(400).json({ error: "paths must be an array" });
    const valid = p => typeof p === "string" && p.trim().length > 0;
    if (!paths.every(valid))
      return res.status(400).json({ error: "All paths must be non-empty strings" });
    const saved = await setAllowlist(paths);
    logger.info(`[paths] updated — ${saved.join(", ")}`);
    res.json({ ok: true, paths: saved });
  });

  // Native folder picker — macOS (osascript), Linux (zenity/kdialog), Windows (PowerShell).
  router.get("/pick-folder", async (_, res) => {
    const platform = process.platform;
    const pick = async () => {
      if (platform === "darwin") {
        const { stdout } = await execAsync(
          `osascript -e 'POSIX path of (choose folder with prompt "Select a folder for Aperio")'`,
          { timeout: 60_000 }
        );
        return stdout.trim().replace(/\/$/, "");
      }
      if (platform === "linux") {
        // Try zenity first, then kdialog.
        for (const cmd of [
          `zenity --file-selection --directory --title="Select a folder for Aperio"`,
          `kdialog --getexistingdirectory "$HOME" --title "Select a folder for Aperio"`,
        ]) {
          try {
            const { stdout } = await execAsync(cmd, { timeout: 60_000 });
            return stdout.trim();
          } catch (err) {
            if (err.code === 1) throw Object.assign(new Error("cancelled"), { cancelled: true });
            // Tool not found — try next
            if (err.code === 127 || /not found|command/i.test(err.message)) continue;
            throw err;
          }
        }
        throw new Error("No folder picker available (install zenity or kdialog)");
      }
      if (platform === "win32") {
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
          "$d.Description = 'Select a folder for Aperio';",
          "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
        ].join(" ");
        const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { timeout: 60_000 });
        return stdout.trim();
      }
      throw new Error(`Unsupported platform: ${platform}`);
    };

    try {
      const path = await pick();
      if (!path) return res.json({ path: null, cancelled: true });
      res.json({ path });
    } catch (err) {
      if (err.cancelled) return res.json({ path: null, cancelled: true });
      res.status(500).json({ error: err.message });
    }
  });

  // Heartbeat — used by the frontend keepalive script.
  // Every ping resets the Ollama inactivity watchdog so Ollama is only
  // stopped when no browser tab has been active for 30 seconds.
  router.get("/heartbeat", (_, res) => {
    watchdog.heartbeat();
    logger.debug("✅ Heartbeat — used by the frontend keepalive script.");
    res.json({ ok: true, ts: Date.now() });
  });
  router.get("/config/client", (_, res) => res.json({
    heartbeatIntervalSeconds: Number(process.env.HEARTBEAT_INTERVAL_SECONDS) || 10,
  }));

  // ── Memories ────────────────────────────────────────────────────────────────
  router.get("/memories", async (req, res) => {
    try {
      const rows = await store.listAll();
      res.json({ raw: rows });
    } catch (err) {
      logger.error("GET /api/memories error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  router.post("/memories/import", express.json({ limit: "512kb" }), async (req, res) => {
    try {
      const { memories } = req.body ?? {};
      if (!Array.isArray(memories) || memories.length === 0) {
        return res.status(400).json({ error: "memories array is required" });
      }
      if (memories.length > 500) {
        return res.status(413).json({ error: "Too many memories — max 500 per import" });
      }

      // Validate first — collect clean inputs and skip bad entries
      const valid  = [];
      const errors = [];

      for (const [i, m] of memories.entries()) {
        const title   = typeof m.title   === "string" ? m.title.trim()   : "";
        const content = typeof m.content === "string" ? m.content.trim() : "";
        if (!title || !content) {
          errors.push({ index: i, reason: "missing title or content" });
          continue;
        }
        if (title.length > 200) {
          errors.push({ index: i, reason: "title exceeds 200 characters" });
          continue;
        }
        if (content.length > 10_000) {
          errors.push({ index: i, reason: "content exceeds 10 000 characters" });
          continue;
        }
        valid.push({
          type:       typeof m.type === "string" && VALID_MEMORY_TYPES.has(m.type) ? m.type : "fact",
          title,
          content,
          tags:       Array.isArray(m.tags) ? m.tags.map(String) : [],
          importance: Number.isFinite(m.importance) ? Math.min(Math.max(Math.floor(m.importance), 1), 5) : 3,
          source:     "import",
        });
      }

      // Single bulk DB write — no embeddings yet (avoids per-row latency for large imports)
      await store.bulkInsert(valid);

      // Generate embeddings asynchronously so the HTTP response returns immediately.
      // Uses the existing setEmbedding + listWithoutEmbeddings machinery.
      setImmediate(async () => {
        try {
          const pending = await store.listWithoutEmbeddings();
          for (const row of pending) {
            const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
            if (embedding) await store.setEmbedding(row.id, embedding);
          }
          logger.info(`[import] backfill complete: ${pending.length} embeddings generated`);
        } catch (err) {
          logger.error("[import] backfill error:", err.message);
        }
      });

      res.json({
        imported: valid.length,
        errors,
        note: valid.length > 0 ? "Embeddings are being generated in the background." : undefined,
      });
    } catch (err) {
      logger.error(" /api/memories/import error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ── Generic DB browser (read-only; whitelisted tables only) ─────────────────
  router.get("/db/tables", async (_req, res) => {
    try {
      res.json({ tables: await store.listTables() });
    } catch (err) {
      logger.error("GET /api/db/tables error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  router.get("/db/table/:name", async (req, res) => {
    try {
      const data = await store.readTable(req.params.name);
      res.json(data);
    } catch (err) {
      if (/^Unknown table/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      logger.error("GET /api/db/table/:name error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  router.get("/db/table/:name/export", async (req, res) => {
    try {
      const data = await store.readTable(req.params.name);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}.json"`);
      res.send(JSON.stringify(data.rows, null, 2));
    } catch (err) {
      if (/^Unknown table/.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      logger.error("GET /api/db/table/:name/export error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  router.patch("/memories/:id/pin", express.json(), async (req, res) => {
    try {
      const { pinned } = req.body ?? {};
      const ok = await store.setPin(req.params.id, !!pinned);
      if (!ok) return res.status(404).json({ error: "Memory not found" });
      res.json({ ok: true, pinned: !!pinned });
    } catch (err) {
      logger.error("PATCH /api/memories/:id/pin error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/memories/:id/expiry", express.json(), async (req, res) => {
    try {
      const { expires_at } = req.body ?? {};
      const ok = await store.setExpiry(req.params.id, expires_at ?? null);
      if (!ok) return res.status(404).json({ error: "Memory not found" });
      res.json({ ok: true });
    } catch (err) {
      logger.error("PATCH /api/memories/:id/expiry error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Wiki (read-only) ────────────────────────────────────────────────────────
  router.get("/wiki/list", async (req, res) => {
    try {
      const { tag, status, updated_since, limit, offset } = req.query;
      const rows = await listArticles(store, {
        tag, status, updated_since,
        limit:  limit  ? parseInt(limit,  10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
      res.json({ articles: rows });
    } catch (err) {
      logger.error("GET /api/wiki/list error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/wiki/search", async (req, res) => {
    try {
      const { q, status, tag, limit, mode } = req.query;
      if (!q) return res.status(400).json({ error: "q is required" });
      const rows = await searchArticles(store, generateEmbedding, {
        query: q,
        status,
        tags:  tag ? [tag] : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        mode,
      });
      res.json({ articles: rows });
    } catch (err) {
      logger.error("GET /api/wiki/search error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/wiki/article/:slug", async (req, res) => {
    try {
      const article = await getArticle(store, req.params.slug);
      if (!article) return res.status(404).json({ error: "Article not found" });
      res.json(article);
    } catch (err) {
      logger.error("GET /api/wiki/article/:slug error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Code graph ──────────────────────────────────────────────────────────────
  // Requires a graph-capable backend (Postgres or SQLite). Returns
  // `{enabled: false}` when neither is available so the sidebar can render
  // an informative empty state.
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
      // Either Postgres (.pool) or SQLite (.db) qualifies.
      if (!store?.pool && !store?.db) return res.json({ enabled: false });
      try { res.json({ enabled: true, ...await fn(req) }); }
      catch (err) {
        if (err.userFacing) return res.status(400).json({ error: err.message });
        logError(`GET ${req.path} failed`, err, { query: req.query });
        res.status(500).json({ error: err.message });
      }
    };
  }
  // Optional skill dependencies (docx Python toolchain). Detection is cheap and
  // safe; install only ever runs pip-into-venv — system binaries are guided.
  router.get("/capabilities", async (_req, res) => {
    try {
      const { detectCapabilities } = await import("../helpers/capabilities.js");
      res.json(detectCapabilities());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/capabilities/install", async (_req, res) => {
    try {
      const { installPipDeps, detectCapabilities } = await import("../helpers/capabilities.js");
      const result = await installPipDeps();
      logger.info("[capabilities] pip deps installed into venv");
      res.json({ ...result, capabilities: detectCapabilities() });
    } catch (err) {
      logger.error("[capabilities] install failed:", err.message);
      res.status(500).json({ error: err.message, log: err.stdout || err.stderr || "" });
    }
  });

  router.get("/codegraph/status", async (_req, res) => {
    try {
      const { getCodegraphStatus } = await import("../codegraph/status.js");
      res.json(getCodegraphStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // User-driven indexing: graph an arbitrary folder under the read ceiling.
  // Out-of-ceiling paths require extending APERIO_ALLOWED_PATHS_TO_READ in .env;
  // we surface that as a 400 with an actionable message rather than a 500.
  router.post("/codegraph/index", express.json(), async (req, res) => {
    if (!store?.pool && !store?.db) {
      return res.status(400).json({ error: "Code graph requires the SQLite or Postgres backend." });
    }
    const raw = (req.body?.path ?? "").toString().trim();
    if (!raw) return res.status(400).json({ error: "path is required" });

    try {
      const { resolve } = await import("path");
      const { homedir } = await import("os");
      const { existsSync, statSync } = await import("fs");
      const { isReadPathAllowed } = await import("./paths.js");
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

      // Block indexing a sub-path of an already-indexed repo (it's already covered).
      const existingRepos = unwrap(await cgRepos(cgCtx));
      const covered = (existingRepos.repos || []).find(r => abs === r.root_path || abs.startsWith(r.root_path + "/"));
      if (covered) {
        return res.status(400).json({
          error: `Already covered by the indexed repo at ${covered.root_path}`,
          coveredBy: covered.root_path,
        });
      }

      // Also auto-add to the allowlist if not already present.
      const current = getAllowlist();
      if (!current.some(p => abs === p || abs.startsWith(p + "/"))) {
        await setAllowlist([...current, abs]);
      }

      const { indexRepo, sweepMissing } = await import("../codegraph/indexer.js");
      const { addRoot, markRootStarted, markRootDone, markRootError, markAllDone } =
        await import("../codegraph/status.js");
      addRoot(abs);

      // Fire-and-forget; client polls /api/codegraph/status for progress.
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
    // Remove from allowlist too — an indexed repo and its allowed path are coupled.
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

  // ── Document graph ────────────────────────────────────────────────────────
  // Same enabled/unwrap contract as the code graph (cgRoute is backend-generic;
  // cgCtx carries store + embeddings, which the docgraph handlers also expect).
  // Surfaces doc_repos / doc_search / doc_context to the Documents sidebar panel.
  router.get("/docgraph/status", async (_req, res) => {
    try {
      const { getDocgraphStatus } = await import("../docgraph/status.js");
      res.json(getDocgraphStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/docgraph/index", express.json(), async (req, res) => {
    if (!store?.pool && !store?.db) {
      return res.status(400).json({ error: "The document graph requires the SQLite or Postgres backend." });
    }
    const raw = (req.body?.path ?? "").toString().trim();
    if (!raw) return res.status(400).json({ error: "path is required" });

    try {
      const { resolve } = await import("path");
      const { homedir } = await import("os");
      const { existsSync, statSync } = await import("fs");
      const { isReadPathAllowed } = await import("./paths.js");
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

      const { indexRepo, sweepMissing } = await import("../docgraph/indexer.js");
      const { addRoot, markRootStarted, markRootDone, markRootError, markAllDone } =
        await import("../docgraph/status.js");
      addRoot(abs);

      // Fire-and-forget; client polls /api/docgraph/status. Inline embedding
      // (no deferEmbedding) so the one-shot index finishes self-contained.
      (async () => {
        markRootStarted(abs);
        try {
          const counts = await indexRepo(store, abs);
          await sweepMissing(store, abs);
          markRootDone(abs, counts);
        } catch (err) {
          logError(`[docgraph] user-triggered index failed`, err, { abs });
          markRootError(abs, err);
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

  // ── Sessions (with pagination) ──────────────────────────────────────────────
  router.get("/sessions", (req, res) => {
    try {
      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
      res.json(listSessions({ page, limit }));
    } catch (err) {
      logger.error("GET /api/sessions error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/sessions/:id", (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Session not found" });
      res.json(session);
    } catch (err) {
      logger.error("GET /api/sessions/:id error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/sessions/:id", (req, res) => {
    try {
      const deleted = deleteSession(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Session not found" });
      res.json({ ok: true });
    } catch (err) {
      logger.error("DELETE /api/sessions/:id error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/sessions/:id/pin", (req, res) => {
    try {
      const { pinned } = req.body ?? {};
      const ok = pinSession(req.params.id, !!pinned);
      if (!ok) return res.status(404).json({ error: "Session not found" });
      res.json({ ok: true, pinned: !!pinned });
    } catch (err) {
      logger.error("PATCH /api/sessions/:id/pin error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Settings (key/value preferences) ──────────────────────────────────────
  // Backed by store.getSetting/setSetting/getSettings/deleteSetting. Values are
  // arbitrary JSON (string, boolean, number, small object).

  router.get("/settings", async (_, res) => {
    try {
      res.json(await store.getSettings());
    } catch (err) {
      logger.error("GET /api/settings error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/settings/:key", async (req, res) => {
    try {
      // A missing key is normal, not an error — return value:null at 200.
      res.json({ key: req.params.key, value: await store.getSetting(req.params.key) });
    } catch (err) {
      logger.error("GET /api/settings/:key error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/settings/:key", express.json({ limit: "64kb" }), async (req, res) => {
    try {
      // "value" may legitimately be false/0/null, so test for presence.
      if (!req.body || !("value" in req.body)) {
        return res.status(400).json({ error: "Body must include a \"value\" field" });
      }
      const value = await store.setSetting(req.params.key, req.body.value);
      res.json({ ok: true, key: req.params.key, value });
    } catch (err) {
      logger.error("PUT /api/settings/:key error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/settings/:key", async (req, res) => {
    try {
      const ok = await store.deleteSetting(req.params.key);
      if (!ok) return res.status(404).json({ error: "Setting not found" });
      res.json({ ok: true });
    } catch (err) {
      logger.error("DELETE /api/settings/:key error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
