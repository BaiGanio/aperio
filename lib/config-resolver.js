// lib/config-resolver.js
//
// The resolver half of the config layer (issue #167, Phase 1). The registry in
// config.js is pure metadata; this turns DB-stored settings into live values.
//
// Resolution order is DB > env > default:
//   • A value saved via the Settings UI (DB) wins — even over a real .env var.
//   • Otherwise the .env / shell env var is used (seed / headless deploys).
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

const EDITABLE = CONFIG.filter((e) => e.tier === 1);

// Inject DB-stored Tier-1 values into process.env so downstream reads pick them
// up. Returns the list of keys applied. Safe to call with no store (no-op).
export async function applyConfigToEnv(store) {
  if (!store?.getSettings) return [];

  let settings;
  try {
    settings = await store.getSettings();
  } catch (err) {
    logger.warn(`[config] could not load settings, using .env/defaults: ${err.message}`);
    return [];
  }

  const applied = [];
  for (const entry of EDITABLE) {
    const raw = settings[configSettingKey(entry.key)];
    if (raw == null) continue;            // not set in DB → fall through to env/default
    const value = String(raw);
    if (value === "") continue;           // blank → treat as unset
    process.env[entry.key] = value;       // DB wins over .env
    applied.push(entry.key);
  }

  if (applied.length) {
    logger.info(`[config] applied ${applied.length} setting(s) from DB: ${applied.join(", ")}`);
  }
  return applied;
}
