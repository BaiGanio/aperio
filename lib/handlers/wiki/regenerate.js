// lib/handlers/wiki/regenerate.js
// Stale-article self-heal. Picks a dedicated, env-configured "refresh provider"
// (see WIKI_REFRESH_PROVIDER in .env.example) and rewrites a stale article in one
// non-tool-use LLM call. Falls back gracefully if not configured.
//
// Why not auto-pick the cheapest provider? Because if the user is on a cloud model
// by choice, silently firing up the local engine is hostile. The refresh provider
// must be opt-in via env, just like ROUNDTABLE_AGENTS.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "../../helpers/logger.js";
import { ensureLlamaCpp } from "../../helpers/startLlamaCpp.js";
import { LLAMACPP_MAIN_ALIAS } from "../../helpers/llamacppAliases.js";
import { getArticle } from "./wikiQueries.js";
import { wikiWriteHandler } from "./wikiHandlers.js";

const SUPPORTED = new Set(["llamacpp", "deepseek", "anthropic", "gemini"]);

// Parse "WIKI_REFRESH_PROVIDER=llamacpp:Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"
// into { name, model } — or null if unset/malformed.
export function parseRefreshProvider(raw) {
  if (!raw || !raw.trim()) return null;
  const [name, ...rest] = raw.trim().split(":");
  const model = rest.join(":").trim();
  if (!name || !model) {
    logger.warn(`[wiki/refresh] WIKI_REFRESH_PROVIDER="${raw}" — expected "provider:model"`);
    return null;
  }
  if (!SUPPORTED.has(name.toLowerCase())) {
    logger.warn(`[wiki/refresh] unsupported refresh provider "${name}" — must be one of ${[...SUPPORTED].join(", ")}`);
    return null;
  }
  return { name: name.toLowerCase(), model };
}

// One-shot text completion. Returns string. Throws on transport/API errors;
// callers log and surface a structured failure.
async function complete({ name, model }, { system, user, maxTokens = 2048 }) {
  if (name === "llamacpp") {
    const base = process.env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080";
    // Route through the resident preset alias when the configured refresh model
    // IS the main model: requesting the raw HF id makes llama.cpp's router load
    // a second, full-context copy (see lib/helpers/completion.js). A genuinely
    // different refresh model is honored as-is — the user opted into a 2nd load.
    const requestModel = model === (process.env.LLAMACPP_MODEL || "") ? LLAMACPP_MAIN_ALIAS : model;
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: requestModel,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: false,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`llama.cpp HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
  if (name === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
    const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: false,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`deepseek HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
  if (name === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model,
      system,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: user }],
    });
    return msg.content?.find(b => b.type === "text")?.text ?? "";
  }
  if (name === "gemini") {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const m = genai.getGenerativeModel({ model, systemInstruction: system });
    const result = await m.generateContent(user);
    return result.response?.text?.() ?? "";
  }
  throw new Error(`unknown provider: ${name}`);
}

const REWRITE_SYSTEM = `You are rewriting a stale wiki article using a fresh set of source memories.

RULES (non-negotiable):
- Output ONLY the markdown body. No preamble, no commentary, no code fences around the whole thing.
- Cite every factual claim with an inline marker of the form [[mem:<uuid>]] using one of the provided memory ids.
- Do NOT invent facts that aren't in the provided memories.
- Keep the structure tight — short sections, no filler.
- Preserve [[other-slug]] sibling links from the prior body where they still make sense.`;

function buildUserPrompt(article, memories) {
  const memBlock = memories.length
    ? memories.map(m => `- id: ${m.id}\n  title: ${m.title}\n  content: ${m.content}`).join("\n\n")
    : "(no memories matched — keep the article minimal and flag the gap.)";
  return [
    `# Article to refresh`,
    `Slug:  ${article.slug}`,
    `Title: ${article.title}`,
    article.summary ? `Summary: ${article.summary}` : null,
    ``,
    `## Prior body (now stale)`,
    article.body_md,
    ``,
    `## Available source memories`,
    memBlock,
    ``,
    `Rewrite the body. Cite every claim as [[mem:<uuid>]] using the ids above.`,
  ].filter(Boolean).join("\n");
}

