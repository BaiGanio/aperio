# Aperio v2 — Lessons Ledger

Safety net 3 of 3 (see `aperio-v2.md` → "How we do not forget anything").
Every hard-won trap from v1 lives here as **one line plus its source**.

Created 2026-11-01 (step **S0.4**). Test group: **T0.4**.

**Sources swept:** `id/reference/tech-debt.md` (every open `##` item + the Intentional-deferrals
and Investigated-and-rejected tables, at `archive/v1-final`) · all 9 `feedback_*` Claude memory
notes · the project memory notes with technical findings · `CHANGELOG.md` · `trash/plans/aperio-reset/`.

**How to use it:** before any Phase 2 / Phase 3 step, read the rows whose *Area* matches.
Port protocol rule 5 ("bring the lesson") points here.

**Columns:** `Plan link` names the matching trap (TR*) or anti-pattern (AP*) row in `aperio-v2.md`
when one exists — the plan says *what to do*, this ledger says *where it came from*.

---

## P — Process lessons (how we work)

Source: the `feedback_*` memory notes. These are about the developer's working rules,
not about Aperio's code. They apply from day one of v2.

| ID | Lesson | Plan link | Source |
|---|---|---|---|
| L-P01 | Never integrate a new visual unseen. Standalone HTML preview → developer approves → then integrate. Subtle tweaks do not count; a change must be obviously visible. | Phase 3 rule | `feedback_preview_before_integrating_visuals` (WebGL galaxy shader revert, 2026-07-04) |
| L-P02 | No casual server / MCP / worker runs for diagnosis — read the code. A real run must use a throwaway workdir, a scratch DB and a non-default port, and must leave no state in the repo tree. | — | `feedback_no_side_effect_processes` (stray `sqlite/` folder incident; rule softened 2026-07-13) |
| L-P03 | Set scratch env vars **before** the dynamic `import(...)`, never after. A module-level `const X = process.env.FOO \|\| default` freezes at import time; setting it later silently hits the real DB. | TR15 · AP1 | `feedback_scratch_env_vars_before_import` (#287 incident: 5 vec0 tables dropped in the real dev DB) |
| L-P04 | Never `git checkout -b` unless asked. Commit on the branch already checked out, even `master`. | TR7 | `feedback_no_unrequested_branches` (2026-08-13) |
| L-P05 | Never `git stash pop` unconditionally after `git stash push -- <path>`. With only untracked files the push fails (needs `-u`) and the pop then takes another session's stash. | TR7 | `feedback_git_stash_pathspec_safety` (near-miss 2026-07-30) |
| L-P06 | Never delete `.env` files or anything in the Trash folder. Hard rule, no exceptions. | — | `feedback_never_delete_env_or_trash` (a `.env` with no backup was lost in a past cleanup) |
| L-P07 | A resolved tech-debt or A2D entry is **deleted**, never annotated with "Fixed YYYY-MM-DD". Permanent facts go to the Intentional-deferrals table. | — | `feedback_tech_debt_delete_not_annotate` (4 recurrences by 2026-08-22) |
| L-P08 | Verify a code-review finding against the real code and tests before applying its fix — especially when it contradicts evidence already in hand. | — | `feedback_verify_review_findings_empirically` (a false WS3 round-4 finding, 2026-08-02) |
| L-P09 | A hardcoded `name:` on a docker-compose volume beats `-p <project>` isolation, so a test stack can reattach to real data. | — | `feedback_docker_compose_volume_isolation` (near-miss on `aperio_data`, 2026-08-17) |
| L-P10 | Assume concurrent sessions in the same repo. One worktree per session, commit only your own files. | TR7 | `AGENTS.md` Co-pilot Contract; many v1 incidents |

## C — Code lessons (v1 open code depth)

Source: every open `##` item in `id/reference/tech-debt.md` at the tag. Each row says whether v2
inherits the problem, and where it is answered.

| ID | Lesson | v2 answer | Plan link | Source |
|---|---|---|---|---|
| L-C01 | A write loop that does not yield freezes the whole server; the fix (yielding) then makes a mid-rebuild read see a thin file. Both halves are real — you trade a 3-second freeze for a momentarily incomplete read. Do **not** "fix" it with a transaction across the yields: better-sqlite3 transactions must be synchronous. | Indexing is a `later` feature. When code/doc graph returns, the yield + accepted-window design returns with it. | — | tech-debt "Indexing shares the server's event loop" + Intentional-deferrals row 3 |
| L-C02 | A mandated verify-first test suite that is only written down never gets built. If a guard cannot be automated in CI, it is a risk, not a guard. | AP1–AP9 each have a CI guard, planted-violation tested in **T1.3**. | AP1–AP9 | tech-debt "Continuous-audit program …" |
| L-C03 | `AgentSpec` filesystem / memory scoping was validated but never enforced at execution time — a declared scope that nothing checks is theatre. | AgentSpec is `never`. The one real gate is `gatedRead` / `gatedWrite` at the file edge (S2.9), enforced at use, not at declaration. | AP3 | tech-debt "Agent permissions — AgentSpec … not enforced" |
| L-C04 | A malformed tool call the model is never told how to fix turns into a retry loop. The error must name the exact wrong field and the right shape. | S2.5/S2.8: a bad tool call returns a pointed repair hint, and bad JSON is reported, never swallowed as `{}`. | TR13 | tech-debt "db_execute — a malformed call the model is never told how to fix"; "Db-connect — placeholder validation" |
| L-C05 | Placeholder rules differ per SQL engine and were verified live against each driver. Re-verify against the real driver before changing any of them. | Databases are `later`. The rule travels with that feature. | — | tech-debt "Db-connect — placeholder validation (db_execute)"; `project_db_execute_param_validation` |
| L-C06 | An interactive command loop with zero test coverage is where regressions hide. | Terminal CLI is `later`; it returns only with tests. | — | tech-debt "Terminal standalone mode — zero test coverage" |
| L-C07 | A moderate npm advisory with no non-breaking upstream fix will sit open. Keep the dependency list tiny so the audit gate stays cheap. | v2 starts near-empty; CI runs `npm audit` from S1.3. | — | tech-debt "npm audit — two moderate advisories" |
| L-C08 | `tree-sitter` is pinned at `^0.24.7` (ABI 14). Do not upgrade until `tree-sitter-wasms` ships ABI-15 grammars. | Code graph is `later`; the pin travels with it. | — | tech-debt Intentional-deferrals row 2 |
| L-C09 | `run_node_script` / `run_python_script` are registered unconditionally and are not confirmable, so a turn can write a `.js` file and run it with `APERIO_ENABLE_SHELL` unset. This is a **documented decision** (`SECURITY.md:41-79`), not a gap. Issue #456's gate was superseded by commit `1d1b4ccb` — do not re-implement it. | Shell is `later`. If it returns, the posture is re-decided from scratch, with no script runner in the default profile. | — | tech-debt Intentional-deferrals row 4; `project_public_launch_2026_09_01` |
| L-C10 | A one-way hash cannot be inverted: an identity derived from a connection string is gone the moment the string changes. Fail closed and name the stranded file. | Databases are `later`. | — | tech-debt Intentional-deferrals row 5 |
| L-C11 | Helmet CSP is enforced by default; `APERIO_CSP=report` exists only for rollout diagnostics. No inline styles. | Phase 3: design tokens + per-component CSS, no inline styles. | — | tech-debt Intentional-deferrals row 1 |
| L-C12 | Memory compaction by deterministic filler-phrase rewriting saves **0.00%** on real Aperio memory content, confirmed two ways. Do not retry it unless memory content becomes long-form. | Not built. | — | tech-debt Investigated-and-rejected; `project_memory_compaction_epic` (#286) |
| L-C13 | `forget` left orphan rows in `vec_memories` — deleting a row must delete its vector in the same operation. | **T2.3** has this exact case as a required test. | — | `project_orchestration_review`; `project_demo_recording` (found 2026-07-03, fixed 2026-07-09) |
| L-C14 | Two files with the same basename (`server.js` and `lib/server.js`) cost real debugging time. | AP9 guard. | AP9 | `trash/audits/anti-patterns-2026-10-30.md` |
| L-C15 | A `Buffer` does not survive `structuredClone` to a worker — it arrives as a plain `Uint8Array`. | Any worker boundary in v2 converts explicitly and has a test. | — | `project_aperio_reset_2026_10_22` |
| L-C16 | `p95` hides freezes. Report the **max** turn latency and event-loop lag too. | TR12; measured in **T2.1**. | TR12 | `project_aperio_reset_2026_10_22` |
| L-C17 | Storing an embedding signature per row is the only way to notice a model change; mixed vectors from two models silently ruin recall. | S2.4 + **T2.4**. | TR19 | `project_embedding_signature` (#287) |
| L-C18 | The keychain lookup needs the `-A` flag, or the DB-encrypt prompt repeats forever. | Encryption is not in core. If it returns, the flag returns with it. | — | `project_config_precedence_and_keychain` (#180) |
| L-C19 | A PowerShell installer with `$ErrorActionPreference = "Stop"` aborts on benign npm stderr. | TR4: install smoke on all three OSes from Phase 1. | TR4 | `project_vm_install_testing` |
| L-C20 | Windows ARM64 has no prebuilt `sqlite-vec`; the vector sidecars must degrade to ordinary tables and recall must still serve full-text results. | S2.3 keeps the fallback. Issue **#528** path cases land in **T2.9**. | TR4 | `FEATURES.md` → Storage; issue #528 |
| L-C21 | A check-then-use path gate has a TOCTOU window — a symlink swapped between the check and the open defeats it. | S2.9: `gatedRead` / `gatedWrite` resolve and open in one step. **T2.9** swaps a symlink mid-flight. | AP3 | `trash/audits/anti-patterns-2026-10-30.md`; `lib/routes/paths.js` |
| L-C22 | Import order is a security boundary: an MCP shell-toggle check placed after an import was bypassable. | AP1 + a lint rule; config is read through a function. | AP1 · TR15 | `project_embedding_signature` review round 4 |
| L-C23 | A docgraph → memory bridge raced on delete / sweep / reindex and left orphans. | Doc intelligence is `later`; issue **#532** stays open with the label. | — | issue #532; tech-debt |
| L-C24 | `scripts/release-bump.js` cannot cut a major version — "major bumps are not automated". | TR5: v1.0.0 is cut by hand at S4.3, as the one written exception to "never bump `package.json`". | TR5 | `scripts/release-bump.js` at the tag |

## M — Model lessons (small local models)

Source: the project memory notes about llama.cpp, Ollama and the capability work. These are the
reason v2 exists, so every one of them is already a trap row or a test case.

| ID | Lesson | v2 answer | Plan link | Source |
|---|---|---|---|---|
| L-M01 | A weak model treats a 5-row memory preload as "everything there is" and never asks for more. Frame recalled rows as a **preview**, not the whole store. | S2.6 framing + **T2.6**. | — | `project_recall_not_invoked` (QWEN3, 2026-06-08) |
| L-M02 | A weak model will not call a recall tool reliably. Code must do the recall. | The one rule of the whole plan: code does the memory work. | — | `project_recall_not_invoked` |
| L-M03 | Auto-recall in the system prompt breaks the llama.cpp prompt cache — the prefix changes every turn and the whole prompt is reprocessed. Put recall **after** the stable prefix. | TR9; byte-for-byte stable-prefix test in **T2.6**. | TR9 · rule 7 | `project_prompt_cache_hygiene`; `project_llamacpp_multiturn_latency`; issue #570 |
| L-M04 | The tool-schema prefix must stay byte-identical between turns, or KV reuse is lost. | Port protocol rule 7. Issue **#570** becomes AGENTS rule 7. | rule 7 | issue #570 |
| L-M05 | gemma-4-E4B leaks tool calls in a **pipe-delimited** shape; Ornith-1.0-9B leaks them in an **angle-bracket** shape. Both need their own parser case. | S2.5 ports the v1 `llamacpp.js` tests; each quirk is a named case. | TR13 | tech-debt "gemma-4-E4B tool-call leakage — pipe-delimited shape, distinct from the Ornith angle-bracket fix" and "Ornith tool-call leakage — angle-bracket shape unparsed" |
| L-M06 | Ornith-1.0-9B-MTP falls into a same-call repetition loop — the real blocker after both leak fixes. | S2.5 needs a repetition break; the v1 `repeated-call-break` scenarios are ported. | TR13 | tech-debt "Ornith … same-call repetition loop" |
| L-M07 | gemma returns empty completions and needs a retry; Ollama `/v1` ignores `think:false` (use `reasoning_effort:none`); qwen3 leaks inline `<think>`. | Named test cases in S2.5. | TR13 | `project_ollama_thinking_quirks` |
| L-M08 | `OLLAMA_NUM_CTX` over `/v1` only drives trim math, not the server KV cache. The launcher must pass the real context length to the server. | S2.5 launcher sizes context from the GGUF header. | — | `project_ollama_num_ctx` |
| L-M09 | KV-cache size per token from a GGUF header can be far off for hybrid-SSM models (qwen3.5 header says 128KB, real is likely 4×+). Measure the real `llama-server` KV buffers before lowering a limit. | S2.5: measure, do not trust the header alone. | — | `project_ctx_sizing_kv_facts` |
| L-M10 | Tuning against a small fixture set overfits it. Keep a holdout set that is never used for tuning, and report train **and** holdout. | TR10; **T2.1**. | TR10 | `project_skill_autotune` (baseline train 0.73 / holdout 0.5) |
| L-M11 | One run of a 4–9B model proves nothing. Run each case N times (start 5), fixed seed where possible, report mean and spread. | TR11; **T2.1**. | TR11 | `project_skill_autotune`; `project_model_capability_map` |
| L-M12 | "Capability gap" was usually a **wiring** gap, not a model ceiling. Check the wiring before blaming the model. | Every `later` feature re-measures at the return gate. | TR? | `project_provider_ux_parity`; `project_capability_gate_doctrine` |
| L-M13 | Capability gating by model name was the wrong answer and is superseded — assume the model is capable and measure. What survives is the neutral-vs-crutch distinction and the capability-holdout rule. | No gates, no scaffold in v2. | — | `project_capability_gate_doctrine` (superseded 2026-07-11) |
| L-M14 | A diagnostic can produce a false "no tool use" positive; the v1 harness has the regression test for it. | Ported with the S2.1 harness. | — | `project_db_execute_param_validation`; `tests/harness/no-tool-use-diagnostic.test.js` |
| L-M15 | Prompt routing **is** tool routing — the prompt that picks a tool and the tool list must be designed together. | ≤ 6 tools per turn (rule 7); 5 core tools only (S2.8). | rule 7 | `project_demo_recording` |
| L-M16 | An allowlist leak across an eval run invalidates the result. Isolate each eval run's allowed paths. | **T2.1** runs isolated. | — | `project_demo_recording` |
| L-M17 | `load: never` on a skill was not actually enforced. A declared skill rule needs a test. | S2.10 measures each skill on and off. | — | `project_exam_harness` |
| L-M18 | Per-turn tool-schema re-send is **not** duplication and is not worth "fixing"; the greeting memory preload was the real waste and was dropped. | Auto-recall is budgeted per turn (S2.6), not preloaded. | TR14 | `project_token_audit` |
| L-M19 | A model-graded harness is only as good as its grader: the doc-intelligence grader never reached a level anyone trusted, and the gate was accepted on **mechanism conformance**, not realistic usage. Say out loud which rung a pass means. | Doc intelligence is `later`. The S2.1 eval grades deterministically, never by model judgement. | TR10 | tech-debt "Document-intelligence harness — grader (#250)" and "Document-intelligence gate — gemma4-E4B model behaviour (#250)"; `project_doc_intelligence_epic` |
| L-M20 | A small model fails differently on a **cold start** (no example to copy) than on a warm one, and its save/insert mechanics drift from its own plan. Test the cold path on purpose. | Doc intelligence is `later`. Auto-capture (S2.7) tests the cold path. | — | tech-debt "Document Intelligence — cold-start template proposals (#250)" and "Document Intelligence — save/insert mechanics on gemma4 (#250)" |

---

## Open questions carried into v2

| # | Question | Where it is answered |
|---|---|---|
| Q1 | Does a small model actually do better **with** self-memory? | A test at the return gate. Until then self-memory is `parked`. |
| Q2 | What is the real KV size per token for a hybrid-SSM model? | Measure `llama-server` buffers at S2.5 (L-M09). |
| Q3 | Can v2 auto-recall beat the v1 baseline on both test models? | **T2.6**. If not, we learn why before going on. |
