// lib/routes/api.js
// Thin composition layer — imports all domain sub-routers and mounts them.
// Originally a single 810-line file; now delegates to focused per-domain modules.

import { Router } from "express";
import { mountMetaRoutes }       from "./api-meta.js";
import { mountAgentRoutes }      from "./api-agents.js";
import { mountMemoryRoutes }     from "./api-memories.js";
import { mountWikiRoutes }       from "./api-wiki.js";
import { mountCodegraphRoutes }  from "./api-codegraph.js";
import { mountDocgraphRoutes }   from "./api-docgraph.js";
import { mountSessionRoutes }    from "./api-sessions.js";
import { mountSettingsRoutes }   from "./api-settings.js";
import { mountGithubWebhookRoutes } from "./api-github-webhook.js";
import { mountDataRoutes }         from "./api-data.js";

/**
 * All Express REST routes.
 * Mounted at /api in server.js:  app.use("/api", apiRouter({ agent, store, watchdog }))
 *
 * @param {object} opts
 * @param {object} opts.agent    - Agent instance from createAgent()
 * @param {object} opts.store    - DB store instance from getStore()
 * @param {object} opts.watchdog - Ollama watchdog from createOllamaWatchdog()
 */
export function apiRouter({ agent, store, watchdog, scheduler }) {
  const router = Router();

  mountMetaRoutes(router,      { agent, store, watchdog });
  mountAgentRoutes(router,     { store, scheduler });
  mountMemoryRoutes(router,    { store });
  mountWikiRoutes(router,      { store });
  mountCodegraphRoutes(router, { store });
  mountDocgraphRoutes(router,  { store });
  mountSessionRoutes(router);
  mountSettingsRoutes(router,  { store });
  mountGithubWebhookRoutes(router, { store });
  mountDataRoutes(router,         { store });

  return router;
}
