# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## Unreleased

### Changed

- **Leaving `run_node_script` / `run_python_script` ungated is now recorded as a
  decision, not a gap.** Both tools execute code on the host with the user's
  privileges and remain outside `APERIO_ENABLE_SHELL` and `CONFIRMABLE_TOOLS`,
  because eight bundled skills (`pptx`, `docx`, `docx-advanced`, `pdf`,
  `design-randomizer`, `agent-conduct`) generate their output by writing a
  script and running it — a switch would break document generation on a fresh
  install, and a confirm prompt would charge several clicks per document.
  `SECURITY.md` now states the decision and its full cost, including that the
  spawned child inherits the server environment (provider API keys included),
  and points anyone who cannot accept that baseline to host-level isolation
  rather than to a setting. The `APERIO_ENABLE_SHELL` help text in
  `lib/config.js` (and the generated `.env.example` / `docs/config-reference.md`)
  now says the switch gates `run_shell` **only**. Documentation and help text
  only — no behaviour change.

- **`SECURITY.md` now describes the code-execution and database surfaces as they
  actually are.** Four corrections, all documentation-only:
  - The threat model warned about `run_shell` alone. `run_node_script` and
    `run_python_script` execute code on the same host with the same privileges,
    are **not** gated by `APERIO_ENABLE_SHELL` (the `SHELL_ENABLED` check lives
    in `runShellHandler` only), are **not** in `CONFIRMABLE_TOOLS`, and ship in
    the default `file-generate` tool profile. Because `write_file` also runs
    without confirmation inside the allowed write paths on an untainted turn,
    a model can write a `.js` file and execute it with the shell switch off.
    `SECURITY.md` now states that arbitrary code execution as the Aperio user is
    the baseline capability of a connected model, not something the shell switch
    turns on.
  - Confirming an `index_folder` proposal calls
    `setAllowlist([...paths, path])`, and Aperio keeps one allowed-folders list
    that is both the read ceiling and the write ceiling. The grant is therefore
    persistent, app-wide read **and** write for every later tool call and
    session, while the prompt says only "Authorize and index". Documented under
    Known Limitations; the prompt string itself is unchanged.
  - `db_query` / `db_execute` reach the user's own configured databases,
    production included, and were absent from `SECURITY.md`. `db_execute` is
    confirm-before-write; `db_query` and `db_schema` are not confirmed at all,
    and their rows enter the conversation and the configured AI provider.
  - The Supported Versions table said `0.68.x` while `package.json` is `0.69.0`.

### Added

- **Every built-in provider loop now has a per-turn tool-step cap.** New
  `APERIO_TURN_MAX_TOOL_STEPS` (default 6, 0 disables) bounds how many
  tool-calling passes one reply may spend in the llama.cpp, DeepSeek, Anthropic
  and Gemini loops. At the limit the tools are withdrawn for one pass and a
  short instruction explains why, so the model must answer — with no tool
  schemas in the request the API cannot return another tool call and the turn is
  guaranteed to end. This closes the last unbounded shape: the existing repeated-
  call breaker and the tool-safety middleware both only count a call issued
  *identically* over and over, so a model alternating between different tools
  reset them on every call and ran until the turn's wall clock killed it with no
  answer produced. Codex already had its own equivalent
  (`CODEX_TURN_MAX_TOOL_CALLS`) and is unchanged. The cap is surfaced like the
  repeat breaker — an amber chip in the web UI, a line in the CLI, and a
  `tool_step_limit` stream event. 6 rests on the premise that a model still lost
  after 3-4 passes is rarely one pass from succeeding, so a higher ceiling buys
  a longer wait for the same failure rather than a better answer: nothing else
  in Aperio bounds a turn's total length (per-request timeouts bound one
  request), and at the ~42 s per pass recorded on the Ornith loop a cap of 6
  fires in about 4 minutes where 64 would have taken ~45 — long after any real
  user pressed Stop. The trade-off is stated rather than hidden: the deepest
  legitimate chain seen so far (`doc_manifest` → `doc_batch` → `db_schema` →
  `db_execute` → `db_query`) is 5 passes, so a document flow runs one pass short
  of the cap and deeper workloads should raise the variable.

- **The continuous-audit gates now run on CI.** New `ci.audit.yml` runs
  `npm run test:audit` (462 tests / 26 suites, ~1 s) on every push and pull
  request to `master` and `dev`, and `audit/tests` joins the roots of `npm test`
  so a local full run covers it too. Until now nothing on CI executed them,
  which made T8.3 — the gate that refuses a triage outcome whose promised
  regression test is not "somewhere the suite will really run it" — a rule the
  repository did not keep about its own gates. Deliberately **not**
  path-filtered, unlike `ci.agent-harness.yml`: the contract gates assert
  against the real current source, so a change in `lib/`, `mcp/`, or `db/` can
  turn them red and a filter on `audit/**` would miss exactly the changes they
  exist to catch. Its own workflow rather than a root added to `test:ci`, so
  the audit gates stay out of the product coverage figure and out of the
  unit/integration dashboards, and a failure names itself on the checks list.

