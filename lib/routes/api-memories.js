// lib/routes/api-memories.js
// Memories CRUD, import, generic DB browser endpoints.
import express from "express";
import logger from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { makeRateLimiter } from "../helpers/rateLimit.js";

const VALID_MEMORY_TYPES = new Set(["fact", "preference", "project", "decision", "solution", "source", "person"]);

export function mountMemoryRoutes(router, { store }) {

  // ── Memories ──────────────────────────────────────────────────────────────────
  router.get("/memories", async (req, res) => {
    try {
      const rows = await store.listAll();
      res.json({ raw: rows });
    } catch (err) {
      logger.error("GET /api/memories error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // NET-03: bulk import embeds every row — throttle it.
  const importLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, name: "memories-import" });
  router.post("/memories/import", importLimiter, express.json({ limit: "512kb" }), async (req, res) => {
    try {
      const { memories } = req.body ?? {};
      if (!Array.isArray(memories) || memories.length === 0) {
        return res.status(400).json({ error: "memories array is required" });
      }
      if (memories.length > 500) {
        return res.status(413).json({ error: "Too many memories — max 500 per import" });
      }

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

      await store.bulkInsert(valid);

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
      logger.error("/api/memories/import error:", err);
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
}
