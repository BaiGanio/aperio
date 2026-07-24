// audit/tests/routes-contract.test.js
// A03 Route contract gate tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CONTRACT_SCRIPT = resolve("audit/scripts/contracts/routes.js");

function buildRoutesFixture() {
  const dir = mkdtempSync(join(tmpdir(), "audit-a03-"));
  mkdirSync(join(dir, "lib", "routes"), { recursive: true });
  mkdirSync(join(dir, "lib", "server"), { recursive: true });
  mkdirSync(join(dir, "lib", "helpers"), { recursive: true });
  mkdirSync(join(dir, "lib", "security"), { recursive: true });

  const create = (p, c) => writeFileSync(join(dir, p), c, "utf-8");
  const routeFiles = [
    "api.js", "api-agents.js", "api-codegraph.js", "api-config.js",
    "api-data.js", "api-database.js", "api-datasets.js", "api-docgraph.js",
    "api-github-webhook.js", "api-interrupts.js", "api-memories.js",
    "api-meta.js", "api-restart.js", "api-sessions.js", "api-settings.js",
    "api-wiki.js", "paths.js",
  ];
  for (const f of routeFiles) {
    create(`lib/routes/${f}`, `// ${f}`);
  }

  // api.js with all mount references
  create("lib/routes/api.js", `
    import { mountMetaRoutes } from "./api-meta.js";
    import { mountAgentRoutes } from "./api-agents.js";
    import { mountMemoryRoutes } from "./api-memories.js";
    import { mountWikiRoutes } from "./api-wiki.js";
    import { mountCodegraphRoutes } from "./api-codegraph.js";
    import { mountDocgraphRoutes } from "./api-docgraph.js";
    import { mountSessionRoutes } from "./api-sessions.js";
    import { mountSettingsRoutes } from "./api-settings.js";
    import { mountConfigRoutes } from "./api-config.js";
    import { mountRestartRoutes } from "./api-restart.js";
    import { mountGithubWebhookRoutes } from "./api-github-webhook.js";
    import { mountDataRoutes } from "./api-data.js";
    import { mountDatabaseRoutes } from "./api-database.js";
    import { mountInterruptRoutes } from "./api-interrupts.js";
    import { mountDatasetRoutes } from "./api-datasets.js";
    export function apiRouter() {}
  `);

  create("lib/server/setupRoutes.js", `
    import { makeRateLimiter } from "../helpers/rateLimit.js";
    import { createStaticGuard } from "../helpers/staticAuth.js";
  `);
  create("lib/helpers/rateLimit.js", "export function makeRateLimiter() {}");
  create("lib/helpers/netGuard.js", "export function netGuard() {}");
  create("lib/security/agentPermissions.js", "export const PERMISSION_CAPABILITIES = [];");
  create("lib/security/interruptService.js", "export class InterruptService {}");

  return dir;
}

function runContract(dir) {
  try {
    const result = execSync(`node ${CONTRACT_SCRIPT} "${dir}"`, {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(result);
  } catch (err) {
    return JSON.parse(err.stdout);
  }
}

describe("A03 — Route contract gate", () => {
  test("gate passes with complete fixture", () => {
    const dir = buildRoutesFixture();
    try {
      const result = runContract(dir);
      assert.ok(result.passed, "Gate should pass with complete fixture");
      assert.equal(result.checks.route_files.passed, true);
      assert.equal(result.checks.security_modules.passed, true);
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when a route file is missing", () => {
    const dir = buildRoutesFixture();
    try {
      unlinkSync(join(dir, "lib", "routes", "api-memories.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail with missing route file");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when setupRoutes.js is missing", () => {
    const dir = buildRoutesFixture();
    try {
      unlinkSync(join(dir, "lib", "server", "setupRoutes.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without setupRoutes");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when rateLimit.js is missing", () => {
    const dir = buildRoutesFixture();
    try {
      unlinkSync(join(dir, "lib", "helpers", "rateLimit.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without rateLimit");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when netGuard.js is missing", () => {
    const dir = buildRoutesFixture();
    try {
      unlinkSync(join(dir, "lib", "helpers", "netGuard.js"));
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail without netGuard");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("gate fails when api.js does not reference all mount functions", () => {
    const dir = buildRoutesFixture();
    try {
      writeFileSync(join(dir, "lib", "routes", "api.js"),
        "export function apiRouter() {}", "utf-8");
      const result = runContract(dir);
      assert.equal(result.passed, false, "Gate should fail with incomplete api.js");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });

  test("restoring a deleted file makes gate pass again", () => {
    const dir = buildRoutesFixture();
    try {
      unlinkSync(join(dir, "lib", "security", "agentPermissions.js"));
      assert.equal(runContract(dir).passed, false, "Should fail after deletion");

      writeFileSync(join(dir, "lib", "security", "agentPermissions.js"),
        "export const PERMISSION_CAPABILITIES = [];", "utf-8");
      assert.equal(runContract(dir).passed, true, "Should pass after restoration");
    } finally {
      execSync(`rm -rf "${dir}"`, { shell: true });
    }
  });
});
