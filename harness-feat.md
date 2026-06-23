# Aperio Agent Harness — Feature Blueprint

> Audit date: 2026-06-08
> Status: Stage 2.5–3 of 5. Solid foundations, missing planning and orchestration layers.

---

## 1. What We Have

### Provider Abstraction
Five provider loops behind a uniform interface (`lib/agent/providers/`):

| Provider | Loop | Streaming | Tool calls | Thinking support |
|---|---|---|---|---|
| Anthropic | `anthropic.js` | Native SSE | Native `tool_use` blocks | Via content blocks |
| DeepSeek | `deepseek.js` | OpenAI-compatible SSE | OpenAI `tool_calls` | `thinking_mode` toggle, reasoning field |
| Ollama | `ollama.js` | OpenAI-compatible SSE | OpenAI `tool_calls` | `<think>` tag extraction |
| Gemini | `gemini.js` | Google GenAI SDK | `functionDeclarations` | `thought` flag |
| Claude Code | `claude-code.js` | CLI agent SDK | SDK-managed | Via SDK |

Adding a new provider = one loop file + an entry in `lib/agent/index.js`. The interface is already defined.

### Tool Orchestration (`lib/tools/executor.js`, `lib/agent/index.js`)

- **On-demand loading**: 13 keyword-matched tool profiles (memory, wiki, file-read, file-edit, file-generate, file-project, file-delete, codegraph, shell, web, vision, github, image-gen). The model only sees tools relevant to the current turn.
- **Per-turn failure budget**: 3 consecutive invalid tool calls → loop stops, model is told *it* produced bad JSON, not that "the tools are broken." Categories tracked: `parseArgs`, `postWriteValidation`, `pptxFileMissing`.
- **Post-write validation**: After `write_file`/`edit_file`, the harness parses the output as JS/JSON/XML and rejects syntactically broken files.
- **Hallucination guard**: After the final answer, scans for "I created X.pptx" claims and verifies the file exists on disk. Appends a correction to the conversation if not.
- **Path sandboxing**: All writes go to `var/scratch/<sessionId>/`. Relative reads resolve there first, falling back to the project root. Generated artifacts get web URLs before reaching the model.
- **Tool result summarization**: `toolActivity.js` produces `{ ok, summary }` for every tool call — compact enough for WebSocket frames.

### System Prompt Assembly
Composed per-turn from six sources:
1. Identity files (`id/whoami.md`, `id/capabilities.md`) — cached at boot
2. Character overlay (`id/characters/<name>.md`) — domain expertise
3. Persona overlay (`id/whoami-<persona>.md`) — protocol role
4. Matched skills (keyword-triggered, `lib/workers/skills.js`) — on-demand
5. Session memory snapshot (top-5 preloaded, refreshed on writes)
6. Provider tag + language directive

Per-turn resolution cache avoids recomputing skill matches and tool profiles on every loop iteration within the same turn.

### Reasoning Extraction (`lib/workers/reasoning.js`)
Five adapters handle distinct model families' thinking formats:
- Qwen3 native `reasoning` field + inline `<think>` fallback
- DeepSeek R1 `reasoning_content` in OpenAI format
- Gemini `thought` boolean + inline extraction
- Claude thinking blocks via content block deltas
- Generic `<think>` / `<thinking>` / `<parameter name="thinking">` tag splitter

Each adapter exposes `processDelta(delta, state, emit)` for streaming and `stripReasoning(fullText)` for post-hoc cleanup.

### Context Management (`lib/context/trim.js`)
- Token estimation via `gpt-tokenizer`
- Thresholds: warn at 60% or 80k absolute, handoff at 72% or 120k absolute
- Trimming drops oldest messages while preserving the first (system-context) message
- Orphaned tool results (whose matching `tool_use` was trimmed) are cleaned up
- UI signals: `context_warning`, `context_handoff_suggested`, `context_trimmed`

### Multi-Agent Patterns

**Round-table deliberation** (`lib/workers/roundtable.js`):
- Answerer → Reviewer → Revise → Re-review consensus loop
- `AGREED:` protocol detection with malformed-agreement retry
- Provider error recovery (detects JSON error envelopes in agent replies)
- Full markdown transcript recording to `var/roundtables/`

**Background workers**:
- `deduplicate.js`: Periodic memory dedup (every 10 min)
- `infer.js`: Pattern inference — reads memories, asks LLM for implicit patterns, stores as `inference` type (every 30 min)
- `session-prune.js`: Old session cleanup (daily)

