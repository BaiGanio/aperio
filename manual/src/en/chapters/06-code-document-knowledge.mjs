export const codeDocumentKnowledge = {
  id: 'chapter.code-document-knowledge', number: 6, title: 'Code and document knowledge',
  purpose: 'Index an authorized folder, ask the code graph and document graph questions each can answer, and distinguish indexed evidence from live files.',
  audiences: ['Everyday user (owner)', 'Integrator', 'Contributor'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'Codegraph and docgraph MCP tools backed by SQLite or Postgres. Indexing must be enabled and the root must be allowed.',
    evidence: 'Pinned extractors and composition roots establish reachable tools and supported file families. Search completeness depends on the indexed roots and last successful index.'
  },
  sections: [
    { id: 'concept.graph-scope', title: 'Choose the graph that owns the question', paragraphs: [
      'Codegraph indexes symbols and call edges from source files. Start with code_repos when the repository is unknown, search for a symbol or leading documentation, inspect a file outline, then fetch context by qualified name. Pass the repository selector when relative paths or qualified names collide.',
      'Docgraph indexes human documents into sections, chunks, and extracted references. Use doc_search for a topic, doc_outline for one document, doc_context for the selected section or chunk, and doc_refs for an exact ID, URL, email, citation key, or wikilink. Code belongs in codegraph, not docgraph.'
    ] },
    { id: 'concept.index-freshness', title: 'An index is a dated projection', paragraphs: [
      'A graph answer describes the last indexed state, not necessarily the current bytes. Check the listed root, file or document path, index time, and result identity before relying on it. After a source change, wait for or trigger the relevant index update and repeat the same query.',
      'Semantic ranking depends on embeddings; keyword paths remain available when vectors are absent. Empty search can mean wrong root, unsupported type, stale index, insufficient query, or genuinely no match. Diagnose those in that order before claiming absence.'
    ], rules: ['Index only an allowed folder.', 'Use repository/folder qualifiers when names collide.', 'Fetch the smallest context slice needed.', 'Remove the disposable root from the index after a synthetic exercise.'] }
  ],
  procedures: [{
    id: 'procedure.index-synthetic-folder', title: 'Index and query a synthetic code-and-document folder',
    audience: 'Integrator or contributor', goal: 'One authorized disposable root yields a code symbol and document passage, then the root and files are cleaned up.',
    prerequisites: ['SQLite or Postgres backend', 'Codegraph and docgraph enabled', 'An empty allowed throwaway folder'],
    platforms: 'Common graph contract. Filesystem path syntax differs; backend-specific support must follow pinned evidence.',
    warning: 'Indexing materializes content and metadata in the selected database. Use synthetic files and an isolated database; deleting the source folder alone does not prove graph rows are gone.',
    start: 'Create an allowed throwaway folder containing signal.js with function tuneSignal and notes.md with heading Receiver and synthetic token INV-17000.',
    steps: [
      { action: 'Start indexing the root for both code and documents; wait for both target results instead of treating queue acceptance as completion.' },
      { action: 'Call code_repos, then code_search for tuneSignal. Use the returned repository and qualified name with code_context.' },
      { action: 'Call doc_repos, then doc_search for Receiver. Fetch the returned section with doc_context.' },
      { action: 'Call doc_refs for INV-17000 and verify the exact notes.md reference is returned.' },
      { action: 'Modify the synthetic text, update the index, and repeat the queries to prove the projection changed.' },
      { action: 'Delete the disposable graph roots through the owning graph cleanup path, remove the files, and confirm neither repository listing remains.' }
    ],
    success: 'Code and document queries resolve to the intended root, the update becomes visible, and cleanup removes both graph projections and source files.',
    result: 'The codegraph/docgraph boundary, freshness check, disambiguation, and cleanup lifecycle are demonstrated.',
    recovery: ['If the root is denied, authorize the exact folder through Paths and retry once.', 'If a search is empty, confirm the root and index status before changing the query.', 'If cleanup leaves a listed root, stop and use the graph-owned root deletion; do not edit graph tables directly.'],
    reversal: 'Remove the synthetic graph roots first, then the throwaway files and isolated database. Verify code_repos and doc_repos no longer list the root.',
    next: ['chapter.connect-agent-client', 'chapter.contributor-workstation', 'chapter.troubleshoot'], returns: ['role.integrator', 'role.contributor', 'topic.tools-files-artifacts']
  }],
  generatedProjection: { id: 'projection.chapter-06-facts', title: 'Pinned codegraph and docgraph facts', query: { ids: ['mcp.code_search', 'mcp.code_context', 'mcp.doc_search', 'mcp.doc_context', 'mcp.doc_refs', 'config.APERIO_CODEGRAPH', 'config.APERIO_DOCGRAPH'] } }
};
