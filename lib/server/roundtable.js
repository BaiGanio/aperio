// lib/server/roundtable.js — parses ROUNDTABLE_AGENTS/ROUNDTABLE_CHARACTERS,
// gates on shouldEnableRoundtable(), and boots the primary+verifier agent pair
// used by the Discuss toggle. Returns null agents (with a reason) when the
// feature is unavailable rather than throwing — Discuss is optional.

import logger from "../helpers/logger.js";

export async function bootRoundtable({ root, version, provider, createAgent }) {
  const { shouldEnableRoundtable } = await import("../helpers/roundtableBudget.js");
  const { buildRoundtableAgentSpec } = await import("../agent/job-spec.js");
  const roundtableAgents = parseRoundtableAgents(process.env.ROUNDTABLE_AGENTS);
  const primaryRtConfig  = roundtableAgents[0] ?? null;
  const verifierConfig   = roundtableAgents[1] ?? null;
  const roundtableCharacters = (process.env.ROUNDTABLE_CHARACTERS || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  let primaryRoundtable = null;
  let verifier = null;
  let roundtableUnavailableReason = null;
  const roundtableGate = shouldEnableRoundtable({
    mainProvider: provider,
    primaryConfig: primaryRtConfig,
    verifierConfig,
    env: process.env,
  });
  if (!roundtableGate.enabled) {
    roundtableUnavailableReason = roundtableGate.reason;
    logger.warn(`[roundtable] Discuss unavailable for this session: ${roundtableGate.reason}`);
  } else if (primaryRtConfig && verifierConfig) {
    try {
      primaryRoundtable = await createAgent({
        root, version,
        clientName: "aperio-server-rt-primary",
        spec: buildRoundtableAgentSpec({
          id: "primary",
          description: "Round-table primary answerer",
          providerConfig: primaryRtConfig,
          persona: "primary",
          character: roundtableCharacters[0] ?? null,
        }),
      });
      verifier = await createAgent({
        root, version,
        clientName: "aperio-server-rt-verifier",
        spec: buildRoundtableAgentSpec({
          id: "verifier",
          description: "Round-table verifier reviewer",
          providerConfig: verifierConfig,
          persona: "verifier",
          character: roundtableCharacters[1] ?? null,
        }),
      });
      logger.info(`🤝 Round-table: primary = ${primaryRoundtable.provider.name} (${primaryRoundtable.provider.model}), verifier = ${verifier.provider.name} (${verifier.provider.model})`);
    } catch (err) {
      logger.error(`⚠️  Could not boot round-table agents — Discuss toggle disabled:`, err.message);
      roundtableUnavailableReason = err.message;
      primaryRoundtable = null;
      verifier = null;
    }
  } else if (primaryRtConfig || verifierConfig) {
    logger.warn(`[roundtable] ROUNDTABLE_AGENTS needs TWO "provider:model" pairs — Discuss disabled.`);
  }
  const roundtableAvailable = Boolean(primaryRoundtable && verifier);

  return { primaryRoundtable, verifier, roundtableAvailable, roundtableUnavailableReason };
}

export function parseRoundtableAgents(raw) {
  if (!raw || typeof raw !== "string") return [];
  const SUPPORTED = new Set(["anthropic", "deepseek", "gemini", "claude-code", "codex"]);
  return raw.split(",").map(pair => {
    const trimmed = pair.trim();
    if (!trimmed) return null;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) {
      logger.warn(`[roundtable] ignoring malformed agent spec "${trimmed}" — expected "provider:model"`);
      return null;
    }
    const name = trimmed.slice(0, idx).toLowerCase();
    const model = trimmed.slice(idx + 1).trim();
    if (!SUPPORTED.has(name)) {
      logger.warn(`[roundtable] ignoring unsupported provider "${name}" — supported: ${[...SUPPORTED].join(", ")}`);
      return null;
    }
    if (!model) {
      logger.warn(`[roundtable] ignoring "${trimmed}" — model is empty`);
      return null;
    }
    return { name, model };
  }).filter(Boolean);
}
