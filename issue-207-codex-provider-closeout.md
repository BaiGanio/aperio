# Issue 207 Closeout: Codex Provider Notes

Source: https://github.com/BaiGanio/aperio/issues/207
Closed locally on: 2026-07-07

## Readout

Issue #207 has served its purpose as a Codex provider research/spike note. The
useful parts have already been captured in the issue discussion: a working local
spike exists, mocked provider/config tests passed, and the main remaining work is
productization plus authenticated end-to-end validation.

Do not treat the original issue body as canonical implementation guidance. Some
of its Claude Code audit details are stale against the current checkout:

- Claude Code tool schemas are no longer flattened to a passthrough object; the
  provider now derives Zod shapes from each MCP `inputSchema`.
- Claude Code permissions are not using the originally noted `default` mode; the
  current provider bypasses SDK permissions, which needs separate product and
  security review.
- The suggested Codex default model should be checked against current OpenAI
  docs when finalizing the provider rather than copied from the issue text.

## Follow-Up Work

- Run a real authenticated Codex end-to-end test through Aperio chat.
- Capture actual Codex JSONL/MCP behavior before committing the spike.
- Decide and document the supported/default Codex model.
- Persist Codex thread IDs in Aperio session metadata if restart-safe resume is
  expected.
- Improve event mapping for partial text, auth/rate-limit/retry state, and richer
  tool progress.
- Add explicit abort and live MCP failure coverage.
- Decide whether Codex belongs in background completions, setup wizard, README,
  and roundtable mode.
- Review Codex sandbox and approval defaults as a product security decision.
- Track unrelated full-suite failures separately rather than blocking the Codex
  provider on them.

## Recommended Next Step

Turn the local Codex provider spike into a reviewable PR after the authenticated
manual flow passes. Use this note as the follow-up checklist instead of reopening
issue #207.
