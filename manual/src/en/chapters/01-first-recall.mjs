export const firstRecall = {
  id: 'chapter.first-recall',
  number: 1,
  title: 'First recall',
  purpose: 'Install the pinned Aperio source, connect one MCP-capable agent, store one harmless memory, and prove recall in a fresh conversation.',
  nonGoals: ['Choosing a production deployment', 'Claiming a verified Node or platform matrix', 'Configuring every client'],
  audiences: ['Everyday user (owner)', 'Integrator'],
  applicability: {
    release: 'Aperio 0.68.0 at 65d45c971c51c9c83a7d3faf34def61dd4d841e0',
    interface: 'stdio MCP',
    installMode: 'Node source checkout',
    platforms: ['macOS: present-unverified', 'Windows: present-unverified', 'Linux: present-unverified'],
    evidence: 'The entry point and tools are pinned and reachable. Exact Node/platform/client setup remains present-unverified.'
  },
  tasks: ['Prepare the pinned checkout', 'Start the stdio MCP server from an agent', 'Store a harmless memory', 'Recall it in a fresh conversation'],
  procedures: [
    {
      id: 'procedure.prepare-node-source',
      title: 'Prepare the pinned source checkout',
      audience: 'Everyday user (owner) with permission to install dependencies',
      goal: 'A local v0.68.0 checkout whose package identity matches the pinned release.',
      prerequisites: ['Git', 'Node.js and npm. The exact compatible Node range is not verified for this release preview.'],
      platforms: 'Common sequence; no platform-specific support claim is made.',
      warning: 'Dependency installation runs package lifecycle code. Use a disposable or trusted workstation, and inspect the pinned package before continuing.',
      start: 'Choose an empty directory. Do not run these commands over an existing Aperio data directory.',
      steps: [
        { action: 'Clone the repository, then check out the immutable release tag.', code: 'git clone https://github.com/BaiGanio/aperio.git\ncd aperio\ngit checkout --detach v0.68.0' },
        { action: 'Verify the tag resolves to the required full commit.', code: 'git rev-parse HEAD\n# expected: 65d45c971c51c9c83a7d3faf34def61dd4d841e0' },
        { action: 'Install exactly the dependency graph recorded by the lockfile.', code: 'npm ci' }
      ],
      success: 'The full SHA matches and npm exits successfully without changing package.json or package-lock.json.',
      result: 'A pinned Node source checkout with installed dependencies. Aperio is not yet connected to an agent.',
      recovery: ['If the SHA differs, stop and detach the exact tag; do not continue from latest or a branch.', 'If npm reports a Node incompatibility, record the Node/npm versions. This preview has no evidence to widen the platform claim.'],
      reversal: 'Remove only the new checkout after confirming it contains no data you intend to keep. This does not uninstall Node or clear shared caches.',
      next: ['procedure.connect-agent', 'chapter.signal-model'],
      returns: ['role.everyday-user', 'role.integrator', 'topic.integrations-automation']
    },
    {
      id: 'procedure.connect-agent',
      title: 'Connect one agent through stdio MCP',
      audience: 'Integrator or everyday owner configuring a personal agent',
      goal: 'The agent exposes Aperio memory tools from the pinned checkout.',
      prerequisites: ['procedure.prepare-node-source', 'An MCP client that can launch a local stdio server'],
      platforms: 'The Aperio command is common. Client configuration fields are client-owned and present-unverified in this preview.',
      warning: 'The client launches local code with your user permissions. Keep the working directory at the pinned checkout and do not grant broader file access for this first test.',
      start: 'Close any Aperio process already using the same data location. In the client, start a new local stdio-server connection.',
      steps: [
        { action: 'Set the server working directory to the pinned checkout.' },
        { action: 'Set the executable to npm and the arguments to the registered MCP script.', code: 'npm run mcp' },
        { action: 'Connect, then inspect the client tool list for remember and recall. Exact menus and field names vary by client and are intentionally not invented here.' }
      ],
      success: 'The client reports a live connection and lists both remember and recall.',
      result: 'One agent is connected to the pinned Aperio MCP server.',
      recovery: ['If the process exits, run npm run mcp in a terminal inside the checkout and read the first error.', 'If the connection is live but the tools are absent, verify the client is showing tools for this server, then reconnect.'],
      reversal: 'Disconnect or remove only this client server entry. The memory store, if later created, is not removed by disconnecting.',
      next: ['procedure.prove-first-recall', 'chapter.signal-model'],
      returns: ['role.integrator', 'topic.integrations-automation']
    },
    {
      id: 'procedure.prove-first-recall',
      title: 'Store and recall one harmless memory',
      audience: 'Everyday user (owner)',
      goal: 'A fresh conversation recalls a harmless value stored in the previous conversation.',
      prerequisites: ['procedure.connect-agent', 'A client view that shows tool activity or tool results'],
      platforms: 'All connected stdio MCP clients; client UI wording is not standardized.',
      warning: 'Use harmless synthetic text. A normal tier-1 memory may enter context sent to the configured model provider. Do not use a password, token, health detail, private address, or real personal fact.',
      start: 'Open a conversation with the connected agent and confirm Aperio tools are enabled.',
      steps: [
        { action: 'Ask the agent exactly:', quote: 'Remember that my review word is apricot.' },
        { action: 'Confirm the tool activity shows remember succeeded. A conversational promise without a successful tool result is not evidence.' },
        { action: 'End that conversation and start a genuinely fresh conversation with the same Aperio connection.' },
        { action: 'Ask:', quote: 'What is my review word? Use Aperio recall.' },
        { action: 'Confirm the tool activity shows recall and the answer contains apricot.' }
      ],
      success: 'A fresh conversation returns apricot from a successful recall result.',
      result: 'One harmless tier-1 memory exists in Aperio, and end-to-end recall has been demonstrated.',
      recovery: ['If remember did not run, ask the agent to use the Aperio remember tool and inspect the tool result.', 'If recall returns nothing, search for apricot explicitly and confirm the fresh conversation uses the same Aperio store.', 'If the wrong value appears, stop testing and inspect/delete the test memory before adding real data.'],
      reversal: 'Use the returned memory ID with the forget tool, then search for apricot again. The reversal succeeds only when no matching test memory remains.',
      next: ['chapter.signal-model', 'chapter.memory-knowledge', 'chapter.privacy-security'],
      returns: ['role.everyday-user', 'topic.memory-knowledge']
    }
  ],
  symptom: {
    id: 'symptom.recall-empty-after-remember',
    title: 'Recall is empty after remember succeeded',
    severity: 'Low for synthetic data; stop before adding personal data.',
    observed: 'The remember result succeeded, but a fresh conversation does not return the review word.',
    checks: ['Confirm the second conversation uses the same configured Aperio server and storage.', 'Run an explicit recall query for apricot.', 'Capture only version, tool status, and sanitized errors - never memory content or secrets.'],
    recovery: 'Reconnect the same server, repeat explicit recall, and return to procedure.prove-first-recall.',
    verify: 'A successful recall result contains apricot.',
    reversal: 'Delete any duplicate synthetic memories created during diagnosis.'
  }
};
