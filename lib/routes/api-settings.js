// lib/routes/api-settings.js
// Settings key/value CRUD endpoints.
import express from "express";
import logger from "../helpers/logger.js";

export function mountSettingsRoutes(router, { store }) {

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
      res.json({ key: req.params.key, value: await store.getSetting(req.params.key) });
    } catch (err) {
      logger.error("GET /api/settings/:key error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/settings/:key", express.json({ limit: "64kb" }), async (req, res) => {
    try {
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
}
