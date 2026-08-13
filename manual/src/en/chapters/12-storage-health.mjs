export const storageHealth = {
  id: 'chapter.storage-health', number: 12, title: 'Storage, indexing, and service health',
  purpose: 'Identify the active durable store, distinguish service health from data health, and diagnose indexing or retention without destructive guessing.',
  audiences: ['Operator', 'Integrator', 'Contributor'],
  applicability: { release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0', interfaces: 'SQLite or Postgres storage, background embedding/index queues, session and run retention, browser and MCP processes.', evidence: 'Backend selection, migrations, workers, and shutdown lifecycle are pinned; no external monitoring stack is bundled or implied.' },
  sections: [
    { id: 'concept.health-layers', title: 'Healthy listening is only the outer layer', paragraphs: [
      'A process can listen while its configured provider, vector path, index, or durable store is degraded. Check in layers: process and loopback endpoint; resolved backend and database access; schema migration state; one bounded read/write; embedding or index freshness; provider readiness; then end-to-end recall.',
      'Empty recall, code search, or document search is not by itself a health verdict. Confirm database identity, allowed root, feature gate, queue completion, index timestamp, and query mode before treating absence as corruption.'
    ], rules: ['Observe before repairing.', 'Record the exact active database, not only DB_BACKEND input.', 'Use one synthetic probe and remove it.', 'Stop writers before copying SQLite or changing storage.', 'Let each index own its cleanup rows.'] },
    { id: 'concept.retention-health', title: 'Retention is an active deletion policy', paragraphs: [
      'Session pruning, agent-run pruning, artifact pruning, log pruning, and memory expiry are separate mechanisms. A zero or unset run-retention value can mean keep forever, while another subsystem may have its own default. Confirm each owner before promising preservation.',
      'Workers run at boot and on timers. Shutdown must stop timers, scheduler, watchers, embedding work, sockets, model server, and database handles. A clean exit is part of data health because abandoned writers make later diagnosis ambiguous.'
    ] }
  ],
  procedures: [{
    id: 'procedure.check-service-health', title: 'Run a layered health check with one synthetic probe', audience: 'Operator', goal: 'The active store, schema, recall path, optional indexes, retention workers, and shutdown are checked without modifying real content.',
    prerequisites: ['Access to the installation’s configuration provenance and bounded logs', 'A harmless synthetic memory', 'Knowledge of whether codegraph, docgraph, agents, and local inference are enabled'], platforms: 'Common conceptual order; service managers, paths, and database inspection commands are installation-specific.',
    warning: 'Do not delete database files, rebuild indexes, rerun migrations manually, or disable encryption as a diagnostic shortcut. Preserve the first failure and active-store identity.',
    start: 'Record process identity, port, resolved backend, exact database location or connection, provider, enabled indexes, and retention values.',
    steps: [
      { action: 'Confirm the expected process owns the loopback listener and obtain one bounded application response.' },
      { action: 'Verify the resolved backend can read schema migration state and perform a transaction using a synthetic record only.' },
      { action: 'Complete remember and fresh recall for the synthetic record. If recall fails, compare storage identity before invoking embeddings or rebuilding anything.' },
      { action: 'For each enabled graph, inspect its registered root and freshness, then query one known synthetic symbol or passage. Mark disabled graphs not applicable.' },
      { action: 'Inspect retention settings and the latest bounded worker outcome; verify no policy would remove evidence needed for the investigation.' },
      { action: 'Delete the synthetic record, request graceful shutdown, and verify listeners, watchers, timers, provider work, and database handles terminate.' }
    ],
    success: 'Each enabled layer has direct evidence, the synthetic probe is removed, and graceful shutdown leaves no owned process or writer.', result: 'Service health is separated from storage, index, provider, and retention health.',
    recovery: ['On backend mismatch, stop and restore the intended configuration before writing.', 'On migration error, preserve schema state and use the owning migration path; never replay SQL files by hand.', 'On stale index, repair only that graph after preserving root and timestamp evidence.'],
    reversal: 'Remove the synthetic memory and graph fixtures, restore any temporary retention override, and restart only if the installation is meant to remain running.', next: ['chapter.privacy-security', 'chapter.lifecycle', 'chapter.troubleshoot'], returns: ['role.operator', 'topic.configuration-storage-deployment']
  }],
  generatedProjection: { id: 'projection.chapter-12-facts', title: 'Pinned storage and health facts', query: { ids: ['config.DB_BACKEND', 'data.sqlite-backend', 'config.APERIO_CODEGRAPH', 'config.APERIO_DOCGRAPH', 'data.graceful-shutdown', 'data.retention-workers'] } }
};
