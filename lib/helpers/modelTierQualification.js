export const QUALIFICATION_SUITE_VERSION = 1;
export const QUALIFICATION_CASE_COUNT = 14;

const STATE_RESET_MODES = new Set(["fresh-session"]);
const STATE_RESTORE_MODES = new Set(["fixture-and-workspace"]);

export function validateQualificationStateContract(caseDef) {
  const at = `case ${caseDef?.id ?? "unknown"}.stateContract`;
  const contract = caseDef?.stateContract;
  if (!contract || typeof contract !== "object") throw new Error(`${at} is required`);
  if (!STATE_RESET_MODES.has(contract.reset)) throw new Error(`${at}.reset is unsupported`);
  if (!STATE_RESTORE_MODES.has(contract.restore)) throw new Error(`${at}.restore is unsupported`);
  if (!Array.isArray(contract.mutations) || contract.mutations.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${at}.mutations must be an array of descriptions`);
  }
  return {
    reset: contract.reset,
    restore: contract.restore,
    mutations: [...contract.mutations],
  };
}

export function validateQualificationSuite(cases) {
  if (!Array.isArray(cases) || cases.length !== QUALIFICATION_CASE_COUNT) {
    throw new Error(`qualification suite must contain exactly ${QUALIFICATION_CASE_COUNT} cases`);
  }
  for (const caseDef of cases) validateQualificationStateContract(caseDef);
  return cases;
}

export function validateQualificationFixture(fixture, contract) {
  if (!contract || contract.version !== QUALIFICATION_SUITE_VERSION) {
    throw new Error("qualification fixture contract version is unsupported");
  }
  if (contract.reset?.beforeSuite !== "fresh-database"
    || contract.reset?.beforeRetry !== "fresh-session"
    || contract.reset?.restore !== "fixture-and-workspace"
    || contract.reset?.generatedState !== "runner-owned-only") {
    throw new Error("qualification fixture reset contract is incomplete");
  }
  if (!Array.isArray(fixture?.memories)) throw new Error("qualification fixture must contain memories");
  const tag = String(contract.tag ?? "");
  const tagged = fixture.memories.filter(memory => Array.isArray(memory.tags) && memory.tags.includes(tag));
  if (tagged.length !== contract.memoryCount) {
    throw new Error(`qualification fixture must contain exactly ${contract.memoryCount} ${tag} memories`);
  }
  if (fixture.memories.length !== contract.memoryCount) {
    throw new Error(`qualification fixture must contain exactly ${contract.memoryCount} memories`);
  }
  if (tagged.some(memory => !memory.type || !memory.title || !memory.content)) {
    throw new Error("qualification fixture memories must have type, title, and content");
  }
  return { memoryCount: tagged.length, tag };
}
