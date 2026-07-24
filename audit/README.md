# Aperio Continuous Audit — Developer Guide

## What Is This?

This folder is the home of Aperio's continuous audit system — a repeatable,
evidence-first process for finding real defects and architectural drift
without giving the entire repository to an LLM every time.

Key rule: **audit sessions never change production code.** Confirmed findings
become separate implementation tasks.

---

## 1. The Files — What Each One Does

```
audit/
├── README.md                      ← This file. Start here.
│
├── scripts/
│   ├── inventory.js               # Snapshot the repo as JSON
│   └── schema.js                  # Rules for recording findings
│
├── tests/
│   ├── inventory.test.js          # 11 tests: is inventory honest?
│   └── schema.test.js             # 38 tests: is schema enforced?
│
└── runs/
    └── run-001/
        └── baseline.json          # Frozen snapshot from 2026-07-24
```

### `scripts/inventory.js`

A deterministic machine that walks the repo and produces a JSON snapshot:

- File counts (lib, mcp, db, skills, public/scripts)
- Test file counts broken down by directory
- Provider names (anthropic, deepseek, llamacpp, etc.)
- Route file names
- MCP tool names
- Database migration lists (both backends)
- Locale codes
- Git branch, commit SHA, dirty file list
- Node and npm versions

Run it:

```bash
node audit/scripts/inventory.js                    # with timestamp
node audit/scripts/inventory.js --no-timestamp     # for comparison (deterministic)
node audit/scripts/inventory.js /some/other/path   # against any directory
```

Two consecutive runs with `--no-timestamp` produce byte-identical output.
The only non-deterministic field is `observed_at`.

### `scripts/schema.js`

Defines the language for recording audit findings. Two record types:

**Run record** — metadata about an audit session:
schema_version, run_id, slice_id, revision, branch, timestamp, scope, observer, elapsed_ms

**Finding record** — one thing found wrong (or suspicious):
id, revision, status, severity, confidence, affected_locations, invariant,
expected_behavior, actual_behavior, evidence, reproduction

**Finding lifecycle** — every finding moves through a state machine:

```
candidate ──→ confirmed ──→ planned ──→ fixed
     │              │
     └──→ rejected   └──→ duplicate / accepted-risk
                         │
                         └──→ reopened (if risk expires or fix regresses)
```

- `validateRun(record)` — rejects records missing required fields
- `validateFinding(finding)` — rejects findings without evidence, invariant, or reproduction
- `canTransition(from, to)` — checks if a status change is legal
- `transitionFinding(finding, newStatus)` — updates status and preserves history

### `tests/inventory.test.js` (T1 tests)

11 tests that prove the inventory is honest:

| Test | What it proves |
|------|---------------|
| T1.1 | Two runs on the same tree produce identical output |
| T1.1 | Timestamp is present when not suppressed |
| T1.1 | All key arrays are properly sorted |
| T1.2 | Modified, untracked, and deleted files are reported |
| T1.2 | Inventory does not change `git status` (read-only) |
| T1.2 | Filenames with spaces are handled |
| T1.3 | Adding a file changes the count |
| T1.3 | Adding a provider changes the provider list |
| T1.3 | Adding a test file changes the test count |
| T1.3 | Adding a migration changes migration counts |
| T1.3 | Ignored directories (var/, coverage/) are not counted |

### `tests/schema.test.js` (T3 tests)

38 tests that prove the validation rules work:

- Required fields are enforced (run without revision = rejected)
- Invalid statuses/severities/confidences are rejected
- Terminal states (rejected, duplicate, fixed) cannot transition forward
- Finding history is preserved through multiple transitions
- Run IDs are unique

---

## 2. How to Run Things

```bash
# Run all audit tests
npm run test:audit

# Run just the inventory tests
npm run test:audit:inventory

# Run just the schema tests
npm run test:audit:schema

# Generate a fresh baseline
node audit/scripts/inventory.js > audit/runs/latest-baseline.json

# Compare with saved baseline
diff <(node audit/scripts/inventory.js --no-timestamp) \
     <(jq 'del(.observed_at)' audit/runs/run-001/baseline.json)
```

