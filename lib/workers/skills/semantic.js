/**
 * lib/workers/skills/semantic.js — semantic rescue (embedding fallback).
 *
 * Additive tier used ONLY when the deterministic lexical matcher in matching.js
 * returns nothing. Kept separate so the lexical path stays synchronous and
 * deterministic — autotune's score.mjs measures that tier unchanged, and this
 * fallback can only fill a blank turn, never override a keyword match.
 *
 * Per-provider cosine floors come from skills/autotune/calibrate.mjs:
 *   transformers — measured on mxbai-embed-large-v1 (holdout 0.571 → 0.857).
 *   voyage       — NOT yet calibrated; run the harness with a key and set
 *                  APERIO_SKILL_SEMANTIC_FLOOR (voyage-3 has a different scale).
 */

import { createHash } from "crypto";
import logger from "../../helpers/logger.js";

const PROVIDER_FLOORS = { transformers: 0.54, voyage: 0.5 };

export function resolveFloor() {
  const cfg = parseFloat(process.env.APERIO_SKILL_SEMANTIC_FLOOR);
  if (Number.isFinite(cfg)) return cfg;
  const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();
  return PROVIDER_FLOORS[provider] ?? 0.54;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// Skill vectors are embedded once and cached by content hash for the process
// lifetime, so a SKILL.md edit (new hash) re-embeds automatically and a warm
// process pays only the one message embedding per rescued turn.
const _skillVecCache = new Map(); // `${name}:${sha1(text)}` -> number[]

const skillEmbedText = (skill) => `${skill.description ?? ""} ${skill.keywords ?? ""}`.trim();

/**
 * Embedding-similarity fallback for when matchSkills() returns [].
 * Returns up to `limit` skills whose cosine similarity to the message clears the
 * floor, best first — or [] if embeddings are unavailable or nothing qualifies.
 * Never throws: a missing/failing embedder degrades to no match so the (empty)
 * lexical result simply stands.
 *
 * @param {string} userMessage
 * @param {Array}  index                     Result of loadSkillIndex()
 * @param {Object} opts
 * @param {Function} opts.generateEmbedding  async (text, inputType) => number[]|null
 * @param {number} [opts.floor]              cosine floor (default: per-provider)
 * @param {number} [opts.limit=2]
 */
export async function semanticRescue(userMessage, index, { generateEmbedding, floor = resolveFloor(), limit = 2 } = {}) {
  if (!userMessage || !index?.length || typeof generateEmbedding !== "function") return [];
  const candidates = index.filter(s => s.load !== "never");

  let msgVec;
  try { msgVec = await generateEmbedding(userMessage, "query"); }
  catch (err) { logger.warn(`[skills] semantic rescue: message embed failed: ${err.message}`); return []; }
  if (!Array.isArray(msgVec) || !msgVec.length) return [];

  const scored = [];
  for (const skill of candidates) {
    const text = skillEmbedText(skill);
    if (!text) continue;
    const cacheKey = `${skill.name}:${createHash("sha1").update(text).digest("hex")}`;
    let vec = _skillVecCache.get(cacheKey);
    if (!vec) {
      try { vec = await generateEmbedding(text, "document"); }
      catch { vec = null; }
      if (!Array.isArray(vec) || !vec.length) continue;
      _skillVecCache.set(cacheKey, vec);
    }
    const sim = cosine(msgVec, vec);
    if (sim >= floor) scored.push({ skill, sim });
  }

  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, limit).map(x => x.skill);
}
