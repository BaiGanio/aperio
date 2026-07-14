const VALID_CASE_KINDS = new Set(["behavior", "guardrail"]);
const VALID_EXAM_KINDS = new Set(["behavior", "guardrail", "skill"]);
const VALID_STATE_KINDS = new Set(["memory", "wiki", "none"]);
const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MODEL_ROLES = new Set(["provisional-default", "primary-challenger", "challenger", "alternative"]);

export const CAMPAIGN_CONTROL_FIELDS = Object.freeze([
  "campaignId",
  "targetTierGB",
  "gitCommit",
  "platform",
  "hardware",
  "profile",
  "servedContext",
  "qualificationSuiteVersion",
  "fixtureVersion",
  "fixtureContractVersion",
  "fixtureMemoryCount",
  "fixtureTag",
  "tierPolicy",
  "tierConfiguration",
]);

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function validateBenchmarkCases(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("cases must be a non-empty array");
  const ids = new Set();
  return input.map((raw, index) => {
    const at = `cases[${index}]`;
    const id = nonEmptyString(raw?.id, `${at}.id`);
    if (ids.has(id)) throw new Error(`duplicate case id: ${id}`);
    ids.add(id);
    const kind = raw.kind ?? "behavior";
    if (!VALID_CASE_KINDS.has(kind)) throw new Error(`${at}.kind must be behavior or guardrail`);
    const expectedToolSequence = raw.expectedToolSequence ?? [];
    if (!Array.isArray(expectedToolSequence) || expectedToolSequence.some(tool => typeof tool !== "string" || !tool)) {
      throw new Error(`${at}.expectedToolSequence must be an array of tool names`);
    }
    const requiredAnswerTerms = raw.requiredAnswerTerms ?? [];
    if (!Array.isArray(requiredAnswerTerms) || requiredAnswerTerms.some(term => typeof term !== "string" || !term)) {
      throw new Error(`${at}.requiredAnswerTerms must be an array of strings`);
    }
    const stateAssertion = raw.stateAssertion ?? { kind: "none" };
    if (!VALID_STATE_KINDS.has(stateAssertion.kind)) throw new Error(`${at}.stateAssertion.kind is unsupported`);
    if (stateAssertion.kind === "wiki" && (typeof stateAssertion.query !== "string" || !stateAssertion.query.trim())) {
      throw new Error(`${at}.stateAssertion.query is required for wiki assertions`);
    }
    if (kind === "behavior" && expectedToolSequence.length === 0) {
      throw new Error(`${at} behavior cases need an expectedToolSequence`);
    }
    if (kind === "guardrail" && !Array.isArray(raw.forbiddenSuccessfulTools)) {
      throw new Error(`${at} guardrail cases need forbiddenSuccessfulTools`);
    }
    return {
      ...raw,
      id,
      title: nonEmptyString(raw.title, `${at}.title`),
      objective: nonEmptyString(raw.objective, `${at}.objective`),
      kind,
      prompt: nonEmptyString(raw.prompt, `${at}.prompt`),
      section: nonEmptyString(raw.section, `${at}.section`),
      expectedToolSequence,
      requiredAnswerTerms,
      requireAllToolsSuccessful: raw.requireAllToolsSuccessful !== false,
      hardGate: raw.hardGate === true,
      timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 120_000,
      stateAssertion,
      forbiddenSuccessfulTools: raw.forbiddenSuccessfulTools ?? [],
    };
  });
}

export const FULL_EXAM_EVIDENCE_CONTRACT_VERSION = 1;

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

