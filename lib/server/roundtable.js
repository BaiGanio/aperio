// lib/server/roundtable.js — parses ROUNDTABLE_AGENTS/ROUNDTABLE_CHARACTERS,
// gates on shouldEnableRoundtable(), and owns the lazy primary+verifier pair
// used by the Discuss toggle. Compatible agents share one MCP connection so
// each role does not duplicate the same tool server and database runtime.

import logger from "../helpers/logger.js";
import { isLocalProvider } from "../providers/index.js";

export async function bootRoundtable({ root, version, provider, createAgent, mcpConnections = [] }) {
  const { shouldEnableRoundtable } = await import("../helpers/roundtableBudget.js");
  const { buildRoundtableAgentSpec } = await import("../agent/job-spec.js");
  const roundtableAgents = parseRoundtableAgents(process.env.ROUNDTABLE_AGENTS);
  const primaryRtConfig  = roundtableAgents[0] ?? null;
  const verifierConfig   = roundtableAgents[1] ?? null;
  const roundtableCharacters = (process.env.ROUNDTABLE_CHARACTERS || "")
    .split(",").map(s => s.trim()).filter(Boolean);

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
  }
  const roundtableAvailable = roundtableGate.enabled && Boolean(primaryRtConfig && verifierConfig);
  const agentDescriptors = roundtableAvailable
    ? [
        { id: "primary", persona: "primary", character: roundtableCharacters[0] ?? null, ...primaryRtConfig },
        { id: "verifier", persona: "verifier", character: roundtableCharacters[1] ?? null, ...verifierConfig },
      ]
    : [];

  let pair = null;
  let pending = null;
  let closed = false;
  const connectionPool = [...mcpConnections].filter(Boolean);
  const closeAgent = async (agent) => {
    if (typeof agent?.close === "function") await agent.close().catch(() => {});
  };
  const connectionFor = (config) => connectionPool.find(
    connection => connection.providerIsLocal === isLocalProvider(config?.name),
  ) ?? null;

  async function createPair() {
    let primaryRoundtable = null;
    let pooledPrimaryConnection = null;
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
        mcpConnection: connectionFor(primaryRtConfig),
      });
      const primaryConnection = primaryRoundtable.getMcpConnection?.();
      if (primaryConnection && !connectionPool.includes(primaryConnection)) {
        connectionPool.push(primaryConnection);
        pooledPrimaryConnection = primaryConnection;
      }
      if (closed) throw new Error("Round-table manager is closed.");

      const verifier = await createAgent({
        root, version,
        clientName: "aperio-server-rt-verifier",
        spec: buildRoundtableAgentSpec({
          id: "verifier",
          description: "Round-table verifier reviewer",
          providerConfig: verifierConfig,
          persona: "verifier",
          character: roundtableCharacters[1] ?? null,
        }),
        mcpConnection: connectionFor(verifierConfig),
      });
      if (closed) {
        await closeAgent(verifier);
        throw new Error("Round-table manager is closed.");
      }
      logger.info(`🤝 Round-table: primary = ${primaryRoundtable.provider.name} (${primaryRoundtable.provider.model}), verifier = ${verifier.provider.name} (${verifier.provider.model})`);
      return { primaryRoundtable, verifier };
    } catch (err) {
      await closeAgent(primaryRoundtable);
      if (pooledPrimaryConnection) {
        const index = connectionPool.indexOf(pooledPrimaryConnection);
        if (index !== -1) connectionPool.splice(index, 1);
      }
      logger.error(`⚠️  Could not boot round-table agents:`, err.message);
      throw err;
    }
  }

  async function getAgents() {
    if (!roundtableAvailable) throw new Error(roundtableUnavailableReason || "Round-table is unavailable.");
    if (closed) throw new Error("Round-table manager is closed.");
    if (pair) return pair;
    if (!pending) {
      pending = createPair()
        .then(created => (pair = created))
        .finally(() => { pending = null; });
    }
    return pending;
  }

  async function close() {
    closed = true;
    if (pending) await pending.catch(() => {});
    const current = pair;
    pair = null;
    await Promise.allSettled([
      current?.primaryRoundtable?.close?.(),
      current?.verifier?.close?.(),
    ].filter(Boolean));
  }

  return {
    roundtableAvailable,
    roundtableUnavailableReason,
    agentDescriptors,
    get primaryRoundtable() { return pair?.primaryRoundtable ?? null; },
    get verifier() { return pair?.verifier ?? null; },
    getAgents,
    close,
  };
}

export function parseRoundtableAgents(raw) {
  if (!raw || typeof raw !== "string") return [];
  const SUPPORTED = new Set(["anthropic", "deepseek", "gemini", "claude-code", "codex", "llamacpp"]);
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
