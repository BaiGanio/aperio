// src/config/read-config.js - turn (env, DB settings) into one frozen config
// (spec S2.2). Pure: no module state, no logging, never writes process.env.
// A caller reads config by calling a function, never through a module-level
// const (TR15, L-P03).

import { REGISTRY } from './registry.js';

const PRECEDENCE_KEY = 'APERIO_CONFIG_PRECEDENCE';
const BOOL = Object.freeze({ on: true, true: true, 1: true, yes: true, off: false, false: false, 0: false, no: false });

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @param {unknown} v */
const isSet = (v) => v != null && String(v).trim() !== '';

/**
 * Parse one raw string for an entry, or throw. The value is masked for secrets.
 * @param {import('./registry.js').ConfigEntry} e @param {unknown} raw @param {string} layer
 */
function parse(e, raw, layer) {
  const s = String(raw).trim();
  const fail = (want) => {
    const shown = e.secret ? '<hidden>' : JSON.stringify(s);
    throw new ConfigError(`config: ${e.key} from ${layer}: expected ${want}, got ${shown}`);
  };
  switch (e.type) {
    case 'int':
      if (!/^-?\d+$/.test(s)) fail('an integer');
      return Number(s);
    case 'bool': {
      const b = BOOL[/** @type {keyof typeof BOOL} */ (s.toLowerCase())];
      if (b === undefined) fail('on/off');
      return b;
    }
    case 'select':
      if (!e.options?.includes(s)) fail(`one of ${e.options?.join('|')}`);
      return s;
    default:
      return s;
  }
}

/** @param {readonly import('./registry.js').ConfigEntry[]} registry */
const byKey = (registry) => Object.fromEntries(registry.map((e) => [e.key, e]));

/**
 * @param {{ env?: Record<string, string | undefined>, settings?: Record<string, unknown>,
 *           registry?: readonly import('./registry.js').ConfigEntry[] }} input
 * @returns {Readonly<{ values: Readonly<Record<string, unknown>>,
 *   sources: Readonly<Record<string, 'db' | 'env' | 'default'>>, warnings: readonly string[] }>}
 */
export function readConfig({ env = {}, settings = {}, registry = REGISTRY } = {}) {
  const entries = byKey(registry);
  const warnings = Object.keys(settings)
    .filter((k) => !entries[k])
    .map((k) => `config: ignoring unknown key "${k}" in the Settings DB`);

  const precedence = entries[PRECEDENCE_KEY] && isSet(env[PRECEDENCE_KEY])
    ? parse(entries[PRECEDENCE_KEY], env[PRECEDENCE_KEY], 'env')
    : 'db';
  const envFirst = precedence === 'env';

  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Record<string, 'db' | 'env' | 'default'>} */
  const sources = {};
  for (const e of registry) {
    const fromEnv = isSet(env[e.key]);
    const fromDb = e.tier === 1 && isSet(settings[e.key]);
    /** @type {'db' | 'env' | 'default'} */
    let layer = 'default';
    if (fromEnv && (envFirst || !fromDb)) layer = 'env';
    else if (fromDb) layer = 'db';
    const raw = layer === 'env' ? env[e.key] : layer === 'db' ? settings[e.key] : e.default;
    values[e.key] = parse(e, raw, layer);
    sources[e.key] = layer;
  }
  return Object.freeze({
    values: Object.freeze(values),
    sources: Object.freeze(sources),
    warnings: Object.freeze(warnings),
  });
}

/**
 * Check one value before the Settings DB stores it. Returns the trimmed string.
 * @param {string} key @param {unknown} value
 * @param {readonly import('./registry.js').ConfigEntry[]} [registry]
 */
export function validateSetting(key, value, registry = REGISTRY) {
  const e = byKey(registry)[key];
  if (!e) throw new ConfigError(`config: unknown key "${key}"`);
  if (e.tier === 0) throw new ConfigError(`config: ${key} is Tier-0 (env only); the Settings DB cannot set it`);
  parse(e, value, 'settings');
  return String(value).trim();
}

/**
 * .env lines that a differing DB value overrides (db mode only). Tier-0 and
 * unknown keys are skipped. `secret` tells the caller to mask both values.
 * @param {{ fileEnv?: Record<string, string>, settings?: Record<string, unknown>, mode?: string,
 *           registry?: readonly import('./registry.js').ConfigEntry[] }} input
 */
export function shadowedKeys({ fileEnv = {}, settings = {}, mode = 'db', registry = REGISTRY } = {}) {
  if (mode === 'env') return [];
  const entries = byKey(registry);
  const out = [];
  for (const [key, envValue] of Object.entries(fileEnv)) {
    const e = entries[key];
    if (!e || e.tier === 0) continue;
    const dbValue = settings[key];
    if (!isSet(envValue) || !isSet(dbValue) || String(dbValue) === String(envValue)) continue;
    out.push({ key, envValue: String(envValue), dbValue: String(dbValue), secret: e.secret === true });
  }
  return out;
}
