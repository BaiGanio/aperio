// audit/scripts/triage.js
//
// T8 — triage findings into action (aperio-continuous-audit.md Step 8;
// aperio-continuous-audit-tests.md T8.1-T8.3). Pure, injectable checks over
// records T6 already produced — this module never calls GitHub, a cloud
// provider, a model, or starts a server/MCP process.
//
// It reads the working tree in exactly one place, through the same injectable
// `anchorResolver` slice-execution.js uses: checkPublicExport, because §7's
// "file and line references point to current code" is the one confirmation box
// no record can check about itself, and publication is where a stale anchor
// costs the most. Every other check here is answerable from the ledger record
// in front of it, and checkFindingTriage / checkWaveTriage stay pure.
//
// It owns no vocabulary of its own. The five triage outcomes are read straight
// out of schema.js's transition table (SCHEMA.TRANSITIONS.Confirmed), so
// "which outcomes may a confirmed finding take?" has exactly one answer in the
// codebase, and adding a sixth outcome to the lifecycle graph automatically
// teaches this gate about it.
//
//   T8.1  checkFindingTriage / checkWaveTriage — every confirmed finding
//         carries exactly one outcome, with an owner and a real date; nothing
//         is left sitting at Confirmed when the wave closes.
//   T8.2  checkPublicExport — a high/critical finding cannot be exported to a
//         public issue until its disclosure classification is recorded, and a
//         summary that is cleared for publication may not carry the secrets,
//         commands, or payloads its own reproduction contains.
//   T8.3  checkFindingTriage — a finding whose outcome is real code work names
//         a concrete regression-test file and an assertion design; one whose
//         outcome is not code work explains why no regression test applies.
//
// Deliberately NOT here: the disclosure gate is scoped to the act of exporting,
// so checkWaveTriage does not run it. A wave can close correctly with a
// critical finding whose disclosure has not been decided yet — the decision is
// owed at publication, which is where checkPublicExport stands.

import {
  COMMAND_RUNNERS, NEVER_PROSE_RUNNERS, WINDOWS_RUNNERS, NO_ARGUMENT_BINARIES,
  PATH_QUALIFIED_EXECUTABLE, PATH_QUALIFIED_SHELL_EXECUTABLE,
  RUNNABLE_COMMAND, commandInLine, comparableText, executableName,
  isBlank, isNonBlankString,
} from "./record-shapes.js";
import { SCHEMA } from "./schema.js";
import {
  anchorTreeErrors, confirmationFieldErrors, historyErrors, resolveAnchorInTree,
} from "./slice-execution.js";

// ── shared record vocabulary ──────────────────────────────────────────────

/**
 * The outcomes a Confirmed finding may take, read from the ONE lifecycle graph
 * rather than restated. aperio-continuous-audit-tests.md T8.1 names
 * Duplicate/AcceptedRisk/DocumentationOnly/Planned/IssueFiled; schema.js's
 * TRANSITIONS.Confirmed is that list, and keeping a literal copy here is how
 * the two would eventually disagree about what triage is allowed to decide.
 */
export const CONFIRMED_OUTCOMES = SCHEMA.TRANSITIONS.Confirmed;

/**
 * Outcomes that commit someone to changing behavior. Step 8: "Each accepted
 * code finding must name its red regression test before implementation." Both
 * of these keep a `-> Fixed` edge in schema.js, which is precisely what makes
 * them code work: something is still owed and will later be verified.
 */
export const CODE_FIX_OUTCOMES = CONFIRMED_OUTCOMES.filter(
  (outcome) => (SCHEMA.TRANSITIONS[outcome] || []).includes("Fixed"),
);

/**
 * A Duplicate owes no rationale and no regression test, because the record it
 * duplicates owns both. Requiring them here would produce two half-tracked
 * copies of one problem, which is the exact outcome T6.4's duplicate search
 * exists to prevent.
 */
const NO_TEST_RATIONALE_EXEMPT = ["Duplicate"];

/**
 * Terminal outcomes that accept the behavior as it stands. T8.3:
 * "documentation-only and accepted-risk findings explain why no code
 * regression test applies."
 *
 * Derived by subtraction rather than listed, so that a sixth outcome added to
 * schema.js's graph lands in exactly one of these buckets instead of silently
 * landing in none — an outcome no bucket claims would owe neither a test nor
 * a reason for having none.
 */
export const NO_CODE_FIX_OUTCOMES = CONFIRMED_OUTCOMES.filter(
  (outcome) => !CODE_FIX_OUTCOMES.includes(outcome) && !NO_TEST_RATIONALE_EXEMPT.includes(outcome),
);

/** T8.1: "with owner and date." */
export const TRIAGE_DECISION_REQUIRED_FIELDS = ["outcome", "owner", "date"];

/**
 * Strings that occupy a required field without answering it. Matched against
 * the WHOLE normalized value, never as a substring: "none identified" and "no
 * regression test applies because the behavior is intentional" are real
 * answers that happen to contain these words, and flagging them would push
 * authors toward padding rather than explaining.
 */
const PLACEHOLDER_ANSWERS = new Set([
  "tbd", "to be decided", "todo", "n/a", "na", "none", "nil", "null",
  "unknown", "-", "--", "?", "??", "???", "later", "soon", "pending",
  "see above", "see below", "as above",
]);

const isPlaceholder = (value) => PLACEHOLDER_ANSWERS.has(comparableText(value));

/** A field that must carry a real, non-placeholder answer. */
const isRealAnswer = (value) => isNonBlankString(value) && !isPlaceholder(value);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A triage date has to identify a day. "soon", "this week", and "2026-02-31"
 * are all non-blank strings that pin the decision to no point in time, and a
 * decision with no date cannot be reconciled against a wave boundary in T9 —
 * which is the whole reason T8.1 requires one.
 *
 * The WHOLE value has to be a date. An earlier version sliced off the first ten
 * characters and validated only those, which accepted "2026-08-21garbage" and
 * "2026-08-21Tnot-a-time" — a corrupted or half-templated field that reads as a
 * clean decision date to every downstream reader while carrying something else
 * entirely. So the value must be either exactly YYYY-MM-DD or a complete ISO
 * timestamp, and nothing may trail it.
 *
 * The round-trip through Date is the second guarantee: the regex accepts
 * "2026-02-31", and only re-serializing catches a day that does not exist in
 * the month it claims.
 */
function isRecordedDate(value) {
  if (!isNonBlankString(value)) return false;
  const text = value.trim();
  const isDayOnly = ISO_DATE.test(text);
  if (!isDayOnly && !ISO_TIMESTAMP.test(text)) return false;

  const day = text.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return false;

  // A full timestamp must also be a real instant: the pattern above admits
  // "2026-08-21T25:99Z", which names an hour and minute that do not exist.
  return isDayOnly || !Number.isNaN(Date.parse(text));
}

/**
 * Whether a value looks like a path to a test file. Deliberately a SHAPE check
 * and not an existence check: the whole point of T8.3 is a RED regression test,
 * which by definition has not been written when the fix is being approved.
 * Requiring the file to exist would invert the gate — it would pass only after
 * the work it is gating had already been done — and would drag a working-tree
 * read into a module that otherwise needs none.
 */
/**
 * The suite roots this repository actually EXECUTES, and the filenames each
 * runner picks up inside them.
 *
 * A convention check is not enough. "somewhere under a tests/ directory, or
 * with a .test. infix" is satisfied by `scratch/tests/foo.js`,
 * `node_modules/pkg/tests/foo.test.js`, and `lib/foo.test.js` — none of which
 * any configured command runs, so a code finding could close T8.3 promising a
 * regression test CI will never execute. That is the same empty promise as
 * naming a path outside the checkout, only harder to see.
 *
 * The filename patterns matter as much as the roots: `scripts/run-tests.js`
 * collects `*.test.js` and nothing else, so `tests/docint/grading.mjs` is a
 * module the graders import, not a test the suite runs. tests/browser is the
 * one exception — Playwright's default testMatch also takes `.spec.` and
 * TypeScript.
 *
 * This table tracks the `test:*` scripts in package.json. When a script gains
 * or loses a directory, change it here too; the alternative — reading
 * package.json — would drag a working-tree read into a module that otherwise
 * needs none, for a list that changes about once a year.
 */
const TEST_SUITE_ROOTS = [
  // `npm test` -> scripts/run-tests.js, plus the per-suite `test:*` scripts.
  { root: "tests/unit", file: /\.test\.js$/ },
  { root: "tests/integration", file: /\.test\.js$/ },
  { root: "tests/e2e", file: /\.test\.js$/ },
  { root: "tests/harness", file: /\.test\.js$/ },
  { root: "tests/docint", file: /\.test\.js$/ },
  // `npm run test:browser` -> playwright, tests/playwright.config.js.
  { root: "tests/browser", file: /\.(test|spec)\.(js|mjs|cjs|ts|mts|cts)$/ },
  // `npm run test:audit` -> `scripts/run-tests.js audit/tests`. The script used
  // to name every file, so accepting this root promised a regression run that a
  // forgotten package.json edit would silently skip. The shared collector is
  // what makes the promise true: it walks the root itself, so a new `.test.js`
  // anywhere under it is executed with no registration step to forget, and it
  // exits non-zero rather than report green on an empty file list.
  //
  // It has to RECURSE, because this table matches on the root as a PREFIX: it
  // accepts `audit/tests/security/foo.test.js` the moment it accepts the root at
  // all. A shell glob was the wrong instrument twice over — `*` does not descend,
  // and `node --test` only gained its own glob expansion in Node 22 — the
  // recursive walk here needs no minimum floor at all.
  { root: "audit/tests", file: /\.test\.js$/ },
];

export function looksLikeTestFile(value) {
  if (!isNonBlankString(value)) return false;
  const path = value.trim().replace(/\\/g, "/");
  // A sentence is not a path. "I will add a test to paths.test.js" names a
  // file inside prose, and prose is a promise, not a location.
  if (/\s/.test(path)) return false;

  // The location must be inside the checkout, expressed the way the repository
  // refers to its own files. `/Users/someone/scratch/ghost.test.js`,
  // `C:/tmp/ghost.test.js`, `~/ghost.test.js`, and `../../tests/ghost.js` all
  // satisfy the extension and directory conventions below while naming a file
  // the repository's own suite will never run — so the wave closes promising a
  // red test at a location no CI run can reach, which is the same as promising
  // none. A repository-relative path with no `..` segment is the only shape
  // that survives being handed to someone else's checkout.
  //
  // A URI is the same escape wearing different clothes:
  // `https://example.com/tests/foo.test.js` and `file://tests/foo.js` are
  // neither slash-prefixed nor drive-prefixed, and both carry a `tests` segment
  // that would satisfy the directory convention below. So ANY scheme prefix is
  // refused — one rule that covers `https:`, `file:`, `data:`, and the `C:`
  // drive letter alike, because none of them is a path this repository can
  // resolve against its own root.
  if (path.startsWith("/") || path.startsWith("~")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
  if (path.split("/").includes("..")) return false;

  // `./audit/tests/x.test.js` and `audit/./tests/x.test.js` are the same file
  // as the plain spelling, and the prefix comparison below is literal, so the
  // no-op segments come off first.
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length < 2) return false;
  const normalized = segments.join("/");
  const basename = segments[segments.length - 1];

  // The path must land in a suite some configured command actually runs, under
  // a filename that command collects. Either half alone is a promise nobody
  // can keep: the right directory holding a README, or a perfectly named
  // `.test.js` sitting where no runner looks.
  return TEST_SUITE_ROOTS.some(({ root, file }) =>
    normalized.startsWith(`${root}/`) && file.test(basename));
}

// ── T8.1 / T8.3 — one outcome per finding, and who owes a test ────────────

/**
 * How many recorded transitions leave Confirmed. This is what makes "exactly
 * one outcome" checkable: a hand-merged or replayed ledger row can carry two
 * decisions (Confirmed -> AcceptedRisk and Confirmed -> Planned), and the
 * `status` field only ever shows whichever was written last, so counting the
 * trail is the only way to see the one that was overwritten.
 *
 * Whether each edge is LEGAL is not re-decided here — schema.js's
 * transitionFinding and slice-execution.js's status-trail check already own
 * that graph. This function only counts, so the two never disagree.
 */
function outcomeEdges(history) {
  if (!Array.isArray(history)) return null;
  const usable = history.filter(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry) &&
      isNonBlankString(entry.from) && isNonBlankString(entry.to),
  );
  // A history array whose entries are not readable is not a shorter history,
  // it is an unreadable one — counting the readable subset would report "one
  // outcome" for a record whose second outcome simply failed to decode.
  if (usable.length !== history.length) return null;
  return usable.filter((entry) => entry.from === "Confirmed");
}

const invalidFinding = (errors) => ({
  classification: "invalid", ok: false, outcome: null, errors,
});

/**
 * A record on the triaged path, bucketed by whether its decision holds up.
 *
 * The outcome is carried either way — it is what checkPublicExport reads to
 * recognize a Duplicate, and a diagnosis is more useful than a blank — but the
 * BUCKET follows `ok`. Returning "triaged" for a record that failed its own
 * checks is what let a wave closeout print a clean triaged count over records
 * with no confirmation facts, no trail, and no decision behind them.
 */
const triagedFinding = (outcome, errors) => ({
  classification: errors.length === 0 ? "triaged" : "invalid",
  ok: errors.length === 0,
  outcome,
  errors,
});

