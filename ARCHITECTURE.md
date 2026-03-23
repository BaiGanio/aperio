# Aperio — Architecture & Design Decisions

> *"Any fool can build a complex system. It takes a genius to build a simple one."*

- probably someone who struggled with Kubernetes. He-he ;/

This document explains the **why** behind Aperio's design — the choices made, the alternatives considered, and the deliberate constraints accepted. 
- Code tells you *what* a system does. 
- This tells you *why it does the way it does*.

---

## The Core Thesis

Most AI memory layers are platforms. Aperio is a tool.

That's not a limitation — it's the point. A platform optimises for feature completeness, multi-tenancy, and enterprise sales. A tool optimises for clarity, ownership, and the ability to read the entire codebase in an afternoon. Aperio makes a deliberate bet: **an engineer who understands every line of their memory system will build better AI applications than one who treats memory as a black box API.**

Seven dependencies. One Docker container. Zero external API keys required. Your data stays where you put it.

---

## Why MCP Instead of a REST API

The Model Context Protocol is not just a transport — it's a **lingua franca for AI tool use**. When Aperio exposes its tools over MCP, any MCP-compatible model can use them without glue code. OpenAI, Anthropic, Google, and most major inference providers have adopted the protocol. Building against MCP today means Aperio works with the AI ecosystem of tomorrow, not just the one that existed when it was written.

A REST API would have been faster to build. It also would have required a custom integration for every model provider, a separate SDK, and an authentication layer. MCP gives you all of that for free, plus a standardised tool schema that models already know how to reason about.

The philosophical point: **protocols age better than APIs**. HTTP outlasted SOAP. TCP outlasted everything. MCP is a protocol, not a vendor's API surface.

---

## Why PostgreSQL + pgvector Instead of a Dedicated Vector Database

Dedicated vector databases (Pinecone, Weaviate, Qdrant) are excellent products solving a real problem. They are also *additional infrastructure* — another service to run, monitor, back up, and reason about operationally.

Aperio's insight is that for single-user workloads, the vector index is a **feature of the database**, not the database itself. pgvector gives you:

- Semantic similarity search alongside relational queries in a single transaction
- Full SQL expressiveness — filter by type, tags, importance, expiry date, *and* vector proximity, all in one query
- One backup target, one connection string, one mental model

The moment you reach millions of vectors or need sub-millisecond latency at scale, a dedicated vector database is the right call. Aperio is not targeting that use case, and pretending otherwise would be dishonest.

### Why HNSW over IVFFlat

pgvector supports two index types. The choice matters:

**IVFFlat** partitions vectors into clusters at build time. It is fast to query but requires a training phase (`VACUUM ANALYZE`), and recall degrades if the cluster structure doesn't match query distribution. It also needs a meaningful number of vectors before the index is useful — building it on an empty table is pointless.

**HNSW** (Hierarchical Navigable Small World) builds a navigable graph incrementally. No training phase. No minimum vector count. Every insert immediately improves the graph. Recall is consistently high across workloads.

For a personal memory store where the collection starts empty and grows organically, HNSW is the only reasonable choice. IVFFlat would have been premature optimization for a scale Aperio is not designed to reach by a single developer contribution.

---

## Why a Flat Schema Instead of a Knowledge Graph

This is the question that deserves the most honest answer, because it's where Aperio most visibly differs from its competitors.

Zep uses temporal knowledge graphs. Letta uses tiered memory architectures. Both are genuinely interesting systems. Aperio uses a flat `memories` table with a vector column. Why?

**Because the query semantics are different.**

A knowledge graph excels when you need to traverse relationships: *"Find all decisions that were influenced by this project, whose outcomes were observed by these people."* That is a graph traversal problem and relational databases solve it poorly.

But the primary query in a personal memory system is: *"What do I know that is relevant to what I'm doing right now?"* That is a **semantic proximity problem** — and pgvector's HNSW index solves it directly. The vector embedding implicitly encodes relationships. Memories about TypeScript, type safety, and compiler errors naturally cluster together without explicit relationship edges, because the embedding model has already learned that they are conceptually adjacent.

The flat schema is not a simplification of a knowledge graph. It is a different data model optimised for a different primary access pattern.

