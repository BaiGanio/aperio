// lib/routes/api-sessions.js
// Session CRUD endpoints.
import logger from "../helpers/logger.js";
import { listSessions, getSession, deleteSession, pinSession } from "../helpers/sessions.js";

export function mountSessionRoutes(router) {

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
}