/**
 * T6's trail rules, plus the one thing they cannot express: that the trail
 * EXISTS at all.
 *
 * historyErrors() returns clean for `history: undefined`, which is correct
 * where it lives — validateFinding accepts a Candidate that has never been
 * transitioned. Past Candidate it is a hole: a status is a claim about a
 * journey, and a record asserting "Planned" with no trail has produced no
 * evidence that it ever passed through Candidate -> Confirmed. Requiring the
 * trail here is what turns `status` from an assertion into a checkable one.
 *
 * A NONEMPTY trail is not the whole of that guarantee either. T6's rules check
 * that every entry is a legal edge, that the entries connect, and that the last
 * one lands on the finding's status — all of which a hand-authored
 * `[{ from: "Confirmed", to: "Planned" }]` satisfies while recording no
 * confirmation at all, so a status and an outcome typed onto a bare row would
 * collect full wave coverage. Candidate is the graph's only entry point —
 * nothing in SCHEMA.TRANSITIONS leads back into it — so every journey a real
 * finding took begins there, and requiring that first edge is what makes the
 * trail evidence of the evidence gate instead of a restatement of the status.
 */
function trailErrorsFor(finding, label) {
  const errors = historyErrors(finding).map((e) => `${label}: ${e}`);
  if (errors.length > 0) return errors;
  if (!Array.isArray(finding.history) || finding.history.length === 0) {
    return [`${label}: status is "${finding.status}" but the record carries no status trail — ` +
      `a status without the transitions that produced it is a claim, not a history`];
  }
  if (finding.history[0]?.from !== "Candidate") {
    return [`${label}: the status trail begins at ${JSON.stringify(finding.history[0]?.from)}, not ` +
      `Candidate — every finding enters the lifecycle as a Candidate, so a trail starting anywhere ` +
      `else is missing the transitions that would show this record ever faced the evidence gate`];
  }
  return [];
}

/**
 * Validate one post-wave finding record against Step 8.
 *
 * `classification` is separate from `ok` for the same reason it is in T6's
 * exit gate: "orphaned" and "untriaged" are accurate descriptions of a real
 * state, not malformed data, but neither of them is a wave that may close.
 *
 *   triaged    — reached one of CONFIRMED_OUTCOMES (or past it, via Fixed /
 *                Reopened) with a complete decision record. COMPLETE is the
 *                whole word: a record on this path whose confirmation facts,
 *                trail, or decision do not hold up is not a triaged record with
 *                a footnote — it lands in `invalid`, because a closeout that
 *                counts it as triaged reports work that was never done.
 *   orphaned   — still sitting at Confirmed. T8.1's headline assertion.
 *   untriaged  — still sitting at Candidate: the human triage never reached it.
 *   rejected   — closed by T6.2's evidence gate before triage; see below.
 *   invalid    — the record cannot be read, or reads but does not hold up, so
 *                its outcome is not a fact the closeout may count.
 */
export function checkFindingTriage(finding, { knownRecordIds, ineligibleRecordStatuses } = {}) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return invalidFinding([`finding must be an object, got ${JSON.stringify(finding)}`]);
  }
  if (!isNonBlankString(finding.id)) {
    return invalidFinding([`finding has no usable id (got ${JSON.stringify(finding.id)}) — an outcome ` +
      `that names no finding cannot be reconciled against the wave's finding set`]);
  }

  const label = `finding "${finding.id}"`;
  if (!isNonBlankString(finding.status) || !SCHEMA.STATUSES.includes(finding.status)) {
    return invalidFinding([`${label}: status must be one of ${SCHEMA.STATUSES.join("/")}, got ` +
      `${JSON.stringify(finding.status)} — an unrecognized status must not be sorted into a bucket ` +
      `by guesswork`]);
  }

  if (finding.status === "Candidate") {
    return {
      classification: "untriaged", ok: false, outcome: null,
      errors: [`${label} is still a Candidate at wave closeout — the human triage in Step 8 never ` +
        `reached it, so it is neither rejected nor confirmed`],
    };
  }
  // T6 already owns what makes a status trail well formed: every entry a real
  // edge, connected to its neighbour, ending where the finding actually is.
  // Running those rules HERE too is not redundancy — the trail has grown since
  // confirmation, and the newest edge is exactly the one nothing has checked
  // yet. Computed once, before the status branches, because EVERY status past
  // Candidate makes a claim about a journey the trail is the only evidence for.
  const trailErrors = trailErrorsFor(finding, label);

  if (finding.status === "Confirmed") {
    return {
      classification: "orphaned", ok: false, outcome: null,
      errors: [...trailErrors,
        `${label} is Confirmed with no recorded outcome — every confirmed finding must take ` +
        `exactly one of ${CONFIRMED_OUTCOMES.join("/")} before the wave closes`],
    };
  }
  if (finding.status === "Rejected") {
    // Rejection is not a human triage outcome in this system: T6.2's evidence
    // gate is what rejects a candidate, at slice time, on the evidence. It
    // therefore owes no owner/date decision record here — demanding one would
    // ask a human to re-sign work the gate already did deterministically.
    //
    // It does owe the transition. `{ id, status: "Rejected" }` used to return
    // ok with nothing behind it, which made a rejected stub the cheapest way to
    // give a truncated or hand-edited ledger full coverage credit for a finding
    // that was never examined: checkWaveTriage counts the id as present and
    // closes the wave.
    //
    // `trailErrors` is the whole check, and it is enough: Candidate is the only
    // source of an edge into Rejected in schema.js's graph, and the trail rules
    // already require the trail to exist, to be legal, and to END at the
    // finding's status. Those three together mean a valid trail ending at
    // Rejected necessarily contains Candidate -> Rejected, so asserting that
    // edge separately would be a rule no input can violate.
    return {
      classification: "rejected",
      ok: trailErrors.length === 0,
      outcome: trailErrors.length === 0 ? "Rejected" : null,
      errors: trailErrors,
    };
  }

  // Without the trail check a record can carry status "AcceptedRisk" over a
  // trail ending at Planned and still read as triaged, leaving the closeout in
  // T9 free to count it as either.
  const errors = [...trailErrors];

  // Past Confirmed, the record asserts it CLEARED the confirmation gate, and a
  // wave closeout hands out coverage credit on the strength of that assertion.
  // The trail is not evidence of it: two syntactically valid history lines can
  // be written onto a row carrying nothing but an id, a status, and a triage
  // decision, and every other check in this function would pass — a truncated
  // or hand-merged ledger row gets full credit exactly where the rejected-stub
  // rule above was written to stop it. So the §7 confirmation fields are
  // re-checked here, on the record as it stands now.
  //
  // Rejected is exempt above for the opposite reason: T6.2 rejects candidates
  // precisely so a half-formed one can be closed cheaply, and demanding a
  // complete confirmation record of a record that was never confirmed would
  // make the cheap outcome the expensive one.
  //
  // The anchor half of §7 — "the file:line still points at current code" —
  // needs the working tree and stays out of this module; checkPublicExport
  // adds it at the one moment it is worth a filesystem read.
  errors.push(...confirmationFieldErrors(finding).map((e) => `${label}: ${e}`));
  const edges = outcomeEdges(finding.history);
  if (edges === null) {
    errors.push(`${label}: history must be an array of readable {from, to} transitions (got ` +
      `${JSON.stringify(finding.history)}) — without the trail, one outcome and two overwritten ` +
      `outcomes are the same record`);
  } else if (edges.length === 0) {
    errors.push(`${label}: status is "${finding.status}" but no recorded transition leaves Confirmed — ` +
      `the outcome was written onto the record without a decision behind it`);
  } else if (edges.length > 1) {
    errors.push(`${label}: ${edges.length} recorded outcomes leave Confirmed ` +
      `(${edges.map((e) => e.to).join(", ")}) — a confirmed finding takes exactly one, or the wave ` +
      `has two owners for one problem and the ledger shows only the last`);
  }

  // The outcome the TRAIL records, which is the one that actually happened.
  // `status` alone cannot be trusted for this: Fixed and Reopened are both
  // downstream of an outcome, so on those records `status` does not name it.
  const recordedOutcome = edges?.length === 1 ? edges[0].to : null;
  if (recordedOutcome !== null && !CONFIRMED_OUTCOMES.includes(recordedOutcome)) {
    errors.push(`${label}: the transition leaving Confirmed goes to "${recordedOutcome}", which is not ` +
      `a triage outcome (${CONFIRMED_OUTCOMES.join("/")})`);
  }

  const decision = finding.triage;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    errors.push(`${label}: triage must be a decision record object with ` +
      `${TRIAGE_DECISION_REQUIRED_FIELDS.join("/")}, got ${JSON.stringify(decision)}`);
    return triagedFinding(recordedOutcome, errors);
  }

  for (const field of TRIAGE_DECISION_REQUIRED_FIELDS) {
    if (isBlank(decision[field])) errors.push(`${label}: triage is missing required field: ${field}`);
  }
  // owner must NAME a person or team. `{}` and `[]` are not blank but name
  // nobody, and "TBD" names nobody later — either way the finding has no owner,
  // which is the state T8.1 exists to make impossible.
  if (!isBlank(decision.owner) && !isRealAnswer(decision.owner)) {
    errors.push(`${label}: triage.owner must name a person or team, got ` +
      `${JSON.stringify(decision.owner)} — an outcome nobody owns is an untriaged finding with a ` +
      `status on it`);
  }
  if (!isBlank(decision.date) && !isRecordedDate(decision.date)) {
    errors.push(`${label}: triage.date must be a real calendar day in YYYY-MM-DD form, got ` +
      `${JSON.stringify(decision.date)}`);
  }

  // The decision record and the lifecycle trail must agree about what was
  // decided. If they can disagree, the ledger has two answers and the closeout
  // in T9 will count whichever one it happens to read.
  if (!isBlank(decision.outcome)) {
    if (!CONFIRMED_OUTCOMES.includes(decision.outcome)) {
      errors.push(`${label}: triage.outcome must be one of ${CONFIRMED_OUTCOMES.join("/")}, got ` +
        `${JSON.stringify(decision.outcome)}`);
    } else if (recordedOutcome !== null && decision.outcome !== recordedOutcome) {
      errors.push(`${label}: triage.outcome is "${decision.outcome}" but the recorded transition out ` +
        `of Confirmed goes to "${recordedOutcome}" — the decision record and the lifecycle trail ` +
        `must name the same outcome`);
    }
  }

  const outcome = CONFIRMED_OUTCOMES.includes(decision.outcome) ? decision.outcome : recordedOutcome;

  if (outcome === "Duplicate") {
    // T6.4's classifyDuplicate returns matches[].id precisely so this link can
    // be recorded. A Duplicate with nothing on the other end is not a tracked
    // finding, it is a closed one — the single easiest way for a real problem
    // to leave the ledger looking handled.
    if (!isRealAnswer(decision.duplicateOf)) {
      errors.push(`${label}: outcome Duplicate must name the record it duplicates ` +
        `(triage.duplicateOf, the id classifyDuplicate matched), got ` +
        `${JSON.stringify(decision.duplicateOf)}`);
    } else if (comparableText(decision.duplicateOf) === comparableText(finding.id)) {
      // A self-reference satisfies every other check on this field while
      // pointing at nothing: the record is closed as already-tracked, and the
      // thing tracking it is itself. No other record then owns the remediation
      // or the regression test, so the Duplicate outcome quietly discards a
      // real finding — the one failure this whole gate exists to prevent.
      errors.push(`${label}: outcome Duplicate names itself as the record it duplicates ` +
        `(${JSON.stringify(decision.duplicateOf)}) — a finding cannot be the duplicate that ` +
        `tracks it, and closing it this way leaves nobody owning the fix`);
    } else if (ineligibleRecordStatuses instanceof Map &&
               ineligibleRecordStatuses.has(comparableText(decision.duplicateOf))) {
      // A record can EXIST and still be the wrong end of this link. Rejected
      // means T6.2's evidence gate threw that claim out on the evidence, and
      // Candidate means nothing has examined it yet — neither is a finding that
      // tracks anything, so neither can be the "existing tracked finding" a
      // Duplicate closes against. Without this, a wave could reject a claim and
      // then close a second, real finding as a duplicate of the rejected one,
      // leaving nobody owning the fix or the regression test.
      errors.push(`${label}: outcome Duplicate names ${JSON.stringify(decision.duplicateOf)}, whose own ` +
        `status is ${ineligibleRecordStatuses.get(comparableText(decision.duplicateOf))} — a record at ` +
        `that status owns neither the remediation nor the regression test, so closing this one against ` +
        `it leaves nobody owning the fix`);
    } else if (knownRecordIds instanceof Set &&
               !knownRecordIds.has(comparableText(decision.duplicateOf))) {
      // A typo in this field has the same effect as a self-reference: the
      // finding closes as tracked, and the record supposedly tracking it does
      // not exist. checkWaveTriage supplies the wave's own ids plus any ledger
      // ids the caller passes, so the link is resolved rather than assumed.
      errors.push(`${label}: outcome Duplicate names ${JSON.stringify(decision.duplicateOf)}, which is ` +
        `not a known record — a link to a record nobody can find closes this finding with nobody ` +
        `owning the fix`);
    }
  }

  errors.push(...regressionTestErrors(finding, decision, outcome, label));

  return triagedFinding(outcome, errors);
}

/**
 * T8.3 — a code finding owns a red regression test; a non-code outcome explains
 * why it does not. Split out from checkFindingTriage only for readability; it
 * is not independently useful, because which rule applies is decided by the
 * outcome that function just established.
 */
