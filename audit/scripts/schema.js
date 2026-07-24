// audit/scripts/schema.js
// Run and finding schema with validation and state transitions
// for Aperio Continuous Audit.

const FINDING_STATUSES = [
  "candidate",
  "confirmed",
  "rejected",
  "duplicate",
  "accepted-risk",
  "planned",
  "fixed",
  "reopened",
];

// Allowed transitions from the plan's state diagram
const STATUS_TRANSITIONS = {
  candidate:    ["confirmed", "rejected"],
  confirmed:    ["duplicate", "accepted-risk", "planned"],
  rejected:     [],             // terminal
  duplicate:    [],             // terminal
  "accepted-risk": ["reopened"],
  planned:      ["fixed"],
  fixed:        ["reopened"],
  reopened:     ["confirmed", "rejected"],
};

const SEVERITIES = ["low", "medium", "high", "critical"];
const CONFIDENCES = ["low", "medium", "high"];

function validateRun(record) {
  const errors = [];
  const required = [
    "run_id", "slice_id", "revision", "branch", "timestamp", "scope",
    "observer", "elapsed_ms",
  ];
  for (const f of required) {
    if (record[f] === undefined || record[f] === null || record[f] === "") {
      errors.push(`Missing required field: ${f}`);
    }
  }
  if (record.schema_version == null) {
    errors.push("Missing required field: schema_version");
  }
  if (record.model_usage && typeof record.model_usage.input_tokens !== "number") {
    errors.push("model_usage.input_tokens must be a number");
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateFinding(finding) {
  const errors = [];
  const required = [
    "id", "revision", "status", "severity", "confidence",
    "affected_locations", "invariant", "expected_behavior", "actual_behavior",
    "evidence",
  ];
  for (const f of required) {
    if (finding[f] === undefined || finding[f] === null || finding[f] === "") {
      errors.push(`Missing required field: ${f}`);
    }
  }
  if (!FINDING_STATUSES.includes(finding.status)) {
    errors.push(`Invalid status: ${finding.status}. Must be one of: ${FINDING_STATUSES.join(", ")}`);
  }
  if (!SEVERITIES.includes(finding.severity)) {
    errors.push(`Invalid severity: ${finding.severity}. Must be one of: ${SEVERITIES.join(", ")}`);
  }
  if (!CONFIDENCES.includes(finding.confidence)) {
    errors.push(`Invalid confidence: ${finding.confidence}. Must be one of: ${CONFIDENCES.join(", ")}`);
  }
  if (!Array.isArray(finding.affected_locations) || finding.affected_locations.length === 0) {
    errors.push("affected_locations must be a non-empty array");
  }
  if (finding.reproduction && typeof finding.reproduction !== "string") {
    errors.push("reproduction must be a string");
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

function canTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed) {
    return { allowed: false, reason: `Unknown source status: ${from}` };
  }
  if (allowed.includes(to)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `Cannot transition from "${from}" to "${to}". Allowed: ${allowed.join(", ") || "(terminal state)"}` };
}

function transitionFinding(finding, newStatus, { timestamp = new Date().toISOString(), reason = "" } = {}) {
  const check = canTransition(finding.status, newStatus);
  if (!check.allowed) {
    throw new Error(check.reason);
  }
  const history = finding.history || [];
  history.push({
    from: finding.status,
    to: newStatus,
    timestamp,
    reason,
  });

  return {
    ...finding,
    status: newStatus,
    history,
    updated_at: timestamp,
  };
}

function makeRunId(sliceId) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${sliceId}-${ts}-${rand}`;
}

export {
  FINDING_STATUSES,
  SEVERITIES,
  CONFIDENCES,
  STATUS_TRANSITIONS,
  validateRun,
  validateFinding,
  canTransition,
  transitionFinding,
  makeRunId,
};