### Memory Layer (`db/`, `mcp/tools/memory.js`)
- Dual backend: SQLite (zero-config, default) or Postgres (Docker)
- Vector embeddings via `sqlite-vec` or `pgvector`
- Full-text search via FTS5
- Hybrid search (semantic + fulltext)
- Point-in-time recall (`as_of`)
- Memory versioning with tombstones
- TTL/expiry support
- Seven memory types: fact, preference, project, decision, solution, source, person, inference

### Skills System (`lib/workers/skills.js`)
- 25+ skills in `skills/` directory
- On-demand loading via keyword matching on recent user messages
- "Always-on" skills loaded every turn
- Dependency declaration (`depends-on` in frontmatter)
- Executable skills (SKILL.md + index.js runner)
- Frontmatter parser for YAML metadata

---

## 2. What's Missing — The Gaps

| # | Capability | Priority | Effort | Notes |
|---|---|---|---|---|
| 1 | **Structured planning loop** | P0 | Low-Med | No ReAct/Plan-Execute-Verify cycle. Agent thinks → calls tools → returns. No plan artifact, no plan-vs-execution diff, no self-critique phase. |
| 2 | **Sub-agent spawning** | P0 | Medium | No `spawnChild(name, prompt, tools)` pattern. Roundtable is the only multi-agent mode, and it's strictly sequential. `createAgent()` already returns fully configured agent objects — this builds on that. |
| 3 | **Observation compression** | P1 | Low | Large tool outputs (full file reads, code searches) are fed back verbatim. No chunking, no relevance filtering, no summarization before model ingestion. |
| 4 | **Agent evaluation harness** | P1 | Medium | `tests/` exists but has no agent-quality metrics — task success rate, tool accuracy, hallucination rate, token efficiency. |
| 5 | **Structured observation format** | P2 | Low | Tool results are raw strings. No canonical `{ ok, summary, full?, metadata }` envelope. The `summarizeResult` in `toolActivity.js` is a starting point. |
| 6 | **Checkpointing / rollback** | P2 | Medium | If a file write corrupts state mid-turn, there's no recovery beyond the failure budget stopping the loop. |
| 7 | **Explicit agent state machine** | P2 | Low | The loop is `while (true)` with no named cognitive states. The `state` object tracks only `thinks`/`noTools`. |
| 8 | **Tool chaining / pipelines** | P3 | Medium | Tools are called one at a time. No way to compose `read_file → parse → write_file` as an atomic pipeline with data flow. |
| 9 | **Memory retrieval strategy** | P3 | Medium | Session memory preload is a simple top-N recall. No relevance scoring, recency weighting, or context-aware retrieval at query time. |

---

## 3. Implementation Roadmap

### Phase 1 — Planning Loop (P0)

**Goal**: Before executing tools, the agent produces a structured plan. The harness validates it against available tools and tracks execution progress.

**Where**: `lib/workers/planning.js` (new), `lib/agent/index.js` (modify `runAgentLoop`)

**What**:
- Add a `planning` phase before the tool-execution loop
- Agent outputs a JSON plan block: `{"steps": [{"tool": "...", "args": {...}, "purpose": "..."}], "reasoning": "..."}`
- Harness validates each step's tool exists and args schema matches
- Execution tracks plan-vs-reality: steps completed, skipped, unexpected
- After all tools run, agent reflects on plan-vs-outcome before final answer

**Why this first**: The reasoning adapter infrastructure already handles structured output from thinking models. Adding a plan extraction/validation layer is ~200 lines and immediately improves reliability on complex tasks.

### Phase 2 — Sub-Agent Spawning (P0)

**Goal**: The agent can spawn child agents for parallel or delegated work.

**Where**: `lib/agent/spawn.js` (new), `lib/agent/index.js` (add spawn API)

