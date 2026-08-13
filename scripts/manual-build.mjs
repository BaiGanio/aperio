#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { buildPreview } from '../manual/build/index.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('--release')) {
  throw new Error('Release mode is intentionally unavailable: F05/F09 and release gates are incomplete. Preview cannot publish.');
}
if (!args.has('--preview')) {
  throw new Error('This checkpoint requires explicit --preview. Release inference and latest are prohibited.');
}
const result = await buildPreview(process.cwd(), { htmlOnly: args.has('--html-only') });
console.log(`NON-RELEASE preview built at ${path.relative(process.cwd(), result.outputRoot)}`);
