import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeDataset, stableId } from '../../lib/data/index.mjs';

const exec = promisify(execFile);

async function git(root, args) {
  const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function at(root, sha, file) {
  return git(root, ['show', `${sha}:${file}`]);
}

async function blob(root, sha, file) {
  return git(root, ['rev-parse', `${sha}:${file}`]);
}

async function filesAt(root, sha, directory) {
  const listing = await git(root, ['ls-tree', '-r', '--name-only', sha, directory]);
  return listing ? listing.split('\n').filter(Boolean) : [];
}

function row(family, name, fields) {
  return { id: stableId(family, name), family, name, ...fields };
}

export async function extractPartIFacts(root, edition) {
  const sha = edition.product.sha;
  const packageJson = JSON.parse(await at(root, sha, 'package.json'));
  const license = await at(root, sha, 'LICENSE');
  if (packageJson.version !== edition.product.version) throw new Error('tagged package version mismatch');
  const tagSha = await git(root, ['rev-parse', `${edition.product.tag}^{commit}`]);
  const releaseSha = await git(root, ['rev-parse', 'refs/remotes/origin/release']);
  if (tagSha !== sha || releaseSha !== sha) throw new Error('release identity disagreement');
  const memory = await at(root, sha, 'mcp/tools/memory.js');
  const memoryHandlers = await at(root, sha, 'lib/handlers/memory/memoryHandlers.js');
  const wiki = await at(root, sha, 'mcp/tools/wiki.js');
  const fileTools = await at(root, sha, 'mcp/tools/files.js');
  const codegraph = await at(root, sha, 'mcp/tools/codegraph.js');
  const docgraph = await at(root, sha, 'mcp/tools/docgraph.js');
  const github = await at(root, sha, 'mcp/tools/github.js');
  const database = await at(root, sha, 'mcp/tools/database.js');
  const web = await at(root, sha, 'mcp/tools/web.js');
  const image = await at(root, sha, 'mcp/tools/image.js');
  const mcp = await at(root, sha, 'mcp/index.js');
  const config = await at(root, sha, 'lib/config.js');
  const providers = await at(root, sha, 'lib/providers/index.js');
  const sessions = await at(root, sha, 'lib/routes/api-sessions.js');
  const agents = await at(root, sha, 'lib/routes/api-agents.js');
  const server = await at(root, sha, 'lib/server.js');
  const terminal = await at(root, sha, 'lib/terminal/standalone.js');
  const paths = await at(root, sha, 'lib/routes/paths.js');
  const artifactWorkspace = await at(root, sha, 'lib/helpers/artifactWorkspace.js');
  const jobSpec = await at(root, sha, 'lib/agent/job-spec.js');
  const databaseFactory = await at(root, sha, 'db/index.js');
  const configResolver = await at(root, sha, 'lib/config-resolver.js');
  const postgresCompose = await at(root, sha, 'docker/docker-compose.yml');
  const productionCompose = await at(root, sha, 'docker/docker-compose.prod.yml');
  const dataRoutes = await at(root, sha, 'lib/routes/api-data.js');
  const sqliteEncryption = await at(root, sha, 'db/sqlite/encryption.js');
  const serverShutdown = await at(root, sha, 'lib/server/shutdown.js');
  const sessionPrune = await at(root, sha, 'lib/workers/session-prune.js');
  const runPrune = await at(root, sha, 'lib/workers/agent-run-prune.js');
  if (!mcp.includes('registerMemory')) throw new Error('memory tools are not reachable from MCP composition root');

  const facts = [
    row('release', edition.product.version, { value: edition.product.version, status: 'verified', source: 'package.json', sourceBlob: await blob(root, sha, 'package.json') }),
    row('legal', 'license', { value: license.split('\n').slice(0, 3).join(' / '), status: license.startsWith('MIT License\n\nCopyright (c) 2025 BaiGanio') ? 'verified' : 'unsupported', source: 'LICENSE', sourceBlob: await blob(root, sha, 'LICENSE') }),
    row('command', 'start', { value: packageJson.scripts.start, status: 'present-unverified', audience: 'operator', source: 'package.json', sourceBlob: await blob(root, sha, 'package.json') }),
    row('command', 'mcp', { value: packageJson.scripts.mcp, status: 'verified', audience: 'integrator', source: 'package.json', sourceBlob: await blob(root, sha, 'package.json') }),
    row('command', 'test', { value: packageJson.scripts.test, status: 'verified', audience: 'contributor', source: 'package.json', sourceBlob: await blob(root, sha, 'package.json') }),
    row('command', 'test:integration', { value: packageJson.scripts['test:integration'], status: 'verified', audience: 'contributor', source: 'package.json', sourceBlob: await blob(root, sha, 'package.json') }),
    row('mcp', 'remember', { value: 'Save a new memory to Aperio', status: memory.includes('name: "remember"') ? 'verified' : 'unsupported', source: 'mcp/tools/memory.js', sourceBlob: await blob(root, sha, 'mcp/tools/memory.js') }),
    row('mcp', 'recall', { value: 'Search memories by semantic similarity or full text', status: memory.includes('name: "recall"') ? 'verified' : 'unsupported', source: 'mcp/tools/memory.js', sourceBlob: await blob(root, sha, 'mcp/tools/memory.js') }),
    row('mcp', 'update_memory', { value: 'Create a replacement version and supersede the prior current memory', status: memory.includes('name: "update_memory"') ? 'verified' : 'unsupported', source: 'mcp/tools/memory.js', sourceBlob: await blob(root, sha, 'mcp/tools/memory.js') }),
    row('mcp', 'forget', { value: 'Delete one memory by UUID', status: memory.includes('name: "forget"') ? 'verified' : 'unsupported', source: 'mcp/tools/memory.js', sourceBlob: await blob(root, sha, 'mcp/tools/memory.js') }),
    row('mcp', 'wiki_search', { value: 'Search wiki articles before creating a synthesis', status: wiki.includes('name: "wiki_search"') ? 'verified' : 'unsupported', source: 'mcp/tools/wiki.js', sourceBlob: await blob(root, sha, 'mcp/tools/wiki.js') }),
    row('mcp', 'wiki_write', { value: 'Upsert a cited wiki synthesis by stable slug and increment its revision', status: wiki.includes('name: "wiki_write"') ? 'verified' : 'unsupported', source: 'mcp/tools/wiki.js', sourceBlob: await blob(root, sha, 'mcp/tools/wiki.js') }),
    row('mcp', 'read_file', { value: 'Read an allowed code or text file in bounded chunks', status: fileTools.includes('"read_file"') ? 'verified' : 'unsupported', source: 'mcp/tools/files.js', sourceBlob: await blob(root, sha, 'mcp/tools/files.js') }),
    row('mcp', 'write_file', { value: 'Write within allowed paths with confirmation when the product requires it', status: fileTools.includes('"write_file"') ? 'verified' : 'unsupported', source: 'mcp/tools/files.js', sourceBlob: await blob(root, sha, 'mcp/tools/files.js') }),
    row('mcp', 'edit_file', { value: 'Replace exact text; ambiguous matches fail unless replace_all is explicit', status: fileTools.includes('"edit_file"') ? 'verified' : 'unsupported', source: 'mcp/tools/files.js', sourceBlob: await blob(root, sha, 'mcp/tools/files.js') }),
    row('mcp', 'delete_file', { value: 'Delete one exact file through the confirmation interrupt', status: fileTools.includes('"delete_file"') ? 'verified' : 'unsupported', source: 'mcp/tools/files.js', sourceBlob: await blob(root, sha, 'mcp/tools/files.js') }),
    row('mcp', 'generate_xlsx', { value: 'Generate a spreadsheet in the protected artifact workspace and return its verified path', status: fileTools.includes('"generate_xlsx"') ? 'verified' : 'unsupported', source: 'mcp/tools/files.js', sourceBlob: await blob(root, sha, 'mcp/tools/files.js') }),
    row('mcp', 'code_search', { value: 'Search indexed code symbols with repository-qualified results', status: codegraph.includes('name: "code_search"') ? 'verified' : 'unsupported', source: 'mcp/tools/codegraph.js', sourceBlob: await blob(root, sha, 'mcp/tools/codegraph.js') }),
    row('mcp', 'code_context', { value: 'Fetch the source slice for a qualified indexed symbol', status: codegraph.includes('name: "code_context"') ? 'verified' : 'unsupported', source: 'mcp/tools/codegraph.js', sourceBlob: await blob(root, sha, 'mcp/tools/codegraph.js') }),
    row('mcp', 'doc_search', { value: 'Search indexed human-document passages by topic', status: docgraph.includes('name: "doc_search"') ? 'verified' : 'unsupported', source: 'mcp/tools/docgraph.js', sourceBlob: await blob(root, sha, 'mcp/tools/docgraph.js') }),
    row('mcp', 'doc_context', { value: 'Fetch one indexed document section or chunk', status: docgraph.includes('name: "doc_context"') ? 'verified' : 'unsupported', source: 'mcp/tools/docgraph.js', sourceBlob: await blob(root, sha, 'mcp/tools/docgraph.js') }),
    row('mcp', 'doc_refs', { value: 'Find indexed documents containing one exact reference', status: docgraph.includes('name: "doc_refs"') ? 'verified' : 'unsupported', source: 'mcp/tools/docgraph.js', sourceBlob: await blob(root, sha, 'mcp/tools/docgraph.js') }),
    row('mcp', 'fetch_github_issue', { value: 'Read one GitHub issue and comments; returned issue content is untrusted', status: github.includes('"fetch_github_issue"') ? 'verified' : 'unsupported', source: 'mcp/tools/github.js', sourceBlob: await blob(root, sha, 'mcp/tools/github.js') }),
    row('mcp', 'update_github_issue', { value: 'Propose an issue update or comment and require a server-owned confirmation before remote write', status: github.includes('"update_github_issue"') && github.includes('Pending your confirmation') ? 'verified' : 'unsupported', source: 'mcp/tools/github.js', sourceBlob: await blob(root, sha, 'mcp/tools/github.js') }),
    row('mcp', 'db_query', { value: 'Run one bounded read-only parameterized statement on a named connection', status: database.includes('name: "db_query"') ? 'verified' : 'unsupported', source: 'mcp/tools/database.js', sourceBlob: await blob(root, sha, 'mcp/tools/database.js') }),
    row('mcp', 'db_execute', { value: 'Propose one write statement for confirmation on a configured writable connection', status: database.includes('name: "db_execute"') && database.includes('confirm-before-write') ? 'verified' : 'unsupported', source: 'mcp/tools/database.js', sourceBlob: await blob(root, sha, 'mcp/tools/database.js') }),
    row('mcp', 'fetch_url', { value: 'Fetch one SSRF-checked URL with bounded text and explicit paging', status: web.includes('"fetch_url"') ? 'verified' : 'unsupported', source: 'mcp/tools/web.js', sourceBlob: await blob(root, sha, 'mcp/tools/web.js') }),
    row('mcp', 'read_image', { value: 'Read a bounded local or base64 image; description is a separate vision-model operation', status: image.includes('"read_image"') && image.includes('MAX_BYTES') ? 'verified' : 'unsupported', source: 'mcp/tools/image.js', sourceBlob: await blob(root, sha, 'mcp/tools/image.js') }),
    row('config', 'AI_PROVIDER', { value: 'llamacpp | anthropic | deepseek | gemini | claude-code | codex', status: config.includes('{ key: "AI_PROVIDER"') ? 'present-unverified' : 'unsupported', source: 'lib/config.js', sourceBlob: await blob(root, sha, 'lib/config.js') }),
    row('config', 'APERIO_CONFIG_PRECEDENCE', { value: 'db by default; env is the explicit override', status: config.includes('APERIO_CONFIG_PRECEDENCE') ? 'verified' : 'unsupported', source: 'lib/config.js', sourceBlob: await blob(root, sha, 'lib/config.js') }),
    row('config', 'APERIO_AGENT_JOBS', { value: 'Background-agent execution is gated; job definitions may exist while execution is off', status: config.includes('APERIO_AGENT_JOBS') && agents.includes('jobsEnabled') ? 'verified' : 'unsupported', source: 'lib/config.js + lib/routes/api-agents.js', sourceBlob: await blob(root, sha, 'lib/routes/api-agents.js') }),
    row('config', 'DB_BACKEND', { value: 'Explicit sqlite or postgres wins; otherwise reachable aperio_db may select Postgres and the safe fallback is SQLite', status: databaseFactory.includes("SUPPORTED = new Set(['postgres', 'sqlite'])") ? 'verified' : 'unsupported', source: 'db/index.js', sourceBlob: await blob(root, sha, 'db/index.js') }),
    row('config', 'APERIO_ENABLE_SHELL', { value: 'Shell execution is an opt-in host-execution capability, not a sandbox', status: config.includes('APERIO_ENABLE_SHELL') ? 'verified' : 'unsupported', source: 'lib/config.js', sourceBlob: await blob(root, sha, 'lib/config.js') }),
    row('config', 'APERIO_CODEGRAPH', { value: 'Code indexing is opt-in', status: config.includes('APERIO_CODEGRAPH') ? 'verified' : 'unsupported', source: 'lib/config.js', sourceBlob: await blob(root, sha, 'lib/config.js') }),
    row('config', 'APERIO_DOCGRAPH', { value: 'Document indexing is opt-in', status: config.includes('APERIO_DOCGRAPH') ? 'verified' : 'unsupported', source: 'lib/config.js', sourceBlob: await blob(root, sha, 'lib/config.js') }),
    row('interface', 'stdio-mcp', { value: 'Standalone stdio MCP server', status: packageJson.scripts.mcp === 'node mcp/index.js' ? 'verified' : 'unsupported', source: 'package.json + mcp/index.js', sourceBlob: await blob(root, sha, 'mcp/index.js') }),
    row('interface', 'browser-chat', { value: 'Browser server with session and background-agent routes', status: server.includes('createApp') && sessions.includes('mountSessionRoutes') ? 'verified' : 'unsupported', source: 'lib/server.js + lib/routes/api-sessions.js', sourceBlob: await blob(root, sha, 'lib/server.js') }),
    row('interface', 'terminal-chat', { value: 'Terminal conversation creates a distinct saved session source', status: terminal.includes('source: "terminal"') ? 'verified' : 'unsupported', source: 'lib/terminal/standalone.js', sourceBlob: await blob(root, sha, 'lib/terminal/standalone.js') }),
    row('route', 'sessions', { value: 'List, fetch, pin, and delete saved sessions by exact ID', status: ['router.get("/sessions"', 'router.delete("/sessions/:id"', 'router.patch("/sessions/:id/pin"'].every((needle) => sessions.includes(needle)) ? 'verified' : 'unsupported', source: 'lib/routes/api-sessions.js', sourceBlob: await blob(root, sha, 'lib/routes/api-sessions.js') }),
    row('route', 'agent-jobs', { value: 'Define jobs, inspect runs, run now when enabled, and delete by exact ID', status: ['router.post("/agents"', 'router.post("/agents/:id/run"', 'router.delete("/agents/:id"'].every((needle) => agents.includes(needle)) ? 'verified' : 'unsupported', source: 'lib/routes/api-agents.js', sourceBlob: await blob(root, sha, 'lib/routes/api-agents.js') }),
    row('support', 'node-source-install', { value: 'Shipped source install surface; exact Node/platform matrix not release-verified', status: 'present-unverified', source: 'package.json + package-lock.json', sourceBlob: await blob(root, sha, 'package-lock.json') }),
    row('support', 'client-specific-fields', { value: 'Client-owned configuration fields require client evidence', status: 'present-unverified', source: 'mcp/index.js', sourceBlob: await blob(root, sha, 'mcp/index.js') }),
    row('support', 'provider-interface-divergence', { value: 'Provider and interface lanes are materially distinct; one representative path does not establish universal support', status: providers.includes('resolveProvider') ? 'present-unverified' : 'unsupported', source: 'lib/providers/index.js', sourceBlob: await blob(root, sha, 'lib/providers/index.js') }),
    row('data', 'memory-tier-1', { value: 'Normal memory may be shared with configured providers', status: 'verified', source: 'mcp/tools/memory.js', sourceBlob: await blob(root, sha, 'mcp/tools/memory.js') }),
    row('data', 'memory-tiers', { value: 'Tier 1 normal; cloud retrieval withholds tier 2 by default or redacts it when configured; tier 3 never leaves the machine', status: memoryHandlers.includes('Tier 3 (private) is always dropped') ? 'verified' : 'unsupported', source: 'lib/handlers/memory/memoryHandlers.js', sourceBlob: await blob(root, sha, 'lib/handlers/memory/memoryHandlers.js') }),
    row('data', 'memory-expiry', { value: 'Current recall excludes expired records; expiry is not a full deletion or backup mechanism', status: memory.includes('expires_at') ? 'verified' : 'unsupported', source: 'mcp/tools/memory.js + database search implementations', sourceBlob: await blob(root, sha, 'mcp/tools/memory.js') }),
    row('data', 'allowed-path-gate', { value: 'File and indexing operations resolve paths through one symlink-aware allowlist gate', status: paths.includes('export function isReadPathAllowed') && paths.includes('export function isWritePathAllowed') ? 'verified' : 'unsupported', source: 'lib/routes/paths.js', sourceBlob: await blob(root, sha, 'lib/routes/paths.js') }),
    row('data', 'artifact-workspace', { value: 'Generated artifacts belong to the active session scratch workspace or a run-scoped MCP workspace', status: artifactWorkspace.includes('ownership: "session"') && artifactWorkspace.includes('ownership: "run"') ? 'verified' : 'unsupported', source: 'lib/helpers/artifactWorkspace.js', sourceBlob: await blob(root, sha, 'lib/helpers/artifactWorkspace.js') }),
    row('data', 'agent-run-interrupts', { value: 'Agent run records may include their pending and decided confirmation interrupts', status: agents.includes('attachRunInterrupts') ? 'verified' : 'unsupported', source: 'lib/routes/api-agents.js', sourceBlob: await blob(root, sha, 'lib/routes/api-agents.js') }),
    row('data', 'agent-tool-allowlist', { value: 'Background job specifications normalize an explicit tool allowlist', status: jobSpec.includes('toolAllowlist') ? 'verified' : 'unsupported', source: 'lib/agent/job-spec.js', sourceBlob: await blob(root, sha, 'lib/agent/job-spec.js') }),
    row('data', 'sqlite-backend', { value: 'SQLite is the zero-configuration and failure fallback backend', status: databaseFactory.includes("initBackend('sqlite')") ? 'verified' : 'unsupported', source: 'db/index.js', sourceBlob: await blob(root, sha, 'db/index.js') }),
    row('data', 'postgres-compose-boundary', { value: 'Development Compose owns a loopback Postgres service; production Compose migration initialization conflicts with the repository migration-ownership warning and is not a verified manual lane', status: postgresCompose.includes('do NOT mount db/migrations') && productionCompose.includes('/docker-entrypoint-initdb.d') ? 'present-unverified' : 'unsupported', source: 'docker/docker-compose.yml + docker/docker-compose.prod.yml', sourceBlob: await blob(root, sha, 'docker/docker-compose.prod.yml') }),
    row('data', 'config-tier-boundary', { value: 'Tier-0 bootstrap values are environment-only; eligible Tier-1 values can come from DB settings, environment, or defaults and apply at boot', status: configResolver.includes('Tier-0 keys are never injected') && configResolver.includes('restart') ? 'verified' : 'unsupported', source: 'lib/config-resolver.js', sourceBlob: await blob(root, sha, 'lib/config-resolver.js') }),
    row('data', 'graceful-shutdown', { value: 'Graceful shutdown stops workers, scheduler, graph watchers, embeddings, sockets, HTTP, llama.cpp, and the database in an owned sequence', status: serverShutdown.includes('watchdog.stop()') && serverShutdown.includes('await store.close') ? 'verified' : 'unsupported', source: 'lib/server/shutdown.js', sourceBlob: await blob(root, sha, 'lib/server/shutdown.js') }),
    row('data', 'retention-workers', { value: 'Session and agent-run retention are separate daily workers; run retention is opt-in and also prunes run-owned artifacts', status: sessionPrune.includes('setInterval') && runPrune.includes('AGENT_RUN_RETENTION_DAYS') ? 'verified' : 'unsupported', source: 'lib/workers/session-prune.js + lib/workers/agent-run-prune.js', sourceBlob: await blob(root, sha, 'lib/workers/agent-run-prune.js') }),
    row('data', 'sqlite-encryption-boundary', { value: 'SQLite encryption uses authenticated decryption and OS-keychain key custody; it does not protect exports, prompts, artifacts, Postgres, or unrelated copies', status: sqliteEncryption.includes('AES-256-GCM authenticated') && sqliteEncryption.includes('keychain') ? 'verified' : 'unsupported', source: 'db/sqlite/encryption.js', sourceBlob: await blob(root, sha, 'db/sqlite/encryption.js') }),
    row('data', 'confirmation-boundary', { value: 'Protected mutations bind a server-owned interrupt to canonical arguments; proposal or rejection is not execution', status: github.includes('canonicalArguments') && database.includes('confirmation_token') ? 'verified' : 'unsupported', source: 'mcp/tools/github.js + mcp/tools/database.js', sourceBlob: await blob(root, sha, 'mcp/tools/github.js') }),
    row('data', 'portable-import-asymmetry', { value: 'Portable export can include jobs and runs, while import accepts memories, wiki, and self-memories and queues embedding backfill; it is not a full backup round trip', status: dataRoutes.includes('agent_jobs') && !dataRoutes.slice(dataRoutes.indexOf('router.post("/data/import"')).includes('agent_jobs') ? 'verified' : 'unsupported', source: 'lib/routes/api-data.js', sourceBlob: await blob(root, sha, 'lib/routes/api-data.js') }),
    row('data', 'repository-entry-points', { value: 'server.js enters browser service; mcp/index.js composes stdio tools; db/index.js selects the durable backend', status: server.includes('createApp') && mcp.includes('registerMemory') && databaseFactory.includes('getStore') ? 'verified' : 'unsupported', source: 'server.js + mcp/index.js + db/index.js', sourceBlob: await blob(root, sha, 'server.js') }),
    row('data', 'dual-backend-contract', { value: 'SQLite and Postgres implement the same store-facing product domains; schema and behavior changes require both lanes to remain coherent', status: packageJson.dependencies?.pg && packageJson.dependencies?.['better-sqlite3'] ? 'verified' : 'unsupported', source: 'package.json + db/index.js', sourceBlob: await blob(root, sha, 'db/index.js') }),
    row('data', 'path-validation-coupling', { value: 'Product file and indexing operations depend on the shared allowed-path validation boundary', status: paths.includes('isReadPathAllowed') && paths.includes('isWritePathAllowed') ? 'verified' : 'unsupported', source: 'lib/routes/paths.js', sourceBlob: await blob(root, sha, 'lib/routes/paths.js') }),
    row('data', 'mcp-context-coupling', { value: 'MCP tool registrations consume one shared context assembled by mcp/index.js', status: mcp.includes('createContext') ? 'verified' : 'unsupported', source: 'mcp/index.js', sourceBlob: await blob(root, sha, 'mcp/index.js') }),
    row('support', 'release-authority-boundary', { value: 'Tests and candidate artifacts are technical evidence; signing, publication, release aliases, and human approval are separate authorities', status: 'present-unverified', source: 'manual release process', sourceBlob: await blob(root, sha, 'package.json') }),
    row('data', 'portable-export', { value: 'Portable export/import is partial and is not a full backup', status: 'verified', source: 'lib/routes/api-data.js', sourceBlob: await blob(root, sha, 'lib/routes/api-data.js') })
  ];
  if (packageJson.scripts['test:harness']) throw new Error('post-v0.68.0 agent harness leaked into pinned commands');

  const existing = new Set(facts.map((fact) => fact.id));
  const configBlob = await blob(root, sha, 'lib/config.js');
  const registryRows = [...config.matchAll(/^\s*\{ key: "([^"]+)", section: "([^"]+)", type: "([^"]+)", tier: ([01]),/gm)];
  if (registryRows.length !== 112) throw new Error(`pinned configuration catalog incomplete: ${registryRows.length}/112`);
  for (const [, key, section, type, tier] of registryRows) {
    const fact = row('config', key, { value: `${section} / ${type} / tier ${tier}`, status: 'verified', source: 'lib/config.js', sourceBlob: configBlob });
    if (!existing.has(fact.id)) { facts.push(fact); existing.add(fact.id); }
  }

  const packageBlob = await blob(root, sha, 'package.json');
  for (const [name, command] of Object.entries(packageJson.scripts).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const fact = row('command', name, { value: command, status: 'verified', audience: 'contributor', source: 'package.json', sourceBlob: packageBlob });
    if (!existing.has(fact.id)) { facts.push(fact); existing.add(fact.id); }
  }

  const toolFiles = (await filesAt(root, sha, 'mcp/tools')).filter((file) => /^mcp\/tools\/[^/]+\.js$/.test(file));
  for (const file of toolFiles) {
    const source = await at(root, sha, file);
    const names = new Set([
      ...[...source.matchAll(/registerTool\(\s*["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]),
      ...[...source.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1])
    ]);
    const sourceBlob = await blob(root, sha, file);
    for (const name of names) {
      const fact = row('mcp', name, { value: `Registered MCP tool (${file.slice('mcp/tools/'.length, -3)})`, status: 'verified', source: file, sourceBlob });
      if (!existing.has(fact.id)) { facts.push(fact); existing.add(fact.id); }
    }
  }

  for (const name of ['llamacpp', 'anthropic', 'deepseek', 'gemini', 'claude-code', 'codex']) {
    const fact = row('provider', name, { value: name === 'llamacpp' ? 'Local inference lane' : 'Configured provider lane; credentials and service availability are external', status: 'present-unverified', source: 'lib/providers/index.js', sourceBlob: await blob(root, sha, 'lib/providers/index.js') });
    if (!existing.has(fact.id)) { facts.push(fact); existing.add(fact.id); }
  }
  return normalizeDataset(facts, {
    schemaVersion: 1,
    generator: 'manual-part-i-authority@1',
    productVersion: edition.product.version,
    productTag: edition.product.tag,
    productSha: sha,
    sourceBlobs: [...new Set(facts.map((fact) => `${fact.source}:${fact.sourceBlob}`))].sort(),
    sort: 'stable ID, en collation',
    generatedAt: new Date(0).toISOString()
  });
}
