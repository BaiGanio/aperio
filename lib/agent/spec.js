// Validated runtime contract for chat, background, review, and future delegated
// agents. Phase 4.1 defines and normalizes the shape only; later slices consume
// it at agent construction and permission-evaluation boundaries.

export const AGENT_SPEC_VERSION = 1;

export const AGENT_PROVIDERS = Object.freeze([
  "ollama",
  "llamacpp",
  "anthropic",
  "deepseek",
  "gemini",
  "claude-code",
  "codex",
]);

export const MEMORY_SCOPE_ACCESS = Object.freeze([
  "read",
  "write",
  "read-write",
  "none",
]);

export const INTERRUPT_MODES = Object.freeze([
  "default",
  "always",
  "never",
]);

const TOP_LEVEL_KEYS = new Set([
  "version",
  "id",
  "description",
  "provider",
  "model",
  "identity",
  "persona",
  "character",
  "skills",
  "memoryScopes",
  "toolAllowlist",
  "filesystem",
  "interruptPolicy",
  "timeoutMs",
  "recursionDepth",
  "concurrency",
  "outputSchema",
]);

const PROVIDER_KEYS = new Set(["name", "model"]);
const IDENTITY_KEYS = new Set(["name", "persona", "prompt"]);
const MEMORY_SCOPE_KEYS = new Set(["name", "access"]);
const FILESYSTEM_KEYS = new Set(["read", "write", "execute"]);
const INTERRUPT_KEYS = new Set(["mode", "allowEdit", "timeoutMs"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(path, message) {
  throw new TypeError(`Invalid AgentSpec ${path}: ${message}`);
}

function rejectUnknown(obj, allowed, path) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(path, `unknown field "${key}"`);
  }
}

function stringField(value, path, { required = false, max = 512, pattern = null } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(path, "is required");
    return null;
  }
  if (typeof value !== "string") fail(path, "must be a string");
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) fail(path, "must be a non-empty string");
    return null;
  }
  if (trimmed.length > max) fail(path, `must be at most ${max} characters`);
  if (pattern && !pattern.test(trimmed)) fail(path, "contains unsupported characters");
  return trimmed;
}

function stringArray(value, path, { nullable = false } = {}) {
  if (value === undefined) return [];
  if (value === null && nullable) return null;
  if (!Array.isArray(value)) fail(path, "must be an array");
  const seen = new Set();
  const out = [];
  value.forEach((item, index) => {
    const s = stringField(item, `${path}[${index}]`, { required: true, max: 512 });
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  });
  return out;
}

function nonNegativeInteger(value, path, { max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    fail(path, `must be an integer between 0 and ${max}`);
  }
  return value;
}

function positiveInteger(value, path, { max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    fail(path, `must be an integer between 1 and ${max}`);
  }
  return value;
}

function cloneJson(value, path) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail(path, "must be a JSON Schema object");
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail(path, "must be JSON-serializable");
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function normalizeProvider(spec) {
  const providerInput = spec.provider ?? {};
  if (providerInput !== null && !isPlainObject(providerInput)) fail(".provider", "must be an object");
  if (providerInput) rejectUnknown(providerInput, PROVIDER_KEYS, ".provider");

  const providerName = stringField(providerInput?.name, ".provider.name", { max: 64 });
  if (providerName && !AGENT_PROVIDERS.includes(providerName)) {
    fail(".provider.name", `must be one of ${AGENT_PROVIDERS.join(", ")}`);
  }

  const modelFromProvider = stringField(providerInput?.model, ".provider.model", { max: 256 });
  const modelFromTop = stringField(spec.model, ".model", { max: 256 });
  const model = modelFromProvider ?? modelFromTop;
  if (modelFromProvider && modelFromTop && modelFromProvider !== modelFromTop) {
    fail(".model", "conflicts with provider.model");
  }

  return Object.freeze({
    name: providerName,
    model,
  });
}

function normalizeIdentity(spec) {
  const identity = spec.identity ?? {};
  if (!isPlainObject(identity)) fail(".identity", "must be an object");
  rejectUnknown(identity, IDENTITY_KEYS, ".identity");

  const personaFromIdentity = stringField(identity.persona, ".identity.persona", { max: 96 });
  const personaFromTop = stringField(spec.persona, ".persona", { max: 96 });
  if (personaFromIdentity && personaFromTop && personaFromIdentity !== personaFromTop) {
    fail(".persona", "conflicts with identity.persona");
  }

  return Object.freeze({
    name: stringField(identity.name, ".identity.name", { max: 128 }),
    persona: personaFromIdentity ?? personaFromTop,
    prompt: stringField(identity.prompt, ".identity.prompt", { max: 20_000 }),
  });
}

