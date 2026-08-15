import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [htmlPath, outputPath, pageStylesheet] = process.argv.slice(2);

if (!htmlPath || !outputPath || !pageStylesheet) {
  throw new Error('Usage: node render-tagged-pdf.mjs <input.html> <output.pdf> <page.css>');
}

const browser = await chromium.launch({
  headless: true,
  args: ['--allow-file-access-from-files'],
});

try {
  const page = await browser.newPage();
  await page.emulateMedia({ media: 'print' });
  await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });
  await page.addStyleTag({ path: path.resolve(pageStylesheet) });
  await page.evaluate(() => document.fonts.ready);

  const session = await page.context().newCDPSession(page);
  const result = await session.send('Page.printToPDF', {
    displayHeaderFooter: false,
    generateDocumentOutline: true,
    generateTaggedPDF: true,
    preferCSSPageSize: true,
    printBackground: true,
    transferMode: 'ReturnAsBase64',
  });

  await fs.writeFile(path.resolve(outputPath), Buffer.from(result.data, 'base64'));
} finally {
  await browser.close();
}
