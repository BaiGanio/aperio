// Baseline background-agent jobs seeded when the agent_jobs table is empty.
// Jobs are disabled by default so first boot never starts background work.

export const AGENT_JOB_SEED = [
  {
    id: "nightly-maintenance",
    enabled: false,
    trigger: { kind: "interval", everyMs: 86400000 },
    steps: [
      { tool: "backfill_embeddings", input: {} },
      { tool: "deduplicate_memories", input: { threshold: 0.97, dry_run: true } },
    ],
  },
];
