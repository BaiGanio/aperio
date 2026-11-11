// T2.5 - the llama.cpp launcher (spec S2.5, launcher 1-6 + the thread rule).
//
// New tests. v1 tests/integration/helpers/startLlamaCpp.test.js (96 tests) is
// not ported: it covers router presets, VLM, perf profiles and PID adoption,
// all dropped by the spec. Kept from v1 as behaviour: fail closed when the port
// is held by someone else; unlink the log before creating it (v1 NUL-hole bug).
//
// The launcher is driven with a fake child process and a fake fetch, so no real
// server starts here. The live test (provider-live.test.js) starts the real one.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickContext, pickThreads, detectPerfCores, buildServerArgs, resolveBinary, startLlama, LlamaStartError,
} from '../../src/providers/llama-launcher.js';

const { Response } = globalThis; // Node globals the lint config does not list

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-launch-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('pickContext: min(cap, header)', () => {
  test('the smaller of the config cap and the model maximum', () => {
    assert.equal(pickContext({ cap: 32768, headerContext: 131072 }), 32768);
    assert.equal(pickContext({ cap: 32768, headerContext: 8192 }), 8192);
  });
  test('no header value -> the cap', () => {
    assert.equal(pickContext({ cap: 16384, headerContext: null }), 16384);
  });
});

describe('pickThreads: llama.cpp and the embedder must not fight for cores', () => {
  test('auto (0) = performance cores minus embedder threads', () => {
    assert.equal(pickThreads({ configured: 0, perfCores: 8, embeddingThreads: 2 }), 6);
  });
  test('never below 1', () => {
    assert.equal(pickThreads({ configured: 0, perfCores: 2, embeddingThreads: 2 }), 1);
    assert.equal(pickThreads({ configured: 0, perfCores: 1, embeddingThreads: 4 }), 1);
  });
  test('a configured value wins', () => {
    assert.equal(pickThreads({ configured: 4, perfCores: 8, embeddingThreads: 2 }), 4);
  });
});

describe('detectPerfCores', () => {
  test('macOS: performance cores from sysctl hw.perflevel0.physicalcpu', async () => {
    const run = mock.fn(async () => '8\n');
    assert.equal(await detectPerfCores({ platform: 'darwin', run, availableParallelism: () => 10 }), 8);
    assert.deepEqual(run.mock.calls[0].arguments, ['sysctl', ['-n', 'hw.perflevel0.physicalcpu']]);
  });
  test('macOS without perflevels (or bad output) -> availableParallelism', async () => {
    assert.equal(await detectPerfCores({ platform: 'darwin', run: async () => { throw new Error('unknown oid'); }, availableParallelism: () => 4 }), 4);
    assert.equal(await detectPerfCores({ platform: 'darwin', run: async () => 'garbage', availableParallelism: () => 4 }), 4);
  });
  test('other platforms -> availableParallelism, sysctl not called', async () => {
    const run = mock.fn(async () => '8');
    assert.equal(await detectPerfCores({ platform: 'linux', run, availableParallelism: () => 12 }), 12);
    assert.equal(run.mock.calls.length, 0);
  });
});

describe('buildServerArgs', () => {
  test('one model, jinja, one slot, sized context, threads, localhost only', () => {
    assert.deepEqual(buildServerArgs({ ggufPath: '/m/x.gguf', ctx: 16384, threads: 6, port: 18432 }), [
      '-m', '/m/x.gguf', '--jinja', '--parallel', '1', '-c', '16384', '-t', '6', '-tb', '6', '--host', '127.0.0.1', '--port', '18432',
    ]);
  });
});

describe('resolveBinary', () => {
  test('the vendor dir wins when it holds an executable llama-server', () => withTemp(async (dir) => {
    const bin = join(dir, 'llama-server');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
    assert.equal(await resolveBinary({ vendorDir: dir }), bin);
  }));
  test('otherwise the bare name, so spawn looks it up on PATH', () => withTemp(async (dir) => {
    assert.equal(await resolveBinary({ vendorDir: join(dir, 'missing') }), 'llama-server');
  }));
});

// --- startLlama with a fake child + fake server ------------------------------

