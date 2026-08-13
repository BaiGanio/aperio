import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractPartIFacts } from '../../../../manual/generators/authority/index.mjs';
import { loadPreviewEdition } from '../../../../manual/lib/edition/index.mjs';
import { project, applyOverlay } from '../../../../manual/lib/data/index.mjs';
import { configurationCatalog } from '../../../../manual/src/en/chapters/21-configuration-catalog.mjs';
import { commandsChecks } from '../../../../manual/src/en/chapters/22-commands-checks.mjs';
import { capabilityCatalog } from '../../../../manual/src/en/chapters/23-capability-catalog.mjs';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../../..');

test('reference catalogs exhaustively reconcile with pinned registries and reject factual overlays', async () => {
  const edition = await loadPreviewEdition(root);
  const dataset = await extractPartIFacts(root, edition);
  const configRows = project(dataset, configurationCatalog.generatedProjection.query);
  const commandRows = project(dataset, commandsChecks.generatedProjection.query);
  const capabilityRows = project(dataset, capabilityCatalog.generatedProjection.query);
  assert.equal(configRows.length, 112);
  const { stdout } = await exec('git', ['show', `${edition.product.sha}:package.json`], { cwd: root });
  const pinnedScripts = JSON.parse(stdout).scripts;
  assert.deepEqual(commandRows.map((row) => row.name).sort(), Object.keys(pinnedScripts).sort());
  assert.ok(capabilityRows.length >= 30, `unexpectedly incomplete MCP catalog: ${capabilityRows.length}`);
  assert.equal(new Set(dataset.rows.map((row) => row.id)).size, dataset.rows.length);
  assert.ok(dataset.rows.every((row) => row.source && row.sourceBlob));
  const license = dataset.rows.find((row) => row.id === 'legal.license');
  assert.equal(license.status, 'verified');
  assert.equal(license.source, 'LICENSE');
  assert.throws(() => applyOverlay(configRows[0], { value: 'editorial override' }), /factual overlay write/);
  assert.throws(() => applyOverlay(commandRows[0], { status: 'verified-by-prose' }), /factual overlay write/);
});
