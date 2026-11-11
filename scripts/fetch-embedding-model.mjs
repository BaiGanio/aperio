#!/usr/bin/env node
// scripts/fetch-embedding-model.mjs - download the local models into their
// caches (spec S2.4 #2, S2.5 launcher 1). This is the only code that
// downloads; at run time neither the embedder nor the launcher touches the
// network.
//
//   npm run model:fetch
//
// 1. EMBEDDING_MODEL -> TRANSFORMERS_CACHE (transformers.js layout).
// 2. LLAMACPP_MODEL (`org/repo:quant`) -> LLAMA_CACHE, in the Hugging Face hub
//    layout llama.cpp uses: blobs/<sha256>, snapshots/<rev>/<file> -> blob,
//    refs/main. Skipped when the launcher already finds the weights file.

import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { env, pipeline } from '@huggingface/transformers';
import { loadConfig } from '../src/config/load-config.js';
import { createEmbedder } from '../src/embeddings/local-embedder.js';
import { findCachedGguf, resolveCacheRoot } from '../src/providers/gguf-cache.js';
import { readGgufHeader } from '../src/providers/gguf-header.js';

const HF = 'https://huggingface.co';
const SIDE_FILE = /^(?:mmproj|mtp)[-_.]/i;

const { values } = await loadConfig({ envPath: fileURLToPath(new URL('../.env', import.meta.url)) });

// --- 1. the embedding model --------------------------------------------------
const model = values.EMBEDDING_MODEL;
const cacheDir = values.TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
console.log(`Fetching ${model} (q8) into ${cacheDir} ...`);
env.allowRemoteModels = true;
env.cacheDir = cacheDir;
const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
await extractor.dispose();
// Prove it loads offline, the way the app loads it.
const embedder = await createEmbedder({ model, cacheDir, threads: values.EMBEDDING_THREADS, log: { warn() {}, info() {} } });
console.log(`Done. ${embedder.sig}`);
await embedder.close();

// --- 2. the llama.cpp model --------------------------------------------------
const llamaModel = values.LLAMACPP_MODEL;
const root = resolveCacheRoot(values.LLAMA_CACHE, homedir());
const cached = await findCachedGguf(llamaModel, root);
if (cached) {
  console.log(`${llamaModel} is already cached: ${cached}`);
} else {
  await fetchGguf(llamaModel, root);
}
const path = await findCachedGguf(llamaModel, root);
if (!path) throw new Error(`${llamaModel}: downloaded, but the launcher cannot find it in ${root}`);
const header = await readGgufHeader(path);
console.log(`Done. ${header.arch}, context ${header.contextLength}: ${path}`);

/** @param {string} url */
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

/** @param {string} spec `org/repo:quant` @param {string} cacheRoot */
async function fetchGguf(spec, cacheRoot) {
  const [repo, quant = ''] = spec.split(':');
  if (!repo.includes('/')) throw new Error(`LLAMACPP_MODEL must be org/repo[:quant] or a .gguf path, got ${spec}`);
  const { sha } = await getJson(`${HF}/api/models/${repo}/revision/main`);
  const tree = await getJson(`${HF}/api/models/${repo}/tree/${sha}`);
  const files = tree.filter((f) => f.type === 'file' && f.path.toLowerCase().endsWith('.gguf') && !f.path.includes('/')
    && !SIDE_FILE.test(f.path) && f.path.toLowerCase().includes(quant.toLowerCase()) && f.lfs?.oid);
  if (!files.length) throw new Error(`${repo} has no .gguf weights file matching "${quant}"`);
  files.sort((a, b) => b.lfs.size - a.lfs.size);
  const file = files[0];

  const base = join(cacheRoot, `models--${repo.replaceAll('/', '--')}`);
  const blob = join(base, 'blobs', file.lfs.oid);
  const snapFile = join(base, 'snapshots', sha, file.path);
  await mkdir(join(base, 'blobs'), { recursive: true });
  await mkdir(join(base, 'snapshots', sha), { recursive: true });
  await mkdir(join(base, 'refs'), { recursive: true });

  const have = await lstat(blob).then((s) => s.size === file.lfs.size, () => false);
  if (!have) {
    const url = `${HF}/${repo}/resolve/${sha}/${file.path}`;
    console.log(`Fetching ${file.path} (${(file.lfs.size / 2 ** 30).toFixed(2)} GiB) into ${base} ...`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
    const part = `${blob}.incomplete`;
    let got = 0;
    let shown = -1;
    const progress = new globalThis.TransformStream({
      transform(chunk, ctrl) {
        got += chunk.byteLength;
        const pct = Math.floor((100 * got) / file.lfs.size);
        if (pct >= shown + 5) { shown = pct; process.stdout.write(`  ${pct}%\r`); }
        ctrl.enqueue(chunk);
      },
    });
    try {
      await streamPipeline(Readable.fromWeb(res.body.pipeThrough(progress)), createWriteStream(part));
    } catch (err) {
      await rm(part, { force: true }); // cleanup: a half file must never look like a model
      throw err;
    }
    if (got !== file.lfs.size) {
      await rm(part, { force: true });
      throw new Error(`${file.path}: got ${got} bytes, expected ${file.lfs.size}`);
    }
    await rename(part, blob);
    console.log('  100%');
  }
  await rm(snapFile, { force: true });
  await symlink(join('..', '..', 'blobs', file.lfs.oid), snapFile);
  await writeFile(join(base, 'refs', 'main'), sha);
}
