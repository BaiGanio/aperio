// T3.0 - the shell loads as plain files, with no build (spec S3.0 §2.1, §3 item 6).
// The real S2.14 server serves the real public/; a fake runner stands in for the
// model. Every module main.js pulls in (transitively) must answer 200 as JavaScript,
// and a Node WebSocket client must connect.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server/app-server.js';
import { TEST_CONFIG, connect, fakeRunner, quietLog, rawGet } from '../server/socket-helpers.js';

let server;
let port;

before(async () => {
  server = createServer({ config: TEST_CONFIG, runner: fakeRunner(), log: quietLog() });
  ({ port } = await server.listen());
});
after(() => server?.close());

const IMPORT_RE = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Static and literal dynamic import specifiers in one module. */
function importsOf(source) {
  const out = new Set();
  for (const re of IMPORT_RE) for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out];
}

test('GET / is the shell: one <aperio-app> and one module script main.js', async () => {
  const r = await rawGet(port, '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal((r.body.match(/<aperio-app\b/g) ?? []).length, 1);
  const scripts = [...r.body.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'exactly one script tag');
  assert.match(scripts[0], /\btype=["']module["']/);
  assert.match(scripts[0], /\bsrc=["']\/?main\.js["']/);
});

test('main.js and every module it imports load as JavaScript, with no build step', async () => {
  const seen = new Set();
  const queue = ['/main.js'];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const r = await rawGet(port, p);
    assert.equal(r.status, 200, `${p} → ${r.status}`);
    assert.match(r.headers['content-type'], /javascript/, `${p} must be served as JavaScript`);
    assert.ok(r.headers['content-security-policy'], `${p} has the CSP header`);
    for (const spec of importsOf(r.body)) {
      assert.match(spec, /^(\.{1,2}\/|\/)/, `${p} imports a bare specifier "${spec}" (no import map, no build)`);
      queue.push(new URL(spec, `http://x${p}`).pathname);
    }
  }
  assert.ok(seen.has('/shared/ws-schema.js'), 'the shell reaches the shared schema through the server route');
  assert.ok(seen.size >= 5, `only ${seen.size} modules reached: ${[...seen].join(', ')}`);
});

test('a Node WebSocket client connects to the same server', async () => {
  const c = await connect(port);
  assert.equal(c.ws.readyState, c.ws.OPEN);
  c.close();
  await c.closed;
});
