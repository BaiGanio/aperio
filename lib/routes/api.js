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
import { mountConfigRoutes }     from "./api-config.js";
import { mountRestartRoutes }    from "./api-restart.js";
import { mountGithubWebhookRoutes } from "./api-github-webhook.js";
import { mountDataRoutes }         from "./api-data.js";
import { mountDatabaseRoutes }     from "./api-database.js";

/**
 * All Express REST routes.
 * Mounted at /api in server.js:  app.use("/api", apiRouter({ agent, store, watchdog }))
 *
 * @param {object} opts
 * @param {object} opts.agent    - Agent instance from createAgent()
 * @param {object} opts.store    - DB store instance from getStore()
 * @param {object} opts.watchdog - Ollama watchdog from createOllamaWatchdog()
 * @param {import('events').EventEmitter} [opts.watcherEvents] - live file-change bus, forwarded to code/doc graph watchers started on demand
 * @param {object} [opts.watcherRegistry] - (kind, root)→handle registry so the index route registers new watchers and DELETE can stop them
 *
 * agent/watchdog/scheduler may be passed either as ready instances (tests) or as
 * lazy getters (getAgent/getWatchdog/getScheduler) when the router is mounted
 * before those are built, so the API can serve before the agent finishes booting.
 */
export function apiRouter({ agent, store, watchdog, scheduler, getAgent, getWatchdog, getScheduler, version, watcherEvents, watcherRegistry }) {
  const router = Router();
  const resolveAgent     = getAgent     ?? (() => agent     ?? null);
  const resolveWatchdog  = getWatchdog  ?? (() => watchdog  ?? null);
  const resolveScheduler = getScheduler ?? (() => scheduler ?? null);
  const ver = version ?? agent?.version;

  mountMetaRoutes(router,      { getAgent: resolveAgent, store, getWatchdog: resolveWatchdog, version: ver });
  mountAgentRoutes(router,     { store, getScheduler: resolveScheduler });
  mountMemoryRoutes(router,    { store });
  mountWikiRoutes(router,      { store });
  mountCodegraphRoutes(router, { store, watcherEvents, watcherRegistry });
  mountDocgraphRoutes(router,  { store, watcherEvents, watcherRegistry });
  mountSessionRoutes(router);
  mountSettingsRoutes(router,  { store });
  mountConfigRoutes(router,    { store });
  mountRestartRoutes(router);
  mountGithubWebhookRoutes(router, { store });
  mountDataRoutes(router,         { store });
  mountDatabaseRoutes(router,     { store });

  return router;
}
