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

export async function exercisePinnedDailyUse(root, sha) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-c03-flow-'));
  const tree = path.join(scratch, 'product');
  const archive = path.join(scratch, 'product.tar');
  let store;
  const priorEnv = Object.fromEntries(['SQLITE_PATH', 'APERIO_DB_ENCRYPT', 'AI_PROVIDER'].map((key) => [key, process.env[key]]));
  try {
    await fs.mkdir(tree);
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, sha], { cwd: root });
    await exec('tar', ['-xf', archive, '-C', tree]);
    await fs.symlink(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
    await chmodTree(tree, false);

    process.env.SQLITE_PATH = ':memory:';
    process.env.APERIO_DB_ENCRYPT = 'off';
    process.env.AI_PROVIDER = 'llamacpp';
    const { SqliteStore } = await import(pathToFileURL(path.join(tree, 'db/sqlite.js')));
    const { rememberHandler, recallHandler, updateMemoryHandler, forgetHandler } = await import(pathToFileURL(path.join(tree, 'lib/handlers/memory/memoryHandlers.js')));
    const { wikiSearchHandler, wikiWriteHandler, wikiGetHandler } = await import(pathToFileURL(path.join(tree, 'lib/handlers/wiki/wikiHandlers.js')));
    store = await SqliteStore.init();
    const context = { store, generateEmbedding: async () => null, vectorEnabled: () => false, providerIsLocal: true };
    const remembered = await rememberHandler(context, { title: 'Manual C03 synthetic record', content: 'Review token cobalt-17.', tags: ['manual-c03'], tier: 1, source: 'manual-c03-synthetic' });
    const originalId = remembered.content[0].text.match(/id: ([0-9a-f-]+)/)?.[1];
    if (!originalId) throw new Error('daily-use flow did not receive the original memory ID');
    const found = await recallHandler(context, { query: 'cobalt-17', search_mode: 'fulltext' });
    if (!found.content[0].text.includes(originalId)) throw new Error('daily-use flow did not find the original memory');
    const updated = await updateMemoryHandler(context, { id: originalId, content: 'Review token cobalt-18.' });
    const replacementId = updated.content[0].text.match(/new id: ([0-9a-f-]+)/)?.[1];
    if (!replacementId || replacementId === originalId) throw new Error('daily-use flow did not create a replacement version');
    const corrected = await recallHandler(context, { query: 'cobalt-18', search_mode: 'fulltext' });
    if (!corrected.content[0].text.includes(replacementId)) throw new Error('daily-use flow did not find the replacement memory');
    await forgetHandler(context, { id: replacementId });
    const removed = await recallHandler(context, { query: 'cobalt', search_mode: 'fulltext' });
    if (removed.content[0].text !== 'No memories found.') throw new Error('daily-use flow left a current synthetic memory');

    const sensitiveIds = [];
    for (const [tier, content] of [[2, 'Synthetic sensitive amber-two.'], [3, 'Synthetic private amber-three.']]) {
      const response = await rememberHandler(context, { title: `Manual C03 tier ${tier}`, content, tags: ['manual-c03-sensitive'], tier, source: 'manual-c03-synthetic' });
      const id = response.content[0].text.match(/id: ([0-9a-f-]+)/)?.[1];
      if (!id) throw new Error(`provider-lane flow did not receive tier-${tier} memory ID`);
      sensitiveIds.push(id);
    }
    const localRows = await recallHandler(context, { tags: ['manual-c03-sensitive'], search_mode: 'fulltext' });
    if (!localRows.content[0].text.includes('amber-two') || !localRows.content[0].text.includes('amber-three')) throw new Error('local provider lane did not return permitted tiers');
    const cloudRows = await recallHandler({ ...context, providerIsLocal: false }, { tags: ['manual-c03-sensitive'], search_mode: 'fulltext' });
    if (cloudRows.content[0].text !== 'No memories found.') throw new Error('cloud provider lane exposed withheld/private synthetic memories');
    for (const id of sensitiveIds) await forgetHandler(context, { id });

    const wikiSourceIds = [];
    for (const [title, content] of [['Manual C03 garden goal', 'Ship a soil-moisture alert.'], ['Manual C03 garden decision', 'Store readings in SQLite.'], ['Manual C03 garden milestone', 'Test the threshold outdoors.']]) {
      const response = await rememberHandler(context, { title, content, tags: ['manual-c03-wiki'], tier: 1, source: 'manual-c03-synthetic' });
      const id = response.content[0].text.match(/id: ([0-9a-f-]+)/)?.[1];
      if (!id) throw new Error('wiki synthesis flow did not receive a source memory ID');
      wikiSourceIds.push(id);
    }
    const absentArticle = await wikiSearchHandler(context, { query: 'garden sensor handoff', mode: 'fulltext', limit: 5 });
    if (!absentArticle.content[0].text.startsWith('No wiki articles matched')) throw new Error('wiki synthesis preflight found an unexpected article');
    const wikiBody = `## Goal\nShip a soil-moisture alert [[mem:${wikiSourceIds[0]}]].\n\n## Decision\nStore readings in SQLite [[mem:${wikiSourceIds[1]}]].\n\n## Next milestone\nTest the threshold outdoors [[mem:${wikiSourceIds[2]}]].`;
    const written = await wikiWriteHandler(context, { slug: 'manual-c03-garden-sensor-handoff', title: 'Manual C03 garden sensor handoff', summary: 'Synthetic cited handoff.', body_md: wikiBody, tags: ['manual-c03'], source_memory_ids: wikiSourceIds });
    if (!written.content[0].text.includes('sources: 3') || written.content[0].text.includes('omitted')) throw new Error('wiki synthesis did not retain all source citations');
    const fetched = await wikiGetHandler(context, { slug: 'manual-c03-garden-sensor-handoff' });
    if (!fetched.content[0].text.includes('rev 1 · fresh') || !wikiSourceIds.every((id) => fetched.content[0].text.includes(id))) throw new Error('wiki synthesis retrieval lost its revision or citations');
    const revised = await wikiWriteHandler(context, { slug: 'manual-c03-garden-sensor-handoff', title: 'Manual C03 garden sensor handoff', summary: 'Synthetic cited handoff, reviewed.', body_md: wikiBody, tags: ['manual-c03'], source_memory_ids: wikiSourceIds });
    if (!revised.content[0].text.includes('Updated (rev 2)') || !revised.content[0].text.includes('sources: 3')) throw new Error('wiki synthesis did not revise the stable slug');
    for (const id of wikiSourceIds) await forgetHandler(context, { id });

    const sessions = await import(pathToFileURL(path.join(tree, 'lib/helpers/sessions.js')));
    const { handleBranchConversation } = await import(pathToFileURL(path.join(tree, 'lib/emitters/handlers/ws/session.js')));
    const runtime = path.join(scratch, 'runtime');
    sessions.init(runtime);
    const sessionId = sessions.createSession({ model: 'synthetic-model', provider: 'llamacpp', source: 'web' });
    if (sessions.getSession(sessionId)?.source !== 'web') throw new Error('session create/get boundary failed');
    const terminalSessionId = sessions.createSession({ model: 'synthetic-model', provider: 'llamacpp', source: 'terminal' });
    if (sessions.getSession(terminalSessionId)?.source !== 'terminal') throw new Error('terminal interface session source failed');
    if (!sessions.pinSession(sessionId, true) || !sessions.listSessions({ page: 1, limit: 10 }).sessions.some((item) => item.id === sessionId && item.pinned)) {
      throw new Error('session pin/list boundary failed');
    }
    const branchMessages = [{ role: 'system', content: 'Synthetic internal greeting.' }];
    for (let index = 0; index < 4; index += 1) {
      branchMessages.push({ role: 'user', content: `Garden sensor design detail ${index}: compare a harmless threshold.` });
      branchMessages.push({ role: 'assistant', content: `Synthetic design response ${index}.` });
    }
    const branchEvents = [];
    const branchResult = await handleBranchConversation({
      messages: branchMessages,
      sessionId,
      msgAttachments: new WeakMap(),
      sessionHadAttachments: false,
      provider: () => ({ model: 'synthetic-model', name: 'llamacpp' }),
      send: (type, payload) => branchEvents.push({ type, payload }),
      sessionLogger: null,
    });
    const branchEvent = branchEvents.find((event) => event.type === 'session_branched')?.payload;
    if (!branchResult?.sessionId || !branchEvent?.ok || branchEvent.parentId !== sessionId || branchEvent.id !== branchResult.sessionId) throw new Error('session branch did not report distinct child and parent identities');
    const child = sessions.getSession(branchResult.sessionId);
    if (child?.parentId !== sessionId || child?.source !== 'web') throw new Error('session branch did not persist its bounded parent relationship');
    const resumeContext = sessions.buildResumeContext(sessions.getSession(sessionId));
    if (!/last exchanges|what was covered/i.test(resumeContext) || !resumeContext.includes('Garden sensor design')) throw new Error('session resume context did not use the saved compact source');
    if (!sessions.deleteSession(branchResult.sessionId) || sessions.getSession(branchResult.sessionId) || !sessions.getSession(sessionId)) throw new Error('session branch cleanup damaged the source');
    if (!sessions.deleteSession(sessionId) || sessions.getSession(sessionId) || !sessions.deleteSession(terminalSessionId)) throw new Error('session exact-ID cleanup failed');

    const syntheticJobId = 'manual-c03-inactive-job';
    await store.upsertAgentJob({ id: syntheticJobId, enabled: false, steps: [{ tool: 'recall', input: { limit: 1 } }], trigger: { kind: 'manual' }, owner: 'manual synthetic verification' });
    const storedJob = await store.getAgentJob(syntheticJobId);
    const jobRuns = await store.listAgentRuns(syntheticJobId, 5);
    if (!storedJob || storedJob.enabled !== false || jobRuns.length !== 0) throw new Error('inactive agent definition was confused with execution');
    if (!await store.deleteAgentJob(syntheticJobId) || await store.getAgentJob(syntheticJobId)) throw new Error('inactive agent definition exact-ID cleanup failed');

    return {
      identity: 'NON-RELEASE', productSha: sha, storage: ':memory:',
      memory: { store: 'pass', search: 'pass', versionedCorrection: 'pass', exactIdDeletion: 'pass' },
      knowledge: { searchBeforeWrite: 'pass', citedSynthesis: 'pass', stableSlugRevision: 'pass', isolatedCleanup: 'pass' },
      session: { browserCreateGet: 'pass', terminalCreateGet: 'pass', pinAndList: 'pass', branchAndResumeContext: 'pass', childOnlyDeletion: 'pass', exactIdDeletion: 'pass' },
      agent: { inactiveDefinition: 'pass', emptyRunHistory: 'pass', exactIdDeletion: 'pass' },
      providerLanes: { localTierVisibility: 'pass', cloudSensitiveWithhold: 'pass', privateNeverLeaves: 'pass' }
    };
  } finally {
    if (store) await store.close();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await chmodTree(tree, true).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
