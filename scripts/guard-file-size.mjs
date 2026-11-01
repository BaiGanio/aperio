#!/usr/bin/env node
// AP7 - god files. A hand-written source file over MAX_LINES must say why,
// with a `// size-reason:` line near the top. Nothing else buys an exemption.
//
// Usage: node scripts/guard-file-size.mjs [rootDir]

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const MAX_LINES = 500;
const HEADER_LINES = 15;
const REASON = /\/\/\s*size-reason:\s*\S/;

const SCAN_DIRS = ['src', 'public', 'scripts', 'eslint-rules', 'tests'];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'var',
  'tmp',
  'docs',
  'trash',
  'migrations',
  'generated',
  'fixtures',
]);

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html']);

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
 * @returns {Promise<string[]>} one message per offending file
 */
export async function findOversizedFiles(root) {
  /** @type {string[]} */
  const offenders = [];
  for (const dirName of SCAN_DIRS) {
    const dir = path.join(root, dirName);
    for await (const file of walk(dir)) {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      if (lines.length <= MAX_LINES) continue;
      const header = lines.slice(0, HEADER_LINES).join('\n');
      if (REASON.test(header)) continue;
      const rel = path.relative(root, file);
      offenders.push(
        `AP7: ${rel} is ${lines.length} lines (limit ${MAX_LINES}) and has no "// size-reason:" header.`,
      );
    }
  }
  return offenders.sort();
}

async function main() {
  const root = path.resolve(process.argv[2] ?? '.');
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) {
    console.error(`AP7: "${root}" is not a directory.`);
    process.exitCode = 2;
    return;
  }
  const offenders = await findOversizedFiles(root);
  if (offenders.length === 0) {
    console.log(`AP7 file-size guard: OK (limit ${MAX_LINES} lines).`);
    return;
  }
  for (const line of offenders) console.error(line);
  console.error(
    `AP7 file-size guard: ${offenders.length} file(s) over the limit. Split by responsibility, or write a "// size-reason:" header.`,
  );
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
