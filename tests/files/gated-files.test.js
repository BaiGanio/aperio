// T2.9 — gatedRead / gatedWrite (spec S2.9 §2, §3). Every test runs in a
// mkdtemp sandbox under the OS temp dir; nothing is written in the repo tree.
// Ported v1 cases: tests/integration/routes/paths.test.js (sibling prefix,
// escaping symlink) and tests/integration/mcp/tools/files.test.js (secret
// deny-list, 500 KB cap, not found, not allowed), cut to the gate.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync,
  rmSync, existsSync, unlinkSync, renameSync,
} from 'node:fs';
import { gatedRead, gatedWrite } from '../../src/files/paths.js';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); }); // cleanup

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aperio-gate-')));
  roots.push(root);
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  writeFileSync(join(allowed, 'f.txt'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  return { root, allowed, outside };
}

function quietLog() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level} ${msg}`);
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

const cfg = (allowed, over = {}) => ({
  APERIO_ALLOWED_PATHS: allowed, FILE_READ_MAX_BYTES: 512000, FILE_WRITE_MAX_BYTES: 512000, ...over,
});

/** Symlinks need a privilege on Windows; skip there rather than fail. */
function link(t, target, at) {
  try { symlinkSync(target, at); return true; } catch (err) {
    if (err.code === 'EPERM') { t.skip('symlinks not permitted on this host'); return false; }
    throw err;
  }
}

describe('allow', () => {
  test('reads a normal file inside', async () => {
    const { allowed } = sandbox();
    const r = await gatedRead(join(allowed, 'f.txt'), { config: cfg(allowed), log: quietLog() });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.text, 'inside');
    assert.equal(r.realPath, join(allowed, 'f.txt'));
  });

  test('a relative path joins to the first allowed folder', async () => {
    const { allowed } = sandbox();
    const r = await gatedRead('f.txt', { config: cfg(allowed), log: quietLog() });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.text, 'inside');
  });

  test('create and overwrite inside write the exact bytes', async () => {
    const { allowed } = sandbox();
    const ctx = { config: cfg(allowed), log: quietLog() };
    const c = await gatedWrite(join(allowed, 'new.txt'), 'héllo', { mode: 'create', ...ctx });
    assert.equal(c.ok, true, c.message);
    assert.equal(c.created, true);
    assert.equal(readFileSync(join(allowed, 'new.txt'), 'utf8'), 'héllo');
    const o = await gatedWrite(join(allowed, 'f.txt'), 'x', { mode: 'overwrite', ...ctx });
    assert.equal(o.ok, true, o.message);
    assert.equal(o.created, false);
    assert.equal(readFileSync(join(allowed, 'f.txt'), 'utf8'), 'x');
  });
});

describe('deny', () => {
  test('.. escape', async () => {
    const { allowed } = sandbox();
    const r = await gatedRead(join(allowed, '..', 'outside', 'secret.txt'), { config: cfg(allowed), log: quietLog() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_NOT_ALLOWED');
    assert.equal(r.text, undefined);
  });

  test('absolute path outside, and the message lists the allowed folders', async () => {
    const { allowed, outside } = sandbox();
    const r = await gatedRead(join(outside, 'secret.txt'), { config: cfg(allowed), log: quietLog() });
    assert.equal(r.code, 'E_NOT_ALLOWED');
    assert.match(r.message, new RegExp(allowed.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  });

  test('sibling folder that shares the prefix (ported v1)', async () => {
    const { root, allowed } = sandbox();
    mkdirSync(join(root, 'allowed-evil'));
    writeFileSync(join(root, 'allowed-evil', 'x.txt'), 'evil');
    const r = await gatedRead(join(root, 'allowed-evil', 'x.txt'), { config: cfg(allowed), log: quietLog() });
    assert.equal(r.code, 'E_NOT_ALLOWED');
  });

  test('symlink inside pointing outside (ported v1)', async (t) => {
    const { allowed, outside } = sandbox();
    if (!link(t, join(outside, 'secret.txt'), join(allowed, 'link.txt'))) return;
    const r = await gatedRead(join(allowed, 'link.txt'), { config: cfg(allowed), log: quietLog() });
    assert.equal(r.code, 'E_NOT_ALLOWED');
    assert.equal(r.text, undefined);
  });

  test('symlinked parent folder pointing outside — read and create', async (t) => {
    const { allowed, outside } = sandbox();
    if (!link(t, outside, join(allowed, 'dir'))) return;
    const ctx = { config: cfg(allowed), log: quietLog() };
    assert.equal((await gatedRead(join(allowed, 'dir', 'secret.txt'), ctx)).code, 'E_NOT_ALLOWED');
    const w = await gatedWrite(join(allowed, 'dir', 'new.txt'), 'x', { mode: 'create', ...ctx });
    assert.equal(w.code, 'E_NOT_ALLOWED');
    assert.equal(existsSync(join(outside, 'new.txt')), false);
  });

  test('null byte: E_BAD_PATH and the file is never opened', async () => {
    const { allowed } = sandbox();
    let opened = false;
    const hooks = { beforeOpen: () => { opened = true; }, afterOpen: () => { opened = true; } };
    const r = await gatedRead(join(allowed, 'f.txt\0.png'), { config: cfg(allowed), log: quietLog(), hooks });
    assert.equal(r.code, 'E_BAD_PATH');
    assert.equal(opened, false);
    const w = await gatedWrite(join(allowed, 'a\0.txt'), 'x', { mode: 'create', config: cfg(allowed), log: quietLog(), hooks });
    assert.equal(w.code, 'E_BAD_PATH');
    assert.equal(opened, false);
  });

  test('bad input: empty, non-string, device prefix', async () => {
    const { allowed } = sandbox();
    const ctx = { config: cfg(allowed), log: quietLog() };
    for (const p of ['', 42, null, '\\\\?\\C:\\x.txt', '\\\\.\\PhysicalDrive0']) {
      assert.equal((await gatedRead(p, ctx)).code, 'E_BAD_PATH', String(p));
    }
  });
});

describe('deny swap between check and use (L-C21)', () => {
  // beforeOpen runs after the fast deny passed: the attacker swaps f.txt for a
  // link to outside, so the open lands outside. afterOpen swaps a fresh inside
  // file back, so a path-only re-check would pass. Only the handle proof catches it.
  function swapHooks(allowed, outside, seen) {
    const f = join(allowed, 'f.txt');
    return {
      beforeOpen: () => { unlinkSync(f); symlinkSync(join(outside, 'secret.txt'), f); },
      afterOpen: (fh) => { seen.fh = fh; unlinkSync(f); writeFileSync(join(allowed, 'tmp'), 'inside'); renameSync(join(allowed, 'tmp'), f); },
    };
  }

  test('read: E_SWAPPED, no outside bytes, handle closed', async (t) => {
    const { allowed, outside } = sandbox();
    if (!link(t, join(outside, 'secret.txt'), join(allowed, 'probe'))) return;
    const seen = {};
    const r = await gatedRead(join(allowed, 'f.txt'), { config: cfg(allowed), log: quietLog(), hooks: swapHooks(allowed, outside, seen) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_SWAPPED');
    assert.doesNotMatch(JSON.stringify(r), /OUTSIDE-SECRET/);
    assert.equal(seen.fh.fd, -1, 'handle closed');
  });

  test('overwrite: E_SWAPPED, the outside file is unchanged byte for byte', async (t) => {
    const { allowed, outside } = sandbox();
    if (!link(t, join(outside, 'secret.txt'), join(allowed, 'probe'))) return;
    const before = readFileSync(join(outside, 'secret.txt'));
    const seen = {};
    const w = await gatedWrite(join(allowed, 'f.txt'), 'PWNED', {
      mode: 'overwrite', config: cfg(allowed), log: quietLog(), hooks: swapHooks(allowed, outside, seen),
    });
    assert.equal(w.code, 'E_SWAPPED');
    assert.deepEqual(readFileSync(join(outside, 'secret.txt')), before);
    assert.equal(seen.fh.fd, -1, 'handle closed');
  });
});

describe('secret deny-list (ported v1)', () => {
  for (const name of ['.env', '.env.example', 'id_rsa', 'x.pem']) {
    test(`${name} is refused for read and write`, async () => {
      const { allowed } = sandbox();
      writeFileSync(join(allowed, name), 'KEY=1');
      const ctx = { config: cfg(allowed), log: quietLog() };
      assert.equal((await gatedRead(join(allowed, name), ctx)).code, 'E_SECRET');
      assert.equal((await gatedWrite(join(allowed, name), 'x', { mode: 'overwrite', ...ctx })).code, 'E_SECRET');
      assert.equal(readFileSync(join(allowed, name), 'utf8'), 'KEY=1');
    });
  }

  test('notes.txt linked to .env is refused (real name checked)', async (t) => {
    const { allowed } = sandbox();
    writeFileSync(join(allowed, '.env'), 'KEY=1');
    if (!link(t, join(allowed, '.env'), join(allowed, 'notes.txt'))) return;
    const r = await gatedRead(join(allowed, 'notes.txt'), { config: cfg(allowed), log: quietLog() });
    assert.equal(r.code, 'E_SECRET');
  });
});

describe('limits and file kinds', () => {
  test('read over the cap: E_TOO_LARGE, handle closed', async () => {
    const { allowed } = sandbox();
    writeFileSync(join(allowed, 'big.txt'), 'x'.repeat(11));
    const seen = {};
    const r = await gatedRead(join(allowed, 'big.txt'), {
      config: cfg(allowed, { FILE_READ_MAX_BYTES: 10 }), log: quietLog(), hooks: { afterOpen: (fh) => { seen.fh = fh; } },
    });
    assert.equal(r.code, 'E_TOO_LARGE');
    assert.equal(seen.fh.fd, -1);
  });

  test('read at the cap is fine; the ok path closes the handle too', async () => {
    const { allowed } = sandbox();
    writeFileSync(join(allowed, 'ten.txt'), 'x'.repeat(10));
    const seen = {};
    const r = await gatedRead(join(allowed, 'ten.txt'), {
      config: cfg(allowed, { FILE_READ_MAX_BYTES: 10 }), log: quietLog(), hooks: { afterOpen: (fh) => { seen.fh = fh; } },
    });
    assert.equal(r.ok, true, r.message);
    assert.equal(seen.fh.fd, -1);
  });

  test('write over the cap: E_TOO_LARGE, nothing created', async () => {
    const { allowed } = sandbox();
    const w = await gatedWrite(join(allowed, 'big.txt'), 'x'.repeat(11), {
      mode: 'create', config: cfg(allowed, { FILE_WRITE_MAX_BYTES: 10 }), log: quietLog(),
    });
    assert.equal(w.code, 'E_TOO_LARGE');
    assert.equal(existsSync(join(allowed, 'big.txt')), false);
  });

  test('a folder is E_NOT_FILE', async () => {
    const { allowed } = sandbox();
    mkdirSync(join(allowed, 'sub'));
    assert.equal((await gatedRead(join(allowed, 'sub'), { config: cfg(allowed), log: quietLog() })).code, 'E_NOT_FILE');
  });

  test('a FIFO is E_NOT_FILE and the call returns (no hang)', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const { allowed } = sandbox();
    execFileSync('mkfifo', [join(allowed, 'pipe')]);
    assert.equal((await gatedRead(join(allowed, 'pipe'), { config: cfg(allowed), log: quietLog() })).code, 'E_NOT_FILE');
  });

  test('missing file: E_NOT_FOUND (read and overwrite)', async () => {
    const { allowed } = sandbox();
    const ctx = { config: cfg(allowed), log: quietLog() };
    assert.equal((await gatedRead(join(allowed, 'nope.txt'), ctx)).code, 'E_NOT_FOUND');
    assert.equal((await gatedWrite(join(allowed, 'nope.txt'), 'x', { mode: 'overwrite', ...ctx })).code, 'E_NOT_FOUND');
  });

  test('create: existing file is E_EXISTS and unchanged; missing parent is E_NOT_FOUND and no folder is made', async () => {
    const { allowed } = sandbox();
    const ctx = { config: cfg(allowed), log: quietLog() };
    assert.equal((await gatedWrite(join(allowed, 'f.txt'), 'x', { mode: 'create', ...ctx })).code, 'E_EXISTS');
    assert.equal(readFileSync(join(allowed, 'f.txt'), 'utf8'), 'inside');
    assert.equal((await gatedWrite(join(allowed, 'no', 'dir', 'a.txt'), 'x', { mode: 'create', ...ctx })).code, 'E_NOT_FOUND');
    assert.equal(existsSync(join(allowed, 'no')), false);
  });
});

describe('config is read per call (TR15)', () => {
  test('empty APERIO_ALLOWED_PATHS fails closed', async () => {
    const { allowed } = sandbox();
    const r = await gatedRead(join(allowed, 'f.txt'), { config: cfg(''), log: quietLog() });
    assert.equal(r.code, 'E_NO_ALLOWED_DIRS');
  });

  test('a changed value is used by the next call', async () => {
    const a = sandbox();
    const b = sandbox();
    const file = join(a.allowed, 'f.txt');
    assert.equal((await gatedRead(file, { config: cfg(a.allowed), log: quietLog() })).ok, true);
    assert.equal((await gatedRead(file, { config: cfg(b.allowed), log: quietLog() })).code, 'E_NOT_ALLOWED');
  });

  test('a missing allowed folder is skipped and logged; the next one still works', async () => {
    const { root, allowed } = sandbox();
    const log = quietLog();
    const r = await gatedRead('f.txt', { config: cfg(`${join(root, 'gone')},${allowed}`), log });
    assert.equal(r.ok, true, r.message);
    assert.ok(log.lines.some((l) => l.startsWith('warn') && l.includes('gone')), log.lines.join('\n'));
  });

  test('a deny is logged at warn with the code, never the content', async () => {
    const { allowed, outside } = sandbox();
    const log = quietLog();
    await gatedRead(join(outside, 'secret.txt'), { config: cfg(allowed), log });
    assert.ok(log.lines.some((l) => l.startsWith('warn') && l.includes('E_NOT_ALLOWED')));
    assert.ok(log.lines.every((l) => !l.includes('OUTSIDE-SECRET')));
  });
});
