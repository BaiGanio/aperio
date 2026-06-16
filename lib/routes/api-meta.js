// lib/routes/api-meta.js
// Info, provider, models, skills, files, paths, pick-folder, heartbeat, metrics, capabilities endpoints.
import express, { Router } from "express";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import logger, { logError } from "../helpers/logger.js";
import { getAllowlist, getUserPaths, setAllowlist } from "./paths.js";

const execAsync = promisify(exec);

// ── File search helper for @ autocomplete ─────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "target", "vendor", ".DS_Store"]);
function _collectFiles(dir, q, out, max, rootDir, depth = 0) {
  if (out.length >= max || depth > 6) return;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (out.length >= max) return;
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    const rel = relative(rootDir, full);
    if (name.toLowerCase().includes(q)) out.push({ name, path: rel, isDir });
    if (isDir) _collectFiles(full, q, out, max, rootDir, depth + 1);
  }
}

export function mountMetaRoutes(router, { agent, store, watchdog }) {
  const { provider } = agent;

  // ── Info endpoints ──────────────────────────────────────────────────────────
  router.get("/version",  (_, res) => res.json({ version: agent.version }));
  router.get("/provider", (_, res) => res.json({ provider: agent.provider.name, model: agent.provider.model }));
  router.get("/config",   (_, res) => res.json({ backend: process.env.DB_BACKEND || "sqlite" }));

  // On-demand SKILL.md body
  router.get("/skill", (req, res) => {
    const doc = agent.getSkillDoc(String(req.query.name || ""));
    if (!doc) return res.status(404).json({ error: "skill not found" });
    res.json(doc);
  });

  // List all skill names + descriptions
  router.get("/skills", (_, res) => {
    try {
      const list = agent.getSkillList();
      res.json({ skills: list });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Search files/folders in allowed paths (for @ autocomplete)
  router.get("/files", (req, res) => {
    const q = (req.query.q || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json({ files: [] });
    try {
      const allowed = getUserPaths();
      const results = [];
      const MAX_RESULTS = 20;
      for (const dir of allowed) {
        if (results.length >= MAX_RESULTS) break;
        _collectFiles(dir, q, results, MAX_RESULTS, dir);
      }
      res.json({ files: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/models", async (_, res) => {
    const providers = {};
    const ollamaBase = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    try {
      const r = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const data = await r.json();
        providers.ollama = (data.models || []).map(m => m.name);
      }
    } catch { /* ollama not running */ }
    if (process.env.ANTHROPIC_API_KEY) {
      providers.anthropic = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    }
    if (process.env.DEEPSEEK_API_KEY) {
      providers.deepseek = ["deepseek-v4-flash", "deepseek-v4-pro"];
    }
    res.json({ provider: agent.provider.name, model: agent.provider.model, providers });
  });

  router.put("/provider", express.json({ limit: "4kb" }), (req, res) => {
    const { provider: providerName, model } = req.body || {};
    if (!providerName || !model) return res.status(400).json({ error: "provider and model are required" });
    try {
      agent.setProvider({ name: providerName, model });
      res.json({ ok: true, provider: providerName, model });
    } catch (err) {
      logger.error("PUT /api/provider error:", err);
      res.status(500).json({ error: err.message });
    }
  });

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

  // ── Allowed folders ──────────────────────────────────────────────────────────
  router.get("/paths", (_, res) => {
    res.json({ paths: getUserPaths() });
  });

  router.post("/paths", express.json({ limit: "16kb" }), async (req, res) => {
    const { paths } = req.body ?? {};
    if (!Array.isArray(paths))
      return res.status(400).json({ error: "paths must be an array" });
    const valid = p => typeof p === "string" && p.trim().length > 0;
    if (!paths.every(valid))
      return res.status(400).json({ error: "All paths must be non-empty strings" });
    const saved = await setAllowlist(paths);
    logger.info(`[paths] updated — ${saved.join(", ")}`);
    res.json({ ok: true, paths: saved });
  });

  // Native folder picker
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
        for (const cmd of [
          `zenity --file-selection --directory --title="Select a folder for Aperio"`,
          `kdialog --getexistingdirectory "$HOME" --title "Select a folder for Aperio"`,
        ]) {
          try {
            const { stdout } = await execAsync(cmd, { timeout: 60_000 });
            return stdout.trim();
          } catch (err) {
            if (err.code === 1) throw Object.assign(new Error("cancelled"), { cancelled: true });
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

  // Heartbeat
  router.get("/heartbeat", (_, res) => {
    watchdog.heartbeat();
    logger.debug("✅ Heartbeat — used by the frontend keepalive script.");
    res.json({ ok: true, ts: Date.now() });
  });
  router.get("/config/client", (_, res) => res.json({
    heartbeatIntervalSeconds: Number(process.env.HEARTBEAT_INTERVAL_SECONDS) || 10,
  }));

  // ── Capabilities ─────────────────────────────────────────────────────────────
  router.get("/capabilities", async (_req, res) => {
    try {
      const { detectCapabilities } = await import("../helpers/capabilities.js");
      res.json(detectCapabilities());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/capabilities/install", async (_req, res) => {
    try {
      const { installPipDeps, detectCapabilities } = await import("../helpers/capabilities.js");
      const result = await installPipDeps();
      logger.info("[capabilities] pip deps installed into venv");
      res.json({ ...result, capabilities: detectCapabilities() });
    } catch (err) {
      logger.error("[capabilities] install failed:", err.message);
      res.status(500).json({ error: err.message, log: err.stdout || err.stderr || "" });
    }
  });
}
