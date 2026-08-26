// audit/scripts/slice-execution.js
//
// T6 — audit-wave slice execution (aperio-continuous-audit.md Step 6;
// aperio-continuous-audit-tests.md T6.1-T6.4). Four independent, pure,
// injectable checks over already-produced slice/finding records — this module
// never calls GitHub, a cloud provider, a model, or starts a server/MCP
// process. The one thing it does read is the audited working tree itself, and
// only to answer §7's "file and line references point to current code", which
// no amount of record inspection can settle; that read goes through an
// injectable `anchorResolver`, so every check here stays pure under test.
// It reuses schema.js's status vocabulary and transition table
// (SCHEMA, transitionFinding) rather than defining a second one, exactly as
// usage-accounting.js reuses validateRun's shape instead of re-validating it.
//
//   T6.1  checkSliceExitGate / checkWaveExitGate — a completed slice report
//         satisfies Step 6's exit gate; a deferred slice needs reason, owner,
//         and trigger/date and is never counted complete.
//   T6.2  classifyCandidateEvidence / checkCandidateEscalation — a candidate
//         cannot become Confirmed on model agreement alone; that requires an
//         evidence item schema.js's own transition table would otherwise wave
//         through unchecked (transitionFinding only enforces the state graph,
//         not what justifies climbing it).
//   T6.3  checkLensBudget — at most one primary lens per slice; a second cloud
//         lens or any precision-model use needs a recorded human override
//         naming a reason, an approver, and the finding IDs it covers.
//   T6.4  classifyDuplicate — a candidate matching an existing ledger/GitHub
//         record by invariant AND affected file becomes Duplicate; a shared
//         symptom with a different invariant stays a distinct, linked finding.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNNABLE_COMMAND, comparableText, isBlank, isNonBlankString } from "./record-shapes.js";
import { SCHEMA, transitionFinding, validateFinding } from "./schema.js";

// ── T6.1 — slice exit gate ───────────────────────────────────────────────

// Step 6's exit-gate field list ("every completed report satisfies the exit
// gate") mapped onto names this module already has a shape for:
//   revision -> revision (baseline commit/working-tree state, T1)
//   manifest -> manifestHash (manifest.js's computeManifestHash() output)
//   commands -> commandsRun
//   token usage -> tokens (schema.js's shape PLUS the cache-write count the
//                  durable run ledger requires — see LEDGER_TOKEN_KEYS)
//   candidates/outcomes -> candidates ([{id, status}], status from SCHEMA.STATUSES)
export const SLICE_REPORT_REQUIRED_FIELDS = [
  "slice", "revision", "scope", "lens", "manifestHash", "commandsRun",
  "tokens", "candidates", "cleanInvariants", "residualUncertainty",
];

// T6.1: "deferred slice has reason, owner, and trigger/date."
export const DEFERRAL_REQUIRED_FIELDS = ["slice", "reason", "owner", "trigger"];

const TOKEN_KEYS = ["input", "cachedInput", "reasoning", "output"];

// aperio-continuous-audit.md §4.8 makes the cache-WRITE count mandatory and
// forbids collapsing an unreported one to zero, and ledger.js refuses any
// durable run row that omits it. A slice report is what becomes that row, so
// letting the exit gate call such a report "complete" would approve work the
// ledger then rejects. The gate therefore validates the ledger's key set, not
// the smaller schema.js one.
export const LEDGER_TOKEN_KEYS = [...TOKEN_KEYS, "cacheCreationInput"];

// Presence alone is not a shape. A partially-decoded or hand-edited report can
// carry `scope: {}`, `lens: []`, or `commandsRun: {}` — values that are neither
// missing nor usable. Each required field is therefore checked against the
// shape the exit gate actually reads, not merely for existence. `tokens`,
// `candidates`, and `cleanInvariants` have their own dedicated checks below.
const SLICE_REPORT_FIELD_SHAPES = {
  slice: "string",
  revision: "string",
  scope: "string|string[]",
  lens: "string|string[]",
  manifestHash: "sha256",
  commandsRun: "string[]",
  residualUncertainty: "string",
};

const DEFERRAL_FIELD_SHAPES = {
  slice: "string", reason: "string", owner: "string", trigger: "string",
};

// isBlank / isNonBlankString / comparableText now live in record-shapes.js
// (imported above) because triage.js asks the same three questions of the same
// records. comparableText in particular has to mean ONE thing: T6's
// confirmation gate uses it to require that `expected` and `actual` differ as
// behavior, and T8.3 uses it to require that the promised red regression test
// would actually be red.
function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonBlankString);
}

// computeManifestHash() returns a hex SHA-256 digest, and manifestHash is the
// slice's claim about WHICH tree state it audited. "not computed", "n/a", or a
// truncated paste are all non-empty strings that identify no manifest at all —
// and a manifest identity nobody can compare is the same unchecked box a
// placeholder is anywhere else in this module.
const SHA256_HEX = /^[0-9a-f]{64}$/i;

const SHAPE_CHECKS = {
  string: isNonBlankString,
  // An empty array is allowed here: "this slice ran no commands" is a
  // legitimate documented answer. An array holding blanks or non-strings is not.
  "string[]": isStringArray,
  // Either form, but it must NAME something — an empty scope or lens is not a
  // documented scope, it is a missing one wearing an array's clothes.
  "string|string[]": (v) => isNonBlankString(v) || (isStringArray(v) && v.length > 0),
  sha256: (v) => typeof v === "string" && SHA256_HEX.test(v.trim()),
};

// What each shape reads like in an error, so a failure says what to write.
const SHAPE_DESCRIPTIONS = {
  string: "non-empty string",
  "string[]": "non-empty string[]",
  "string|string[]": "non-empty string or string[]",
  sha256: "64-character hex SHA-256 digest, the value computeManifestHash() returns",
};

function matchesShape(value, shape) {
  return SHAPE_CHECKS[shape](value);
}

function missingFields(record, required) {
  return required.filter((f) => isBlank(record[f]));
}

// One token validator, used by BOTH the slice exit gate and the confirmation
// gate — §7 requires token usage on a confirmed finding for the same reason
// Step 6 requires it on a slice report, so the two must not drift apart.
function tokenErrors(tokens) {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return [`tokens must be an object with ${LEDGER_TOKEN_KEYS.join("/")}, got ${JSON.stringify(tokens)}`];
  }

  const errors = [];
  let countsValid = true;
  for (const key of LEDGER_TOKEN_KEYS) {
    const value = tokens[key];
    if (!Number.isFinite(value) || value < 0) {
      countsValid = false;
      errors.push(`tokens.${key} must be a finite non-negative number, got ${JSON.stringify(value)}` +
        (key === "cacheCreationInput"
          ? ` — the durable ledger may not confuse "not recorded" with zero, so the count must be recorded here`
          : ""));
    }
  }
  if (!countsValid) return errors;

  // cachedInput and cacheCreationInput are both PARTS of input
  // (usage-accounting.js: input_tokens = uncached + cacheRead + cacheCreated),
  // so their sum exceeding it is an impossible record, not a large one.
  const { input, cachedInput, cacheCreationInput, reasoning, output } = tokens;
  if (cachedInput + cacheCreationInput > input) {
    errors.push(`tokens.cachedInput (${cachedInput}) plus tokens.cacheCreationInput ` +
      `(${cacheCreationInput}) exceeds tokens.input (${input}) — both are parts of input, so this ` +
      `record is impossible`);
  }
  // The same subset rule on the output side: usage-accounting.js rejects
  // reasoning > output when reconciling, so a record the gate passes here
  // would fail there.
  if (reasoning > output) {
    errors.push(`tokens.reasoning (${reasoning}) exceeds tokens.output (${output}) — ` +
      `reasoning is a breakdown of output, not an addition to it`);
  }
  return errors;
}

// Shape errors for the fields that ARE present — fields reported as missing
// are skipped so one bad field never produces two errors.
function shapeErrors(record, shapes, label) {
  return Object.entries(shapes)
    .filter(([field, shape]) => !isBlank(record[field]) && !matchesShape(record[field], shape))
    .map(([field, shape]) =>
      `${label} field "${field}" must be a ${SHAPE_DESCRIPTIONS[shape]}, got ${JSON.stringify(record[field])}`);
}

/**
 * Classify and validate one slice report or deferral record against Step 6's
 * exit gate. Returns `classification` ("complete" | "incomplete" | "deferred"
 * | "invalid") separately from `complete`, because a validly-documented
 * deferral is a legitimate classification that is still never `complete` —
 * that is the assertion T6.1 exists to enforce, not an edge case of it.
 */
