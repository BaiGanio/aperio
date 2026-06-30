// lib/config-resolver.js
//
// The resolver half of the config layer (issue #167, Phase 1). The registry in
// config.js is pure metadata; this turns DB-stored settings into live values.
//
// Resolution order is env > DB > default by default, but APERIO_CONFIG_PRECEDENCE
// can flip the top two:
//   • env (default) → env > DB > default. A var present in the environment wins
//     over its DB value, so terminal users drive everything from .env. Settings
//     that exist ONLY in the DB (no env entry) still apply — env mode overrides
//     what's there, it does not ignore the DB.
//   • db            → DB > env > default. A value saved via the Settings UI wins
//     even over a real .env var, so UI users manage config from the panel.
//   • Otherwise the code's own built-in default applies.
//
// The precedence key itself is read from the environment first (so .env can
// always force it), then from the Settings UI (so a UI user can flip it to "db"
// without editing .env), then defaults to "env". It is the one Tier-0 key the
// resolver injects, because it is the meta-switch that governs all the others.
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

const PRECEDENCE_KEY = "APERIO_CONFIG_PRECEDENCE";
          
// Provenance snapshot (issue #182). applyConfigToEnv captures which layer
// supplied each config var's effective value — "db", "env", or "default" — at
// boot, before it overwrites process.env. Other code (the ctx-clamp warning, the
// `config` diagnostic) reads this to label values without re-reading the DB/.env.
// Empty until applyConfigToEnv runs; callers then fall back to no label.
const _sources = new Map();
const SOURCE_LABELS = { db: "Settings/DB", env: ".env", default: "default" };

// Which layer supplied KEY's effective value, or null if unknown (resolver not
// yet run, or KEY is not a managed/imported config var).
export function configSourceOf(key) {
  return _sources.get(key) || null;
}

// Human label for configSourceOf, e.g. "Settings/DB" / ".env" / "default".
export function configSourceLabel(key) {
  const s = _sources.get(key);
  return s ? SOURCE_LABELS[s] : null;
}

// Pure: pick the provenance label for one var from its raw layer presence.
// Mirrors api-config.js: with env-precedence a value present in the environment
// (.env or shell) wins; with db-precedence a DB value wins. Tier-0 vars are
// never injected from the DB, so they're only ever "env" or "default".
function sourceFor({ envPresent, dbSet, tier0, envWins }) {
  if (tier0)   return envPresent ? "env" : "default";
  if (envWins) return envPresent ? "env" : dbSet ? "db" : "default";
  return dbSet ? "db" : envPresent ? "env" : "default";
}

// Resolve the effective precedence: an explicit env var wins (so .env can force
// it), then a value saved in the Settings UI, then the "env" default. Returns
// "db" or "env".
export function resolvePrecedence(settings = {}) {
  const raw =
    process.env[PRECEDENCE_KEY] ??
    settings[configSettingKey(PRECEDENCE_KEY)] ??
    "env";
  return String(raw).trim().toLowerCase() === "db" ? "db" : "env";
}

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

  // In "env" precedence (the default), a var already present in the environment
  // (from .env, loaded by dotenv before us, or the shell) keeps its value — we
  // simply don't inject the DB value over it. DB-only vars (absent from the env)
  // are still injected, so env mode overrides rather than ignores the DB.
  // Pin the resolved precedence onto process.env so every other consumer
  // (api-config.js, etc.) reads the same value, including one set via the UI.
  const precedence = resolvePrecedence(settings);
  process.env[PRECEDENCE_KEY] = precedence;
  const envWins = precedence === "env";
  const isSet = (v) => v != null && String(v).trim() !== "";

  // Snapshot which vars are already in the environment (.env/shell) BEFORE we
  // inject DB values, so provenance can be labeled afterward without confusing
  // an injected DB value for a real env var. Cover the registry plus any
  // config.<KEY> the user adopted from .env (Phase 2b) with no registry entry.
  const candidateKeys = new Set(CONFIG.map((e) => e.key));
  for (const sk of Object.keys(settings)) {
    if (sk.startsWith(PREFIX)) candidateKeys.add(sk.slice(PREFIX.length));
  }
  const envPresent = new Set([...candidateKeys].filter((k) => isSet(process.env[k])));

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

  // Record provenance for every candidate key from the pre-injection snapshot.
  _sources.clear();
  for (const key of candidateKeys) {
    _sources.set(key, sourceFor({
      envPresent: envPresent.has(key),
      dbSet: isSet(settings[configSettingKey(key)]),
      tier0: TIER0.has(key),
      envWins,
    }));
  }

  if (applied.length) {
    logger.info(`[config] applied ${applied.length} setting(s) from DB: ${applied.join(", ")}`);
  }
  return applied;
}
