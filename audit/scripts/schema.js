// audit/scripts/schema.js
//
// T3 — audit ledger finding/run record schema (aperio-continuous-audit.md
// Step 3, aperio-continuous-audit-tests.md T3). Bootstrap-milestone scope:
// the minimum complete schema needed to record one run and one finding, per
// the plan's own instruction to generalize from a validated record, not from
// hypothetical fields. Full ledger persistence (T3.3 usage-cost reconciliation
// across many records, T6-T9 aggregation) is not built here.

const SEVERITIES = ["low", "medium", "high", "critical"];
const CONFIDENCES = ["low", "medium", "high"];
const STATUSES = [
  "Candidate", "Rejected", "Confirmed", "Duplicate",
  "AcceptedRisk", "Planned", "Fixed", "Reopened",
];

// Finding lifecycle (aperio-continuous-audit.md §3.4 "Finding lifecycle"
// stateDiagram). Only these transitions are valid — any other pair, including
// any transition out of a terminal state (Rejected, Duplicate, AcceptedRisk),
// is rejected. Reopened has no outgoing edge in the diagram; re-triaging a
// Reopened finding is a new Planned decision made by a human, not a schema
// transition, so it stays terminal here too.
const TRANSITIONS = {
  Candidate: ["Rejected", "Confirmed"],
  Confirmed: ["Duplicate", "AcceptedRisk", "Planned"],
  Planned: ["Fixed"],
  Fixed: ["Reopened"],
};

const FINDING_REQUIRED_FIELDS = [
  "id", "title", "severity", "confidence", "affectedPaths",
  "violatedInvariant", "reproduction", "expected", "actual",
  "impact", "evidence", "suggestedMitigation", "regressionTestLocation",
  "status",
];

const RUN_REQUIRED_FIELDS = [
  "baselineSha", "lens", "scope", "filesRead", "commandsRun",
  "model", "provider", "tokens", "candidates", "confirmedFindings",
  "rejectedCandidates", "residualUncertainty", "elapsedMs",
];

function missingFields(record, required) {
  return required.filter((f) => record[f] === undefined || record[f] === null || record[f] === "");
}

// Severity (impact) and confidence (evidence strength) are validated as two
// independent enums on purpose — Step 3: "Severity is based on impact;
// confidence is separate. A high-impact/low-confidence candidate is not
// reported as a confirmed high-severity bug." Neither field can stand in for
// the other here.
export function validateFinding(finding) {
  const errors = [...missingFields(finding, FINDING_REQUIRED_FIELDS).map(
    (f) => `missing required field: ${f}`
  )];

  if (finding.severity !== undefined && !SEVERITIES.includes(finding.severity)) {
    errors.push(`severity must be one of ${SEVERITIES.join("/")}, got "${finding.severity}"`);
  }
  if (finding.confidence !== undefined && !CONFIDENCES.includes(finding.confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCES.join("/")}, got "${finding.confidence}"`);
  }
  if (finding.status !== undefined && !STATUSES.includes(finding.status)) {
    errors.push(`status must be one of ${STATUSES.join("/")}, got "${finding.status}"`);
  }
  if (finding.affectedPaths !== undefined) {
    if (!Array.isArray(finding.affectedPaths) || finding.affectedPaths.length === 0) {
      errors.push("affectedPaths must be a non-empty array of {file, line}");
    } else {
      finding.affectedPaths.forEach((p, i) => {
        if (!p || typeof p.file !== "string" || typeof p.line !== "number") {
          errors.push(`affectedPaths[${i}] must be {file: string, line: number}, got ${JSON.stringify(p)}`);
        }
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRun(run) {
  const errors = [...missingFields(run, RUN_REQUIRED_FIELDS).map(
    (f) => `missing required field: ${f}`
  )];

  if (run.tokens !== undefined) {
    for (const key of ["input", "cachedInput", "reasoning", "output"]) {
      if (typeof run.tokens[key] !== "number") {
        errors.push(`tokens.${key} must be a number (0 if not applicable), got ${JSON.stringify(run.tokens?.[key])}`);
      }
    }
  }
  if (run.candidates !== undefined && !Array.isArray(run.candidates)) errors.push("candidates must be an array");
  if (run.confirmedFindings !== undefined && !Array.isArray(run.confirmedFindings)) {
    errors.push("confirmedFindings must be an array");
  }
  if (run.rejectedCandidates !== undefined && !Array.isArray(run.rejectedCandidates)) {
    errors.push("rejectedCandidates must be an array");
  }
  return { valid: errors.length === 0, errors };
}

// Applies a transition and returns a NEW finding object; the caller decides
// whether/how to persist it. History is appended, never overwritten, so
// reopening a Fixed finding (T3.2) keeps the full Candidate->...->Fixed
// trail instead of losing it at the reopen point.
export function transitionFinding(finding, toStatus) {
  const allowed = TRANSITIONS[finding.status] || [];
  if (!allowed.includes(toStatus)) {
    return {
      ok: false,
      error: `invalid transition ${finding.status} -> ${toStatus} ` +
        `(allowed from ${finding.status}: ${allowed.join(", ") || "none — terminal state"})`,
    };
  }
  const history = [
    ...(finding.history || []),
    { from: finding.status, to: toStatus, at: new Date().toISOString() },
  ];
  return { ok: true, finding: { ...finding, status: toStatus, history } };
}

export const SCHEMA = {
  SEVERITIES, CONFIDENCES, STATUSES, TRANSITIONS,
  FINDING_REQUIRED_FIELDS, RUN_REQUIRED_FIELDS,
};
