import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAgentSpec } from "../../../lib/agent/spec.js";
import {
  AgentPermissionNarrowingError,
  assertPermissionNarrowing,
  createPermissionPolicyFromAgentSpec,
  evaluatePermission,
  normalizePermissionPolicy,
} from "../../../lib/security/agentPermissions.js";

test("evaluates ordered first-match rules with default deny", () => {
  const policy = normalizePermissionPolicy({
    rules: [
      { capability: "read", effect: "deny", resource: "/repo/private" },
      { capability: "read", effect: "allow", resource: "/repo" },
    ],
  });

  assert.equal(evaluatePermission(policy, { capability: "read", resource: "/repo/public/a.js" }).allowed, true);
  const denied = evaluatePermission(policy, { capability: "read", resource: "/repo/private/key.txt" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.ruleIndex, 0);

  const noMatch = evaluatePermission(policy, { capability: "write", resource: "/repo/public/a.js" });
  assert.equal(noMatch.allowed, false);
  assert.equal(noMatch.reason, "default-deny");
});

test("supports read, write, execute, network, database, and memory capabilities", () => {
  const policy = normalizePermissionPolicy({
    rules: [
      { capability: "read", effect: "allow", resource: "/repo/docs" },
      { capability: "write", effect: "allow", resource: "/repo/var/scratch" },
      { capability: "execute", effect: "allow", resource: "/repo/scripts" },
      { capability: "network", action: "fetch", effect: "allow", resource: "example.com" },
      { capability: "database", action: "query", effect: "allow", resource: "aperio" },
      { capability: "memory", action: "read", effect: "allow", resource: "project" },
    ],
  });

  assert.equal(evaluatePermission(policy, { capability: "read", resource: "/repo/docs/plan.md" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "write", resource: "/repo/var/scratch/out.txt" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "execute", resource: "/repo/scripts/check.js" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "network", action: "fetch", resource: "EXAMPLE.com" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "database", action: "query", resource: "aperio" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "memory", action: "read", resource: "project" }).allowed, true);

  assert.equal(evaluatePermission(policy, { capability: "network", action: "post", resource: "example.com" }).allowed, false);
  assert.equal(evaluatePermission(policy, { capability: "database", action: "execute", resource: "aperio" }).allowed, false);
  assert.equal(evaluatePermission(policy, { capability: "memory", action: "write", resource: "project" }).allowed, false);
});

test("derives filesystem and memory permission rules from AgentSpec", () => {
  const spec = normalizeAgentSpec({
    id: "worker",
    filesystem: {
      read: ["/repo"],
      write: ["/repo/var/scratch"],
      execute: ["/repo/scripts"],
    },
    memoryScopes: [
      { name: "project", access: "read-write" },
      { name: "self", access: "none" },
    ],
  });
  const policy = createPermissionPolicyFromAgentSpec(spec);

  assert.equal(evaluatePermission(policy, { capability: "read", resource: "/repo/README.md" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "write", resource: "/repo/var/scratch/out.md" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "execute", resource: "/repo/scripts/a.js" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "memory", action: "read", resource: "project" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "memory", action: "write", resource: "project" }).allowed, true);
  assert.equal(evaluatePermission(policy, { capability: "memory", action: "read", resource: "self" }).allowed, false);
});

test("allows child policies that are strict subsets of the parent", () => {
  const parent = normalizePermissionPolicy({
    rules: [
      { capability: "read", effect: "allow", resource: "/repo" },
      { capability: "write", effect: "allow", resource: "/repo/var/scratch" },
      { capability: "network", action: "fetch", effect: "allow", resource: "*" },
      { capability: "database", action: "query", effect: "allow", resource: "aperio" },
      { capability: "memory", action: "read", effect: "allow", resource: "*" },
    ],
  });
  const child = normalizePermissionPolicy({
    rules: [
      { capability: "read", effect: "allow", resource: "/repo/docs" },
      { capability: "write", effect: "allow", resource: "/repo/var/scratch/child" },
      { capability: "network", action: "fetch", effect: "allow", resource: "docs.example.com" },
      { capability: "database", action: "query", effect: "allow", resource: "aperio" },
      { capability: "memory", action: "read", effect: "allow", resource: "project" },
      { capability: "execute", effect: "deny", resource: "*" },
    ],
  });

  assert.equal(assertPermissionNarrowing(parent, child), true);
});

test("rejects child widening outside the parent allow envelope", () => {
  const parent = normalizePermissionPolicy({
    rules: [
      { capability: "read", effect: "allow", resource: "/repo/docs" },
      { capability: "network", action: "fetch", effect: "allow", resource: "docs.example.com" },
      { capability: "database", action: "query", effect: "allow", resource: "aperio" },
      { capability: "memory", action: "read", effect: "allow", resource: "project" },
    ],
  });

  assert.throws(
    () => assertPermissionNarrowing(parent, { rules: [{ capability: "read", effect: "allow", resource: "/repo" }] }),
    error => error instanceof AgentPermissionNarrowingError && error.reason === "parent-allow-too-narrow",
  );
  assert.throws(
    () => assertPermissionNarrowing(parent, { rules: [{ capability: "network", action: "fetch", effect: "allow", resource: "api.example.com" }] }),
    error => error instanceof AgentPermissionNarrowingError && error.reason === "no-parent-allow",
  );
  assert.throws(
    () => assertPermissionNarrowing(parent, { rules: [{ capability: "database", action: "execute", effect: "allow", resource: "aperio" }] }),
    error => error instanceof AgentPermissionNarrowingError && error.reason === "no-parent-allow",
  );
  assert.throws(
    () => assertPermissionNarrowing(parent, { rules: [{ capability: "memory", action: "write", effect: "allow", resource: "project" }] }),
    error => error instanceof AgentPermissionNarrowingError && error.reason === "no-parent-allow",
  );
});

test("rejects child allows that cross an earlier parent deny", () => {
  const parent = normalizePermissionPolicy({
    rules: [
      { capability: "read", effect: "deny", resource: "/repo/private" },
      { capability: "read", effect: "allow", resource: "/repo" },
    ],
  });

  assert.throws(
    () => assertPermissionNarrowing(parent, { rules: [{ capability: "read", effect: "allow", resource: "/repo" }] }),
    error => error instanceof AgentPermissionNarrowingError && error.reason === "blocked-by-parent-deny",
  );
  assert.equal(
    assertPermissionNarrowing(parent, { rules: [{ capability: "read", effect: "allow", resource: "/repo/public" }] }),
    true,
  );
});

test("rejects malformed policies and unknown rule fields", () => {
  assert.throws(() => normalizePermissionPolicy({}), /\.rules: must be an array/);
  assert.throws(
    () => normalizePermissionPolicy({ rules: [{ capability: "read", effect: "allow", grant: "*" }] }),
    /unknown field "grant"/,
  );
  assert.throws(
    () => normalizePermissionPolicy({ rules: [{ capability: "shell", effect: "allow" }] }),
    /\.rules\[0\]\.capability: must be one of/,
  );
  assert.throws(
    () => normalizePermissionPolicy({ rules: [{ capability: "read", effect: "maybe" }] }),
    /\.rules\[0\]\.effect: must be one of/,
  );
});
