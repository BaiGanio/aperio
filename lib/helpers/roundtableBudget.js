import os from "os";
import { MODEL_FACTS, ollamaContextWindow } from "../providers/index.js";

const GIB = 1024 ** 3;
const DEFAULT_KV_BYTES_PER_TOKEN = 144 * 1024;
const DEFAULT_RESERVE_FRACTION = 0.20;
const DEFAULT_RESERVE_GB = 8;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function estimateOllamaFootprintGB(model, contextWindow, env = process.env) {
  if (!model) return 0;
  const facts = MODEL_FACTS[String(model)] ?? { sizeGB: 8 };
  const ctx = toNumber(contextWindow) ?? ollamaContextWindow(env);
  const perToken = facts.kvBytesPerToken > 0 ? facts.kvBytesPerToken : DEFAULT_KV_BYTES_PER_TOKEN;
  const weightsGB = facts.sizeGB ?? 8;
  const cacheGB = ctx > 0 ? (ctx * perToken) / GIB : 0;
  return weightsGB + cacheGB + 1;
}

export function shouldEnableRoundtable({
  mainProvider = null,
  primaryConfig = null,
  verifierConfig = null,
  totalRamGB = os.totalmem() / GIB,
  env = process.env,
} = {}) {
  if (!primaryConfig || !verifierConfig) {
    return { enabled: false, reason: "ROUNDTABLE_AGENTS needs two provider:model pairs" };
  }

  const localModels = [];
  if (mainProvider?.name === "ollama") localModels.push(mainProvider.model);
  if (primaryConfig.name === "ollama") localModels.push(primaryConfig.model);
  if (verifierConfig.name === "ollama") localModels.push(verifierConfig.model);

  if (localModels.length <= 1) {
    return { enabled: true, reason: null, footprintGB: 0, budgetGB: totalRamGB };
  }

  const contextWindow = ollamaContextWindow(env);
  const footprintGB = localModels.reduce((sum, model) => sum + estimateOllamaFootprintGB(model, contextWindow, env), 0);
  const reserveGB = Math.max(
    toNumber(env.APERIO_ROUNDTABLE_RESERVE_GB) ?? DEFAULT_RESERVE_GB,
    totalRamGB * (toNumber(env.APERIO_ROUNDTABLE_RESERVE_FRACTION) ?? DEFAULT_RESERVE_FRACTION),
  );
  const budgetGB = Math.max(0, totalRamGB - reserveGB);

  if (footprintGB > budgetGB) {
    return {
      enabled: false,
      reason: `estimated local model footprint ${footprintGB.toFixed(1)} GB exceeds budget ${budgetGB.toFixed(1)} GB`,
      footprintGB,
      budgetGB,
    };
  }

  return { enabled: true, reason: null, footprintGB, budgetGB };
}
