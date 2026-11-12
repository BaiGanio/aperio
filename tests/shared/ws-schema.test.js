// T2.11 - the WebSocket message schema (spec S2.11 §2, §3; AP8).
//
// One v1 case is ported: "sends error event when message is not valid JSON"
// (archive/v1-final:tests/unit/handlers/wsHandler.test.js), cut to v2 scope:
// no socket and no handler (S3.0), so it checks parseClientFrame returns a
// bad_json error the server can send back, and does not throw.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLIENT_TYPES, SERVER_TYPES, DEFAULT_MAX_FRAME_BYTES, parseClientFrame, encodeServerFrame,
} from '../../src/shared/ws-schema.js';

const SCHEMA_FILE = new URL('../../src/shared/ws-schema.js', import.meta.url);
const SRC_DIR = new URL('../../src/', import.meta.url).pathname;
const SECRET = 'sk-SECRET-do-not-echo-1234';

/** One valid sample per client type (spec §2.3). */
const CLIENT_SAMPLES = Object.freeze({
  chat: { type: 'chat', turnId: 't-1', text: 'hello' },
  stop: { type: 'stop', turnId: 't-1' },
  memories_list: { type: 'memories_list' },
  memory_update: { type: 'memory_update', id: 'a1b2', content: 'The user likes tea.' },
  memory_delete: { type: 'memory_delete', id: 'a1b2' },
});

/** One valid sample per server type (spec §2.4) — the events src/ emits today. */
const SERVER_SAMPLES = Object.freeze({
  stream_start: { type: 'stream_start', turnId: 't-1' },
  token: { type: 'token', turnId: 't-1', text: 'Hi' },
  reasoning_token: { type: 'reasoning_token', turnId: 't-1', text: 'hmm' },
  tool_start: { type: 'tool_start', turnId: 't-1', id: 'c1', name: 'recall', arguments: { query: 'tea' } },
  tool_result: { type: 'tool_result', turnId: 't-1', id: 'c1', name: 'recall', ok: true },
  tool_args_invalid: { type: 'tool_args_invalid', turnId: 't-1', id: 'c1', name: 'recall', raw: '{', message: 'bad' },
  retract: { type: 'retract', turnId: 't-1', reason: 'text_tool_call' },
  stream_end: { type: 'stream_end', turnId: 't-1', text: 'Hi', toolCalls: [], aborted: false },
  recall_injected: { type: 'recall_injected', turnId: 't-1', rows: [{ id: 'a1', title: 'tea', score: 0.8 }], tokens: 12, ms: 3 },
  recall_skipped: { type: 'recall_skipped', turnId: 't-1', reason: 'no_match' },
  context_trimmed: { type: 'context_trimmed', turnId: 't-1', dropped: 6, pct: 91 },
  turn_complete: { type: 'turn_complete', turnId: 't-1', status: 'completed' },
  error: { type: 'error', turnId: 't-1', code: 'bad_json', message: 'frame is not valid JSON' },
  memories: { type: 'memories', rows: [{ id: 'a1', content: 'The user likes tea.' }] },
});

const frame = (obj) => JSON.stringify(obj);
const wrongKindValue = (kind) => (kind === 'string' ? 42 : 'not-a-' + kind);
/** @returns {any} */
const fail = (r) => { assert.equal(r.ok, false, 'expected a reject'); return r.error; };

