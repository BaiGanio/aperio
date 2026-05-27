// envFile.js — generate a valid .env from the setup wizard's choices.
//
// We start from .env.example (so the generated .env keeps all the helpful
// comments + advanced defaults) and overwrite only the keys the wizard owns.
// This sidesteps the hand-editing pitfalls non-coders hit: invalid paths,
// `KEY = value` spacing, typo'd model ids.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV_PATH = resolve(ROOT, ".env");
const EXAMPLE_PATH = resolve(ROOT, ".env.example");

const PROVIDER_KEY_VAR = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const VALID_PROVIDERS = new Set(["anthropic", "deepseek", "gemini", "ollama"]);

// Replace the first uncommented `KEY=...` line, else append the assignment.
function setKey(content, key, value) {
  const safe = /[\s#"'$]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, `${key}=${safe}`);
  return content.replace(/\n*$/, `\n${key}=${safe}\n`);
}

/**
 * Validate wizard input and write .env. Throws on bad input so the API layer
 * can return a 400 rather than persist garbage.
 *
 * @param {{ provider: string, apiKey?: string, model?: string, port?: number }} choices
 */
export function writeEnvFromWizard({ provider, apiKey, model, port }) {
  provider = String(provider || "").toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const isCloud = provider !== "ollama";
  if (isCloud && !apiKey?.trim()) {
    throw new Error(`${provider} requires an API key`);
  }
  if (provider === "ollama" && !model?.trim()) {
    throw new Error("ollama requires a model");
  }

  const base = existsSync(EXAMPLE_PATH)
    ? readFileSync(EXAMPLE_PATH, "utf8")
    : "AI_PROVIDER=ollama\n";

  let out = setKey(base, "AI_PROVIDER", provider);

  if (isCloud) {
    out = setKey(out, PROVIDER_KEY_VAR[provider], apiKey.trim());
    if (model?.trim()) {
      const MODEL_VAR = { anthropic: "ANTHROPIC_MODEL", deepseek: "DEEPSEEK_MODEL", gemini: "GEMINI_MODEL" };
      out = setKey(out, MODEL_VAR[provider], model.trim());
    }
  } else {
    out = setKey(out, "OLLAMA_MODEL", model.trim());
  }

  if (port) out = setKey(out, "PORT", String(port));

  writeFileSync(ENV_PATH, out);
  return ENV_PATH;
}
