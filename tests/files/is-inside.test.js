// T2.9 — pure path rules (spec S2.9 §2, §3). No fs: the win32 cases from
// issue #528 run on any host through path.win32 (L-C20: never simulate win32
// against the real fs — #528's simulator wrote 299 backslash files into the repo).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir } from 'node:os';
import { isInside, expandTilde } from '../../src/files/paths.js';

describe('expandTilde (ported v1 PATH-01)', () => {
  const home = homedir();
  test('expands a bare ~', () => assert.equal(expandTilde('~'), home));
  test('expands ~/path', () => assert.equal(expandTilde('~/projects/x'), path.join(home, 'projects/x')));
  test('leaves ~user untouched', () => assert.equal(expandTilde('~bob/secret'), '~bob/secret'));
  test('leaves an embedded ~ untouched', () => assert.equal(expandTilde('/a/~/b'), '/a/~/b'));
  test('leaves absolute paths untouched', () => assert.equal(expandTilde('/etc/passwd'), '/etc/passwd'));
});

describe('isInside — posix', () => {
  const p = path.posix;
  const cases = [
    ['/a', '/a', true, 'the root itself'],
    ['/a/b/c.txt', '/a', true, 'nested file'],
    ['/a/..foo', '/a', true, 'a name that starts with two dots is still inside'],
    ['/a-evil/x', '/a', false, 'sibling that shares the prefix (ported v1)'],
    ['/b', '/a', false, 'other folder'],
    ['/a/../b', '/a', false, '.. escape'],
    ['/', '/a', false, 'parent of the root'],
  ];
  for (const [real, root, want, why] of cases) {
    test(`${why}: ${real} in ${root} → ${want}`, () => assert.equal(isInside(real, root, p), want));
  }
});

describe('isInside — win32 (#528)', () => {
  const w = path.win32;
  const cases = [
    ['C:\\a', 'C:\\a', true, 'the root itself'],
    ['C:\\a\\b', 'C:\\a', true, 'nested'],
    ['c:\\a\\b', 'C:\\a', true, 'drive letter case'],
    ['C:\\A\\b', 'C:\\a', true, 'folder case (NTFS is case-insensitive)'],
    ['C:/a/b', 'C:\\a', true, 'mixed separators'],
    ['C:\\a-evil\\x', 'C:\\a', false, 'sibling prefix'],
    ['D:\\a\\b', 'C:\\a', false, 'other drive'],
    ['\\\\server\\share\\x', 'C:\\a', false, 'UNC path'],
    ['C:\\a\\..\\b', 'C:\\a', false, '.. escape'],
  ];
  for (const [real, root, want, why] of cases) {
    test(`${why}: ${real} in ${root} → ${want}`, () => assert.equal(isInside(real, root, w), want));
  }
});
