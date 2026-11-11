// T2.7 - the trigger (spec S2.7 §2 behaviour 3-6). Pure.
// Only a sentence that starts with the word "Remember" triggers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExplicit } from '../../src/capture/capture-cues.js';

const contents = (text) => findExplicit(text).filter((c) => !c.unresolved).map((c) => c.content);

test('"Remember", "Remember that", "Remember:" trigger; the cue is dropped; any case', () => {
  assert.deepEqual(contents('Remember that my dentist is Dr. Ivanova.'), ['My dentist is Dr. Ivanova.']);
  assert.deepEqual(contents('Remember: the staging port is 8443.'), ['The staging port is 8443.']);
  assert.deepEqual(contents('Remember my car is a blue Skoda.'), ['My car is a blue Skoda.']);
  assert.deepEqual(contents('REMEMBER THAT the wifi is called Orchard.'), ['The wifi is called Orchard.']);
  assert.equal(findExplicit('Remember that my dentist is Dr. Ivanova.')[0].sentence, 'Remember that my dentist is Dr. Ivanova.');
});

test('the ask can sit among other sentences; a dot in 1.23 or a host does not split', () => {
  assert.deepEqual(contents('Hi! Remember that lunch is every second Wednesday. Thanks.'), ['Lunch is every second Wednesday.']);
  assert.deepEqual(contents('Remember: the sprint ends on Tuesdays\nThat is all.'), ['The sprint ends on Tuesdays']);
  assert.deepEqual(contents('Remember that Go on CI is 1.23 at ci.example.net.'), ['Go on CI is 1.23 at ci.example.net.']);
});

test('not a trigger: questions, "remember" not first, other phrases, empty input', () => {
  for (const text of [
    'Do you remember my dentist?', 'Remember when we fixed the Redis storm?', 'Remember that the port is 8443?',
    "I can't remember the port.", 'Remembering the old days is fun.', "Don't forget the review is Friday.",
    'Note that the host is db2.', 'Heads-up: the standup moves to Thursday.', '', null, 42,
  ]) assert.deepEqual(findExplicit(text), [], JSON.stringify(text));
});

test('pointer-only or under 3 words -> unresolved, no content', () => {
  for (const text of ['Remember that.', 'Remember this!', 'Remember it.', 'Remember what I said.', 'Remember that one.', 'Remember that the port.']) {
    const hits = findExplicit(text);
    assert.equal(hits.length, 1, text);
    assert.equal(hits[0].unresolved, true, text);
    assert.equal(hits[0].content, undefined, text);
  }
  assert.deepEqual(contents('Remember that Priya leads Beacon.'), ['Priya leads Beacon.'], '3 words is enough');
});
