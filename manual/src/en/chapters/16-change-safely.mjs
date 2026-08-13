export const changeSafely = {
  id: 'chapter.change-safely', number: 16, title: 'Change Aperio safely',
  purpose: 'Make the smallest coherent source change, preserve cross-layer contracts, and verify behavior plus cleanup in proportion to risk.',
  audiences: ['Contributor'],
  applicability: { release: 'Repository guidance rooted in the pinned v0.68.0 architecture; current working-tree instructions govern an actual contribution.', interfaces: 'Source, tests, generated outputs, SQLite/Postgres, browser/MCP/provider boundaries.', evidence: 'Pinned structure identifies coupling; a task-specific test and affected-flow result are required for a change claim.' },
  sections: [
    { id: 'concept.change-contract', title: 'Change the owner, not every route to it', paragraphs: [
      'One canonical behavior should have one implementation owner. Routes, task pages, provider adapters, and generated catalogs project or call that owner. Copying logic into a second lane creates drift even when both copies pass today.',
      'Before editing, state the invariant, inputs, durable or external effects, error shapes, cancellation behavior, and cleanup owner. Add a regression test that fails for the original defect or absent feature, then change the narrowest responsible module.'
    ], rules: ['Preserve unrelated work.', 'Keep configuration registry and generated references synchronized.', 'Mirror database migrations when authorized.', 'Route every file operation through path validation.', 'Verify cancellation, failure, and teardown—not only success.'] },
    { id: 'concept.resource-review', title: 'Correctness includes bounded resources and data lifetime', paragraphs: [
      'Review new arrays, caches, queues, logs, buffers, queries, timers, listeners, workers, streams, sockets, files, database handles, and background promises. Bound growth, attach ownership, release on success and failure, and prevent work continuing after its result is abandoned.',
      'Do not claim faster or smaller from intuition. Establish a relevant baseline and measure meaningful performance changes. Prefer clarity when no bottleneck is demonstrated.'
    ] }
  ],
  procedures: [{
    id: 'procedure.make-verified-change', title: 'Implement and verify one scoped change', audience: 'Contributor', goal: 'One owner-level change passes its regression test, affected flow, resource cleanup, and scoped diff review.',
    prerequisites: ['A clean task boundary and baseline', 'The relevant architecture and testing references', 'Authority to edit every file the invariant requires'], platforms: 'Repository workflow is common; available external providers, databases, and platform lanes determine additional verification.',
    warning: 'Stop before touching a no-touch zone without authority, before resolving a concurrent edit by overwrite, or before broad cleanup unrelated to the task.',
    start: 'Write down the current failure or desired outcome, canonical owner, coupled consumers, risk level, and exact success/recovery/cleanup evidence.',
    steps: [
      { action: 'Add or identify a focused regression test that expresses the user-visible contract and fails for the right reason.' },
      { action: 'Edit the smallest coherent owner module and any required projections. Avoid copied behavior or unrelated formatting churn.' },
      { action: 'Run the focused test, then the coupled suite required by the touched boundary.' },
      { action: 'Exercise the affected flow with synthetic isolated state, including one failure or cancellation path and explicit cleanup.' },
      { action: 'Measure any claimed performance effect against the recorded baseline; otherwise make no performance claim.' },
      { action: 'Review the task-scoped diff for secrets, generated-file hand edits, missing dual-backend changes, lifecycle leaks, and unrelated files.' }
    ],
    success: 'Focused and coupled tests pass, the affected flow behaves correctly, owned resources terminate, and the scoped diff contains only coherent task work.', result: 'The change is reviewable and evidence-backed but not committed or released by implication.',
    recovery: ['If the regression test passes before the fix, strengthen it before editing production code.', 'If a coupled test fails, trace the contract mismatch rather than weakening coverage.', 'If cleanup leaks, fix ownership before continuing to wider verification.'],
    reversal: 'Undo only this task’s edits using a reviewed patch or restore the isolated task workspace; never reset or discard another session’s work.', next: ['chapter.verify-release', 'chapter.troubleshoot', 'chapter.evidence-escalate'], returns: ['role.contributor', 'topic.contributor-technical']
  }],
  generatedProjection: { id: 'projection.chapter-16-facts', title: 'Pinned change-safety facts', query: { ids: ['data.dual-backend-contract', 'data.path-validation-coupling', 'data.mcp-context-coupling', 'data.graceful-shutdown'] } }
};
