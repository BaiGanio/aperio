// A01 — audit/scripts/bootstrap-contract.js (bootstrap and shutdown domain,
// aperio-continuous-audit.md's A01 invariant: "every partial start has an
// observable recovery path; shutdown releases all owned resources").
//
// Two static, mechanical checks, each with a synthetic-fixture red/green
// proof plus a real-source assertion (T5.1's pattern, applied per-gate).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  stepIds, stepsWithErrorPath, checkStepErrorPaths,
  destructuredParamNames, bodyReferencedNames, callSiteKeys, checkShutdownResourceParity,
  checkBootstrapContract,
} from "../scripts/bootstrap-contract.js";

describe("audit/scripts/bootstrap-contract.js — step error paths", () => {
  test("stepIds/stepsWithErrorPath parse a fixture STEPS array and setStep calls", () => {
    const src = `
export const STEPS = [
  { id: 'a', label: 'A', icon: 'x' },
  { id: 'b', label: 'B', icon: 'y' },
];
setStep('a', 'running', 'go');
setStep('a', 'error', 'boom');
setStep('b', 'running', 'go');
setStep('b', 'done', 'ok');
`;
    assert.deepStrictEqual([...stepIds(src)].sort(), ["a", "b"]);
    assert.deepStrictEqual([...stepsWithErrorPath(src)], ["a"]);
  });

  test("T5.1 red/green proof — a step with no error path fails and names it; adding the " +
    "call flips it to passing", () => {
    const red = `
export const STEPS = [ { id: 'x', label: 'X', icon: 'i' } ];
setStep('x', 'running', 'go');
setStep('x', 'done', 'ok');
`;
    const redResult = checkStepErrorPaths({ source: red });
    assert.strictEqual(redResult.ok, false);
    assert.deepStrictEqual(redResult.missing, ["x"]);

    const green = red + `\nsetStep('x', 'error', 'boom');\n`;
    const greenResult = checkStepErrorPaths({ source: green });
    assert.strictEqual(greenResult.ok, true);
  });

  test("current real state — every bootstrap.js step has an observable per-step error path " +
    "(fixed 2026-08-16; node/deps/engine previously had none, see git history and CHANGELOG.md)", () => {
    const result = checkStepErrorPaths();
    assert.deepStrictEqual(result.ids, ["deps", "engine", "model", "node", "sqlite"]);
    assert.deepStrictEqual(result.missing, []);
    assert.strictEqual(result.ok, true);
  });
});

describe("audit/scripts/bootstrap-contract.js — shutdown resource parity", () => {
  test("destructuredParamNames/bodyReferencedNames/callSiteKeys parse a fixture shutdown module", () => {
    const shutdown = `
export function createGracefulShutdown({ watchdog, store, orphan }) {
  return async function gracefulShutdown() {
    watchdog.stop();
    await store.close?.();
  };
}
`;
    const declared = destructuredParamNames(shutdown, "createGracefulShutdown");
    assert.deepStrictEqual([...declared].sort(), ["orphan", "store", "watchdog"]);
    const used = bodyReferencedNames(shutdown, "createGracefulShutdown", declared);
    assert.deepStrictEqual([...used].sort(), ["store", "watchdog"]);

    const server = `const gracefulShutdown = createGracefulShutdown({ watchdog, store });`;
    assert.deepStrictEqual([...callSiteKeys(server, "createGracefulShutdown")].sort(), ["store", "watchdog"]);
  });

  test("T5.1 red/green proof — a declared-but-never-torn-down resource fails; using it in the " +
    "body flips it to passing", () => {
    const redShutdown = `
export function createGracefulShutdown({ watchdog, orphan }) {
  return async function gracefulShutdown() {
    watchdog.stop();
  };
}
`;
    const server = `createGracefulShutdown({ watchdog, orphan });`;
    const red = checkShutdownResourceParity({ shutdownSource: redShutdown, serverSource: server });
    assert.strictEqual(red.ok, false);
    assert.deepStrictEqual(red.unusedInBody, ["orphan"]);

    const greenShutdown = `
export function createGracefulShutdown({ watchdog, orphan }) {
  return async function gracefulShutdown() {
    watchdog.stop();
    orphan.dispose();
  };
}
`;
    const green = checkShutdownResourceParity({ shutdownSource: greenShutdown, serverSource: server });
    assert.strictEqual(green.ok, true);
  });

  test("T5.1 red/green proof — a call-site/signature drift (param declared but not passed) fails", () => {
    const shutdown = `
export function createGracefulShutdown({ watchdog, store }) {
  return async function gracefulShutdown() {
    watchdog.stop();
    await store.close?.();
  };
}
`;
    const serverMissingStore = `createGracefulShutdown({ watchdog });`;
    const result = checkShutdownResourceParity({ shutdownSource: shutdown, serverSource: serverMissingStore });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.declaredNotPassedAtCallSite, ["store"]);
  });

  test("current real state — createGracefulShutdown's declared resources are all torn down " +
    "in its body and match the real call site in lib/server.js", () => {
    const result = checkShutdownResourceParity();
    assert.deepStrictEqual(result, { ok: true, unusedInBody: [], declaredNotPassedAtCallSite: [], passedNotInSignature: [] });
  });
});

describe("audit/scripts/bootstrap-contract.js — combined", () => {
  test("checkBootstrapContract reflects both sub-gates", () => {
    const result = checkBootstrapContract();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stepErrorPaths.ok, true);
    assert.strictEqual(result.shutdownResourceParity.ok, true);
  });
});
