// T2.2 - config registry: precedence, provenance, errors, shadow notice.
//
// Cases ported from v1 (archive/v1-final): the 8-case env-vs-db provenance
// matrix in tests/integration/routes/config-schema.test.js and the E1-E2e
// shadow cases in config-shadow-warning.test.js. The HTTP route, the
// process.env injection and the "unmanaged var" import are out of v2 scope
// (spec S2.2 non-goals), so the cases call the pure functions directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError,
  readConfig,
  shadowedKeys,
  validateSetting,
} from '../../src/config/read-config.js';
import { REGISTRY } from '../../src/config/registry.js';

/** A small stub registry: one key per kind the tests need. */
const STUB = Object.freeze([
  { key: 'APERIO_CONFIG_PRECEDENCE', tier: 0, type: 'select', default: 'db', options: ['db', 'env'], help: '' },
  { key: 'PORT', tier: 0, type: 'int', default: '3000', help: '' },
  { key: 'MODEL', tier: 1, type: 'text', default: 'm-default', help: '' },
  { key: 'CTX', tier: 1, type: 'int', default: '4096', help: '' },
  { key: 'LEVEL', tier: 1, type: 'select', default: 'info', options: ['info', 'debug'], help: '' },
  { key: 'FLAG', tier: 1, type: 'bool', default: 'off', help: '' },
  { key: 'TOKEN', tier: 1, type: 'text', secret: true, default: '', help: '' },
]);

/** @param {Record<string, string>} env @param {Record<string, string>} [settings] */
const read = (env, settings = {}) => readConfig({ env, settings, registry: STUB });

// --- precedence ------------------------------------------------------------

test('db mode: DB beats env beats default', () => {
  const env = { MODEL: 'from-env' };
  const settings = { MODEL: 'from-db' };
  assert.equal(read(env, settings).values.MODEL, 'from-db');
  assert.equal(read(env).values.MODEL, 'from-env');
  assert.equal(read({}).values.MODEL, 'm-default');
});

test('env mode flips DB and env; a DB-only key still applies', () => {
  const env = { APERIO_CONFIG_PRECEDENCE: 'env', MODEL: 'from-env' };
  assert.equal(read(env, { MODEL: 'from-db' }).values.MODEL, 'from-env');
  const dbOnly = read({ APERIO_CONFIG_PRECEDENCE: 'env' }, { MODEL: 'from-db' });
  assert.equal(dbOnly.values.MODEL, 'from-db');
  assert.equal(dbOnly.sources.MODEL, 'db');
});

test('a blank value counts as unset in every layer', () => {
  const c = read({ MODEL: '  ' }, { MODEL: '' });
  assert.equal(c.values.MODEL, 'm-default');
  assert.equal(c.sources.MODEL, 'default');
});

test('Tier-0 key ignores a DB value; source is never db', () => {
  for (const mode of ['db', 'env']) {
    const c = read({ APERIO_CONFIG_PRECEDENCE: mode }, { PORT: '9999' });
    assert.equal(c.values.PORT, 3000);
    assert.equal(c.sources.PORT, 'default');
    const withEnv = read({ APERIO_CONFIG_PRECEDENCE: mode, PORT: '31337' }, { PORT: '9999' });
    assert.equal(withEnv.values.PORT, 31337);
    assert.equal(withEnv.sources.PORT, 'env');
  }
});

test('the precedence switch is env only: a DB value cannot flip it', () => {
  const c = read({ MODEL: 'from-env' }, { APERIO_CONFIG_PRECEDENCE: 'env', MODEL: 'from-db' });
  assert.equal(c.values.APERIO_CONFIG_PRECEDENCE, 'db');
  assert.equal(c.values.MODEL, 'from-db');
});

// --- provenance matrix (ported from v1 config-schema.test.js) -------------

const MATRIX = [
  ['env mode: env set, no DB', 'env', 'from-env', null, 'env'],
  ['env mode: no env, DB set', 'env', null, 'from-db', 'db'],
  ['env mode: neither set', 'env', null, null, 'default'],
  ['db mode: DB set even when env is set', 'db', 'from-env', 'from-db', 'db'],
  ['db mode: no DB, falls through to env', 'db', 'from-env', null, 'env'],
  ['db mode: neither set', 'db', null, null, 'default'],
];
for (const [name, mode, envValue, dbValue, expected] of MATRIX) {
  test(`provenance - ${name} -> ${expected}`, () => {
    const env = { APERIO_CONFIG_PRECEDENCE: mode, ...(envValue ? { MODEL: envValue } : {}) };
    const settings = dbValue ? { MODEL: dbValue } : {};
    assert.equal(read(env, settings).sources.MODEL, expected);
  });
}

test('provenance - secret: env mode with env and DB set -> env', () => {
  const c = read({ APERIO_CONFIG_PRECEDENCE: 'env', TOKEN: 'sk-env' }, { TOKEN: 'sk-db' });
  assert.equal(c.sources.TOKEN, 'env');
});

