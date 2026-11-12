// T2.7 - the secret check the remember tool runs (spec S2.7 rev 3 §2.3; plan TR17).
//
// Pure. A text that looks like it holds a secret is never saved. The test
// keys below are fakes in the public shapes of each provider.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSecret } from '../../src/tools/secret-scan.js';

describe('hasSecret: true', () => {
  const YES = [
    ['OpenAI-style key', 'my key is sk-proj-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'],
    ['Anthropic-style key', 'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
    ['GitHub token', 'token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 for CI'],
    ['AWS access key id', 'AWS key AKIAIOSFODNN7EXAMPLE for backups'],
    ['PEM header', '-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNz'],
    ['RSA PEM header', '-----BEGIN RSA PRIVATE KEY-----'],
    ['password: value', 'the staging DB password: Hunter2-staging!'],
    ['token: value', 'token: abc123'],
    ['hex run of 32', 'id 7f3e9a1c2b4d6e8f0a1b2c3d4e5f6a7b here'],
    ['a full 40-char git SHA is a hex run too (accepted cost)', 'commit 0810db84a1b2c3d4e5f60718293a4b5c6d7e8f90'],
    ['base64 run of 32+', 'blob QWxhZGRpbjpvcGVuIHNlc2FtZQ0KQWxhZGRpbjpvcGVu'],
  ];
  for (const [name, text] of YES) {
    test(name, () => assert.equal(hasSecret(text), true));
  }
});

describe('hasSecret: false', () => {
  const NO = [
    ['plain fact', 'My dentist is Dr. Ivanova.'],
    ['a port', 'The staging port is 8443.'],
    ['a host name', 'The VPN gateway is vpn2.example.net.'],
    ['a URL with a path', 'The doc is at https://www.notion.so/team/nimbus-architecture-overview'],
    ['a UUID (hex runs split by dashes)', 'Row 123e4567-e89b-12d3-a456-426614174000 is the bad one.'],
    ['a short git SHA', 'The fix is in 0810db84.'],
    ['"password" with no value', 'The password reset is on Mondays.'],
    ['"token" in prose', 'The token budget is 800.'],
    ['a long normal word', 'Supercalifragilisticexpialidocious is long.'],
    ['an invoice number', 'The invoice number starts with INV-2026.'],
  ];
  for (const [name, text] of NO) {
    test(name, () => assert.equal(hasSecret(text), false));
  }
  test('non-text input', () => {
    for (const x of [null, undefined, 42, {}]) assert.equal(hasSecret(x), false);
  });
});