function regressionTestErrors(finding, decision, outcome, label) {
  const errors = [];
  if (outcome === null || NO_TEST_RATIONALE_EXEMPT.includes(outcome)) return errors;

  if (CODE_FIX_OUTCOMES.includes(outcome)) {
    // schema.js already requires regressionTestLocation to be PRESENT on any
    // valid finding. What triage adds is that it must be a location — a
    // present field reading "a unit test" satisfies the schema and points
    // nowhere an assertion can be written.
    if (!looksLikeTestFile(finding.regressionTestLocation)) {
      errors.push(`${label}: outcome ${outcome} is code work, so regressionTestLocation must name a ` +
        `concrete test file inside a suite this repository runs (${TEST_SUITE_ROOTS.map((s) => s.root).join(", ")}), ` +
        `named the way that suite's runner collects it, got ` +
        `${JSON.stringify(finding.regressionTestLocation)}`);
    }
    if (!isRealAnswer(finding.regressionTestAssertion)) {
      errors.push(`${label}: outcome ${outcome} is code work, so regressionTestAssertion must design ` +
        `the failing assertion, got ${JSON.stringify(finding.regressionTestAssertion)} — Step 8 ` +
        `requires the red test to be named BEFORE implementation, not after`);
    } else if (
      // Pasting the finding's own title or impact into the assertion field
      // fills it without designing anything. The assertion has to say what a
      // test would check; restating the problem is what the finding already
      // does in `title`, `expected`, and `actual`.
      //
      // Whether `expected` and `actual` themselves describe two different
      // behaviors is NOT re-checked here — T6's confirmation gate settled that
      // before this finding was ever Confirmed, and a second copy of the rule
      // is a second thing to keep in step.
      comparableText(finding.regressionTestAssertion) === comparableText(finding.title ?? "") ||
      comparableText(finding.regressionTestAssertion) === comparableText(finding.impact ?? "")
    ) {
      errors.push(`${label}: regressionTestAssertion repeats the finding's own ` +
        `${comparableText(finding.regressionTestAssertion) === comparableText(finding.title ?? "") ? "title" : "impact"} ` +
        `verbatim — it must describe what the test asserts, not restate the problem`);
    }
    return errors;
  }

  if (NO_CODE_FIX_OUTCOMES.includes(outcome)) {
    if (!isRealAnswer(decision.noRegressionTestRationale)) {
      errors.push(`${label}: outcome ${outcome} changes no behavior, so triage.noRegressionTestRationale ` +
        `must explain why no code regression test applies, got ` +
        `${JSON.stringify(decision.noRegressionTestRationale)} — an unexplained "no test needed" is ` +
        `indistinguishable from a fix nobody got around to`);
    }
  }
  return errors;
}

// ── T8.1 — wave closeout ─────────────────────────────────────────────────

const emptyWaveTriage = (errors) => ({
  ok: false, errors, triaged: [], rejected: [], orphaned: [],
  untriaged: [], invalid: [], missing: [], unexpected: [], duplicated: [],
});

/**
 * Duplicate links that lead nowhere because they lead back.
 *
 * Self-reference is caught per finding, but A -> B -> A is invisible from
 * inside either record: each one names a real, different, existing record, so
 * every per-finding check passes. The wave is the smallest scope that can see
 * the loop — and a loop is the same failure as a self-reference, just longer:
 * every finding on it is closed as tracked by another, and none of them owns
 * the remediation or the regression test.
 *
 * Only findings whose OUTCOME is Duplicate form edges. A chain that leaves the
 * wave, or ends at a finding with a real outcome, terminates and is fine.
 */
function duplicateCycleErrors(findings) {
  const linkOf = new Map();
  for (const finding of findings) {
    if (!isNonBlankString(finding?.id) || finding.triage?.outcome !== "Duplicate") continue;
    if (!isNonBlankString(finding.triage.duplicateOf)) continue;
    linkOf.set(comparableText(finding.id), comparableText(finding.triage.duplicateOf));
  }

  const errors = [];
  const settled = new Set();
  for (const start of linkOf.keys()) {
    if (settled.has(start)) continue;
    const path = [];
    const onPath = new Set();
    for (let at = start; at !== undefined && !settled.has(at); at = linkOf.get(at)) {
      if (onPath.has(at)) {
        errors.push(`the Duplicate links ${[...path.slice(path.indexOf(at)), at].join(" -> ")} form a ` +
          `cycle — every finding on it is closed as tracked by another, so none of them is tracked ` +
          `at all and nobody owns the fix`);
        break;
      }
      onPath.add(at);
      path.push(at);
    }
    for (const id of onPath) settled.add(id);
  }
  return errors;
}

/**
 * The records outside this wave that a Duplicate may be closed against.
 *
 * Two entry shapes, and the difference between them is who is doing the
 * checking:
 *
 *   { id, status }  — a record whose lifecycle this system tracks. Its status
 *                     is REQUIRED and is checked HERE, against
 *                     LEDGER_OWNER_STATUSES — narrower than the wave's own
 *                     confirmed-or-later rule, because an in-wave record is
 *                     validated in full and this one is two fields. It is
 *                     the only form this gate can verify, so a missing status is
 *                     refused rather than waved through: a partial database
 *                     projection that dropped the column would otherwise let a
 *                     Duplicate close against a Candidate or a Rejected record.
 *   "ID-123"        — a bare id, which asserts something this gate cannot see:
 *                     that the caller already filtered the list down to records
 *                     eligible to own a finding. It exists for the records that
 *                     have no lifecycle status to give — a GitHub issue, an
 *                     entry in another team's tracker — and it is a promise,
 *                     not a check. A bare id whose status you DO know is the
 *                     one way an unsupported record still reaches this set.
 */
function readLedgerEntries(entries) {
  if (!Array.isArray(entries)) {
    return { eligible: [], ineligible: [], errors: [`ledgerRecordIds must be an array of record ids ` +
      `or {id, status} records (empty is allowed), got ${JSON.stringify(entries)}`] };
  }

  const eligible = [];
  const ineligible = [];
  const errors = [];

  entries.forEach((entry, i) => {
    if (isNonBlankString(entry)) {
      eligible.push(comparableText(entry));
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !isNonBlankString(entry.id)) {
      errors.push(`ledgerRecordIds[${i}] must be a record id or a {id, status} record, got ` +
        `${JSON.stringify(entry)}`);
      return;
    }
    // A missing status is refused rather than read as "nothing to check". The
    // record shape says this is a tracked record, so silently dropping back to
    // the bare-id promise would let an absent column — a partial projection, a
    // renamed field — close a Duplicate against a Candidate. A caller that
    // really is asserting prefiltered eligibility says so with the string form.
    if (isBlank(entry.status)) {
      errors.push(`ledgerRecordIds[${i}].status is required on a {id, status} record, got ` +
        `${JSON.stringify(entry)} — a record whose status this gate cannot read must be passed as a ` +
        `bare id, which states plainly that the caller vouched for it`);
      return;
    }
    // A status that is present but unreadable is refused rather than ignored.
    // Dropping back to "no status given" would turn a typo into the bare-id
    // promise above, which is precisely the assertion the caller was trying to
    // make good on by sending the status in the first place.
    if (!SCHEMA.STATUSES.includes(entry.status)) {
      errors.push(`ledgerRecordIds[${i}].status must be one of ${SCHEMA.STATUSES.join("/")}, got ` +
        `${JSON.stringify(entry.status)} — an unreadable status must not be sorted into ` +
        `a bucket by guesswork`);
      return;
    }
    if (LEDGER_OWNER_STATUSES.includes(entry.status)) eligible.push(comparableText(entry.id));
    else ineligible.push([comparableText(entry.id), entry.status]);
  });

  return { eligible, ineligible, errors };
}

/**
 * Reconcile a closing wave's findings against Step 8.
 *
 * `expectedFindingIds` is required rather than defaulted, exactly as
 * checkWaveExitGate requires `expectedSlices`: a triage run measured only
 * against the records handed to it will report a clean wave when the ledger
 * read returned half the rows, or none. An explicitly empty array is a real
 * answer — "this wave produced no findings" — and passes; a missing one is a
 * caller who never said what completion would mean.
 */
export function checkWaveTriage(findings, { expectedFindingIds, ledgerRecordIds = [] } = {}) {
  if (!Array.isArray(expectedFindingIds) || !expectedFindingIds.every(isNonBlankString)) {
    return emptyWaveTriage([`expectedFindingIds must be an array of finding ids (empty is allowed, and ` +
      `means the wave produced no findings), got ${JSON.stringify(expectedFindingIds)} — without the ` +
      `set the wave is measured against, a partial ledger read would close as a clean wave`]);
  }
  if (!Array.isArray(findings)) {
    return emptyWaveTriage([`findings must be an array of finding records, got ` +
      `${JSON.stringify(findings)} — treating a malformed wave as empty would close it without ` +
      `checking a single finding`]);
  }

  const expected = new Set(expectedFindingIds);
  if (expected.size !== expectedFindingIds.length) {
    return emptyWaveTriage([`expectedFindingIds contains duplicate ids (${expectedFindingIds.length} ` +
      `entries, ${expected.size} distinct) — the set a wave is measured against must name each ` +
      `finding once`]);
  }

  const ledger = readLedgerEntries(ledgerRecordIds);
  if (ledger.errors.length > 0) return emptyWaveTriage(ledger.errors);

  // What a Duplicate is allowed to point at: another finding in this wave, or a
  // record from the wider ledger / issue tracker the caller names. Anything else
  // is a link nobody can follow.
  //
  // Existing is not the same as eligible. A Rejected record was contradicted or
  // left unsupported, and a Candidate has not been examined at all — neither
  // owns a remediation, so neither can be the tracked finding a Duplicate is
  // closed against. They are collected separately, WITH their status, so the
  // refusal names the real reason instead of claiming the record is missing.
  const inWave = findings.filter((f) => isNonBlankString(f?.id));
  const ineligibleRecordStatuses = new Map([
    // A ledger entry that CARRIES a status is checked here, exactly like an
    // in-wave record: an external finding sitting at Candidate or Rejected is
    // no more able to own a remediation than one inside the wave, and reading
    // it as eligible merely because it arrived from outside is the same hole
    // one step further away.
    ...ledger.ineligible,
    ...inWave
      .filter((f) => !isNonBlankString(f.status) || !EXPORTABLE_STATUSES.includes(f.status))
      .map((f) => [comparableText(f.id), isNonBlankString(f.status) ? f.status : "unreadable"]),
  ]);
  // In-wave records are added last and ineligibility is subtracted after both,
  // so the wave's own copy always wins: when the wave says Rejected, that is
  // the record's current state, and a stale ledger entry must not vote it back
  // into eligibility.
  const knownRecordIds = new Set([
    ...ledger.eligible,
    ...inWave.map((f) => comparableText(f.id)),
  ].filter((id) => !ineligibleRecordStatuses.has(id)));

  const errors = [];
  const buckets = { triaged: [], rejected: [], orphaned: [], untriaged: [], invalid: [] };
  const seen = new Map();

  findings.forEach((finding, i) => {
    const result = checkFindingTriage(finding, { knownRecordIds, ineligibleRecordStatuses });
    const label = isNonBlankString(finding?.id) ? finding.id : `findings[${i}]`;
    errors.push(...result.errors);
    buckets[result.classification].push(label);

    // Coverage is counted on the finding id alone. A record with no usable id
    // is already `invalid`; crediting it to some finding would let it stand in
    // for one that is genuinely absent.
    if (isNonBlankString(finding?.id)) seen.set(finding.id, (seen.get(finding.id) ?? 0) + 1);
  });

  errors.push(...duplicateCycleErrors(findings));

  const duplicated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  const unexpected = [...seen.keys()].filter((id) => !expected.has(id));
  const missing = expectedFindingIds.filter((id) => !seen.has(id));

  for (const id of duplicated) {
    errors.push(`finding "${id}" appears ${seen.get(id)} times in the wave — one record per finding, ` +
      `or two triage decisions for one problem both look complete`);
  }
  for (const id of unexpected) {
    errors.push(`finding "${id}" is not part of the finding set being closed — a record from another ` +
      `wave must not be counted as this one's coverage`);
  }
  if (missing.length) {
    errors.push(`the wave's finding set is not covered — no record for: ${missing.join(", ")}`);
  }

  return { ok: errors.length === 0, errors, ...buckets, missing, unexpected, duplicated };
}

// ── T8.2 — security disclosure gate ──────────────────────────────────────

/** Severities whose publication could hand someone a working attack. */
export const DISCLOSURE_REQUIRED_SEVERITIES = ["high", "critical"];

/**
 * How a confirmed finding may be published. Only `public` permits an export;
 * the other two are decisions to withhold, which is why they are recorded
 * rather than merely absent.
 */
export const DISCLOSURE_CLASSIFICATIONS = ["public", "private", "embargoed"];

const DISCLOSURE_REQUIRED_FIELDS = ["classification", "decidedBy", "date"];

/**
 * Every status Confirmed can reach, plus Confirmed itself — computed from the
 * lifecycle graph rather than listed, so a new outcome added to schema.js is
 * exportable without anyone remembering to update a literal here.
 *
 * Step 8 triages CONFIRMED findings, and §4.7 discards a candidate that has no
 * evidence "before cross-review". Candidate and Rejected are the two statuses
 * outside this set, and they are precisely the records that must never reach a
 * public issue: T6.2 exists to stop an unsupported claim escalating, and
 * publishing one would escalate it further than Confirmed ever would.
 */
