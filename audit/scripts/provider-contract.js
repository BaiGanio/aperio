// audit/scripts/provider-contract.js
//
// T2.1 — provider contract matrix for the continuous-audit program (Step 2,
// T2.1; audit slice A06). Six provider loops exist (anthropic, deepseek,
// gemini, llamacpp, claude-code, codex) and every one of them is reached
// through the same five-stage path:
//
//   KNOWN_PROVIDERS  →  resolveProvider()  →  dispatch ladder  →  loop module
//   (lib/providers/index.js)                 (lib/agent/index.js)
//
// …plus the AI_PROVIDER select in the config registry, which is what a user
// can actually choose. A provider added to one stage and forgotten in another
// is not a compile error: an unknown name resolves to `not-configured`, and a
// resolvable name with no dispatch branch throws only when a real turn runs.
// This gate reconciles all five stages by name, then checks that each loop
// still implements the three cross-provider capability contracts the plan
// names — usage reporting, abort, and egress redaction — instead of trusting
// a file count.
//
// Deliberately source-level, not import-level: importing the six loops pulls
// in SDKs and side effects, and the drift being caught here is textual (a
// branch that was never added). The same choice routes-contract.js makes.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../lib/config.js";
import { isLocalProvider } from "../../lib/providers/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTRY_FILE = "lib/providers/index.js";
const DISPATCH_FILE = "lib/agent/index.js";

// Names that appear in the resolver or the dispatch ladder but are not user
// selectable providers, and must not be matrixed as if they were.
//   not-configured — the explicit "no provider chosen" state resolveProvider
//                    returns instead of a silent cloud fallback (#252).
//   mock           — the deterministic loop-regression harness
//                    (tests/harness/mock-provider.js); resolveProvider refuses
//                    to resolve it outside NODE_ENV=test.
export const NON_PROVIDER_NAMES = new Set(["not-configured", "mock"]);

