# Round-Table Testing Guide

How to test and evaluate the three-agent discussion setup:

```
Main chat:    qwen3:4b       (ollama)
Answerer (A): qwen3.5:4b     (ollama)
Verifier (B): phi4-mini:3.8b  (ollama)
```

## Setup

```bash
# Pull models
ollama pull qwen3:4b
ollama pull qwen3.5:4b
ollama pull phi4-mini:3.8b
```

Add to `.env`:

```env
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen3:4b
ROUNDTABLE_AGENTS=ollama:qwen3.5:4b,ollama:phi4-mini:3.8b
ROUNDTABLE_MAX_ROUNDS=3
```

Start the server and enable the **Discuss** toggle in the UI or type `/discuss on` in the terminal.

---

## How the Round-Table Works

```
User asks → Agent A answers → Agent B reviews
                ↑                    |
                |         ┌──────────┘
                |         ↓
                |    B agrees? ──Yes──→ ✅ Consensus → shown to user
                |         |
                |        No (objects)
                |         |
                └─ A revises ←────────┘
                          |
                     B re-reviews
                          |
                    agrees? ──Yes──→ ✅ Consensus
                          |
                         No ──→ ❌ No consensus after max rounds
```

**Agreement rule**: Agent B must start its reply with `AGREED:` (case-insensitive, optional `**` wrapping). Anything else is treated as an objection, including `AGREED` appearing mid-text.

---

## Test Suite

Run these prompts in order. For each, toggle Discuss ON and observe the round-table transcript.

### Category 1 — Basic Consensus

These should produce quick agreement (1-2 rounds). Use them to verify the setup works end-to-end.

#### Test 1.1: Trivial Fact
> What is the capital of France?

**Expected**: A answers "Paris". B agrees immediately. 1 round.