- **Continuous audit: a triage gate (T8).** T6 says whether a whole audit wave
  may be believed; this is the layer after it — what a confirmed finding is
  allowed to become. It starts no process, calls no model and no network, and
  touches the working tree in one place only — resolving a finding's file:line
  anchors at the moment of publication, through the same injectable resolver T6
  uses. **T8.1** requires every confirmed
  finding to take exactly one outcome with an owner and a real calendar day, and
  refuses to close a wave with anything still sitting at Confirmed or Candidate.
  Outcomes are counted off the lifecycle *trail*, not off `status`, because
  `status` shows only the last decision written and two merged decisions
  otherwise look like one. **T8.2** blocks a high/critical finding from reaching
  a public issue until its disclosure decision is recorded, then scans the
  cleared summary for secret shapes, assigned credentials (at any length, in any
  quoting — short is what weak credentials are, and the key may be quoted too, so
  a pasted `{"password":"abc"}` is read as the credential it is — and under
  compound key names such as `client_secret=` and `db_password=`, which is how
  they are actually written), HTTP `Authorization` credentials at any scheme and
  any token length — the scheme and the secret are two tokens, so an
  assignment's value stopped at `Basic` and never read the part that logs you in
  — bare JWTs (a summary quotes the token and leaves the header behind, and one
  word is neither a runnable command nor an eight-word run), exploit-payload
  shapes, its own runnable
  reproduction (read through the prompt, bullet, numbered step, or backticks a
  terminal or a markdown file writes it with, so `$ curl …`, `1. curl …`, and a
  bare `curl …` are one line), and
  eight-word verbatim runs out of its own evidence. Keys that are a credential
  in one sentence and ordinary metadata in the next — `token`, `auth`, bare
  `pass` — are filtered by their *value* rather than blocked outright, because
  this repository's own writing is full of the metadata sense (`tokens: 500`,
  `auth: required`, `pass: true`) and a gate that refuses honest text is a gate
  someone switches off. A count or a config word is metadata; `access_token=abc`
  is still the credential, and the exemption never reaches `password=`.
  A command that needs no operand at all is now settled before any rule that
  waits for one: `tcpdump` on its own starts capturing every packet on the wire,
  and every tier waited for an argument that never comes. Two guards, because
  "runs bare" and "is not a word" are different properties — a binary like
  `tcpdump` or `mongosh` needs only the noun forms excluded ("a tcpdump
  capture"), while `reboot`, `shutdown`, and `halt` are ordinary English and are
  read only after a run verb, since "Reboot loops are common" opens a sentence
  exactly the way a command would. A capitalized POSIX runner now has to be
  carrying real shell syntax — a scheme, a flag, an operator — before it counts:
  case folding was meant for the Windows names, which are binaries and never
  words, and "Make /api reject unauthenticated requests" is a recommendation
  while "Curl http://host/admin returns the file" is a working request. Lowercase
  spellings keep every tier they had.
  A never-prose executable followed by one plain word is a whole command on its
  own — `rm uploads` and `sudo reboot` carry no flag, no path, and no number, so
  every shape tier waited for punctuation those lines never contain. Two guards
  keep that from swallowing prose: a determiner or preposition in FRONT of the
  runner means the tool is being named ("the rm command", "written in
  PowerShell"), and a function word after it means the sentence simply continued
  ("runs powershell and never validates"). The prepositions of instrument — via,
  using, with, through — are deliberately not in that list, since they introduce
  a command rather than name a tool. A runner that is also an English word
  (`make`, `curl`, `node`, `java`, `ruby`, `python`) no longer steps over a plain
  word to reach an argument: that hop read "Make sure /api requires
  authentication" as the command `make sure /api` and blocked a summary that
  leaks nothing, and a real invocation of those six announces itself in the very
  next slot.
  A positional operand is now also read as a bare host,
  a dotted quad, or an SSH target, because `curl attacker.example.com` and `ssh
  root@host` carry no shell punctuation at all — no slash, no colon, no port —
  so a summary that shortened the reproduction to its bare host, or wrote the
  line fresh, published a working command with nothing left to catch it. A
  dotted token ending in a data or config suffix stays prose, since
  `config.json` and `example.com` are the same shape and "make config.json the
  source of truth" is a sentence this gate exists to publish.
  Single-token payloads match on word boundaries so a payload of `0`
  cannot make every summary containing "500" unpublishable; punctuated ones keep
  substring matching, where accidental collision does not exist. **T8.3** makes a
  Planned/IssueFiled finding name a concrete test file — restricted to types an
  assertion can actually run in, required to be a repository-relative path (no
  `..` segments, no absolute or home-relative path, no URI scheme) so the
  promised test is somewhere the suite will really run it — `npm run test:audit`
  now hands `audit/tests` to the same `scripts/run-tests.js` collector the rest
  of the suite uses instead of naming each file, so a new audit regression is
  executed without a package.json edit anyone can forget, a nested location the
  root's prefix match already accepted is descended into rather than blessed and
  skipped, and the run exits non-zero rather than report green on an empty file
  list. The collector enumerates in JS, so it also works on the Node 18 floor
  `README.md` documents, where `node --test` does not expand a glob and would
  open the pattern as a literal filename — and deliberately *not* required to
  exist yet,
  since a red regression test that already exists is not red — while
  AcceptedRisk/DocumentationOnly must explain why no test applies.

  `DocumentationOnly` and `IssueFiled` are now part of `schema.js`'s single
  lifecycle graph rather than a private outcome list; the §3.4 stateDiagram
  predates Step 8 and named neither. `IssueFiled` keeps Planned's `-> Fixed`
  edge, because a filed issue is work still owed. Everything else is derived from
  that graph — the five triage outcomes, which of them are code work, and which
  statuses may be exported — so a sixth outcome teaches every gate at once. A
  status is treated as a claim about a journey: the trail is required, validated
  through `slice-execution.js`'s `historyErrors`, and must begin at `Candidate`
  — the graph's only entry point, so a hand-authored `Confirmed -> Planned`
  trail (legal, connected, ending where `status` says) no longer stands in for
  the confirmation that never happened — and every record
  past Candidate is put back through §7's Finding Exit Gate — the new exported
  `confirmationFieldErrors`, which is the pure half of the same check T6 runs
  before it will confirm anything. The record-level schema alone is not enough
  there and was never meant to be: it tests *presence*, so `violatedInvariant:
  "   "` and `line: 0` clear it, and §7's confirmation facts (revision, variants
  weighed, duplicate search, model, tokens) are outside its field list because a
  Candidate legitimately lacks them. Without that reuse, a truncated or
  hand-merged ledger row carrying nothing but an id, a status, a legal history
  and a triage decision earned full coverage credit at closeout, and a forged one
  with a clean `Candidate -> Confirmed` trail could be authorized as a public
  claim without ever having met the evidence gate. Publication additionally
  resolves the anchors against the tree and fails closed if it cannot, because a
  finding anchored at a file since moved or deleted is a stale claim and the
  public issue is the most expensive place to find that out. Rejected stays
  exempt from all of it — T6.2 rejects candidates cheaply on purpose.
  `isBlank`/`isNonBlankString`/`comparableText`/
  `RUNNABLE_COMMAND` moved to `audit/scripts/record-shapes.js` so T6 and T8
  cannot drift on what counts as a real answer or a runnable command.
  `RUNNABLE_COMMAND` matches the Windows runners case-insensitively — they are
  typed and documented with capitals (`PowerShell -EncodedCommand …`, `CMD /c …`,
  `CertUtil -urlcache …`) and each runs exactly as spelled, so a case-sensitive
  match read all three as prose, refusing a real reproduction at T6 and letting
  the same payload through T8.2 on its way to a public issue. The POSIX half
  stays case-sensitive: it is full of English words, and a blanket flag would
  make a sentence's opening capital enough to pass "Make sure the invariant is
  checked" off as a reproduction.

- **Continuous audit: a slice-execution gate (T6).** `audit/scripts/schema.js`
  says whether one finding record is well formed; this is the layer that says
  whether a whole audit wave may be believed. Four pure, injectable checks, none
  of which starts a process or calls a model. **T6.1** holds every slice report
  to Step 6's exit gate and counts a documented deferral as deferred rather than
  complete, so a wave cannot report coverage it does not have; `manifestHash`
  must be the digest `computeManifestHash()` emits, because a manifest identity
  nobody can compare identifies no tree state. **T6.2** stops a candidate
  becoming Confirmed on model agreement — a second model concurring is not
  independent evidence — and holds the evidence itself to the same standard as
  the finding: every anchor is resolved against the audited tree, must point at a
  real line, and must name code the candidate itself claims is affected, so
  `package.json:1` can no longer confirm a provider bug. A reproduction that is a
  command is verified as a command: this module never runs one, so it counts only
  once the record says when it was run and what it produced (a *failing* run is
  the point), or a caller injects its own verifier. **T6.3** enforces §4's
  budget — one primary cloud lens per slice, and any frontier-model use needs a
  recorded human override naming a reason, an approver, and the finding IDs it
  covers. A frontier call mislabeled as a cheap lens is reclassified rather than
  waved through, and reconnaissance keeps its free pass only while nothing in the
  record says the call left the machine: an entry naming a cloud provider is
  budgeted as the cloud call it describes even when it names no model. **T6.4**
  classifies a candidate as Duplicate on a shared invariant *and* a shared
  affected file, keeping "same symptom, different root cause" a distinct linked
  finding. Status transitions delegate to `schema.js`'s `transitionFinding()` so
  the two never keep separate lifecycle graphs, and a status trail must be a path
  through that graph: each entry a real edge, connected to its neighbours, ending
  where the finding actually is.

- **Continuous-audit runs now have a durable usage ledger.** Audit slices can
  append immutable JSONL run records under `audit/ledger/`, and the T3.3
  accounting gate reads that ledger by default. Persistence validates complete
  run records, rejects duplicate IDs, and fails closed on damaged rows. The
  stream-usage mapper preserves cache reads, reasoning, output, and especially
  Anthropic cache-creation tokens; if a cache-writing provider drops that field,
  recording fails instead of silently billing the run as though it wrote zero.

- **The price sheet carries cache-read and cache-write rates.** `lib/pricing.js`
  now reads OpenRouter's `input_cache_read` and `input_cache_write` alongside the
  prompt and completion rates, so `getPricing()` returns `cacheRead` and
  `cacheWrite` in USD per million. Neither can be derived from the input rate —
  a cache read is billed well below it and a cache write above it — which is why
  the usage-accounting gate previously had to report a cached run as an interval
  and a run with cache writes as `unknown`. Both now collapse to an exact cost
  whenever the catalog publishes the rate: a real 120k-token Anthropic run with
  90k cache reads and 20k cache writes prices at a point instead of not at all.
  A rate the catalog does not publish is `null`, never 0 — a zero would claim
  those tokens are free — and the old interval and `unknown` verdicts are still
  what a null produces, so a provider that charges no separate cache rate and a
  pricing cache written by an older build both keep working unchanged.
  `input_cache_write` is the five-minute rate, which is the one Aperio buys:
  `lib/agent/providers/anthropic.js` sets a bare `{ type: "ephemeral" }`
  breakpoint with no `ttl`. Reasoning tokens still get no rate of their own —
  they are a breakdown of the output count on every provider Aperio talks to —
  and the audit gate now pins that as an *absence* invariant, going red the day
  `lib/pricing.js` starts reading OpenRouter's `internal_reasoning` rate.

- **Continuous audit: a usage-accounting gate (T3.3).** `audit/scripts/schema.js`
  validates one run record and stops; this is the layer above it, reconciling many
  records into a cost ledger that never invents a number. Local and subscription
  runs are labeled and left unpriced — the invariant
  `lib/providers/index.js` already states ("No per-token $ estimate should ever be
  shown for these — it would be fiction, not a guide") — a model with no published
  rate reports `unknown` rather than zero, and estimated usage is kept in its own
  column so it can never be mistaken for an actual. Prices come from the real
  `lib/pricing.js`; the gate never warms its OpenRouter cache, so its verdict does
  not depend on a network fetch. When that price sheet publishes no cache-read
  rate for a model, a run served partly from cache reports a cost *interval*
  (cached tokens at 0 → low, at the full input rate → high) instead of a
  fabricated point, and
  reasoning tokens — a breakdown of the output count, not an addition to it — are
  reported but never billed on top. The four source facts that arithmetic rests on
  are pinned as gate markers, including that both WebSocket provider announces
  carry the billing flags: a mid-session switch that re-announces `costRates`
  without them would leave a Claude Code session showing the previous provider's
  dollar figure — and that one is checked per announce payload with no trigger
  condition, because an omitted flag does not reset the display, it keeps the
  previous provider's billing class. The one reviewed exemption (llama.cpp's
  sparse same-provider re-announce) is scoped to that single payload rather than
  to its file, so a second announce added there is still judged on its own and
  the exemption goes red once the announce it was written about is gone. The
  billing classes are checked by
  membership rather than by
  non-emptiness — dropping `claude-code` while `codex` remains would leave every
  Claude Code run reconciled as billable API usage — and the model resolver
  mirrors `getPricing()`'s aliases (dated suffixes included) while refusing to
  price an alias that could name more than one model. Cache *writes* are the one
  class the interval can never cover: they are billed above the base input rate,
  so without a published cache-write rate a run carrying them prices as
  `unknown` rather than as a bound that does not contain the true cost. A
  record that never stated its cache-write count stays `unknown` whatever rates
  exist — a rate with no count prices nothing. A loop whose source cannot be read is assumed to
  report cache writes and named as an error, because the absence of a marker in
  a file nobody could open is not evidence that the marker is gone. Duplicate
  run IDs are rejected before aggregation, so a merged or replayed ledger cannot
  double-count a run — and so is every other rejected record: an invalid row is
  priced, marked `excluded`, and left out of the totals rather than summed under
  its own error message. Totals nest usage
  source first and billing class second, so a planning estimate for a local or
  subscription pass cannot inflate the actual non-API token totals. The
  aggregate obeys the same rule as the rows: a bucket holding an unpriced run
  reports `partial` and a bucket where nothing could be priced reports
  `unknown`, never a dollar figure — the priced rows' interval stays visible
  under `pricedSubsetCost`, which names how many rows it covers. Otherwise the
  common case, a cold pricing cache where every model is unknown, would have
  reported the audit's cost as `$0`.

### Changed

- **The audit run schema gained an address and a usage source.**
  `audit/scripts/schema.js` now requires `runId` as a non-empty string — the
  run's counterpart of a finding's `id`, needed so a ledger of many records can
  say which run it means and reject the same one arriving twice, which only
  works if the address compares by value (two equal objects would be two
  different Set members, and `runId: 0` would be schema-valid yet unaddressable)
  — and accepts an optional, enum-checked
  `usageSource` so the T3.3 accounting layer can keep planning estimates out of
  the actual cost column. `usageSource` is optional because a run record is by
  construction a record of a run that happened: omitting it means
  `provider-reported`.

- **Continuous audit: an MCP tool-registry completeness gate (T2.3).** A file
  in `mcp/tools/` registers its tools against whatever server object it is
  handed, so a module can be complete, tested and reachable through
  `TOOL_PROFILES` while `mcp/index.js` never imports it — and the existing
  coverage test reads the tools directory itself, so it passes on a module the
  real host never wires in. `npm run test:audit` now reconciles the directory,
  `mcp/index.js`'s positional import/registrar/call wiring, and the two tool
  catalogs a tool can live in: the standalone MCP host's, and the in-process
  agent's (the same plus `lib/agent/mcp-connect.js`'s host tools). That
  comparison also gates the two silent resolutions `registerHostTools()`
  performs — a non-override host tool colliding with an MCP name throws
  "Duplicate tool name" at every agent boot, and an override host tool whose
  MCP twin disappears is dropped with a bare `continue`. `index_folder` is the
  one internal-only tool on record, and its exemption is re-checked against the
  real MCP catalog on every run.

