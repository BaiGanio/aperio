// src/eval/settings.js — every eval tunable, resolved per call (spec S2.1
// "Limits"; TR15, L-P03). There is no module-level settings object: a caller
// gets a fresh frozen copy, so one run can never leak a value into the next.
// Nothing here reads process.env (AP1); the CLI passes overrides in.

import { tmpdir } from 'node:os';

/** @returns {object} the defaults, built fresh on every call. */
function defaults() {
  return {
    runs: 5,
    forceSingleRun: false,
    k: 5,
    seed: 42,
    temperature: 0,
    maxEmptyRetries: 2,
    turnTimeoutMs: 180_000,
    startTimeoutMs: 300_000,
    maxEventsPerTurn: 2_000,
    modes: ['semantic', 'fulltext', 'auto'],
    // Ports a dev instance is likely to hold. A run never uses one of these.
    defaultPorts: [3000, 8080, 8081, 31337],
    tmpBase: tmpdir(),
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Readonly<ReturnType<typeof defaults>>}
 */
export function resolveEvalSettings(overrides = {}) {
  const base = defaults();
  for (const key of Object.keys(overrides)) {
    if (!(key in base)) throw new Error(`eval settings: unknown key "${key}"`);
  }
  const settings = { ...base, ...overrides };
  if (!Number.isInteger(settings.runs) || settings.runs < 1) {
    throw new Error(`eval settings: runs must be an integer >= 1, got ${settings.runs}`);
  }
  if (settings.runs === 1 && settings.forceSingleRun !== true) {
    throw new Error('eval settings: N = 1 proves nothing on a small model (L-M11). Pass forceSingleRun to allow it.');
  }
  if (!Number.isInteger(settings.k) || settings.k < 1) {
    throw new Error(`eval settings: k must be an integer >= 1, got ${settings.k}`);
  }
  return Object.freeze({ ...settings, modes: Object.freeze([...settings.modes]), defaultPorts: Object.freeze([...settings.defaultPorts]) });
}
