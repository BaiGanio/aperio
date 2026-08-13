import test from 'node:test';
import assert from 'node:assert/strict';
import { book } from '../../../../manual/src/en/book.mjs';
import { firstRecall } from '../../../../manual/src/en/chapters/01-first-recall.mjs';
import { memoryKnowledge } from '../../../../manual/src/en/chapters/03-memory-knowledge.mjs';
import { conversationsSessionsAgents } from '../../../../manual/src/en/chapters/04-conversations-sessions-agents.mjs';
import { toolsFilesArtifacts } from '../../../../manual/src/en/chapters/05-tools-files-artifacts.mjs';
import { codeDocumentKnowledge } from '../../../../manual/src/en/chapters/06-code-document-knowledge.mjs';
import { connectAgentClient } from '../../../../manual/src/en/chapters/07-connect-agent-client.mjs';
import { integrationsExternalData } from '../../../../manual/src/en/chapters/08-integrations-external-data.mjs';
import { agentsAutomation } from '../../../../manual/src/en/chapters/09-agents-automation.mjs';
import { installDeploy } from '../../../../manual/src/en/chapters/10-install-deploy.mjs';
import { configure } from '../../../../manual/src/en/chapters/11-configure.mjs';
import { storageHealth } from '../../../../manual/src/en/chapters/12-storage-health.mjs';
import { privacySecurity } from '../../../../manual/src/en/chapters/13-privacy-security.mjs';
import { lifecycle } from '../../../../manual/src/en/chapters/14-lifecycle.mjs';
import { contributorWorkstation } from '../../../../manual/src/en/chapters/15-contributor-workstation.mjs';
import { changeSafely } from '../../../../manual/src/en/chapters/16-change-safely.mjs';
import { verifyRelease } from '../../../../manual/src/en/chapters/17-verify-release.mjs';
import { troubleshoot } from '../../../../manual/src/en/chapters/18-troubleshoot.mjs';
import { evidenceEscalate } from '../../../../manual/src/en/chapters/19-evidence-escalate.mjs';
import { releaseSupport } from '../../../../manual/src/en/chapters/20-release-support.mjs';
import { configurationCatalog } from '../../../../manual/src/en/chapters/21-configuration-catalog.mjs';
import { commandsChecks } from '../../../../manual/src/en/chapters/22-commands-checks.mjs';
import { capabilityCatalog } from '../../../../manual/src/en/chapters/23-capability-catalog.mjs';
import { dataPortability } from '../../../../manual/src/en/chapters/24-data-portability.mjs';
import { glossary } from '../../../../manual/src/en/chapters/25-glossary.mjs';
import { fullIndex } from '../../../../manual/src/en/chapters/26-index.mjs';

test('canonical shell has exact route, topic, role, part, and chapter counts', () => {
  assert.equal(book.taskRoutes.length, 7);
  assert.equal(book.topics.length, 10);
  assert.equal(book.roles.length, 4);
  assert.equal(book.parts.length, 7);
  assert.equal(book.parts.flatMap((part) => part.chapters).length, 26);
});

test('Chapters 10-11 bound installation support and configuration precedence', () => {
  for (const chapter of [installDeploy, configure]) {
    assert.ok(chapter.sections.length >= 2);
    assert.equal(chapter.procedures.length, 1);
    for (const field of ['warning', 'start', 'steps', 'success', 'recovery', 'reversal', 'next']) assert.ok(chapter.procedures[0][field]?.length, `${chapter.id} missing ${field}`);
  }
  assert.match(installDeploy.applicability.interfaces, /not release-verified/i);
  assert.match(installDeploy.sections[0].paragraphs.join(' '), /production Compose.*not presented/i);
  assert.match(configure.procedures[0].success, /DB-first precedence.*env override/i);
});

test('Chapters 12-14 own layered health, security, and recoverable backup', () => {
  for (const chapter of [storageHealth, privacySecurity, lifecycle]) {
    assert.ok(chapter.sections.length >= 2);
    assert.equal(chapter.procedures.length, 1);
    for (const field of ['warning', 'start', 'steps', 'success', 'recovery', 'reversal', 'next']) assert.ok(chapter.procedures[0][field]?.length, `${chapter.id} missing ${field}`);
  }
  assert.match(storageHealth.procedures[0].steps.at(-1).action, /graceful shutdown/i);
  assert.match(privacySecurity.procedures[0].warning, /real secret/i);
  assert.match(lifecycle.sections[0].title, /not a full backup/i);
  assert.match(lifecycle.procedures[0].warning, /Portable export\/import is not this backup/i);
});