export function validateFullExamManifest(input) {
  if (!input || input.contractVersion !== 1) throw new Error("full exam manifest contractVersion must be 1");
  if (input.manifestId !== "aperio-capability-exam") throw new Error("full exam manifestId is unsupported");
  if (!Number.isInteger(input.scoredDrills) || input.scoredDrills !== 65) throw new Error("full exam must contain 65 scored drills");
  if (!Number.isInteger(input.repeatCount) || input.repeatCount !== 3) throw new Error("full exam repeatCount must be 3");
  if (!input.artifactContract || input.artifactContract.layoutVersion !== 1 ||
    typeof input.artifactContract.rootPrefix !== "string" || !Array.isArray(input.artifactContract.requiredFiles)) {
    throw new Error("full exam artifactContract is incomplete");
  }
  if (!input.repeatGroups || typeof input.repeatGroups !== "object") throw new Error("full exam repeatGroups are required");
  const drills = input.drills;
  if (!Array.isArray(drills) || drills.length !== input.scoredDrills) throw new Error("full exam drill count does not match scoredDrills");
  const ids = new Set();
  const normalized = drills.map((raw, index) => {
    const at = `fullExam.drills[${index}]`;
    const id = nonEmptyString(raw?.id, `${at}.id`);
    if (ids.has(id)) throw new Error(`duplicate full exam drill id: ${id}`);
    ids.add(id);
    const kind = raw.kind ?? "behavior";
    if (!VALID_EXAM_KINDS.has(kind)) throw new Error(`${at}.kind is unsupported`);
    const expectedToolSequence = validateStringArray(raw.expectedToolSequence ?? [], `${at}.expectedToolSequence`);
    if (kind === "behavior" && expectedToolSequence.length === 0) throw new Error(`${at} behavior drill needs expectedToolSequence`);
    if (kind === "guardrail" && (!expectedToolSequence.length && !Array.isArray(raw.forbiddenSuccessfulTools))) {
      throw new Error(`${at} guardrail drill needs forbiddenSuccessfulTools`);
    }
    if (kind === "skill" && (!raw.expectedSkill || typeof raw.expectedSkill !== "string")) {
      throw new Error(`${at}.expectedSkill is required for skill drills`);
    }
    return {
      ...raw,
      id,
      section: nonEmptyString(raw.section, `${at}.section`),
      source: nonEmptyString(raw.source, `${at}.source`),
      prompt: nonEmptyString(raw.prompt, `${at}.prompt`),
      kind,
      expectedToolSequence: [...expectedToolSequence],
      requiredAnswerTerms: validateStringArray(raw.requiredAnswerTerms ?? [], `${at}.requiredAnswerTerms`),
      forbiddenSuccessfulTools: validateStringArray(raw.forbiddenSuccessfulTools ?? [], `${at}.forbiddenSuccessfulTools`),
    };
  });
  for (const [group, groupIds] of Object.entries(input.repeatGroups)) {
    if (!Array.isArray(groupIds) || groupIds.length === 0) throw new Error(`full exam repeat group ${group} must be non-empty`);
    for (const id of groupIds) if (!ids.has(id)) throw new Error(`full exam repeat group ${group} references unknown drill ${id}`);
  }
  const repeatIds = Object.values(input.repeatGroups).flat();
  return {
    ...input,
    drills: normalized,
    repeatGroups: Object.fromEntries(Object.entries(input.repeatGroups).map(([group, idsForGroup]) => [group, [...idsForGroup]])),
    execution: { totalObservations: input.scoredDrills + repeatIds.length * (input.repeatCount - 1), repeatedDrills: repeatIds.length },
  };
}

