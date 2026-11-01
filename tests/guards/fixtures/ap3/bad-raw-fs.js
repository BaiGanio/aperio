// AP3 violation: a tool importing raw fs instead of the gated helpers.
import fs from 'node:fs';

export async function readNote(p) {
  return fs.promises.readFile(p, 'utf8');
}
