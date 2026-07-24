// lib/server/setupRoutes.js — static asset serving, the bootstrap-guard
// middleware (gates everything until first-run setup completes), and the
// setup-wizard HTTP + SSE routes. Registered once per createApp() call — the
// per-process STATIC_TOKEN is generated here so concurrent createApp() calls
// in tests never share one.

import express from "express";
import { resolve } from "path";
import { randomBytes } from "crypto";

import { createStaticGuard, STATIC_COOKIE } from "../helpers/staticAuth.js";
import { makeRateLimiter } from "../helpers/rateLimit.js";
import logger from "../helpers/logger.js";
import { runBootstrap, bootstrapEvents, stepState, STEPS } from "../../bootstrap.js";
import { detectLocale, createHtmlRenderer, I18N_COOKIE, SUPPORTED_LOCALES } from "./locale.js";

export function registerSetupRoutes({
  app,
  root,
  PORT,
  isBootstrapped,
  getBootstrapMeta,
  getBootstrapStarted,
  setBootstrapStarted,
  getAppReady,
  bootAppOnce,
}) {
  const { renderHtmlWithLocale } = createHtmlRenderer({ root });

  // PATH-02: per-process secret handed to the browser as an httpOnly cookie
  const STATIC_TOKEN = randomBytes(32).toString("hex");

  function setStaticCookie(res) {
    res.cookie?.(STATIC_COOKIE, STATIC_TOKEN, {
      path: "/", httpOnly: true, sameSite: "Lax", maxAge: 30 * 24 * 3600 * 1000,
    });
  }

  // ─── Routes ───────────────────────────────────────────────────────────────
  app.get(["/", "/index.html"], (req, res) => {
    if (!isBootstrapped()) return res.redirect("/setup");
    const lang = detectLocale(req);
    res.cookie?.(I18N_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "Lax" });
    setStaticCookie(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHtmlWithLocale("index.html", lang));
  });

  app.use(express.static(resolve(root, "public"), { index: false }));
  const staticGuard = createStaticGuard(STATIC_TOKEN);
  const sandboxStatic = (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "sandbox");
    next();
  };
  // Runtime var/ data anchors to process.cwd(), not the install dir — matching
  // the writers (wsHandler sessions/scratch, workers/roundtable.js, file tools),
  // the SQLite default, and the path-guard floor. Identical in normal launches
  // (cwd == repo root); sandboxed runs (cwd elsewhere) stay self-contained (#282).
  app.use("/uploads", staticGuard, sandboxStatic, express.static(resolve(process.cwd(), "var/uploads")));
  app.use("/scratch", staticGuard, sandboxStatic, express.static(resolve(process.cwd(), "var/scratch")));
  app.use("/roundtables", staticGuard, express.static(resolve(process.cwd(), "var/roundtables")));

  // ─── Bootstrap guard middleware ────────────────────────────────────────────
  app.use((req, res, next) => {
    if (isBootstrapped()) return next();
    const bypass =
      req.path.startsWith("/setup") ||
      req.path.startsWith("/api/bootstrap") ||
      req.path.startsWith("/api/setup") ||
      req.path === "/favicon.ico";
    if (bypass) return next();
    if (req.path.startsWith("/api/")) {
      return res.status(503).json({ error: "setup_required" });
    }
    res.redirect("/setup");
  });

  // ─── Setup page ───────────────────────────────────────────────────────────
  app.get("/setup", (req, res) => {
    if (isBootstrapped()) return res.redirect("/");
    const lang = detectLocale(req);
    res.cookie?.(I18N_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 3600 * 1000, sameSite: "Lax" });
    setStaticCookie(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderHtmlWithLocale("setup.html", lang));
  });

  app.get("/api/locale", (req, res) => {
    res.json({ lang: detectLocale(req), supported: [...SUPPORTED_LOCALES] });
  });

  app.get("/api/bootstrap/state", (_req, res) => {
    res.json({
      bootstrapped: isBootstrapped(),
      started: getBootstrapStarted(),
      ready: getAppReady(),
      meta:  getBootstrapMeta(),
      steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })),
    });
  });

  const setupLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, name: "setup" });

  app.get("/api/setup/specs", setupLimiter, async (_req, res) => {
    try {
      const { getSpecs } = await import("../helpers/specs.js");
      res.json(getSpecs());
    } catch (err) {
      logger.error("specs failed:", err);
      res.status(500).json({ error: "specs_failed" });
    }
  });

  app.post("/api/setup/config", setupLimiter, async (req, res) => {
    if (isBootstrapped() || getBootstrapStarted()) {
      return res.status(409).json({ error: "already_started" });
    }
    try {
      const { provider, apiKey, model, pullModel } = req.body ?? {};
      const { writeEnvFromWizard } = await import("../helpers/envFile.js");
      writeEnvFromWizard({ provider, apiKey, model, port: PORT });

      // Reload .env so bootApp + providers see the new values
      const dotenv = await import("dotenv");
      dotenv.config({ path: resolve(root, ".env"), override: true });

      // Tier-1 choices (provider, key, model) go to DB settings, not .env
      // (#252): apply to process.env for this boot and stash for bootApp to
      // flush into the store the moment it opens.
      const { stashWizardConfig } = await import("../helpers/setupPending.js");
      stashWizardConfig({ provider, apiKey, model });

      setBootstrapStarted(true);
      bootstrapEvents.once("complete", () => {
        logger.info("Bootstrap done — initialising app…");
        void bootAppOnce().catch(() => {});
      });
      bootstrapEvents.once("error", () => { setBootstrapStarted(false); });
      runBootstrap({
        model: model || process.env.LLAMACPP_MODEL,
        engine: provider && provider.toLowerCase() === "llamacpp" ? provider.toLowerCase() : null,
        pullModel: !!pullModel,
      });

      res.json({ ok: true });
    } catch (err) {
      logger.warn("setup config rejected:", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Bootstrap SSE stream ─────────────────────────────────────────────────
  app.get("/api/bootstrap/stream", (req, res) => {
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send("snapshot", { steps: STEPS.map(s => ({ ...s, status: stepState[s.id] })) });

    if (isBootstrapped()) {
      send("complete", { ready: true });
      return res.end();
    }

    const onProgress = d  => send("progress", d);
    const onStep     = d  => send("step", d);
    const onComplete = () => { send("complete", { ready: true }); res.end(); };
    const onError    = d  => { send("error", d); res.end(); };

    bootstrapEvents.on("progress", onProgress);
    bootstrapEvents.on("step",     onStep);
    bootstrapEvents.on("complete", onComplete);
    bootstrapEvents.on("error",    onError);

    const hb = setInterval(() => res.write(": ping\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(hb);
      bootstrapEvents.off("progress", onProgress);
      bootstrapEvents.off("step",     onStep);
      bootstrapEvents.off("complete", onComplete);
      bootstrapEvents.off("error",    onError);
    });
  });
}