describe('type lists', () => {
  test('client types are exactly the 5 core types; tables are frozen', () => {
    assert.deepEqual(Object.keys(CLIENT_TYPES).sort(), Object.keys(CLIENT_SAMPLES).sort());
    assert.ok(Object.isFrozen(CLIENT_TYPES));
    assert.ok(Object.isFrozen(SERVER_TYPES));
    for (const t of Object.values(CLIENT_TYPES)) assert.ok(Object.isFrozen(t));
  });

  test('server types are exactly the turn events + memories', () => {
    assert.deepEqual(Object.keys(SERVER_TYPES).sort(), Object.keys(SERVER_SAMPLES).sort());
  });

  test('every string and array field has a max (bounded input)', () => {
    for (const [type, fields] of Object.entries({ ...CLIENT_TYPES, ...SERVER_TYPES })) {
      for (const [name, spec] of Object.entries(fields)) {
        if (spec.kind === 'string' || spec.kind === 'array') {
          assert.ok(Number.isInteger(spec.max) && spec.max > 0, `${type}.${name} has a max`);
        }
      }
    }
  });

  test('turnId is at most 128 chars wherever it appears', () => {
    for (const fields of Object.values({ ...CLIENT_TYPES, ...SERVER_TYPES })) {
      if (fields.turnId) assert.equal(fields.turnId.max, 128);
    }
  });

  test('default frame cap is 256 KiB', () => {
    assert.equal(DEFAULT_MAX_FRAME_BYTES, 256 * 1024);
  });
});

describe('parseClientFrame: valid frames', () => {
  for (const [type, sample] of Object.entries(CLIENT_SAMPLES)) {
    test(`${type}: a valid sample is ok and msg equals the sample`, () => {
      const r = parseClientFrame(frame(sample));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual({ ...r.msg }, sample);
    });
  }

  test('a Buffer frame is accepted like a string', () => {
    const r = parseClientFrame(Buffer.from(frame(CLIENT_SAMPLES.chat)));
    assert.equal(r.ok, true);
  });

  test('stop without turnId is ok (turnId is optional there)', () => {
    assert.equal(parseClientFrame(frame({ type: 'stop' })).ok, true);
  });
});

describe('parseClientFrame: field checks, driven by CLIENT_TYPES', () => {
  for (const [type, fields] of Object.entries(CLIENT_TYPES)) {
    for (const [name, spec] of Object.entries(fields)) {
      if (spec.required) {
        test(`${type}.${name} missing → missing_field`, () => {
          const rest = { ...CLIENT_SAMPLES[type] };
          delete rest[name];
          const e = fail(parseClientFrame(frame(rest)));
          assert.equal(e.code, 'missing_field');
          assert.equal(e.type, type);
          assert.match(e.message, new RegExp(`${type}\\.${name}`));
        });
      }
      test(`${type}.${name} wrong kind → bad_field`, () => {
        const e = fail(parseClientFrame(frame({ ...CLIENT_SAMPLES[type], [name]: wrongKindValue(spec.kind) })));
        assert.equal(e.code, 'bad_field');
        assert.match(e.message, new RegExp(`${type}\\.${name}`));
      });
      if (spec.kind === 'string' && spec.max < DEFAULT_MAX_FRAME_BYTES - 1024) {
        test(`${type}.${name} over its max (${spec.max}) → bad_field`, () => {
          const e = fail(parseClientFrame(frame({ ...CLIENT_SAMPLES[type], [name]: 'x'.repeat(spec.max + 1) })));
          assert.equal(e.code, 'bad_field');
          assert.match(e.message, new RegExp(`${type}\\.${name}`));
        });
      }
    }
  }

  test('null in a required field → bad_field (null is not a string)', () => {
    assert.equal(fail(parseClientFrame(frame({ type: 'chat', turnId: 't', text: null }))).code, 'bad_field');
  });

  test('a field not in the type → extra_field, naming the field (§4.2)', () => {
    const e = fail(parseClientFrame(frame({ ...CLIENT_SAMPLES.chat, txet: 'typo' })));
    assert.equal(e.code, 'extra_field');
    assert.match(e.message, /chat\.txet/);
  });
});

