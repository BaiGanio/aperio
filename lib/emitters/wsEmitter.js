
/**
 * WebSocket emitter — used by server.js and the round-table orchestrator.
 *
 * Default form (no opts): unchanged behaviour — JSON-serialize and send.
 * Tagged form (`{ agentId, persona }`): inject those fields into every payload
 * so the UI can route streamed tokens to the correct bubble. Used by the
 * round-table orchestrator to wrap a single ws into two per-agent emitters.
 *
 * Tags do NOT overwrite values the caller already set — that lets the
 * orchestrator emit roundtable-level events (`roundtable_agreed`, etc.) with
 * its own metadata via the same socket.
 *
 * @param {WebSocket} ws
 * @param {{ agentId?: string, persona?: string }} [opts]
 */
export function makeWsEmitter(ws, opts = {}) {
  const { agentId = null, persona = null } = opts;
  const tagged = agentId != null || persona != null;
  return {
    send(obj) {
      const payload = tagged
        ? {
            ...obj,
            agent_id: obj.agent_id ?? agentId,
            persona:  obj.persona  ?? persona,
          }
        : obj;
      ws.send(JSON.stringify(payload));
    },
  };
}