export function checkSliceExitGate(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { classification: "invalid", complete: false, errors: [`slice report must be an object, got ${JSON.stringify(report)}`] };
  }

  // Only `deferred === true` selects the deferral path. A serialized record
  // carrying deferred: "false" is truthy in JS, and would otherwise excuse a
  // slice that was explicitly marked NOT deferred; any non-boolean value is
  // malformed data this gate must reject rather than interpret.
  if (report.deferred !== undefined && report.deferred !== null && typeof report.deferred !== "boolean") {
    return {
      classification: "invalid",
      complete: false,
      errors: [`slice "${report.slice ?? "(unnamed)"}": deferred must be a boolean, got ` +
        `${JSON.stringify(report.deferred)} — a non-boolean marker must not select the deferral path`],
    };
  }

  if (report.deferred === true) {
    const label = `deferred slice "${report.slice ?? "(unnamed)"}"`;
    const errors = missingFields(report, DEFERRAL_REQUIRED_FIELDS)
      .map((f) => `${label} missing required field: ${f}`);
    errors.push(...shapeErrors(report, DEFERRAL_FIELD_SHAPES, label));
    return { classification: "deferred", complete: false, errors };
  }

  const sliceLabel = `slice "${report.slice ?? "(unnamed)"}"`;
  const errors = missingFields(report, SLICE_REPORT_REQUIRED_FIELDS)
    .map((f) => `${sliceLabel} missing required field: ${f}`);
  errors.push(...shapeErrors(report, SLICE_REPORT_FIELD_SHAPES, sliceLabel));

  if (!isBlank(report.tokens)) errors.push(...tokenErrors(report.tokens).map((e) => `${sliceLabel}: ${e}`));

  if (!isBlank(report.candidates)) {
    if (!Array.isArray(report.candidates)) {
      errors.push(`slice "${report.slice}": candidates must be an array, got ${JSON.stringify(report.candidates)}`);
    } else {
      report.candidates.forEach((c, i) => {
        // An outcome with no candidate ID cannot be tied back to the candidate
        // it belongs to, or reconciled against the finding ledger — the
        // documented shape here is {id, status}, and a bare status is a
        // recorded outcome for nobody.
        if (!c || typeof c !== "object" || Array.isArray(c) || !isNonBlankString(c.id)) {
          errors.push(`slice "${report.slice}": candidates[${i}] must name the candidate it reports on ` +
            `as a non-empty string id, got ${JSON.stringify(c?.id)} — an outcome that names no candidate ` +
            `cannot be reconciled with the finding ledger`);
        }
        if (!c || typeof c.status !== "string" || !SCHEMA.STATUSES.includes(c.status)) {
          errors.push(`slice "${report.slice}": candidates[${i}] (${c?.id ?? "no id"}) must carry a valid ` +
            `outcome/status (one of ${SCHEMA.STATUSES.join("/")}), got ${JSON.stringify(c?.status)}`);
        }
      });
    }
  }

  if (!isBlank(report.cleanInvariants)) {
    if (!Array.isArray(report.cleanInvariants)) {
      errors.push(`slice "${report.slice}": cleanInvariants must be an array (may be empty), got ${JSON.stringify(report.cleanInvariants)}`);
    } else {
      // An explicitly empty array is a real answer ("this slice cleared no
      // invariant"). An array of `{}`, null, or "   " is not: it CLAIMS
      // coverage while naming none, which is the opposite of what this field
      // is for.
      report.cleanInvariants.forEach((invariant, i) => {
        if (!isNonBlankString(invariant)) {
          errors.push(`slice "${report.slice}": cleanInvariants[${i}] must name an invariant as a ` +
            `non-empty string, got ${JSON.stringify(invariant)} — an entry that records no invariant ` +
            `is a claim of coverage, not coverage`);
        }
      });
    }
  }

  return { classification: errors.length === 0 ? "complete" : "incomplete", complete: errors.length === 0, errors };
}

/** The full run set from aperio-continuous-audit.md §5's ownership map. */
export const AUDIT_SLICE_IDS = Array.from({ length: 22 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`);

const emptyWaveResult = (errors) => ({
  ok: false, errors, complete: [], deferred: [], incomplete: [],
  missing: [], unexpected: [], duplicated: [],
});

/**
 * Reconcile a wave of slice reports against the exit gate AND against the run
 * set it is supposed to cover. Per-slice validity is only half of T6.1: "the
 * completed A01-A22 run set or documented deferrals" is a COVERAGE claim, so a
 * wave of one valid A01 report — or of twenty-two copies of A01 — must not
 * report the aggregate gate satisfied. `expectedSlices` is therefore required,
 * not defaulted: a caller that names no run set has not stated what completion
 * would mean, and guessing AUDIT_SLICE_IDS for them would hide that.
 *
 * A slice appears in exactly one bucket: `complete`, a validly-documented
 * `deferred`, or `incomplete` — including a malformed deferral, which is
 * neither accepted as done nor silently dropped. Coverage failures are
 * reported separately as `missing`, `unexpected`, and `duplicated`.
 */
export function checkWaveExitGate(reports, { expectedSlices } = {}) {
  if (!Array.isArray(expectedSlices) || expectedSlices.length === 0 || !expectedSlices.every(isNonBlankString)) {
    return emptyWaveResult([`expectedSlices must be a non-empty array of slice ids (e.g. AUDIT_SLICE_IDS), got ` +
      `${JSON.stringify(expectedSlices)} — without the run set it is supposed to cover, a wave of one ` +
      `valid report would satisfy the aggregate exit gate`]);
  }

  const expected = new Set(expectedSlices);
  if (expected.size !== expectedSlices.length) {
    return emptyWaveResult([`expectedSlices contains duplicate ids (${expectedSlices.length} entries, ` +
      `${expected.size} distinct) — the run set a wave is measured against must name each slice once`]);
  }

  if (!Array.isArray(reports) || reports.length === 0) {
    return emptyWaveResult([Array.isArray(reports)
      ? "reports is empty — an absent or accidentally empty run set must not satisfy the aggregate exit gate without checking any slice"
      : `reports must be an array of slice reports/deferrals, got ${JSON.stringify(reports)} — ` +
        `treating a malformed wave as empty would silently pass without checking any slice`]);
  }

  const errors = [];
  const complete = [];
  const deferred = [];
  const incomplete = [];
  const seen = new Map();

  reports.forEach((report, i) => {
    const result = checkSliceExitGate(report);
    const label = report?.slice ?? `reports[${i}]`;
    errors.push(...result.errors);
    if (result.complete) complete.push(label);
    else if (result.classification === "deferred" && result.errors.length === 0) deferred.push(label);
    else incomplete.push(label);

    // Coverage is counted on the slice ID only. A report with no usable ID is
    // already `incomplete`; it must not also be credited to some slice.
    if (isNonBlankString(report?.slice)) seen.set(report.slice, (seen.get(report.slice) ?? 0) + 1);
  });

  const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  const unexpected = [...seen.keys()].filter((id) => !expected.has(id));
  const missing = expectedSlices.filter((id) => !seen.has(id));

  for (const id of duplicated) {
    errors.push(`slice "${id}" is reported ${seen.get(id)} times — one report per slice, or a repeated ` +
      `slice would count as coverage of the ones that are absent`);
  }
  for (const id of unexpected) {
    errors.push(`slice "${id}" is not part of the run set being measured (${expectedSlices.join(", ")})`);
  }
  if (missing.length) {
    errors.push(`the run set is not covered — no report or deferral for: ${missing.join(", ")}`);
  }

  return { ok: errors.length === 0, errors, complete, deferred, incomplete, missing, unexpected, duplicated };
}

// ── T6.2 — unsupported candidates cannot escalate ───────────────────────

// "model-agreement" (a second or further model concurring with the first) is
// deliberately NOT independent evidence — aperio-continuous-audit-tests.md
// T6.2: "a second model agreeing is not accepted as independent evidence."
// Everything else here is a form of static or reproducible proof.
export const EVIDENCE_KINDS = ["file-line", "static-trace", "focused-test", "reproduction", "model-agreement"];
const MODEL_AGREEMENT_KIND = "model-agreement";

// A filename with an extension followed by a line number: "paths.js:42".
const FILE_LINE_ANCHOR = /[^\s:]+\.[A-Za-z0-9_]+:\d+/;
// A repo path — either slash-separated, or a bare filename with an extension.
const hasPathReference = (detail) => /\S\/\S/.test(detail) || /\S\.[A-Za-z0-9_]{1,12}\b/.test(detail);
// A reproduction may also be a command someone can actually re-run. The
// pattern is shared with T8.2's public-summary scan (record-shapes.js): a
// command form only one of them recognized would be evidence here and an
// unrecognized payload on the way into a public issue.

// aperio-continuous-audit.md §4.7: "A finding without a file/line reference,
// violated invariant, and reproduction path is discarded before cross-review."
// A non-blank string is therefore not yet evidence — `detail: "trust me"` is
// exactly the plausible unsupported claim T6.2 exists to stop. Each kind must
// carry the payload its NAME promises.
const EVIDENCE_DETAIL_SHAPES = {
  "file-line": {
    accepts: (d) => FILE_LINE_ANCHOR.test(d),
    expected: "a file:line reference (e.g. lib/routes/paths.js:42)",
  },
  "static-trace": {
    accepts: (d) => FILE_LINE_ANCHOR.test(d),
    expected: "a trace anchored to at least one file:line (e.g. lib/agent/index.js:210)",
  },
  "focused-test": {
    accepts: hasPathReference,
    expected: "the test's path (e.g. audit/tests/ledger.test.js)",
  },
  reproduction: {
    accepts: (d) => hasPathReference(d) || RUNNABLE_COMMAND.test(d.trim()),
    expected: "a reproduction path or a runnable command (e.g. npm run test:audit)",
  },
};

/**
 * The path-shaped tokens inside an evidence detail, with any ":42" suffix split
 * off. Splitting on whitespace and prose punctuation reduces a trace such as
 * "handleTurn -> applyUsage at lib/agent/index.js:210" to the single token that
 * actually names a file, and leaves command details ("npm run test:audit")
 * with no tokens at all — a command is re-run, not resolved.
 */
function pathTokens(detail) {
  const tokens = [];
  for (const piece of String(detail).split(/[\s()[\]{}'"`,;]+/)) {
    const raw = piece.replace(/[.,;]+$/, "");
    if (!raw) continue;
    const withLine = /^(.+?):(\d+)$/.exec(raw);
    const file = withLine ? withLine[1] : raw;
    const line = withLine ? Number(withLine[2]) : null;
    if (!/\S\/\S/.test(file) && !/\.[A-Za-z0-9_]{1,12}$/.test(file)) continue;
    tokens.push({ file, line });
  }
  return tokens;
}

/**
 * §7's exit gate asks for a static trace, focused test, or reproduction that
 * actually SUPPORTS the claim. A detail of the right shape is not yet that:
 * "does/not/exist.test.js" is a perfectly well-formed path naming no test that
 * was ever run, and accepting it would carry a candidate to Confirmed on an
 * anchor nobody can open — the same hole `anchorErrors()` closes for
 * affectedPaths. So every path named in a detail is resolved against the
 * audited tree, and one that resolves is enough (prose may mention several).
 *
 * A detail with no path token at all is left to commandEvidenceErrors(): it
 * passed its kind's shape check as a runnable command, which this module cannot
 * and must not execute, so it is checked against its RECORDED result instead.
 */