test('provenance - secret: db mode, DB only -> db', () => {
  assert.equal(read({}, { TOKEN: 'sk-db' }).sources.TOKEN, 'db');
});

// --- types and errors ------------------------------------------------------

test('values are typed: int -> number, bool -> boolean', () => {
  const c = read({ CTX: '8192', FLAG: 'on' });
  assert.equal(c.values.CTX, 8192);
  assert.equal(c.values.FLAG, true);
  assert.equal(read({}).values.FLAG, false);
});

test('the result is frozen', () => {
  const c = read({});
  assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(c.values));
  assert.ok(Object.isFrozen(c.sources));
});

test('a bad int throws ConfigError naming key and layer', () => {
  assert.throws(() => read({ CTX: '12abc' }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /CTX/);
    assert.match(err.message, /env/);
    return true;
  });
  assert.throws(() => read({}, { CTX: '1.5' }), /CTX.*db/);
});

test('a bad select or bool throws ConfigError', () => {
  assert.throws(() => read({ LEVEL: 'loud' }), ConfigError);
  assert.throws(() => read({ FLAG: 'maybe' }), ConfigError);
  assert.throws(() => read({ APERIO_CONFIG_PRECEDENCE: 'ui' }), ConfigError);
});

test('a bad secret value is never printed', () => {
  const stub = [...STUB, { key: 'PIN', tier: 1, type: 'int', secret: true, default: '0', help: '' }];
  assert.throws(
    () => readConfig({ env: { PIN: 'hunter2' }, settings: {}, registry: stub }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /PIN/);
      assert.ok(!err.message.includes('hunter2'), 'secret leaked into the error');
      return true;
    },
  );
});

test('unknown DB key: readConfig ignores it and returns a warning', () => {
  const c = read({}, { NOT_A_KEY: 'x' });
  assert.equal('NOT_A_KEY' in c.values, false);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /NOT_A_KEY/);
});

test('validateSetting: rejects unknown keys, Tier-0 keys and bad values', () => {
  assert.throws(() => validateSetting('NOT_A_KEY', 'x', STUB), ConfigError);
  assert.throws(() => validateSetting('PORT', '9999', STUB), /Tier-0|env only/);
  assert.throws(() => validateSetting('CTX', 'abc', STUB), ConfigError);
  assert.equal(validateSetting('CTX', ' 8192 ', STUB), '8192');
});

// --- shadow notice (ported from v1 config-shadow-warning.test.js) ---------

const shadow = (fileEnv, settings, mode = 'db') =>
  shadowedKeys({ fileEnv, settings, mode, registry: STUB });

test('E1: a .env line shadowed by a differing DB value is reported', () => {
  const out = shadow({ CTX: '768' }, { CTX: '1024' });
  assert.deepEqual(out, [{ key: 'CTX', envValue: '768', dbValue: '1024', secret: false }]);
});

test('E2a: silent when values are equal', () => {
  assert.deepEqual(shadow({ CTX: '1024' }, { CTX: '1024' }), []);
});

test('E2b: silent when the key is only in .env', () => {
  assert.deepEqual(shadow({ CTX: '768' }, {}), []);
});

test('E2c: silent when the key is only in the DB', () => {
  assert.deepEqual(shadow({}, { CTX: '1024' }), []);
});

test('E2d: silent under env mode (the file wins)', () => {
  assert.deepEqual(shadow({ CTX: '768' }, { CTX: '1024' }, 'env'), []);
});

test('E2e: silent for Tier-0 keys', () => {
  assert.deepEqual(shadow({ PORT: '31337' }, { PORT: '9999' }), []);
});

test('secrets are flagged so callers mask both values', () => {
  const [s] = shadow({ TOKEN: 'sk-env' }, { TOKEN: 'sk-db' });
  assert.equal(s.secret, true);
});

// --- the real registry -----------------------------------------------------

test('real registry: ~20 unique keys, valid tiers, defaults parse', () => {
  const keys = REGISTRY.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate key');
  assert.ok(keys.length >= 15 && keys.length <= 30, `got ${keys.length} keys`);
  for (const e of REGISTRY) assert.ok(e.tier === 0 || e.tier === 1, e.key);
  assert.ok(Object.isFrozen(REGISTRY));
  const c = readConfig({ env: {}, settings: {} });
  assert.equal(c.values.APERIO_CONFIG_PRECEDENCE, 'db');
});

test('real registry: security and bootstrap keys are Tier-0 (spec Q1)', () => {
  const tier = Object.fromEntries(REGISTRY.map((e) => [e.key, e.tier]));
  for (const k of ['APERIO_CONFIG_PRECEDENCE', 'PORT', 'HOST', 'SQLITE_PATH', 'APERIO_ALLOWED_PATHS']) {
    assert.equal(tier[k], 0, `${k} must be Tier-0`);
  }
});