test('Chapters 15-17 preserve task scope and separate candidate evidence from release authority', () => {
  for (const chapter of [contributorWorkstation, changeSafely, verifyRelease]) {
    assert.ok(chapter.sections.length >= 2);
    assert.equal(chapter.procedures.length, 1);
    for (const field of ['warning', 'start', 'steps', 'success', 'recovery', 'reversal', 'next']) assert.ok(chapter.procedures[0][field]?.length, `${chapter.id} missing ${field}`);
  }
  assert.match(contributorWorkstation.procedures[0].warning, /another session/i);
  assert.match(changeSafely.procedures[0].steps.at(-1).action, /lifecycle leaks/i);
  assert.match(verifyRelease.procedures[0].warning, /does not authorize signing, publication, upload/i);
});

test('Chapters 18-19 provide symptom records and a redacted escalation contract', () => {
  assert.equal(troubleshoot.records.length, 3);
  assert.equal(evidenceEscalate.records.length, 1);
  assert.match(troubleshoot.procedures[0].warning, /Do not delete, reinstall, migrate, rotate keys/i);
  assert.match(evidenceEscalate.procedures[0].warning, /Do not attach a full database/i);
  assert.match(evidenceEscalate.procedures[0].success, /no recoverable secret/i);
});

test('Chapters 20-24 wrap generated reference projections without owning factual rows', () => {
  for (const chapter of [releaseSupport, configurationCatalog, commandsChecks, capabilityCatalog, dataPortability]) {
    assert.ok(chapter.sections.length >= 2);
    assert.equal(chapter.procedures.length, 1);
    assert.ok(chapter.generatedProjection.query.ids || chapter.generatedProjection.query.family);
  }
  assert.equal(configurationCatalog.generatedProjection.query.family, 'config');
  assert.equal(commandsChecks.generatedProjection.query.family, 'command');
  assert.equal(capabilityCatalog.generatedProjection.query.family, 'mcp');
  assert.match(dataPortability.sections[0].paragraphs.join(' '), /unsuitable as the sole backup/i);
});

test('Chapters 25-26 provide offline glossary and generated index contracts', () => {
  assert.ok(glossary.terms.length >= 25);
  assert.ok(glossary.aliases.length >= 8);
  for (const [, canonical] of glossary.aliases) assert.ok(glossary.terms.some(([term]) => term === canonical), `unknown glossary alias target: ${canonical}`);
  assert.match(glossary.terms.find(([term]) => term === 'Portable export')[1], /not a full backup/i);
  assert.match(fullIndex.purpose, /every authored chapter, concept, symptom record, checklist, procedure, glossary term, and factual catalog family/i);
  assert.match(fullIndex.sections[1].paragraphs.join(' '), /Color, images, hover, animation, and network are never required/i);
  assert.deepEqual(Object.keys(fullIndex.backMatter), ['license', 'acknowledgments', 'support']);
  assert.match(fullIndex.backMatter.license.provenance, /LICENSE.*v0\.68\.0 product pin/i);
  assert.match(fullIndex.backMatter.acknowledgments.paragraphs.join(' '), /release rights record.*remain external candidate blockers/i);
  assert.match(fullIndex.backMatter.support.paragraphs.join(' '), /complete offline/i);
  assert.ok(fullIndex.backMatter.support.links.some(([label]) => /changelog/i.test(label)));
});

test('Chapters 5 and 6 keep file and graph operations bounded and recoverable', () => {
  for (const chapter of [toolsFilesArtifacts, codeDocumentKnowledge]) {
    assert.ok(chapter.sections.length >= 2);
    for (const procedure of chapter.procedures) {
      for (const field of ['warning', 'start', 'steps', 'success', 'recovery', 'reversal', 'next']) assert.ok(procedure[field]?.length, `${procedure.id} missing ${field}`);
    }
  }
  assert.match(toolsFilesArtifacts.procedures[0].success, /denied/i);
  assert.match(codeDocumentKnowledge.procedures[0].reversal, /graph roots first/i);
});

