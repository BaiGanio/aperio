#!/usr/bin/env node
// AP9 - two files with the same basename (v1 had `server.js` and
// `lib/server.js`) cost real debugging time, lesson L-C14. Inside the app
// source tree every file name must be unique and descriptive.
//
// Usage: node scripts/guard-duplicate-basenames.mjs [rootDir]

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const SCAN_DIRS = ['src', 'public'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'var', 'tmp', 'fixtures']);

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs']);

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXT.has(path.extname(entry.name))) continue;
    yield full;
  }
}

/**
 * @param {string} root
 * @returns {Promise<string[]>} one message per repeated basename
 */
export async function findDuplicateBasenames(root) {
  /** @type {Map<string, string[]>} */
  const seen = new Map();
  for (const dirName of SCAN_DIRS) {
    for await (const file of walk(path.join(root, dirName))) {
      const key = path.basename(file).toLowerCase();
      const rel = path.relative(root, file);
      const list = seen.get(key);
      if (list) list.push(rel);
      else seen.set(key, [rel]);
    }
  }
  /** @type {string[]} */
  const offenders = [];
  for (const [name, files] of seen) {
    if (files.length < 2) continue;
    offenders.push(`AP9: "${name}" is used ${files.length} times: ${files.sort().join(', ')}`);
  }
  return offenders.sort();
}

async function main() {
  const root = path.resolve(process.argv[2] ?? '.');
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    console.error(`AP9: "${root}" is not a directory.`);
    process.exitCode = 2;
    return;
  }
  const offenders = await findDuplicateBasenames(root);
  if (offenders.length === 0) {
    console.log('AP9 duplicate-basename guard: OK.');
    return;
  }
  for (const line of offenders) console.error(line);
  console.error(
    `AP9 duplicate-basename guard: ${offenders.length} repeated name(s). Give each file a unique, descriptive name.`,
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
