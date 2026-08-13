import fs from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function strengthenContract(base, later) {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(later)) {
    if (key in merged && merged[key] === true && value !== true) {
      throw new Error(`contract weakening: ${key}`);
    }
    if (key in merged && merged[key] === false && value === true && key.startsWith('previewMay')) {
      throw new Error(`contract weakening: ${key}`);
    }
    merged[key] = value;
  }
  return merged;
}

export async function loadContracts(root) {
  const classes = await readJson(path.join(root, 'manual/contracts/source-classes.json'));
  const contract = await readJson(path.join(root, 'manual/contracts/invariants.json'));
  const required = ['authored', 'generated', 'imported', 'asset', 'evidence', 'preview', 'candidate', 'published'];
  for (const sourceClass of required) {
    if (!classes.classes[sourceClass]) throw new Error(`missing source class: ${sourceClass}`);
  }
  if (contract.invariants.previewMayPublish !== false) throw new Error('preview publication must be impossible');
  return { classes, contract };
}
