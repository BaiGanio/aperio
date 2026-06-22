// lib/config-sync.js
//
// Phase 2b — on-demand .env ↔ registry reconciliation (issue #167).
//
// The registry (config.js) is the set of vars that have a typed UI control.
// A user's real .env may carry vars the registry doesn't know about yet. This
// module finds those ("unmanaged"), infers a control for each so the Config
// panel can still render them, and reports dangling DB values ("orphaned").
//
// Side-effect-light and shared by BOTH surfaces:
//   • scripts/config-sync.js  — the CLI report + `--scaffold`
//   • lib/routes/api-config.js — the live "Unmanaged / Imported" section
//
// It NEVER writes .env and NEVER mutates the registry.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import dotenv from "dotenv";
import { CONFIG } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(__dirname, "..", ".env");

// Set by the OS or the app itself — never user config, so never a control.
// Mirrors the exclusions documented at the top of config.js.
export const OS_EXCLUDED = new Set([
  "HOME", "APPDATA", "NODE_ENV", "APERIO_PROC_ROLE", "PWD",
]);

const REGISTRY_KEYS = new Set(CONFIG.map((e) => e.key));
const SECRETY = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)/i;
const BOOLY = new Set(["1", "0", "true", "false", "on", "off", "yes", "no"]);

// Infer a typed control for an unmanaged var from its name + current value.
export function inferType(key, value = "") {
  if (SECRETY.test(key)) return "secret";
  const v = String(value).trim().toLowerCase();
  if (BOOLY.has(v)) return "boolean";
  if (v !== "" && /^-?\d+(\.\d+)?$/.test(v)) return "number";
  return "text";
}

// Parse the real .env file into a flat { KEY: value } map. Missing file → {}.
export function parseEnvFile(path = ENV_PATH) {
  try {
    return dotenv.parse(readFileSync(path));
  } catch {
    return {};
  }
}

// The keys in `envVars` with no registry entry that aren't OS plumbing.
export function unmanagedKeys(envVars) {
  return Object.keys(envVars).filter(
    (k) => !REGISTRY_KEYS.has(k) && !OS_EXCLUDED.has(k),
  );
}

// Synthetic schema fields for the unmanaged vars, so the config panel can render
// an inferred, editable control per var in the advanced "Imported" section.
// Secrets are masked exactly like registry secrets — only `configured`, never
// the value. (The route may overlay a DB-saved value on top of these.)
export function unmanagedFields(envVars) {
  return unmanagedKeys(envVars).map((key) => {
    const raw = String(envVars[key] ?? "");
    const type = inferType(key, raw);
    const base = {
      key, section: "imported", type, tier: 1, editable: true,
      secret: type === "secret", options: null,
      help: "Imported from your .env — no registry entry yet. Saving stores it like any setting; run `npm run config:sync -- --scaffold` to promote it into the registry.",
      // For booleans, seed the ON token from the observed value so a toggle
      // round-trips the user's own convention (true/false vs on/off).
      example: type === "boolean" ? raw : "",
      default: "",
    };
    if (type === "secret") return { ...base, configured: raw.trim() !== "" };
    return { ...base, value: raw, source: "env" };
  });
}

// The synthetic section the unmanaged fields live under.
export const IMPORTED_SECTION = {
  id: "imported",
  title: "Unmanaged / Imported",
  blurb: "Variables found in your .env that have no registry entry yet. Each gets an inferred control; a developer can promote them into the registry with `npm run config:sync -- --scaffold`.",
};

// Full reconciliation report.
//   managed   — .env vars that have a registry control.
//   unmanaged — .env vars with no registry entry (get an inferred control).
//   orphaned  — config.<KEY> values persisted in the DB whose KEY is gone from
//               both the registry and .env (still injected at boot; cleanup
//               candidates). `dbSettingKeys` = the raw setting keys in the store.
export function classify(envVars, dbSettingKeys = []) {
  const envKeys = Object.keys(envVars).filter((k) => !OS_EXCLUDED.has(k));
  const managed = envKeys.filter((k) => REGISTRY_KEYS.has(k));
  const unmanaged = envKeys.filter((k) => !REGISTRY_KEYS.has(k));

  const PREFIX = "config.";
  const orphaned = dbSettingKeys
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .filter((key) => !REGISTRY_KEYS.has(key) && !(key in envVars));

  return { managed, unmanaged, orphaned };
}
