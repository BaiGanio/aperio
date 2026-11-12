// src/context/assemble-turn.js - the stable prefix (plan Appendix A2; L-M03,
// L-M04, L-M22).
//
// The stable prefix is toolsJson + system. It never changes inside a session,
// so llama-server reuses its KV cache on every turn. Recall goes AFTER it, in
// the user message (S2.7 rev 4), and that message is kept in history byte for byte.

/**
 * @param {{ recallBlock: string | null, text: string }} args
 * @returns {string} the user message exactly as sent and as stored in history
 */
export function assembleUserTurn({ recallBlock, text }) {
  return recallBlock ? `${recallBlock}\n\n${text}` : text;
}

/**
 * The part of the request that must be byte-identical on every turn.
 * @param {{ toolsJson: string, system: string }} assembled
 */
export const stablePrefix = ({ toolsJson, system }) => toolsJson + system;