function normalizeMemoryScope(item, index) {
  if (typeof item === "string") {
    return Object.freeze({ name: stringField(item, `.memoryScopes[${index}]`, { required: true, max: 128 }), access: "read" });
  }
  if (!isPlainObject(item)) fail(`.memoryScopes[${index}]`, "must be a string or object");
  rejectUnknown(item, MEMORY_SCOPE_KEYS, `.memoryScopes[${index}]`);
  const name = stringField(item.name, `.memoryScopes[${index}].name`, { required: true, max: 128 });
  const access = stringField(item.access, `.memoryScopes[${index}].access`, { max: 32 }) ?? "read";
  if (!MEMORY_SCOPE_ACCESS.includes(access)) {
    fail(`.memoryScopes[${index}].access`, `must be one of ${MEMORY_SCOPE_ACCESS.join(", ")}`);
  }
  return Object.freeze({ name, access });
}

function normalizeMemoryScopes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(".memoryScopes", "must be an array");
  const byName = new Map();
  value.forEach((item, index) => {
    const scope = normalizeMemoryScope(item, index);
    byName.set(scope.name, scope);
  });
  return Object.freeze([...byName.values()]);
}

function normalizeFilesystem(value) {
  const fs = value ?? {};
  if (!isPlainObject(fs)) fail(".filesystem", "must be an object");
  rejectUnknown(fs, FILESYSTEM_KEYS, ".filesystem");
  return Object.freeze({
    read: Object.freeze(stringArray(fs.read, ".filesystem.read")),
    write: Object.freeze(stringArray(fs.write, ".filesystem.write")),
    execute: Object.freeze(stringArray(fs.execute, ".filesystem.execute")),
  });
}

function normalizeInterruptPolicy(value) {
  const policy = value ?? {};
  if (!isPlainObject(policy)) fail(".interruptPolicy", "must be an object");
  rejectUnknown(policy, INTERRUPT_KEYS, ".interruptPolicy");
  const mode = stringField(policy.mode, ".interruptPolicy.mode", { max: 32 }) ?? "default";
  if (!INTERRUPT_MODES.includes(mode)) {
    fail(".interruptPolicy.mode", `must be one of ${INTERRUPT_MODES.join(", ")}`);
  }
  if (policy.allowEdit !== undefined && typeof policy.allowEdit !== "boolean") {
    fail(".interruptPolicy.allowEdit", "must be a boolean");
  }
  return Object.freeze({
    mode,
    allowEdit: policy.allowEdit ?? true,
    timeoutMs: positiveInteger(policy.timeoutMs, ".interruptPolicy.timeoutMs", { max: 86_400_000, fallback: null }),
  });
}

export function normalizeAgentSpec(input) {
  if (!isPlainObject(input)) fail("", "must be an object");
  rejectUnknown(input, TOP_LEVEL_KEYS, "");

  const version = positiveInteger(input.version, ".version", { max: AGENT_SPEC_VERSION, fallback: AGENT_SPEC_VERSION });
  if (version !== AGENT_SPEC_VERSION) fail(".version", `must be ${AGENT_SPEC_VERSION}`);

  const spec = {
    version,
    id: stringField(input.id, ".id", {
      required: true,
      max: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    }),
    description: stringField(input.description, ".description", { max: 1_000 }),
    provider: normalizeProvider(input),
    identity: normalizeIdentity(input),
    character: stringField(input.character, ".character", { max: 128 }),
    skills: Object.freeze(stringArray(input.skills, ".skills")),
    memoryScopes: normalizeMemoryScopes(input.memoryScopes),
    toolAllowlist: Object.freeze(stringArray(input.toolAllowlist, ".toolAllowlist", { nullable: true })),
    filesystem: normalizeFilesystem(input.filesystem),
    interruptPolicy: normalizeInterruptPolicy(input.interruptPolicy),
    timeoutMs: positiveInteger(input.timeoutMs, ".timeoutMs", { max: 86_400_000, fallback: null }),
    recursionDepth: nonNegativeInteger(input.recursionDepth, ".recursionDepth", { max: 16, fallback: 0 }),
    concurrency: positiveInteger(input.concurrency, ".concurrency", { max: 64, fallback: 1 }),
    outputSchema: cloneJson(input.outputSchema, ".outputSchema"),
  };

  return deepFreeze(spec);
}

export function validateAgentSpec(input) {
  normalizeAgentSpec(input);
  return true;
}
