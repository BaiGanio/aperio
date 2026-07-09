// lib/routes/api-wiki.js
// Wiki list, search, article endpoints.
import logger from "../helpers/logger.js";
import { generateEmbedding } from "../helpers/embeddings.js";
import { listArticles, searchArticles, getArticle } from "../handlers/wiki/wikiQueries.js";

export function mountWikiRoutes(router, { store }) {

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

  // ── Wiki drafts ─────────────────────────────────────────────────────────────
  router.get("/wiki/drafts", async (_req, res) => {
    try {
      const drafts = await store.listWikiDrafts();
      res.json({ drafts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/wiki/drafts/:slug/publish", async (req, res) => {
    try {
      const result = await store.publishWikiDraft(req.params.slug);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });
}
