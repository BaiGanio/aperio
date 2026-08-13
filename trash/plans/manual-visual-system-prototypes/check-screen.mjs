import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const prototypeDir = path.dirname(new URL(import.meta.url).pathname);
const outputDir = path.resolve(prototypeDir, '../../../tmp/pdfs/manual-visual-system/screen');
const directions = ['signal-desk', 'night-receiver', 'field-console'];
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--allow-file-access-from-files'] });

try {
  for (const direction of directions) {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport });
      const html = path.join(prototypeDir, `preview-${direction}.html`);
      await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);

      const result = await page.evaluate(() => ({
        hasMain: Boolean(document.querySelector('main')),
        pageCount: document.querySelectorAll('.prototype-page').length,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        visibleMascot: document.querySelector('.cover-art img')?.getBoundingClientRect().height > 0,
      }));

      if (!result.hasMain || result.pageCount !== 4 || result.hasHorizontalOverflow || !result.visibleMascot) {
        throw new Error(`${direction}/${viewport.name} failed: ${JSON.stringify(result)}`);
      }

      await page.screenshot({
        path: path.join(outputDir, `${direction}-${viewport.name}.png`),
        fullPage: true,
      });
      await page.close();
      console.log(`PASS: ${direction} ${viewport.name} responsive layout`);
    }
  }
} finally {
  await browser.close();
}
