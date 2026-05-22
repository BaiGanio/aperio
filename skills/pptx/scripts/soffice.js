#!/usr/bin/env node
/**
 * Run LibreOffice (soffice) with headless plugin set.
 * Usage: node scripts/soffice.js --headless --convert-to pdf input.pptx
 */

import { spawnSync } from 'child_process';
import { runScript } from './_lib.js';

runScript('soffice', () => {
  if (process.argv.length < 3) {
    throw Object.assign(new Error('Usage: node scripts/soffice.js <soffice args...>'), { code: 'BAD_USAGE' });
  }

  const result = spawnSync(
    'soffice',
    process.argv.slice(2),
    { env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp' }, stdio: 'inherit' }
  );

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw Object.assign(
        new Error('soffice not found on PATH. Install LibreOffice (brew install libreoffice) and retry.'),
        { code: 'SOFFICE_NOT_INSTALLED' }
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw Object.assign(
      new Error(`soffice exited with status ${result.status}`),
      { code: 'SOFFICE_FAILED' }
    );
  }

  console.log(`✅ soffice: completed (${process.argv.slice(2).join(' ')})`);
});
