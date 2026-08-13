export const verifyRelease = {
  id: 'chapter.verify-release', number: 17, title: 'Verify and prepare a release',
  purpose: 'Assemble reproducible verification evidence and a candidate without confusing test success with authority to sign, publish, or move release identity.',
  audiences: ['Contributor', 'Maintainer'],
  applicability: { release: 'The manual’s product authority remains v0.68.0. These are preparation controls, not authorization for a new release.', interfaces: 'Automated tests, affected flows, generated artifacts, manifests, PDF checks, checksums, and human gates.', evidence: 'Commands must come from the candidate tree and required toolchain; release identity and human approval remain external gates.' },
  sections: [
    { id: 'concept.release-evidence', title: 'A candidate is a closed evidence graph', paragraphs: [
      'Every artifact should trace to source, normalized factual data, toolchain identity, build phase, verification result, and manifest hash. Generated output is never repaired by hand. Rebuild from source and invalidate evidence when any input changes.',
      'A green general suite does not replace targeted affected-flow proof. A visually clean PDF does not establish tags or reading order. A validator report does not establish human usability. Keep each claim tied to its owning check.'
    ], rules: ['Build from an immutable candidate tree.', 'Keep pseudolocale and internal evidence out of primary review paths.', 'Verify both success and cleanup.', 'Use release filenames only after release identity is authorized.', 'Never sign, upload, publish, move aliases, or close the epic without the named human gate.'] },
    { id: 'concept.release-gates', title: 'Technical readiness and release authority are different states', paragraphs: [
      'A hermetic candidate requires every declared dependency, digest-pinned tools, offline assets, reproducible inputs, clean test results, and a complete manifest. Missing specialist validators or fonts are blockers, not optional warnings.',
      'Physical A4 and Letter proofs and required human review cannot be simulated by software. Record them as pending until a person examines actual output under the ticket’s criteria.'
    ] }
  ],
  procedures: [{
    id: 'procedure.prepare-release-candidate', title: 'Prepare a non-publishing candidate evidence packet', audience: 'Contributor or maintainer with candidate-build authority', goal: 'An immutable candidate tree produces verified artifacts and a complete manifest while all signing and publication actions remain untouched.',
    prerequisites: ['All content and implementation dependencies closed', 'Digest-pinned build and validation tools', 'Offline assets and complete font profile', 'An isolated output root and candidate identity approved for build'], platforms: 'The hermetic toolchain defines its platform. Physical proofing remains a separate human lane.',
    warning: 'Candidate build authority does not authorize signing, publication, upload, release aliases, version changes, or closing a release epic.',
    start: 'Resolve every dependency and evidence pin, freeze the candidate tree, create empty isolated build/cache directories, and verify no release aliases will move.',
    steps: [
      { action: 'Run focused tests and affected flows from the immutable candidate, then the required coupled and whole-suite gates.' },
      { action: 'Generate catalogs, English and pseudolocale artifacts, PDFs, page images, contact sheets, and manifests only through the canonical orchestrator.' },
      { action: 'Verify HTML at desktop and narrow widths and every English A4/Letter page visually against approved prototypes.' },
      { action: 'Run structural PDF checks for language, tags, roles, bookmarks, reading order, searchable text, links, figures, alternative text, tables, headers, fonts, geometry, grayscale, and collisions; retain the Chromium /Strong regression.' },
      { action: 'Run required specialist validators and reproducibility rebuilds. Treat unavailable tools or divergent hashes as blockers.' },
      { action: 'Seal a non-release manifest and review checklist that names passed checks, blockers, external dependencies, and human decisions. Stop before every publication action.' }
    ],
    success: 'The candidate and evidence reproduce from immutable inputs, all required automated checks pass, and every remaining external or human gate is explicit.', result: 'A reviewable candidate exists without claiming release, PDF/UA certification, or publication authority.',
    recovery: ['On generated mismatch, fix source or toolchain and rebuild the entire affected evidence set.', 'On unavailable validator or font, keep the candidate non-release and name the exact dependency.', 'On visual defect, fix semantic source or approved styling; never patch PDF or page images.'],
    reversal: 'Discard only the isolated candidate outputs and caches, leaving source and prior evidence intact; no alias or published object should exist to reverse.', next: ['chapter.release-support', 'chapter.evidence-escalate', 'chapter.index'], returns: ['role.contributor', 'role.maintainer', 'topic.evaluations-testing-reliability']
  }],
  generatedProjection: { id: 'projection.chapter-17-facts', title: 'Pinned verification facts', query: { ids: ['command.test', 'command.test:integration', 'support.release-authority-boundary', 'data.repository-entry-points'] } }
};
