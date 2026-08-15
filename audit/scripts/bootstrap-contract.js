// audit/scripts/bootstrap-contract.js
//
// A01 domain contract (bootstrap and shutdown) for the continuous-audit
// program's Step 2 expansion. A01's invariant (aperio-continuous-audit.md
// §5): "Every partial start has an observable recovery path; shutdown
// releases all owned resources." Two static, mechanical checks:
//
//   1. bootstrap.js's STEPS: every step id that can enter 'running' must be
//      able to reach setStep(id, 'error', ...) too — otherwise a failure in
//      that step leaves its own status tile stuck at 'running' forever, even
//      if the wizard's global error event still fires (which it does; see
//      runBootstrap's outer try/catch — this checks per-step observability,
//      not total silence).
//   2. lib/server/shutdown.js's createGracefulShutdown(): every resource
//      name in its parameter list must both be referenced inside its body
//      (declared-but-never-torn-down is a leak) AND be passed by name at its
//      real call site in lib/server.js (signature/call-site drift would pass
//      `undefined` for that resource and crash on the first `.stop()`).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BOOTSTRAP_FILE = "bootstrap.js";
const SHUTDOWN_FILE = "lib/server/shutdown.js";
const SERVER_FILE = "lib/server.js";

export function stepIds(source) {
  const ids = new Set();
  const re = /^export const STEPS = \[([\s\S]*?)\];/m;
  const block = source.match(re);
  if (!block) throw new Error("could not locate STEPS array");
  const idRe = /id:\s*['"]([a-zA-Z0-9_-]+)['"]/g;
  let m;
  while ((m = idRe.exec(block[1]))) ids.add(m[1]);
  return ids;
}

export function stepsWithErrorPath(source) {
  const withError = new Set();
  const re = /setStep\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*,\s*['"]error['"]/g;
  let m;
  while ((m = re.exec(source))) withError.add(m[1]);
  return withError;
}

export function checkStepErrorPaths({ source = readFileSync(`${ROOT}/${BOOTSTRAP_FILE}`, "utf8") } = {}) {
  const ids = stepIds(source);
  const withError = stepsWithErrorPath(source);
  const missing = [...ids].filter((id) => !withError.has(id)).sort();
  return { ok: missing.length === 0, missing, ids: [...ids].sort() };
}

// Extracts the destructured parameter names from a `export function name({ a,
// b, c })` signature — createGracefulShutdown's whole parameter list is one
// destructured object.
export function destructuredParamNames(source, functionName) {
  const re = new RegExp(`function\\s+${functionName}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, "m");
  const m = source.match(re);
  if (!m) throw new Error(`could not locate ${functionName}(...)'s destructured parameters`);
  return new Set(
    m[1].split(",").map((p) => p.split(":")[0].trim().replace(/=.*/, "").trim()).filter(Boolean)
  );
}

export function bodyReferencedNames(source, functionName, names) {
  const startIdx = source.indexOf(`function ${functionName}`);
  if (startIdx === -1) throw new Error(`could not locate ${functionName}`);
  const body = source.slice(startIdx);
  const used = new Set();
  for (const name of names) {
    // Word-boundary match anywhere after the signature line (cheap but
    // sufficient: a param name reused as an unrelated identifier elsewhere in
    // the same function would be a false negative for "unused," never a
    // false positive for "used" — the safer direction for a leak check).
    const bodyOnly = body.slice(body.indexOf(")") + 1);
    if (new RegExp(`\\b${name}\\b`).test(bodyOnly)) used.add(name);
  }
  return used;
}

// The real call site passes an object literal with shorthand keys
// (`{ watchdog, dedup, ... store }`), so the keys ARE the resource names.
export function callSiteKeys(source, functionName) {
  const re = new RegExp(`${functionName}\\(\\{([\\s\\S]*?)\\}\\)`, "m");
  const m = source.match(re);
  if (!m) throw new Error(`could not locate a call to ${functionName}(...)`);
  return new Set(
    m[1].split(",").map((p) => p.split(":")[0].trim()).filter(Boolean)
  );
}

export function checkShutdownResourceParity({
  shutdownSource = readFileSync(`${ROOT}/${SHUTDOWN_FILE}`, "utf8"),
  serverSource = readFileSync(`${ROOT}/${SERVER_FILE}`, "utf8"),
} = {}) {
  const declared = destructuredParamNames(shutdownSource, "createGracefulShutdown");
  const used = bodyReferencedNames(shutdownSource, "createGracefulShutdown", declared);
  const unused = [...declared].filter((n) => !used.has(n)).sort();

  const passed = callSiteKeys(serverSource, "createGracefulShutdown");
  const declaredNotPassed = [...declared].filter((n) => !passed.has(n)).sort();
  const passedNotDeclared = [...passed].filter((n) => !declared.has(n)).sort();

  return {
    ok: unused.length === 0 && declaredNotPassed.length === 0 && passedNotDeclared.length === 0,
    unusedInBody: unused,
    declaredNotPassedAtCallSite: declaredNotPassed,
    passedNotInSignature: passedNotDeclared,
  };
}

export function checkBootstrapContract() {
  const stepPaths = checkStepErrorPaths();
  const shutdown = checkShutdownResourceParity();
  return { ok: stepPaths.ok && shutdown.ok, stepErrorPaths: stepPaths, shutdownResourceParity: shutdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkBootstrapContract(), null, 2));
}
