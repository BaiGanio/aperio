// AP3 green: the tool goes through the file gate.
import { gatedRead } from '../files/paths.js';

export async function readNote(p) {
  return gatedRead(p);
}
