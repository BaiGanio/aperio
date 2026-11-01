// AP4 violation: a sync read on the request path blocks every socket.
import { readFileSync } from 'node:fs';

export function loadPrompt(p) {
  return readFileSync(p, 'utf8');
}