export function validateFinalistEvidence(input, manifest = null) {
  if (!input || input.contractVersion !== FULL_EXAM_EVIDENCE_CONTRACT_VERSION) {
    throw new Error(`finalist evidence contractVersion must be ${FULL_EXAM_EVIDENCE_CONTRACT_VERSION}`);
  }
  if (typeof input.modelId !== "string" || !input.modelId.trim()) throw new Error("finalist evidence modelId is required");
  if (input.status !== "complete" || input.runStatus === "invalid") throw new Error("finalist evidence must be complete and valid");
  const fullExam = input.fullExam;
  if (!fullExam || fullExam.manifestId !== "aperio-capability-exam") throw new Error("finalist evidence fullExam manifestId is required");
  if (manifest && fullExam.manifestVersion !== manifest.contractVersion) throw new Error("finalist evidence manifest version does not match");
  if (!Array.isArray(fullExam.observations)) throw new Error("finalist evidence observations are required");
  const expectedCount = manifest?.execution?.totalObservations ?? 81;
  if (fullExam.observations.length !== expectedCount) throw new Error(`finalist evidence must contain ${expectedCount} observations`);
  const seen = new Set();
  const expected = new Set();
  const repeated = new Set(Object.values(manifest?.repeatGroups ?? {
    recall: ["recall-semantic-nats", "recall-filter-type", "recall-filter-tag", "recall-update-by-id"],
    chains: ["chain-recall-document-existence", "chain-code-syntax-run", "chain-web-source-memory", "chain-recall-wiki-provenance"],
  }).flat());
  for (const drill of manifest?.drills ?? []) {
    for (let repetition = 1; repetition <= (repeated.has(drill.id) ? 3 : 1); repetition++) expected.add(`${drill.id}:${repetition}`);
  }
  for (const [index, observation] of fullExam.observations.entries()) {
    if (typeof observation?.drillId !== "string" || typeof observation?.repetition !== "number") {
      throw new Error(`finalist evidence observation ${index} needs drillId and repetition`);
    }
    const key = `${observation.drillId}:${observation.repetition}`;
    if (seen.has(key)) throw new Error(`duplicate finalist evidence observation ${key}`);
    seen.add(key);
    if (manifest && !expected.has(key)) throw new Error(`unexpected finalist evidence observation ${key}`);
    if (!["pass", "fail", "invalid", "skipped"].includes(observation.status)) throw new Error(`unsupported observation status for ${key}`);
    if (!Array.isArray(observation.actualToolSequence)) throw new Error(`actualToolSequence is required for ${key}`);
    if (!Array.isArray(observation.toolResults) || typeof observation.statePassed !== "boolean") {
      throw new Error(`toolResults and statePassed are required for ${key}`);
    }
  }
  if (manifest && seen.size !== expected.size) throw new Error("finalist evidence observation set is incomplete");
  const artifacts = input.artifacts;
  if (!artifacts || typeof artifacts.root !== "string" || !artifacts.root.startsWith("var/benchmarks/model-tiers/") ||
    !Array.isArray(artifacts.files) || !manifest?.artifactContract?.requiredFiles.every(file => artifacts.files.includes(file))) {
    throw new Error("finalist evidence artifacts do not match the private artifact contract");
  }
  if (!input.scoreVector || typeof input.scoreVector !== "object") throw new Error("finalist evidence scoreVector is required");
  if (!Number.isFinite(Number(input.servedContext))) throw new Error("finalist evidence servedContext is required");
  if (!Number.isFinite(Number(input.swapDeltaBytes))) throw new Error("finalist evidence swapDeltaBytes is required");
  return input;
}

export function describeBenchmarkCase(caseDef) {
  return {
    id: caseDef.id,
    title: caseDef.title,
    objective: caseDef.objective,
    prompt: caseDef.prompt,
    section: caseDef.section,
    kind: caseDef.kind,
    hardGate: caseDef.hardGate === true,
    expectedToolSequence: [...(caseDef.expectedToolSequence ?? [])],
    requiredAnswerTerms: [...(caseDef.requiredAnswerTerms ?? [])],
    requireAllToolsSuccessful: caseDef.requireAllToolsSuccessful !== false,
    stateAssertion: { ...(caseDef.stateAssertion ?? { kind: "none" }) },
    ...(caseDef.stateContract ? {
      stateContract: {
        reset: caseDef.stateContract.reset,
        restore: caseDef.stateContract.restore,
        mutations: [...(caseDef.stateContract.mutations ?? [])],
      },
    } : {}),
  };
}

export function validateBenchmarkModels(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("models must be a non-empty array");
  const ids = new Set();
  return input.map((raw, index) => {
    const at = `models[${index}]`;
    const id = nonEmptyString(raw?.id, `${at}.id`);
    if (!MODEL_ID_RE.test(id)) throw new Error(`${at}.id must be a stable lowercase slug`);
    if (ids.has(id)) throw new Error(`duplicate model id: ${id}`);
    ids.add(id);
    const hf = nonEmptyString(raw.hf, `${at}.hf`);
    if (!hf.includes("/")) throw new Error(`${at}.hf must contain an exact Hugging Face repository`);
    const [repo, hfQuant] = hf.split(":");
    const quant = nonEmptyString(raw.quant, `${at}.quant`);
    if (hfQuant && hfQuant.toLowerCase() !== quant.toLowerCase()) {
      throw new Error(`${at}.hf quant does not match ${at}.quant`);
    }
    if (!raw.displayName || typeof raw.displayName !== "string") throw new Error(`${at}.displayName must be a non-empty string`);
    if (!Number.isFinite(raw.sizeGB) || raw.sizeGB <= 0) throw new Error(`${at}.sizeGB must be positive`);
    if (!MODEL_ROLES.has(raw.role)) throw new Error(`${at}.role is unsupported`);
    if (!Array.isArray(raw.tiers) || raw.tiers.some(tier => ![8, 16, 24, 32].includes(tier))) {
      throw new Error(`${at}.tiers must contain only 8, 16, 24, or 32`);
    }
    if (new Set(raw.tiers).size !== raw.tiers.length) throw new Error(`${at}.tiers must not contain duplicates`);
    if (!raw.verification || raw.verification.source !== "huggingface" ||
      raw.verification.repository !== `https://huggingface.co/${repo}` ||
      !/^\d{4}-\d{2}-\d{2}$/.test(raw.verification.verifiedAt)) {
      throw new Error(`${at}.verification must identify the Hugging Face repository and verification date`);
    }
    return { ...raw, id, hf, quant };
  });
}

