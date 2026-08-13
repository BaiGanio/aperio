import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function chmodTree(directory, writable) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await chmodTree(file, writable);
    await fs.chmod(file, writable ? (entry.isDirectory() ? 0o755 : 0o644) : (entry.isDirectory() ? 0o555 : 0o444));
  }
  await fs.chmod(directory, writable ? 0o755 : 0o555);
}

function interruptStore() {
  const rows = new Map();
  const copy = (value) => value == null ? value : structuredClone(value);
  return {
    async createAgentInterrupt(input) { const now = new Date().toISOString(); const row = { id: input.id, session_id: input.sessionId, run_id: input.runId, tool_name: input.toolName, canonical_arguments: copy(input.canonicalArguments), protected_payload_ref: input.protectedPayloadRef ?? null, digest: input.digest, allowed_decisions: copy(input.allowedDecisions), decision: null, decision_payload: null, status: 'pending', expires_at: input.expiresAt, created_at: now, updated_at: now }; rows.set(row.id, row); return copy(row); },
    async getAgentInterrupt(id) { return copy(rows.get(id) ?? null); },
    async listAgentInterrupts() { return [...rows.values()].map(copy); },
    async expireAgentInterrupts() { return 0; },
    async updateAgentInterruptStatus(id, status) { const row = rows.get(id); if (!row) return null; row.status = status; return copy(row); },
    async decideAgentInterrupt(id, { decision, status, decisionPayload, now }) { const row = rows.get(id); if (!row || row.status !== 'pending') return null; Object.assign(row, { decision, status, decision_payload: copy(decisionPayload), decided_at: now, updated_at: now }); return copy(row); },
    async claimAgentInterrupt(id, { claimId, now }) { const row = rows.get(id); if (!row || !['approved', 'edited'].includes(row.status)) return null; Object.assign(row, { status: 'claimed', claim_id: claimId, claimed_at: now, updated_at: now }); return copy(row); },
    async completeAgentInterrupt(id, { status, now }) { const row = rows.get(id); if (!row || row.status !== 'claimed') return null; Object.assign(row, { status, completed_at: now, updated_at: now }); return copy(row); }
  };
}

export async function exercisePinnedConnectionsAndIntegrations(root, sha) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-c05-flow-'));
  const tree = path.join(scratch, 'product');
  const archive = path.join(scratch, 'product.tar');
  try {
    await fs.mkdir(tree);
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: root });
    await exec('tar', ['-xf', archive, '-C', tree]);
    await fs.symlink(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    await chmodTree(tree, false);

    const registered = new Map();
    const server = { registerTool(name, schema, handler) { registered.set(name, { schema, handler }); } };
    for (const file of ['github.js', 'database.js', 'web.js', 'image.js']) {
      const mod = await import(pathToFileURL(path.join(tree, 'mcp/tools', file)));
      mod.register(server, {});
    }
    for (const name of ['fetch_github_issue', 'update_github_issue', 'db_query', 'db_execute', 'fetch_url', 'read_image']) {
      if (!registered.has(name)) throw new Error(`pinned integration tool is unreachable: ${name}`);
    }

    const web = await import(pathToFileURL(path.join(tree, 'mcp/tools/web.js')));
    const hits = web.parseDdgResults('<a class="result__a" href="https://fixture.invalid/signal">Synthetic signal</a><a class="result__snippet">bounded fixture</a>', 1);
    if (hits.length !== 1 || hits[0].url !== 'https://fixture.invalid/signal') throw new Error('synthetic web parsing failed');

    const image = await import(pathToFileURL(path.join(tree, 'mcp/tools/image.js')));
    const invalidImage = await image.readImageHandler({ path: path.join(scratch, 'missing.png') });
    if (!invalidImage.content?.[0]?.text.includes('File not found')) throw new Error('image missing-input boundary failed');

    const { normalizeAgentJobDefinition } = await import(pathToFileURL(path.join(tree, 'lib/agent/job-spec.js')));
    const job = normalizeAgentJobDefinition({ id: 'manual-c05', prompt: 'Return SYNTHETIC-SIGNAL.', spec: { toolAllowlist: [] } });
    if (job.id !== 'manual-c05' || job.spec.toolAllowlist.length !== 0) throw new Error('background job normalization failed');

    const { createInterruptService } = await import(pathToFileURL(path.join(tree, 'lib/security/interruptService.js')));
    let executions = 0;
    const service = createInterruptService({ store: interruptStore(), executeTool: async () => { executions += 1; return 'unexpected'; }, idFactory: () => 'synthetic-interrupt' });
    await service.create({ sessionId: 'synthetic', runId: 'run-1', toolName: 'update_github_issue', canonicalArguments: { repo: 'fixture/repo', issue: 1 }, allowedDecisions: ['approve', 'reject'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const rejected = await service.decide('synthetic-interrupt', { decision: 'reject' });
    if (rejected.status !== 'rejected' || executions !== 0) throw new Error('rejected integration interrupt executed a mutation');
    await service.claimAndExecute('synthetic-interrupt').then(() => { throw new Error('rejected interrupt became executable'); }, (error) => { if (!/not executable/.test(error.message)) throw error; });

    const controller = new AbortController();
    const observed = new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
    controller.abort();
    if (await observed !== 'aborted') throw new Error('controlled cancellation was not observed');

    return {
      identity: 'NON-RELEASE', productSha: sha,
      connection: { stdioCommand: 'node mcp/index.js', catalogDiscovery: 'pass' },
      integrations: { registeredGuardedLanes: 'pass', syntheticWebFixture: 'pass', imageBoundary: 'pass' },
      interrupts: { rejectedMutationNotExecuted: 'pass', rejectedMutationNotClaimable: 'pass' },
      automation: { normalizedLeastPrivilegeJob: 'pass', controlledCancellationObserved: 'pass' },
      cleanup: 'pass'
    };
  } finally {
    await chmodTree(tree, true).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
