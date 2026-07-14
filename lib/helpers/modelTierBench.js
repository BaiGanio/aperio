const VALID_CASE_KINDS = new Set(["behavior", "guardrail"]);
const VALID_STATE_KINDS = new Set(["memory", "none"]);
const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

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