- **Continuous audit: a provider contract matrix gate (T2.1).** Six provider
  loops are reached through five stages — `KNOWN_PROVIDERS`,
  `resolveProvider()`, the dispatch ladder in `lib/agent/index.js`, the loop
  module itself, and `AI_PROVIDER`'s options in the config registry — and a
  provider added to one and forgotten in another is not a compile error: an
  unknown name resolves to `not-configured`, and a resolvable name with no
  dispatch branch throws only when a real turn runs. `npm run test:audit` now
  reconciles all five by name and checks that every loop still implements the
  three cross-provider contracts (usage reporting, abort, egress redaction),
  with reviewed exemptions honoured only while their stated reason still holds
  in the code — llama.cpp's redaction exemption is re-checked against
  `isLocalProvider()` on every run.

- **Document-intelligence: a deterministic guard against blending currencies
  in a final answer.** Rewording `SKILL.md`'s "never blend, never convert"
  rule twice was measured, live, to not be enough — a model that got every
  per-currency line right still added a "Grand total" summing BGN and EUR
  into one number. `verifyCurrencyClaims()` now checks the model's own
  final answer after the fact: when a parenthetical breakdown's amounts,
  tagged with two or more different currency codes, arithmetically sum to
  the number in front of it, it appends a correction telling the model (and
  the user) to disregard that total — the same non-blocking pattern already
  used for hallucinated file-deliverable claims.