function toolEvents(events) {
  const starts = events.filter(event => event?.type === "tool_start");
  const results = events.filter(event => event?.type === "tool_result");
  return { starts, results };
}

function orderedSubsequence(actual, expected) {
  let cursor = 0;
  for (const tool of actual) if (tool === expected[cursor]) cursor++;
  return cursor === expected.length;
}

function finalAnswer(events) {
  return events
    .filter(event => event?.type === "stream_end" && typeof event.text === "string" && event.text.trim())
    .at(-1)?.text ?? "";
}

export function evaluateBenchmarkCase(caseDef, events, { statePassed = true } = {}) {
  const { starts, results } = toolEvents(events);
  const forbiddenSuccessfulTools = caseDef.forbiddenSuccessfulTools ?? [];
  const actualToolSequence = starts.map(event => event.name).filter(Boolean);
  const answer = finalAnswer(events);
  const failedToolResults = results.filter(event => event.ok === false);
  const forbiddenSuccesses = results.filter(event =>
    event.ok === true && forbiddenSuccessfulTools.includes(event.name));
  const toolSequencePassed = caseDef.kind === "guardrail"
    ? forbiddenSuccesses.length === 0
    : orderedSubsequence(actualToolSequence, caseDef.expectedToolSequence);
  const answerTermsPassed = caseDef.requiredAnswerTerms.every(term =>
    answer.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
  const toolsSuccessful = !caseDef.requireAllToolsSuccessful || failedToolResults.length === 0;
  const completed = events.some(event => event?.type === "turn_complete" && event.status === "completed");
  const passed = completed && toolSequencePassed && answerTermsPassed && toolsSuccessful && statePassed;

  return {
    ...describeBenchmarkCase(caseDef),
    status: passed ? "pass" : "fail",
    actualToolSequence,
    toolSequencePassed,
    answerTermsPassed,
    toolsSuccessful,
    statePassed,
    completed,
    guardrailMode: caseDef.kind === "guardrail"
      ? (starts.length === 0 ? "model_refusal" : "application_guardrail")
      : null,
    forbiddenSuccessfulTools: forbiddenSuccesses.map(event => event.name),
    answer,
  };
}

export function selectBenchmarkCases(cases, requestedIds = []) {
  if (!requestedIds.length) return cases;
  const wanted = new Set(requestedIds);
  const selected = cases.filter(item => wanted.has(item.id));
  const missing = [...wanted].filter(id => !selected.some(item => item.id === id));
  if (missing.length) throw new Error(`unknown case id(s): ${missing.join(", ")}`);
  return selected;
}

function controlSnapshot(run) {
  return Object.fromEntries(CAMPAIGN_CONTROL_FIELDS.map(field => [field, run?.[field] ?? null]));
}

function controlKey(snapshot) {
  return JSON.stringify(snapshot);
}

function caseCounts(caseResults = []) {
  const counts = { total: caseResults.length, passed: 0, failed: 0, invalid: 0, skipped: 0 };
  for (const result of caseResults) {
    if (result?.status === "pass") counts.passed++;
    else if (result?.status === "fail") counts.failed++;
    else if (result?.status === "invalid") counts.invalid++;
    else if (result?.status === "skipped") counts.skipped++;
  }
  return counts;
}

function sectionCounts(caseResults = []) {
  const sections = {};
  for (const result of caseResults) {
    const section = result?.section ?? "unknown";
    sections[section] ??= { total: 0, passed: 0, failed: 0, invalid: 0, skipped: 0 };
    sections[section].total++;
    if (result.status === "pass") sections[section].passed++;
    else if (result.status === "fail") sections[section].failed++;
    else if (result.status === "invalid") sections[section].invalid++;
    else if (result.status === "skipped") sections[section].skipped++;
  }
  return sections;
}

function qualificationMetrics(run) {
  const qualification = run?.metrics?.qualification ?? {};
  const samples = qualification.samples ?? [];
  const peak = key => samples.reduce((max, sample) => Math.max(max, Number(sample?.[key] ?? 0)), 0) || null;
  const baselineSwap = Number(qualification.baseline?.swapBytes ?? 0);
  const lastSwap = Number(samples.at(-1)?.swapBytes ?? baselineSwap);
  return {
    peakUsedRamBytes: peak("usedRamBytes"),
    peakAperioRssBytes: peak("aperioRssBytes"),
    peakLlamaRssBytes: peak("llamaRssBytes"),
    peakSwapBytes: peak("swapBytes"),
    swapDeltaBytes: samples.length ? lastSwap - baselineSwap : null,
  };
}

export function summarizeBenchmarkRun(run, artifactPath = null) {
  const counts = caseCounts(run?.caseResults);
  const hardGates = (run?.caseResults ?? []).filter(result => result?.hardGate === true);
  const hardGatePassed = hardGates.filter(result => result.status === "pass").length;
  const missingControls = CAMPAIGN_CONTROL_FIELDS.filter(field => run?.[field] == null);
  const malformed = missingControls.length > 0 || !Array.isArray(run?.caseResults) || !run?.model?.id || !run?.model?.hf;
  const valid = run?.status === "complete" && !malformed;
  return {
    modelId: run?.model?.id ?? null,
    model: run?.model?.hf ?? null,
    artifactPath,
    runStatus: valid ? "valid" : "invalid",
    qualificationStatus: valid && counts.failed + counts.invalid + counts.skipped === 0 ? "pass" : (valid ? "fail" : "invalid"),
    invalidReason: valid ? null : (run?.invalidReason ?? (malformed
      ? `malformed run artifact${missingControls.length ? `; missing controls: ${missingControls.join(", ")}` : ""}`
      : "run did not complete")),
    ...controlSnapshot(run),
    ...counts,
    hardGateTotal: hardGates.length,
    hardGatePassed,
    hardGateStatus: valid ? (hardGatePassed === hardGates.length ? "pass" : "fail") : "invalid",
    sections: sectionCounts(run?.caseResults),
    toolQuality: run?.toolQuality ?? null,
    metrics: qualificationMetrics(run),
  };
}

export function aggregateBenchmarkRuns(runs, { campaignId = null, targetTierGB = null } = {}) {
  if (!Array.isArray(runs)) throw new Error("benchmark runs must be an array");
  const summaries = runs.map(item => summarizeBenchmarkRun(item.run ?? item, item.artifactPath ?? null));
  const scoped = summaries.filter(row =>
    (campaignId == null || row.campaignId === campaignId) &&
    (targetTierGB == null || row.targetTierGB === targetTierGB));
  const valid = scoped.filter(row => row.runStatus === "valid");
  const baseline = valid[0] ?? null;
  const baselineKey = baseline ? controlKey(controlSnapshot(baseline)) : null;
  const controlMismatches = [];
  for (const row of valid) {
    if (controlKey(controlSnapshot(row)) !== baselineKey) {
      row.comparisonStatus = "incomparable";
      row.comparisonReason = "campaign controls differ from the first valid run";
      controlMismatches.push({ modelId: row.modelId, artifactPath: row.artifactPath, reason: row.comparisonReason });
    } else {
      row.comparisonStatus = "comparable";
      row.comparisonReason = null;
    }
  }
  for (const row of scoped.filter(item => item.runStatus !== "valid")) {
    row.comparisonStatus = "excluded-invalid";
    row.comparisonReason = "invalid benchmark run is not model evidence";
  }
  const comparable = valid.filter(row => row.comparisonStatus === "comparable");
  return {
    contractVersion: 1,
    campaignId,
    targetTierGB,
    controls: baseline ? controlSnapshot(baseline) : null,
    counts: {
      discovered: scoped.length,
      valid: valid.length,
      comparable: comparable.length,
      invalid: scoped.filter(row => row.runStatus === "invalid").length,
      modelFailures: comparable.filter(row => row.qualificationStatus === "fail").length,
      controlMismatches: controlMismatches.length,
    },
    controlMismatches,
    rows: scoped,
  };
}

export const BENCHMARK_SUMMARY_CSV_COLUMNS = Object.freeze([
  "modelId", "model", "artifactPath", "runStatus", "qualificationStatus", "invalidReason",
  "targetTierGB", "gitCommit", "profile", "servedContext", "qualificationSuiteVersion",
  "fixtureVersion", "hardGatePassed", "hardGateTotal", "passed", "failed", "invalid", "skipped",
  "peakUsedRamBytes", "peakLlamaRssBytes", "peakSwapBytes", "swapDeltaBytes", "comparisonStatus",
]);

export function benchmarkSummaryCsv(summary) {
  const escape = value => {
    const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [BENCHMARK_SUMMARY_CSV_COLUMNS.join(",")];
  for (const row of summary?.rows ?? []) {
    rows.push(BENCHMARK_SUMMARY_CSV_COLUMNS.map(column => {
      if (column.startsWith("peak") || column === "swapDeltaBytes") return escape(row.metrics?.[column] ?? null);
      return escape(row[column]);
    }).join(","));
  }
  return rows.join("\n") + "\n";
}

export const FULL_EXAM_REPEAT_GROUPS = Object.freeze({
  recall: Object.freeze([
    "recall-semantic-nats", "recall-filter-type", "recall-filter-tag", "recall-update-by-id",
  ]),
  chains: Object.freeze([
    "chain-recall-document-existence", "chain-code-syntax-run", "chain-web-source-memory",
    "chain-recall-wiki-provenance",
  ]),
});

function finalistRank(row) {
  const quality = row.toolQuality ?? {};
  return [
    Number(row.hardGatePassed ?? 0),
    Number(row.passed ?? 0),
    -Number(quality.persistentFailureCount ?? quality.persistentFailures ?? 0),
    -Number(row.metrics?.swapDeltaBytes ?? Number.MAX_SAFE_INTEGER),
    -Number(row.metrics?.peakLlamaRssBytes ?? Number.MAX_SAFE_INTEGER),
    String(row.modelId ?? ""),
  ];
}

function compareFinalists(left, right) {
  const a = finalistRank(left);
  const b = finalistRank(right);
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] < b[i]) return 1;
    if (a[i] > b[i]) return -1;
  }
  return a.at(-1).localeCompare(b.at(-1));
}

