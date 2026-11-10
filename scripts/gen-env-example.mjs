// scripts/gen-env-example.mjs - write .env.example from the config registry.
//
//   node scripts/gen-env-example.mjs                 write .env.example
//   node scripts/gen-env-example.mjs --check         exit 1 if it is stale (CI)
//   node scripts/gen-env-example.mjs --out-dir DIR   use DIR instead of the repo root (tests)
//
// It never writes `.env`. That file belongs to the user.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderEnvExample } from '../src/config/env-example.js';
import { REGISTRY } from '../src/config/registry.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out-dir');
const dir = outIdx === -1 ? path.resolve(import.meta.dirname, '..') : path.resolve(args[outIdx + 1]);
const file = path.join(dir, '.env.example');
const want = renderEnvExample(REGISTRY);

if (args.includes('--check')) {
  let have = null;
  try {
    have = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (have !== want) {
    console.error(`${file} is stale. Run: npm run gen:env`);
    process.exit(1);
  }
  console.log(`${file} is current.`);
} else {
  await writeFile(file, want);
  console.log(`wrote ${file}`);
}
