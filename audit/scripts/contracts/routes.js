// audit/scripts/contracts/routes.js
// A03 Route contract gate — deterministic checks, no LLM.
// Verifies:
//   1. All expected route files exist in lib/routes/
//   2. Route registration (setupRoutes.js) exists
//   3. Security modules exist (rateLimit, netGuard, agentPermissions, interruptService)
//   4. Route composition (api.js) mounts all expected domain modules

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

function checkRouteFiles(rootDir) {
  const results = [];
  const routeDir = join(rootDir, "lib", "routes");

  // Expected route files
  const expectedRoutes = [
    "api.js", "api-agents.js", "api-codegraph.js", "api-config.js",
    "api-data.js", "api-database.js", "api-datasets.js", "api-docgraph.js",
    "api-github-webhook.js", "api-interrupts.js", "api-memories.js",
    "api-meta.js", "api-restart.js", "api-sessions.js", "api-settings.js",
    "api-wiki.js", "paths.js",
  ];

  if (existsSync(routeDir)) {
    const actualFiles = readdirSync(routeDir).filter(f => f.endsWith(".js"));
    for (const f of expectedRoutes) {
      results.push({
        invariant: `Route file lib/routes/${f} exists`,
        passed: actualFiles.includes(f),
        detail: actualFiles.includes(f) ? "Present" : "MISSING",
      });
    }

    // Check that api.js references all expected modules
    const apiJsPath = join(routeDir, "api.js");
    if (existsSync(apiJsPath)) {
      const content = readFileSync(apiJsPath, "utf-8");
      const mountRefs = ["mountMetaRoutes", "mountAgentRoutes", "mountMemoryRoutes",
        "mountWikiRoutes", "mountCodegraphRoutes", "mountDocgraphRoutes",
        "mountSessionRoutes", "mountSettingsRoutes", "mountConfigRoutes",
        "mountRestartRoutes", "mountDatabaseRoutes", "mountDataRoutes",
        "mountDatasetRoutes", "mountInterruptRoutes", "mountGithubWebhookRoutes"];
      const missing = mountRefs.filter(ref => !content.includes(ref));
      results.push({
        invariant: "api.js references all domain mount functions",
        passed: missing.length === 0,
        detail: missing.length === 0
          ? "All mount functions referenced"
          : `Missing: ${missing.join(", ")}`,
      });
    }
  } else {
    for (const f of expectedRoutes) {
      results.push({
        invariant: `Route file lib/routes/${f} exists`,
        passed: false,
        detail: "lib/routes/ directory MISSING",
      });
    }
  }

  return { results, passed: results.every(r => r.passed) };
}

function checkSecurityModules(rootDir) {
  const results = [];

  const modules = [
    ["lib/server/setupRoutes.js", "Route registration module"],
    ["lib/helpers/rateLimit.js", "Rate limiting middleware"],
    ["lib/helpers/netGuard.js", "DNS rebinding / CSRF protection"],
    ["lib/security/agentPermissions.js", "Agent permission enforcement"],
    ["lib/security/interruptService.js", "Interrupt service"],
    ["lib/routes/paths.js", "Path safety gate"],
  ];

  for (const [relPath, label] of modules) {
    const full = join(rootDir, relPath);
    results.push({
      invariant: `${label} (${relPath}) exists`,
      passed: existsSync(full),
      detail: existsSync(full) ? "Present" : "MISSING",
    });
  }

  // Check that setupRoutes.js imports rateLimit
  const setupRoutesPath = join(rootDir, "lib", "server", "setupRoutes.js");
  if (existsSync(setupRoutesPath)) {
    const content = readFileSync(setupRoutesPath, "utf-8");
    results.push({
      invariant: "setupRoutes.js imports rateLimit middleware",
      passed: content.includes("makeRateLimiter") || content.includes("rateLimit"),
      detail: content.includes("makeRateLimiter") ? "makeRateLimiter imported" : "NOT imported",
    });
    results.push({
      invariant: "setupRoutes.js imports staticAuth guard",
      passed: content.includes("createStaticGuard") || content.includes("staticAuth"),
      detail: content.includes("createStaticGuard") ? "createStaticGuard imported" : "NOT imported",
    });
  }

  return { results, passed: results.every(r => r.passed) };
}

function runRouteContractGate(rootDir) {
  rootDir = resolve(rootDir || process.cwd());
  const gate = {
    $schema: "aperio-audit-routes-contract-v1",
    slice_id: "A03",
    checks: {
      route_files: checkRouteFiles(rootDir),
      security_modules: checkSecurityModules(rootDir),
    },
    passed: false,
  };
  gate.passed = gate.checks.route_files.passed && gate.checks.security_modules.passed;
  return gate;
}

const rootArg = process.argv[2];
const gate = runRouteContractGate(rootArg);
process.stdout.write(JSON.stringify(gate, null, 2) + "\n");
process.exit(gate.passed ? 0 : 1);

export { runRouteContractGate };
