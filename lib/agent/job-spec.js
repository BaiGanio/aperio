import { normalizeAgentSpec } from "./spec.js";

function makeSpecId(prefix, value) {
  const slug = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 96);
  return `${prefix}.${slug || "default"}`;
}

export function buildBackgroundJobSpec(job = {}) {
  const legacyProvider = job.provider && typeof job.provider === "object" ? job.provider : null;
  return normalizeAgentSpec({
    ...(job.spec ?? {}),
    id: job.spec?.id ?? makeSpecId("background", job.id),
    description: job.spec?.description ?? `Background job ${job.id}`,
    provider: {
      name: job.spec?.provider?.name ?? legacyProvider?.name,
      model: job.spec?.provider?.model ?? legacyProvider?.model,
    },
    identity: {
      ...(job.spec?.identity ?? {}),
      persona: job.spec?.identity?.persona ?? job.persona,
    },
    character: job.spec?.character ?? job.character,
    timeoutMs: job.spec?.timeoutMs ?? job.timeoutMs,
    toolAllowlist: job.spec?.toolAllowlist ?? null,
  });
}

export function normalizeAgentJobDefinition(job = {}) {
  const { provider, persona, character, spec: _spec, created_at, updated_at, ...rest } = job;
  const normalized = { ...rest };
  const needsSpec = typeof job.prompt === "string" && job.prompt.trim().length > 0;
  if (needsSpec || job.spec) normalized.spec = buildBackgroundJobSpec(job);
  if (created_at !== undefined) normalized.created_at = created_at;
  if (updated_at !== undefined) normalized.updated_at = updated_at;
  return normalized;
}

export function buildRoundtableAgentSpec({ id, description, providerConfig, persona, character } = {}) {
  return normalizeAgentSpec({
    id: makeSpecId("roundtable", id ?? persona),
    description,
    provider: {
      name: providerConfig?.name,
      model: providerConfig?.model,
    },
    identity: { persona },
    character,
    toolAllowlist: null,
  });
}