**What's genuinely missing:** explicit causal and temporal relationships. "This decision was made because of that context" cannot be represented. That is a real limitation, and the honest answer is that it's an accepted tradeoff — not an oversight. A `memory_links` join table (`source_id`, `target_id`, `relation_type`) would address this without abandoning the core model, and is the natural next evolution.

---

## Why Dual Provider Support (Anthropic + Ollama)

**Data sovereignty is not a feature — it is a property of the system.**

When Aperio runs with Ollama, no query, no memory, and no reasoning trace ever leaves the machine. For users working with sensitive professional context, proprietary code, or personal information they'd rather not fund someone else's model training with, local-first operation is not optional.

The dual-provider architecture reflects a belief that AI tooling should not force a choice between capability and privacy. Anthropic's Claude offers stronger reasoning and better tool use. Ollama offers complete data sovereignty. Aperio supports both with the same codebase, and the model can be switched with an environment variable.

The practical engineering consequence: tool schemas must be simple enough for smaller local models to parse reliably. This constraint actually improved Aperio's tool design — simpler schemas are more robust everywhere.

---

## Aperio vs. The Field

A question that will arise in any technical conversation about this project: *"How is this different from Mem0, Zep, or Letta?"*

| | Aperio | Mem0 | Zep | Letta |
|---|---|---|---|---|
| **Model** | Tool | Platform | Platform | Framework |
| **Deployment** | Self-hosted | Cloud / self-hosted | Cloud / self-hosted | Self-hosted |
| **Data location** | Your Postgres | Their servers (cloud) | Their servers (cloud) | Your machine |
| **Dependencies** | 7 | Many | Many | Many |
| **Memory model** | Flat + vectors | Managed graph | Temporal KG | Tiered |
| **Primary value** | Simplicity, ownership | Managed service | Temporal reasoning | Agent OS |

**Mem0** is a managed service. It handles memory so you don't have to think about it. The tradeoff is that your data lives on their infrastructure and the system is a black box. Aperio is the opposite: you own the data, you can read every query, and you can modify the behaviour directly.

**Zep** is genuinely impressive for temporal reasoning and knowledge graph construction. It is also a significantly more complex system to operate and reason about. If your application needs to answer "what did the user believe about X six months ago, and how has that changed?", Zep is probably the right tool. If your application needs to answer "what does the user know that's relevant to this conversation?", Aperio's approach is simpler and sufficient.

**Letta** (formerly MemGPT) is an agent operating system — a framework for building stateful agents with structured memory tiers. It is solving a harder and more general problem than Aperio. Comparing them is a bit like comparing a Swiss Army knife to a chef's knife. One does more things; the other does one thing better.

---

## What Aperio Deliberately Does Not Do

Understanding a system's boundaries is as important as understanding its capabilities.

**Multi-tenancy and authentication.** Aperio is a single-user tool. There is no user isolation, no access control, and no concept of "whose memories are these." Adding these would triple the complexity and shift the project from "tool" to "service." That is a different project.

**Automatic memory extraction from conversations.** Some memory systems automatically decide what to remember from every conversation. Aperio requires explicit tool calls. This is intentional — automatic extraction is a hard problem (what should be remembered? at what granularity? with what confidence?) and getting it wrong silently is worse than not having it. Explicit memory operations are auditable and predictable.

**Conflict resolution and belief revision.** If you remember that you prefer TypeScript, then later remember that you've switched to Go, Aperio stores both. It does not reason about contradiction. This is a limitation, and `update_memory` exists as a manual escape hatch.

---

## The Shape of What's Next

The natural evolution of Aperio, roughly in order of value:

1. **`memory_links` table** — explicit relationships between memories, enabling causal and contextual linking without abandoning the flat model
2. **Automatic importance decay** — memories that haven't been recalled in 90 days probably matter less than they did; a scheduled job could adjust importance scores accordingly  
3. **Conversation episode storage** — storing full conversation summaries as a separate memory tier, giving the system episodic context without polluting the semantic memory store
4. **Multi-user isolation** — `user_id` column, row-level security, per-user embedding spaces

Each of these is an incremental addition. None of them require rebuilding the foundation.

---

*Aperio is small enough to understand completely and focused enough to do its job well. In a field full of platforms trying to be everything, that is a considered choice.*