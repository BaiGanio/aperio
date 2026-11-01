import logger from "../helpers/logger.js";
import { inspectCachedModel } from "../helpers/ggufModelFacts.js";
import { resolveModelCacheDir } from "../helpers/modelCache.js";

export const GENERIC_MODEL_FACTS = Object.freeze({
  sizeGB: 8,
  maxContext: 131072,
  kvBytesPerToken: 524288,
});

let catalog = Object.freeze({});
let aliasesLower = new Map();
let parsedOverrides = Object.freeze({});
let parsedOverridesRaw = null;
const inspectedFactsCache = new Map();

function normalizeRow(row) {
  const facts = {
    hf: row.hf,
    sizeGB: Number(row.sizeGB ?? row.size_gb),
    maxContext: Number(row.maxContext ?? row.max_context),
    kvBytesPerToken: Number(row.kvBytesPerToken ?? row.kv_bytes_per_token),
    architecture: row.architecture,
  };
  const activeParams = row.activeParams ?? row.active_params;
  if (activeParams != null) facts.activeParams = Number(activeParams);
  if (row.mmproj != null) facts.mmproj = row.mmproj;
  return [row.alias, Object.freeze(facts)];
}

export function installModelFacts(rows = []) {
  catalog = Object.freeze(Object.fromEntries(rows.map(normalizeRow)));
  aliasesLower = new Map(Object.entries(catalog).map(([alias, facts]) => [alias.toLowerCase(), facts]));
  return catalog;
}

export async function hydrateModelFacts(store) {
  if (!store?.getModelFacts) {
    installModelFacts([]);
    return catalog;
  }
  return installModelFacts(await store.getModelFacts());
}

export function getModelFactsCatalog() {
  return catalog;
}

export function factsForHf(hfRepo) {
  const repo = String(hfRepo ?? "").split(":")[0];
  if (!repo) return null;
  return Object.values(catalog).find(facts => facts.hf.split(":")[0] === repo) ?? null;
}

function parseModelFactsOverrides(env) {
  const raw = env.APERIO_MODEL_FACTS_OVERRIDES || "";
  if (raw === parsedOverridesRaw) return parsedOverrides;
  parsedOverridesRaw = raw;
  if (!raw) {
    parsedOverrides = Object.freeze({});
    return parsedOverrides;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    parsedOverrides = value;
  } catch {
    logger.warn("[providers] APERIO_MODEL_FACTS_OVERRIDES could not be parsed — ignoring. Expected JSON object keyed by HF repo path.");
    parsedOverrides = Object.freeze({});
  }
  return parsedOverrides;
}

export function resolveModelFacts(model, env = process.env) {
  const repo = String(model ?? "").split(":")[0];
  const overrides = parseModelFactsOverrides(env);
  const configured = repo ? overrides[repo] ?? overrides[model] : null;
  if (configured) return configured;

  const cacheRoot = resolveModelCacheDir(env);
  const cacheKey = `${cacheRoot}\u0000${String(model ?? "")}`;
  if (inspectedFactsCache.has(cacheKey)) return inspectedFactsCache.get(cacheKey);
  const inspected = inspectCachedModel(model, cacheRoot);
  if (inspected) {
    inspectedFactsCache.set(cacheKey, inspected);
    return inspected;
  }

  const aliasFacts = catalog[model] ?? aliasesLower.get(String(model ?? "").toLowerCase());
  return factsForHf(model) ?? aliasFacts ?? GENERIC_MODEL_FACTS;
}

export function modelDisplayName(hfRepo) {
  const repo = String(hfRepo ?? "").split(":")[0];
  const entry = Object.entries(catalog).find(([, facts]) => facts.hf.split(":")[0] === repo);
  if (entry) return entry[0];
  return repo.split("/").pop() || repo;
}
