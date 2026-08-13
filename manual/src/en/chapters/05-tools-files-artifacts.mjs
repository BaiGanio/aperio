export const toolsFilesArtifacts = {
  id: 'chapter.tools-files-artifacts', number: 5, title: 'Tools, files, and artifacts',
  purpose: 'Use file tools inside explicit path boundaries, require confirmation where the product requires it, and keep generated artifacts tied to their owning session or run.',
  audiences: ['Everyday user (owner)', 'Integrator', 'Contributor'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'MCP file tools. Browser and terminal sessions supply their own scratch workspace; raw MCP uses a run-scoped artifact workspace.',
    evidence: 'Reachable tool schemas, shared path validation, secret-file gates, confirmation interrupts, and artifact ownership are pinned. A generated file is not verified until its returned path and contents are checked.'
  },
  sections: [
    { id: 'concept.path-boundary', title: 'Allowed paths are the outer boundary', paragraphs: [
      'Every read, scan, search, write, edit, delete, and indexing request passes through the shared allowed-path gate. The project root and active session scratch area form a floor; user-authorized folders expand the boundary. A path-looking string from a model is never permission by itself.',
      'Symlinks are resolved through their existing prefix before containment is decided. Secret and credential filenames remain blocked even when their directory is allowed. Read denials and write denials are expected safety results, not reasons to widen access casually.'
    ], rules: ['Use read_file in bounded chunks; it is not a binary or arbitrary-document reader.', 'Read before exact-string edit. A nonunique match must fail unless replacing all is explicitly intended.', 'Writes outside the active session workspace or after untrusted input require the product confirmation flow.', 'Delete uses a short-lived confirmation token and exact target; proposing deletion is not completion.'] },
    { id: 'concept.artifact-ownership', title: 'An artifact has an owner and a cleanup clock', paragraphs: [
      'Generated XLSX and DOCX outputs are written to a protected artifact workspace. Browser and terminal turns inherit the session scratch directory; a standalone MCP process receives one run-scoped directory. The tool returns the verified path and download URL—do not invent either.',
      'Artifacts can make an otherwise short session worth retaining. Deleting or pruning a session may remove its scratch and session-artifact directories. Export anything you intend to keep before cleanup, and do not treat a preview thumbnail as the source file.'
    ] }
  ],
  procedures: [{
    id: 'procedure.safe-file-artifact', title: 'Exercise a harmless file and artifact in scratch',
    audience: 'Owner or integrator testing file tools', goal: 'A text file and generated spreadsheet are created only in disposable scratch, verified, denied outside scope, and removed.',
    prerequisites: ['An active Aperio session with a known scratch workspace', 'A harmless synthetic row such as signal,17'],
    platforms: 'Common tool contract; absolute path syntax differs by operating system, but containment and confirmation semantics do not.',
    warning: 'Do not use secrets, personal data, an existing file, or a guessed confirmation token. Confirm only the exact displayed target and diff.',
    start: 'Create an empty disposable session workspace and note its exact absolute path.',
    steps: [
      { action: 'Write notes.txt inside the session workspace with one synthetic line. If confirmation is requested, inspect the exact target and approve through the real client control.' },
      { action: 'Read notes.txt and verify the returned path and content. Then request the same read against a known path outside the allowed set and confirm it is denied.' },
      { action: 'Edit the unique synthetic line, read again, and verify only that occurrence changed.' },
      { action: 'Generate review.xlsx with one sheet and one synthetic row. Open the exact returned path and verify the workbook content; the display filename is not a destination path.' },
      { action: 'Propose deletion of notes.txt. Confirm only the real product-issued token, then verify the file is absent.' },
      { action: 'End the disposable session after deciding whether to retain review.xlsx; verify the scratch policy matches that decision.' }
    ],
    success: 'Allowed operations stay inside scratch, the outside read is denied, returned artifact contents match the request, and cleanup removes only disposable state.',
    result: 'Path gates, exact editing, artifact ownership, denial, and cleanup are observed without exposing real data.',
    recovery: ['If a path is denied, inspect the listed allowed roots; do not retry by traversing through .. or a symlink.', 'If edit matches more than once, read the file and provide a unique surrounding string.', 'If artifact generation succeeds but verification fails, keep the session and returned path as evidence; do not regenerate over the failure.'],
    reversal: 'Delete only notes.txt through the confirmed flow. Remove the disposable session or exported review.xlsx according to the chosen retention outcome.',
    next: ['chapter.code-document-knowledge', 'chapter.privacy-security', 'chapter.evidence-escalate'], returns: ['role.everyday-user', 'role.integrator', 'topic.tools-files-artifacts']
  }],
  generatedProjection: { id: 'projection.chapter-05-facts', title: 'Pinned file and artifact facts', query: { ids: ['mcp.read_file', 'mcp.write_file', 'mcp.edit_file', 'mcp.delete_file', 'mcp.generate_xlsx', 'data.allowed-path-gate', 'data.artifact-workspace'] } }
};