function detailAnchorErrors(index, kind, tokens, anchorResolver, relatedPaths) {
  if (!tokens.length) return [];

  const problems = [];
  for (const { file, line } of tokens) {
    const resolved = anchorResolver(file);
    if (!resolved || typeof resolved !== "object") {
      problems.push(`"${file}" could not be checked against the audited tree`);
      continue;
    }
    if (!resolved.inTree) {
      problems.push(`"${file}" resolves outside the audited tree`);
      continue;
    }
    if (!resolved.exists) {
      problems.push(`"${file}" names no file in the audited tree${shorthandHint(file, relatedPaths)}`);
      continue;
    }
    // Line 0 is the mirror image of a line past the end, and the same rule
    // anchorErrors() applies to affectedPaths applies here: no file has a line
    // 0, so "paths.js:0" is well-formed, resolves, and still points at no code.
    if (line !== null && line < 1) {
      problems.push(`"${file}:${line}" names no line — the first line of a file is 1`);
      continue;
    }
    if (line !== null && Number.isFinite(resolved.lines) && line > resolved.lines) {
      problems.push(`"${file}:${line}" points past the end of a ${resolved.lines}-line file`);
      continue;
    }
    if (!anchorSupportsCandidate(file, relatedPaths)) {
      problems.push(`"${file}" is real code, but not code this candidate points at`);
      continue;
    }
    return [];
  }
  return [`evidenceItems[${index}]: kind "${kind}" detail must point at code in the audited tree that ` +
    `the candidate itself names — ${problems.join("; ")}; a path that resolves to nothing, or to ` +
    `something else entirely, supports no claim`];
}

/**
 * Whether a command-shaped evidence detail records a run that actually
 * happened. This is the other half of the anchor check: an anchored detail is
 * verified by opening the file, and a command detail cannot be — this module
 * never executes anything — so "npm run nonexistent" would otherwise be
 * independent evidence purely by looking runnable, and would carry an
 * otherwise-complete candidate straight to Confirmed.
 *
 * The record has to say what happened when the command was run: WHEN (`ranAt`,
 * a readable timestamp) and WHAT it produced (`observed`). Note that a FAILING
 * command is perfectly good evidence — a reproduction very often is a test that
 * fails — so this asks for a recorded observation, never for success.
 *
 * A caller that really does run commands (a harness, a CI job) should inject
 * `commandVerifier(item) -> { ran, reason }` and answer from its own run log;
 * the default only reads what the evidence item itself recorded.
 */
const defaultCommandVerifier = (item) => {
  const at = item?.ranAt;
  const observed = item?.observed;
  if (!isNonBlankString(at) || !Number.isFinite(Date.parse(at))) {
    return { ran: false, reason: `no readable \`ranAt\` timestamp, got ${JSON.stringify(at)}` };
  }
  if (!isNonBlankString(observed) || isPlaceholder(observed)) {
    return { ran: false, reason: `no \`observed\` outcome, got ${JSON.stringify(observed)}` };
  }
  return { ran: true, reason: null };
};

function commandEvidenceErrors(index, item, tokens, isCommand, commandVerifier) {
  // Whether a detail is a COMMAND is decided by its syntax, never by whether it
  // happens to mention a path. `node audit/tests/x.test.js` names a real file,
  // but the file existing is not the claim — the claim is that running it
  // showed the defect, and nobody ran it. So a command is verified as a command
  // even when its path resolved a moment ago in detailAnchorErrors().
  if (!isCommand) {
    if (tokens.length) return [];  // an ordinary anchored detail — already resolved

    // Neither a resolvable path nor a command. The shape regexes are
    // deliberately loose — `FILE_LINE_ANCHOR` matches anywhere in the string, so
    // "x.js:12abc" passes the shape check and yields no usable token. Such a
    // detail is malformed; it must not reach the command verifier, or a fake
    // `ranAt`/`observed` pair would confirm a broken anchor.
    return [`evidenceItems[${index}]: kind "${item.kind}" detail ${JSON.stringify(item.detail)} names no ` +
      `path this module could resolve` +
      (item.kind === "reproduction" ? ", and is not a runnable command either" : "") +
      ` — it looks like an anchor but points at nothing (a line number with trailing characters, ` +
      `a filename that is not one); a detail nobody can open supports no claim`];
  }

  const verdict = commandVerifier(item);
  if (verdict && verdict.ran === true) return [];
  return [`evidenceItems[${index}]: kind "${item.kind}" detail ${JSON.stringify(item.detail)} is a ` +
    `command, and this module never runs one — so it counts only once the record says it WAS run ` +
    `(${verdict?.reason ?? "the injected commandVerifier rejected it"}); a command nobody ran is an ` +
    `intention, not evidence`];
}

/**
 * The places a candidate itself points at: the code it says is affected, plus
 * the reproduction and regression-test locations its own record declares. An
 * evidence anchor outside that set proves something — just not THIS finding.
 *
 * Both halves are needed. `file-line` and `static-trace` evidence names the
 * defective code, which is `affectedPaths`; a `focused-test` or `reproduction`
 * names the artifact that exercises the defect, which by nature lives elsewhere
 * and is exactly what §7 already makes the record declare. Widening the set to
 * those two fields is therefore not a loophole — it is the record's own answer
 * to "where is this reproduced", and evidence is checked against it rather than
 * against any well-formed path in the repository.
 */
function candidateAnchorPaths(candidate) {
  const paths = affectedFiles(candidate);
  for (const field of Object.keys(CONFIRMATION_PATH_FIELDS)) {
    const value = candidate?.[field];
    if (!isNonBlankString(value) || isPlaceholder(value)) continue;
    for (const { file } of pathTokens(value)) {
      if (namesAComparableFile(file)) paths.add(normalizeRepoPath(file));
    }
  }
  return paths;
}

/**
 * Whether one resolved anchor supports the candidate it is attached to.
 *
 * An anchor that resolves is only half the T6.2 question. `package.json:1` is a
 * real file at a real line and supports no claim about a provider's usage
 * accounting, so without this a candidate could be carried to Confirmed by
 * evidence that never touches it — the same "answer without an answer" the
 * shape and resolution checks close from the other side.
 *
 * Comparison is on the normalized repo-relative path, and nothing else. A bare
 * basename ("paths.js" for "lib/routes/paths.js") is NOT shorthand here: the
 * anchor is resolved against the audited tree before this runs, and the tree
 * has no <repo>/paths.js to resolve, so accepting the basename at this stage
 * would only mean accepting an anchor the resolver already failed. A repository
 * also holds many an index.js. Evidence names the full path; shorthandHint()
 * says so in the error rather than guessing which file was meant.
 *
 * An EMPTY relation set means the candidate names no place at all. That is not
 * a pass — it is a record with no affectedPaths, which confirmationGateErrors()
 * already rejects — so this returns true rather than adding a second, more
 * confusing error for the same missing field.
 */
function anchorSupportsCandidate(file, relatedPaths) {
  if (!relatedPaths || relatedPaths.size === 0) return true;
  const anchor = normalizeRepoPath(file);
  if (anchor === "") return false;
  return relatedPaths.has(anchor);
}

/**
 * The likely repair for an anchor that resolved to nothing: an auditor (or a
 * model) writing "paths.js:42" for a candidate that affects
 * "lib/routes/paths.js". The anchor is still rejected — the point is to say
 * WHICH full path was meant instead of leaving "names no file" as the whole
 * story. Only an unambiguous single match is named; two candidate paths sharing
 * a basename produce no guess.
 */
function shorthandHint(file, relatedPaths) {
  if (!relatedPaths || relatedPaths.size === 0) return "";
  const anchor = normalizeRepoPath(file);
  if (anchor === "" || anchor.includes("/")) return "";
  const matches = [...relatedPaths].filter((related) => related.endsWith(`/${anchor}`));
  if (matches.length !== 1) return "";
  return ` (this candidate names "${matches[0]}" — evidence must give the full repo-relative path)`;
}

/**
 * Whether an evidence list contains anything beyond model agreement. An item
 * only counts as independent evidence when it carries a RECOGNIZED kind (one
 * of EVIDENCE_KINDS) and a `detail` payload of the SHAPE that kind promises —
 * see EVIDENCE_DETAIL_SHAPES. null, `{}`, `[]`, an unrecognized kind such as
 * "reviewer-opinion", a recognized kind with no detail, and a recognized kind
 * whose detail is prose ("trust me") are all malformed, not proof, and are
 * reported as such rather than silently passing the T6.2 gate. Content-free
 * and content-shaped-but-unverifiable detail are exactly what T6.2 exists to
 * catch: neither may be what carries a candidate to Confirmed.
 *
 * `candidate` is the finding the evidence is attached to. When it is supplied,
 * every anchor must also SUPPORT that candidate (see candidateAnchorPaths) —
 * evidence pointing at unrelated code proves something else. It is optional
 * only because this function is also usable as a standalone classifier of
 * evidence shape, with no candidate in hand to relate anything to;
 * checkCandidateEscalation() always passes one, so the Confirmed gate never
 * runs without the relatedness check.
 */
