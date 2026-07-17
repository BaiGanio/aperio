// envFile.js — generate a valid .env from the setup wizard's choices.
//
// The .env is the user's holy grail: the wizard never overwrites an existing
// one. It only CREATES a .env on a true first run, seeded from .env.example (so
// the file keeps its helpful comments), and writes only tier-0 bootstrap values
// (PORT, APERIO_LITE). Tier-1 choices — provider, API key, model — are persisted
// to DB settings instead (lib/helpers/setupPending.js, #252), so secrets never
// land in the file. After that, non-coders change settings via the web UI (→ DB)
// and code users hand-edit .env (set APERIO_CONFIG_PRECEDENCE=env to make the
// file win).
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { isCloudProvider } from "../providers/index.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { isLite, CONFIG } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV_PATH = resolve(ROOT, ".env");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

const VALID_PROVIDERS = new Set(["anthropic", "deepseek", "gemini", "llamacpp", "codex"]);

// Serialize a value for .env: strip newlines/control chars so a value can't
// inject extra `KEY=...` lines, escape backslashes then double-quotes, and
// always wrap in quotes so spaces/`#`/`$` stay literal.
export function envQuote(value) {
  const clean = String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Replace the first uncommented `KEY=...` line, else append the assignment.
// Function replacers keep `$` in the value from being read as a backreference.
export function setKey(content, key, value) {
  const safe = envQuote(value);
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, () => `${key}=${safe}`);
  return content.replace(/\n*$/, () => `\n${key}=${safe}\n`);
}

// Write .env with owner-only perms. writeFileSync's mode is ignored when the
// file already exists, so chmod explicitly to fix perms on an existing .env.
function writeEnv(content) {
  writeFileSync(ENV_PATH, content, { mode: 0o600 });
  try { chmodSync(ENV_PATH, 0o600); } catch { /* best-effort on exotic FS */ }
  return ENV_PATH;
}

/**
 * Validate wizard input and write .env. Throws on bad input so the API layer
 * can return a 400 rather than persist garbage.
 *
 * @param {{ provider: string, apiKey?: string, model?: string, port?: number }} choices
 */
export function writeEnvFromWizard({ provider, apiKey, model, port }) {
  // The .env is the user's holy grail — the app never overwrites one that
  // exists. The wizard only ever CREATES a .env on a genuine first run; if a
  // real one is already present (a code user's hand-edited file, or a setup that
  // lost var/bootstrap.lock), leave it byte-for-byte untouched and reuse it.
  if (existsSync(ENV_PATH)) return ENV_PATH;

  provider = String(provider || "").toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const isCloud = isCloudProvider(provider);
  if (isCloud && provider !== "codex" && !apiKey?.trim()) {
    throw new Error(`${provider} requires an API key`);
  }
  if (!isCloud && !model?.trim()) {
    throw new Error(`${provider} requires a model`);
  }

  // First run only: seed from the .env.example template (keeps the helpful
  // comments) so a non-coder gets a complete, valid file. Tier-1 choices
  // (provider, API key, model) do NOT go into this file — the setup route
  // persists them to DB settings via setupPending.js (#252). Comment out the
  // template's START-HERE assignment lines so a stale seeded value can never
  // shadow (or leak next to) what the user later saves in Settings.
  let out = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, "utf8") : "";
  for (const e of CONFIG.filter((e) => e.envTemplate && e.tier === 1)) {
    out = out.replace(new RegExp(`^(${e.key}=.*)$`, "m"), "# $1");
  }

  if (port) out = setKey(out, "PORT", String(port));

  // Persist the lite profile into the one file every entry point loads, so a
  // later session that skips the launchers (e.g. `npm run chat:local` in the
  // terminal) still runs the same profile as the web UI: db precedence, SQLite
  // pinned before the store opens, lite defaults for the rest.
  if (isLite()) out = setKey(out, "APERIO_LITE", "on");

  return writeEnv(out);
}
