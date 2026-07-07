import { existsSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";
import { normalizeAgentSpec } from "./spec.js";
import {
  assertPermissionNarrowing,
  createPermissionPolicyFromAgentSpec,
} from "../security/agentPermissions.js";

const PERMISSION_KEYS = new Set([
  "description",
  "skills",
  "toolAllowlist",
  "filesystem",
  "memoryScopes",
  "interruptPolicy",
  "timeoutMs",
  "recursionDepth",
  "concurrency",
  "outputSchema",
]);

export class AgentBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentBundleError";
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readTextIfExists(path) {
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) throw new AgentBundleError(`${path} is not a file`);
  return readFileSync(path, "utf8").trim();
}

function readJsonIfExists(path) {
  const text = readTextIfExists(path);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AgentBundleError(`${path} is not valid JSON: ${err.message}`);
  }
}

function rejectUnknownPermissionFields(input, path) {
  if (input == null) return;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new AgentBundleError(`${path} must be a JSON object`);
  }
  for (const key of Object.keys(input)) {
    if (!PERMISSION_KEYS.has(key)) {
      throw new AgentBundleError(`${path} contains unsupported field "${key}"`);
    }
  }
}

function resolveBundleDir(root, bundleDir) {
  if (!bundleDir) return null;
  const dir = resolve(root || process.cwd(), bundleDir);
  if (!existsSync(dir)) throw new AgentBundleError(`Agent bundle not found: ${dir}`);
  if (!statSync(dir).isDirectory()) throw new AgentBundleError(`Agent bundle is not a directory: ${dir}`);
  return dir;
}

function hasPolicyRules(spec) {
  const policy = createPermissionPolicyFromAgentSpec(spec);
  return policy.rules.length > 0;
}

function validateToolNarrowing(adminSpec, bundleToolAllowlist) {
  if (!adminSpec || bundleToolAllowlist === undefined) return;
  if (adminSpec.toolAllowlist === null) return;
  if (bundleToolAllowlist === null) {
    throw new AgentBundleError("Agent bundle cannot widen tool allowlist beyond administrator policy");
  }
  const adminTools = new Set(adminSpec.toolAllowlist ?? []);
  for (const tool of bundleToolAllowlist ?? []) {
    if (!adminTools.has(tool)) {
      throw new AgentBundleError(`Agent bundle tool "${tool}" is not allowed by administrator policy`);
    }
  }
}

function validateLimitNarrowing(adminSpec, patch) {
  if (!adminSpec) return;
  if (patch.timeoutMs != null && adminSpec.timeoutMs != null && patch.timeoutMs > adminSpec.timeoutMs) {
    throw new AgentBundleError("Agent bundle timeoutMs exceeds administrator policy");
  }
  if (patch.recursionDepth != null && patch.recursionDepth > adminSpec.recursionDepth) {
    throw new AgentBundleError("Agent bundle recursionDepth exceeds administrator policy");
  }
  if (patch.concurrency != null && patch.concurrency > adminSpec.concurrency) {
    throw new AgentBundleError("Agent bundle concurrency exceeds administrator policy");
  }

  const policy = patch.interruptPolicy;
  if (!policy) return;
  if (adminSpec.interruptPolicy.mode === "always" && policy.mode && policy.mode !== "always") {
    throw new AgentBundleError("Agent bundle cannot relax administrator interrupt policy");
  }
  if (adminSpec.interruptPolicy.allowEdit === false && policy.allowEdit === true) {
    throw new AgentBundleError("Agent bundle cannot enable interrupt edits denied by administrator policy");
  }
  if (
    policy.timeoutMs != null &&
    adminSpec.interruptPolicy.timeoutMs != null &&
    policy.timeoutMs > adminSpec.interruptPolicy.timeoutMs
  ) {
    throw new AgentBundleError("Agent bundle interrupt timeout exceeds administrator policy");
  }
}

function applyPatch(merged, patch, adminSpec) {
  rejectUnknownPermissionFields(patch, "permissions.json");
  validateToolNarrowing(adminSpec, patch.toolAllowlist);
  validateLimitNarrowing(adminSpec, patch);

  if (patch.description != null && !adminSpec?.description) merged.description = patch.description;
  if (patch.skills != null) merged.skills = patch.skills;
  if (patch.toolAllowlist !== undefined) merged.toolAllowlist = patch.toolAllowlist;
  if (patch.filesystem != null) merged.filesystem = patch.filesystem;
  if (patch.memoryScopes != null) merged.memoryScopes = patch.memoryScopes;
  if (patch.interruptPolicy != null) merged.interruptPolicy = patch.interruptPolicy;
  if (patch.timeoutMs != null) merged.timeoutMs = patch.timeoutMs;
  if (patch.recursionDepth != null) merged.recursionDepth = patch.recursionDepth;
  if (patch.concurrency != null) merged.concurrency = patch.concurrency;
  if (patch.outputSchema != null && !adminSpec?.outputSchema) merged.outputSchema = patch.outputSchema;
}

export function loadAgentBundle({ root = process.cwd(), bundleDir = null, baseSpec, adminSpec = null } = {}) {
  const base = normalizeAgentSpec(baseSpec);
  const dir = resolveBundleDir(root, bundleDir);
  if (!dir) return { spec: base, bundle: null, skillDirs: [] };

  const merged = cloneJson(base);
  const agentPrompt = readTextIfExists(join(dir, "AGENT.md"));
  if (agentPrompt && !adminSpec?.identity?.prompt) {
    merged.identity = { ...(merged.identity ?? {}), prompt: agentPrompt };
  }

  const permissions = readJsonIfExists(join(dir, "permissions.json"));
  if (permissions) applyPatch(merged, permissions, adminSpec);

  const memoryScopes = readJsonIfExists(join(dir, "memory-scopes.json"));
  if (memoryScopes) {
    applyPatch(
      merged,
      { memoryScopes: Array.isArray(memoryScopes) ? memoryScopes : memoryScopes.memoryScopes },
      adminSpec,
    );
  }

  const outputSchema = readJsonIfExists(join(dir, "output.schema.json")) ??
    readJsonIfExists(join(dir, "output-schema.json"));
  if (outputSchema && !adminSpec?.outputSchema) merged.outputSchema = outputSchema;

  const spec = normalizeAgentSpec(merged);
  if (adminSpec && hasPolicyRules(spec)) {
    assertPermissionNarrowing(
      createPermissionPolicyFromAgentSpec(adminSpec),
      createPermissionPolicyFromAgentSpec(spec),
    );
  }

  const skillsDir = join(dir, "skills");
  const skillDirs = existsSync(skillsDir) && statSync(skillsDir).isDirectory()
    ? [skillsDir]
    : [];

  return {
    spec,
    bundle: Object.freeze({ dir, hasAgentPrompt: Boolean(agentPrompt), hasPermissions: Boolean(permissions) }),
    skillDirs,
  };
}
