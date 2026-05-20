#!/usr/bin/env node
/**
 * Run LibreOffice (soffice) with headless plugin set.
 * Usage: node scripts/soffice.js --headless --convert-to pdf input.pptx
 */

import { spawnSync } from 'child_process';

const result = spawnSync(
  'soffice',
  process.argv.slice(2),
  { env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp' }, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