export function classifyCandidateEvidence(evidenceItems = [], {
  anchorResolver = resolveAnchorInTree, candidate = null,
  commandVerifier = defaultCommandVerifier,
} = {}) {
  const items = Array.isArray(evidenceItems) ? evidenceItems : [];
  const errors = [];
  const independentKinds = new Set();
  const relatedPaths = candidate && typeof candidate === "object" ? candidateAnchorPaths(candidate) : null;
  let hasIndependentEvidence = false;
  let modelAgreementCount = 0;

  items.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      errors.push(`evidenceItems[${i}]: must be an object with a recognized kind, got ${JSON.stringify(item)}`);
      return;
    }
    if (!EVIDENCE_KINDS.includes(item.kind)) {
      errors.push(`evidenceItems[${i}]: kind must be one of ${EVIDENCE_KINDS.join("/")}, got ${JSON.stringify(item.kind)}`);
      return;
    }
    if (item.kind === MODEL_AGREEMENT_KIND) {
      modelAgreementCount += 1;
      return;
    }
    if (!isNonBlankString(item.detail)) {
      errors.push(`evidenceItems[${i}]: kind "${item.kind}" has no detail (file/line, trace, or ` +
        `reproduction path) as a non-empty string, got ${JSON.stringify(item.detail)} — an evidence ` +
        `item with no content cannot support Confirmed`);
      return;
    }
    const shape = EVIDENCE_DETAIL_SHAPES[item.kind];
    if (shape && !shape.accepts(item.detail)) {
      errors.push(`evidenceItems[${i}]: kind "${item.kind}" detail must name ${shape.expected}, got ` +
        `${JSON.stringify(item.detail)} — prose that points at nothing checkable is a claim, not evidence`);
      return;
    }
    // Every detail is verified one way or the other: an anchored one against
    // the tree, a command-shaped one against its recorded run. Neither path may
    // end in "looks plausible".
    const tokens = pathTokens(item.detail);
    // Only a reproduction may BE a command; every other kind promises a place
    // in the code. Both checks then run: a command that names a path must still
    // name one that resolves and belongs to this candidate, AND record its run.
    const isCommand = item.kind === "reproduction" && RUNNABLE_COMMAND.test(String(item.detail).trim());
    const unresolved = detailAnchorErrors(i, item.kind, tokens, anchorResolver, relatedPaths);
    if (unresolved.length) {
      errors.push(...unresolved);
      return;
    }
    const unrun = commandEvidenceErrors(i, item, tokens, isCommand, commandVerifier);
    if (unrun.length) {
      errors.push(...unrun);
      return;
    }
    hasIndependentEvidence = true;
    independentKinds.add(item.kind);
  });

  return {
    hasIndependentEvidence,
    modelAgreementOnly: items.length > 0 && !hasIndependentEvidence && modelAgreementCount > 0,
    independentKinds: [...independentKinds],
    errors,
  };
}

// aperio-continuous-audit.md §7's Finding Exit Gate asks for facts the
// record-level schema has no place for, because they are CONFIRMATION facts:
// a Candidate legitimately lacks them, and validateFinding() must keep
// accepting a Candidate. These are the §7 boxes schema.js does not cover:
//   "Exact commit/working-tree state recorded"     -> revision
//   "SQLite/Postgres, local/cloud, ... considered" -> variantsConsidered
//   "Existing tests and issues were searched"      -> duplicateSearch
//   "Token usage and model are recorded"           -> model, tokens
export const CONFIRMATION_REQUIRED_FIELDS = ["revision", "variantsConsidered", "duplicateSearch", "model", "tokens"];

// A completed duplicate search, i.e. classifyDuplicate()'s own verdict. Note
// that "Duplicate" is allowed: §3.4's graph routes a duplicate through
// Confirmed before it is marked Duplicate, so finding one is not a reason to
// block confirmation. "invalid" is not a search that ran.
const COMPLETED_DUPLICATE_SEARCHES = ["Duplicate", "Distinct"];

/**
 * §7's "existing tests and issues were searched" box, checked against the shape
 * classifyDuplicate() actually returns — not just its verdict word. A bare
 * `{ classification: "Distinct" }` records a conclusion with no search behind
 * it: no result arrays, and for "Duplicate", not even the record it duplicates.
 * That is the same "answer without an answer" this gate rejects elsewhere, so
 * the whole result shape is required, and a Duplicate must name at least one
 * match.
 */
function duplicateSearchErrors(search) {
  const expected = `classifyDuplicate()'s result — { classification: ` +
    `${COMPLETED_DUPLICATE_SEARCHES.join(" | ")}, matches: [], relatedBySymptom: [] }`;

  if (!search || typeof search !== "object" || Array.isArray(search) ||
      !COMPLETED_DUPLICATE_SEARCHES.includes(search.classification)) {
    return [`duplicateSearch must record a completed search of existing tests and issues ` +
      `(${expected}), got ${JSON.stringify(search)}`];
  }

  const errors = [];
  for (const field of ["matches", "relatedBySymptom"]) {
    if (!Array.isArray(search[field])) {
      errors.push(`duplicateSearch.${field} must be an array (may be empty) — a verdict with no ` +
        `search result recorded is a conclusion, not ${expected}; got ${JSON.stringify(search[field])}`);
    }
  }
  // A "Duplicate" verdict that names nothing it duplicates cannot be acted on:
  // §3.4 routes such a finding to the record it repeats, and there is no record.
  if (search.classification === "Duplicate" && Array.isArray(search.matches) &&
      !search.matches.some((m) => isNonBlankString(m?.id))) {
    errors.push(`duplicateSearch classified the finding Duplicate but names no matching record — ` +
      `matches must carry at least one entry with a non-empty id, got ${JSON.stringify(search.matches)}`);
  }
  return errors;
}

// §7's boxes are checked or they are not. "TBD" and "N/A pending evidence" are
// the two shapes an UNCHECKED box takes when a model is asked to fill one in
// anyway — they are the absence of an answer wearing an answer's clothes.
// Only a whole-string non-answer, or one that OPENS by declaring itself not
// applicable, is rejected: prose like "None of the callers check this" is a
// real answer that merely begins with a placeholder-shaped word.
const PLACEHOLDER_ONLY = /^(?:tbd|todo|n\.?\/?a\.?|none|unknown|pending|\?+|-+|\.+)$/i;
const PLACEHOLDER_PREFIX = /^(?:tbd|todo|n\.?\/?a\.?|pending)\b/i;
const PLACEHOLDER_CHECKED_FIELDS = [
  "violatedInvariant", "expected", "actual", "impact",
  "reproduction", "suggestedMitigation", "regressionTestLocation",
];

// validateFinding() checks these for PRESENCE, which is the right rule for a
// Candidate — the record schema must keep accepting a work-in-progress. A
// confirmation is the opposite claim: every box is checked, so every one of
// these has to be a readable answer. `violatedInvariant: {}` is neither
// missing nor an invariant, and the placeholder and expected/actual checks
// below silently ignore non-strings, so without this each one is a way to
// confirm a finding that says nothing.
const CONFIRMATION_STRING_FIELDS = [
  "id", "title", "violatedInvariant", "expected", "actual", "impact",
  "evidence", "reproduction", "suggestedMitigation", "regressionTestLocation",
];

// Two of those fields must not merely be prose: §7 wants a reproduction that
// can be re-run and a regression-test location that names a place.
//
// Only ONE of them accepts a command. A reproduction is satisfied by something
// re-runnable, so "npm run test:audit" is a real answer. A regression-test
// LOCATION is a place in the repository — "npm run test:audit" names where the
// suite is started, not where the test guarding this finding belongs, and
// accepting it lets a finding be confirmed while that box is still empty.
const CONFIRMATION_PATH_FIELDS = {
  reproduction: {
    accepts: namesAPlaceOrCommand,
    expected: "a reproduction path or a runnable command (e.g. npm run test:audit)",
  },
  regressionTestLocation: {
    accepts: hasPathReference,
    expected: "the path where the regression test belongs (e.g. audit/tests/ledger.test.js) — " +
      "a command names how to run the suite, not where the test lives",
  },
};

function isPlaceholder(value) {
  if (!isNonBlankString(value)) return false;
  const text = value.trim();
  return PLACEHOLDER_ONLY.test(text) || PLACEHOLDER_PREFIX.test(text);
}

function namesAPlaceOrCommand(value) {
  return hasPathReference(value) || RUNNABLE_COMMAND.test(value.trim());
}

// The audited tree, the same way manifest.js roots itself: relative to this
// file, never to whatever directory the process happens to be started in.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Line counts of file VERSIONS already looked up: `key -> { identity, lines }`,
// where identity is the stat fingerprint the entry was counted from. A wave
// confirms many findings against a handful of hot files (db/sqlite/store.js is
// 1400+ lines), and re-reading each one per anchor is pure waste — but skipping
// the read is only safe while the file is demonstrably the same one, which is
// what `identity` establishes on every hit. Bounded, and cleared wholesale
// rather than grown without limit: this is a within-run lookup table, not a
// durable cache, and a run touching more distinct files has bigger problems.
const ANCHOR_CACHE_LIMIT = 512;
const anchorLineCounts = new Map();
// Canonical (symlink-resolved) form of each audited root, so the containment
// check below compares like with like. `null` records a root that could not be
// canonicalized at all, which fails closed the same way an unreadable file does.
const canonicalRoots = new Map();

function canonicalRoot(rootDir) {
  if (canonicalRoots.has(rootDir)) return canonicalRoots.get(rootDir);
  let real = null;
  try {
    real = realpathSync(rootDir);
  } catch {
    real = null;
  }
  if (canonicalRoots.size >= ANCHOR_CACHE_LIMIT) canonicalRoots.clear();
  canonicalRoots.set(rootDir, real);
  return real;
}

