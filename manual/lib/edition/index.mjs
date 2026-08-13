import path from 'node:path';
import { readJson } from '../contracts/index.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;

export function validateEdition(edition, { release = false } = {}) {
  if (!FULL_SHA.test(edition.product?.sha || '')) throw new Error('product pin must be a full SHA');
  if (!/^v\d+\.\d+\.\d+$/.test(edition.product?.tag || '')) throw new Error('product tag must be explicit');
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(edition.locale || '')) throw new Error('locale must be canonical BCP 47');
  for (const output of ['html', 'a4', 'letter']) {
    if (!edition.outputs?.includes(output)) throw new Error(`missing output: ${output}`);
  }
  if (release) {
    if (!FULL_SHA.test(edition.manualSha || '')) throw new Error('release manual pin must be a full SHA');
    if (!Number.isInteger(edition.releaseRevision) || edition.releaseRevision < 1) throw new Error('release revision required');
  } else {
    if (edition.identity !== 'NON-RELEASE') throw new Error('preview identity missing');
    if (edition.releaseRevision != null || edition.releaseChecksums || edition.releaseFilenames) {
      throw new Error('preview cannot claim release identity');
    }
  }
  return edition;
}

export async function loadPreviewEdition(root) {
  return validateEdition(await readJson(path.join(root, 'manual/editions/part-i-preview.json')));
}
