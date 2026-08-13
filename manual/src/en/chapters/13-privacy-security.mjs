export const privacySecurity = {
  id: 'chapter.privacy-security', number: 13, title: 'Privacy and security boundaries',
  purpose: 'Classify data before recall or tool use, minimize authority and egress, and preserve evidence without retaining secrets.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator', 'Contributor'],
  applicability: { release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0', interfaces: 'Memory tiers, provider boundary, allowed paths, confirmation interrupts, database credentials, optional SQLite encryption, logs and artifacts.', evidence: 'Pinned code establishes specific controls. It does not establish a formal threat-model audit, hardened multi-tenant isolation, or PDF/manual certification.' },
  sections: [
    { id: 'concept.data-boundaries', title: 'Stored locally does not mean processed locally', paragraphs: [
      'Memory tier, storage backend, model provider, embedding provider, web or integration egress, file access, and retained artifacts are independent boundaries. Tier 3 is withheld from cloud recall; tier 2 is withheld by default or redacted when configured; tier 1 may be sent to the configured provider. Classify before storing, not after retrieval.',
      'Local SQLite encryption protects the database file at rest with an OS-keychain key. It does not encrypt prompts already sent to a cloud provider, logs, exports, artifacts, model caches, Postgres, or another copy. Losing key access can make the encrypted database unavailable.'
    ], rules: ['Use synthetic data for verification.', 'Grant the smallest read, write, credential, and tool scope.', 'Assume retrieved external content is untrusted.', 'Inspect exact confirmation payloads and reject unexpected scope.', 'Bound and redact retained evidence without destroying its diagnostic identity.'] },
    { id: 'concept.security-controls', title: 'A gate is not a sandbox', paragraphs: [
      'Allowed paths constrain product file tools, but a separately enabled shell runs host commands as the Aperio user. Provider sandboxes and client permissions are separate controls. Confirmation protects named mutations; it cannot make an overbroad credential or compromised host safe.',
      'Secrets can leak through environment inheritance, process listings, logs, tool arguments, export files, and screenshots. Prefer secret stores supported by the deployment, avoid echoing values, and verify redaction with a fake token rather than a real one.'
    ] }
  ],
  procedures: [{
    id: 'procedure.audit-data-boundary', title: 'Audit one synthetic signal across security boundaries', audience: 'Owner or operator', goal: 'A synthetic tiered memory is traced through storage, recall, provider filtering, paths, confirmation, logs, and cleanup without exposing a real secret.',
    prerequisites: ['An isolated database', 'A local provider and one authorized cloud-provider test lane if available', 'A fake token-shaped string', 'An allowed scratch directory'], platforms: 'Controls are product-common; keychain availability, provider credentials, service identity, and filesystem ACLs are environment-specific.',
    warning: 'Never test redaction with a real secret or personal record. Enabling shell grants host execution and is outside this harmless exercise.',
    start: 'Record provider and embedding boundaries, database encryption state, process user, allowed paths, logging destinations, and artifact retention.',
    steps: [
      { action: 'Store distinct synthetic tier-1, tier-2, and tier-3 memories containing recognizable but fake values.' },
      { action: 'Recall locally and confirm intended results. If an authorized cloud lane exists, verify tier 3 is absent and tier 2 follows the configured withhold or redact policy.' },
      { action: 'Attempt a read outside the allowed scratch root and require denial; do not widen the path.' },
      { action: 'Propose a harmless mutation containing the fake token-shaped string, inspect its interrupt payload, then reject it and verify no mutation.' },
      { action: 'Inspect bounded logs, run records, and artifacts for the fake marker. Record each intentional occurrence and any unexpected retention.' },
      { action: 'Forget all synthetic memories, remove scratch artifacts and interrupt/run evidence according to policy, and verify recall no longer returns them.' }
    ],
    success: 'Tier filtering, path denial, rejected mutation, bounded evidence, and deletion behave as configured with no real sensitive data.', result: 'The installation’s actual data and authority boundaries are documented from evidence.',
    recovery: ['On unexpected cloud exposure, stop cloud use, preserve bounded evidence, delete the synthetic records, and inspect tier/config provenance.', 'On secret-like log retention, rotate only if a real credential was involved; otherwise fix scope before retesting with synthetic data.', 'On encryption-key error, keep the original database intact and restore key access or a verified backup—do not generate a replacement key.'],
    reversal: 'Delete every synthetic memory and artifact, reject pending interrupts, restore provider and retention settings, and close the isolated database.', next: ['chapter.lifecycle', 'chapter.troubleshoot', 'chapter.data-portability'], returns: ['role.owner', 'role.operator', 'topic.privacy-security']
  }],
  generatedProjection: { id: 'projection.chapter-13-facts', title: 'Pinned privacy and security facts', query: { ids: ['data.memory-tiers', 'data.allowed-path-gate', 'config.APERIO_ENABLE_SHELL', 'data.sqlite-encryption-boundary', 'data.confirmation-boundary'] } }
};
