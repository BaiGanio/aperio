// lib/routes/api-data.js
// Data portability REST endpoints — full database export/import (memories + wiki + self-memories).
import express from "express";
import logger from "../helpers/logger.js";
import { makeRateLimiter } from "../helpers/rateLimit.js";

export function mountDataRoutes(router, { store }) {

  // ── Export ───────────────────────────────────────────────────────────────────

  router.post("/data/export", express.json({ limit: "32kb" }), async (req, res) => {
    try {
      const { include_wiki = true, include_agent_jobs = true, include_self_memories = true } = req.body ?? {};
      const data = await store.exportAll();

      const payload = {
        aperio_export: 1,
        exported_at: new Date().toISOString(),
        counts: {
          memories: data.memories.length,
          wiki_articles: include_wiki ? data.wiki_articles.length : 0,
          agent_jobs: include_agent_jobs ? data.agent_jobs.length : 0,
          agent_runs: include_agent_jobs ? data.agent_runs.length : 0,
          self_memories: include_self_memories ? data.self_memories.length : 0,
        },
        memories: data.memories,
        wiki_articles: include_wiki ? data.wiki_articles : [],
        agent_jobs: include_agent_jobs ? data.agent_jobs : [],
        agent_runs: include_agent_jobs ? data.agent_runs : [],
        self_memories: include_self_memories ? data.self_memories : [],
      };

      res.json(payload);
    } catch (err) {
      logger.error("POST /api/data/export error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ── Import ───────────────────────────────────────────────────────────────────

  const importLimiter = makeRateLimiter({
    windowMs: 15 * 60 * 1000, max: 20, name: "data-import",
  });

  router.post("/data/import", importLimiter, express.json({ limit: "2mb" }), async (req, res) => {
    try {
      let { memories, wiki_articles, self_memories } = req.body ?? {};

      // Support old export format: flat memories array with no wiki.
      if (!memories && Array.isArray(req.body)) {
        memories = req.body;
        wiki_articles = [];
      }

      if (!Array.isArray(memories)) {
        return res.status(400).json({ error: "memories array is required" });
      }
      if (memories.length > 1000) {
        return res.status(413).json({ error: "Too many memories — max 1000 per import" });
      }

      const result = await store.importAll({
        memories,
        wiki_articles: wiki_articles ?? [],
        self_memories: self_memories ?? [],
      });

      // Queue imported memories for embedding backfill.
      if (result.imported.memories > 0) {
        setImmediate(async () => {
          try {
            const pending = await store.listWithoutEmbeddings();
            if (pending.length > 0) {
              const { generateEmbedding } = await import("../helpers/embeddings.js");
              for (const row of pending) {
                const embedding = await generateEmbedding(`${row.title}. ${row.content}`);
                if (embedding) await store.setEmbedding(row.id, embedding);
              }
              logger.info(`[data-import] backfill complete: ${pending.length} embeddings`);
            }
          } catch (err) {
            logger.error("[data-import] backfill error:", err.message);
          }
        });
      }

      res.json({
        imported: result.imported,
        skipped: result.skipped,
        note: result.imported.memories > 0
          ? "Embeddings are being generated in the background."
          : undefined,
      });
    } catch (err) {
      logger.error("POST /api/data/import error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
}
