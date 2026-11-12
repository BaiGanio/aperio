// T2.14 - static files, the shared schema route and the CSP header
// (spec S2.14 §2.2, §3 item 2). L-C11: CSP is on, no inline code.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createServer, CSP_HEADER } from '../../src/server/app-server.js';
import { TEST_CONFIG, fakeRunner, quietLog, rawGet } from './socket-helpers.js';

const SCHEMA_FILE = path.resolve(import.meta.dirname, '..', '..', 'src', 'shared', 'ws-schema.js');
const EXPECTED_CSP = "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

let dir;
let server;
let port;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aperio-public-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><p>shell</p>\n');
  server = createServer({ config: TEST_CONFIG, runner: fakeRunner(), log: quietLog(), publicDir: dir });
  ({ port } = await server.listen());
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

test('the CSP constant is the one in the spec, with no unsafe-inline', () => {
  assert.equal(CSP_HEADER, EXPECTED_CSP);
  assert.doesNotMatch(CSP_HEADER, /unsafe/);
});

test('GET / serves public/index.html with the CSP header', async () => {
  const r = await rawGet(port, '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /shell/);
  assert.equal(r.headers['content-security-policy'], EXPECTED_CSP);
});

test('GET /shared/ws-schema.js serves the same file the server imports, as JavaScript', async () => {
  const r = await rawGet(port, '/shared/ws-schema.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
  assert.equal(r.body, await readFile(SCHEMA_FILE, 'utf8'));
  assert.equal(r.headers['content-security-policy'], EXPECTED_CSP);
});

test('an unknown path is 404 and still carries the CSP header', async () => {
  const r = await rawGet(port, '/nope.js');
  assert.equal(r.status, 404);
  assert.equal(r.headers['content-security-policy'], EXPECTED_CSP);
});

for (const p of ['/../package.json', '/%2e%2e/package.json', '/shared/../../package.json', '/shared/..%2f..%2fpackage.json', '/..%5cpackage.json']) {
  test(`path traversal ${p} never serves the file`, async () => {
    const r = await rawGet(port, p);
    assert.ok([400, 403, 404].includes(r.status), `status ${r.status}`);
    assert.doesNotMatch(r.body, /"name": "aperio"/);
  });
}

test('only /shared/ws-schema.js is served from src/, nothing else', async () => {
  const r = await rawGet(port, '/shared/registry.js');
  assert.equal(r.status, 404);
});

test('close() frees the port', async () => {
  const s = createServer({ config: TEST_CONFIG, runner: fakeRunner(), log: quietLog(), publicDir: dir });
  const { port: p } = await s.listen();
  await s.close();
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(p, '127.0.0.1', resolve); });
  await new Promise((resolve) => probe.close(resolve));
});