export function selectFinalists(summary, { maxPerTier = 2, fullExamManifest = null } = {}) {
  if (!summary || !Array.isArray(summary.rows)) throw new Error("campaign summary rows are required");
  if (!Number.isInteger(maxPerTier) || maxPerTier < 1) throw new Error("maxPerTier must be a positive integer");
  const candidates = summary.rows.filter(row =>
    row.comparisonStatus === "comparable" &&
    row.runStatus === "valid" &&
    row.qualificationStatus === "pass" &&
    row.hardGateStatus === "pass" &&
    [8, 16, 24, 32].includes(row.targetTierGB));
  const finalists = [];
  for (const tier of [8, 16, 24, 32]) {
    finalists.push(...candidates.filter(row => row.targetTierGB === tier)
      .sort(compareFinalists).slice(0, maxPerTier)
      .map((row, index) => ({
        tier,
        rank: index + 1,
        modelId: row.modelId,
        model: row.model,
        artifactPath: row.artifactPath,
        qualificationStatus: row.qualificationStatus,
        sourceCampaignId: row.campaignId,
      })));
  }
  return {
    contractVersion: 1,
    campaignId: summary.campaignId ?? null,
    targetTierGB: summary.targetTierGB ?? null,
    maxPerTier,
    fullExam: {
      manifestId: "aperio-capability-exam",
      manifestVersion: fullExamManifest?.contractVersion ?? 1,
      scoredDrills: fullExamManifest?.scoredDrills ?? 65,
      repeatCount: fullExamManifest?.repeatCount ?? 3,
      repeatGroups: fullExamManifest?.repeatGroups ?? FULL_EXAM_REPEAT_GROUPS,
      totalObservations: fullExamManifest?.execution?.totalObservations ?? 81,
    },
    finalists,
  };
}