// `target` lies strictly inside `dir`. Equality is not containment: the root
// directory itself is not a file anchor.
//
// The climb-out test is on path SEGMENTS, not on the string. `startsWith("..")`
// also rejects "..config.js" — an ordinary in-tree file whose name begins with
// two dots — and evidence anchored to it would be reported as living in another
// checkout. Only a segment that IS ".." leaves the directory.
//
// AGENTS.md routes app file operations through lib/routes/paths.js. This module
// deliberately does not import it: it is the auditor, and the code under audit
// (path validation included) is what it may have to report on, so it stays on
// node:path alone.
function containedIn(dir, target) {
  const rel = relative(dir, target);
  if (rel === "" || isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes("..");
}

/**
 * Resolve one anchor against the audited working tree. Returns
 * `{ inTree, exists, lines }`, or `null` when the tree could not be consulted
 * at all — which the gate treats as "not verified", never as "fine".
 *
 * A path that normalizes to an absolute path or climbs out of the root is
 * reported `inTree: false`: an anchor into somebody else's checkout is not an
 * anchor into the code under audit, even if that file happens to exist.
 *
 * `root` is JOINED, never concatenated — a caller auditing a second checkout
 * passes an ordinary directory path ("/tmp/checkout"), and string concatenation
 * would turn every anchor in it into "/tmp/checkoutlib/foo.js", i.e. report a
 * perfectly good tree as entirely missing. The lexical check is also not the
 * last word: a symlink inside the tree may point anywhere, so the target is
 * canonicalized and re-checked for containment BEFORE it is read. Without that,
 * `linked.js -> /outside/private.js` reads as in-tree and a finding could be
 * confirmed against code that is not in the audited checkout at all.
 */
export function resolveAnchorInTree(file, { root = REPO_ROOT } = {}) {
  if (!isNonBlankString(file)) return { inTree: false, exists: false, lines: 0 };
  const rel = normalizeRepoPath(file);
  if (rel === "" || rel.startsWith("/") || rel === ".." || rel.startsWith("../")) {
    return { inTree: false, exists: false, lines: 0 };
  }

  const rootDir = resolvePath(root);
  const target = resolvePath(rootDir, rel);
  if (!containedIn(rootDir, target)) return { inTree: false, exists: false, lines: 0 };

  const key = `${rootDir}\u0000${rel}`;
  const realRoot = canonicalRoot(rootDir);
  if (realRoot === null) return null;

  // A symlink inside the tree may point anywhere, and readFileSync would follow
  // it without complaint. Canonicalize first, then re-check containment: code
  // reached through an escaping link is not code in the audited checkout.
  //
  // Both this and the stat below run on EVERY call, cache hit or not. AGENTS.md
  // expects concurrent sessions in this same worktree, so between two findings
  // in one wave a file can be deleted, truncated, or replaced by a link out of
  // the tree — and a cache consulted BEFORE these checks would keep answering
  // "exists, N lines" for a file that is none of those things, confirming later
  // findings against a tree state that is already gone.
  let realTarget;
  try {
    realTarget = realpathSync(target);
  } catch (err) {
    if (err?.code === "ENOENT") return { inTree: true, exists: false, lines: 0 };
    return null;
  }
  if (!containedIn(realRoot, realTarget)) return { inTree: false, exists: false, lines: 0 };

  let stats;
  try {
    stats = statSync(realTarget);
  } catch (err) {
    // A file that is not there is a verified absence — a real answer. Anything
    // else (a permission error, an unreadable device) is a failure to check,
    // and must not be reported as a clean "does not exist".
    if (err?.code === "ENOENT") return { inTree: true, exists: false, lines: 0 };
    return null;
  }
  // A directory is not a file anchor. readFileSync would fail on it (EISDIR),
  // which is a failure to check, not a verified absence — so it stays `null`.
  if (!stats.isFile()) return null;

  // What is cached is a line count for ONE IDENTIFIED VERSION of a file, never
  // the fact that a path once resolved. Identity is the device/inode pair plus
  // size and both timestamps, so a replaced, truncated, or rewritten file misses
  // the cache and is read again. (Two writes inside the same millisecond that
  // leave inode AND size identical would still hit; that residual is far
  // narrower than keying on the path alone, and the stat above already caught
  // deletion and symlink escape.)
  const identity = `${realTarget}\0${stats.dev}:${stats.ino}\0${stats.size}\0${stats.mtimeMs}\0${stats.ctimeMs}`;
  const cached = anchorLineCounts.get(key);
  if (cached && cached.identity === identity) return { inTree: true, exists: true, lines: cached.lines };

  let content;
  try {
    content = readFileSync(realTarget, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { inTree: true, exists: false, lines: 0 };
    return null;
  }

  // A trailing newline does not open a further line, so an anchor at that
  // "line" points past the end of the file.
  const lines = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
  if (anchorLineCounts.size >= ANCHOR_CACHE_LIMIT) anchorLineCounts.clear();
  anchorLineCounts.set(key, { identity, lines });
  return { inTree: true, exists: true, lines };
}

/**
 * §7: "File and line references point to current code." Two separate claims,
 * and the record proves neither on its own.
 *
 * validateFinding() checks the JavaScript TYPES of an affectedPaths entry, which
 * is the right rule for a Candidate — but `{ file: "", line: -1 }` is `{string,
 * number}` and points at nothing, and `{ file: "does/not/exist.js", line: 999999 }`
 * is perfectly well-formed while naming no code at all. Well-formedness is
 * therefore only the first half; the second half is resolved against the audited
 * tree by `anchorResolver`, which fails CLOSED — an anchor nobody could check is
 * an unchecked box, not a passed one.
 *
 * `anchorResolver` is injectable so this stays testable against a synthetic tree
 * (and so a caller auditing a checkout elsewhere can point it there). Injecting
 * `() => ({ inTree: true, exists: true, lines: Infinity })` deliberately turns
 * the tree half off — a caller confirming findings against an OLD revision that
 * is no longer checked out is the one legitimate reason to do that.
 */
function anchorWellFormed(p) {
  return {
    file: isNonBlankString(p.file) && normalizeRepoPath(p.file) !== "",
    line: Number.isInteger(p.line) && p.line >= 1,
  };
}

/**
 * The half of the anchor rule that needs no filesystem: an anchor has to NAME a
 * file and a line before there is any point asking the tree about it.
 *
 * Split out from the tree half so triage.js — which validates records at
 * closeout and at publication, long after the slice run — can apply it without
 * dragging a working-tree read into a module that has none.
 */
function anchorShapeErrors(finding) {
  if (!Array.isArray(finding.affectedPaths)) return [];  // validateFinding() reports this
  const errors = [];
  finding.affectedPaths.forEach((p, i) => {
    if (!p || typeof p !== "object") return;             // validateFinding() reports this too
    const wellFormed = anchorWellFormed(p);
    if (!wellFormed.file) {
      errors.push(`affectedPaths[${i}].file must name a file that can be opened, got ` +
        `${JSON.stringify(p.file)} — a Confirmed finding's anchor has to point at current code`);
    }
    if (!wellFormed.line) {
      errors.push(`affectedPaths[${i}].line must be a whole line number of 1 or more, got ` +
        `${JSON.stringify(p.line)} — NaN, 0, and negative lines point at no line in any file`);
    }
  });
  return errors;
}

export function anchorTreeErrors(finding, anchorResolver) {
  if (!Array.isArray(finding.affectedPaths)) return [];  // validateFinding() reports this
  const errors = [];
  finding.affectedPaths.forEach((p, i) => {
    if (!p || typeof p !== "object") return;             // validateFinding() reports this too

    const { file: wellFormedFile, line: wellFormedLine } = anchorWellFormed(p);
    // Shape failures are anchorShapeErrors()' to report; here they only mean
    // there is nothing to look up.
    if (!wellFormedFile) return;

    const resolved = anchorResolver(p.file);
    if (!resolved || typeof resolved !== "object") {
      errors.push(`affectedPaths[${i}] (${p.file}) could not be checked against the audited tree — ` +
        `"file and line references point to current code" is an unchecked box, not a passed one`);
      return;
    }
    if (!resolved.inTree) {
      errors.push(`affectedPaths[${i}] (${p.file}) resolves outside the audited tree — an anchor into ` +
        `another checkout is not an anchor into the code under audit`);
      return;
    }
    if (!resolved.exists) {
      errors.push(`affectedPaths[${i}] (${p.file}) names no file in the audited tree — a Confirmed ` +
        `finding cannot anchor to code that is not there (was it moved, or is the finding stale?)`);
      return;
    }
    if (wellFormedLine && Number.isFinite(resolved.lines) && p.line > resolved.lines) {
      errors.push(`affectedPaths[${i}] points at ${p.file}:${p.line}, but that file has ` +
        `${resolved.lines} line${resolved.lines === 1 ? "" : "s"} — the reference does not point at ` +
        `current code`);
    }
  });
  return errors;
}

/**
 * Exported because T8's triage gate needs the SAME trail rules at a later
 * moment: by then the trail has grown an outcome edge, and a record whose
 * `status` and whose trail disagree is exactly the ledger row a closeout would
 * count two different ways. Restating these rules in triage.js would be a
 * second copy of the lifecycle graph in all but name.
 *
 * transitionFinding() builds the next record by SPREADING `finding.history`
 * (`[...(finding.history || [])]`), so any truthy non-iterable value there —
 * `{}` from a hand-edited ledger row, a half-decoded JSON column — throws a
 * TypeError out of this wrapper instead of the structured failure it promises,
 * and takes the whole slice run down with it. This is checked on EVERY
 * transition, not only Confirmed: the cheap Rejected path is exactly the one a
 * malformed record is most likely to travel.
 */
export function historyErrors(finding) {
  const { history } = finding;
  if (history === undefined || history === null) return [];

  if (!Array.isArray(history)) {
    return [`history must be an array of {from, to, at} entries when present, got ` +
      `${JSON.stringify(history)} — the transition spreads it, so a non-iterable value ` +
      `crashes the run rather than failing the record`];
  }

  const errors = [];
  history.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`history[${i}] must be a {from, to, at} entry, got ${JSON.stringify(entry)}`);
      return;
    }
    // All three fields are REQUIRED, not merely checked when they happen to be
    // there: transitionFinding() writes every one of them on every transition,
    // so an entry missing any of them did not come from a transition. `{}` is a
    // gap in the audit trail wearing an entry's clothes — it records neither
    // which statuses were traversed nor when — and an optional-if-present rule
    // would preserve it untouched through every future transition.
    for (const field of ["from", "to"]) {
      if (entry[field] === undefined || entry[field] === null) {
        errors.push(`history[${i}].${field} is missing — an entry that does not say which status the ` +
          `finding moved ${field === "from" ? "out of" : "into"} records no transition`);
      } else if (!SCHEMA.STATUSES.includes(entry[field])) {
        errors.push(`history[${i}].${field} must be one of ${SCHEMA.STATUSES.join("/")}, got ` +
          `${JSON.stringify(entry[field])} — a status trail that names no known status records nothing`);
      }
    }
    // transitionFinding() stamps `at` with an ISO timestamp. A trail with no
    // WHEN cannot be ordered against the revision the finding was found at,
    // which is the one thing the trail exists to make auditable.
    if (!isNonBlankString(entry.at) || !Number.isFinite(Date.parse(entry.at))) {
      errors.push(`history[${i}].at must be a readable timestamp (the ISO string transitionFinding() ` +
        `writes), got ${JSON.stringify(entry.at)} — an undated transition cannot be placed in the trail`);
    }

    // Two known statuses are not yet a transition that could have happened.
    // schema.js owns the lifecycle graph (§3.4), and every entry in the trail
    // is supposed to be one edge of it that transitionFinding() actually took —
    // so "Rejected -> Fixed" is a claim about a move out of a terminal state
    // that no code in this repository can make. Checked against the same table
    // the next transition will be checked against, never a second copy.
    const from = entry.from;
    const to = entry.to;
    if (SCHEMA.STATUSES.includes(from) && SCHEMA.STATUSES.includes(to) &&
        !(SCHEMA.TRANSITIONS[from] || []).includes(to)) {
      errors.push(`history[${i}] records ${from} -> ${to}, which is not a transition the lifecycle ` +
        `allows (from ${from}: ${(SCHEMA.TRANSITIONS[from] || []).join(", ") || "none — terminal state"})`);
    }

    // The trail is one path through that graph, so each entry must start where
    // the previous one ended. A trail that jumps describes two different
    // findings, and nothing records what happened in the gap.
    const previous = history[i - 1];
    if (i > 0 && previous && typeof previous === "object" && !Array.isArray(previous) &&
        SCHEMA.STATUSES.includes(previous.to) && SCHEMA.STATUSES.includes(from) && previous.to !== from) {
      errors.push(`history[${i}] starts at ${from}, but history[${i - 1}] left the finding at ` +
        `${previous.to} — the trail has a gap, and nothing records how the status changed across it`);
    }

    // A trail is a sequence in TIME, not merely a connected path. Checking only
    // that each `at` parses leaves "Candidate -> Confirmed on the 22nd" sitting
    // above "Confirmed -> Planned on the 21st" — a record that says triage
    // decided the outcome before the evidence gate confirmed the finding.
    // Nothing downstream can repair that: T8 dates a finding by its trail, so
    // the record is credited to whichever wave the out-of-order stamp names,
    // and the closeout counts a finding the wave never examined.
    //
    // Equal stamps pass. transitionFinding() writes millisecond ISO strings, so
    // two transitions applied in one batch legitimately share a stamp; only
    // going BACKWARDS is the impossible thing.
    const at = Date.parse(entry.at);
    const previousAt = Date.parse(previous?.at);
    if (i > 0 && Number.isFinite(at) && Number.isFinite(previousAt) && at < previousAt) {
      errors.push(`history[${i}] is stamped ${JSON.stringify(entry.at)}, before history[${i - 1}] at ` +
        `${JSON.stringify(previous.at)} — a status trail runs forwards, and a transition recorded ` +
        `before the one it follows dates the finding to a wave it was never examined in`);
    }
  });

  // Where the trail ends IS the finding's status. If it is not, one of the two
  // is wrong, and appending the next transition would preserve the disagreement
  // forever — a Candidate whose trail already says it was Rejected is a record
  // claiming a terminal state it is not in.
  const last = history[history.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) &&
      SCHEMA.STATUSES.includes(last.to) && SCHEMA.STATUSES.includes(finding.status) &&
      last.to !== finding.status) {
    errors.push(`history ends at ${last.to}, but the finding's status is ${finding.status} — the trail ` +
      `and the record disagree about where the finding actually is`);
  }
  return errors;
}

