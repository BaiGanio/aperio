import { Router } from "express";

/**
 * All Express REST routes.
 * Mounted at /api in server.js:  app.use("/api", apiRouter({ agent, store }))
 *
 * @param {object} opts
 * @param {object} opts.agent  - Agent instance from createAgent()
 * @param {object} opts.store  - DB store instance from getStore()
 */
export function apiRouter({ agent, store }) {
  const { provider } = agent;
  const router = Router();

  // ── Info endpoints ──────────────────────────────────────────────────────────
  router.get("/version",  (_, res) => res.json({ version: agent.version }));
  router.get("/provider", (_, res) => res.json({ provider: provider.name, model: provider.model }));
  router.get("/config",   (_, res) => res.json({ backend: process.env.DB_BACKEND || "lancedb" }));
  router.get("/heartbeat",(_, res) => res.json({ ok: true, ts: Date.now() }));

  // ── Memories ────────────────────────────────────────────────────────────────
  router.get("/memories", async (req, res) => {
    try {
      const records = await store.table.query().limit(500).toArray();
      res.json({ raw: records });
    } catch (err) {
      console.error("GET /api/memories error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
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
        stats: {
          inputTokens:  data.prompt_eval_count,
          outputTokens: data.eval_count,
          totalTokens:  data.prompt_eval_count + data.eval_count,
        },
      });
    } catch (err) {
      console.error("POST /api/chat error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  return router;
}