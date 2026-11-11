// src/providers/gguf-cache.js - find the model's weights file in the Hugging
// Face cache (spec S2.5, launcher 1). Async (AP4). No download, ever: a missing
// model is the caller's error, naming `npm run model:fetch` (decision 6).
//
// Ported from v1 lib/helpers/ggufModelFacts.js findCachedGguf at
// archive/v1-final: models--org--repo/refs/main -> snapshots/<rev>, quant by
// substring, side files skipped, largest weights file wins.
// Changed: a quant with no matching file is null, never a silent other quant.

import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** Projector and draft-model files sit next to the weights; they are never the model. */
const SIDE_FILE = /^(?:mmproj|mtp)[-_.]/i;

/**
 * The cache root. Empty = `~/.cache/huggingface/hub`; a leading `~` is expanded.
 * @param {string} llamaCache config LLAMA_CACHE @param {string} home
 */
export function resolveCacheRoot(llamaCache, home) {
  const v = String(llamaCache ?? '').trim();
  if (!v) return join(home, '.cache', 'huggingface', 'hub');
  return v.replace(/^~(?=\/|$)/, home);
}

/** @param {string} p */
const exists = async (p) => {
  try { await stat(p); return true; } catch { return false; } // absent is an answer, not an error
};

/**
 * @param {string} model `org/repo[:quant]` or an absolute path to a .gguf
 * @param {string} cacheRoot
 * @returns {Promise<string | null>} absolute path of the weights file, or null
 */
export async function findCachedGguf(model, cacheRoot) {
  const spec = String(model ?? '').trim();
  if (spec.toLowerCase().endsWith('.gguf') && isAbsolute(spec)) return (await exists(spec)) ? resolve(spec) : null;

  const [repo, quantRaw] = spec.split(':');
  if (!repo.includes('/')) return null;
  const base = join(cacheRoot, `models--${repo.replaceAll('/', '--')}`);
  let rev;
  try {
    rev = (await readFile(join(base, 'refs', 'main'), 'utf8')).trim();
  } catch {
    return null; // not cached, or a broken cache entry: both mean "fetch it"
  }
  if (!rev) return null;
  const snap = join(base, 'snapshots', rev);
  let names;
  try {
    names = (await readdir(snap)).filter((f) => f.toLowerCase().endsWith('.gguf') && !SIDE_FILE.test(f));
  } catch {
    return null; // refs/main names a snapshot that is not there
  }
  const quant = quantRaw?.trim().toLowerCase();
  if (quant) names = names.filter((f) => f.toLowerCase().includes(quant));
  if (!names.length) return null;

  const sized = await Promise.all(names.map(async (f) => ({ f, size: (await stat(join(snap, f))).size })));
  sized.sort((a, b) => b.size - a.size);
  return join(snap, sized[0].f);
}