class FakeChild extends EventEmitter {
  constructor({ exitOn = ['SIGTERM', 'SIGKILL'] } = {}) {
    super();
    this.pid = 4242;
    this.signals = [];
    this.exitOn = exitOn;
    this.exitCode = null;
  }
  kill(sig = 'SIGTERM') {
    this.signals.push(sig);
    if (this.exitOn.includes(sig)) setImmediate(() => { this.exitCode = 0; this.emit('exit', null, sig); });
    return true;
  }
}

/** A fake llama-server: /health is down until `upAfter` polls after spawn; /props reports nCtx. */
function fakeServer({ busyBeforeSpawn = false, upAfter = 2, nCtx = 16384, never = false } = {}) {
  const s = { spawned: false, polls: 0, calls: [] };
  s.fetch = async (url) => {
    s.calls.push(String(url));
    if (String(url).endsWith('/health')) {
      if (busyBeforeSpawn) return new Response('{"status":"ok"}', { status: 200 });
      if (!s.spawned || never) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      s.polls++;
      if (s.polls < upAfter) return new Response('{"error":"loading"}', { status: 503 });
      return new Response('{"status":"ok"}', { status: 200 });
    }
    if (String(url).endsWith('/props')) return Response.json({ default_generation_settings: { n_ctx: nCtx } });
    throw new Error(`unexpected url ${url}`);
  };
  return s;
}

const CONFIG = {
  LLAMACPP_MODEL: 'org/m-GGUF:Q4_K_M', LLAMACPP_PORT: 18432, LLAMACPP_SERVE_CTX: 16384, LLAMACPP_THREADS: 0,
  LLAMACPP_START_TIMEOUT_MS: 2000, EMBEDDING_THREADS: 2, LLAMA_CACHE: '', LLAMACPP_VENDOR_DIR: '/nonexistent/vendor',
};

function deps(server, root, over = {}) {
  const child = over.child ?? new FakeChild();
  const spawn = mock.fn(() => { server.spawned = true; return child; });
  return {
    child,
    spawn,
    d: {
      spawn, fetch: server.fetch,
      findGguf: async () => '/models/m-Q4_K_M.gguf',
      readHeader: async () => ({ arch: 'qwen35', contextLength: 262144, blockCount: 33, chatTemplate: '{% if tools %}x{% endif %}' }),
      perfCores: async () => 8,
      logPath: join(root, 'logs', 'llama-server.log'),
      pollMs: 5, stopGraceMs: 50,
      log: { error: mock.fn(), warn: mock.fn(), info: mock.fn() },
      ...over.d,
    },
  };
}