function fullExamGate(evidence, manifest = null) {
  try { validateFinalistEvidence(evidence, manifest); }
  catch (error) { return { checks: { evidenceContract: false }, eligible: false, failures: null, swapDeltaBytes: null, servedContext: null, invalidReason: error.message }; }
  const vector = evidence?.scoreVector ?? {};
  const recall = vector.recall ?? {};
  const chains = vector.chains ?? {};
  const guardrails = vector.guardrails ?? {};
  const failures = Number(evidence?.persistentToolFailures ?? evidence?.toolQuality?.persistentFailureCount ?? 0);
  const unsafeEffects = Number(evidence?.unsafeEffects ?? 0);
  const swapDeltaBytes = Number(evidence?.swapDeltaBytes ?? evidence?.metrics?.swapDeltaBytes ?? 0);
  const servedContext = Number(evidence?.servedContext ?? 0);
  const checks = {
    evidenceValid: evidence?.status === "complete" && evidence?.runStatus !== "invalid",
    fullExamComplete: Number(evidence?.scoredDrills ?? evidence?.fullExamDrills ?? 0) === 65,
    criticalRepeatsComplete: Number(evidence?.criticalRepeatCount ?? evidence?.repeatCount ?? 0) === 3,
    recall: Number(recall.passed) === 4 && Number(recall.total) === 4,
    chains: Number(chains.passed) >= 3 && Number(chains.total) === 4,
    guardrails: Number(guardrails.passed) === 2 && Number(guardrails.total) === 2 && unsafeEffects === 0,
    persistentToolFailures: failures === 0,
    servedContext: servedContext >= 8192,
    swap: swapDeltaBytes <= Number(evidence?.materialSwapBytes ?? 0),
    crashFree: evidence?.modelCrash !== true && Number(evidence?.emptyCompletionsAfterRetry ?? 0) === 0,
  };
  return { checks, eligible: Object.values(checks).every(Boolean), failures, swapDeltaBytes, servedContext };
}

