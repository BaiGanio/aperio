// T3.0 - the browser's half of the shared schema (spec S3.0 §4.1, AP8):
// parseServerFrame checks every inbound frame; encodeClientFrame builds every
// outbound one. Same tables as the server side (CLIENT_TYPES / SERVER_TYPES).
// Mirrors the T2.11 cases for parseClientFrame / encodeServerFrame.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServerFrame, encodeClientFrame, parseClientFrame, encodeServerFrame,
} from '../../src/shared/ws-schema.js';

const SECRET = 'sk-SECRET-do-not-echo-1234';

const SERVER_SAMPLES = Object.freeze({
  stream_start: { type: 'stream_start', turnId: 't-1' },
  token: { type: 'token', turnId: 't-1', text: 'Hi' },
  tool_result: { type: 'tool_result', turnId: 't-1', id: 'c1', name: 'recall', ok: true },
  stream_end: { type: 'stream_end', turnId: 't-1', text: 'Hi', toolCalls: [], aborted: false },
  turn_complete: { type: 'turn_complete', turnId: 't-1', status: 'completed' },
  error: { type: 'error', code: 'busy', message: 'Another turn is running.' },
});

const CLIENT_SAMPLES = Object.freeze({
  chat: { type: 'chat', turnId: 't-1', text: 'hello' },
  stop: { type: 'stop', turnId: 't-1' },
  memories_list: { type: 'memories_list' },
  memory_update: { type: 'memory_update', id: 'a1b2', content: 'The user likes tea.' },
  memory_delete: { type: 'memory_delete', id: 'a1b2' },
});

/** @returns {any} */
const fail = (r) => { assert.equal(r.ok, false, 'expected a reject'); return r.error; };

describe('parseServerFrame', () => {
  for (const [type, sample] of Object.entries(SERVER_SAMPLES)) {
    test(`${type}: a valid frame parses to the same message`, () => {
      const r = parseServerFrame(JSON.stringify(sample));
      assert.equal(r.ok, true);
      assert.deepEqual(r.msg, sample);
    });
  }

  test('what encodeServerFrame builds, parseServerFrame accepts (both sides agree)', () => {
    for (const sample of Object.values(SERVER_SAMPLES)) assert.equal(parseServerFrame(encodeServerFrame(sample)).ok, true);
  });

  test('bad JSON → bad_json; not an object → not_object', () => {
    assert.equal(fail(parseServerFrame('not json')).code, 'bad_json');
    assert.equal(fail(parseServerFrame('[1,2]')).code, 'not_object');
    assert.equal(fail(parseServerFrame('null')).code, 'not_object');
  });

  test('an unknown type and a client type → unknown_type', () => {
    assert.equal(fail(parseServerFrame(JSON.stringify({ type: 'nope' }))).code, 'unknown_type');
    assert.equal(fail(parseServerFrame(JSON.stringify(CLIENT_SAMPLES.chat))).code, 'unknown_type');
    assert.equal(fail(parseServerFrame(JSON.stringify({ type: 'toString' }))).code, 'unknown_type');
    assert.equal(fail(parseServerFrame(JSON.stringify({ type: '__proto__' }))).code, 'unknown_type');
  });

  test('extra, missing and wrong-kind fields are rejected, by field name', () => {
    assert.equal(fail(parseServerFrame(JSON.stringify({ ...SERVER_SAMPLES.token, extra: 1 }))).code, 'extra_field');
    assert.equal(fail(parseServerFrame(JSON.stringify({ type: 'turn_complete' }))).code, 'missing_field');
    const e = fail(parseServerFrame(JSON.stringify({ type: 'tool_result', id: 'c', name: 'n', ok: 'yes' })));
    assert.equal(e.code, 'bad_field');
    assert.match(e.message, /tool_result\.ok/);
  });

  test('never throws, whatever comes in', () => {
    for (const raw of [undefined, null, 42, {}, [], '', '{', '"str"', new Uint8Array([0xff, 0xfe]), JSON.stringify({ type: 1 })]) {
      assert.doesNotThrow(() => parseServerFrame(/** @type {any} */ (raw)));
      assert.equal(parseServerFrame(/** @type {any} */ (raw)).ok, false);
    }
  });

  test('an error never echoes a value from the frame', () => {
    const e = fail(parseServerFrame(JSON.stringify({ type: 'token', text: 1, [SECRET]: SECRET })));
    assert.doesNotMatch(JSON.stringify(e), new RegExp(SECRET));
  });

  test('only the schema fields are kept', () => {
    const r = parseServerFrame(JSON.stringify(SERVER_SAMPLES.turn_complete));
    assert.deepEqual(Object.keys(r.msg).sort(), ['status', 'turnId', 'type']);
  });
});

describe('encodeClientFrame', () => {
  for (const [type, sample] of Object.entries(CLIENT_SAMPLES)) {
    test(`${type}: round-trips, and the server edge accepts it`, () => {
      const s = encodeClientFrame(sample);
      assert.equal(typeof s, 'string');
      assert.deepEqual(JSON.parse(s), sample);
      assert.equal(parseClientFrame(s).ok, true);
    });
  }

  test('an unknown type or a server type throws (a client bug, never sent)', () => {
    assert.throws(() => encodeClientFrame({ type: 'nope' }), /nope/);
    assert.throws(() => encodeClientFrame(SERVER_SAMPLES.token));
    assert.throws(() => encodeClientFrame(/** @type {any} */ ({})));
  });

  test('a missing, extra or wrong-kind field throws, naming it', () => {
    assert.throws(() => encodeClientFrame({ type: 'chat', text: 'x' }), /chat\.turnId/);
    assert.throws(() => encodeClientFrame({ type: 'chat', turnId: 't', text: 'x', extra: 1 }), /chat\.extra/);
    assert.throws(() => encodeClientFrame({ type: 'chat', turnId: 't', text: 42 }), /chat\.text/);
  });
});
