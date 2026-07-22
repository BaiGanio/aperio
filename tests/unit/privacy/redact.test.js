// tests/lib/privacy/redact.test.js
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { redact, restore } from '../../../lib/privacy/redact.js';

describe('redact — PII detection', () => {
  test('redacts an email address', () => {
    const { text, map } = redact('Contact me at alice@example.com please.');
    assert.ok(text.includes('\u00ABEMAIL_'));
    assert.ok(!text.includes('alice@example.com'));
    assert.equal(map.size, 1);
  });

  test('redacts multiple emails with distinct placeholders', () => {
    const { text, map } = redact('a@b.com and c@d.org');
    assert.equal(map.size, 2);
    const tokens = [...map.keys()];
    assert.notEqual(tokens[0], tokens[1]);
  });

  test('redacts a phone number', () => {
    const { text, map } = redact('Call +1-555-123-4567 now.');
    assert.ok(text.includes('\u00ABPHONE_'));
    assert.equal(map.size, 1);
  });

  test('redacts a credit card number', () => {
    const { text, map } = redact('Card: 4111-1111-1111-1111');
    assert.ok(text.includes('\u00ABCARD_'));
    assert.equal(map.size, 1);
  });

  test('redacts a credit card without dashes', () => {
    const { text, map } = redact('Card: 4111111111111111');
    assert.ok(text.includes('\u00ABCARD_'));
    assert.equal(map.size, 1);
  });

  test('redacts an IBAN', () => {
    const { text, map } = redact('IBAN: DE89370400440532013000');
    assert.ok(text.includes('\u00ABIBAN_'));
    assert.equal(map.size, 1);
  });

  test('redacts multiple PII types in one string', () => {
    const input = `email: user@example.com, phone: +1-555-000-1111, card: 4111-1111-1111-1111`;
    const { text, map } = redact(input);
    // At least 3 placeholders (EMAIL, PHONE, CARD)
    assert.ok(map.size >= 3);
    // No original PII left in redacted text
    assert.ok(!text.includes('user@example.com'));
    assert.ok(!text.includes('+1-555-000-1111'));
    assert.ok(!text.includes('4111-1111-1111-1111'));
  });
});

describe('redact — non-PII safety', () => {
  test('returns empty map for clean text', () => {
    const { text, map } = redact('Hello, this is a normal message.');
    assert.equal(text, 'Hello, this is a normal message.');
    assert.equal(map.size, 0);
  });

  test('does not false-positive on short number sequences', () => {
    const { text, map } = redact('My PIN is 1234, my age is 38.');
    assert.equal(text, 'My PIN is 1234, my age is 38.');
    assert.equal(map.size, 0);
  });

  test('empty string returns empty string', () => {
    const { text, map } = redact('');
    assert.equal(text, '');
    assert.equal(map.size, 0);
  });

  test('non-string input coerces to string', () => {
    const { text, map } = redact(null);
    assert.equal(text, 'null');
    assert.equal(map.size, 0);
  });
});

describe('restore — placeholder reversal', () => {
  test('restores a single redacted value', () => {
    const input = 'Email: alice@example.com';
    const { text, map } = redact(input);
    const restored = restore(text, map);
    assert.equal(restored, input);
  });

  test('restores multiple values in order', () => {
    const input = `a@b.com, +1-555-000-1111, 4111-1111-1111-1111`;
    const { text, map } = redact(input);
    const restored = restore(text, map);
    assert.equal(restored, input);
  });

  test('round-trip is lossless for non-PII text', () => {
    const input = 'Today was a good day. I read a book and went for a walk.';
    const { text, map } = redact(input);
    assert.equal(text, input);
    const restored = restore(text, map);
    assert.equal(restored, input);
  });

  test('restore with empty map is a no-op', () => {
    const result = restore('hello world', new Map());
    assert.equal(result, 'hello world');
  });

  test('restore with null map returns text unchanged', () => {
    const result = restore('hello world', null);
    assert.equal(result, 'hello world');
  });

  test('non-string input to restore returns empty string', () => {
    const result = restore(null, new Map());
    assert.equal(result, '');
  });
});

describe('redact + restore — combined', () => {
  test('realistic email with all PII types round-trips', () => {
    const input = [
      'Hi Alice,',
      '',
      'My new email is alice@example.com and my phone is +44 20 7946 0958.',
      'Payment: 4111-1111-1111-1111 (exp 12/28). IBAN: GB29NWBK60161331926819.',
      '',
      'Best,',
      'Bob',
    ].join('\n');

    const { text, map } = redact(input);
    // No original PII surfaces
    assert.ok(!text.includes('alice@example.com'));
    assert.ok(!text.includes('+44 20 7946 0958'));
    assert.ok(!text.includes('4111-1111-1111-1111'));
    assert.ok(!text.includes('GB29NWBK60161331926819'));

    const restored = restore(text, map);
    assert.equal(restored, input);
  });

  test('text with no PII is unchanged end-to-end', () => {
    const input = 'This is a completely innocent note about the weather.';
    const { text, map } = redact(input);
    assert.equal(text, input);
    assert.equal(restore(text, map), input);
  });
});
