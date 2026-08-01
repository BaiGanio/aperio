// lib/pricing.js
//
// Real model pricing from OpenRouter's public model catalog. Fetches only the
// models Aperio actually supports, once per day, cached to var/pricing-cache.json.
// On cache miss or network failure, returns null — never guesses.
//
// OpenRouter API: https://openrouter.ai/api/v1/models (public, no auth, ~300 models)

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { resolve, dirname } from "path";
import logger from "./helpers/logger.js";

const CACHE_FILE = resolve(process.cwd(), "var", "pricing-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Models Aperio uses — OpenRouter ID → internal key
const WATCHED = {
  "deepseek/deepseek-v4-pro":     "deepseek-v4-pro",
  "deepseek/deepseek-v4-flash":   "deepseek-v4-flash",
  "anthropic/claude-opus-4.8":    "claude-opus-4-8",
  "anthropic/claude-sonnet-4.6":  "claude-sonnet-4-6",
  "anthropic/claude-haiku-4.5":   "claude-haiku-4-5",
  "anthropic/claude-sonnet-5":    "claude-sonnet-5",
  "anthropic/claude-fable-5":     "claude-fable-5",
  "google/gemini-2.5-flash":      "gemini-2.5-flash",
  "google/gemini-2.5-pro":        "gemini-2.5-pro",
  "openai/gpt-5.4-mini":          "gpt-5.4-mini",
  "openai/gpt-5.5":               "gpt-5.5",
  "openai/gpt-5.6-sol":           "gpt-5.6-sol",
  "openai/gpt-5.6-luna":          "gpt-5.6-luna",
  "openai/gpt-5.6-terra":         "gpt-5.6-terra",
};

// All possible model name patterns → OpenRouter ID
function buildSearchKey(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SEARCH_MAP = {};
for (const [orId, key] of Object.entries(WATCHED)) {
  // Index by internal key
  SEARCH_MAP[buildSearchKey(key)] = orId;
  // Index by sanitized OR ID
  SEARCH_MAP[buildSearchKey(orId)] = orId;
  // Index by provider/model (e.g. deepseek/deepseek-v4-pro)
  SEARCH_MAP[buildSearchKey(orId.replace(/\//g, ""))] = orId;
}

let _cache = null; // { internalKey: { in, out, contextWindow } }

async function fetchFromOpenRouter() {
  const url = "https://openrouter.ai/api/v1/models";
  logger.info(`[pricing] Fetching model catalog from OpenRouter...`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}: ${res.statusText}`);

  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Unexpected OpenRouter response shape");
  }

  const extracted = {};
  for (const model of json.data) {
    const orId = model.id?.toLowerCase();
    if (!orId) continue;
    const internalKey = WATCHED[orId];
    if (!internalKey) continue;

    const p = model.pricing || {};
    const prompt = parseFloat(p.prompt);
    const completion = parseFloat(p.completion);
    if (isNaN(prompt) || isNaN(completion) || prompt < 0 || completion < 0) continue;

    extracted[internalKey] = {
      in: prompt * 1_000_000,
      out: completion * 1_000_000,
      contextWindow: model.context_length || null,
    };
  }

  const payload = { fetchedAt: Date.now(), models: extracted };
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2));
  _cache = extracted;

  const count = Object.keys(extracted).length;
  const expected = Object.keys(WATCHED).length;
  if (count < expected) {
    logger.warn(`[pricing] OpenRouter cache: ${count}/${expected} models matched (some may not be in catalog)`);
  } else {
    logger.info(`[pricing] OpenRouter cache updated: ${count} models`);
  }
  return extracted;
}

export async function ensurePricingCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      const stat = statSync(CACHE_FILE);
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
        _cache = data.models || {};
        logger.info(`[pricing] Using cached pricing (${Object.keys(_cache).length} models)`);
        return;
      }
    } catch (err) {
      logger.warn(`[pricing] Cache read error: ${err.message}`);
    }
  }
  try {
    await fetchFromOpenRouter();
  } catch (err) {
    logger.warn(`[pricing] Fetch failed: ${err.message}`);
    if (!_cache && existsSync(CACHE_FILE)) {
      try {
        _cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8")).models || {};
        logger.info(`[pricing] Using stale cache`);
      } catch { _cache = {}; }
    } else if (!_cache) {
      _cache = {};
    }
  }
}

export function getPricing(modelName) {
  if (!_cache || !modelName) return null;

  // Try exact alias lookup first
  let orId = SEARCH_MAP[buildSearchKey(modelName)];

  // Try stripping date suffix (e.g. claude-sonnet-5-20251001 → claude-sonnet-5)
  if (!orId) {
    const stripped = modelName.replace(/-\d{8}$/, "").replace(/\.\d{8}$/, "");
    if (stripped !== modelName) {
      orId = SEARCH_MAP[buildSearchKey(stripped)];
    }
  }

  // Try fragment match against all indexed keys
  if (!orId) {
    const searchKey = buildSearchKey(modelName);
    let bestLen = 0;
    for (const [key, id] of Object.entries(SEARCH_MAP)) {
      if (key.includes(searchKey) && key.length > bestLen) {
        bestLen = key.length;
        orId = id;
      }
    }
  }

  if (!orId) return null;

  // Map through WATCHED to get internal key, then pricing
  const internalKey = WATCHED[orId];
  if (!internalKey) return null;
  const entry = _cache[internalKey];
  if (!entry) return null;
  return { in: entry.in, out: entry.out, contextWindow: entry.contextWindow };
}
