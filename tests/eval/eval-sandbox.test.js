// tests/eval/eval-sandbox.test.js — T2.1 isolation (spec S2.1 §2 "Limits",
// L-M16, L-P02): one temp root per run holds the workdir, the scratch DB and
// the port record, and nothing remains after success or after a throw.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { withRunSandbox } from '../../src/eval/sandbox.js';
import { resolveEvalSettings } from '../../src/eval/settings.js';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('run sandbox', () => {
  /** A private parent dir, so the test can prove nothing is left behind in it. */
  async function parent(t) {
    const dir = await mkdtemp(join(tmpdir(), 'aperio-eval-sandbox-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  test('workdir, scratch DB and port record all live under one temp root', async (t) => {
    const tmpBase = await parent(t);
    const settings = resolveEvalSettings({ tmpBase });
    await withRunSandbox(settings, async (box) => {
      assert.ok(box.root.startsWith(tmpBase + sep), 'root is under tmpBase');
      assert.ok(box.workdir.startsWith(box.root + sep), 'workdir under root');
      assert.ok(box.dbPath.startsWith(box.root + sep), 'scratch DB under root');
      assert.ok(box.portFile.startsWith(box.root + sep), 'port record under root');
      assert.ok(await exists(box.workdir), 'workdir exists during the run');
      assert.ok(Number.isInteger(box.port) && box.port > 1024, 'a real port');
      assert.ok(!settings.defaultPorts.includes(box.port), 'never a default port');
      assert.deepEqual(box.allowedPaths, [box.workdir], 'the run gets its own allowed-paths list');
    });
  });

  test('nothing remains after success', async (t) => {
    const tmpBase = await parent(t);
    let root;
    const value = await withRunSandbox(resolveEvalSettings({ tmpBase }), async (box) => {
      root = box.root;
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(await exists(root), false);
    assert.deepEqual(await readdir(tmpBase), []);
  });

  test('nothing remains after a thrown failure, and the error is rethrown', async (t) => {
    const tmpBase = await parent(t);
    let root;
    await assert.rejects(
      withRunSandbox(resolveEvalSettings({ tmpBase }), async (box) => {
        root = box.root;
        throw new Error('target would not start');
      }),
      /target would not start/,
    );
    assert.equal(await exists(root), false);
    assert.deepEqual(await readdir(tmpBase), []);
  });

  test('two runs never share a root or a port', async (t) => {
    const tmpBase = await parent(t);
    const settings = resolveEvalSettings({ tmpBase });
    await withRunSandbox(settings, async (a) => {
      await withRunSandbox(settings, async (b) => {
        assert.notEqual(a.root, b.root);
        assert.notEqual(a.port, b.port);
      });
    });
  });
});
