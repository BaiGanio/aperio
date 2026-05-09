import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import logger from "../helpers/logger.js";

export function getRecommendedModel() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 60) return "deepseek-r1:32";
  if (gb >= 30) return "qwen3:14b";
  if (gb >= 14) return "llama3.1:8b";
  if (gb >= 8) return "qwen2.5:3b";
  return "qwen3:8b";
}

export function resolveProvider() {
  const PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "anthropic";
  const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  let selectedModel = process.env.OLLAMA_MODEL;
  if (!selectedModel) {
    if (process.env.CHECK_RAM === "true") { selectedModel = getRecommendedModel(); logger.info(`CHECK_RAM enabled. Auto-selected: ${selectedModel}`); }
    else { selectedModel = "llama3.1"; }
  }
  if (PROVIDER === "ollama") return { name: "ollama", model: selectedModel, baseURL: `${OLLAMA_BASE_URL}/v1`, ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: parseInt(process.env.OLLAMA_NUM_CTX || "32768", 10) };
  if (PROVIDER === "deepseek") return { name: "deepseek", model: process.env.DEEPSEEK_MODEL, baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY, ollamaBaseURL: null, vision: false, contextWindow: 128000 };
  return { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
}
