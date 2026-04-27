
/**
 * WebSocket emitter — used by server.js.
 * Serializes every message object to JSON and calls ws.send().
 */
export function makeWsEmitter(ws) {
  return {
    send(obj) { ws.send(JSON.stringify(obj)); },
  };
}