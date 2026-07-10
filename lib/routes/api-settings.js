// lib/routes/api-settings.js
// Settings key/value CRUD endpoints.
import express from "express";
import logger from "../helpers/logger.js";
import { CONFIG } from "../config.js";
import { configSettingKey } from "../config-resolver.js";
import { inferType } from "../config-sync.js";

// Secret settings are write-only over the API: a GET never returns their value,
// only whether one is set ({ configured: bool }), so a token/webhook secret can
// be entered in the UI but is never echoed back to any client. The set covers
// the legacy github.* keys plus every secret-typed registry var the config UI
// writes under config.<KEY> (provider API keys, etc.).
const SECRET_SETTING_KEYS = new Set([
  "github.token", "github.webhook_secret",
  ...CONFIG.filter((e) => e.type === "secret").map((e) => configSettingKey(e.key)),
]);

// Known setting keys — any PUT to a key outside this set is rejected.
// Covers every config.* registry var plus the handful of built-in keys the
// app manages internally (paths, embeddings, DB connections, GitHub secrets).
const KNOWN_SETTING_KEYS = new Set([
  "github.token", "github.webhook_secret",
  "allowed-paths",
  "embedding_provider",
  "db.connections",
  ...CONFIG.map((e) => configSettingKey(e.key)),
]);
// Also mask any config.<KEY> whose name infers a secret — this covers unmanaged
// vars adopted from .env (Phase 2b), which have no registry entry but may hold a
// token/key/password and must not leak via /api/settings.
const isSecretSetting = (k) =>
  SECRET_SETTING_KEYS.has(k) ||
  (k.startsWith("config.") && inferType(k.slice("config.".length)) === "secret");
const isConfigured = (v) => v != null && String(v).trim() !== "";
const maskSecret  = (v) => ({ configured: isConfigured(v) });

export function mountSettingsRoutes(router, { store }) {

  router.get("/settings", async (_, res) => {
    try {
      const all = await store.getSettings();
      for (const k of Object.keys(all)) if (isSecretSetting(k)) all[k] = maskSecret(all[k]);
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
        value: isSecretSetting(req.params.key) ? maskSecret(value) : value,
      });
    } catch (err) {
      logger.error("GET /api/settings/:key error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/settings/:key", express.json({ limit: "64kb" }), async (req, res) => {
    try {
      if (!KNOWN_SETTING_KEYS.has(req.params.key)) {
        return res.status(400).json({ error: `Unknown setting: "${req.params.key}"` });
      }
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