---

## 3. How to Read the Baseline

Open `audit/runs/run-001/baseline.json`. It answers:

> At commit `e344e2f0` on branch `feat/codegraph-intelligence-283`,
> how many X does the repo have?

Key fields:

| Field | Current value | What to watch for |
|-------|--------------|-------------------|
| `source_files.total` | 401 | Spikes or drops without explanation |
| `test_files.total` | 271 | Drops mean tests deleted (flag for review) |
| `providers` | 6 items | Adding a new provider must also add it to dispatch |
| `database.migration_count_postgres` | 10 | Must always equal `migration_count_sqlite` |
| `database.migration_parity` | true | If false, a migration was added to only one backend |
| `locales.count` | 26 | Adding a locale should touch the i18n pipeline too |
| `repository.dirty` | true | Findings against dirty trees are marked sensitive |

The `dirty` flag is an honest signal: if the working tree has uncommitted
changes, some audit conclusions may not hold at the clean HEAD.

---

## 4. When to Do What

Three rhythms, from most to least frequent:

### Every Pull Request (CI)

```yaml
- run: npm run test:audit
```

Purpose: **catch harness breakage.** If a refactor changes how `findFiles()`
works or a dependency update breaks a test, you know immediately.

What it costs: ~4 seconds.

### Every Release / Milestone

```bash
node audit/scripts/inventory.js --no-timestamp > new-baseline.json
diff <(jq 'del(.observed_at)' new-baseline.json) \
     <(jq 'del(.observed_at)' audit/runs/run-001/baseline.json)
```

Purpose: **detect silent drift.** Did someone add a new route without a rate
limit? Add a locale without i18n keys? Change the provider list? The diff
tells you. Review it before tagging the release.

What it costs: <1 second.

### Quarterly — Full Audit (all 22 slices)

This is the big one. 22 component slices (A01–A22) + 12 boundary journeys.
Each slice is a bounded chunk of the codebase reviewed against a specific
invariant. The full plan (including what remains to be built) is at:

```
trash/plans/aperio-continuous-audit/aperio-continuous-audit.md
```

What it costs: depends on model usage. The plan caps each slice at 30K input
tokens and uses local models for reconnaissance.

---

## 5. What Already Exists vs What's Still Planned

### Built and usable now

| Component | What it does | Tests |
|-----------|-------------|-------|
| `scripts/inventory.js` | Deterministic repo snapshot | 11 pass |
| `scripts/schema.js` | Finding recording + validation | 38 pass |
| `scripts/manifest.js` | Evidence packet builder with content hashes | 9 pass |
| `scripts/contracts/database.js` | A14 DB contract gate (migration parity, store existence, encryption tests) | 7 pass |
| `runs/run-001/baseline.json` | Frozen baseline at e344e2f0 | — |
| `runs/run-001/A14/manifest.json` | A14 evidence packet | Verified |
| `runs/run-001/A14/contract-result.json` | A14 contract gate result (passing) | Verified |
| `npm run test:audit` | Runs all audit harness tests | 59/59 pass |
| `audit/README.md` | This file — developer instructions | Updated after each phase |

### What the plan describes but doesn't exist yet

| Component | Purpose | Needed for |
|-----------|---------|------------|
| Wave 1–5 execution | 22 slice audits | Full audit run |
| Delta trigger system | Rerun only changed slices | After Run 1 closeout |
| Slice definitions for A01–A13, A15–A22 | Remaining 21 slice definitions in manifest.js | Full audit run |

The A14 (Database) vertical pilot is complete: manifest → contract gate →
red/green proof → first run record with a clean result. All 59 tests pass.
Next: expand to remaining slices (A01–A13, A15–A22).

---

## 6. CI Integration — What It Means

