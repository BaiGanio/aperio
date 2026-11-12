// AP8 allowed (browser side): every client frame is built by the shared schema.
import { encodeClientFrame } from '../shared/ws-schema.js';

export function sendStop(ws) {
  ws.send(encodeClientFrame({ type: 'stop' }));
}