// Extract every [[mem:uuid]] marker, dedupe.
function extractCitedMemoryIds(body) {
  const ids = new Set();
  const re = /\[\[mem:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/gi;
  let m; while ((m = re.exec(body))) ids.add(m[1].toLowerCase());
  return [...ids];
}

/**
 * Regenerate a stale article in place.
 * Returns { ok: true, revision } on success or { ok: false, reason } on any failure.
 * Never throws — caller can use the return shape to keep serving the stale body.
 */
export async function regenerateArticle(ctx, slug) {
  const t0 = Date.now();
  const log = (level, msg, extra = {}) => logger[level](`[wiki/refresh] ${msg}`, { slug, ...extra });

  const cfg = parseRefreshProvider(process.env.WIKI_REFRESH_PROVIDER);
  if (!cfg) {
    log("warn", "WIKI_REFRESH_PROVIDER not set — refresh disabled");
    return { ok: false, reason: "refresh provider not configured (set WIKI_REFRESH_PROVIDER)" };
  }

  log("info", `starting regen via ${cfg.name}:${cfg.model}`);

  // Step 1: load the article.
  let article;
  try {
    article = await getArticle(ctx.store, slug);
  } catch (err) {
    log("error", `load article failed: ${err.message}`, { stack: err.stack });
    return { ok: false, reason: `load failed: ${err.message}` };
  }
  if (!article) return { ok: false, reason: `article "${slug}" not found` };

  // Step 2: if the provider is the local engine and auto-start is on, ensure it's running.
  if (cfg.name === "llamacpp" && process.env.WIKI_REFRESH_AUTOSTART_LLAMACPP === "true") {
    try { await ensureLlamaCpp(); }
    catch (err) {
      log("error", `ensureLlamaCpp failed: ${err.message}`, { stack: err.stack });
      return { ok: false, reason: `llama.cpp auto-start failed: ${err.message}` };
    }
  }

  // Step 3: gather fresh source memories.
  const recallQuery = [article.title, article.summary].filter(Boolean).join(". ");
  let memories;
  try {
    const queryEmbedding = await ctx.generateEmbedding(recallQuery);
    memories = await ctx.store.recall({
      query: recallQuery,
      queryEmbedding,
      limit: 12,
      mode: queryEmbedding ? "auto" : "fulltext",
    });
    log("info", `recall returned ${memories.length} memories`);
  } catch (err) {
    log("error", `recall failed: ${err.message}`, { stack: err.stack });
    return { ok: false, reason: `recall failed: ${err.message}` };
  }

  if (!memories.length) {
    log("warn", "no memories matched — leaving article stale");
    return { ok: false, reason: "no source memories matched the article topic" };
  }

  // Step 4: call the LLM.
  let body_md;
  try {
    body_md = await complete(cfg, {
      system: REWRITE_SYSTEM,
      user:   buildUserPrompt(article, memories),
      maxTokens: 2048,
    });
    if (!body_md || !body_md.trim()) throw new Error("provider returned empty body");
    log("info", `completion ok (${body_md.length} chars)`);
  } catch (err) {
    log("error", `LLM completion failed: ${err.message}`, { provider: cfg.name, model: cfg.model, stack: err.stack });
    return { ok: false, reason: `LLM completion failed: ${err.message}` };
  }

  // Step 5: extract citations. Refuse to write an article that cites nothing —
  // a zero-citation refresh almost certainly means the model ignored the rules.
  const citedIds = extractCitedMemoryIds(body_md);
  const validIds = new Set(memories.map(m => m.id));
  const grounded = citedIds.filter(id => validIds.has(id));
  if (!grounded.length) {
    log("warn", `regenerated body cites no valid memories — discarding`, {
      citedCount: citedIds.length, validRecallCount: memories.length,
    });
    return { ok: false, reason: "regenerated body had no valid [[mem:uuid]] citations" };
  }
  if (grounded.length < citedIds.length) {
    log("warn", `${citedIds.length - grounded.length} citation(s) referenced ids not in recall set — keeping the rest`);
  }

  // Step 6: write back via the existing handler (this triggers revision archival via the SQL trigger).
  try {
    const result = await wikiWriteHandler(ctx, {
      slug:               article.slug,
      title:              article.title,
      summary:            article.summary,
      body_md,
      tags:               article.tags,
      source_memory_ids:  grounded,
    });
    // wikiWriteHandler returns { content: [{ text }] }; surface its text in logs.
    const text = result?.content?.[0]?.text ?? "";
    log("info", `regen complete in ${Date.now() - t0}ms — ${text}`);
    return { ok: true, citations: grounded.length, ms: Date.now() - t0 };
  } catch (err) {
    log("error", `wiki_write failed during refresh: ${err.message}`, { stack: err.stack });
    return { ok: false, reason: `write failed: ${err.message}` };
  }
}
