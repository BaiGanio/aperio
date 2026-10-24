// tests/lib/privacy/redact.test.js
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { redact, restore, createStreamRestorer } from '../../../lib/privacy/redact.js';

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

  // A model does not have to echo a placeholder back verbatim. It can
  // paraphrase it, change its case, translate the label, drop a guillemet or
  // split the token across a sentence. restore() matches whole tokens only,
  // so the correct outcome for every mangled form is "leave it exactly as the
  // model wrote it" — the user sees a harmless placeholder-ish string rather
  // than PII pasted into the wrong sentence. Issue #531 / T2.5 edge case.
  test('a placeholder the model mangled is left as-is, never mis-restored', () => {
    const { map } = redact('Email: alice@example.com');
    const [token] = [...map.keys()];
    assert.ok(token, 'redact must have minted a token to mangle');

    const mangled = [
      token.toLowerCase(),              // case changed
      token.replace('«', ''),      // opening guillemet dropped
      token.replace('»', ''),      // closing guillemet dropped
      token.replace('_', ' '),          // underscore turned into a space
      `${token.slice(0, -1)}9»`,   // index digit altered
      token.split('').join(' '),        // letter-spaced
    ];

    for (const text of mangled) {
      assert.equal(
        restore(text, map), text,
        `a mangled token must pass through untouched: ${JSON.stringify(text)}`
      );
      assert.ok(
        !restore(text, map).includes('alice@example.com'),
        `a mangled token must never resolve to the real value: ${JSON.stringify(text)}`
      );
    }
  });

  test('an unknown but well-formed placeholder passes through instead of resolving', () => {
    // Two turns can both carry placeholder-shaped text; a token minted by a
    // recall whose map this turn does not hold must stay a placeholder rather
    // than pick up some other entry's value.
    const { map } = redact('Email: alice@example.com');
    const foreign = '«EMAIL_99»';
    assert.equal(restore(foreign, map), foreign);
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

describe('createStreamRestorer — chunked restore for token-streaming', () => {
  test('restores a placeholder delivered whole in one chunk', () => {
    const { text, map } = redact('Email: alice@example.com');
    const restorer = createStreamRestorer(map);
    const out = restorer.push(text) + restorer.flush();
    assert.equal(out, 'Email: alice@example.com');
  });

  test('holds back a placeholder split across two chunks until it completes', () => {
    const { text, map } = redact('Email: alice@example.com');
    const splitAt = text.indexOf('EMAIL'); // lands inside the placeholder
    const chunk1 = text.slice(0, splitAt + 3);
    const chunk2 = text.slice(splitAt + 3);
    const restorer = createStreamRestorer(map);

    const out1 = restorer.push(chunk1);
    assert.ok(!out1.includes('«'), 'the unfinished placeholder prefix must not be released yet');

    const out2 = restorer.push(chunk2);
    const full = out1 + out2 + restorer.flush();
    assert.equal(full, 'Email: alice@example.com');
    assert.ok(!full.includes('«') && !full.includes('»'), 'no bracket ever leaks to the caller');
  });

  test('a placeholder split across three tiny chunks still restores correctly', () => {
    const { text, map } = redact('Contact a@b.com now');
    const restorer = createStreamRestorer(map);
    let out = '';
    for (const ch of text) out += restorer.push(ch); // one character per "token" event
    out += restorer.flush();
    assert.equal(out, 'Contact a@b.com now');
  });

  test('multiple placeholders across chunk boundaries all restore', () => {
    const { text, map } = redact('a@b.com and c@d.org');
    const mid = Math.floor(text.length / 2);
    const restorer = createStreamRestorer(map);
    const out = restorer.push(text.slice(0, mid)) + restorer.push(text.slice(mid)) + restorer.flush();
    assert.equal(out, 'a@b.com and c@d.org');
  });

  test('plain text with no map entries passes straight through', () => {
    const restorer = createStreamRestorer(new Map());
    assert.equal(restorer.push('hello '), 'hello ');
    assert.equal(restorer.push('world'), 'world');
    assert.equal(restorer.flush(), '');
  });

  test('a lone unmatched guillemet is held until flush, not lost', () => {
    // A non-empty map so the fast (no-op) path doesn't short-circuit the
    // buffering — this is what a turn with an active redaction looks like:
    // ordinary French/Bulgarian-style quote punctuation elsewhere in the same
    // reply must still come through, just released at flush() instead of push().
    const map = new Map([['«EMAIL_0»', 'alice@example.com']]);
    const restorer = createStreamRestorer(map);
    assert.equal(restorer.push('quote: «'), 'quote: ');
    assert.equal(restorer.flush(), '«');
  });

  test('flush on an empty buffer returns an empty string', () => {
    const restorer = createStreamRestorer(new Map());
    assert.equal(restorer.flush(), '');
  });
});
