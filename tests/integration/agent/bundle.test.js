import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadAgentBundle, AgentBundleError } from "../../../lib/agent/bundle.js";
import { normalizeAgentSpec } from "../../../lib/agent/spec.js";

function makeBundle() {
  const root = mkdtempSync(join(tmpdir(), "aperio-agent-bundle-"));
  const bundleDir = join(root, "reviewer");
  mkdirSync(bundleDir, { recursive: true });
  return { root, bundleDir };
}

test("loads AGENT.md, permissions, memory scopes, output schema, and skill dir", () => {
  const { root, bundleDir } = makeBundle();
  try {
    writeFileSync(join(bundleDir, "AGENT.md"), "Review narrowly.\n", "utf8");
    writeFileSync(join(bundleDir, "permissions.json"), JSON.stringify({
      toolAllowlist: ["read_file", "code_search"],
      filesystem: { read: ["/repo"], write: ["/repo/var/scratch"] },
      timeoutMs: 60_000,
    }), "utf8");
    writeFileSync(join(bundleDir, "memory-scopes.json"), JSON.stringify([{ name: "project", access: "read" }]), "utf8");
    writeFileSync(join(bundleDir, "output.schema.json"), JSON.stringify({
      type: "object",
      properties: { verdict: { type: "string" } },
    }), "utf8");
    mkdirSync(join(bundleDir, "skills", "audit"), { recursive: true });
    writeFileSync(join(bundleDir, "skills", "audit", "SKILL.md"), "---\nname: audit\ndescription: Audit\n---\n\nAudit.", "utf8");

    const loaded = loadAgentBundle({
      root,
      bundleDir: "reviewer",
      baseSpec: { id: "base", toolAllowlist: null },
    });

    assert.equal(loaded.spec.identity.prompt, "Review narrowly.");
    assert.deepEqual(loaded.spec.toolAllowlist, ["read_file", "code_search"]);
    assert.deepEqual(loaded.spec.memoryScopes, [{ name: "project", access: "read" }]);
    assert.equal(loaded.spec.outputSchema.properties.verdict.type, "string");
    assert.deepEqual(loaded.skillDirs, [join(bundleDir, "skills")]);
    assert.equal(loaded.bundle.dir, bundleDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("administrator spec wins for prompt and rejects wider tools", () => {
  const { root, bundleDir } = makeBundle();
  try {
    writeFileSync(join(bundleDir, "AGENT.md"), "Bundle prompt.", "utf8");
    writeFileSync(join(bundleDir, "permissions.json"), JSON.stringify({
      toolAllowlist: ["read_file", "write_file"],
    }), "utf8");
    const adminSpec = normalizeAgentSpec({
      id: "admin",
      identity: { prompt: "Admin prompt." },
      toolAllowlist: ["read_file"],
    });

    assert.throws(
      () => loadAgentBundle({ root, bundleDir: "reviewer", baseSpec: adminSpec, adminSpec }),
      /write_file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("administrator filesystem policy must cover bundle permissions", () => {
  const { root, bundleDir } = makeBundle();
  try {
    writeFileSync(join(bundleDir, "permissions.json"), JSON.stringify({
      filesystem: { read: ["/repo/subdir"] },
    }), "utf8");
    const adminSpec = normalizeAgentSpec({
      id: "admin",
      filesystem: { read: ["/repo"] },
      toolAllowlist: null,
    });
    const loaded = loadAgentBundle({ root, bundleDir: "reviewer", baseSpec: adminSpec, adminSpec });
    assert.deepEqual(loaded.spec.filesystem.read, ["/repo/subdir"]);

    writeFileSync(join(bundleDir, "permissions.json"), JSON.stringify({
      filesystem: { read: ["/other"] },
    }), "utf8");
    assert.throws(
      () => loadAgentBundle({ root, bundleDir: "reviewer", baseSpec: adminSpec, adminSpec }),
      /widens parent policy/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported security-sensitive bundle fields", () => {
  const { root, bundleDir } = makeBundle();
  try {
    writeFileSync(join(bundleDir, "permissions.json"), JSON.stringify({
      provider: { name: "ollama", model: "qwen3:4b" },
    }), "utf8");
    assert.throws(
      () => loadAgentBundle({ root, bundleDir: "reviewer", baseSpec: { id: "base" } }),
      AgentBundleError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