function reachableFrom(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of SCHEMA.TRANSITIONS[queue.pop()] || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export const EXPORTABLE_STATUSES = [...reachableFrom("Confirmed")];

/**
 * The statuses an EXTERNAL record may hold and still own a Duplicate.
 *
 * Narrower than EXPORTABLE_STATUSES, and deliberately so. An in-wave record is
 * validated in full — its trail, its triage decision, its regression test are
 * all read by checkFindingTriage — so "confirmed-or-later" is backed by the
 * whole record. A ledger entry is two fields and a promise: nothing here can
 * read the record behind it. So the status itself has to carry the ownership:
 *
 *   Confirmed — examined, and nothing decided yet. No remediation, no issue, no
 *     regression test; closing a Duplicate against it leaves the fix unowned,
 *     which is exactly the failure the duplicate rules exist to prevent.
 *   Duplicate — points at a record this gate cannot see, so the chain dangles
 *     one link further out than the in-wave cycle check can follow.
 *   Reopened — the earlier decision was undone. Something will own it again,
 *     but nothing does today.
 *
 * A caller who knows better says so with the bare-id form, which is the shape
 * that means "I vouched for this one".
 */
const UNOWNED_LEDGER_STATUSES = new Set(["Confirmed", "Duplicate", "Reopened"]);
export const LEDGER_OWNER_STATUSES =
  EXPORTABLE_STATUSES.filter((status) => !UNOWNED_LEDGER_STATUSES.has(status));

/**
 * Values that are a redaction rather than a leak. Without this, the
 * assigned-secret rule below would block a summary for saying
 * `password=<redacted>`, teaching authors to describe the leak vaguely instead
 * of showing plainly that a secret was there and was removed.
 */
// The repeated-character markers require a RUN of three or more. A mask is
// conventionally written long enough to read as one (`***`, `xxxxxxxx`), while
// `auth=x` is a one-character value — and once the length floor on values was
// removed, treating a lone `x` as redaction became the last way a short
// credential could still slip through.
const REDACTION_MARKER = /^[<[(]?(redacted|removed|omitted|elided|masked|scrubbed|\*{3,}|x{3,}|\.{3}|…)[>\])]?$/i;

/**
 * Shapes that are a secret no matter what surrounds them. Each is a form that
 * cannot plausibly appear in a written explanation of a bug — a prose sentence
 * never contains a PEM header or a 36-character GitHub token — so a match is a
 * paste, not a description.
 */
export const SECRET_PATTERNS = [
  {
    name: "Anthropic/OpenAI-style API key",
    re: /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/,
    why: "the live key itself; publishing it is the compromise, not a report of one",
  },
  {
    name: "AWS access key id",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    why: "identifies a real IAM principal and pairs with a secret someone may also have pasted",
  },
  {
    // Two spellings, and the second is now the common one. The legacy prefixes
    // (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) carry base62 only, so their body
    // is `[A-Za-z0-9]`. A fine-grained PAT is `github_pat_` followed by an id
    // segment, an UNDERSCORE, and the secret — so a rule that forbade `_` in
    // the body stopped at the separator and matched nothing, which is why the
    // modern format walked through a gate written for the old one.
    name: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    why: "a live repository credential, often with write scope",
  },
  {
    name: "bearer token",
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
    why: "a reproduction pasted with its Authorization header intact is a working request",
  },
  {
    // A JWT arrives WITHOUT its header far more often than with it: the summary
    // copies the token out of the reproduction and leaves `Authorization:
    // Bearer` behind, and a lone token is not a runnable command and is one
    // word, so neither source-comparison rule reaches it either.
    //
    // `eyJ` is what makes this safe to match bare: it is base64url for `{"`, so
    // every JWT begins with it and no prose does. The signature may be empty,
    // because an `alg: none` token is a session too — that IS the defect being
    // reported, and it must not be the thing that publishes the credential.
    name: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
    why: "a decodable, replayable session credential; the claim it carries can be described instead",
  },
  {
    name: "PEM private key",
    re: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
    why: "no explanation of a defect needs the key material to make its point",
  },
  {
    name: "credentials inside a connection URL",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
    why: "postgres://user:password@host is a complete credential wearing a URL's clothes",
  },
];

/**
 * A secret that is a secret because of what it is ASSIGNED TO. Unlike the
 * shapes above, the value itself is unremarkable — `hunter2` is only a leak
 * because `password=` precedes it — so this rule reads the assignment and then
 * exempts values that are visibly redacted.
 */
/**
 * Three alternatives, because a credential is written three ways and the length
 * floor an earlier version used let two of them through:
 *
 *   password="my secret pass"   quoted, and the value contains spaces
 *   password='abc'              quoted, short
 *   password=abc                bare
 *   {"password":"abc"}          the KEY quoted too, which is what JSON is
 *
 * The quotes around the key are matched with a backreference, so `"password":`
 * and `'password':` are read the same as `password=` while a stray quote on one
 * side alone is not. A public summary that pastes a JSON response is the most
 * ordinary way a credential arrives, and requiring the colon to follow a BARE
 * identifier made valid JSON the shortest way past the scanner.
 *
 * There is NO minimum length. `password=abc` is a real credential — short is
 * what weak ones are — and requiring six characters made brevity the way past
 * the scanner. Redaction markers are exempted after the match instead, which is
 * the distinction that actually matters: not how long the value is, but whether
 * it is the secret or a stand-in for it.
 *
 * The key may also be a COMPOUND name, and a compound is written two ways that
 * no single word-boundary rule covers. `client_secret=hunter2` defeats a
 * leading `\b` because the character before `secret` is `_`, a word character.
 * `clientSecret=hunter2` — the same key in every JavaScript file in this
 * repository — defeats a separator-based prefix because there is no separator
 * at all; the boundary is a change of case.
 *
 * So the regex below stops trying to decide what a credential key looks like.
 * It matches ANY identifier-shaped assignment, and `credentialKeyKind()` then
 * splits the captured key into words — on separators AND on camelCase humps —
 * and reads the last one. That is the rule authors actually follow when they
 * name a key, and it is checkable in one place instead of encoded in a
 * lookbehind that has to be right about case, separators, and prefixes at once.
 */
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']?)([A-Za-z][A-Za-z0-9_.-]*)\1\s*[:=]\s*` +
  String.raw`(?:"([^"]+)"|'([^']+)'|([^\s"',;)]+))`,
  "g",
);

/**
 * A key name split into the words its author wrote, lowercased.
 *
 *   clientSecret   -> ["client", "secret"]
 *   db_password    -> ["db", "password"]
 *   APP_AUTH_TOKEN -> ["app", "auth", "token"]
 *   x-api-key      -> ["x", "api", "key"]
 *   APIKey         -> ["api", "key"]
 *
 * The camelCase splits are deliberately case-SENSITIVE, which is what keeps
 * `secretariat`, `tokenizer`, and `compass` as single words: a hump is a real
 * boundary, a letter sequence that merely contains a credential word is not.
 */