/**
 * §7's Finding Exit Gate, minus the one question a record cannot answer about
 * itself: whether its anchors still point at code in the tree right now.
 *
 * Exported because confirmation is not the last moment these facts matter.
 * T8 closes a wave and exports findings to public issues, and a record that
 * merely CLAIMS to have been confirmed — a truncated ledger row, a hand-edited
 * one, a replayed one — has to be measured against the same boxes the gate
 * would have made it check. validateFinding() alone cannot do that job there:
 * it tests presence, so `violatedInvariant: "   "` and `line: 0` clear it, and
 * §7's confirmation facts (revision, variants, duplicate search, model, tokens)
 * are outside its field list entirely by design.
 *
 * Pure: no filesystem, no clock, no network. The tree half is
 * anchorTreeErrors(), which callers add when they can and must fail closed
 * when they cannot.
 */
export function confirmationFieldErrors(finding) {
  const errors = [...validateFinding(finding).errors, ...anchorShapeErrors(finding)];

  for (const field of CONFIRMATION_STRING_FIELDS) {
    if (finding[field] !== undefined && finding[field] !== null && !isNonBlankString(finding[field])) {
      errors.push(`${field} must be a non-empty string, got ${JSON.stringify(finding[field])} — ` +
        `a field that is present but unreadable checks no box`);
    }
  }
  for (const [field, shape] of Object.entries(CONFIRMATION_PATH_FIELDS)) {
    if (isNonBlankString(finding[field]) && !isPlaceholder(finding[field]) && !shape.accepts(finding[field])) {
      errors.push(`${field} must name ${shape.expected}, got ${JSON.stringify(finding[field])}`);
    }
  }

  // "Expected and actual behavior are distinguishable." Two identical strings
  // describe no defect at all — and DISTINGUISHABLE is about the behaviors, not
  // the bytes. A leading space, a doubled space, or a capital letter is a
  // formatting difference; a reader still sees the same sentence twice, and the
  // §7 box is still unchecked. So both sides are normalized before comparing.
  if (isNonBlankString(finding.expected) && isNonBlankString(finding.actual) &&
      comparableText(finding.expected) === comparableText(finding.actual)) {
    errors.push(`expected (${JSON.stringify(finding.expected)}) and actual ` +
      `(${JSON.stringify(finding.actual)}) describe the same behavior, so no defect is described — ` +
      `whitespace and capitalization are not a difference in behavior`);
  }

  for (const field of PLACEHOLDER_CHECKED_FIELDS) {
    if (isPlaceholder(finding[field])) {
      errors.push(`${field} is a placeholder (${JSON.stringify(finding[field])}), not an answer — ` +
        `an unchecked box on the exit gate cannot be checked by writing "TBD" in it`);
    }
  }

  if (!isNonBlankString(finding.revision)) {
    errors.push(`revision must record the exact commit/working-tree state the finding was found at, ` +
      `got ${JSON.stringify(finding.revision)} — a file:line reference means nothing without it`);
  }
  if (!Array.isArray(finding.variantsConsidered) || finding.variantsConsidered.length === 0 ||
      !finding.variantsConsidered.every(isNonBlankString)) {
    errors.push(`variantsConsidered must name the variants weighed (SQLite/Postgres, local/cloud, ` +
      `browser/MCP, ...) as a non-empty array of strings, got ${JSON.stringify(finding.variantsConsidered)}`);
  }
  errors.push(...duplicateSearchErrors(finding.duplicateSearch));
  if (!isNonBlankString(finding.model)) {
    errors.push(`model must record which model produced the finding, got ${JSON.stringify(finding.model)}`);
  }
  errors.push(...tokenErrors(finding.tokens));

  return errors;
}

/** §7's Finding Exit Gate: every applicable box, not just the record schema. */
function confirmationGateErrors(finding, anchorResolver) {
  return [...confirmationFieldErrors(finding), ...anchorTreeErrors(finding, anchorResolver)];
}

/**
 * Attempt a finding-status transition, gated on evidence for the one
 * transition T6.2 is about: escalating INTO Confirmed. schema.js's
 * transitionFinding() already enforces the state graph (T3.2); this adds the
 * two gates transitionFinding() has no way to know about — the evidence gate,
 * and §7's Finding Exit Gate on the RECORD — then delegates to it so the two
 * never disagree about which transitions exist.
 *
 * The record gate applies to Confirmed only, and reuses schema.js's
 * validateFinding() rather than restating its field list. A candidate may
 * still be Rejected while half-formed — that is the cheap outcome T6.2 wants
 * to stay available — but a finding with no file/line reference, no violated
 * invariant, and no distinguishable expected/actual cannot be confirmed no
 * matter how good the evidence item attached to it looks.
 */
export function checkCandidateEscalation({
  finding, toStatus, evidenceItems = [],
  anchorResolver = resolveAnchorInTree,
  commandVerifier = defaultCommandVerifier,
} = {}) {
  // transitionFinding() reads finding.status unconditionally; a missing or
  // non-object finding would throw there instead of returning a structured
  // failure. Malformed audit data is exactly what this module reports on,
  // never something it should let crash the process running it.
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return { ok: false, errors: [`finding must be an object with a status field, got ${JSON.stringify(finding)}`] };
  }

  const errors = [...historyErrors(finding)];

  if (toStatus === "Confirmed") {
    const at = `finding ${finding?.id ?? "(no id)"}`;

    // §7's Finding Exit Gate on the record itself. Evidence proves a claim; it
    // does not supply the claim's file/line references, invariant, revision,
    // variants weighed, duplicate search, or model/token cost.
    errors.push(...confirmationGateErrors(finding, anchorResolver)
      .map((e) => `${at}: cannot become Confirmed — ${e}`));

    const classified = classifyCandidateEvidence(evidenceItems,
      { anchorResolver, candidate: finding, commandVerifier });
    errors.push(...classified.errors.map((e) => `${at}: ${e}`));
    if (!classified.hasIndependentEvidence) {
      errors.push(`${at}: cannot become Confirmed — ` +
        (classified.modelAgreementOnly
          ? "only model-agreement evidence is present; a second model concurring is not independent evidence"
          : "no independent evidence (file/line, static trace, reproduction, or focused test) was supplied"));
    }
  }

  if (errors.length) return { ok: false, errors };

  const transition = transitionFinding(finding, toStatus);
  if (!transition.ok) return { ok: false, errors: [transition.error] };
  return { ok: true, errors: [], finding: transition.finding };
}

// ── T6.3 — lens and escalation budget ────────────────────────────────────

// aperio-continuous-audit.md §4: "Give the model the general protocol plus
// exactly one primary lens. A second lens is a separate pass only when risk
// justifies it" — and precision adjudication is budgeted separately (§4's
// routing table) and reserved for "the small fraction of evidence that
// warrants it." Both kinds of extra spend need the same recorded override.
// aperio-continuous-audit.md §3.3's third funnel stage costs nothing to
// budget against (it never leaves the machine), so it is a recognized kind
// that is simply excluded from the primary/precision arithmetic below.
const RECON_LENS_KIND = "local-reconnaissance";
const PRIMARY_LENS_KIND = "primary-cloud";
const PRECISION_LENS_KIND = "precision-adjudication";
export const LENS_KINDS = [RECON_LENS_KIND, PRIMARY_LENS_KIND, PRECISION_LENS_KIND];