- **Landing page: the 75 flip-card prompt keys are now translated in all 25
  non-English locales.** `tool_*_prompt`, `team_*`, and `flip_*` keys
  (`docs/locales/*.json`) previously existed only in English and silently fell
  back for every other language; a Bulgarian or German visitor flipping a card
  saw an English prompt regardless of their selected locale. All 25 locale
  files now carry translated values for these keys, verified against
  `en.json`'s key set (0 missing, 376 keys per locale) and the existing
  `locale-drift-sync` test suite.

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

### Security

- **The SQLite database is now created `0600` and repaired to `0600` on open.**
  `.sqlite/aperio.db` holds provider API keys since the settings overlay landed,
  but better-sqlite3 creates the file itself, so the process umask decided its
  mode and shipped installs world-readable at `0644`. The mode is now forced on
  every open — new databases start private, and an existing `0644` file is
  tightened the next time Aperio starts. The database and every sidecar SQLite
  puts beside it (WAL, SHM, journal) carry the same rows and get the same
  treatment, in two passes: everything already on disk the instant
  `new Database()` returns, before anything that can throw — an unclean exit
  leaves 0644 sidecars behind on a pre-existing install, and a boot that dies
  loading sqlite-vec or applying a migration must not leave them readable — then
  again after the migrations, for the sidecars this boot created itself. The
  file is also created `0600` up front rather than chmod-ed afterwards, so there
  is no window in which it exists world-readable — a descriptor another local
  user opened in that window could not be revoked by a later `chmod`. When
  encryption is on, both roots are hardened: the decrypted temp copy Aperio
  opens *and* the encrypted path, whose plaintext WAL/SHM leftovers from an
  unclean pre-fix shutdown nothing else would revisit. The directory Aperio
  creates for the database is made `0700`; a directory that already exists is
  left alone. The encrypt/decrypt file writes got the same treatment, because
  `writeFileSync` silently ignores its `mode` option when the target already
  exists. A missing sidecar and Windows (no POSIX mode bits) are expected and
  stay quiet; any other `chmod` failure — a group-owned database we can write
  but not re-permission — is now logged as a warning rather than swallowed,
  since it means the file stays readable by other users on that machine.

