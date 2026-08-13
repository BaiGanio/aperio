export const evidenceEscalate = {
  id: 'chapter.evidence-escalate', number: 19, title: 'Collect evidence and escalate',
  purpose: 'Package the smallest sufficient, provenance-rich evidence for another person without leaking secrets, mutable noise, or unbounded data.',
  audiences: ['Everyday user (owner)', 'Operator', 'Integrator', 'Contributor', 'Maintainer'],
  applicability: { release: 'Aperio 0.68.0 and repository work derived from it', interfaces: 'Local diagnostic bundle assembled from textual facts, bounded logs, manifests, screenshots only when needed, and synthetic reproduction.', evidence: 'The evidence checklist is complete without network, images, color, or private data. Submission destination and disclosure policy remain external.' },
  sections: [
    { id: 'concept.evidence-quality', title: 'Good evidence is bounded, attributable, and reproducible', paragraphs: [
      'Include release or commit, interface, platform/runtime, backend and provider identities without secrets, configuration provenance for relevant keys, exact action, expected and actual result, first bounded error, timestamps, reproduction, cleanup state, and prior known-good evidence. State what was not tested.',
      'Prefer text and machine-readable manifests to screenshots. A screenshot can demonstrate visual layout but is poor evidence for searchable errors, configuration provenance, or hidden state. Never use an image as the only copy of a table or log.'
    ], rules: ['Collect the minimum sufficient interval.', 'Redact values but preserve key names and structural identity.', 'Hash immutable artifacts.', 'Distinguish observation from inference.', 'Name every unavailable dependency and human decision.'] },
    { id: 'concept.escalation-safety', title: 'Escalation does not broaden authority', paragraphs: [
      'A support request or issue body is data exchanged with another party. Do not attach databases, exports, credentials, full home-directory paths, private repository content, personal memories, or unrestricted logs unless a specific approved channel and necessity exist.',
      'Keep the original evidence locally, create a redacted copy, and verify the copy independently. Record whether cleanup has completed and whether any live risk—exposed credential, active process, repeated automation—still requires containment.'
    ] }
  ],
  records: [{ id: 'checklist.escalation-packet', title: 'Escalation evidence packet', severity: 'review before sharing', observed: 'A bounded unresolved symptom needs another person or external dependency.', checks: ['Identity: release/SHA, interface, runtime/platform, backend/provider.', 'Reproduction: synthetic inputs, starting state, actions, expected/actual result.', 'Evidence: first bounded error, timestamps, relevant manifest hashes, cleanup result.', 'Safety: redacted credentials, paths, personal data, external content, and database material.', 'Scope: attempted checks, ruled-out layers, unavailable tools, and requested decision.'], recovery: 'If redaction removes diagnostic meaning, replace sensitive values with stable labels and retain a private mapping; do not restore the secret.', verify: 'A second read can reproduce the issue and cannot recover a secret from the shared packet.', reversal: 'Delete temporary unredacted copies and revoke any accidentally exposed credential.' }],
  procedures: [{
    id: 'procedure.build-escalation-packet', title: 'Build and verify a redacted evidence packet', audience: 'Any reader escalating an unresolved issue', goal: 'A recipient can reproduce or decide the next step from bounded evidence while secrets and unrelated data remain private.',
    prerequisites: ['An unresolved symptom after least-destructive diagnosis', 'A local private evidence directory', 'The intended recipient and disclosure boundary'], platforms: 'Packet fields are common. Archive, hashing, and secure-transfer mechanisms are environment-specific.',
    warning: 'Do not attach a full database, portable export, .env, keychain material, access token, unrestricted log, browser profile, or private source tree by default.',
    start: 'Copy only task-scoped evidence into a private scratch directory. Record original paths separately and define the sharing boundary.',
    steps: [
      { action: 'Write a text summary separating observation, inference, attempted recovery, current impact, and requested decision.' },
      { action: 'Add identity, environment, relevant configuration sources, synthetic reproduction, first bounded error, and cleanup state.' },
      { action: 'Add only necessary log excerpts and manifests. Replace secrets and personal values with stable redaction labels.' },
      { action: 'Hash immutable attachments and list their source and generation method. Mark screenshots supplementary and add text alternatives.' },
      { action: 'Search the redacted copy for secret patterns, home paths, personal data, tokens, database URLs, and unrelated project names.' },
      { action: 'Open the packet as the recipient would, confirm it is self-contained, then share only through the approved destination or stop at the external gate.' }
    ],
    success: 'The packet states identity, reproduction, bounded evidence, attempted checks, cleanup, blockers, and requested decision with no recoverable secret or unrelated data.', result: 'Escalation can proceed without silently expanding data or operational authority.',
    recovery: ['If evidence is too large, narrow by time, owner, and first failure instead of truncating structure blindly.', 'If a secret was exposed, stop sharing, revoke it through its owner, and rebuild from the private original.', 'If the destination is not approved, retain the verified local packet and record the external gate.'],
    reversal: 'Remove temporary unredacted copies, revoke exposed credentials if any, delete synthetic state, and retain only the approved local evidence according to policy.', next: ['chapter.troubleshoot', 'chapter.release-support', 'chapter.index'], returns: ['role.owner', 'role.operator', 'role.contributor', 'topic.evaluations-testing-reliability']
  }],
  generatedProjection: { id: 'projection.chapter-19-facts', title: 'Pinned evidence facts', query: { ids: ['release.0-68-0', 'data.config-tier-boundary', 'data.artifact-workspace', 'support.release-authority-boundary'] } }
};
