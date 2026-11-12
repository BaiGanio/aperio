// src/context/assemble-turn.js - the stable prefix (plan Appendix A2; L-M03,
// L-M04, L-M22).
//
// The stable prefix is toolsJson + system. It never changes inside a session,
// so llama-server reuses its KV cache on every turn. Since S2.7 rev 3 code
// injects nothing: the user turn is the user's text, kept in history byte for byte.

/**
 * The part of the request that must be byte-identical on every turn.
 * @param {{ toolsJson: string, system: string }} assembled
 */
export const stablePrefix = ({ toolsJson, system }) => toolsJson + system;
