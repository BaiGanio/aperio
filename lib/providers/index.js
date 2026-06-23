import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../helpers/logger.js";

// Pick the most capable local model that comfortably fits the machine's RAM, so
// a non-technical user never has to guess. Tags below are real Ollama pulls — a
// wrong tag means a failed download, which is exactly the frustration we avoid.
//   • qwen2.5:3b — low budget / unknown specs: runs almost anywhere.
//   • gemma4:e4b — most capable model that still fits low hardware.
//   • gemma4:12b / qwen3:30b-a3b — for boxes with real headroom.
// A RAM read of 0 (totalmem unavailable) falls through to the safe small model.
export function getRecommendedModel() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 48) return "qwen3:30b-a3b";
  if (gb >= 24) return "gemma4:12b";
  if (gb >= 8)  return "gemma4:e4b";
  return "qwen2.5:3b";
}

// The app talks to Ollama over the OpenAI-compatible /v1 endpoint, which (unlike
// the native /api/chat) has no way to set num_ctx — so OLLAMA_NUM_CTX is only the
// app's internal assumption for trim/cap math, NOT a window pushed onto the
// server. If it exceeds Ollama's real serving window, capToolResults over-keeps
// and the prompt is silently truncated server-side, leaving the model to answer
// blind. Clamp to Ollama's own OLLAMA_CONTEXT_LENGTH (the server's real window)
// whenever that var is visible to the app, so we never assume more context than
// Ollama actually provides. Setting OLLAMA_CONTEXT_LENGTH on the server (the real
// fix) then aligns both sides automatically.
export function ollamaContextWindow(env = process.env) {
  const assumed = parseInt(env.OLLAMA_NUM_CTX || "32768", 10);
  const real = parseInt(env.OLLAMA_CONTEXT_LENGTH || "0", 10);
  if (real > 0 && assumed > real) {
    logger.warn(`[provider] OLLAMA_NUM_CTX=${assumed} exceeds Ollama's OLLAMA_CONTEXT_LENGTH=${real}; clamping context window to ${real} (the server's real window) to prevent silent prompt truncation`);
    return real;
  }
  return assumed;
}

/**
 * Resolve a provider config.
 *
 * Default: read everything from process.env (preserves prior behaviour).
 * Round-table: pass `{ name, model }` to force a specific provider+model while
 * still pulling credentials/base URLs from env. This is how server.js boots
 * two agents from a single ROUNDTABLE_AGENTS env var.
 *
 * @param {{ name?: string, model?: string }} [overrides]
 */
export function resolveProvider(overrides = {}) {
  const PROVIDER = (overrides.name ?? process.env.AI_PROVIDER)?.toLowerCase() || "anthropic";
  const ANTHROPIC_MODEL = overrides.model || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const selectedModel = overrides.model || process.env.OLLAMA_MODEL || "llama3.1";
  if (PROVIDER === "ollama") return { name: "ollama", model: selectedModel, baseURL: `${OLLAMA_BASE_URL}/v1`, ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: ollamaContextWindow() };
  // deepseek-v4-pro accepts native image_url content (only in user messages);
  // flash and older models are text-only and fall back to the local VLM bridge.
  if (PROVIDER === "deepseek") { const model = overrides.model || process.env.DEEPSEEK_MODEL; return { name: "deepseek", model, baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY, ollamaBaseURL: null, vision: /deepseek-v4-pro/i.test(model || ""), contextWindow: 128000 }; }
  if (PROVIDER === "gemini") { const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); return { name: "gemini", model: overrides.model || process.env.GEMINI_MODEL || "gemini-2.0-flash", client, ollamaBaseURL: null, vision: true, contextWindow: 1000000 }; }
  if (PROVIDER === "claude-code") return { name: "claude-code", model: ANTHROPIC_MODEL, client: null, ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
  return { name: "anthropic", model: ANTHROPIC_MODEL, client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), ollamaBaseURL: OLLAMA_BASE_URL, contextWindow: 200000 };
}
