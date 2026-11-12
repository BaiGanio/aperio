// AP8 violation: a frame built by hand skips the shared schema.
export function sendToken(ws, text) {
  ws.send(JSON.stringify({ type: 'token', text }));
}