describe('parseClientFrame: type checks', () => {
  test('unknown type → unknown_type', () => {
    const e = fail(parseClientFrame(frame({ type: 'switch_model', model: 'x' })));
    assert.equal(e.code, 'unknown_type');
  });

  test('inherited names are not types (toString, __proto__, constructor)', () => {
    for (const type of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      assert.equal(fail(parseClientFrame(frame({ type }))).code, 'unknown_type', type);
    }
  });

  test('a server-only type sent by the client → unknown_type', () => {
    assert.equal(fail(parseClientFrame(frame({ type: 'token', text: 'x' }))).code, 'unknown_type');
  });

  test('missing type → unknown_type', () => {
    assert.equal(fail(parseClientFrame(frame({ text: 'hi' }))).code, 'unknown_type');
  });

  test('type not a string → unknown_type', () => {
    assert.equal(fail(parseClientFrame(frame({ type: 7 }))).code, 'unknown_type');
  });
});

describe('parseClientFrame: shape of the frame', () => {
  // Ported from v1 wsHandler.test.js "sends error event when message is not valid JSON".
  test('not valid JSON → bad_json; never throws; the error is a sendable error frame', () => {
    const r = parseClientFrame(Buffer.from('not { json'));
    const e = fail(r);
    assert.equal(e.code, 'bad_json');
    const sent = JSON.parse(encodeServerFrame({ type: 'error', code: e.code, message: e.message }));
    assert.equal(sent.type, 'error');
  });

  test('JSON array, null, number, string, bool → not_object', () => {
    for (const raw of ['[]', '[{"type":"chat"}]', 'null', '42', '"chat"', 'true']) {
      assert.equal(fail(parseClientFrame(raw)).code, 'not_object', raw);
    }
  });

  test('empty frame → bad_json', () => {
    assert.equal(fail(parseClientFrame('')).code, 'bad_json');
  });

  test('a raw value that is not a string or bytes → bad_json, no throw', () => {
    for (const raw of [undefined, null, 42, {}]) {
      assert.doesNotThrow(() => parseClientFrame(/** @type {any} */ (raw)));
      assert.equal(parseClientFrame(/** @type {any} */ (raw)).ok, false);
    }
  });
});

describe('parseClientFrame: frame cap (checked before JSON.parse)', () => {
  test('a frame over the default cap → too_large, JSON.parse not called', (t) => {
    const parse = t.mock.method(JSON, 'parse');
    const big = frame({ type: 'chat', turnId: 't', text: 'x'.repeat(DEFAULT_MAX_FRAME_BYTES) });
    const e = fail(parseClientFrame(big));
    assert.equal(e.code, 'too_large');
    assert.equal(parse.mock.callCount(), 0);
  });

  test('maxBytes option sets the cap (the server passes WS_MAX_FRAME_BYTES)', () => {
    const f = frame(CLIENT_SAMPLES.chat);
    assert.equal(parseClientFrame(f, { maxBytes: f.length }).ok, true);
    assert.equal(fail(parseClientFrame(f, { maxBytes: f.length - 1 })).code, 'too_large');
  });

  test('the cap counts bytes, not chars (multi-byte text)', () => {
    const f = frame({ type: 'chat', turnId: 't', text: 'é'.repeat(100) }); // 'é' = 2 bytes
    assert.equal(fail(parseClientFrame(f, { maxBytes: f.length + 10 })).code, 'too_large');
  });

  test('a Buffer over the cap → too_large', () => {
    assert.equal(fail(parseClientFrame(Buffer.alloc(11, 0x20), { maxBytes: 10 })).code, 'too_large');
  });
});