**What**:
- `spawnChild({ name, prompt, tools, model? })` — creates a fresh agent instance with a subset of tools
- Returns a promise that resolves to `{ text, toolCalls, usage }`
- Parent can spawn multiple children in parallel via `Promise.all`
- Children run via the same provider loops, same emitter (routed to parent's UI)
- Parent receives structured results and integrates them into the conversation
- WebSocket events tagged with `agent_id` so the UI can show child activity

**Why this second**: `createAgent()` already returns fully configured agent objects. The provider loops are stateless within a turn. Spawning is mostly plumbing — a new `runAgentLoop` invocation with a scoped tool set and a child emitter.

### Phase 3 — Observation Compression (P1)

**Goal**: Large tool results don't bloat context.

**Where**: `lib/context/compress.js` (new), `lib/agent/index.js` (wrap `callTool`)

**What**:
- `compressToolResult(name, result, contextBudget)` function
- File reads: truncate to relevant sections when a query/symbol is provided
- Search results: summarize to "N matches in M files" with key excerpts
- Wiki/wiki_get: return article summary + section headers, full body on demand
- Code graph: already returns structured results — keep as-is
- Compressed results include a `full_result_available: true` flag
- Model can request the full result via a `get_full_result` pseudo-tool

**Why this third**: Context pressure is the #1 cause of degradation on long tasks. This directly extends the existing `summarizeResult` in `toolActivity.js`.

### Phase 4 — Agent Evaluation Harness (P1)

**Goal**: Measure agent quality with reproducible test scenarios.

**Where**: `tests/harness/` (new directory), `package.json` (add `test:harness` script)

**What**:
- Test scenarios: YAML/JSON files defining a task, expected tool sequence, and success criteria
- Runner: executes the agent against each scenario with a given provider
- Metrics: task completion rate, tool-call accuracy, hallucination rate, token efficiency, latency
- Regression mode: run against all providers, compare against baseline
- CI integration: runs on PRs that touch `lib/agent/` or `lib/tools/`

**Why this fourth**: Without measurement, adding planning and sub-agents is shooting in the dark. This gives you regression protection and a feedback loop.

### Phase 5 — Structured Observation Format (P2)

**Goal**: Every tool result has a canonical shape the model can rely on.

**Where**: `lib/tools/result.js` (new), all MCP tool handlers (modify)

**What**:
- Canonical envelope: `{ ok: bool, summary: string, full?: string, metadata: { source: string, tokens: number, cached?: boolean, ... } }`
- The existing `summarizeResult` produces `{ ok, summary }` — extend it
- MCP handlers wrap their output in this envelope
- The agent loop can then decide: feed summary only, feed full, or feed both

### Phase 6+ — Checkpointing, State Machine, Pipelines (P2–P3)

Lower urgency, higher complexity. Tackle after phases 1–5 are stable.

---

## 4. Files to Create / Modify

```
New files:
  lib/workers/planning.js          # Planning loop (Phase 1)
  lib/agent/spawn.js               # Sub-agent spawning (Phase 2)
  lib/context/compress.js          # Observation compression (Phase 3)
  lib/tools/result.js              # Structured observation format (Phase 5)
  tests/harness/                   # Agent evaluation (Phase 4)
  tests/harness/scenarios/         # Test scenarios
  tests/harness/runner.js          # Harness runner

Modified files:
  lib/agent/index.js               # Add planning, spawn, compress hooks
  lib/tools/executor.js            # Structured result envelope
  lib/context/trim.js              # Compression budget awareness
  mcp/tools/*.js                   # Structured result format (Phase 5)
  package.json                     # test:harness script
  lib/emitters/wsEmitter.js        # Child agent event routing (already tagged)
```

---

## 5. Design Principles

1. **Build on what exists.** The provider loops, tool executor, reasoning adapters, and agent factory are already clean abstractions. Don't rewrite them — extend them.

2. **Provider-agnostic.** Every new feature must work across all five providers. If a provider can't support a feature (e.g., no native thinking), fall back gracefully.

3. **Observable.** Every new behavior must emit WebSocket events so the UI can render it. The emitter infrastructure (`wsEmitter.js`) is already tagged for multi-agent routing.

4. **Measurable.** Every new feature must have corresponding test scenarios in the harness. No unmeasured capability claims.

5. **Fail-safe.** The harness must never produce a worse outcome than the current single-agent loop. If planning fails or a child agent errors, fall back to the existing behavior.

---

## 6. Success Criteria

- **Phase 1**: Agent completes a 5-tool task (read → analyze → write → verify → report) with 0 incorrect tool calls, vs. 1–2 without planning.
- **Phase 2**: Agent spawns 3 children to read 3 files in parallel, integrates results in <50% of the sequential time.
- **Phase 3**: Context usage on a 20-turn session stays under 60% with compression on, vs. 85%+ without.
- **Phase 4**: Harness catches a regression where a provider loop change breaks tool-call formatting, before it reaches users.
- **Phase 5**: Model hallucination rate on file-write claims drops from current baseline (measured in Phase 4).

---

*Generated from the 2026-06-08 architecture audit of `lib/agent/`, `lib/tools/`, `lib/workers/`, `lib/context/`, `lib/providers/`, and `mcp/`.*