test('Chapters 3 and 4 are authored and every procedure carries the canonical recovery contract', () => {
  for (const chapter of [memoryKnowledge, conversationsSessionsAgents]) {
    assert.ok(chapter.purpose.length > 40);
    assert.ok(chapter.sections.length >= 2);
    for (const procedure of chapter.procedures) {
      for (const field of ['id', 'audience', 'goal', 'prerequisites', 'platforms', 'warning', 'start', 'steps', 'success', 'result', 'recovery', 'reversal', 'next', 'returns']) {
        assert.ok(procedure[field]?.length ?? procedure[field], `${procedure.id} missing ${field}`);
      }
    }
  }
  assert.match(memoryKnowledge.procedures[0].warning, /synthetic/i);
  assert.equal(memoryKnowledge.procedures[1].id, 'procedure.synthesize-wiki-article');
  assert.match(memoryKnowledge.procedures[1].success, /stable slug.*revision.*source count/i);
  assert.match(conversationsSessionsAgents.procedures[0].reversal, /no reversal/i);
  assert.equal(conversationsSessionsAgents.procedures[1].id, 'procedure.inspect-inactive-agent-job');
  assert.match(conversationsSessionsAgents.procedures[1].warning, /Do not enable APERIO_AGENT_JOBS|Do not.*Run now/i);
  assert.match(conversationsSessionsAgents.sections[0].rules.join(' '), /SpeechRecognition API.*browser vendor.*ordinary chat and session path/i);
});

test('Chapters 3 and 4 teach concrete reader scenarios with observable examples', () => {
  for (const chapter of [memoryKnowledge, conversationsSessionsAgents]) {
    assert.ok(chapter.workedExamples.length >= 2, `${chapter.id} lacks worked examples`);
    for (const example of chapter.workedExamples) {
      for (const field of ['for', 'situation', 'why', 'failure', 'cleanup', 'takeaway']) assert.ok(example[field]?.length, `${example.id} missing ${field}`);
      assert.ok(example.exchanges.length >= 2, `${example.id} needs a multi-step example`);
      for (const exchange of example.exchanges) {
        for (const field of ['speaker', 'text', 'call', 'input', 'expect', 'explains']) assert.ok(exchange[field]?.length, `${example.id} exchange missing ${field}`);
      }
    }
  }
  assert.match(memoryKnowledge.workedExamples[0].exchanges[1].expect, /new id/i);
  assert.match(memoryKnowledge.workedExamples[1].exchanges[1].input, /source_memory_ids/);
  assert.match(conversationsSessionsAgents.workedExamples[0].cleanup, /child.*source/i);
  assert.match(conversationsSessionsAgents.workedExamples[1].takeaway, /Definition, trigger, run, interrupt, result, and cleanup/i);
});

test('all Part I procedures carry orientation, success, recovery, and reversal', () => {
  for (const procedure of firstRecall.procedures) {
    for (const field of ['id', 'audience', 'goal', 'prerequisites', 'platforms', 'start', 'steps', 'success', 'result', 'recovery', 'reversal', 'next', 'returns']) {
      assert.ok(procedure[field]?.length ?? procedure[field], `${procedure.id} missing ${field}`);
    }
  }
  assert.match(firstRecall.procedures.at(-1).success, /fresh conversation/i);
});

test('Chapters 7-9 own one connection procedure and guarded external automation lifecycles', () => {
  for (const chapter of [connectAgentClient, integrationsExternalData, agentsAutomation]) {
    assert.ok(chapter.sections.length >= 2);
    assert.ok(chapter.procedures.length + (chapter.procedureLinks?.length ?? 0) > 0);
    for (const procedure of chapter.procedures) for (const field of ['warning', 'start', 'steps', 'success', 'recovery', 'reversal', 'next']) assert.ok(procedure[field]?.length, `${chapter.id} missing ${field}`);
  }
  assert.deepEqual(connectAgentClient.procedureLinks, ['procedure.connect-agent', 'procedure.prove-first-recall']);
  assert.match(integrationsExternalData.procedures[0].result, /authentication.*egress.*confirmation.*interruption.*ownership.*cleanup/i);
  assert.match(agentsAutomation.procedures[0].reversal, /worker.*watcher.*timer.*provider request/i);
});
