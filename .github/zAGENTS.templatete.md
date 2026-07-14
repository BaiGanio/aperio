PROMPT: "execute the fill protocol at the top of agents.template.md" 
# AGENTS.md — [Project Name]

> This file orients AI agents working in this repo: what the project is, where the
> sharp edges are, and how the developer wants to fly. It is a light marker, read at
> the start of every session — keep it short, point to deeper docs, never duplicate them.
>
> *On lineage: this template is the form; every filled CLAUDE.md is a particular
> that partakes of it. But the truth of a project lives in neither file — it lives
> in the developer. The protocol below exists only to recollect it.*
>
> *And the destination is never the code. Code is the idea made visible — the
> becoming, not the being. When the particulars disagree, climb: steer by the
> idea, and the idea decides.*

<!-- ═══════════════════════════════════════════════════════════════════════
     FILL PROTOCOL — instructions for the model doing the one-time fill pass.
     DELETE THIS ENTIRE BLOCK once the fill is complete and approved.

     Your job: turn this template into an accurate briefing for THIS repo.
     Accuracy beats completeness. Every claim you write must be traceable to
     (a) a file in the repo, or (b) an answer the developer gave you.
     If you can prove neither: ASK. Never fill a section by guessing.

     ── Phase 1: Research (before asking anything) ──
     Read, in this order, whatever exists:
       1. README*                — what the project claims to be
       2. SECURITY*, CONTRIBUTING*, LICENSE — stated policies
       3. Package manifest (package.json / pyproject.toml / go.mod / Cargo.toml)
                                 — real dependencies, scripts, entry points
       4. CI config (.github/workflows/ etc.) — what actually gates merges
       5. Config surface (.env.example, settings modules) — tunables, secrets shape
       6. Migrations / schema files — the data model
       7. Test setup            — how tests really run, not how docs say they run
       8. Directory tree, 2 levels deep — module layout
     Draft answers for each section below and note where each answer came from.

     ── Phase 2: Interview — grill the developer ──
     The repo cannot tell you what has burned the developer before, what they
     fear touching, or how they want to work with you. That knowledge is the
     most valuable content in this file, so extract it.

     You are practicing maieutics — Socratic midwifery (Theaetetus 150b).
     The developer already carries this knowledge; they have simply never had
     to say it aloud. Your questions add nothing — they deliver what is
     already there. The repo shows you shadows on the cave wall; only the
     developer can tell you what casts them. Rules:
       - Ask in small batches (3–5 questions), most important first.
       - Ask concrete questions ("which file, edited wrong, ruins your week?")
         not abstract ones ("any fragile code?").
       - Each section below carries an ASK comment with its interview questions.
         A section is DONE only when it is filled with evidence or the developer
         explicitly said "not applicable".
       - When an answer surprises you, follow up. Depth beats coverage.
       - Contradiction between repo evidence and the developer's answer?
         Surface it and ask which is true — that gap is exactly what this
         file exists to close.

     ── Phase 3: Write ──
       - Fill every section. Delete sections the developer marked N/A —
         an empty heading is worse than no heading.
       - Delete every EVIDENCE/ASK comment and this whole protocol block.
       - Keep the final file lean: aim under ~150 lines of prose (tables and
         command blocks excluded). Push depth into reference docs and link them.
       - Show the finished file to the developer and get explicit sign-off
         before considering the pass complete.
     ═══════════════════════════════════════════════════════════════════════ -->

## Project: [name]

[One line: what it is and why it exists. Link to repo/homepage.]
[One more line: the eidos — the idea of which this repo is only the current shadow.
It decides arguments when trade-offs collide; every section below serves it.]

<!-- EVIDENCE: README intro, repo description.
     ASK: "What is the idea this repo is a shadow of — the thing that would still
     be true if every line were rewritten? When two goals conflict
     (speed vs. safety, features vs. simplicity), which one wins?" -->

## Co-pilot Contract

How the developer wants to work with an AI agent in this repo:

- [Where to act freely vs. where to ask first — e.g. "act in tests, ask before migrations"]
- [The one thing an agent must never do here without confirmation]
- [Verification habits — what "done" means before claiming done]
- [Communication style — terse expert mode / explain-as-you-go]

<!-- ASK: "Where do you want me to just act, and where must I ask first?
     What must an agent never do in this repo? What's your definition of done —
     tests green, manual check, something else? How much explanation do you want?"
     This section has NO repo evidence — it comes entirely from the interview. -->

## Quick Start

```bash
# Clone, install, run — the commands the developer actually types
```

Key commands: [the daily-driver commands: run, test, migrate, lint]

<!-- EVIDENCE: README, manifest scripts, Makefile.
     ASK: "Which commands do you actually run every day? Any script in the
     manifest that looks important but is dead/legacy?" -->

