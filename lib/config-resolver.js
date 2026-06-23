// lib/config-resolver.js
//
// The resolver half of the config layer (issue #167, Phase 1). The registry in
// config.js is pure metadata; this turns DB-stored settings into live values.
//
// Resolution order is DB > env > default by default, but APERIO_CONFIG_PRECEDENCE
// (env-only, Tier-0) can flip the top two for the "I want to override from .env
// without touching the UI" case:
//   • db  (default) → DB > env > default. A value saved via the Settings UI wins
//     even over a real .env var.
//   • env           → env > DB > default. A var present in the environment wins
//     over its DB value. Settings that exist ONLY in the DB (no env entry) still
//     apply — env mode overrides what's there, it does not ignore the DB.
//   • Otherwise the code's own built-in default applies.
//
// Mechanism: instead of rewriting the ~280 existing `process.env.X` reads to
// call a resolver, we inject DB values into process.env once at boot, before
// any consumer module loads. Every existing read then resolves correctly with
// zero changes. Because edits require a restart to take effect, there is no
// hot-reload path — a restart simply re-runs this injection.

import { CONFIG } from "./config.js";
import logger from "./helpers/logger.js";

const PREFIX = "config.";

// The settings-store key a Tier-1 var is persisted under (namespaced so it
// can't collide with the app's other settings, e.g. github.token).
export const configSettingKey = (key) => PREFIX + key;

// Only Tier-1 vars are UI/DB-editable. Tier-0 (DB creds, ports, security keys)
// stay env-only — the store itself needs some of them to even open.
export const EDITABLE_KEYS = CONFIG.filter((e) => e.tier === 1).map((e) => e.key);

// Tier-0 keys are never injected, even if a config.<KEY> value exists in the DB.
const TIER0 = new Set(CONFIG.filter((e) => e.tier === 0).map((e) => e.key));

// Inject DB-stored config values into process.env so downstream reads pick them
// up. Covers every config.<KEY> setting except Tier-0 keys — so it applies both
// registry Tier-1 vars and "unmanaged" vars adopted from .env via the Config
// panel (Phase 2b), which have no registry entry. Returns the keys applied.
// Safe to call with no store (no-op).
export async function applyConfigToEnv(store) {
  if (!store?.getSettings) return [];

  let settings;
  try {
    settings = await store.getSettings();
  } catch (err) {
    logger.warn(`[config] could not load settings, using .env/defaults: ${err.message}`);
    return [];
  }

  // In "env" precedence, a var already present in the environment (from .env,
  // loaded by dotenv before us, or the shell) keeps its value — we simply don't
  // inject the DB value over it. DB-only vars (absent from the env) are still
  // injected, so env mode overrides rather than ignores the DB.
  const envWins = String(process.env.APERIO_CONFIG_PRECEDENCE || "db")
    .trim().toLowerCase() === "env";
  const isSet = (v) => v != null && String(v).trim() !== "";

  const applied = [];
  for (const [settingKey, raw] of Object.entries(settings)) {
    if (!settingKey.startsWith(PREFIX)) continue;   // only our namespace
    const key = settingKey.slice(PREFIX.length);
    if (TIER0.has(key)) continue;         // never inject bootstrap/security keys
    if (raw == null) continue;            // not set → fall through to env/default
    const value = String(raw);
    if (value === "") continue;           // blank → treat as unset
    if (envWins && isSet(process.env[key])) continue;  // a real env var wins
    process.env[key] = value;             // DB wins over .env
    applied.push(key);
  }

  if (applied.length) {
    logger.info(`[config] applied ${applied.length} setting(s) from DB: ${applied.join(", ")}`);
  }
  return applied;
}
