const VALID_CASE_KINDS = new Set(["behavior", "guardrail"]);
const VALID_STATE_KINDS = new Set(["memory", "wiki", "none"]);
const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

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
    if (!hf.includes("/") || !hf.includes(":")) throw new Error(`${at}.hf must be an exact repo:quant identifier`);
    if (!Array.isArray(raw.tiers) || raw.tiers.some(tier => ![8, 16, 24, 32].includes(tier))) {
      throw new Error(`${at}.tiers must contain only 8, 16, 24, or 32`);
    }
    return { ...raw, id, hf };
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