"Put it in CI" means adding a GitHub Actions workflow that runs automatically
on every push or PR. With what we have today:

```yaml
name: audit-harness
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:audit

      - name: Generate and compare baseline
        run: |
          node audit/scripts/inventory.js --no-timestamp > ci-baseline.json
          # Compare key counts with the stored stable baseline
          node -e "
            const cur = require('./ci-baseline.json');
            const ref = require('./audit/runs/stable-baseline.json') || {};
            const flags = [];
            if (cur.database.migration_count_postgres !== cur.database.migration_count_sqlite)
              flags.push('MIGRATION_ASYMMETRY');
            if (cur.providers.length !== ref.providers?.length)
              flags.push('PROVIDER_COUNT_CHANGED');
            // More checks as contracts are added
            if (flags.length) {
              console.log('Audit flags: ' + flags.join(', '));
              process.exit(1);
            }
          "
```

This catches things that normal tests don't: migration asymmetry, provider
count drift, locale silent additions, source count anomalies.

---

## 7. How This Gets Built — The Development Process

This audit system is built one phase at a time. Each phase produces real,
tested files — not promises. Here's the explicit process we follow:

### After every phase

1. **This README is updated** — new files, new commands, new test counts,
   updated "built vs planned" table. You never have to guess what exists.
2. **I ask if you're clear** on what was built and what's next.
3. You say yes, ask questions, or redirect. Only then does the next phase start.

### The contract between us

- You don't need to remember where we are — the README and the progress file
  (`trash/plans/aperio-continuous-audit/aperio-continuous-audit-progress.md`)
  both say it.
- You don't need to chase me for status — I update both after every phase
  and ask you before proceeding.
- If something is unclear, you say so. I adjust or explain before building more.

### Current phase

The "Built and usable now" table in section 5 reflects the latest completed
phase. The "What the plan describes but doesn't exist yet" table shows what's
next. Between the two, you always know what we have and what we're building
toward.

---

## 8. Finding Lifecycle Reference

```
                          ┌──────────┐
                          │ Candidate │
                          └────┬─────┘
                           ┌───┴───┐
                           │       │
                    ┌──────┘       └──────┐
                    │                     │
               ┌────┴─────┐         ┌────┴─────┐
               │ Confirmed │         │ Rejected │──→ [*]
               └────┬─────┘         └──────────┘
              ┌─────┼─────────┐
              │     │         │
        ┌─────┴┐ ┌──┴───┐ ┌───┴────┐
        │Planned│ │Dup. │ │Acc.Risk│
        └──┬───┘ └──[*]─┘ └───┬────┘
           │                  │
       ┌───┴───┐         ┌────┴────┐
       │ Fixed │──→ [*]  │ Reopened│──→ Confirmed / Rejected
       └───┬───┘         └─────────┘
           │
      ┌────┴────┐
      │ Reopened│
      └─────────┘
```

Rules:
- A finding without evidence, invariant, or reproduction is not a finding.
- Confidence and severity are separate. High-impact / low-confidence is not a "critical bug."
- Terminal states (rejected, duplicate, fixed) cannot be resumed.
- Reopened findings go back to confirmed (with new evidence) or rejected.

---

## 9. Quick Reference

```bash
# Harness health
npm run test:audit

# Fresh repo snapshot
node audit/scripts/inventory.js

# Snapshot without timestamp (for comparison)
node audit/scripts/inventory.js --no-timestamp

# Validate a run record
node -e "
  const { validateRun } = require('./audit/scripts/schema.js');
  const r = validateRun({ run_id: 'test', ... });
  console.log(r.valid ? 'OK' : r.errors);
"

# Validate and transition a finding
node -e "
  const { validateFinding, transitionFinding } = require('./audit/scripts/schema.js');
  const f = { id: 'X', status: 'candidate', ... };
  console.log(validateFinding(f).valid);
  const updated = transitionFinding(f, 'confirmed', { reason: 'reproduced' });
  console.log(updated.status, updated.history);
"
```
