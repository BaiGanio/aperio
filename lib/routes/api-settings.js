// lib/routes/api-settings.js
// Settings key/value CRUD endpoints.
import express from "express";
import logger from "../helpers/logger.js";

// Secret settings are write-only over the API: a GET never returns their value,
// only whether one is set ({ configured: bool }), so a token/webhook secret can
// be entered in the UI but is never echoed back to any client.
const SECRET_SETTING_KEYS = new Set(["github.token", "github.webhook_secret"]);
const isConfigured = (v) => v != null && String(v).trim() !== "";
const maskSecret  = (v) => ({ configured: isConfigured(v) });

export function mountSettingsRoutes(router, { store }) {

  router.get("/settings", async (_, res) => {
    try {
      const all = await store.getSettings();
      for (const k of SECRET_SETTING_KEYS) if (k in all) all[k] = maskSecret(all[k]);
      res.json(all);
    } catch (err) {
      logger.error("GET /api/settings error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/settings/:key", async (req, res) => {
    try {
      const value = await store.getSetting(req.params.key);
      res.json({
        key:   req.params.key,
        value: SECRET_SETTING_KEYS.has(req.params.key) ? maskSecret(value) : value,
      });
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