// §4's routing table reserves adjudication for "the small fraction of
// evidence that warrants it" and names frontier/reasoning models for it
// (Opus, Codex, GPT-5-class). A model matching this marker is precision-tier
// no matter what `kind` it was declared under — including the free
// local-reconnaissance kind, which is exempt from the budget only because it
// never leaves the machine. The guard must not be bypassable by mislabeling a
// frontier call as a cheap lens, whichever cheap lens is chosen.
// Callers with their own model roster should inject `isPrecisionModel`.
// `reason(er|ing)` is one alternative, not two spellings of the same word:
// DeepSeek's reasoning tier is served under the official alias
// `deepseek-reasoner`, while §4's routing table reserves the primary lens for
// "the currently available non-reasoning DeepSeek coding model". Matching only
// "reasoning" would let the reasoner alias bill as a routine primary lens.
//
// The generic markers above are not enough on their own: the frontier tiers
// Aperio actually bills for are named in lib/pricing.js, and `claude-sonnet-5`
// and `gemini-2.5-pro` contain none of those words. A default that misses the
// catalog's own top tiers would let the most expensive routine call in the
// project bill as a primary lens with no override, which is precisely the spend
// T6.3 is here to make deliberate. So the flagship FAMILY names are matched
// too — Anthropic's Opus/Sonnet/Fable, OpenAI's GPT-5 line, and the `-pro`
// suffix Google and DeepSeek both use for their frontier tier. Cheap tiers
// (`-flash`, `-mini`, `haiku`) carry no marker and stay routine, and `pro` is
// matched only as a whole path/name segment so "provider" is not a frontier
// model. The bias is deliberate: a mislabeled cheap call costs one recorded
// override, a mislabeled frontier call costs the budget this guard protects.
const DEFAULT_PRECISION_MODEL_MARKER =
  /opus|sonnet|fable|gpt-5|\bo1\b|\bo3\b|frontier|reason(?:er|ing)|codex|(?:^|[\s._/-])pro(?:$|[\s._/-])/i;
const defaultIsPrecisionModel = (model) => DEFAULT_PRECISION_MODEL_MARKER.test(String(model ?? ""));

// local-reconnaissance is exempt from the budget for exactly ONE reason — §3.3:
// it never leaves the machine. That exemption is a claim about WHERE the call
// ran, and `kind` is the declaration being checked, so it cannot also be the
// proof. Otherwise a routine cloud call labeled local-reconnaissance spends a
// second cloud lens for free, which is the precise thing T6.3 forbids.
// So locality must be established from something OTHER than the budget label,
// and it fails CLOSED: a recon entry naming a model nobody can place as local
// is budgeted as the cloud call it probably is.
//
// The model NAME cannot carry this on its own — the repo's own local model is
// "qwen2.5-coder-7b", a name that reads exactly like a hosted one, and a name
// list would rot the moment the roster changes. The primary signal is therefore
// the run's `provider`, the same field the runtime already records, with model
// markers only as a fallback for names that state the runtime outright.
// Callers with a real roster should inject `isLocalModel` the way they inject
// `isPrecisionModel` — a self-declared `provider` is a weaker claim than a
// classifier that knows what actually ran.
const DEFAULT_LOCAL_MODEL_MARKER = /llama[\s._-]?cpp|llama-server|\bgguf\b|\bollama\b|\blocal\b|localhost|127\.0\.0\.1|transformers|ripgrep|tree-sitter/i;
const DEFAULT_LOCAL_PROVIDERS = ["llamacpp", "llama.cpp", "ollama", "local", "transformers"];
const defaultIsLocalModel = (model, usage = {}) =>
  DEFAULT_LOCAL_PROVIDERS.includes(String(usage?.provider ?? "").trim().toLowerCase()) ||
  DEFAULT_LOCAL_MODEL_MARKER.test(String(model ?? ""));

/**
 * Enforce T6.3: at most one primary-cloud lens per slice without a recorded
 * override, and any precision-adjudication use requires one unconditionally.
 * An override must name a reason, a human approver, and the finding ID(s) it
 * covers — "including associated finding IDs" is not optional decoration, and
 * those IDs are checked against `knownFindingIds` (the slice's own
 * candidate/finding IDs) so an override authorizes the findings that warranted
 * the spend rather than any well-formed string.
 * A lens use with an unrecognized `kind`, one declared under ANY cheaper kind
 * while naming a precision-tier model, or a local-reconnaissance entry naming a
 * model that cannot be placed as local, fails closed: it is budgeted as the
 * cloud call it appears to be rather than silently skipping the guard.
 */
