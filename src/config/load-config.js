// src/config/load-config.js - the boot entry for config (spec S2.2).
// Reads .env and process.env at call time, never at import (TR15, L-P03),
// and never writes process.env.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readConfig, shadowedKeys } from './read-config.js';

/** @param {string} file @returns {Promise<Record<string, string>>} */
async function readEnvFile(file) {
  try {
    return /** @type {Record<string, string>} */ (parseEnv(await readFile(file, 'utf8')));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {};
    throw err;
  }
}

/**
 * @param {{ settings?: Record<string, unknown>, envPath?: string,
 *           log?: (msg: string) => void }} [opts]
 */
export async function loadConfig({
  settings = {},
  envPath = path.resolve('.env'),
  log = (msg) => console.warn(msg),
} = {}) {
  const fileEnv = await readEnvFile(envPath);
  const config = readConfig({ env: { ...fileEnv, ...process.env }, settings });
  for (const w of config.warnings) log(w);
  for (const s of shadowedKeys({ fileEnv, settings, mode: config.values.APERIO_CONFIG_PRECEDENCE })) {
    const values = s.secret ? '(values differ; secret not shown)' : `.env=${s.envValue} -> Settings=${s.dbValue}`;
    log(`config: ${s.key} in .env is shadowed by the Settings value ${values}. ` +
      'Delete the stale line, or set APERIO_CONFIG_PRECEDENCE=env to make .env win.');
  }
  return config;
}
