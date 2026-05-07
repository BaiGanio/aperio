import { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import logger from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { listSessions, getSession, deleteSession, saveSessionPaths } from "../helpers/sessions.js";
import {
  updatePaths,
  clampToDefaults,
  ALLOWED_READ_PATHS,
  ALLOWED_WRITE_PATHS,
  DEFAULT_READ_PATHS,
  DEFAULT_WRITE_PATHS,
} from "./paths.js";

const execAsync = promisify(exec);

const VALID_MEMORY_TYPES = new Set(["fact", "preference", "project", "decision", "solution", "source", "person"]);

/**
 * All Express REST routes.
 * Mounted at /api in server.js:  app.use("/api", apiRouter({ agent, store, watchdog }))
 *
 * @param {object} opts
 * @param {object} opts.agent    - Agent instance from createAgent()
 * @param {object} opts.store    - DB store instance from getStore()
 * @param {object} opts.watchdog - Ollama watchdog from createOllamaWatchdog()
 */
export function apiRouter({ agent, store, watchdog }) {
  const { provider } = agent;
  const router = Router();

  // ── Info endpoints ──────────────────────────────────────────────────────────
  router.get("/version",  (_, res) => res.json({ version: agent.version }));
  router.get("/provider", (_, res) => res.json({ provider: provider.name, model: provider.model }));
  router.get("/config",   (_, res) => res.json({ backend: process.env.DB_BACKEND || "lancedb" }));

  // ── Path safety — session-scoped, never persisted to disk ──────────────────
  router.get("/paths", (_, res) => {
    res.json({
      readPaths:    [...ALLOWED_READ_PATHS],
      writePaths:   [...ALLOWED_WRITE_PATHS],
      defaultRead:  [...DEFAULT_READ_PATHS],
      defaultWrite: [...DEFAULT_WRITE_PATHS],
    });
  });

  router.post("/paths", (req, res) => {
    const { readPaths, writePaths, sessionId } = req.body ?? {};
    if (!Array.isArray(readPaths) || !Array.isArray(writePaths))
      return res.status(400).json({ error: "readPaths and writePaths must be arrays" });
    const valid = p => typeof p === "string" && p.trim().length > 0;
    if (!readPaths.every(valid) || !writePaths.every(valid))
      return res.status(400).json({ error: "All paths must be non-empty strings" });
    updatePaths({ readPaths, writePaths });
    if (sessionId && typeof sessionId === "string") {
      try { saveSessionPaths(sessionId, { readPaths: [...ALLOWED_READ_PATHS], writePaths: [...ALLOWED_WRITE_PATHS] }); } catch { /* non-fatal */ }
    }
    logger.info(`[paths] updated — read: ${ALLOWED_READ_PATHS.join(", ")} | write: ${ALLOWED_WRITE_PATHS.join(", ")}`);
    res.json({ ok: true, readPaths: [...ALLOWED_READ_PATHS], writePaths: [...ALLOWED_WRITE_PATHS] });
  });

  // Native folder picker — macOS only, opens Finder via osascript.
  router.get("/pick-folder", async (_, res) => {
    if (process.platform !== "darwin")
      return res.status(501).json({ error: "Native folder picker is only supported on macOS" });
    try {
      const { stdout } = await execAsync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select a folder for Aperio")'`,
        { timeout: 60_000 }
      );
      res.json({ path: stdout.trim().replace(/\/$/, "") });
    } catch (err) {
      if (err.code === 1) return res.json({ path: null, cancelled: true });
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
      const rows = await store.table.query().limit(10_000).toArray();
      res.json({ raw: rows });
    } catch (err) {
      logger.error("GET /api/memories error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  router.post("/memories/import", async (req, res) => {
    try {
      const { memories } = req.body ?? {};
      if (!Array.isArray(memories) || memories.length === 0) {
        return res.status(400).json({ error: "memories array is required" });
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

  // ── Ollama chat proxy ───────────────────────────────────────────────────────
  // Only useful when provider is Ollama; kept here so the route is always
  // registered and won't 404 if called from a cached frontend.
  router.post("/chat", async (req, res) => {
    try {
      const { messages } = req.body ?? {};
      if (!Array.isArray(messages)) {
        return res.status(400).json({ error: "messages array is required" });
      }

      const upstream = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: provider.model, messages, stream: false }),
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        return res.status(502).json({ error: `Ollama error: ${text}` });
      }

      const data = await upstream.json();

      res.json({
        reply: data.message.content,
        reasoning_content: data.message.reasoning_content,
        stats: {
          inputTokens:  data.prompt_eval_count,
          outputTokens: data.eval_count,
          totalTokens:  data.prompt_eval_count + data.eval_count,
        },
      });
    } catch (err) {
      logger.error("POST /api/chat error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  return router;
}
