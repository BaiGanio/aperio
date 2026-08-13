export const parts = [
  { id: 'part.tune-in', title: 'Tune in', chapters: [
    ['chapter.first-recall', 'First recall'],
    ['chapter.signal-model', 'How Aperio carries a signal']
  ]},
  { id: 'part.use', title: 'Use Aperio', chapters: [
    ['chapter.memory-knowledge', 'Memory and knowledge'],
    ['chapter.conversations-sessions-agents', 'Conversations, sessions, and agents'],
    ['chapter.tools-files-artifacts', 'Tools, files, and artifacts'],
    ['chapter.code-document-knowledge', 'Code and document knowledge']
  ]},
  { id: 'part.connect-operate', title: 'Connect and automate', chapters: [
    ['chapter.connect-agent-client', 'Connect an agent or MCP client'],
    ['chapter.integrations-external-data', 'Integrations and external data'],
    ['chapter.agents-automation', 'Agents and automation']
  ]},
  { id: 'part.operate', title: 'Operate an installation', chapters: [
    ['chapter.install-deploy', 'Install and deploy'],
    ['chapter.configure', 'Configure Aperio'],
    ['chapter.storage-health', 'Storage, indexing, and service health'],
    ['chapter.privacy-security', 'Privacy and security boundaries'],
    ['chapter.lifecycle', 'Update, move, protect, recover, and uninstall']
  ]},
  { id: 'part.extend', title: 'Extend and contribute', chapters: [
    ['chapter.contributor-workstation', 'Contributor workstation and repository map'],
    ['chapter.change-safely', 'Change Aperio safely'],
    ['chapter.verify-release', 'Verify and prepare a release']
  ]},
  { id: 'part.fix', title: 'Fix a problem', chapters: [
    ['chapter.troubleshoot', 'Troubleshoot by symptom'],
    ['chapter.evidence-escalate', 'Collect evidence and escalate']
  ]},
  { id: 'part.reference', title: 'Reference', chapters: [
    ['chapter.release-support', 'Release and support matrix'],
    ['chapter.configuration-catalog', 'Configuration catalog'],
    ['chapter.commands-checks', 'Commands and operational checks'],
    ['chapter.capability-catalog', 'Tools, providers, integrations, and capability catalog'],
    ['chapter.data-portability', 'Data, portability, and retention matrix'],
    ['chapter.glossary', 'Glossary'],
    ['chapter.index', 'Full index']
  ]}
];

export const taskRoutes = [
  ['Start using Aperio', 'chapter.first-recall'],
  ['Use and manage memory day to day', 'chapter.memory-knowledge'],
  ['Connect another agent, client, or integration', 'chapter.connect-agent-client'],
  ['Configure and operate an installation', 'chapter.configure'],
  ['Update, move, protect, recover, or uninstall Aperio', 'chapter.lifecycle'],
  ['Extend or contribute to Aperio', 'chapter.contributor-workstation'],
  ['Fix a problem', 'chapter.troubleshoot']
];

export const topics = [
  ['Memory and knowledge', 'chapter.memory-knowledge'],
  ['Conversations and sessions', 'chapter.conversations-sessions-agents'],
  ['Agents and providers', 'chapter.conversations-sessions-agents'],
  ['Tools, files, and generated artifacts', 'chapter.tools-files-artifacts'],
  ['Integrations and automation', 'chapter.integrations-external-data'],
  ['Privacy, security, and data boundaries', 'chapter.privacy-security'],
  ['Evaluations, testing, and reliability', 'chapter.verify-release'],
  ['Configuration, storage, and deployment', 'chapter.configure'],
  ['Lifecycle, portability, backup, and recovery', 'chapter.lifecycle'],
  ['Contributor and technical references', 'chapter.contributor-workstation']
];

export const roles = [
  { id: 'role.everyday-user', title: 'Everyday user (owner)', links: ['procedure.prove-first-recall', 'chapter.memory-knowledge', 'chapter.privacy-security'] },
  { id: 'role.operator', title: 'Operator', links: ['chapter.install-deploy', 'chapter.configure', 'chapter.lifecycle'] },
  { id: 'role.integrator', title: 'Integrator', links: ['procedure.connect-agent', 'chapter.connect-agent-client', 'chapter.integrations-external-data'] },
  { id: 'role.contributor', title: 'Contributor', links: ['chapter.contributor-workstation', 'chapter.change-safely', 'chapter.verify-release'] }
];

export const book = {
  id: 'book.aperio-manual',
  title: 'Aperio Manual',
  subtitle: 'Part I review preview',
  layers: ['Tune in', 'Use', 'Connect and operate', 'Extend', 'Recover and look up'],
  parts,
  taskRoutes,
  topics,
  roles
};
