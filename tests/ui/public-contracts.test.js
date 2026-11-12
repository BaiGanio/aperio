// T3.0 - static rules for public/ (spec S3.0 §2, §3 items 8-9; the plan's Phase 3 rules).
// The inline scans are ported from v1 tests/integration/csp-reenablement.test.js
// (archive/v1-final), cut to v2: every HTML file, and no count allowance (v1 allowed 2 style=).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_DIR, REPO } from './ui-helpers.js';

const FRAMEWORKS = ['react', 'react-dom', 'vue', 'angular', '@angular/core', 'lit', 'svelte', 'preact', 'solid-js',
  'vite', 'webpack', 'esbuild', 'rollup', 'parcel'];

async function filesIn(dir, ext) {
  const all = await readdir(dir, { recursive: true });
  return all.filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
}
const rel = (f) => path.relative(REPO, f);
const read = (f) => readFile(f, 'utf8');

test('package.json has no UI framework or bundler', async () => {
  const pkg = JSON.parse(await read(path.join(REPO, 'package.json')));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
  for (const name of FRAMEWORKS) assert.ok(!deps.includes(name), `${name} is a framework or bundler`);
  assert.ok(!deps.some((d) => d.startsWith('@vitejs/') || d.startsWith('@sveltejs/')), 'no framework plugin packages');
});

test('public/ has the skeleton files the spec names', async () => {
  for (const f of ['index.html', 'main.js', 'state/store.js', 'services/socket-service.js', 'components/app-shell.js']) {
    await assert.doesNotReject(read(path.join(PUBLIC_DIR, f)), `public/${f} is missing`);
  }
});

test('CSP (v1 port): no inline <script>, <style>, style= or on*= in any public/ HTML', async () => {
  const html = await filesIn(PUBLIC_DIR, '.html');
  assert.ok(html.length >= 1, 'no HTML in public/');
  for (const f of html) {
    const text = await read(f);
    for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc=/, `${rel(f)}: a <script> with no src`);
      assert.equal(m[2].trim(), '', `${rel(f)}: inline script code`);
    }
    assert.doesNotMatch(text, /<style\b/i, `${rel(f)}: a <style> block`);
    assert.doesNotMatch(text, /\sstyle\s*=/i, `${rel(f)}: an inline style=`);
    assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${rel(f)}: an inline event handler`);
  }
});

test('every public/ module starts with // @ts-check', async () => {
  for (const f of await filesIn(PUBLIC_DIR, '.js')) {
    assert.match(await read(f), /^\/\/ @ts-check\b/, `${rel(f)} has no // @ts-check on line 1`);
  }
});

test('no innerHTML, no outerHTML, no insertAdjacentHTML, no window.* globals in public/', async () => {
  for (const f of await filesIn(PUBLIC_DIR, '.js')) {
    const text = await read(f);
    assert.doesNotMatch(text, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/, `${rel(f)}: builds markup from strings`);
    assert.doesNotMatch(text, /\bwindow\.\w+\s*=(?!=)/, `${rel(f)}: sets a window global`);
    assert.doesNotMatch(text, /\bglobalThis\.\w+\s*=(?!=)/, `${rel(f)}: sets a global`);
  }
});

test('components never import the socket service; services never touch the DOM', async () => {
  for (const f of await filesIn(path.join(PUBLIC_DIR, 'components'), '.js')) {
    const text = await read(f);
    assert.doesNotMatch(text, /from\s*['"][^'"]*services\//, `${rel(f)} imports a service`);
    assert.doesNotMatch(text, /\bnew\s+WebSocket\b/, `${rel(f)} opens a socket`);
  }
  for (const f of await filesIn(path.join(PUBLIC_DIR, 'services'), '.js')) {
    assert.doesNotMatch(await read(f), /\b(document|customElements|HTMLElement)\b/, `${rel(f)} touches the DOM`);
  }
});

test('main.js is the only file that wires the store, the service and the element', async () => {
  for (const f of await filesIn(PUBLIC_DIR, '.js')) {
    const text = await read(f);
    if (path.basename(f) === 'main.js') {
      assert.match(text, /createStore\(/);
      assert.match(text, /createSocketService\(/);
      assert.match(text, /customElements\.define\(\s*['"]aperio-app['"]/);
      continue;
    }
    assert.doesNotMatch(text, /customElements\.define\(/, `${rel(f)} defines an element; only main.js does`);
    assert.doesNotMatch(text, /createSocketService\(\s*\{/, `${rel(f)} makes a service; only main.js does`);
  }
});