// The cross-provider capability contracts, one marker each. A marker proves
// the loop reaches for the shared mechanism; it does not prove the mechanism
// is used correctly — that is what the per-provider tests are for, which is
// why this gate also requires each provider to have one.
export const CAPABILITY_MARKERS = {
  // Every loop must close its stream with a usage payload, on every exit path
  // it takes — the ledger's token accounting has no other source.
  usage: /type:\s*["']stream_end["'][^\n]*\busage\b/,
  // Every loop must consult the caller's abort controller rather than only
  // accepting it. `getAbort()` and `getAbort?.()` are both real call shapes.
  abort: /getAbort\s*\??\.?\(/,
  // Every CLOUD loop must scrub secrets at its own send boundary (PRIVACY-01).
  // The local loop is exempt — see REVIEWED_CAPABILITY_EXEMPTIONS. The
  // trailing `(` is load-bearing: without it the import specifier
  // `from "../../helpers/redactSecrets.js"` satisfies the marker, so a loop
  // that imports the helper and stops calling it would pass this gate.
  redaction: /\bredact(?:Messages|Secrets)\s*\(/,
};

// T2.1's "provider intentionally delegates / reviewed exception passes" case.
// An exemption is honoured only while its stated reason still holds in the
// code: `localOnly` is re-checked against isLocalProvider(), the single source
// of truth for privacy gating — so the day llamacpp stops being local, this
// gate fails instead of silently keeping the exemption.
export const REVIEWED_CAPABILITY_EXEMPTIONS = {
  llamacpp: {
    redaction: {
      reason: "fully local provider — nothing leaves the machine, so there is no egress boundary to scrub",
      localOnly: true,
    },
  },
};

// Two providers sharing one loop module is legitimate delegation (an adapter
// that is a thin variant of another), but it must be a decision on record —
// an accidental copy of a dispatch line points both names at one loop and
// silently disables the second provider's own behaviour.
export const REVIEWED_DELEGATIONS = {};

/** Names in lib/providers/index.js's KNOWN_PROVIDERS set literal. */
export function parseKnownProviders(source) {
  const body = source.match(/KNOWN_PROVIDERS\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Body of `export function <name>(…) { … }`, brace-matched from its own
 *  opening brace — so a `name:` in a neighbouring function can never be read
 *  as one of the resolver's return values. Deliberately not indentation-based:
 *  a nested or re-indented definition would slip past that. */
function functionBody(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) return "";
  // Walk past the parameter list first: a default-valued destructured
  // parameter (`resolveProvider(overrides = {})`) puts a brace BEFORE the
  // body, and matching from that one yields an empty body and a silent pass.
  let parens = 0;
  let i = source.indexOf("(", start);
  for (; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")" && --parens === 0) break;
  }
  const open = source.indexOf("{", i);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** Provider names resolveProvider() can actually return. */
export function parseResolverNames(source) {
  const body = functionBody(source, "resolveProvider");
  const names = [...body.matchAll(/name:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]);
  return [...new Set(names)].filter((n) => !NON_PROVIDER_NAMES.has(n));
}

/** Dispatch ladder in lib/agent/index.js: provider name → loop function. */
export function parseDispatch(source) {
  const map = {};
  const re = /provider\.name === ["']([a-z0-9-]+)["'][\s\S]{0,120}?await\s+(\w+)\(/g;
  let m;
  while ((m = re.exec(source))) {
    if (NON_PROVIDER_NAMES.has(m[1])) continue;
    map[m[1]] = m[2];
  }
  return map;
}

/** Loop imports in lib/agent/index.js: function name → provider module path. */
export function parseLoopImports(source) {
  const map = {};
  const re = /import\s*\{([^}]*)\}\s*from\s*["']\.\/providers\/([\w-]+)\.js["']/g;
  let m;
  while ((m = re.exec(source))) {
    for (const raw of m[1].split(",")) {
      const fn = raw.trim().split(/\s+as\s+/).pop();
      if (fn) map[fn] = `lib/agent/providers/${m[2]}.js`;
    }
  }
  return map;
}

/** AI_PROVIDER's selectable values in the config registry. */
export function parseConfigOptions(config = CONFIG) {
  return config.find((entry) => entry.key === "AI_PROVIDER")?.options ?? [];
}

function exemption(exemptions, provider, capability) {
  return exemptions?.[provider]?.[capability] ?? null;
}

/**
 * Reconcile every stage of the provider path by name, then check each loop's
 * capability markers. Fully injectable so a drift fixture (a registry listing
 * six providers against a dispatch handling five) can be driven without
 * touching the repo.
 */
export function checkProviderMatrix({
  registryNames = [],
  resolverNames = [],
  dispatch = {},
  loopImports = {},
  configOptions = [],
  loopSources = {},
  testFiles = [],
  exemptions = REVIEWED_CAPABILITY_EXEMPTIONS,
  delegations = REVIEWED_DELEGATIONS,
  isLocal = isLocalProvider,
} = {}) {
  const errors = [];
  const matrix = {};
  const registry = [...new Set(registryNames)];
  const dispatched = Object.keys(dispatch);

  for (const name of dispatched) {
    if (!registry.includes(name)) {
      errors.push(`${name}: dispatched in ${DISPATCH_FILE} but absent from KNOWN_PROVIDERS ` +
        `(${REGISTRY_FILE}) — resolveProvider will report it not-configured and the branch is dead`);
    }
  }

  const seenLoops = {};
  for (const name of registry) {
    const loopFn = dispatch[name] ?? null;
    const loopFile = loopFn ? (loopImports[loopFn] ?? null) : null;
    const tests = testFiles.filter((f) => f.split("/").pop() === `${name}.test.js`);
    const entry = { loopFn, loopFile, tests, capabilities: {} };
    matrix[name] = entry;

    if (!loopFn) {
      errors.push(`${name}: in KNOWN_PROVIDERS (${REGISTRY_FILE}) but has no dispatch branch in ` +
        `${DISPATCH_FILE} — selecting it throws "Unknown AI_PROVIDER" at the first turn`);
    }
    if (!resolverNames.includes(name)) {
      errors.push(`${name}: in KNOWN_PROVIDERS but resolveProvider() never returns it — ` +
        `it resolves to the anthropic fall-through instead of its own config`);
    }
    if (!configOptions.includes(name)) {
      errors.push(`${name}: missing from AI_PROVIDER's options in lib/config.js — ` +
        `unreachable from Settings and absent from the generated .env.example`);
    }
    if (!tests.length) {
      errors.push(`${name}: no provider-specific test file (${name}.test.js) — ` +
        `a shared capability marker is presence, not proof of behaviour`);
    }
    if (loopFile) {
      if (seenLoops[loopFile] && !delegations[name]) {
        errors.push(`${name}: shares its loop module (${loopFile}) with ` +
          `${seenLoops[loopFile]} but is not a reviewed delegation — manual classification required`);
      }
      seenLoops[loopFile] ??= name;
    }

    // A provider with no dispatch branch has no loop to check. Reporting its
    // three capability contracts as violations too would bury the one finding
    // that matters (the missing branch) under noise about a file that was
    // never reached; "unknown" is the truthful state.
    if (!loopFn) {
      for (const capability of Object.keys(CAPABILITY_MARKERS)) entry.capabilities[capability] = "unknown";
      continue;
    }

    const source = loopFile ? loopSources[loopFile] : null;
    if (source == null) {
      errors.push(loopFile
        ? `${name}: dispatches to ${loopFn} but its module (${loopFile}) could not be read`
        : `${name}: dispatches to ${loopFn}, which is not imported from lib/agent/providers/ — ` +
          `the loop it actually runs is unknown to this gate`);
      for (const capability of Object.keys(CAPABILITY_MARKERS)) entry.capabilities[capability] = "unknown";
      continue;
    }
    for (const [capability, marker] of Object.entries(CAPABILITY_MARKERS)) {
      const present = source != null && marker.test(source);
      const waiver = exemption(exemptions, name, capability);
      entry.capabilities[capability] = present ? "present" : waiver ? "exempt" : "missing";
      if (waiver?.localOnly && !isLocal(name)) {
        errors.push(`${name}: exempt from the ${capability} contract as a local-only provider, ` +
          `but isLocalProvider("${name}") is false — the exemption's stated reason no longer holds`);
      }
      if (present || waiver) continue;
      errors.push(`${name}: loop ${loopFile} has no ${capability} marker ` +
        `(${marker}) and is not a reviewed exemption`);
    }
  }

  for (const name of Object.keys(exemptions)) {
    if (!registry.includes(name)) {
      errors.push(`${name}: has a reviewed capability exemption but is no longer a known provider — ` +
        `registry entry is stale`);
    }
  }

  return { ok: errors.length === 0, errors, matrix };
}

function readIfPresent(rel) {
  try {
    return readFileSync(`${ROOT}/${rel}`, "utf8");
  } catch {
    return null;
  }
}

function listTestFiles() {
  return execFileSync("git", ["ls-files", "tests"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".test.js"));
}

/** The real repo's provider matrix. */
export function checkProviderContract() {
  const registrySource = readIfPresent(REGISTRY_FILE) ?? "";
  const dispatchSource = readIfPresent(DISPATCH_FILE) ?? "";
  const dispatch = parseDispatch(dispatchSource);
  const loopImports = parseLoopImports(dispatchSource);

  const loopSources = {};
  for (const file of new Set(Object.values(loopImports))) {
    const source = readIfPresent(file);
    if (source != null) loopSources[file] = source;
  }

  return checkProviderMatrix({
    registryNames: parseKnownProviders(registrySource),
    resolverNames: parseResolverNames(registrySource),
    dispatch,
    loopImports,
    configOptions: parseConfigOptions(),
    loopSources,
    testFiles: listTestFiles(),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkProviderContract(), null, 2));
}
