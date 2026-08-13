import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { loadContracts } from '../lib/contracts/index.mjs';
import { loadPreviewEdition } from '../lib/edition/index.mjs';
import { extractPartIFacts } from '../generators/authority/index.mjs';
import { renderHtml, reviewChecklistMarkdown } from '../render/html/index.mjs';
import { renderPdf, captureHtmlReview } from '../render/pdf/index.mjs';
import { verifyPdf } from '../verify/pdf/index.mjs';
import { exercisePinnedFirstRecall } from '../verify/flow/pinned-first-recall.mjs';
import { exercisePinnedDailyUse } from '../verify/flow/pinned-daily-use.mjs';
import { exercisePinnedFilesAndGraphs } from '../verify/flow/pinned-files-graphs.mjs';
import { exercisePinnedConnectionsAndIntegrations } from '../verify/flow/pinned-connections-integrations.mjs';
import { exercisePinnedInstallAndConfig } from '../verify/flow/pinned-install-config.mjs';
import { exercisePinnedStorageRecovery } from '../verify/flow/pinned-storage-recovery.mjs';
import { loadPreviewAssets } from '../preview/assets.mjs';

const exec = promisify(execFile);

async function verifyHtml(html) {
  if (!html.startsWith('<!doctype html>') || !html.includes('<html lang="en"')) throw new Error('semantic HTML identity invalid');
  if ((html.match(/NON-RELEASE/g) || []).length < 5) throw new Error('preview markings are incomplete');
  if (/<strong[\s>]/i.test(html)) throw new Error('Chromium /Strong regression source detected');
  for (const tag of ['<main', '<section', '<article', '<nav', '<figure', '<figcaption', '<table', '<thead', '<th']) {
    if (!html.includes(tag)) throw new Error(`semantic HTML missing ${tag}`);
  }
  const idList = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const ids = new Set(idList);
  if (ids.size !== idList.length) throw new Error('duplicate semantic HTML ID detected');
  for (const match of html.matchAll(/href="#([^"]+)"/g)) if (!ids.has(match[1])) throw new Error(`broken internal anchor: ${match[1]}`);
  const pages = [...html.matchAll(/<section class="manual-page[^>]*>([\s\S]*?)<\/section>/g)];
  if (!pages.length || pages.some((match) => !match[1].includes('NON-RELEASE'))) throw new Error('every English HTML page must visibly say NON-RELEASE');
  for (const required of ['aurora-window', 'part-opener', 'route-panel', 'procedure', 'platform-lanes', 'screenshot-frame', 'signal-flow', 'mascot-guide', 'console-box', 'generated-catalog']) {
    if (!html.includes(required)) throw new Error(`approved treatment missing ${required}`);
  }
  if (/pseudolocale[^<]*(?:href|src)=/i.test(html) || /href="(?!#)[^"]*pseudolocale/i.test(html)) throw new Error('English review entry point exposes pseudolocale artifact');
  const localAssetRefs = [...html.matchAll(/(?:src|url\()=["']?(?!data:|https?:|#)([^"')]+)/g)];
  if (localAssetRefs.length) throw new Error(`standalone HTML has local asset dependencies: ${localAssetRefs.map((item) => item[1]).join(', ')}`);
  return { ids: ids.size, pages: pages.length, internalLinks: [...html.matchAll(/href="#/g)].length, externalLinks: [...html.matchAll(/href="https:\/\//g)].length, standalone: true };
}

async function renderPages(pdf, directory, prefix) {
  await fs.mkdir(directory, { recursive: true });
  await exec('pdftoppm', ['-png', '-r', '120', pdf, path.join(directory, prefix)], { maxBuffer: 8 * 1024 * 1024 });
  return (await fs.readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith('.png')).sort();
}

async function contactSheet(files, outputFile) {
  const columns = 4;
  const cellWidth = 250;
  const cellHeight = 355;
  const rows = Math.ceil(files.length / columns);
  const composites = [];
  for (const [index, file] of files.entries()) {
    const left = (index % columns) * cellWidth + 15;
    const top = Math.floor(index / columns) * cellHeight;
    const thumb = await sharp(file).resize({ width: 220, height: 315, fit: 'inside', background: '#ffffff' }).png().toBuffer();
    composites.push({ input: thumb, left, top: top + 28 });
    composites.push({ input: Buffer.from(`<svg width="220" height="24"><rect width="220" height="24" fill="#151020"/><text x="8" y="17" fill="#fff" font-family="Arial" font-size="12">NON-RELEASE / PAGE ${index + 1}</text></svg>`), left, top });
  }
  await sharp({ create: { width: columns * cellWidth, height: rows * cellHeight, channels: 3, background: '#e8e3ef' } }).composite(composites).png().toFile(outputFile);
}

async function artifact(file, root) {
  const bytes = await fs.readFile(file);
  return { path: path.relative(root, file), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), identity: 'NON-RELEASE', releaseEvidence: false };
}

async function assertNoPseudoClipping(html) {
  if (/text-overflow:\s*ellipsis/.test(html)) throw new Error('pseudolocale clipping rule detected');
  if (/<img[^>]+table/i.test(html)) throw new Error('rasterized table detected');
}

export async function buildPreview(root, { outputRoot = path.join(root, 'manual/preview-output/part-i'), htmlOnly = false } = {}) {
  const lockPath = path.join(os.tmpdir(), 'aperio-manual-part-i-preview.lock');
  const lock = await fs.open(lockPath, 'wx').catch((error) => { throw new Error(`same-edition build contention: ${error.message}`); });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-preview-'));
  const phases = [];
  try {
    phases.push('resolve');
    const edition = await loadPreviewEdition(root);
    phases.push('acquire');
    const productType = await exec('git', ['cat-file', '-t', edition.product.sha], { cwd: root });
    if (productType.stdout.trim() !== 'commit') throw new Error('product pin is not locally acquired');
    phases.push('preflight');
    await loadContracts(root);
    phases.push('generate');
    const dataset = await extractPartIFacts(root, edition);
    const previewAssets = await loadPreviewAssets(root);
    phases.push('assemble');
    const html = await renderHtml({ edition, dataset, assets: previewAssets.assets });
    const pseudoHtml = await renderHtml({ edition, dataset, assets: previewAssets.assets, pseudo: true });
    phases.push('html');
    const htmlReport = await verifyHtml(html);
    await assertNoPseudoClipping(pseudoHtml);
    const htmlFile = path.join(scratch, 'aperio-manual-part-i-NON-RELEASE.html');
    await fs.writeFile(htmlFile, html);
    const qaRoot = path.join(scratch, 'evidence/internal');
    const pseudoRoot = path.join(qaRoot, 'pseudolocale');
    await fs.mkdir(pseudoRoot, { recursive: true });
    const pseudoHtmlFile = path.join(pseudoRoot, 'aperio-manual-part-i-pseudolocale-NON-RELEASE.html');
    await fs.writeFile(pseudoHtmlFile, pseudoHtml);
    await fs.writeFile(path.join(scratch, 'REVIEW-CHECKLIST-NON-RELEASE.md'), reviewChecklistMarkdown());
    const report = {
      identity: 'NON-RELEASE', mode: 'preview', edition, phases, html: htmlReport,
      facts: { rows: dataset.rows.length, semanticHash: dataset.provenance.semanticHash },
      assets: previewAssets.manifest,
      treatment: {
        coverAndPartOpeners: 'Night Receiver',
        ordinaryInterior: 'Signal Desk',
        denseServiceMaterial: 'Field Console',
        authority: 'approved prototype family',
        source: 'manual/styles/visual-system.mjs',
        approval: 'maintainer approval recorded 2026-08-13 for manual/preview-output/part-i',
        integrationAuthorized: true
      },
      nonHermetic: true,
      releaseEligible: false,
      blockers: ['digest-pinned Linux OCI toolchain', 'locked complete-script font profile', 'specialist PDF validator and accessibility review', 'LibreOffice and physical A4/Letter proofs']
    };
    if (!htmlOnly) {
      phases.push('a4/letter');
      report.pdf = {};
      report.pseudolocale = {};
      for (const paper of ['a4', 'letter']) {
        const pdf = path.join(scratch, `aperio-manual-part-i-NON-RELEASE-${paper}.pdf`);
        await renderPdf({ htmlFile, outputFile: pdf, paper });
        report.pdf[paper] = await verifyPdf(pdf, paper, { expectedPages: htmlReport.pages });
        const pseudoPdf = path.join(pseudoRoot, `aperio-manual-part-i-pseudolocale-NON-RELEASE-${paper}.pdf`);
        await renderPdf({ htmlFile: pseudoHtmlFile, outputFile: pseudoPdf, paper });
        report.pseudolocale[paper] = await verifyPdf(pseudoPdf, paper, { pseudo: true, expectedPages: htmlReport.pages });
      }
      phases.push('verify');
      report.affectedFlow = await exercisePinnedFirstRecall(root, edition.product.sha);
      report.affectedFlows = {
        dailyUse: await exercisePinnedDailyUse(root, edition.product.sha),
        filesAndGraphs: await exercisePinnedFilesAndGraphs(root, edition.product.sha)
        ,connectionsAndIntegrations: await exercisePinnedConnectionsAndIntegrations(root, edition.product.sha),
        installAndConfig: await exercisePinnedInstallAndConfig(root, edition.product.sha),
        storageRecovery: await exercisePinnedStorageRecovery(root, edition.product.sha)
      };
      for (const paper of ['a4', 'letter']) {
        const pdf = path.join(scratch, `aperio-manual-part-i-NON-RELEASE-${paper}.pdf`);
        const pageDirectory = path.join(scratch, `pages-${paper}`);
        report.pdf[paper].images = await renderPages(pdf, pageDirectory, `part-i-${paper}`);
        const imageFiles = report.pdf[paper].images.map((name) => path.join(pageDirectory, name));
        const sheet = path.join(scratch, `contact-sheet-${paper}-NON-RELEASE.png`);
        await contactSheet(imageFiles, sheet);
        report.pdf[paper].contactSheet = path.basename(sheet);
        const pseudoPdf = path.join(pseudoRoot, `aperio-manual-part-i-pseudolocale-NON-RELEASE-${paper}.pdf`);
        report.pseudolocale[paper].images = await renderPages(pseudoPdf, path.join(pseudoRoot, `pages-${paper}`), `part-i-pseudolocale-${paper}`);
      }
      report.htmlScreenshots = await captureHtmlReview({ htmlFile, outputDirectory: path.join(qaRoot, 'html-screen') });
    }
    phases.push('atomic-promote');
    report.artifacts = [];
    for (const name of await fs.readdir(scratch)) {
      const file = path.join(scratch, name);
      if ((await fs.stat(file)).isFile() && name !== 'manifest-NON-RELEASE.json') report.artifacts.push(await artifact(file, scratch));
    }
    await fs.rm(outputRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputRoot), { recursive: true });
    await fs.writeFile(path.join(scratch, 'manifest-NON-RELEASE.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.rename(scratch, outputRoot);
    return { outputRoot, report };
  } catch (error) {
    await fs.rm(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}
