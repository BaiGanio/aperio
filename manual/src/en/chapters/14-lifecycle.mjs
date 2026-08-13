export const lifecycle = {
  id: 'chapter.lifecycle', number: 14, title: 'Update, move, protect, recover, and uninstall',
  purpose: 'Protect the whole installation before lifecycle change, distinguish portable data from backup, and prove both forward recovery and reversal.',
  audiences: ['Everyday user (owner)', 'Operator'],
  applicability: { release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0', interfaces: 'Source installations with SQLite or Postgres. Portable JSON export/import covers selected logical records only.', evidence: 'Pinned export/import fields, database behavior, encryption, artifacts, caches, and shutdown establish what must be protected. No universal backup utility or cross-version upgrade guarantee is invented.' },
  sections: [
    { id: 'concept.backup-vs-export', title: 'Portable export is not a full backup', paragraphs: [
      'The portable export contains memories and optionally wiki, agent jobs, agent runs, and self-memories. Import accepts memories, wiki articles, and self-memories, limits memories per request, and regenerates missing embeddings. That asymmetry alone prevents it from being a full round-trip backup.',
      'A recoverable installation may also require schema and database contents, settings, encryption key access, indexed code/document state or a rebuild plan, session and run artifacts, credentials or re-entry plan, model and embedding dependencies, configuration, and the exact source release. Protect these according to backend while writers are stopped.'
    ], rules: ['Inventory before copying.', 'Gracefully stop all writers.', 'Back up data and the means to decrypt and interpret it.', 'Restore into isolation and prove recall before changing the original.', 'Keep an exact rollback path until the new installation passes.'] },
    { id: 'concept.lifecycle-stages', title: 'Update, move, recovery, and uninstall share one proof shape', paragraphs: [
      'Each operation starts from recorded identity and ends only after a restored or changed installation proves schema access, fresh recall, provider boundary, optional indexes, artifacts that were promised, and clean shutdown. A successful file copy or process start is intermediate evidence.',
      'Uninstall is deliberately last. Stop processes and triggers, export only what is wanted for portability, make and verify any required full backup, remove application code, then handle databases, volumes, caches, model weights, credentials, and keychain entries as separate explicit decisions.'
    ] }
  ],
  procedures: [{
    id: 'procedure.protect-and-recover', title: 'Create and prove a recoverable installation backup', audience: 'Owner or operator', goal: 'A full installation inventory is captured with backend-appropriate consistency, restored in isolation, and proven through fresh recall before the original is touched.',
    prerequisites: ['Administrative access to the installation and its database', 'Enough separate storage for a backup and isolated restore', 'Access to required encryption keys without copying them into the manual evidence', 'A maintenance window to stop writers'], platforms: 'SQLite file-copy and Postgres logical/physical backup mechanisms differ. Use the backend’s established consistent-backup method; this release does not supply a universal backup command.',
    warning: 'Portable export/import is not this backup. Never copy a live SQLite file as the only backup, expose a key in logs, or test recovery over the original installation.',
    start: 'Record release SHA, backend and exact data location, schema state, config sources, encryption/key custody, providers, indexes, artifacts, caches, credentials, processes, and retention rules.',
    steps: [
      { action: 'Create a portable export only if logical portability is also desired; label it partial and record its counts.' },
      { action: 'Disable triggers and gracefully stop Aperio, MCP children, model processes, workers, watchers, and all database writers. Verify ports and handles are closed.' },
      { action: 'Capture a backend-consistent database backup plus required configuration, artifact state, release identity, and a secure key-restoration plan. Hash and inventory the backup without publishing secrets.' },
      { action: 'Restore into a separate path, database identity, and non-default port. Re-enter credentials through their proper secret channel and run only owning migrations.' },
      { action: 'Verify schema, counts, one known record, fresh-conversation recall, privacy tier behavior, promised artifacts, and each enabled index or its documented rebuild.' },
      { action: 'Stop the restored instance cleanly. Keep the original untouched until the restore evidence is reviewed; then choose update, move, continued protection, or explicit uninstall.' }
    ],
    success: 'An isolated restore opens with the required key, matches the inventory, completes fresh recall, satisfies promised data/artifact checks, and shuts down cleanly.', result: 'The backup is recovery evidence rather than an untested copy.',
    recovery: ['If restore cannot open, preserve both copies and inspect backend, version, schema, and key custody without retrying over either.', 'If logical counts differ, compare the declared portable-export field asymmetry before diagnosing database loss.', 'If indexes differ, use the recorded rebuild plan only after canonical records are proven.'],
    reversal: 'Stop and remove only the isolated restore after evidence is retained, or keep it as the selected new installation while the untouched original remains the rollback until explicit retirement.', next: ['chapter.troubleshoot', 'chapter.data-portability', 'chapter.release-support'], returns: ['role.owner', 'role.operator', 'topic.lifecycle']
  }],
  generatedProjection: { id: 'projection.chapter-14-facts', title: 'Pinned lifecycle facts', query: { ids: ['data.portable-export', 'data.portable-import-asymmetry', 'data.sqlite-encryption-boundary', 'data.graceful-shutdown', 'data.retention-workers'] } }
};
