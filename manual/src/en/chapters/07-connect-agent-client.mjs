export const connectAgentClient = {
  id: 'chapter.connect-agent-client', number: 7, title: 'Connect an agent or MCP client',
  purpose: 'Attach one client to Aperio’s stdio MCP server, prove the tool boundary, and keep client-owned configuration separate from the product contract.',
  audiences: ['Everyday user (owner)', 'Integrator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interfaces: 'The pinned product exposes a Node stdio MCP entry point. Client configuration screens, field names, restart behavior, and support status belong to each client.',
    evidence: 'The command and MCP tool catalog are pinned. No universal client matrix is inferred from one successful connection.'
  },
  sections: [
    { id: 'concept.connection-boundary', title: 'A connection is a process boundary', paragraphs: [
      'The client starts Aperio as a local subprocess and exchanges MCP messages over standard input and output. The working directory selects the checkout whose code and dependencies run; environment variables select its database, provider, and security boundaries. A green client indicator proves transport, not correct storage or recall.',
      'Chapter 1 owns the single canonical connection and fresh-recall procedures. Client-specific pages may translate where to enter the same command, arguments, working directory, and environment, but they must link back instead of copying the procedure. A client label or screenshot is never authority for Aperio behavior.'
    ], rules: ['Use an absolute working directory for the pinned checkout.', 'Use the pinned command exactly; do not present a post-release harness as a v0.68.0 command.', 'Keep secrets in the client’s supported secret or environment facility, not in pasted chat.', 'Prove list-tools, remember, and fresh recall before calling the connection complete.'] },
    { id: 'concept.connection-scope', title: 'Scope follows the process you launch', paragraphs: [
      'The subprocess receives the environment and filesystem authority granted by its launcher. A second client can therefore point at another database or allowed-path set even when both display the same server name. Record the checkout, database, and intended scope when diagnosing a mismatch.',
      'Disconnecting a client ends transport; it does not delete durable memories. Conversely, removing a client entry does not prove that a child process stopped. Check the client’s process status and close the disposable session during cleanup.'
    ] }
  ],
  procedureLinks: ['procedure.connect-agent', 'procedure.prove-first-recall'],
  procedures: [],
  generatedProjection: { id: 'projection.chapter-07-facts', title: 'Pinned connection facts', query: { ids: ['command.mcp', 'interface.stdio-mcp', 'support.client-specific-fields', 'support.provider-interface-divergence'] } }
};