- **Added Subresource Integrity to the CDN assets, and moved Prism off the CDN.**
  The Bootstrap Icons stylesheet and the Mermaid bundle now carry `integrity`
  (sha384) plus `crossorigin` in `index.html`, `setup.html` and
  `codegraph-atlas.html`. Prism could not be fixed the same way: `prism-autoloader`
  injects a script tag per language grammar at runtime and cannot put an
  `integrity` attribute on them, so hashing the autoloader would have verified
  the loader while leaving every grammar it fetches unverified. Prism is instead
  served from the pinned `prismjs@1.29.0` npm package through `/vendor/prismjs/`,
  the same pattern the offline d3 build already uses — the grammar files become
  same-origin and the CDN leaves the script path entirely.

- **A quote in a link URL could inject attributes into rendered chat markdown.**
  `renderMarkdown()` interpolated the href into an anchor raw, so a `"` inside
  the URL closed the attribute and let the rest of the match become attributes on
  the anchor — an inline event handler being the obvious payload, on a string
  written by the model and by tool output. The quote is now encoded. Only the
  quote: `&`, `<` and `>` are already escaped earlier in the same chain, so a
  full escape pass would double-encode the `&` in a query string and break links.

- **`SECURITY.md` now has a "Known limitations" section.** It names, without
  softening, the gaps that remain: the Docker image binds `0.0.0.0` and neither
  Compose file sets `APERIO_AUTH_TOKEN`; `APERIO_AUTH_TOKEN` guards only `/api/*`,
  so an unauthenticated caller can fetch `/`, collect the `aperio_static` cookie
  it hands out, and read `/uploads`, `/scratch` and `/roundtables`; chat markdown
  is escaped by bespoke code rather than a vetted sanitizer; and the icon font
  files fetched by the Bootstrap Icons stylesheet remain outside SRI's reach.