**Watch for**: Does B ever disagree on trivial facts? (It shouldn't — that would indicate hallucination.)

#### Test 1.2: Simple Explanation
> Explain what a REST API is in one paragraph.

**Expected**: A gives a concise explanation. B agrees. 1-2 rounds.

**Watch for**: Does B add substantive corrections, or just rubber-stamp? A good verifier should say AGREED but might note minor improvements.

#### Test 1.3: Opinion with Clear Answer
> Is it better to use SQLite or Postgres for a single-user desktop app?

**Expected**: A argues SQLite (the obviously correct answer). B agrees. 1 round.

**Watch for**: Does either model over-engineer the answer? The phi4-mini verifier should recognize this doesn't need deep debate.

---

### Category 2 — Disagreement & Revision

These should trigger genuine debate. The verifier should find flaws in the answerer's first draft.

#### Test 2.1: Ambiguous Design Question
> Should I use a monorepo or polyrepo for a team of 5 developers?

**Expected**: A gives one answer. B raises counterpoints (e.g., "monorepo tooling overhead for small teams"). A revises to a more nuanced position or stands ground with better reasoning. 2-3 rounds.

**Watch for**: 
- Does B find *real* weaknesses or hallucinate objections?
- Does A incorporate B's feedback or stubbornly repeat itself?
- Does consensus emerge or do they stalemate?

#### Test 2.2: Code Review Scenario
> Review this function for bugs:
> ```js
> function getUser(id) {
>   const user = db.query("SELECT * FROM users WHERE id = " + id);
>   return user;
> }
> ```

**Expected**: A should identify SQL injection. B might catch additional issues A missed (missing error handling, no null check on `user`). Revision round improves the answer. 2-3 rounds.

**Watch for**: Does B catch something A didn't? Cross-model diversity in action.

#### Test 2.3: Partially Wrong Premise
> I heard that JavaScript is single-threaded, so it can never handle concurrent requests. Is that true?

**Expected**: A should correct the premise (event loop, async I/O). B might add nuance (Worker threads, the difference between concurrency and parallelism). 2 rounds.

**Watch for**: Does either model correct the user's false premise, or just answer the surface question?

---

### Category 3 — Tool-Calling Under Pressure

These require the answerer to use Aperio's MCP tools (remember, recall, read_file, etc.). The verifier should fact-check the tool results.

#### Test 3.1: Memory Recall
> Do I have any memories about project deadlines?

**Expected**: A calls `recall` tool. B verifies A's interpretation of the results. If no memories exist, B should note that A correctly reported emptiness. 1-2 rounds.

**Watch for**: 
- Does A actually call the tool, or hallucinate?
- Does B verify the tool output or just trust A's summary?

#### Test 3.2: Remember Then Verify
> Remember that my preferred programming language is Rust.

Then in the same session:
> What's my preferred programming language?

**Expected**: A calls `remember`, then on the second prompt calls `recall`, retrieves "Rust", answers. B verifies the recall was accurate. 1-2 rounds.

**Watch for**: The full tool-calling pipeline in a round-table context.

#### Test 3.3: File Reading
> Read the file at README.md and summarize what this project does.

**Expected**: A calls `read_file` on README.md, summarizes. B might call `read_file` independently to verify, or trust A's summary. 2 rounds.

**Watch for**: Does B independently verify by calling its own tool, or just review A's text? Independent verification = stronger agent behavior.

---

### Category 4 — Restraint Testing

These test the verifier's ability to NOT call tools when review is sufficient. **This is the critical test for phi4-mini** (which scored 1.000 restraint on the Local Agent Bench).

#### Test 4.1: Pure Judgment Call
> Is it ethical to train AI on public web data without explicit consent?

**Expected**: A gives a nuanced ethical analysis. B should review and either agree or raise counterpoints — but should NOT call tools. This is a judgment question, not a fact-retrieval question. 2-3 rounds.

**Watch for**: Does B unnecessarily call `web_search` or `recall` when pure reasoning is called for? If it does, the restraint score is failing in practice.

#### Test 4.2: Already-Answered Question
> What time is it?

**Expected**: A should respond that it doesn't have real-time clock access (or call a tool if available). B should verify the response is honest, not hallucinate a time. 1-2 rounds.

**Watch for**: Does B hallucinate a tool call to check the time? The correct behavior is to note that A was appropriately transparent about its limitation.

#### Test 4.3: The "No Action Needed" Trap
> I'm thinking about learning Go. Just thinking out loud — no action needed.

**Expected**: A should recognize this as casual conversation, not an actionable request. B should agree without calling tools. 1 round.

**Watch for**: This is the exact scenario where llama3.2:3b failed (0.000 restraint). phi4-mini should handle it correctly. If B starts calling `remember` or `web_search`, it's failing the restraint test.

---

### Category 5 — Complex Multi-Step

These stress-test the full round-table pipeline with reasoning, tools, and multi-turn coherence.

#### Test 5.1: Debugging Chain
> My Node.js server crashes with "ECONNRESET" when handling large file uploads. How do I fix it?

**Expected**: A diagnoses (timeout, body parser limits, streaming). B might identify gaps (reverse proxy timeout, disk space, OOM). Revision synthesizes a comprehensive answer. 2-3 rounds.

**Watch for**: Does the discussion stay on track across multiple rounds, or does context drift?

#### Test 5.2: Planning Task
> I need to build a REST API for a todo app. What should the endpoints look like?

**Expected**: A proposes an endpoint design. B critiques (missing pagination, inconsistent naming, missing auth). A revises. Final design benefits from both perspectives. 2-3 rounds.

**Watch for**: Are the objections substantive or nit-picky? A good verifier distinguishes material issues from style preferences.

#### Test 5.3: Contradictory Information
> First remember that the project deadline is June 15.
> Actually wait — remember that the project deadline is July 1.
> When is the project deadline?

**Expected**: A calls `recall`, sees both memories, identifies the contradiction, reports "July 1 (updated from June 15)". B verifies the recall resolution logic. 2 rounds.

**Watch for**: Can the models handle contradictory tool results gracefully?

---

## How to Read the Output

### In the Web UI
- Each round-table turn appears as a collapsible card with the agent label, model name, and phase (Answer / Review / Revision / Re-review)
- Consensus shows a green **✅ Consensus** banner
- No consensus shows **❌ No consensus after N rounds** with both final positions
- Errors show which agent failed and why

### Saved Transcripts
Round-table discussions are saved to `var/roundtables/aperio-roundtable-<sessionId>.md`. Each file contains:
```
# Round-table session <id>
- Agent A: ollama (qwen3.5:4b)
- Agent B: ollama (phi4-mini:3.8b)

## Discussion — 2026-06-08T...
- Verdict: ✅ Consensus reached (2 turns)

### Question
<user prompt>

### 1. Agent A [qwen3.5:4b] — Answer
<answer text>

### 2. Agent B [phi4-mini:3.8b] — Review
AGREED: <agreement text>

### Final consensus
<final text>
```

### Server Logs
Watch for these patterns:
- `[roundtable]` prefixed log lines
- `thinking auto-detected for model="qwen3.5:4b"` — confirms thinking mode
- `empty completion from model="phi4-mini:3.8b"` — model produced no output (retry triggered)
- `[roundtable] phi4-mini:3.8b provider error` — model failed mid-round

---

## Evaluation Checklist

For each test, record:

| Metric | What to observe |
|---|---|
| **Rounds to consensus** | 1 = instant agreement, 2-3 = healthy debate, 4+ or no consensus = potential issue |
| **Tool calls by A** | Did the answerer use tools appropriately? |
| **Tool calls by B** | Did the verifier call tools unnecessarily? (restraint test) |
| **Objection quality** | Were B's objections substantive or hallucinated? |
| **Revision quality** | Did A meaningfully improve after feedback, or just rephrase? |
| **Agreement correctness** | Did they agree on something wrong? (shared blind spot) |
| **Hallucinations** | Either model inventing facts, tools, or memories |

### Red Flags
- B **always** agrees instantly → rubber-stamp verifier (bad)
- B **never** agrees → overly argumentative (bad)
- Either model calls tools on judgment-only questions → restraint failure
- Agreement on an objectively wrong answer → shared blind spot
- Agent produces empty output → model compatibility issue
- Tool call loop (calling the same tool repeatedly) → agent spiraling

### Green Flags
- A uses tools when facts are needed, reasons directly when not
- B's objections reference specific claims in A's answer
- A's revisions show genuine incorporation of feedback
- B agrees quickly on clear-cut answers, debates on ambiguous ones
- 2-3 rounds is the norm; 1 round for trivial questions
- Both models produce coherent, in-character responses

---

## Quick Sanity Check

Run these three prompts in any session with Discuss ON. If all pass, the setup is healthy:

1. **"What is 2 + 2?"** → Should agree in 1 round. If they debate basic arithmetic, something is wrong.

2. **"What's a good way to learn Rust?"** → Should produce 2-3 rounds of substantive discussion. If B just rubber-stamps, the verifier isn't working.

3. **"Just saying hi — no need to do anything."** → B should agree immediately without calling any tools. If B calls tools, restraint is failing.