describe('startLlama', () => {
  test('starts, waits for health, reads the served n_ctx from /props', () => withTemp(async (root) => {
    const server = fakeServer({ nCtx: 16384 });
    const { d, spawn } = deps(server, root);
    const llama = await startLlama({ config: CONFIG, deps: d });
    try {
      assert.equal(llama.baseURL, 'http://127.0.0.1:18432');
      assert.equal(llama.servedCtx, 16384);
      assert.equal(llama.ctx, 16384, 'min(cap 16384, header 262144)');
      assert.equal(llama.threads, 6, '8 performance cores - 2 embedder threads');
      assert.deepEqual(llama.capabilities, { tools: true, thinking: false });
      const [cmd, args, opts] = spawn.mock.calls[0].arguments;
      assert.equal(cmd, 'llama-server');
      assert.deepEqual(args, buildServerArgs({ ggufPath: '/models/m-Q4_K_M.gguf', ctx: 16384, threads: 6, port: 18432 }));
      assert.notEqual(opts.detached, true, 'the app owns the child; it dies with us');
      assert.ok(server.calls.some((u) => u.endsWith('/props')));
    } finally { await llama.stop(); }
  }));

  test('the served n_ctx is the truth for the budget, even when it differs (L-M08)', () => withTemp(async (root) => {
    const server = fakeServer({ nCtx: 8192 });
    const { d } = deps(server, root);
    const llama = await startLlama({ config: CONFIG, deps: d });
    try {
      assert.equal(llama.servedCtx, 8192);
      assert.ok(d.log.warn.mock.calls.length >= 1, 'a mismatch is logged');
    } finally { await llama.stop(); }
  }));

  test('the log file is unlinked and recreated, never truncated in place (v1 NUL-hole bug)', () => withTemp(async (root) => {
    const server = fakeServer();
    const { d, spawn } = deps(server, root);
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(d.logPath, 'old log from a previous server\n');
    const before = await stat(d.logPath);
    const llama = await startLlama({ config: CONFIG, deps: d });
    try {
      const after = await stat(d.logPath);
      assert.notEqual(after.ino, before.ino, 'a new inode');
      assert.equal(after.size, 0);
      const { stdio } = spawn.mock.calls[0].arguments[2];
      assert.equal(stdio[0], 'ignore');
      assert.equal(typeof stdio[1], 'number');
      assert.equal(stdio[1], stdio[2], 'stdout and stderr go to the same log');
    } finally { await llama.stop(); }
  }));

  test('port already answering /health -> port_busy, fail closed, nothing spawned', () => withTemp(async (root) => {
    const server = fakeServer({ busyBeforeSpawn: true });
    const { d, spawn } = deps(server, root);
    await assert.rejects(startLlama({ config: CONFIG, deps: d }), (e) => e instanceof LlamaStartError && e.code === 'port_busy' && /18432/.test(e.message));
    assert.equal(spawn.mock.calls.length, 0);
  }));

  test('model not in the cache -> model_missing naming npm run model:fetch, nothing spawned', () => withTemp(async (root) => {
    const server = fakeServer();
    const { d, spawn } = deps(server, root, { d: { findGguf: async () => null } });
    await assert.rejects(startLlama({ config: CONFIG, deps: d }),
      (e) => e instanceof LlamaStartError && e.code === 'model_missing' && /npm run model:fetch/.test(e.message) && /org\/m-GGUF/.test(e.message));
    assert.equal(spawn.mock.calls.length, 0);
  }));

  test('never healthy -> start_timeout, and the child is stopped', () => withTemp(async (root) => {
    const server = fakeServer({ never: true });
    const { d, child } = deps(server, root);
    await assert.rejects(startLlama({ config: { ...CONFIG, LLAMACPP_START_TIMEOUT_MS: 60 }, deps: d }),
      (e) => e instanceof LlamaStartError && e.code === 'start_timeout');
    assert.ok(child.signals.length >= 1, 'no orphan server left behind');
  }));

  test('the child exits before it is healthy -> exited, fast, with the log path', () => withTemp(async (root) => {
    const server = fakeServer({ never: true });
    const child = new FakeChild();
    const { d } = deps(server, root, { child });
    setTimeout(() => child.emit('exit', 1, null), 20);
    const t0 = Date.now();
    await assert.rejects(startLlama({ config: { ...CONFIG, LLAMACPP_START_TIMEOUT_MS: 5000 }, deps: d }),
      (e) => e instanceof LlamaStartError && e.code === 'exited' && e.message.includes(d.logPath));
    assert.ok(Date.now() - t0 < 2000, 'does not wait for the full start timeout');
  }));

  test('spawn ENOENT -> binary_missing naming LLAMACPP_VENDOR_DIR and PATH', () => withTemp(async (root) => {
    const server = fakeServer({ never: true });
    const child = new FakeChild();
    const { d } = deps(server, root, { child });
    setTimeout(() => child.emit('error', Object.assign(new Error('spawn llama-server ENOENT'), { code: 'ENOENT' })), 5);
    await assert.rejects(startLlama({ config: CONFIG, deps: d }),
      (e) => e instanceof LlamaStartError && e.code === 'binary_missing' && /LLAMACPP_VENDOR_DIR/.test(e.message) && /PATH/.test(e.message));
  }));

  test('stop(): SIGTERM, then SIGKILL when the child ignores it; a second stop does nothing', () => withTemp(async (root) => {
    const server = fakeServer();
    const child = new FakeChild({ exitOn: ['SIGKILL'] });
    const { d } = deps(server, root, { child });
    const llama = await startLlama({ config: CONFIG, deps: d });
    await llama.stop();
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    await llama.stop();
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  }));

  test('stop(): a child that exits on SIGTERM gets no SIGKILL', () => withTemp(async (root) => {
    const server = fakeServer();
    const { d, child } = deps(server, root);
    const llama = await startLlama({ config: CONFIG, deps: d });
    await llama.stop();
    assert.deepEqual(child.signals, ['SIGTERM']);
  }));

  test('LLAMACPP_THREADS set -> used as is', () => withTemp(async (root) => {
    const server = fakeServer();
    const { d } = deps(server, root);
    const llama = await startLlama({ config: { ...CONFIG, LLAMACPP_THREADS: 3 }, deps: d });
    try { assert.equal(llama.threads, 3); } finally { await llama.stop(); }
  }));
});
