export const configure = {
  id: 'chapter.configure', number: 11, title: 'Configure Aperio',
  purpose: 'Resolve configuration from its actual authority layers, protect bootstrap secrets, and verify one change through the consumer that uses it.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator', 'Contributor'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'DB settings overlay, .env or process environment, and code defaults. APERIO_CONFIG_PRECEDENCE selects DB-first by default or env-first; bootstrap tier-0 keys remain environment-only.',
    evidence: 'The pinned configuration registry and resolver define keys, tiers, defaults, precedence, provenance, and restart behavior. Generated catalogs are factual projections, not substitute instructions.'
  },
  sections: [
    { id: 'concept.config-precedence', title: 'Effective value and written value may differ', paragraphs: [
      'With the default db precedence, an eligible value saved in Settings overrides the environment; with env precedence, an environment value wins when present while DB-only values still apply. The precedence key itself is resolved early. Lite mode fixes precedence to DB so its Settings UI remains authoritative.',
      'Tier-0 bootstrap and security values cannot be injected from the database because the store may need them before it opens. Configuration is applied at boot and is not a general hot-reload contract. A saved field can therefore be valid yet inactive until the owning process restarts.'
    ], rules: ['Identify the key’s tier and source before editing it.', 'Change one layer at a time.', 'Never print secret values while comparing sources.', 'Restart only the consumer that requires it, then verify effective provenance.', 'Generate catalogs from the registry; never hand-maintain a competing list.'] },
    { id: 'concept.config-coupling', title: 'Some settings change durable interpretation', paragraphs: [
      'Backend, encryption, embedding dimension, provider, path, retention, and feature-gate changes have different reversibility. Changing an embedding dimension can make existing vectors incompatible; changing database location can make data appear missing; changing provider changes the inference boundary; enabling shell grants host execution rather than creating a sandbox.',
      'Before a high-impact change, record the current effective value, source, dependent data or process, expected restart, success signal, and rollback value. Treat a blank as unset only where the registry and resolver do. Never infer a safe migration from a settings control.'
    ] }
  ],
  procedures: [{
    id: 'procedure.change-config-safely', title: 'Change one reversible setting and verify precedence',
    audience: 'Owner or operator', goal: 'One harmless feature gate changes through its intended authority layer, reports the expected source after restart, and returns to its prior value.',
    prerequisites: ['An isolated installation and database', 'Access to its Settings interface or environment file', 'A recorded current value and provenance for a reversible non-secret key'],
    platforms: 'Precedence behavior is common. Environment-file location, service restart command, and UI field presentation depend on the installation lane.',
    warning: 'Do not use encryption keys, database credentials, embedding dimensions, storage locations, shell enablement, or a production provider token for this exercise.',
    start: 'Choose a harmless off-by-default gate in the isolated installation. Record its current effective value, source label, precedence mode, process ID, and expected behavior.',
    steps: [
      { action: 'Confirm whether the key is tier 0 or tier 1 in the pinned generated catalog. Continue only with a reversible tier-1 key.' },
      { action: 'Under db precedence, save the test value in Settings. Restart the owning process and verify both effective value and “from UI” provenance.' },
      { action: 'Set a conflicting environment value without exposing secrets. Restart and verify DB still wins; record the shadow notice without copying values unnecessarily.' },
      { action: 'Set APERIO_CONFIG_PRECEDENCE=env, restart, and verify the environment value now wins while unrelated DB-only settings remain applied.' },
      { action: 'Exercise the selected feature’s observable behavior once. Do not accept a saved form or log line alone as success.' },
      { action: 'Restore the original value and precedence, restart, recheck behavior and provenance, then remove the disposable setting row and environment line.' }
    ],
    success: 'Effective value, provenance, restart behavior, DB-first precedence, env override, and restoration match the pinned resolver contract.',
    result: 'One configuration change is traced from authority layer through runtime behavior without disclosing secrets or changing durable interpretation.',
    recovery: ['If the process fails after restart, restore the recorded value in the same authority layer before changing anything else.', 'If the wrong layer wins, inspect precedence and tier rather than duplicating the value across layers.', 'If the selected feature has no bounded observable behavior, choose another reversible key; do not claim success from configuration storage alone.'],
    reversal: 'Restore the original setting and precedence, restart the exact consumer, verify prior behavior and provenance, and delete only the test-layer residue.',
    next: ['chapter.storage-health', 'chapter.privacy-security', 'chapter.configuration-catalog'], returns: ['role.operator', 'topic.configuration-storage-deployment']
  }],
  generatedProjection: { id: 'projection.chapter-11-facts', title: 'Pinned configuration facts', query: { ids: ['config.APERIO_CONFIG_PRECEDENCE', 'config.AI_PROVIDER', 'config.DB_BACKEND', 'config.APERIO_ENABLE_SHELL', 'data.config-tier-boundary'] } }
};
