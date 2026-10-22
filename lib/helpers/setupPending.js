// setupPending.js — carry the setup wizard's tier-1 choices from
// POST /api/setup/config to the settings store (#252).
//
// The wizard runs before the database exists, but tier-1 config (provider,
// API key, model) belongs in DB settings, not .env (which keeps only tier-0
// bootstrap values like PORT). So the setup route stashes the choices here —
// in memory, never on disk, because the key is a secret — and bootApp flushes
// them into the store right after it opens, before applyConfigToEnv runs.
// stash() also sets process.env so the very first boot resolves the chosen
// provider without waiting for the next restart's resolver pass.

import { configSettingKey } from "../config-resolver.js";
import logger from "./logger.js";

export const PROVIDER_KEY_VAR = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
  codex: "CODEX_API_KEY",
};

export const PROVIDER_MODEL_VAR = {
  anthropic: "ANTHROPIC_MODEL",
  deepseek: "DEEPSEEK_MODEL",
  gemini: "GEMINI_MODEL",
  codex: "CODEX_MODEL",
  llamacpp: "LLAMACPP_MODEL",
};

let pending = null;

// Map the wizard's { provider, apiKey, model } onto env var names, apply them
// to process.env for the current boot, and remember them for flush.
export function stashWizardConfig({ provider, apiKey, model } = {}) {
  const name = String(provider || "").toLowerCase();
  if (!name) return;
  const vars = { AI_PROVIDER: name };
  if (apiKey?.trim() && PROVIDER_KEY_VAR[name]) vars[PROVIDER_KEY_VAR[name]] = apiKey.trim();
  if (model?.trim() && PROVIDER_MODEL_VAR[name]) vars[PROVIDER_MODEL_VAR[name]] = model.trim();
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  pending = vars;
}

// Persist the stashed choices as config.* settings. Keeps the stash on a
// missing/broken store so a later boot attempt can still flush it. Returns the
// applied keys (for logging/tests).
export async function flushWizardConfig(store) {
  if (!pending || !store?.setSetting) return [];
  const applied = [];
  try {
    for (const [key, value] of Object.entries(pending)) {
      await store.setSetting(configSettingKey(key), value);
      applied.push(key);
    }
  } catch (err) {
    logger.warn(`[setup] could not persist wizard config to settings: ${err.message}`);
    return applied;
  }
  pending = null;
  if (applied.length) logger.info(`[setup] wizard config saved to settings: ${applied.join(", ")}`);
  return applied;
}
