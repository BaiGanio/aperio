// AP8 allowed: every frame is built by the shared schema.
import { encodeServerFrame } from '../shared/ws-schema.js';

export function sendToken(ws, text) {
  ws.send(encodeServerFrame({ type: 'token', text }));
}