- **Rewrote git history to remove a stale `audit/` tree and old build renders.**
  `master`'s history on GitHub no longer contains `audit/` (superseded findings,
  including one naming an unpatched issue by exact file:line), `manual/preview-output`,
  or `output/pdf` — cutting a fresh clone from ~650 MB to ~62 MB. This is a
  history rewrite: **anyone with an existing clone must re-clone** (`git pull`
  will not work against the new history). Forks and clones made before this
  change still hold the old files — the rewrite only stops new clones from
  receiving them going forward. See `SECURITY.md`.

### Fixed

- **The live document-intelligence llama.cpp harness could silently evaluate a
  model with no tools.** Selecting a model through `LLAMACPP_MODEL` did not add
  it to `APERIO_CAPABLE_MODELS`, so the skill prompt named database/document
  tools while the request carried an empty schema array; local models then
  role-played calls in prose and confabulated results. The harness now
  capability-enables its selected evaluation model before boot, cleans up the
  per-run managed extraction database after shutdown, and the agent log reports
  effective attached schemas separately from the larger pre-gate plan.

- **The idle-shutdown watchdog could kill the server mid-generation on a long
  local-model turn (#454).** The dead-man's switch only reset on the browser
  tab's `/api/heartbeat` ping, with zero visibility into whether a turn was
  actually running — and backgrounded tabs throttle/freeze their own
  `setInterval`, so a legitimate 300-680+ s local-model turn could miss every
  ping and get killed as "idle" out from under the user. `runAgentLoop()`
  (`lib/agent/index.js`) now tracks an in-flight-turn count, exposed via
  `agent.getActiveTurnCount()`; `createWatchdog()`'s `onIdle()`
  (`lib/helpers/shutdownGuard.js`) checks it at fire time via a new `isBusy`
  option and defers (rearming for another full window) instead of tearing
  down while a turn is still active. `IDLE_SHUTDOWN`'s default stays `off`
  (the mitigation already shipped for this issue) pending a live validation
  run of the fix.

- **A MySQL/Postgres connection running the non-default backslash-escaping
  mode could have a valid write wrongly rejected.** `db_execute`'s
  bind-parameter count (`maskLiteralsAndComments()`,
  `lib/db-connect/placeholders.js`) guessed backslash-escaping from the
  engine alone — MySQL on, Postgres off outside `E'...'` strings — which is
  right for the common case but wrong for a server running MySQL's
  `NO_BACKSLASH_ESCAPES` or Postgres's legacy
  `standard_conforming_strings = off`. Connections can now set an optional
  `backslashEscapes` (on/off/default) override in the connection form,
  threaded through `validateBoundParams()` and `countPlaceholders()`; leaving
  it unset keeps the existing engine-guess behavior unchanged.

- **A stranded "extraction" connection reported a misleading error.** When the
  self-provisioned document-extraction database's saved file no longer
  matched the profile's current identity (most often a database connection
  setting changed around an app upgrade), the error said a foreign connection
  "already uses" the reserved name — wrong and confusing when it was actually
  the profile's own earlier row, just no longer recognizable. This case can't
  be auto-recovered (the old identity is gone once the process restarts with
  new settings, and a one-way hash can't be inverted), so it still fails
  closed, but `reservedExtractionNameError()` (`lib/db-connect/extraction.js`)
  now tells the two cases apart and names the real file path so the old data
  can be recovered by hand.

- **A model stuck "thinking" forever could burn an entire turn without ever
  answering or calling a tool.** No existing timeout caught this: the idle-read
  timeout only fires when bytes stop arriving, and a model stuck reasoning stays
  chatty (a token roughly every second), so it never trips. One recorded local
  run spent all 900 seconds of a turn emitting nothing but reasoning tokens — no
  answer, no tool call — until an external test-harness timer killed it.
  `LlamaCppStreamHandler` now tracks how long a turn has been producing
  confirmed reasoning — a native `reasoning`/`reasoning_content` field, or a
  resolved inline `<think>...</think>` block — with no real answer and no
  tool call yet; past `LLAMACPP_THINKING_TIMEOUT_MS` (default 180s, well
  under the observed failure, and anchored to when reasoning actually began
  rather than to connection start, so a long prompt prefill can't eat into
  the budget) it cancels the stream and falls into the existing
  empty-completion retry, which forces thinking off and nudges for a direct
  answer, rather than letting the turn run out the clock unaided. A turn
  that is actually producing output, or reasoning briefly before answering,
  is untouched. Deliberately does NOT cut off a tag-free answer that just
  hasn't finished streaming yet, even past the timeout — that state is
  observably identical to a model stuck reasoning inside an unclosed,
  template-pre-filled `<think>` block with no way to tell the two apart
  mid-stream, and a legitimate slow answer must never be discarded on a
  guess. The budget is a real maximum, not a between-reads sample: it bounds
  how long the loop waits on each read, so reasoning chunks arriving just
  under the idle timeout can no longer stretch a 180s limit to nearly 300s.
  A cutoff falling in the instant when only the first fragment of the
  answer's SSE line has been buffered is held back for up to five seconds,
  so a split `data:` line — routine on this wire — is never mistaken for
  silence and thrown away. Scoped to only the callers that can act on a cutoff:
  `runDeepSeekLoop` shares the same stream handler but has no
  suppressed-thinking retry, so its call site disables the guard entirely
  rather than turn a long legitimate DeepSeek reasoning turn into a bare
  empty-response fallback.

- **A model that kept re-issuing the same tool call could burn an entire turn on
  it and answer nothing.** The same-turn dedup cache already refused to re-run an
  identical call and handed back the earlier result with a "do not call it again"
  note, but nothing stopped the model from asking a fourth, tenth, or
  hundred-and-eighty-eighth time — every provider loop runs until it gets an
  answer, with no step cap, and the existing repeated-call guard only counts
  calls that *fail*. Each repeat still cost a full generation pass, so the only
  backstop was the turn timeout: one recorded local run spent nearly nine minutes
  re-asking for a document manifest it already had, then died with no answer.
  After three identical calls in a row the loop now takes the tools off the
  request for one pass, tells the model why, and refuses to act on a tool call
  leaked in prose — so the turn ends with whatever answer the results already
  support instead of timing out. Distinct calls, a different tool, and the same
  tool with different arguments are all untouched; the counter resets at every
  new user message. The shared repeated-call guard that sits underneath this
  (`tool-safety-middleware.js`) used to only count calls that *fail* — a call
  that kept *succeeding* identically was invisible to it. It now counts either,
  and because every provider routes through the same shared tool wrapper, all
  of them — including `anthropic`/`gemini`, which have no step cap of their
  own — get a bound on a repeated call, success or failure, not just
  llamacpp/deepseek.

- **A repeated tool call on `anthropic`/`gemini` re-ran for real instead of
  being served from cache.** `llamacpp`/`deepseek` already refuse to re-execute
  an identical call within a turn and hand back the earlier result — the
  bounding fix above just stopped the model from asking forever. `anthropic.js`
  and `gemini.js` drive their own dispatch loops outside that shared executor,
  so the same repeated call there still ran for real (wasted work and cost) up
  to two more times before the bound above kicked in. Both now check the
  in-turn cache before dispatching a call, same as the other two providers.

- **The tool-repeat breaker above fired silently — the user just saw the
  assistant stop using tools mid-turn with no explanation.** `llamacpp`/
  `deepseek` now send an amber notice ("`{model}` repeated the same tool call
  `{repeats}`× in a row, so tools were turned off for this reply") to both the
  web UI and the CLI when the breaker trips, translated across all 26 locales.

- **The cost estimate in the context bar billed cached tokens at the full input
  rate.** Every turn re-sends the whole conversation, and on a provider with
  prompt caching most of that prompt is a cache read billed at roughly a tenth
  of the input rate — but the browser only ever knew `in` and `out`, so it
  priced the whole prompt as fresh input. A real 120k-token Anthropic turn with
  90k cache reads and 20k cache writes showed `~$0.29` against a true `$0.138`,
  and the gap widens the longer a conversation runs. The provider announce now
  carries `cacheRead`/`cacheWrite` alongside `in`/`out`, and the cost math
  splits the prompt into its three disjoint classes and bills each at its own
  rate. The token counts were already arriving — the provider loops have been
  putting `cache_read_input_tokens` and `cache_creation_input_tokens` on every
  `stream_end` all along; nothing read them. A provider that does no prompt
  caching reports neither count, and a model whose catalog publishes no cache
  rate falls back to the input rate, so both keep exactly their previous figure.
  Two new audit-gate invariants pin the announce and the arithmetic, next to the
  ones that already pin the billing flags.

- **A local model's tool call silently died with "I tried to use one of my
  tools but couldn't issue the call correctly."** Ornith-1.0-9B-MTP leaks tool
  calls as angle-bracket markup (`<tool_call> <function=db_schema>
  <parameter=connection> aperio </parameter> </function> </tool_call>`) under
  load. The leak was correctly detected and retried, but nothing could parse
  that shape to recover it — every retry reproduced the same unparseable text
  and the call was lost for good. `extractAngleToolCall()` now recovers it,
  the same way an existing bbcode-shaped leak from the same model family
  already was.

- **Foreign-currency travel documents (a train ticket, a hotel bill, an
  airport receipt) had no category at all.** `CATEGORY_RULES`
  (`lib/docgraph/facts/contract.js`) covered Bulgarian and English household
  spending only, so a German train ticket, a German hotel bill and a French
  airport receipt all fell into `Uncategorized` — one of them even mis-scored
  as `Dining` on the word "café" alone. A new `Travel` category with English/
  German/French patterns (ticket, flight, hotel/hôtel, Reise, Fahrkarte,
  Flughafen, Unterkunft, voyage, aéroport) now resolves all three correctly,
  without competing with the existing local-transit-card pattern under
  `Transport`.

- **A failed Node.js, dependency-install, or llama.cpp-engine setup step left
  its own status tile stuck on "running" forever.** Only the model-download
  and SQLite-bindings steps ever marked themselves `error` on failure; the
  other three caught nothing locally, so a failure there was still reported
  (the wizard's overall error event still fired), but the specific tile the
  user was watching never showed which step actually broke. Each of the
  three now follows the same catch → mark-error → rethrow pattern the other
  two already used. Caught by this session's own bootstrap-contract audit
  gate (`audit/scripts/bootstrap-contract.js`), which now reconciles clean.

- **A document naming "café" was never categorized as Dining.** The Dining
  rule's `/\bcafé\b/i` pattern could never match the word "café" itself —
  `\b` treats accented letters as non-word characters, so the trailing
  boundary demanded a word character right after the "é", matching only the
  plural "cafés" instead. Fixed with a Unicode-aware lookahead so "café",
  "Café du Terminal", and "CAFÉ" all resolve to Dining, same as the
  unaccented spelling always did.

- **A watched document folder under macOS's default temp dir was silently
  indexed as zero documents, forever.** `SKIP_DIRS` (`.git`, `node_modules`,
  `trash`, `var`, `coverage`) is meant to skip those folders *within* a
  watched project, but the check tested every segment of the full absolute
  path — so any root resolving under `/private/var/folders/…` false-matched
  on "var" and the whole root was ignored, with no error and no log line.
  Both the initial-scan filter and the live chokidar watcher now check only
  the path segments inside the watched root.

- **A second local-model tool-call leak, distinct from the Ornith one above,
  silently died the same way.** gemma-4-E4B leaks tool calls in a third shape
  — mismatched pipe/angle wrapper tags and every quote rendered as
  llama.cpp's own internal `<|"|>` template marker instead of `"`
  (`<|tool_call>call:doc_search{query:<|"|>Northwind Labs<|"|>}<tool_call|>`).
  Detection already fired; `extractPipeAngleToolCall()` now recovers it by
  swapping the marker back to a real quote and parsing the `call:name{...}`
  body as a JSON-object literal.

- **Setting only `LLAMACPP_PORT` (without also setting `LLAMACPP_BASE_URL`)
  silently broke every chat turn.** The vendored llama-server started
  correctly on the configured port, but the provider that talks to it still
  hardcoded `http://127.0.0.1:8080` as its default, so every request went to
  the wrong port and failed with "the local llama.cpp engine is not
  running." The default now derives from `LLAMACPP_PORT` the same way the
  server-startup code already did, so the two can no longer drift apart.

- **`docker/docker-compose.prod.yml` broke first boot against a fresh
  database.** It mounted `../db/migrations` into Postgres' own
  `/docker-entrypoint-initdb.d`, so a brand-new volume applied the schema
  as raw, unbookkept SQL; the `aperio` service's own migration runner then
  tried to reapply `001_core.sql` on its first request and failed with
  "already exists". The mount is removed — the app already runs migrations
  itself on startup (`db/postgres/store.js`'s `PostgresStore.init()`), the
  same single source of truth the dev Compose file already relied on.
  Verified live against a fresh, isolated volume: all 14 migrations apply
  cleanly on first boot, and a container restart correctly reports nothing
  pending.

- **Windows CI reported the whole test suite green while running zero tests.**
  `package.json`'s `test`/`test:ci` family built its file list with
  `$(find ... -print)` and set `NODE_ENV` via a `VAR=value cmd` prefix — both
  bash syntax that npm's default Windows script-shell (`cmd.exe`) cannot parse.
  On Windows the glob resolved to nothing, `node --test` matched zero files,
  and the step exited in ~1s reporting success instead of running the ~2-3 min,
  5000+ test suite every other platform ran. A new `scripts/run-tests.js`
  resolves the file list and sets `NODE_ENV` in plain JS instead, so the
  scripts behave identically on every platform, and it now refuses to report
  success when it finds zero test files.

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
