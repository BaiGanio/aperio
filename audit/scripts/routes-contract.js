// audit/scripts/routes-contract.js
//
// T2.2 — HTTP mutation/auth-exemption inventory for the continuous-audit
// program (Step 2, T2.2). Scope decision for THIS codebase: auth is a single
// global createAuthGuard() middleware mounted before the whole /api router
// (lib/server.js), not a per-route matrix — so the meaningful drift to catch
// isn't "does this route have auth" (uniform by construction) but "does a
// route that self-declares an exemption from that guard actually implement
// one, and is every self-declared exemption in the reviewed registry."
// api-github-webhook.js is the one route in this codebase built that way
// (GitHub can't present APERIO_AUTH_TOKEN, so it verifies its own HMAC).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROUTES_DIR = "lib/routes";
const MUTATING_METHODS = new Set(["post", "put", "patch", "delete"]);

// A file is in the registry only if it BOTH self-declares an exemption in
// its own comments AND implements the named verification step — the gate
// checks both directions so a declared-but-unimplemented exemption, or an
// implemented-but-undeclared one, both fail loud.
export const REVIEWED_AUTH_EXEMPTIONS = {
  "api-github-webhook.js": {
    reason: "GitHub can't present APERIO_AUTH_TOKEN; self-verifies the X-Hub-Signature-256 HMAC instead",
    verifyMarker: "timingSafeEqual",
  },
};

// Comment prose wraps across lines (e.g. "...is exempt\n// from
// createAuthGuard..."), so this checks for both signal words appearing
// anywhere in the file rather than one contiguous phrase.
function declaresAuthExemption(source) {
  return /\bexempt\b/i.test(source) && source.includes("createAuthGuard");
}

function listRouteFiles() {
  return execFileSync("git", ["ls-files", ROUTES_DIR], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\/api[-.]?.*\.js$/.test(f) || f.endsWith("/api.js"));
}

export function mutatingRoutes(source) {
  const routes = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(source))) {
    const method = m[1];
    routes.push({ method, path: m[2], mutating: MUTATING_METHODS.has(method) });
  }
  return routes;
}

export function checkRouteFile(baseName, source, exemptions = REVIEWED_AUTH_EXEMPTIONS) {
  const declaresExemption = declaresAuthExemption(source);
  const registered = exemptions[baseName];
  const errors = [];

  if (declaresExemption && !registered) {
    errors.push(`${baseName} declares an auth-guard exemption in its comments but is not in ` +
      `REVIEWED_AUTH_EXEMPTIONS — manual classification required`);
  }
  if (registered && !declaresExemption) {
    errors.push(`${baseName} is in REVIEWED_AUTH_EXEMPTIONS but no longer declares the exemption ` +
      `in its comments — registry entry is stale`);
  }
  if (registered && !source.includes(registered.verifyMarker)) {
    errors.push(`${baseName} is a reviewed auth exemption but its verification step ` +
      `("${registered.verifyMarker}") was not found — an exemption without real verification ` +
      `is an open auth bypass`);
  }
  return { ok: errors.length === 0, errors };
}

export function checkRoutesContract({ exemptions = REVIEWED_AUTH_EXEMPTIONS } = {}) {
  const files = listRouteFiles();
  const perFile = {};
  const allErrors = [];
  const inventory = {};

  for (const rel of files) {
    const baseName = rel.split("/").pop();
    let source;
    try {
      source = readFileSync(`${ROOT}/${rel}`, "utf8");
    } catch {
      continue;
    }
    inventory[baseName] = mutatingRoutes(source);
    const result = checkRouteFile(baseName, source, exemptions);
    perFile[baseName] = result;
    if (!result.ok) allErrors.push(...result.errors.map((e) => `${baseName}: ${e}`));
  }

  return { ok: allErrors.length === 0, errors: allErrors, perFile, inventory };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkRoutesContract(), null, 2));
}
