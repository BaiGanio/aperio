// AP4 green: sync fs is allowed in boot code, which runs once before serving.
import { readFileSync } from 'node:fs';

export function loadPromptAtBoot(p) {
  return readFileSync(p, 'utf8');
}
