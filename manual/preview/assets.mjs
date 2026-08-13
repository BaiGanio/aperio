import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const APPROVED_ROOT = 'trash/plans/manual-visual-system-prototypes';

async function dataUri(file, mime) {
  const bytes = await fs.readFile(file);
  return {
    uri: `data:${mime};base64,${bytes.toString('base64')}`,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length
  };
}

export async function loadPreviewAssets(root) {
  const sources = {
    mascotCover: ['docs/assets/mascot/robot-aurora-1024.png', 'image/png'],
    mascotHead: ['docs/assets/mascot/head-64.webp', 'image/webp'],
    facsimile: [`${APPROVED_ROOT}/assets/settings-screen.svg`, 'image/svg+xml'],
    fontDisplay: ['skills/canvas-design/canvas-fonts/BricolageGrotesque-Bold.ttf', 'font/ttf'],
    fontSans: ['skills/canvas-design/canvas-fonts/InstrumentSans-Regular.ttf', 'font/ttf'],
    fontSansBold: ['skills/canvas-design/canvas-fonts/InstrumentSans-Bold.ttf', 'font/ttf'],
    fontMono: ['skills/canvas-design/canvas-fonts/DMMono-Regular.ttf', 'font/ttf']
  };
  const assets = {};
  const manifest = [];
  for (const [id, [relative, mime]] of Object.entries(sources)) {
    const loaded = await dataUri(path.join(root, relative), mime);
    assets[id] = loaded.uri;
    manifest.push({
      id: `asset.preview.${id}`,
      source: relative,
      sha256: loaded.sha256,
      bytes: loaded.bytes,
      state: 'standalone',
      identity: 'NON-RELEASE',
      provenance: relative.startsWith(APPROVED_ROOT) ? 'approved-source-derived' : 'repository-approved-source',
      candidateEligible: false
    });
  }
  return { assets, manifest };
}

export function applyFontAssets(css, assets) {
  return css
    .replace('__FONT_DISPLAY__', assets.fontDisplay)
    .replace('__FONT_SANS__', assets.fontSans)
    .replace('__FONT_SANS_BOLD__', assets.fontSansBold)
    .replace('__FONT_MONO__', assets.fontMono);
}
