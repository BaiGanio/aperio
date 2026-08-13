export const troubleshoot = {
  id: 'chapter.troubleshoot', number: 18, title: 'Troubleshoot by symptom',
  purpose: 'Name the observed failure, preserve its first evidence, test the least destructive layer first, and verify recovery plus reversal.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator', 'Contributor'],
  applicability: { release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0', interfaces: 'Browser, terminal, MCP, SQLite/Postgres, providers, tools, indexes, background runs.', evidence: 'Records below route to canonical procedures. They are diagnostic order, not duplicate operational instructions.' },
  sections: [
    { id: 'concept.symptom-first', title: 'Start with what failed, not a favorite subsystem', paragraphs: [
      'Record the exact action, interface, time, first bounded error, expected result, actual result, and most recent known-good state. A blank UI, missing recall, denied path, provider timeout, and stale index can all feel like “Aperio is broken,” but they cross different owners.',
      'Change one variable at a time. Reproduce with synthetic data where possible. Do not delete databases, regenerate keys, rebuild every index, reinstall dependencies, or widen permissions before identifying the failing layer.'
    ], rules: ['Preserve the first error.', 'Verify active identity and scope.', 'Check read-only state before mutation.', 'Prefer reversible probes.', 'Clean up the probe and confirm the original symptom is gone.'] },
    { id: 'concept.failure-ownership', title: 'Route recovery to the layer that owns it', paragraphs: [
      'Transport failures belong to client/process startup. Storage mismatch belongs to backend identity and configuration. Recall failures can involve storage, expiry, tier filtering, embeddings, or conversation scope. Tool denials belong to path, credential, confirmation, or feature gates. Index failures belong to root registration, freshness, parser support, or graph cleanup.',
      'If a repair would cross ownership—such as editing database rows to fix an index, or bypassing path validation to fix a file denial—stop. Follow the linked canonical procedure or escalate with evidence.'
    ] }
  ],
  records: [
    { id: 'symptom.startup-fails', title: 'Aperio or MCP client does not start', severity: 'service unavailable', observed: 'The expected process exits, never listens, or the MCP client reports a closed connection.', checks: ['Verify checkout SHA, command, working directory, runtime, and dependencies.', 'Read captured stderr and the first application error.', 'Verify isolated backend credentials/path and port ownership.', 'Check provider startup only after server/store initialization is known.'], recovery: 'Correct only the first mismatched prerequisite, restart once, and require the expected process plus bounded endpoint or tool list.', verify: 'Complete the synthetic first-recall flow.', reversal: 'Stop the test process and remove isolated state.' },
    { id: 'symptom.recall-missing', title: 'A known memory is not recalled', severity: 'data path degraded', observed: 'Fresh conversation recall returns no matching current memory or an unexpected version.', checks: ['Confirm database identity and current memory ID.', 'Check expiry, supersession, and deletion state.', 'Check local/cloud tier filtering and provider identity.', 'Inspect semantic versus full-text path and embedding availability.'], recovery: 'Restore the intended database or configuration; retry recall before storing a duplicate.', verify: 'Return the known identity/content in a genuinely fresh conversation.', reversal: 'Remove only synthetic diagnostic memories.' },
    { id: 'symptom.tool-denied', title: 'A file, integration, or automation action is denied or paused', severity: 'guard engaged', observed: 'The tool reports path denial, missing credential, disabled gate, pending confirmation, cancellation, or timeout.', checks: ['Identify the exact tool and canonical arguments.', 'Inspect allowed path, credential scope, feature gate, and run ownership.', 'For pending confirmation, compare the exact target and diff.', 'For cancellation or timeout, verify work actually stopped.'], recovery: 'Grant only the missing intended scope or keep the denial; approve no action whose target differs.', verify: 'Repeat one harmless bounded operation and confirm cleanup.', reversal: 'Reject pending interrupts, disable temporary gates, and remove synthetic artifacts.' }
  ],
  procedures: [{
    id: 'procedure.diagnose-symptom', title: 'Diagnose one symptom without destructive guessing', audience: 'Any reader responsible for the affected installation', goal: 'One failure is reproduced, assigned to an owning layer, corrected minimally, and verified with synthetic evidence.',
    prerequisites: ['The exact symptom and first bounded error', 'Current release, interface, backend, provider, and configuration provenance', 'Authority for a harmless synthetic probe'], platforms: 'Diagnostic order is common; commands and service controls follow the installation lane.',
    warning: 'Do not delete, reinstall, migrate, rotate keys, widen permissions, or rebuild indexes until evidence identifies that owner.',
    start: 'Freeze unrelated changes and triggers. Record time, action, expected/actual result, identities, last-known-good state, and cleanup owner.',
    steps: [
      { action: 'Choose the closest Field Console symptom record and run only its first unmet check.' },
      { action: 'Reproduce with synthetic state at the narrowest boundary; stop after the first stable failure.' },
      { action: 'Trace that failure to transport, process, configuration, storage, retrieval, provider, tool guard, index, or retention ownership.' },
      { action: 'Apply one reversible owner-level correction and repeat the exact probe.' },
      { action: 'Exercise one adjacent failure or cancellation path to prove the correction did not bypass a guard.' },
      { action: 'Reverse the probe, confirm cleanup, and record resolved evidence or escalate without further mutation.' }
    ],
    success: 'The original symptom is absent under the same conditions, guard behavior remains intact, and synthetic state is removed.', result: 'A bounded cause and recovery are established without collateral repair.',
    recovery: ['If the symptom changes, preserve both results and restart diagnosis at the new owner.', 'If no check identifies an owner, stop mutations and build the Chapter 19 evidence packet.', 'If cleanup fails, treat the leaked process or state as the active symptom.'],
    reversal: 'Undo the single correction when it was temporary, remove the probe, and restore triggers or service only after clean state is confirmed.', next: ['chapter.evidence-escalate', 'chapter.storage-health', 'chapter.lifecycle'], returns: ['role.owner', 'role.operator', 'role.integrator', 'role.contributor']
  }],
  generatedProjection: { id: 'projection.chapter-18-facts', title: 'Pinned troubleshooting facts', query: { ids: ['data.graceful-shutdown', 'data.memory-expiry', 'data.memory-tiers', 'data.allowed-path-gate', 'support.provider-interface-divergence'] } }
};
