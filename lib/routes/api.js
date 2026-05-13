import express, { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import logger from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { listSessions, getSession, deleteSession, pinSession } from "../helpers/sessions.js";
import {
  clampToDefaults,
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

  // ── Path safety — env-configured defaults (immutable per process) ─────────
  router.get("/paths", (_, res) => {
    res.json({
      readPaths:    [...DEFAULT_READ_PATHS],
      writePaths:   [...DEFAULT_WRITE_PATHS],
      defaultRead:  [...DEFAULT_READ_PATHS],
      defaultWrite: [...DEFAULT_WRITE_PATHS],
    });
  });

  // Validates and clamps the supplied paths against the env defaults.
  // Per-connection overrides are applied via the WebSocket set_paths message;
  // this endpoint no longer mutates any process-level state.
  router.post("/paths", (req, res) => {
    const { readPaths, writePaths } = req.body ?? {};
    if (!Array.isArray(readPaths) || !Array.isArray(writePaths))
      return res.status(400).json({ error: "readPaths and writePaths must be arrays" });
    const valid = p => typeof p === "string" && p.trim().length > 0;
    if (!readPaths.every(valid) || !writePaths.every(valid))
      return res.status(400).json({ error: "All paths must be non-empty strings" });
    const clamped = clampToDefaults({ readPaths, writePaths });
    logger.info(`[paths] validated — read: ${clamped.readPaths.join(", ")} | write: ${clamped.writePaths.join(", ")}`);
    res.json({ ok: true, readPaths: clamped.readPaths, writePaths: clamped.writePaths });
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

  return router;
}
