// lib/routes/api-meta.js
// Info, provider, models, skills, files, paths, pick-folder, heartbeat, metrics, capabilities endpoints.
import express from "express";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import logger, { logError } from "../helpers/logger.js";
import { revealScratchArtifact } from "../helpers/artifactActions.js";
import { getAllowlist, getUserPaths, setAllowlist } from "./paths.js";
import { isLite } from "../config.js";
import { createMetricsSampler } from "../helpers/metricsSampler.js";

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

export function mountMetaRoutes(router, opts = {}) {
  const { store } = opts;
  const root = opts.root ?? process.cwd();
  const revealArtifact = opts.revealArtifact ?? (url => revealScratchArtifact(url, { root }));
  const previewArtifact = opts.previewArtifact ?? (async url => {
    // ExcelJS is sizeable and spreadsheet previews are uncommon. Keep it off
    // the main-process startup path and load it only when a preview is opened.
    const { previewSpreadsheetArtifact } = await import("../helpers/spreadsheetPreview.js");
    return previewSpreadsheetArtifact(url, { root });
  });
  // Late-bound deps: these routes mount before createAgent()/the watchdog exist
  // so the rest of the API can serve immediately. `agent` is a proxy that throws
  // a 503 ("warming up") until the real agent is ready; `watchdog` no-ops until
  // set. Back-compat: callers may still pass a ready `agent`/`watchdog` directly.
  const getAgent    = opts.getAgent    ?? (() => opts.agent    ?? null);
  const getWatchdog = opts.getWatchdog ?? (() => opts.watchdog ?? null);
  const version     = opts.version     ?? opts.agent?.version;
  const agent = new Proxy({}, {
    get(_t, prop) {
      const a = getAgent();
      if (!a) {
        const e = new Error("Server is warming up — the model is still initializing.");
        e.status = 503;
        throw e;
      }
      const v = a[prop];
      return typeof v === "function" ? v.bind(a) : v;
    },
  });
  const watchdog = { heartbeat: () => getWatchdog()?.heartbeat() };

  // ── Info endpoints ──────────────────────────────────────────────────────────
  router.get("/version",  (_, res) => res.json({ version }));
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

  // ── Skill management (browse / edit / create / disable / reset) ───────────────
  // All of these ride the global auth guard + localhost bind. Writes never touch
  // the shipped skills/ tree — user edits are overlay files under var/skills/.
  router.get("/skills/manage", (_, res) => {
    try {
      res.json({ skills: agent.getSkillsForManagement() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Editable payload (body + fields) for one skill.
  router.get("/skill/edit", (req, res) => {
    const skill = agent.getSkillForEdit(String(req.query.name || ""));
    if (!skill) return res.status(404).json({ error: "skill not found" });
    res.json(skill);
  });

  const skillBody = express.json({ limit: "256kb" });

  // Create a new user skill. Rejects a name that already exists.
  router.post("/skill", skillBody, (req, res) => {
    const { name, description, keywords, load, body } = req.body || {};
    if (agent.getSkillForEdit(String(name || "")))
      return res.status(409).json({ error: "A skill with that name already exists." });
    try {
      res.json({ ok: true, skill: agent.saveSkill({ name, description, keywords, load, body }) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Edit / override an existing skill (also used to toggle always-on).
  router.put("/skill", skillBody, (req, res) => {
    const { name, description, keywords, load, body } = req.body || {};
    try {
      res.json({ ok: true, skill: agent.saveSkill({ name, description, keywords, load, body }) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Flip a skill's load mode in one call (used by the always-on switch).
  router.patch("/skill/load", skillBody, (req, res) => {
    const { name, load } = req.body || {};
    try {
      res.json({ ok: true, skill: agent.setSkillLoad(String(name || ""), load) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Remove a user skill (deleted) or disable a shipped one (load: never).
  router.delete("/skill", (req, res) => {
    try {
      res.json({ ok: true, ...agent.deleteSkill(String(req.query.name || "")) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Reset a shipped skill back to its bundled default (drops the overlay).
  router.post("/skill/reset", skillBody, (req, res) => {
    const name = String((req.body && req.body.name) || "");
    try {
      res.json({ ok: true, skill: agent.resetSkill(name) });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
    const llamacppBase = process.env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080";
    try {
      const r = await fetch(`${llamacppBase}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const data = await r.json();
        providers.llamacpp = (data.data || []).map(m => m.id);
      }
    } catch { /* llama-server not running */ }
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

  // Metrics sampling owns an explicit, stoppable timer (see metricsSampler.js);
  // `stop()` is surfaced through the router's dispose hook so shutdown — and any
  // second mount in tests — does not leave a sampler holding the store alive.
  const metricsSampler = opts.metricsSampler ?? createMetricsSampler({ store });
  metricsSampler.start();
  router.get("/metrics", (_, res) => res.json(metricsSampler.getMetrics()));
  router.get("/system",  (_, res) => res.json(metricsSampler.getMetrics()));

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

  // Reveal only files already served from Aperio's generated-artifact workspace.
  // This is intentionally not a general-purpose host path opener.
  router.post("/artifact/reveal", async (req, res) => {
    try {
      await revealArtifact(req.body?.url);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Parse only generated XLSX artifacts and return a bounded display grid. The
  // browser never receives arbitrary host paths and never loads a workbook-sized
  // parser bundle; containment and file-size limits stay server-side.
  router.get("/artifact/preview", async (req, res) => {
    try {
      res.json(await previewArtifact(req.query?.url));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Heartbeat
  router.get("/heartbeat", (_, res) => {
    watchdog.heartbeat();
    logger.debug("✅ Heartbeat — used by the frontend keepalive script.");
    res.json({ ok: true, ts: Date.now() });
  });

  // Quit — the "Quit Aperio" button. Shuts the server (and llama.cpp, if safe)
  // down immediately instead of waiting for the idle timeout after the tab closes.
  // Under a supervisor (Docker restart: unless-stopped, PM2, systemd, k8s) a
  // clean exit is immediately relaunched, so quitting from inside is impossible —
  // report that instead of pretending to stop.
  router.post("/quit", async (_req, res) => {
    const { isSupervised } = await import("../helpers/selfRestart.js");
    if (isSupervised()) {
      logger.warn("🛑 /quit requested, but the process is supervised — refusing (the supervisor would relaunch it).");
      return res.status(409).json({ ok: false, supervised: true });
    }
    res.json({ ok: true, supervised: false }); // answer before we tear down
    logger.warn("🛑 /quit requested — shutting down.");
    setTimeout(() => {
      const wd = getWatchdog();
      if (wd?.quit) wd.quit(); else process.kill(process.pid, "SIGTERM");
    }, 150);
  });
  router.get("/config/client", (_, res) => res.json({
    heartbeatIntervalSeconds: Number(process.env.HEARTBEAT_INTERVAL_SECONDS) || 60,
    lite: isLite(),
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

  // Resources this mount owns, released by apiRouter().dispose().
  return { stop: () => metricsSampler.stop() };
}