export function checkLensBudget({
  sliceId, lensUsage = [], overrides = [], knownFindingIds,
  isPrecisionModel = defaultIsPrecisionModel,
  isLocalModel = defaultIsLocalModel,
} = {}) {
  const errors = [];

  // A malformed (non-array) lensUsage is not "no lens usage" — it is a
  // record this guard cannot read, and every precision/extra-lens invocation
  // it might contain would otherwise pass silently. Only an OMITTED value
  // (the [] default) means "genuinely nothing to report."
  if (lensUsage !== undefined && !Array.isArray(lensUsage)) {
    return {
      ok: false,
      errors: [`${sliceId ?? "(unnamed slice)"}: lensUsage must be an array, got ` +
        `${JSON.stringify(lensUsage)} — treating a malformed usage record as empty could hide every ` +
        `precision or additional-lens invocation it contains`],
      primaryLensCount: 0, precisionCount: 0,
    };
  }
  const usage = lensUsage ?? [];
  const overrideList = Array.isArray(overrides) ? overrides : [];

  // The slice's own candidate/finding IDs — what an override is allowed to
  // name. `null` means the caller supplied no set (or an unreadable one), and
  // that is an UNCHECKED box, not a passed one: without it, `findingIds:
  // ["unrelated"]` authorizes a precision call that no finding ever asked for.
  const knownIds = Array.isArray(knownFindingIds)
    ? new Set(knownFindingIds.filter(isNonBlankString).map((id) => id.trim()))
    : null;

  // Usage ids must be present and unique so an override can be tied to ONE
  // specific invocation. Without this, two entries that both omit `id` (or
  // that share one by accident) would both match — or both fail to match —
  // the same override, which is not "an override for THIS invocation."
  const seenIds = new Map();
  usage.forEach((u, i) => {
    if (!isNonBlankString(u?.id)) return;
    if (seenIds.has(u.id)) {
      errors.push(`${sliceId ?? "(unnamed slice)"}: lensUsage id "${u.id}" is used by more than one ` +
        `entry (index ${seenIds.get(u.id)} and ${i}) — usage ids must be unique so an override can be ` +
        `tied to a specific invocation`);
    } else {
      seenIds.set(u.id, i);
    }
  });

  // Unrecognized kind is a hard, unconditional data error — the record itself
  // is malformed and no override can cure that. A frontier-tier model labeled
  // primary-cloud is different: it is a curable misclassification, so it is
  // reclassified to precision-adjudication and folded into the SAME override
  // requirement every other precision use has, with a reason that says why.
  const classified = usage.map((u, i) => {
    const label = `${sliceId ?? "(unnamed slice)"}: lensUsage[${i}] "${u?.id ?? "(no id)"}"`;
    if (!LENS_KINDS.includes(u?.kind)) {
      errors.push(`${label}: kind must be one of ${LENS_KINDS.join("/")}, got ${JSON.stringify(u?.kind)} — ` +
        `an unrecognized lens kind cannot be exempted from the budget guard`);
      return { ...u, effectiveKind: PRECISION_LENS_KIND, reclassifyReason: null };
    }
    // The model identity is the ONLY thing separating a routine primary call
    // from a precision one. A budgeted entry that names no model cannot be
    // classified at all, so it fails closed to precision rather than being
    // waved through as routine — otherwise omitting one field would be the
    // cheapest way to hide a frontier invocation. Reconnaissance may name no
    // model (a ripgrep pass is not a model call), but a model value that is
    // present must still be readable.
    const modelPresent = u.model !== undefined && u.model !== null;
    if (modelPresent && !isNonBlankString(u.model)) {
      errors.push(`${label}: model must be a non-empty string, got ${JSON.stringify(u.model)} — ` +
        `a model that cannot be read cannot be classified as routine or precision`);
      return { ...u, effectiveKind: PRECISION_LENS_KIND, reclassifyReason: null };
    }
    if (u.kind !== RECON_LENS_KIND && !modelPresent) {
      errors.push(`${label}: ${u.kind} use names no model — model identity is what distinguishes ` +
        `routine use from precision use, so an unnamed one is treated as precision`);
      return { ...u, effectiveKind: PRECISION_LENS_KIND, reclassifyReason: null };
    }
    if (u.kind !== PRECISION_LENS_KIND && isPrecisionModel(u.model)) {
      return {
        ...u, effectiveKind: PRECISION_LENS_KIND,
        reclassifyReason: `model "${u.model}" is labeled ${u.kind} but matches a precision-tier ` +
          `model — it must be declared ${PRECISION_LENS_KIND} and carry an override`,
      };
    }
    // A recon entry with NO model is exempt because a ripgrep or tree-sitter
    // sweep is not a model call at all. That reading only holds while nothing in
    // the record says otherwise: an entry recording `provider: "anthropic"` and
    // no model is a cloud call with one field left blank, and omitting the model
    // must not be a cheaper way to hide a lens than naming it. So a recorded
    // provider that cannot be placed as local budgets the entry as the cloud
    // call it describes; an absent (or known-local) provider keeps the ripgrep
    // exemption. An unreadable provider value fails closed the same way.
    if (u.kind === RECON_LENS_KIND && !modelPresent) {
      const providerRecorded = u.provider !== undefined && u.provider !== null;
      if (providerRecorded && !isLocalModel(u.model, u)) {
        return {
          ...u, effectiveKind: PRIMARY_LENS_KIND,
          reclassifyReason: `provider ${JSON.stringify(u.provider)} is labeled ${RECON_LENS_KIND} and ` +
            `names no model, but cannot be placed as local — a model-free entry is exempt only when it ` +
            `records no provider (a local tool such as ripgrep) or a local one, so this is budgeted as ` +
            `a ${PRIMARY_LENS_KIND} lens`,
        };
      }
      return { ...u, effectiveKind: u.kind, reclassifyReason: null };
    }
    // The recon exemption is a claim that the call never left the machine. A
    // model that cannot be placed as local is budgeted as a primary cloud lens,
    // so it competes for the one-primary-per-slice budget like any other cloud
    // call instead of riding along free under the cheapest label.
    if (u.kind === RECON_LENS_KIND && !isLocalModel(u.model, u)) {
      return {
        ...u, effectiveKind: PRIMARY_LENS_KIND,
        reclassifyReason: `model "${u.model}" is labeled ${RECON_LENS_KIND} but cannot be placed as ` +
          `a local model (no local \`provider\` recorded) — the recon exemption exists only because ` +
          `the call never leaves the machine, so this is budgeted as a ${PRIMARY_LENS_KIND} lens`,
      };
    }
    return { ...u, effectiveKind: u.kind, reclassifyReason: null };
  });

  const primary = classified.filter((u) => u.effectiveKind === PRIMARY_LENS_KIND);
  const precision = classified.filter((u) => u.effectiveKind === PRECISION_LENS_KIND);
  const extraPrimary = primary.slice(1);
  const needsOverride = [...extraPrimary, ...precision];

  for (const use of needsOverride) {
    const label = `${sliceId ?? "(unnamed slice)"}: ${use.kind} use "${use.id ?? "(no id)"}" (${use.model ?? "unknown model"})`;

    // An override can only ever authorize a specific, named invocation. A use
    // with no id has nothing an override can name — matching it against an
    // override that ALSO omits lensUsageId (undefined === undefined) would
    // approve it by accident, and would do the same for every other no-id
    // use sharing that same override.
    if (!isNonBlankString(use.id)) {
      errors.push(`${label} has no id — a lens use that needs an override must carry a non-empty, ` +
        `unique string id so a specific override can name it`);
      continue;
    }
    const override = overrideList.find((o) => isNonBlankString(o?.lensUsageId) && o.lensUsageId === use.id);
    if (!override) {
      errors.push(`${label} has no recorded human override — ` + (use.reclassifyReason ??
        "a second cloud lens or any precision-model use requires a recorded human override/adjudication reason"));
      continue;
    }
    if (!isNonBlankString(override.reason)) {
      errors.push(`${label}: override is missing an adjudication reason`);
    }
    // approvedBy must NAME a human. `{}` and `[]` are not blank, but they name
    // nobody — accepting them would satisfy the recorded-human-override
    // requirement with no human on record at all.
    if (!isNonBlankString(override.approvedBy)) {
      errors.push(`${label}: override is missing the human approver (approvedBy) as a non-empty ` +
        `string, got ${JSON.stringify(override.approvedBy)}`);
    }
    const findingIds = override.findingIds;
    const validFindingIds = Array.isArray(findingIds) && findingIds.length > 0 &&
      findingIds.every(isNonBlankString);
    if (!validFindingIds) {
      errors.push(`${label}: override must name the associated finding ID(s) as non-empty strings (findingIds)`);
    } else if (knownIds === null) {
      // Well-formed is not the same as associated. §4 spends precision on "the
      // small fraction of evidence that warrants it", so the IDs must identify
      // findings this slice actually produced — which cannot be established
      // against a set nobody supplied.
      errors.push(`${label}: override names finding ID(s) ${JSON.stringify(findingIds)} that could not ` +
        `be checked — pass knownFindingIds (the slice's candidate/finding IDs) so an override is tied ` +
        `to findings that exist, not to any string`);
    } else {
      const unknown = findingIds.map((id) => id.trim()).filter((id) => !knownIds.has(id));
      if (unknown.length) {
        errors.push(`${label}: override names finding ID(s) ${JSON.stringify(unknown)} that are not ` +
          `findings of this slice (${[...knownIds].join(", ") || "none recorded"}) — precision spend must ` +
          `be tied to the evidence that warranted it`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    primaryLensCount: primary.length,
    precisionCount: precision.length,
  };
}

// ── T6.4 — duplicate search ───────────────────────────────────────────────

/**
 * One spelling per file. A ledger row written as "./lib/routes/paths.js", a
 * GitHub issue quoting "lib//routes/paths.js", and a Windows-recorded
 * "lib\routes\paths.js" all name the same file — but as raw strings they are
 * three different Set keys, and the candidate would be cleared as Distinct
 * against its own duplicate. Comparison happens on the normalized form.
 *
 * A leading "/" is preserved: absolute and repo-relative are a real
 * difference, and collapsing them could merge two genuinely distinct findings,
 * which loses a finding rather than duplicating one.
 */
function normalizeRepoPath(file) {
  const raw = file.trim().replace(/\\/g, "/");
  const segments = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && segments.length && segments[segments.length - 1] !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return (raw.startsWith("/") ? "/" : "") + segments.join("/");
}

// A path is only a usable match KEY if it survives normalization. ".", "./",
// and "foo/.." are all non-blank strings that normalize to "" — they name no
// file, produce no comparison key, and would leave the search comparing
// nothing while reporting the actionable "Distinct" verdict.
const namesAComparableFile = (file) => isNonBlankString(file) && normalizeRepoPath(file) !== "";

/** Distinct file paths named by a finding/candidate's affectedPaths. */
function affectedFiles(record) {
  return new Set((Array.isArray(record?.affectedPaths) ? record.affectedPaths : [])
    .map((p) => p?.file)
    .filter(namesAComparableFile)
    .map(normalizeRepoPath));
}

/**
 * Classify a candidate against supplied ledger/GitHub-issue records. A match
 * requires the SAME violated invariant AND at least one shared affected file
 * — "invariant and affected path identify the same finding" (T6.4). A record
 * that only shares a symptom string, with a different invariant, is reported
 * as related but stays Distinct — that is the edge case T6.4 names
 * explicitly: "same symptom but different root cause remains a distinct
 * linked finding."
 */
export function classifyDuplicate(candidate, existingRecords = []) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") {
    errors.push(`candidate must be an object, got ${JSON.stringify(candidate)}`);
  }
  // The invariant is the primary match key, and it is compared by value. An
  // object or array is neither missing nor comparable: it can never equal any
  // record's invariant, so the search silently matches nothing and returns the
  // actionable Distinct verdict on malformed data. Same rule as file names.
  if (!isNonBlankString(candidate?.violatedInvariant)) {
    errors.push(`candidate violatedInvariant must be a non-empty string — it is the key duplicate ` +
      `search matches on — got ${JSON.stringify(candidate?.violatedInvariant)}`);
  }
  if (!Array.isArray(candidate?.affectedPaths) || candidate.affectedPaths.length === 0) {
    errors.push("candidate is missing affectedPaths — duplicate search cannot compare by file");
  } else {
    // A non-empty affectedPaths whose entries name no COMPARABLE file — no file
    // at all (e.g. [{ line: 1 }]), or one like "." or "foo/.." that normalizes
    // away to nothing — yields an empty file set, so no path comparison happens
    // at all, and "Distinct" is the verdict that clears the way to file a NEW
    // finding. Every entry must name a real file, or the search is not a search.
    candidate.affectedPaths.forEach((p, i) => {
      if (!namesAComparableFile(p?.file)) {
        errors.push(`candidate affectedPaths[${i}] names no comparable file (got ${JSON.stringify(p?.file)}) — ` +
          `duplicate search would compare against nothing and wrongly report Distinct`);
      }
    });
  }
  if (existingRecords !== undefined && !Array.isArray(existingRecords)) {
    errors.push(`existingRecords must be an array, got ${JSON.stringify(existingRecords)} — treating a ` +
      `malformed collection as empty would silently miss a real duplicate`);
  } else {
    // The records are the SEARCH SPACE. A record this filter cannot read is
    // skipped silently, and a skipped record is indistinguishable from a
    // record that did not match — so a partially decoded ledger row could be
    // the exact duplicate the candidate is being cleared against. Each record
    // is held to the same shape the candidate is.
    (existingRecords ?? []).forEach((r, i) => {
      const at = `existingRecords[${i}] (${r?.id ?? "no id"})`;
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        errors.push(`${at} must be an object, got ${JSON.stringify(r)}`);
        return;
      }
      if (!isNonBlankString(r.id)) {
        errors.push(`${at} has no usable id — a match this search cannot name is not a usable result`);
      }
      if (!isNonBlankString(r.violatedInvariant)) {
        errors.push(`${at} has no violatedInvariant as a non-empty string (got ` +
          `${JSON.stringify(r.violatedInvariant)}) — it cannot be compared, only skipped`);
      }
      if (!Array.isArray(r.affectedPaths) || r.affectedPaths.length === 0 ||
          !r.affectedPaths.every((p) => namesAComparableFile(p?.file))) {
        errors.push(`${at} has no affectedPaths naming comparable files (got ${JSON.stringify(r.affectedPaths)}) — ` +
          `it cannot be compared by file, only skipped`);
      }
    });
  }

  // A malformed candidate or an unreadable record collection means no valid
  // search happened at all. "Distinct" is an actionable verdict — it is what
  // clears the way to create a new finding — so it must never be the result
  // of a search that could not actually run.
  if (errors.length) {
    return { classification: "invalid", matches: [], relatedBySymptom: [], errors };
  }

  const records = Array.isArray(existingRecords) ? existingRecords : [];
  const candidateFiles = affectedFiles(candidate);

  const matches = records.filter((r) => {
    if (!isNonBlankString(r?.violatedInvariant) || r.violatedInvariant !== candidate.violatedInvariant) return false;
    const files = affectedFiles(r);
    return [...candidateFiles].some((f) => files.has(f));
  });

  if (matches.length) {
    return {
      classification: "Duplicate",
      matches: matches.map((m) => ({ id: m.id, source: m.source ?? "unknown" })),
      relatedBySymptom: [],
      errors,
    };
  }

  const relatedBySymptom = records.filter((r) =>
    isNonBlankString(r?.symptom) && isNonBlankString(candidate.symptom) &&
    r.symptom === candidate.symptom &&
    r.violatedInvariant !== candidate.violatedInvariant,
  ).map((m) => ({ id: m.id, source: m.source ?? "unknown" }));

  return { classification: "Distinct", matches: [], relatedBySymptom, errors };
}
