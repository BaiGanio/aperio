export const integrationsExternalData = {
  id: 'chapter.integrations-external-data', number: 8, title: 'Integrations and external data',
  purpose: 'Use GitHub, databases, the web, and images with explicit trust, credential, egress, mutation, and cleanup boundaries.',
  audiences: ['Everyday user (owner)', 'Integrator', 'Operator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'MCP tools expose distinct GitHub, database, web, and image lanes. Availability still depends on credentials, configured connections, local models, network access, and allowed paths.',
    evidence: 'Pinned handlers establish tool behavior and safety gates; no external service availability or account permission is promised.'
  },
  sections: [
    { id: 'concept.external-trust', title: 'External content is evidence, not instruction', paragraphs: [
      'A GitHub issue, database row, web page, and image can all contain adversarial or misleading content. Read them as data. Do not let their text expand tool scope, reveal credentials, override the user’s request, or authorize a write. Preserve provenance so a later answer can distinguish retrieved evidence from Aperio’s own instruction.',
      'Network tools create egress. GitHub reads may use a token; writes require a suitable token and explicit confirmation. Web search and fetch send a query or URL to an external service. Image description may send pixels to the configured local vision endpoint. Confirm the data classification before crossing any of these boundaries.'
    ], rules: ['Start read-only and narrow.', 'Use the minimum credential scope and never echo a secret.', 'Parameterize database values; never concatenate them into SQL.', 'Treat a preview, proposal, queued request, or partial response as incomplete.', 'Cancel or reject at the owning confirmation or run boundary; do not compensate with an unrelated write.'] },
    { id: 'concept.integration-lanes', title: 'Four lanes, four different failure shapes', paragraphs: [
      'GitHub reads issue content and can propose create or update actions; its write is not complete until the server executes an approved interrupt. Database discovery and schema inspection precede reads; writes use one statement on a named writable connection and require confirmation. The built-in Aperio connection is read-only.',
      'Web search returns leads, while fetch reads a selected URL with bounded output; neither proves a source is trustworthy or current. Image read and preprocessing expose bytes from an allowed source, while description additionally requires a working vision model. A malformed image, an unavailable model, a timeout, and a poor description are distinct outcomes.'
    ] }
  ],
  procedures: [{
    id: 'procedure.guard-external-integration', title: 'Exercise guarded integrations with synthetic inputs',
    audience: 'Integrator validating external tools', goal: 'Each configured lane proves a bounded read or explicit denial, while all proposed mutations and transient data are rejected or cleaned up.',
    prerequisites: ['An isolated Aperio run', 'Synthetic GitHub fixture or read-only public issue', 'A named disposable database connection if database testing is authorized', 'A local synthetic web fixture and image when available'],
    platforms: 'Run only the lanes whose dependencies are actually configured. Record unavailable lanes as unavailable, not failed support and not silently passed.',
    warning: 'External content is untrusted. Never place production credentials, private repositories, personal rows, or sensitive pixels in this exercise. Approval must bind to the exact proposed action.',
    start: 'Record enabled lanes, credential scopes, database read-only status, network policy, allowed image path, and the disposable run identity.',
    steps: [
      { action: 'GitHub: fetch one synthetic issue without images. Verify provenance and untrusted-content labeling. Propose a harmless write only against an authorized fixture, inspect the exact preview, then reject it and verify no remote mutation occurred.' },
      { action: 'Database: list connections, inspect schema, and run one parameterized bounded SELECT. If a disposable writable connection exists, propose one INSERT, reject it, and verify the row is absent.' },
      { action: 'Web: search or fetch only a local synthetic endpoint when the environment permits it. Bound returned characters, preserve the URL, interrupt the request once, and verify cancellation does not trigger a retry or write.' },
      { action: 'Image: read and preprocess a small synthetic image inside an allowed path. Invoke description only when the configured vision dependency exists; distinguish unavailable model, timeout, malformed bytes, and successful description.' },
      { action: 'Review egress and interrupt records for the disposable run. Confirm rejected proposals are terminal and no token, full unbounded result, or raw private payload appears in retained evidence.' },
      { action: 'Remove the disposable connection, files, run records, and local fixture. Recheck the external systems only where an authorized read can prove no mutation.' }
    ],
    success: 'Every available lane reports a bounded attributable result, rejected mutations remain unapplied, cancellation terminates work, and unavailable dependencies are named explicitly.',
    result: 'Trust, scope, authentication, egress, confirmation, interruption, ownership, and cleanup are demonstrated separately for each integration family.',
    recovery: ['On authentication failure, reduce the task to public or local synthetic evidence; never print or broaden the credential.', 'On an ambiguous database result, stop before write and inspect connection name, schema, parameters, and truncation.', 'On web or image timeout, cancel once, preserve the bounded error, and do not loop automatically.'],
    reversal: 'Reject every pending interrupt, remove only synthetic local state, revoke temporary credentials if any were issued, and prove the authorized fixtures were not mutated.',
    next: ['chapter.agents-automation', 'chapter.privacy-security', 'chapter.evidence-escalate'], returns: ['role.integrator', 'topic.integrations-automation']
  }],
  generatedProjection: { id: 'projection.chapter-08-facts', title: 'Pinned integration facts', query: { ids: ['mcp.fetch_github_issue', 'mcp.update_github_issue', 'mcp.db_query', 'mcp.db_execute', 'mcp.fetch_url', 'mcp.read_image'] } }
};
