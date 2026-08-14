# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Added

- **Document-intelligence: a rule against counting one payment twice.** The
  skill told the model how to read, aggregate and persist documents, but never
  that one economic event is often documented more than once — the same receipt
  saved as both a text file and a scan, or a receipt and the bank-statement row
  for that same purchase. `doc_batch`'s `aggregate` merges those, but the moment
  the model hand-builds rows for an `INSERT` it re-derives from the raw documents
  and the merge is gone. The new guidance names both shapes, states the harder
  half — equal amounts never establish duplication, and neither does the same
  merchant on the same card, so two fills at one petrol station on different
  dates stay two purchases — and ends with a check that costs nothing:
  reconcile per-category totals against `aggregate` before proposing the write.

### Fixed

- **A malformed tool call told the model what failed but never why.** When a
  model's arguments arrive from a parse that lost sync, the argument *values*
  end up folded into a key name — so the real parameter is simply absent and the
  tool reports it missing. Two things made that unrecoverable. The schema check
  reported the debris as a hallucinated parameter, which is both wrong and
  expensive: a single call wrote kilobytes of half-parsed payload into the
  repair ledger and back into the model's context. And the pointed correction
  was suppressed for destructive tools, conflating two different guards —
  refusing to *repair* malformed arguments for those tools is a corruption guard
  and is unchanged, but declining to *explain* a failure protects nothing.
  Debris is now classified as its own kind, carrying only a length rather than
  the payload, and the correction names the tool's real parameters once for the
  whole group. Observed against a recorded run where the same malformed
  statement was retried three times under a bare "`sql` is required".

- **The reasoning toggle was labeled "Enable/Disable reasoning" but only ever
  hid or showed the reasoning bubble in the browser** — it was never passed
  into the agent or provider request, so switching it off did not stop a
  model from thinking or save any latency/tokens. Relabeled to "Show/Hide
  reasoning" (English and all 24 locales) to match what it actually does.
  Real per-provider reasoning-effort control is tracked separately as
  [#476](https://github.com/BaiGanio/aperio/issues/476).

- **A stuck llama.cpp/Ollama connection could hang a turn forever.** The
  streaming response reader had no deadline at all past the initial HTTP
  headers — `LLAMACPP_FETCH_TIMEOUT_MS` only bounded time-to-first-byte, so a
  server that stopped responding mid-stream (crashed slot, dead connection)
  left the turn waiting indefinitely with no error and no retry. Verified live
  against llama-server that a long prefill is not actually silent — it sends a
  3-byte SSE keep-alive ping roughly every 30s until the first token — so a
  per-read idle timeout (`LLAMACPP_STREAM_IDLE_TIMEOUT_MS`, default 120s) can
  safely catch a genuinely dead connection without ever tripping during a
  legitimate multi-minute prefill.

- **`db_execute` told models a connection was "named undefined" when they had
  named none.** A proposal missing the `connection` argument fell through to the
  connection lookup, whose error interpolated the raw argument — so the model was
  told `no connection named "undefined"`, asserting it had named a connection it
  had not. Two local models each burned a whole turn re-emitting the identical
  malformed call against that message. The propose path now requires
  `connection` explicitly and says what to pass (`extraction` for data extracted
  from documents, `db_connections` to list what exists), and the lookup error
  reports the name actually looked up rather than the raw argument.