function keyWords(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Words that name a credential and nothing else. Whatever value follows one of
 * these is treated as the secret, redaction markers aside.
 */
const CREDENTIAL_WORDS = new Set([
  "password", "passwords", "passphrase", "passphrases",
  "secret", "secrets", "credential", "credentials",
  // The spellings the tools themselves use. `passwd` is what /etc/passwd, the
  // `passwd` command, and half the config files in the world call the field,
  // so a vocabulary that knows only the long form published `passwd=hunter2`
  // as ordinary prose. None of these is an English word in any other sense.
  "passwd", "passwds", "pword", "pwords",
]);

/**
 * `key` is a credential word only in company. `apiKey` and `signing_key` are
 * secrets; `cacheKey`, `sortKey`, and `primaryKey` are the ordinary meaning of
 * the word, and this repository uses that one constantly.
 */
const KEY_QUALIFIERS = new Set([
  "api", "access", "private", "secret", "signing", "encryption", "master",
]);

/**
 * Words that are a credential in one sentence and ordinary metadata in the
 * next. `token`, `auth`, and bare `pass` are all three, and this repository's
 * own writing is full of the metadata sense: every finding record carries a
 * `tokens` accounting block, route descriptions say `auth: required`, and a
 * check result reads `pass: true`. Blocking those blocks the sanitized
 * summaries this gate exists to let through — and a gate that refuses honest
 * text is a gate someone switches off, which costs more than the leak it was
 * guarding against.
 *
 * So these keys are matched, then filtered by their VALUE (see
 * METADATA_VALUE): a count or a config word is metadata, anything else is
 * still treated as the credential. `accessToken=abc` blocks; `tokens: 500`
 * does not.
 *
 * `authorization` is here for the same reason `auth` is, and it must be spelled
 * out: keyWords() reads the LAST word of a key, and the last word of
 * `Authorization` is `authorization`, not `auth` — so the short form covered
 * `auth:` while the actual HTTP header name fell through to `null` and
 * published whatever followed it. The header written in full is the common
 * case, not the rare one; `Proxy-Authorization` lands here too, because its
 * last word is the same.
 */
const AMBIGUOUS_WORDS = new Set([
  "token", "tokens", "auth", "pass", "authorization",
  // `pwd` and `pw` are the short spellings of password AND the name of the
  // shell command that prints a directory, so they land in the tier that lets
  // the value decide rather than the one that blocks on sight.
  "pwd", "pw",
]);

/**
 * Heads that turn a glued compound into the name of a credential.
 *
 * keyWords() splits on humps and separators, which is exactly what keeps
 * `secretariat` and `compass` out of the vocabulary — but it also means
 * `apikey`, `dbpass`, and `clientsecret`, written as one lowercase run, arrive
 * as a single unrecognized word and publish whatever follows them. Splitting on
 * a credential SUFFIX alone would undo the protection that case-sensitivity
 * bought: `compass`, `bypass`, and `surpass` all end in `pass`.
 *
 * So the head has to be a word that names WHOSE credential it is. `user` +
 * `pass` is a login; `com` + `pass` is a navigation instrument, and `com` is
 * not on this list.
 */
const GLUED_KEY_HEADS = new Set([
  "api", "app", "access", "admin", "auth", "aws", "azure", "client", "db",
  "gcp", "github", "gitlab", "google", "master", "private", "prod", "root",
  "server", "service", "session", "signing", "slack", "sudo", "super",
  "system", "encryption", "user",
]);

/**
 * The credential words a glued key may end in, longest first so that
 * `userpasswords` splits at `passwords` rather than at `pass`.
 */
const GLUED_KEY_TAILS = [
  "passphrases", "passphrase", "credentials", "credential", "passwords",
  "password", "passwds", "passwd", "pwords", "pword", "secrets", "secret",
  "tokens", "token", "keys", "key", "pass", "auth", "pwd",
];

/**
 * A one-word key split at a credential tail, or `null` when it is just a word.
 */
function splitGluedKey(word) {
  for (const tail of GLUED_KEY_TAILS) {
    if (word.length <= tail.length || !word.endsWith(tail)) continue;
    const head = word.slice(0, -tail.length);
    if (GLUED_KEY_HEADS.has(head)) return [head, tail];
  }
  return null;
}

/**
 * Which rule an assignment's key falls under: `"credential"` (the value is the
 * secret), `"ambiguous"` (the value decides), or `null` (not a credential key
 * at all, which is nearly every assignment in ordinary prose).
 */
function credentialKeyKind(key) {
  const written = keyWords(key);
  // Only the final word can be a glued compound — `db_apikey` is `db`, `api`,
  // `key`, and the head it uncovers is what qualifies `key` as a credential.
  const glued = splitGluedKey(written[written.length - 1] ?? "");
  const words = glued ? [...written.slice(0, -1), ...glued] : written;
  const last = words[words.length - 1] ?? "";
  const previous = words[words.length - 2] ?? "";

  if (CREDENTIAL_WORDS.has(last)) return "credential";
  if ((last === "key" || last === "keys") && KEY_QUALIFIERS.has(previous)) return "credential";
  if (AMBIGUOUS_WORDS.has(last)) return "ambiguous";
  return null;
}

/**
 * Values that answer "how many" or "which mode", never "what is the secret".
 *
 * Two shapes only, both deliberately narrow. A count — `500`, `4096`, `1.5`,
 * `30s` — is a measurement; no credential worth publishing is a bare number
 * under a `token`/`auth`/`pass` key. And a small closed vocabulary of config
 * words is what an auth POLICY reads like: `auth: required` describes a route,
 * it does not hand anyone a way in. Anything outside these two — `abc`, `x`,
 * `hunter2` — is still the credential.
 *
 * This exemption applies ONLY to the ambiguous words. `password=1234` stays
 * blocked, because a numeric password is a weak password, not a token count.
 */
const METADATA_VALUE = /^\d+(?:[.,_]\d+)*\s*[a-z%]{0,8}$/i;
const METADATA_WORDS = new Set([
  "required", "optional", "none", "null", "true", "false", "yes", "no", "on",
  "off", "enabled", "disabled", "present", "absent", "missing", "unset",
  "basic", "bearer", "cookie", "header", "session", "anonymous", "public",
]);

const isMetadataValue = (value) => {
  const text = value.trim();
  return METADATA_VALUE.test(text) || METADATA_WORDS.has(comparableText(text));
};

/**
 * The one credential shape the assignment rule structurally cannot see.
 *
 * An HTTP credential is written as TWO tokens — a scheme and then the secret:
 *
 *   Authorization: Basic dXNlcjpwYXNz
 *   Authorization: Bearer abc
 *   {"Authorization": "Bearer abc"}
 *
 * ASSIGNMENT's value stops at the first space, so all it ever sees is `Basic`
 * or `Bearer` — and those are METADATA_WORDS, deliberately, because
 * "auth: basic" is an honest description of a route. The credential is the
 * token AFTER the scheme, and nothing was reading it: `Basic dXNlcjpwYXNz` is
 * a usable login and `Bearer abc` is a usable session, both under the sixteen
 * character floor the standalone bearer shape needs to avoid firing on the
 * words "Bearer tokens".
 *
 * So this rule reads the pair. It does not care WHICH scheme — a custom scheme
 * hands over a credential exactly as well as a registered one — and it has no
 * length floor, for the same reason the assignment rule has none: short is what
 * weak credentials are. The value is then excused only if it is visibly
 * redacted (`Authorization: Bearer <redacted>`, the sanitized form this gate
 * wants people to write).
 *
 * It is NOT excused for looking like metadata. That exemption exists so that
 * `tokens: 500` — a count under an ambiguous key — reads as the measurement it
 * is, and the reasoning does not survive the move to this position: the token
 * after a scheme is the credential by construction, so `Authorization: Bearer
 * 1234` is a replayable session and not a tally of anything. A numeric secret
 * is a weak secret, which is the same rule the assignment path already applies
 * to `password=1234`.
 *
 * The pair still has to READ as a header rather than as a sentence, because a
 * colon is also ordinary punctuation: "Authorization: required is documented,
 * yet the check is skipped" puts two English words exactly where a scheme and a
 * token would sit. Two independent tells settle it, and either one is enough:
 * the first word is a registered auth scheme (AUTH_SCHEMES — this is what
 * catches `Bearer abc`, whose token is indistinguishable from a word), or the
 * second word is not a plain lowercase word at all (`dXNlcjpwYXNz`, `a1b2`,
 * `AKIA…` — this is what catches a scheme nobody registered). A sentence trips
 * neither. And an unregistered scheme carrying a word-shaped token is not lost
 * either: its scheme name is not a METADATA_WORD, so the assignment rule above
 * has already blocked it.
 */
const AUTH_SCHEMES = new Set([
  "basic", "bearer", "digest", "token", "apikey", "negotiate", "ntlm", "oauth",
  "hoba", "mutual", "signature", "hmac", "jwt", "vapid",
  "scram-sha-1", "scram-sha-256", "aws4-hmac-sha256",
]);

/** An English word, as opposed to a token: no digits, no case changes, no punctuation. */
const PLAIN_WORD = /^[a-z]+$/;

const AUTH_HEADER = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?` +
  String.raw`([A-Za-z][A-Za-z0-9._+/-]*)\s+([^\s"',;)]+)`,
  "gi",
);

/**
 * Shapes that ARE an exploit, whatever surrounds them and however short they
 * are. This list exists because the two source-comparison rules below both have
 * a floor: one only recognizes a whole runnable command, the other only fires
 * on an eight-word run. `../../etc/passwd`, `' OR 1=1 --`, and
 * `<script>alert(1)</script>` are under both floors, so a summary could carry
 * the working payload verbatim and still export — the exact thing T8.2 says a
 * sanitized summary must exclude.
 *
 * They are matched against the summary directly rather than compared with the
 * finding's own fields, which also catches a payload the author wrote fresh
 * into the summary instead of pasting out of the reproduction. A public summary
 * describes the defect; it never needs to spell the attack.
 */
export const PAYLOAD_PATTERNS = [
  {
    name: "path traversal sequence",
    re: /(^|[\s"'`(=[/\\])\.\.[/\\]/,
    why: "the traversal is the exploit; naming the endpoint and the missing check says as much",
  },
  {
    name: "percent-encoded traversal or null byte",
    re: /%2e%2e|%252e|%00/i,
    why: "an encoded payload is a payload that got past one layer of review",
  },
  {
    name: "SQL tautology or comment terminator",
    // `m` is load-bearing on the `--` branch. Without it `$` means the end of
    // the WHOLE summary, so a payload line that ends in `--` scanned clean the
    // moment any explanatory sentence followed it — and a multi-paragraph
    // summary is the normal shape, not the exception. A comment terminator is
    // an injection wherever its own line ends, not only in the last one.
    re: /('|\b)\s*or\s+(\d+\s*=\s*\d+|'[^']*'\s*=\s*'[^']*')|--[ \t]*$|;\s*drop\s+table\b/im,
    why: "a working injection string, not a description of one",
  },
  {
    name: "script injection",
    re: /<\s*(script|img|svg|iframe)\b[^>]*(>|\bon[a-z]+\s*=)|\bjavascript:/i,
    why: "the payload runs if anyone pastes the summary into a rendering context",
  },
  {
    name: "shell command chaining",
    re: /[;|&`]\s*\(?\s*(cat|rm|curl|wget|nc|sh|bash|chmod|chown|whoami|id)\b|\$\(\s*\w/i,
    why: "chained shell metacharacters are the injection itself",
  },
  {
    name: "template or JNDI injection",
    re: /\$\{\s*(jndi|env|\w+\s*[:.])/i,
    why: "a lookup expression that resolves wherever it is rendered",
  },
];

/** Consecutive identical words that stop being coincidence and start being a paste. */
export const SHARED_PHRASE_WORDS = 8;

/**
 * Whether `needle` appears in an already-normalized `haystack` as its own text
 * rather than as a fragment of some other word.
 *
 * Plain substring matching is right for a payload carrying punctuation —
 * `../../etc/passwd` or `' OR 1=1 --` cannot occur by accident. It is badly
 * wrong for a short bare token: an exploitPayload of `0` made every summary
 * containing "500" unpublishable, and one of `id` blocked the word "identity",
 * so a real finding could not be reported at all. A gate nobody can pass gets
 * switched off, which costs more than the leak it was guarding against.
 *
 * So a needle that is a single run of word characters must match on word
 * boundaries. Anything else — punctuation, spaces, path separators — keeps
 * substring matching, because there the accidental-collision risk is what does
 * not exist.
 */
function containsVerbatim(haystack, needle) {
  const target = comparableText(needle);
  if (target === "") return false;
  if (!/^\w+$/.test(target)) return haystack.includes(target);

  const bounded = new RegExp(String.raw`(?<!\w)${target.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?!\w)`);
  return bounded.test(haystack);
}

function wordShingles(text, size) {
  const words = comparableText(text).split(" ").filter(Boolean);
  const shingles = new Set();
  for (let i = 0; i + size <= words.length; i += 1) shingles.add(words.slice(i, i + size).join(" "));
  return shingles;
}

/**
 * Every free-text field of a finding that may contain exploit detail, plus the
 * ones that are PRESENT but could not be read.
 *
 * The second list is the point. A field the scanner skips is indistinguishable
 * from a field that held nothing, so `evidence: "see the attached trace"` — a
 * string where an array belongs — would quietly remove the reproduction detail
 * from the comparison and let a summary pasted straight out of it be cleared
 * for publication. An absent field is a real answer; an unreadable one is an
 * unchecked box.
 */
function sensitiveSources(finding) {
  const sources = [];
  const unscannable = [];

  // `evidence` and `reproduction` are both CONFIRMATION_STRING_FIELDS, so by
  // the time this scanner runs the record gate above has already refused any
  // shape but a non-blank string — an earlier version of this function grew a
  // second, more generous reader for the array-of-{kind, detail} form, which is
  // classifyCandidateEvidence()'s separate `evidenceItems` argument and never a
  // confirmed record's own field. The non-string branches stay only as a floor:
  // they fail CLOSED, so if this function is ever called from somewhere that
  // does not gate the record first, an unreadable field still blocks.
  //
  // `exploitPayload` is the one field with no schema behind it at all, which is
  // exactly why it needs the floor.
  for (const field of ["reproduction", "evidence", "exploitPayload"]) {
    if (isBlank(finding[field])) continue;
    if (isNonBlankString(finding[field])) sources.push({ field, text: finding[field] });
    else unscannable.push(`${field} is present but is not text (${JSON.stringify(finding[field])})`);
  }

  return { sources, unscannable };
}

/**
 * Whether a credential value is recognizable on its own, away from the key that
 * named it.
 *
 * The collision safeguard, and the reason this rule is narrower than the
 * labelled one. `password=hunter2` may be compared as a bare word because
 * nothing else in a bug report says "hunter2". `password=admin` may not: the
 * word `admin` belongs to the vocabulary every access-control finding is
 * written in, so matching it would block the summaries this gate exists to let
 * through — and the same is true of a bare number, which is what counts, line
 * numbers, and status codes look like.
 *
 * Those two values are not left unguarded, they are guarded by a different
 * rule: published WITH their key (`password=admin`) the labelled scanner blocks
 * them, and pasted inside their command line the verbatim rule does. What this
 * function gives up is only the unlabelled, out-of-context copy of a value that
 * is indistinguishable from ordinary English — where a gate cannot tell a leak
 * from a sentence, and one that guesses gets switched off.
 *
 * PLAIN_WORD and METADATA_VALUE are the module's existing spellings of "reads
 * as prose" and "reads as a measurement"; reusing them is what keeps this rule
 * and the labelled one from disagreeing about what a secret looks like.
 */
function isDistinctiveCredential(value) {
  const text = String(value).trim();
  return text.length >= 4 && !PLAIN_WORD.test(text) && !METADATA_VALUE.test(text);
}

/**
 * Does `summary` carry material from the finding's own reproduction/evidence?
 * Two independent rules, because they catch different mistakes:
 *
 *   1. A runnable command line reproduced verbatim. These are short — six
 *      words of `curl -H "Authorization: ..." http://host/path` is a working
 *      request — so no length threshold would catch them.
 *   2. A long verbatim run of words. Short phrases genuinely recur between a
 *      summary and a reproduction ("the agent loop retries the call"); eight
 *      consecutive identical words is a copy/paste.
 */
function leakedSourceText(summary, finding) {
  const { sources, unscannable } = sensitiveSources(finding);
  const found = unscannable.map((reason) => `${reason} — a field the scanner cannot read is not a ` +
    `field that held nothing, so the summary cannot be cleared against it`);
  const normalizedSummary = comparableText(summary);
  const summaryShingles = wordShingles(summary, SHARED_PHRASE_WORDS);

  for (const source of sources) {
    for (const rawLine of String(source.text).split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      // `exploitPayload` is declared by the record itself to BE the payload, so
      // it needs no shape test and no length floor — a benign-looking one
      // (`admin`, `0`) is still the value that triggers the defect, and the
      // whole point of naming the field was to keep it out of public text.
      const isDeclaredPayload = source.field === "exploitPayload";
      if (isDeclaredPayload) {
        if (containsVerbatim(normalizedSummary, line)) {
          found.push(`the public summary contains ${source.field} verbatim (${JSON.stringify(line)}) — ` +
            `the field exists to mark text that must not be published`);
        }
        continue;
      }
      // The prompt, bullet, or backticks a reproduction is written with belong
      // to the page, not to the exploit. Matching on the stripped command is
      // what makes `$ curl ...` in the reproduction and a bare `curl ...` in
      // the summary the same line, which is the pair that leaked.
      const command = commandInLine(line);
      if (!RUNNABLE_COMMAND.test(command)) continue;
      if (containsVerbatim(normalizedSummary, command)) {
        found.push(`the public summary reproduces a runnable command from ${source.field} verbatim ` +
          `(${JSON.stringify(command)}) — a sanitized summary describes the defect, it does not hand over ` +
          `the steps`);
      }
    }
    // A credential does not need its label to still be the credential. Strip
    // `password=` off `password=hunter2` and every rule above goes quiet: the
    // assignment scanner has no key to read, the line is not a command, and one
    // word is nowhere near the eight-word run — yet "the exposed credential is
    // hunter2" publishes the working secret. So the values are extracted from
    // the SOURCE, where they are still labelled, and looked for in the summary,
    // where they may not be.
    for (const { key, value } of credentialsIn(source.text)) {
      if (!isDistinctiveCredential(value)) continue;
      if (!containsVerbatim(normalizedSummary, value)) continue;
      found.push(`the public summary carries the value of "${key}" from ${source.field} ` +
        `(${JSON.stringify(value)}) with the label stripped off — an unlabelled secret is still the ` +
        `secret, and publishing it is the compromise whatever sentence surrounds it`);
    }

    for (const shingle of wordShingles(source.text, SHARED_PHRASE_WORDS)) {
      if (summaryShingles.has(shingle)) {
        found.push(`the public summary shares a ${SHARED_PHRASE_WORDS}-word verbatim run with ` +
          `${source.field} (${JSON.stringify(shingle)}) — that is a paste out of the reproduction, ` +
          `not a summary of it`);
        break;
      }
    }
  }
  return found;
}

/**
 * The decoration around a token, removed so the token underneath can be read.
 * A summary is prose, so its commands arrive wrapped: `` `curl …` ``,
 * "(curl …)", "curl …." — and a runner nobody recognizes because of a
 * backtick is a command this scanner does not see.
 */
function bareToken(token) {
  return comparableText(token).replace(/^[`"'($<[]+/, "").replace(/[`"'),.;:>\]]+$/, "");
}

/**
 * bareToken without the lowercasing, because CASE is evidence about one thing:
 * whether a runner-shaped word is the executable or the English word it shares a
 * spelling with. Everything else in this scanner compares meaning, where case is
 * presentation — so the folded form stays the default and this is asked for
 * only where the spelling itself is the question.
 */
function bareTokenExact(token) {
  return String(token).trim().replace(/^[`"'($<[]+/, "").replace(/[`"'),.;:>\]]+$/, "");
}

/**
 * The subcommands that make a runner into a command line with no shell
 * punctuation anywhere in sight.
 *
 * `npm run exploit` and `docker exec db psql` are three plain words each. No
 * flag, no path, no colon — so every shape test below returns false on every
 * token, and a scanner that waits for an argument waits forever while the line
 * publishes. The verb is what settles it: `npm run` and `docker exec` are not
 * phrases anyone writes about a system, they are things one types AT it.
 *
 * Only the runners that HAVE subcommands appear here. `curl`, `make`, `node`
 * and the rest keep the argument rule alone, which is what protects the prose
 * they routinely appear in ("make sure the roots match", "we curl the health
 * endpoint"). Listing a word here does cost the author the noun form of it —
 * "a git bisect over the release" has to become "bisecting the release" — and
 * that is a rewording, not a gate nobody can pass.
 *
 * Local to this module rather than shared from record-shapes.js: T6 asks
 * whether a whole LINE is re-runnable, which the anchored regex already
 * answers. Only this scanner has to recognize a command mid-sentence.
 */
const RUNNER_SUBCOMMANDS = new Map();
for (const [runners, subcommands] of [
  [["npm", "npx", "pnpm", "yarn"], [
    "run", "run-script", "exec", "install", "i", "ci", "add", "remove", "uninstall",
    "dlx", "create", "init", "test", "start", "publish", "link", "pack", "audit",
  ]],
  [["docker"], [
    "run", "exec", "compose", "build", "pull", "push", "cp", "logs", "ps", "start",
    "stop", "kill", "rm", "rmi", "image", "images", "container", "network", "volume",
  ]],
  [["kubectl"], [
    "delete", "exec", "apply", "get", "describe", "create", "run", "logs", "cp",
    "drain", "scale", "patch", "edit", "port-forward", "attach", "rollout",
  ]],
  [["systemctl", "launchctl"], [
    "start", "stop", "restart", "disable", "enable", "mask", "unmask", "kill",
  ]],
  [["git"], [
    "clone", "init", "add", "commit", "checkout", "switch", "branch", "tag", "push",
    "pull", "fetch", "remote", "merge", "rebase", "reset", "revert", "restore",
    "stash", "cherry-pick", "bisect", "blame", "log", "show", "diff", "status",
    "config", "clean", "apply", "grep", "worktree", "submodule",
  ]],
  // The cloud control planes, whose grammar is `runner <service> <verb> --flags`.
  // Their verbs are hyphenated far more often than a shell's are, and a
  // hyphenated word is not a plain word, so the walk below used to stop on
  // `create-user` and never reach the flag that follows it. `aws iam
  // create-user --user-name attacker` published as prose. The service name is
  // what settles the line: nobody writes "aws iam" in a sentence about a
  // system, and there is no verb-agnostic rule that reaches three tokens out
  // without also reaching into ordinary writing.
  [["aws"], [
    "iam", "sts", "s3", "s3api", "ec2", "rds", "kms", "ssm", "lambda", "ecr",
    "eks", "ecs", "dynamodb", "cloudformation", "cloudtrail", "logs", "sns",
    "sqs", "route53", "organizations", "secretsmanager", "configure",
  ]],
  [["gcloud"], [
    "auth", "config", "compute", "container", "iam", "projects", "secrets",
    "storage", "sql", "functions", "run", "services", "organizations",
  ]],
  [["az"], [
    "login", "account", "ad", "role", "vm", "aks", "group", "storage",
    "keyvault", "network", "sql", "webapp", "functionapp", "resource",
  ]],
  [["terraform"], [
    "init", "plan", "apply", "destroy", "import", "state", "workspace",
    "output", "taint", "refresh",
  ]],
  [["helm"], [
    "install", "upgrade", "uninstall", "delete", "rollback", "repo",
    "template", "history", "list",
  ]],
]) {
  for (const runner of runners) RUNNER_SUBCOMMANDS.set(runner, new Set(subcommands));
}

/**
 * Suffixes that name something a runner EXECUTES, as opposed to something it
 * merely reads. The distinction is what keeps `node exploit.js` apart from
 * "the docker compose.yml file" and "the npm package.json lists it": a summary
 * naming a config file is describing the system, while one naming a script
 * beside a runner is handing over the line that runs it.
 */
const SCRIPT_SUFFIX = /\.(js|mjs|cjs|ts|py|rb|pl|php|sh|bash|zsh|ps1|sql|jar|exe)$/;

/**
 * A token that could be a subcommand rather than the end of the command line:
 * `run`, `s3`, `create-user`, `port-forward`. Wider than PLAIN_WORD by exactly
 * the digits and hyphens that CLI verbs and service names are made of, and no
 * wider — punctuation still ends the walk.
 */
const SUBCOMMAND_WORD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The runners that are ALSO ordinary English words.
 *
 * `make`, `curl`, `node`, `java`, `ruby`, `python`, `cat`, and `tar` show up in
 * honest writing as verbs, nouns, and product names, so for these the walk may
 * not step over a plain word on its way to an argument: "Make sure /api requires
 * authentication"
 * is a sentence every sanitized summary is entitled to contain, and reading it
 * as `make sure /api` blocks the finding rather than the exploit. Anything they
 * are genuinely typed with announces itself in the very next slot — `curl -X`,
 * `node exploit.js`, `npm run x` — so nothing real is lost.
 *
 * `psql aperio -c …`, `wget host file`, and `sqlite3 db .dump` keep the hop:
 * none of those names is a word, so the plain token between the runner and its
 * flag is an operand, not a sentence.
 */
const ENGLISH_WORD_RUNNERS = new Set([
  "make", "curl", "node", "java", "ruby", "python", "cat", "tar",
]);

/**
 * The closed class of English function words — determiners, prepositions,
 * conjunctions, auxiliaries, pronouns. One set, read from BOTH sides of a
 * never-prose runner, because the same evidence settles both questions.
 *
 * Before the runner it says the tool is being NAMED, not run: "the rm command",
 * "a chmod call", "written in PowerShell". No command line is introduced by a
 * determiner or a preposition.
 *
 * The prepositions of INSTRUMENT are deliberately absent — "via", "using",
 * "with", "through". Those introduce a command rather than name a tool
 * ("escalate using sudo reboot"), so listing them would have opened the exact
 * hole this rule closes.
 *
 * After the runner it says the sentence simply continued: "the logon script is
 * written in PowerShell and never validates the account name" puts "and" exactly
 * where an operand would sit. A shell operand is a filename, a host, a service,
 * a pod — never a conjunction.
 *
 * Both guards are needed, and neither is enough alone: "the rm command" is
 * caught only by the first, "runs powershell and exits" only by the second.
 * They gate ONLY the plain-operand rule below — a punctuated argument (`cmd /c
 * whoami`, `certutil -urlcache …`) is read as a command however the sentence
 * around it is worded.
 */
const ENGLISH_FUNCTION_WORD = new Set([
  "a", "an", "the", "this", "that", "these", "those", "its", "our", "their",
  "his", "her", "your", "my", "each", "every", "any", "some", "no", "none",
  "all", "both", "either", "neither", "another", "one", "such",
  "in", "on", "at", "of", "to", "for", "from", "by", "without", "into",
  "onto", "over", "under", "against", "about",
  "before", "after", "during", "since", "until", "between", "within", "across",
  "and", "or", "but", "nor", "so", "then", "than", "as", "if", "when", "while",
  "because", "though", "although", "however", "therefore", "yet", "still",
  "is", "are", "was", "were", "be", "been", "being", "will", "would", "can",
  "could", "may", "might", "must", "should", "shall", "do", "does", "did",
  "has", "have", "had", "not", "never", "always", "also", "only", "just", "even",
  "it", "they", "them", "we", "us", "you", "he", "she", "him", "which", "who",
  "whom", "whose", "there", "here", "now", "again", "more", "most", "less",
]);

/**
 * A plain operand: no flag, no path, no punctuation of any kind.
 *
 * `rm uploads`, `sudo reboot`, `pkill node`, `kubectl exploit-pod` — two words
 * each, nothing a shape test can see, and every one of them runs. Read only in
 * the slot immediately after a never-prose executable, and only when that
 * executable is not being named as a noun.
 */
const PLAIN_OPERAND = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The punctuation that ends a SENTENCE, and with it the command.
 *
 * The summary is split on whitespace, which knows nothing about where one
 * sentence stops: "The helper is implemented in node. /api rejects anonymous
 * users" put a runner at the end of one sentence and a path at the start of the
 * next, and the walk read the pair as `node /api` and refused a summary that
 * leaks nothing. No shell reads a full stop as an argument separator, so the
 * walk does not cross one.
 *
 * The trailing quotes and brackets are allowed AFTER the stop because that is
 * how a sentence ends inside a quotation or a parenthetical.
 */
const SENTENCE_END = /[.!?;:][)"'`\]]*$/;

/**
 * The argument a CAPITALIZED POSIX runner has to be carrying before it is read
 * as a command.
 *
 * `RUNNABLE_COMMAND` folds case for the Windows names only, because those are
 * binaries and never words. This scanner has to make the same distinction, and
 * it cannot do it on case alone: "Make /api reject unauthenticated requests" and
 * "Curl http://host/admin returns the file" are both a capitalized POSIX runner
 * at the head of a sentence, one a recommendation the gate exists to publish and
 * the other a working request. What separates them is the ARGUMENT — a scheme, a
 * flag, or shell punctuation is syntax a sentence does not produce, while a bare
 * `/api` is just how a summary names an endpoint.
 *
 * So a capital costs a runner its weaker tiers and nothing more: `curl /api`
 * lowercase is still a command, and `Curl -X POST …` still is too.
 */
const STRONG_COMMAND_ARGUMENT = /:\/\/|^-{1,2}[a-z0-9]|[=&|<>?]/i;

/**
 * Executables that are a whole command with NO argument at all.
 *
 * Every tier above waits for an operand, so `tcpdump` on its own — which starts
 * capturing every packet on the wire — was read as a word and published. These
 * are the summary scanner's own vocabulary, like RUNNER_SUBCOMMANDS: T6 asks
 * whether a REPRODUCTION line is re-runnable, and a reproduction is a line, not
 * a lone token.
 *
 * Two tiers, because "runs bare" and "is not a word" are different properties:
 *
 *   NO_ARGUMENT_BINARIES — never an English word, so naming one is already
 *     quoting it. Guarded only against the noun forms ("a tcpdump capture").
 *     The list itself lives in record-shapes.js, because T6 has to accept the
 *     same lone `whoami` as a re-runnable reproduction that this gate refuses
 *     to publish — two spellings of it would disagree.
 *   NO_ARGUMENT_ENGLISH_WORD — `reboot`, `shutdown`, and `halt` are ordinary
 *     nouns and verbs, so their absence of a determiner proves nothing:
 *     "Reboot loops are common" opens a sentence exactly the way a command
 *     would. These need a POSITIVE signal instead — someone saying the thing is
 *     RUN — which is why they are read only after a run verb.
 */
const NO_ARGUMENT_ENGLISH_WORD = new Set(["reboot", "shutdown", "halt"]);

/**
 * The verbs that INTRODUCE a tool by name, and the nouns that finish the
 * introduction.
 *
 * "The worker runs PowerShell scripts", "the scheduler invokes kubectl clients",
 * "the job uses rm operations" — three ordinary sanitized sentences, and in each
 * one a never-prose executable is followed by a plain word, which is exactly the
 * shape the two-word rule below reads as `rm uploads`. The verb alone does not
 * settle it (someone saying "run rm uploads" IS handing over the line), and the
 * noun alone does not either — so both halves are required: a verb that names a
 * tool, and a CATEGORY noun that describes the tool rather than a target it acts
 * on. No shell reads `scripts` or `operations` as a file to delete.
 */
const TOOL_MENTION_VERB = new Set([
  "run", "runs", "ran", "running", "invoke", "invokes", "invoked",
  "use", "uses", "used", "using", "call", "calls", "called",
  "execute", "executes", "executed", "spawn", "spawns", "spawned",
  "wrap", "wraps", "wrapped", "issue", "issues", "issued",
]);
const TOOL_MENTION_NOUN = new Set([
  "script", "scripts", "command", "commands", "call", "calls",
  "invocation", "invocations", "client", "clients", "operation", "operations",
  "job", "jobs", "task", "tasks", "process", "processes", "binary", "binaries",
  "wrapper", "wrappers", "session", "sessions", "step", "steps",
  "output", "outputs", "result", "results", "capture", "captures",
]);

/**
 * The runners whose whole command is `<runner> <host>`.
 *
 * `ssh` is deliberately NOT in the never-prose set — "the SSH key", "SSH
 * clients", "over SSH" are how the protocol is written about — so its plainest
 * and most complete form carries nothing any shape test can see: a single-label
 * host like `victim` has no dot for BARE_HOST, no `:port`, no `@user`, no flag.
 * What supplies the missing evidence is someone SAYING the line is run, which is
 * the same positive signal NO_ARGUMENT_ENGLISH_WORD needs and for the same
 * reason: "anyone can run ssh victim" is a line, "SSH clients reconnect" is a
 * sentence.
 */
const HOST_TARGET_RUNNER = new Set(["ssh", "scp", "sftp", "telnet", "ftp", "rsync"]);

/** The verbs that say a thing is being TYPED, not described. */
const RUN_VERB = new Set([
  "run", "runs", "ran", "running", "execute", "executes", "executed", "type",
  "types", "typed", "invoke", "invokes", "invoked", "issue", "issues", "issued",
  "call", "calls", "called", "trigger", "triggers", "triggered", "exec",
]);

/** `localhost:3000`, `127.0.0.1:8080`, `host.example.com:443`. */
const HOST_AND_PORT = /^[a-z0-9][a-z0-9.-]*:\d{2,5}$/;

/**
 * A bare number sitting where a shell reads an operand: the port in
 * `nc host 4444`, the mode in `chmod 777 /etc/shadow`. Read ONLY beside a
 * never-prose executable, because everywhere else a bare number is a count, a
 * status code, or a line number — which is the same reason METADATA_VALUE
 * exempts one from the credential rules.
 */
const BARE_OPERAND_NUMBER = /^\d{2,5}$/;

/**
 * The extensions that make a dotted token a FILE rather than a host.
 *
 * `config.json` and `example.com` are the same shape — labels joined by dots,
 * ending in letters — so the host rule below cannot tell them apart on
 * structure alone. Only the data and config suffixes are listed: a dotted token
 * ending in a script suffix is already an argument by the tier above it, so
 * repeating those here would change nothing.
 */
const DATA_FILE_SUFFIX = /\.(json|md|txt|ya?ml|csv|xml|html?|css|log|env|lock|toml|ini|conf|pem|key|crt)$/;

/**
 * The host a network command is pointed AT: `attacker.example.com`, `aperio.live`,
 * `localhost`, `10.0.0.5`.
 *
 * `curl attacker.example.com` and `wget evil.test/p.sh` are the plainest form an
 * exfiltration line takes, and the first of them carries no shell punctuation
 * whatsoever — no slash, no colon, no port. HOST_AND_PORT wanted `:3000` and
 * SCRIPT_SUFFIX wanted a filename, so a summary that shortened the reproduction
 * to its bare host published a working command with nothing to catch it. A
 * dotted quad is included for the same reason and reads no wider: prose does not
 * put `10.0.0.5` in the slot a shell reads as an operand.
 */
const BARE_HOST = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * An SSH/SCP target: `root@host`, `deploy@10.0.0.5`, `admin@corp.example.com`.
 *
 * `ssh root@host` is a whole intrusion written in two words, and the `@` is the
 * thing that makes it one — no sentence puts a user@host in the slot right after
 * `ssh`, `scp`, or `su`. An address in ordinary prose ("mail security@example.com
 * for coordinated disclosure") is unreachable here, because a positional operand
 * is read ONLY immediately after a runner and "mail" is not one.
 */
const USER_AT_HOST = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*$/;

/**
 * A token that turns a runner WORD into a command someone can run.
 *
 * The distinction matters in both directions. "make sure the roots match" and
 * "we curl the endpoint on every boot" are prose that happens to start with a
 * runner, and blocking them would make the gate unpassable for the findings
 * that most need reporting. What a shell actually reads is an ARGUMENT, and
 * that is what turns `curl /promote?role=admin` into a working request.
 *
 * Two tiers, because two kinds of argument carry different collision risk:
 *
 *   Punctuated — a flag, a path, a URL, a query, a pipe. Shell syntax that
 *     prose does not produce, so it counts anywhere in the runner's window.
 *   Positional — `exploit.js`, `poc.py`, `localhost:3000`, `attacker.example.com`,
 *     `root@host`. A plain operand with no shell punctuation at all, which is
 *     exactly what `node exploit.js`, `curl localhost:3000`, `curl
 *     attacker.example.com`, and `ssh root@host` are made of. These count ONLY
 *     in the slot immediately after the runner, where a shell reads the first
 *     operand.
 *     One word further out the same token is ordinary prose ("make sure
 *     node.js is installed", "curl at 10:30"), and a rule that reached it
 *     would refuse honest summaries.
 *
 * The trailing/leading strip is deliberately narrow: `<` and `>` survive inside
 * a token, because `<script>` is PAYLOAD_PATTERNS' business and stripping the
 * angle brackets here would hand it a different string than the summary holds.
 */
function looksLikeCommandArgument(token, { positional = false, bareNumber = false } = {}) {
  const bare = bareToken(token);
  if (bare === "") return false;
  if (/^-{1,2}[a-z0-9]/.test(bare) || /[/?=&|<>]/.test(bare)) return true;
  if (bareNumber && BARE_OPERAND_NUMBER.test(bare)) return true;
  if (!positional) return false;
  // A version number is not a script: `python 3.11` and `node 20.11` are how a
  // summary states a requirement, and both end in a dotted suffix. Requiring a
  // letter in the name is what separates `poc.py` from `3.11`.
  if (SCRIPT_SUFFIX.test(bare) && /[a-z]/.test(bare)) return true;
  if (HOST_AND_PORT.test(bare) || USER_AT_HOST.test(bare)) return true;
  // A file the summary NAMES is not a host the command reaches: `config.json`
  // and `example.com` are indistinguishable by shape, and "make config.json the
  // source of truth" is a sentence this gate exists to let through.
  return BARE_HOST.test(bare) && !DATA_FILE_SUFFIX.test(bare);
}

/**
 * T8.2's other half: runnable commands the summary carries in its OWN right.
 *
 * leakedSourceText compares the summary against the finding's reproduction, so
 * it only ever recognizes a command that was pasted whole. An author who
 * shortens one while writing the summary — `curl https://host/promote?role=admin`
 * in the reproduction, `curl /promote?role=admin` in the summary — evades the
 * verbatim comparison, is far under the eight-word run, and matches no payload
 * pattern, yet publishes the request that performs the escalation. So the
 * summary is also read on its own terms: whatever the finding says, a sanitized
 * summary describes the defect and does not carry a command line.
 *
 * A runner may be followed by at most ONE plain word before the argument, which
 * is where an unrecognized subcommand sits (`psql aperio -c …`). Allowing a
 * wider window is what would make the rule unpassable: ordinary prose reaches
 * an unrelated slash within four or five words often enough ("make the request
 * to /api/x"), and a gate that blocks honest summaries is a gate that gets
 * switched off. looksLikeCommandArgument() narrows that window further for
 * arguments that carry no shell punctuation — see its two tiers.
 *
 * Waiting for an argument is not enough on its own, which is why
 * RUNNER_SUBCOMMANDS exists: in `npm run exploit` and `docker exec db psql`
 * every token after the runner is a plain word, so no tier of
 * looksLikeCommandArgument() ever fires and the whole line published. A
 * recognized subcommand settles it without looking any further.
 */
function leakedCommands(summary) {
  const tokens = String(summary).split(/\s+/).filter(Boolean);
  const found = [];
  const reported = new Set();

  const report = (from, to) => {
    const command = tokens.slice(from, to + 1).map(bareToken).join(" ");
    if (reported.has(command)) return;
    reported.add(command);
    found.push(`the public summary carries a runnable command (${JSON.stringify(command)}) — a ` +
      `sanitized summary describes the defect, it never hands over a line someone can type, ` +
      `whether it was pasted from the reproduction or shortened on the way out`);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    // The runner is read THROUGH its path and its Windows suffix: `/bin/sh -c
    // whoami` and `powershell.exe -enc ...` are the most explicit spelling of a
    // command there is, and a name-only comparison is exactly the rule they walk
    // past. A token that had to be normalized to reach a runner name is an
    // executable and never an English word, which is what lets the capital rule
    // below stand down for it.
    const written = bareTokenExact(tokens[i]);
    const spelled = executableName(written);
    const runner = spelled.toLowerCase();
    // A token that had to be normalized to reach its name — a directory came
    // off, or a `.exe` did — is an executable and never an English word.
    const pathQualified = spelled !== written;
    const previous = i > 0 ? bareToken(tokens[i - 1]) : "";

    // A command that needs no operand is finished the moment it is named, so it
    // has to be settled before any rule that waits for a following token.
    //
    // The category noun BEHIND it is read for the same reason a determiner in
    // front is: "the endpoint returns whoami output" and "a tcpdump capture is
    // attached" are noun phrases naming a tool, not lines anyone typed.
    const namedAsNoun = TOOL_MENTION_NOUN.has(i + 1 < tokens.length ? bareToken(tokens[i + 1]) : "");
    if (NO_ARGUMENT_BINARIES.has(runner) && !ENGLISH_FUNCTION_WORD.has(previous) && !namedAsNoun) {
      report(i, i);
      continue;
    }
    if (NO_ARGUMENT_ENGLISH_WORD.has(runner) && RUN_VERB.has(previous) && !namedAsNoun) {
      report(i, i);
      continue;
    }

    // A file invoked through its path is a command whatever it is called: no
    // allowlist of runner names will ever contain the attacker's own filename,
    // and `./exploit.sh --target victim` runs exactly as written.
    const knownRunner = COMMAND_RUNNERS.includes(runner);
    const shellScript = PATH_QUALIFIED_SHELL_EXECUTABLE.test(written);
    if (!knownRunner && !PATH_QUALIFIED_EXECUTABLE.test(written)) continue;
    // A capital belongs to a sentence, not to a POSIX executable. Windows names
    // are exempt because none of them is a word; the rest have to be carrying
    // real shell syntax before a capitalized spelling counts as an invocation.
    if (spelled !== runner && !WINDOWS_RUNNERS.includes(runner) && !pathQualified
      && !(i + 1 < tokens.length && STRONG_COMMAND_ARGUMENT.test(bareTokenExact(tokens[i + 1])))) {
      continue;
    }
    const subcommands = RUNNER_SUBCOMMANDS.get(runner);
    // An executable that is never an English word can be read a little more
    // freely: `nc host 4444` puts its port one slot past where a prose-safe
    // rule may look, and no sentence contains "nc" for any other reason. A
    // path-qualified RUNNER and a path-qualified shell script join that set for
    // the same reason — `/bin/sh` and `./exploit.sh` are executables by
    // construction, so there is no sentence to protect. A path-qualified SOURCE
    // file does not: "./lib/routes/paths.js accepts a parent segment" is how a
    // sanitized summary says where the defect lives.
    const neverProse = NEVER_PROSE_RUNNERS.has(runner) || (pathQualified && knownRunner) || shellScript;

    // How far past the runner the walk may look. Two tokens is all a prose-safe
    // rule can afford — ordinary writing reaches an unrelated slash inside four
    // or five words often enough. A never-prose executable has no honest
    // sentence to collide with, so the window opens wider there and catches the
    // deeper forms: `kubectl -n prod exec pod -- sh`, `mongodump --db x --out /tmp`.
    const window = Math.min(i + (neverProse ? 6 : 3), tokens.length);

    // A tool NAMED in a sentence is not a tool run in one. "the rm command",
    // "a chmod call", "written in PowerShell" all put a plain word right where an
    // operand would sit, and the determiner or preposition in front is what tells
    // them apart — no command line is introduced by "the" or "in".
    //
    // A determiner is not the only thing that names one, though: "the worker runs
    // PowerShell scripts" introduces the tool with a VERB and finishes it with a
    // category noun, and both halves are required before the two-word rule stands
    // down — "run rm uploads" keeps the verb and loses the noun, and it is a line
    // someone can type.
    const introduced = TOOL_MENTION_VERB.has(previous) && namedAsNoun;
    const asNoun = ENGLISH_FUNCTION_WORD.has(previous) || introduced;

    // A shell executable named through its path needs no argument either:
    // `/tmp/poc.exe` IS the command, and the path is what says so. Held back
    // until the walk below has had its chance, so a line that DOES carry an
    // argument is still reported whole.
    const reportBareScript = () => {
      if (shellScript && !ENGLISH_FUNCTION_WORD.has(previous) && !namedAsNoun) report(i, i);
    };

    // A runner that ENDS its sentence has no argument in it. The no-argument
    // tiers above have already had their say, so nothing is lost by stopping
    // here — and what is gained is every summary that happens to finish a
    // sentence on a lowercase tool name.
    if (SENTENCE_END.test(tokens[i])) {
      reportBareScript();
      continue;
    }

    const reportedBefore = found.length;
    for (let at = i + 1; at < window; at += 1) {
      // A runner and its own subcommand are already a command line. Nothing
      // after them can make it less of one, and everything after them is an
      // operand of whatever shape the author felt like — a bare word included.
      if (at === i + 1 && subcommands?.has(bareToken(tokens[at]))) {
        report(i, at);
        break;
      }
      // A remote-shell runner whose line was announced as RUN takes its host the
      // same way, single label and all: `ssh victim` is a whole intrusion, and
      // every shape test above wanted a dot, a colon, or an `@` that a
      // single-label host does not have.
      if (at === i + 1 && HOST_TARGET_RUNNER.has(runner) && RUN_VERB.has(previous) && !asNoun) {
        const operand = bareToken(tokens[at]);
        if (PLAIN_OPERAND.test(operand) && !ENGLISH_FUNCTION_WORD.has(operand)) {
          report(i, at);
          break;
        }
      }
      // A never-prose executable followed by ANY plain word is already the whole
      // command: `rm uploads` and `sudo reboot` delete data and drop a node with
      // no flag, no path, and no number for a shape test to catch. Every earlier
      // tier waited for punctuation that these lines never contain, so the most
      // destructive two-word forms in the list were the ones that published.
      if (at === i + 1 && neverProse && !asNoun) {
        const operand = bareToken(tokens[at]);
        if (PLAIN_OPERAND.test(operand) && !ENGLISH_FUNCTION_WORD.has(operand)) {
          report(i, at);
          break;
        }
      }
      if (looksLikeCommandArgument(tokens[at],
        { positional: neverProse || at === i + 1, bareNumber: neverProse })) {
        report(i, at);
        break;
      }
      // The command cannot continue past the end of the sentence. This is read
      // AFTER the tiers above, because a real argument routinely ends one:
      // `curl http://host/admin.` is still a command, and the stop belongs to
      // the prose around it.
      if (SENTENCE_END.test(tokens[at])) break;
      // Only a subcommand-shaped word may sit between the runner and its
      // argument. Anything else ends the command, and the sentence goes back to
      // prose. Hyphenated words count: `create-user`, `run-command`, and
      // `port-forward` are how every modern CLI spells its verbs, and stopping
      // on the hyphen dropped the walk one token short of the flag.
      //
      // A runner that is also an English word gets no such hop. Stepping over
      // one plain word is what turned "Make sure /api requires authentication"
      // into `make sure /api` and blocked a summary that leaks nothing; a real
      // invocation of these six announces itself in the very next slot.
      if (ENGLISH_WORD_RUNNERS.has(runner)) break;
      if (!SUBCOMMAND_WORD.test(bareToken(tokens[at]))) break;
    }
    if (found.length === reportedBefore) reportBareScript();
  }
  return found;
}

/**
 * Every credential a piece of text hands over, as structured records rather
 * than as prose.
 *
 * Split out from leakedSecrets because the SAME extraction is needed from the
 * other direction. Reading the summary answers "does this publish a labelled
 * secret"; reading the finding's own reproduction answers "what are this
 * finding's secrets", which is what makes an UNLABELLED copy of one findable.
 * Two spellings of "what counts as a credential here" would mean a key shape
 * one side blocks and the other silently allows through.
 */
function credentialsIn(text) {
  const found = [];

  // A fresh RegExp because ASSIGNMENT is /g and therefore stateful; reusing the
  // module-level object would make the SECOND call on the same input start
  // mid-string and miss the leak it just found.
  const assigned = new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags);
  for (let m = assigned.exec(text); m !== null; m = assigned.exec(text)) {
    // Group 1 is the quote that may wrap the key ("" when the key is bare);
    // group 2 is the key itself.
    const key = m[2];
    const kind = credentialKeyKind(key);
    if (kind === null) {
      // An ordinary assignment can SWALLOW a credential one: in
      // "Two leaks: password=hunter2", the first match is `leaks:` with
      // `password=hunter2` as its value, and skipping the whole match would
      // skip the leak inside it. Resuming just after the key re-scans that
      // text, and always moves forward, so the loop still terminates.
      assigned.lastIndex = m.index + m[1].length + key.length;
      continue;
    }
    // Groups 3/4/5 are the double-quoted, single-quoted, and bare value forms;
    // exactly one of them matched.
    const value = m[3] ?? m[4] ?? m[5];
    if (REDACTION_MARKER.test(value.trim())) continue;
    if (kind === "ambiguous" && isMetadataValue(value)) continue;
    found.push({ shape: "assignment", key, value });
  }

  // Same statefulness precaution as above: /gi, so scan through a fresh object.
  const header = new RegExp(AUTH_HEADER.source, AUTH_HEADER.flags);
  for (let m = header.exec(text); m !== null; m = header.exec(text)) {
    const [, scheme, credential] = m;
    if (REDACTION_MARKER.test(credential.trim())) continue;
    const readsAsHeader = AUTH_SCHEMES.has(comparableText(scheme)) || !PLAIN_WORD.test(credential);
    if (!readsAsHeader) continue;
    found.push({ shape: "header", key: scheme, value: credential });
  }

  return found;
}

/** Secret- or payload-shaped text anywhere in a string that is about to be published. */
function leakedSecrets(text) {
  const found = [...SECRET_PATTERNS, ...PAYLOAD_PATTERNS]
    .filter(({ re }) => re.test(text))
    .map(({ name, why }) => `the public summary contains a ${name} — ${why}`);

  for (const { shape, key, value } of credentialsIn(text)) {
    found.push(shape === "assignment"
      ? `the public summary assigns a value to "${key}" (${JSON.stringify(value)}) — publish ` +
        `the fact that a credential is involved, never the credential`
      : `the public summary carries an Authorization credential ` +
        `(${JSON.stringify(`${key} ${value}`)}) — a scheme plus a token is a request anyone can ` +
        `replay, whatever the scheme is and however short the token`);
  }
  return found;
}

// `errors` and `blockedReasons` are separate on purpose. A finding classified
// `private` is not malformed — the gate firing IS the correct outcome — and
// folding that into `errors` would train a caller to read a working policy
// decision as a bug in the record.
const blockedExport = (reasons, extra = {}) => ({
  allowed: false, decision: "export-blocked", errors: [], blockedReasons: reasons, ...extra,
});

/**
 * The record ids a Duplicate link may resolve against, normalized for
 * comparison.
 *
 * `{ set: null }` means the caller named no ledger — a real state, and the
 * reason the Duplicate branch below refuses rather than assumes. A MALFORMED
 * value is reported instead, never read as an empty ledger: silently treating
 * junk as "no known records" would turn a caller's bug into a blanket refusal
 * that looks like policy.
 */
function normalizeKnownRecordIds(value) {
  if (value === undefined || value === null) return { set: null, errors: [] };
  const ids = value instanceof Set ? [...value] : value;
  if (!Array.isArray(ids) || !ids.every(isNonBlankString)) {
    return { set: null, errors: [`knownRecordIds must be an array or Set of record ids, got ` +
      `${JSON.stringify(value instanceof Set ? ids : value)}`] };
  }
  return { set: new Set(ids.map(comparableText)), errors: [] };
}

/**
 * T8.2 — may this finding be exported into a public issue, and is the summary
 * it would carry actually sanitized?
 *
 * `allowed` is never true by omission. A finding whose severity cannot be read,
 * whose disclosure classification is missing or unrecognized, or whose summary
 * cannot be scanned is blocked — because the one thing worse than withholding
 * a publishable finding is publishing an exploit for a finding nobody
 * classified.
 */
export function checkPublicExport(finding, { anchorResolver = resolveAnchorInTree, knownRecordIds } = {}) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return { allowed: false, decision: "invalid", blockedReasons: [],
      errors: [`finding must be an object, got ${JSON.stringify(finding)}`] };
  }

  const label = `finding "${finding.id ?? "(unnamed)"}"`;
  const errors = [];

  // The ledger / issue ids a Duplicate outcome may resolve against. Supplied
  // here for the same reason checkWaveTriage builds one: without a set, the
  // duplicate link is only checked for being a non-placeholder string, so a
  // typo or a deleted record passes and the finding is published as an outcome
  // that was already settled somewhere it was not.
  const known = normalizeKnownRecordIds(knownRecordIds);
  errors.push(...known.errors.map((e) => `${label}: ${e}`));

  // Step 8 operates on confirmed findings. Without this, a Candidate carrying a
  // severity, a disclosure record, and a clean summary exports cleanly — which
  // is how an unsupported claim T6.2 refused to escalate becomes a public
  // statement anyway, by the longer road.
  const statusExportable = isNonBlankString(finding.status) && EXPORTABLE_STATUSES.includes(finding.status);
  if (!statusExportable) {
    errors.push(`${label}: status must be a confirmed-or-later status ` +
      `(${EXPORTABLE_STATUSES.join("/")}), got ${JSON.stringify(finding.status)} — a candidate that ` +
      `has not cleared the evidence gate must not become a public claim`);
  } else {
    // Membership in the graph is not a journey through it. Anyone can write
    // `status: "Planned"` onto a record that never faced the evidence gate, and
    // with no trail and no triage record it would otherwise export as a
    // confirmed public claim — the longest way round to exactly what T6.2
    // refuses head-on. The trail is the proof, so it is required and validated.
    errors.push(...trailErrorsFor(finding, label));
    if (errors.length === 0 && !finding.history.some((e) => e?.to === "Confirmed")) {
      errors.push(`${label}: the status trail records no transition into Confirmed — publication ` +
        `states that the evidence gate was cleared, and only that edge says it was`);
    }

    // A trail is a claim ABOUT the record; it is not the record. Two lines of
    // syntactically valid history can be written by hand onto a row with no
    // violatedInvariant, no reproduction, and no evidence at all, and the trail
    // check would find nothing wrong with it — so the record itself is put back
    // through §7's confirmation gate.
    //
    // schema.js's validateFinding() is NOT enough here, which is the whole
    // reason this is the shared gate and not that one: it tests presence, so
    // `violatedInvariant: "   "`, `evidence: "  "`, and `affectedPaths:
    // [{file: "gone.js", line: 0}]` all clear it, and §7's confirmation facts
    // (revision, variants weighed, duplicate search, model, tokens) are outside
    // its field list altogether. A forged or corrupted row with a clean
    // Candidate -> Confirmed trail would otherwise be authorized to become a
    // public claim without ever having met the evidence gate.
    if (errors.length === 0) {
      errors.push(...confirmationFieldErrors(finding).map((e) =>
        `${label}: ${e} — publication asserts a supported finding, and a record missing its ` +
        `mandatory fields supports nothing`));
    }

    // The one question a record cannot answer about itself, and the one moment
    // it is worth a filesystem read: do the anchors still point at code that is
    // there? A finding confirmed three waves ago against a file since moved or
    // deleted is a stale claim, and publishing it is the most expensive way to
    // discover that. anchorTreeErrors() fails CLOSED — an anchor the resolver
    // could not check is an unchecked box, never a passed one.
    if (errors.length === 0) {
      errors.push(...anchorTreeErrors(finding, anchorResolver).map((e) =>
        `${label}: ${e} — publication asserts a finding in current code`));
    }

    // Past Confirmed, the record also claims a triage decision, and that
    // decision must hold up. Confirmed itself is exempt: filing the public
    // issue is precisely the act that MAKES the outcome (Confirmed ->
    // IssueFiled), so demanding the outcome first would forbid the only export
    // Step 8 actually describes.
    if (errors.length === 0 && finding.status !== "Confirmed") {
      const triaged = checkFindingTriage(finding,
        known.set === null ? {} : { knownRecordIds: known.set });
      // An outcome of Duplicate says another record already tracks this
      // problem. That claim is the whole justification for publishing the
      // finding as settled, and with no set to resolve the link against it is
      // an unchecked box — never a passed one. Keyed on the OUTCOME rather than
      // on `status`, because a record can name Duplicate in its decision while
      // its status says something else.
      if (known.set === null && triaged.outcome === "Duplicate") {
        errors.push(`${label}: outcome Duplicate names ` +
          `${JSON.stringify(finding.triage?.duplicateOf)} as the record that already tracks it, and ` +
          `no knownRecordIds set was supplied to resolve that link against — publication asserts a ` +
          `settled outcome, and a link nothing can resolve settles nothing`);
      }
      if (!triaged.ok) {
        errors.push(...triaged.errors, `${label}: the triage decision behind this finding does not ` +
          `hold up, so its status is not a settled outcome to publish`);
      }
    }
  }

  // Severity decides whether a classification is REQUIRED, so an unreadable
  // severity is the whole gate's blind spot: DISCLOSURE_REQUIRED_SEVERITIES
  // does not contain `undefined` or `"spicy"`, so a missing or misspelled
  // severity would read as "not high", default to a public classification, and
  // walk a critical finding straight out through the gap the gate was built to
  // close. Refusing it HERE is what makes the severity read fail closed; the
  // rest of this function may then trust `finding.severity`.
  if (!isNonBlankString(finding.severity) || !SCHEMA.SEVERITIES.includes(finding.severity)) {
    errors.push(`${label}: severity must be one of ${SCHEMA.SEVERITIES.join("/")}, got ` +
      `${JSON.stringify(finding.severity)} — an unreadable severity is treated as disclosure-sensitive, ` +
      `never as low`);
  }
  const disclosureRequired = DISCLOSURE_REQUIRED_SEVERITIES.includes(finding.severity);

  const disclosure = finding.disclosure;
  const hasDisclosureRecord = disclosure && typeof disclosure === "object" && !Array.isArray(disclosure);

  if (!hasDisclosureRecord && !isBlank(disclosure)) {
    errors.push(`${label}: disclosure is present but is not a decision record object, got ` +
      `${JSON.stringify(disclosure)}`);
  } else if (!hasDisclosureRecord && disclosureRequired) {
    errors.push(`${label}: a ${finding.severity ?? "severity-unknown"} finding needs a recorded ` +
      `disclosure decision (${DISCLOSURE_REQUIRED_FIELDS.join("/")}) before any public export, got ` +
      `${JSON.stringify(disclosure)}`);
  } else if (hasDisclosureRecord) {
    // Validated whenever a record is PRESENT, at every severity — not only when
    // one was required. A low-severity finding classified `"privat"` is someone
    // deciding to withhold it and mistyping; skipping validation there dropped
    // the typo on the floor and fell through to the public default, so the
    // misspelling authorized exactly what it was written to prevent.
    for (const field of DISCLOSURE_REQUIRED_FIELDS) {
      if (isBlank(disclosure[field])) errors.push(`${label}: disclosure is missing required field: ${field}`);
    }
    if (!isBlank(disclosure.decidedBy) && !isRealAnswer(disclosure.decidedBy)) {
      errors.push(`${label}: disclosure.decidedBy must name the person who made the call, got ` +
        `${JSON.stringify(disclosure.decidedBy)}`);
    }
    if (!isBlank(disclosure.date) && !isRecordedDate(disclosure.date)) {
      errors.push(`${label}: disclosure.date must be a real calendar day in YYYY-MM-DD form, got ` +
        `${JSON.stringify(disclosure.date)}`);
    }
    if (!isBlank(disclosure.classification) &&
        !DISCLOSURE_CLASSIFICATIONS.includes(disclosure.classification)) {
      errors.push(`${label}: disclosure.classification must be one of ` +
        `${DISCLOSURE_CLASSIFICATIONS.join("/")}, got ${JSON.stringify(disclosure.classification)} — ` +
        `an unrecognized classification is not a decision to publish`);
    }
  }

  if (errors.length) {
    return { allowed: false, decision: "invalid", errors, blockedReasons: [] };
  }

  // Reachable only once every check above passed, which means: either there is
  // no disclosure record and the severity did not require one, or there is a
  // record and its classification is one of the three recognized values. An
  // unrecognized classification can no longer arrive here as a silent "public"
  // — it fails above — so this fallback now covers exactly one case, the
  // low/medium finding nobody needed to classify.
  const classification = hasDisclosureRecord ? disclosure.classification : "public";

  if (classification !== "public") {
    return blockedExport(
      [`${label} is classified "${classification}" — publication would expose users, so it goes ` +
        `through the private disclosure path instead of a public issue`],
      { classification },
    );
  }

  // Cleared to publish, so now the text itself has to be clean. An empty or
  // unreadable summary is blocked rather than passed: nothing is the one thing
  // a scanner can always call clean, and "no summary" is not an export.
  if (!isNonBlankString(finding.publicSummary)) {
    return blockedExport(
      [`${label} is cleared for publication but carries no publicSummary (got ` +
        `${JSON.stringify(finding.publicSummary)}) — the sanitized text is what gets exported, so an ` +
        `absent one must not export the raw finding by default`],
      { classification },
    );
  }

  const leaks = [
    ...leakedSecrets(finding.publicSummary),
    ...leakedCommands(finding.publicSummary),
    ...leakedSourceText(finding.publicSummary, finding),
  ].map((reason) => `${label}: ${reason}`);

  if (leaks.length) return blockedExport(leaks, { classification });

  return { allowed: true, decision: "export-allowed", classification, errors: [], blockedReasons: [] };
}
