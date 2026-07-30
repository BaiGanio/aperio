# Next Session — Run 2

## Run 1 Status

**CLOSED** — all Wave 5 findings dispositioned and closeout checklist approved.
Progress report at `trash/plans/aperio-continuous-audit/aperio-continuous-audit-progress.md`.

## What was done in Run 1

- **A14 bootstrap pilot:** Database parity and encryption — 65 tests, clean result.
- **Wave 5:** 12 boundary journeys traced across 7 entry points × 5 invariants. Full boundary matrix (35 cells).
- **Remediation:** 7 findings (3 fixed, 1 mitigated, 1 investigated, 2 accepted risks).

## Run 1 key artifacts

- `audit/runs/run-001/baseline.json` — frozen repo snapshot
- `audit/runs/run-001/matrix.json` — boundary matrix (7×5)
- `audit/runs/run-001/journeys/journey-{1..12}.md` — journey reports
- `audit/runs/run-001/journeys/contract-result.json` — contract verification (8 invariant groups, 55+ checks)
- `audit/runs/run-001/A14/` — database parity evidence

## What to do in Run 2

### Priority order (from closeout)

1. **A06 — Provider contract matrix.** 6 providers to verify: Anthropic, llama.cpp, DeepSeek, Gemini, Claude Code, Codex. Test shared contracts and provider-specific behavior.
2. **A17 — Interrupt and cancellation semantics.** Touched by the CONFIRMABLE_TOOLS fix — verify interrupt lifecycle, confirm/decide paths, expiry.
3. **A03 — HTTP trust boundary.** Security-critical: NetGuard, rate-limit, authGuard, TLS, CORS. Static audit followed by integration tests.
4. **A13 — Memory, wiki, and embeddings.** Largest surface area. Vertext search, CRUD, cache, FTS5, sqlite-vec, Postgres pgvector — touched by the updateMemory fix.
5. **Remaining slices** A01, A02, A04, A05, A07–A12, A15, A16, A18–A22, if budget permits.

### Process improvements to apply

- **Size scope before starting** — Run 1's plan was too ambitious; pick 4–6 slices max.
- **Use the 3-tier funnel** — run local llama.cpp reconnaissance for at least one slice to validate the tier works.
- **Reuse audit journey reports as inputs** — the line-number references in the reports should be the starting point, not re-reading source files.
- **Run audit tests against clean HEAD** — closeout on a dirty tree creates baseline ambiguity.

## Key files

- `trash/plans/aperio-continuous-audit/aperio-continuous-audit.md` — full plan (22 slices, procedure, token budget)
- `trash/plans/aperio-continuous-audit/2dev.md` — developer playbook (session-by-session instructions)
- `trash/plans/aperio-continuous-audit/aperio-continuous-audit-progress.md` — Run 1 closeout + Run 2 template
- `audit/README.md` — how to run things
- `audit/scripts/inventory.js` — deterministic repo snapshot
- `audit/scripts/schema.js` — finding record validation