describe('parseClientFrame: safety', () => {
  test('__proto__ and constructor keys do not reach any prototype', () => {
    const raws = [
      `{"type":"chat","turnId":"t","text":"hi","__proto__":{"polluted":1}}`,
      `{"type":"chat","turnId":"t","text":"hi","constructor":{"prototype":{"polluted":1}}}`,
      `{"__proto__":{"type":"chat","turnId":"t","text":"hi"}}`,
    ];
    for (const raw of raws) {
      const r = parseClientFrame(raw);
      assert.equal(r.ok, false, raw);
      assert.equal(/** @type {any} */ ({}).polluted, undefined);
      assert.equal(/** @type {any} */ (Object.prototype).polluted, undefined);
    }
  });

  test('a valid msg is a plain object with only its own listed fields', () => {
    const r = parseClientFrame(frame(CLIENT_SAMPLES.chat));
    assert.equal(r.ok, true);
    const proto = Object.getPrototypeOf(r.msg);
    assert.ok(proto === Object.prototype || proto === null);
    assert.deepEqual(Object.keys(r.msg).sort(), ['text', 'turnId', 'type']);
  });

  test('the error never holds the raw frame text (it may hold a secret)', () => {
    const bad = [
      `not json ${SECRET}`,
      frame({ type: SECRET }),
      frame({ type: 'chat', turnId: 't', text: 'x', [SECRET]: 1 }),
      frame({ type: 'chat', turnId: SECRET.repeat(10), text: 'x' }),
      frame({ type: 'chat', turnId: 't', text: { secret: SECRET } }),
      frame({ type: 'memory_update', id: 7, content: SECRET }),
      frame({ type: 'chat', turnId: 't', text: SECRET }) + 'x'.repeat(DEFAULT_MAX_FRAME_BYTES),
    ];
    for (const raw of bad) {
      const r = parseClientFrame(raw);
      assert.equal(r.ok, false);
      assert.ok(!JSON.stringify(r).includes(SECRET), `leaked in ${JSON.stringify(r.error)}`);
    }
  });
});

describe('encodeServerFrame', () => {
  for (const [type, sample] of Object.entries(SERVER_SAMPLES)) {
    test(`${type}: round-trips through JSON`, () => {
      const s = encodeServerFrame(sample);
      assert.equal(typeof s, 'string');
      assert.deepEqual(JSON.parse(s), sample);
    });
  }

  test('unknown type throws (a server bug, never a half-valid frame)', () => {
    assert.throws(() => encodeServerFrame({ type: 'nope' }), /nope/);
    assert.throws(() => encodeServerFrame(/** @type {any} */ ({})));
  });

  test('a field of the wrong kind throws, naming it', () => {
    assert.throws(() => encodeServerFrame({ type: 'token', text: 42 }), /token\.text/);
    assert.throws(() => encodeServerFrame({ type: 'tool_result', id: 'c', name: 'n', ok: 'yes' }), /tool_result\.ok/);
  });

  test('a missing required field throws', () => {
    assert.throws(() => encodeServerFrame({ type: 'turn_complete' }), /turn_complete\.status/);
  });

  test('a field not in the type throws', () => {
    assert.throws(() => encodeServerFrame({ type: 'token', text: 'a', extra: 1 }), /token\.extra/);
  });

  test('a client type is not a server type', () => {
    assert.throws(() => encodeServerFrame({ type: 'chat', turnId: 't', text: 'x' }));
  });
});

describe('static contracts', () => {
  test('every event type emitted in src/ has a SERVER_TYPES entry', async () => {
    const files = (await readdir(SRC_DIR, { recursive: true })).filter((f) => f.endsWith('.js'));
    const emitted = new Set();
    for (const f of files) {
      const text = await readFile(join(SRC_DIR, f), 'utf8');
      for (const m of text.matchAll(/emit\(\{\s*type:\s*['"]([a-z_]+)['"]/g)) emitted.add(m[1]);
    }
    assert.ok(emitted.size >= 10, `found ${emitted.size} emitted types — the scan is broken`);
    for (const type of emitted) assert.ok(Object.hasOwn(SERVER_TYPES, type), `${type} has no SERVER_TYPES entry`);
  });

  test('the schema file is browser-safe: no imports at all, no node:, no process', async () => {
    const text = await readFile(SCHEMA_FILE, 'utf8');
    assert.doesNotMatch(text, /^\s*import\s/m);
    assert.doesNotMatch(text, /\bimport\(/);
    assert.doesNotMatch(text, /node:/);
    assert.doesNotMatch(text, /\bprocess\./);
    assert.doesNotMatch(text, /\bBuffer\b/);
    assert.doesNotMatch(text, /\brequire\(/);
  });
});