## Tech Stack

- **Runtime**: [language + version constraint]
- **Framework**: [web/app framework]
- **Database**: [engine + driver/ORM]
- **Testing**: [runner + coverage tool]
- [Other load-bearing dependencies]

<!-- EVIDENCE: package manifest, lockfile, CI matrix.
     ASK: "Any dependency pinned on purpose — a version I must NOT upgrade,
     and why? Anything vendored or patched?" -->

## Configuration

[How the project is configured: .env / YAML / flags. Where the registry of
settings lives, and the precedence order if there are multiple sources.]

Critical settings:
- `KEY` — [what it controls, valid values, what breaks if wrong]

<!-- EVIDENCE: .env.example, config module, settings docs.
     ASK: "Which settings are dangerous to get wrong? Is there a precedence
     order between config sources? Any setting that MUST stay off by default?" -->

## Database

[Schema overview: key tables/collections and what they hold. Migration strategy
and its discipline — what keeps the schema honest.]

<!-- EVIDENCE: migrations dir, schema files, ORM models.
     ASK: "What's the migration discipline — anything that must stay in lockstep?
     Has schema drift ever bitten you here?" -->

## Fragile / No-Touch Zones

[Files or modules where a small change has a large blast radius: what each does,
why it's load-bearing, and how to verify a change there safely.]

<!-- This is the highest-value section and the repo alone cannot write it.
     EVIDENCE: files with dense import graphs, security-adjacent code, anything
     with warning comments.
     ASK: "What has actually broken before, and what change caused it?
     Which file do you fear touching? For each fragile zone: how do I PROVE
     a change there is safe — which test, which manual check?" -->

## Module Coupling Map

| Coupling | Why |
|----------|-----|
| `module/a` ↔ `module/b` | [Why a change in one silently breaks the other] |

<!-- EVIDENCE: trace imports of the fragile zones above; shared data shapes,
     protocols without schemas, parallel dirs that must stay in sync.
     ASK: confirm each row — "if I change X, does Y really break?" -->

## Security Model

- [Auth mechanism]
- [Input validation / path safety strategy]
- [Secrets management]
- [Rate limiting, CORS, CSP, sandboxing]

<!-- EVIDENCE: SECURITY.md, auth middleware, validation helpers.
     ASK: "What's the threat model — who is this defended against?
     Any security decision that looks wrong but is intentional?" -->

## Code Conventions

- [Module system, language level]
- [Lint/format tooling and config]
- [Type discipline: TS / JSDoc / hints]
- [Error-handling philosophy]
- [Unwritten rules — the things reviewers reject that no linter catches]

<!-- EVIDENCE: lint config, editorconfig, reading 3–4 representative files.
     ASK: "What are the unwritten rules — things you'd reject in review that
     no tool enforces?" -->

## Contribution Conventions

### Branch naming
AI agent commits: `type: <description> signed by <model-name>`. Humans: same prefix, no signature.
Types: `feature:`, `fix:`, `refactor:`, `chore:`.

### Commit messages
[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.
Types: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

### Changelog & versioning
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/). Add entries under
`## Unreleased`. Release workflow handles version bumps — never manually bump version files.
Versioning: [SemVer](https://semver.org/).

<!-- Ready to use as-is. ASK only: "Does the release workflow really own version
     bumps here, or is that aspirational?" Adjust if the repo differs. -->

## Plans

When asked to write or design a plan — architecture, feature design, migration strategy,
refactor roadmap — produce a plan document at `trash/plans/<slug>.md`. Use kebab-case slugs.

### Plan structure
Every plan must include:

1. **Objective** — one sentence: the problem being solved and why it matters
2. **Diagram** — a [Mermaid](https://mermaid.js.org/) diagram showing key components and their
   relationships. Mermaid is text-based, renders on GitHub, and is diffable. For UI mockups,
   generate a PNG and store alongside as `<slug>.png`.

   ```mermaid
   graph TD
       A[Input] --> B[Process]
       B --> C[Output]
   ```

3. **Model recommendation** — which model/provider to use for execution, with rationale.
   See model selection principles below. Include: recommended model, estimated input/output
   tokens, estimated cost, and one-sentence rationale.

4. **Steps** — ordered, each with a concrete acceptance criterion ("works when…"), and a
   reference to the companion test file (`trash/plans/<slug>-tests.md`) where each step's
   tests are defined in detail.

5. **Risks** — what can go wrong, mitigation for each
6. **Doc updates** — which files need changes after implementation (see Documentation Sync)

### TDD — Tests First

Every plan MUST have a companion test file at `trash/plans/<slug>-tests.md`, produced
alongside the plan itself. When the plan is executed, the verification criteria defined
in the test file are validated **before** the implementation is considered complete —
verify-first, not verify-after.

Tests adapt to the plan's domain — "test" means "provable criterion that the work is done
right." The structure is universal; the content is domain-specific:

| Plan domain | What a "test" means |
|-------------|---------------------|
| Software feature | Code test (unit, integration, e2e, contract) |
| Engineering (e.g., water mill) | Physical criterion (flow rate, RPM, load, tolerances) |
| Business / strategy | Measurable outcome (revenue, conversion, time-to-market) |
| Content / documentation | Review checklist, accuracy checks, style compliance |
| Infrastructure / ops | Health checks, SLO thresholds, chaos-test assertions |

**Test file structure** (`trash/plans/<slug>-tests.md`):

1. **Coverage map** — which plan steps each test group covers, so nothing falls through
   the cracks. Use a simple table:

   | Plan step | Test group | Coverage |
   |-----------|-----------|----------|
   | Step 1    | Unit: …   | …        |
   | Step 2    | …         | …        |

2. **Test cases** — each test case has:
   - **Name** — descriptive, unique across the file
   - **Input / setup** — preconditions, fixtures, mock data, or domain-specific preparation
   - **Expected behavior** — concrete, measurable outcome; avoid "should work"
   - **Assertions** — the specific checks that must pass (code assertions, physical
     measurements, financial targets — whatever the domain demands)
   - **Edge cases** — boundary conditions, failure modes, edge inputs, worst-case scenarios

3. **Test execution order** — dependencies between test groups. Tests within a group
   are independent; groups may depend on earlier groups.

4. **Diagrams** (optional) — if a test scenario involves data flow, state transitions,
   or component interactions that are easier to see than read, include a Mermaid diagram.

5. **Required setup** — any fixtures, tools, environment, migrations, config, or seed
   data needed before the test suite can run.

When a plan is executed:
1. Read the companion test file first
2. Prepare the verification criteria and confirm the current state does **not** satisfy
   them — red means the test file has teeth (for code: write stubs and watch them fail;
   for engineering: measure the current output against the target)
3. Implement the plan steps until all criteria are met (green)
4. Update the test file if discoveries during implementation change the expected outcome
5. Confirm the coverage map still holds — no orphaned plan steps, no untested paths

### Model selection
Right-size the model to the task. A typo fix does not need a frontier model. A security
audit does not belong on a 7B local model. Default priority:

1. **Local first** — [local model setup, if any] for code edits, file ops, structured
   reasoning. Zero API cost.
2. **Cheapest capable cloud** — [preferred provider] for reasoning-heavy work,
   [secondary] for throughput.
3. **Precision-critical only** — [strongest model] when instruction-following is paramount.

<!-- ASK: "Do you run local models? Which cloud providers do you pay for, and
     what's your cost tolerance — when is the expensive model worth it?" -->

## Documentation Sync

After any change that alters behavior, adds a feature, fixes a security issue,
or changes configuration, check whether these files need updates:

| Change type | Files to update |
|-------------|-----------------|
| New feature / tool | `FEATURES.md`, `CHANGELOG.md` |
| API / config change | `README.md` (if documented there), `CHANGELOG.md` |
| Security fix | `SECURITY.md`, `CHANGELOG.md` |
| Dependency change | `README.md` (if listed), `CHANGELOG.md` |
| Architecture change | `[architecture doc]`, `CHANGELOG.md` |
| Breaking change | `README.md`, `FEATURES.md`, `CHANGELOG.md` |

**Always confirm with the developer before writing doc updates.** State which files need
changes and why. Wait for confirmation. Never silently modify documentation.

After a commit, push, or release, re-check this table and offer to update any stale docs.

<!-- EVIDENCE: which of these doc files actually exist in the repo.
     ASK: prune rows for files that don't exist; add rows for docs that do. -->

## Reference Files

Deep-dive docs live here — read on demand, not every turn:

| Topic | File |
|-------|------|
| Architecture | `[path]` |
| API / tools | `[path]` |
| Testing guide | `[path]` |
| Troubleshooting | `[path]` |
| CI/CD | `[path]` |
| Known tech debt | `[path]` |

<!-- EVIDENCE: docs/ or similar dirs. ASK: "Where do the deep docs live?
     Which are trustworthy and which are stale?" Mark stale ones or drop them. -->

## Maintaining This File

This file is a marker, not a manual. Any agent reading it: if a claim here no longer
matches the repo, say so — a stale briefing is worse than none. Keep updates surgical:
fix the pointer, don't grow the prose. When something new deserves depth, it goes in a
reference file and earns one line here.

The unexamined briefing is not worth loading. *(Apology 38a, adjusted for context windows.)*