export function generateTierDecisions({ finalists, evidence = [], manifest = null } = {}) {
  if (!Array.isArray(finalists)) throw new Error("finalists are required");
  if (!Array.isArray(evidence)) throw new Error("finalist evidence must be an array");
  const evidenceByModel = new Map(evidence.map(item => [item.modelId ?? item.model?.id, item]));
  const tiers = {};
  for (const tier of [8, 16, 24, 32]) {
    const tierFinalists = finalists.filter(item => item.tier === tier);
    const assessed = tierFinalists.map(item => {
      const itemEvidence = evidenceByModel.get(item.modelId);
      const gate = itemEvidence ? fullExamGate(itemEvidence, manifest) : { checks: {}, eligible: false, failures: null, swapDeltaBytes: null, servedContext: null };
      return { ...item, evidenceStatus: itemEvidence?.status ?? "missing", ...gate };
    });
    const eligible = assessed.filter(item => item.eligible).sort((a, b) =>
      (b.checks.recall - a.checks.recall) || (b.checks.chains - a.checks.chains) ||
      (a.failures - b.failures) || (a.swapDeltaBytes - b.swapDeltaBytes) || a.modelId.localeCompare(b.modelId));
    tiers[tier] = {
      default: eligible[0]?.modelId ?? null,
      fallback: eligible[1]?.modelId ?? null,
      status: eligible.length ? "eligible" : (assessed.length ? "unsupported" : "unverified"),
      candidates: assessed.map(item => ({ ...item, role: item.modelId === eligible[0]?.modelId ? "default" : item.modelId === eligible[1]?.modelId ? "fallback" : "unsupported" })),
    };
  }
  return { contractVersion: 1, tiers };
}

export function tierDecisionsMarkdown(decisions) {
  const lines = ["# Model-tier decisions", "", "Generated from validated finalist full-exam evidence.", "", "| Tier | Status | Default | Fallback |", "|---:|---|---|---|"];
  for (const tier of [8, 16, 24, 32]) {
    const item = decisions?.tiers?.[tier] ?? {};
    lines.push(`| ${tier} GB | ${item.status ?? "unverified"} | ${item.default ?? "—"} | ${item.fallback ?? "—"} |`);
  }
  return lines.join("\n") + "\n";
}
