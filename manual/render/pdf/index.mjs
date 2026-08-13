import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function launchChrome(profile) {
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools timeout: ${stderr}`)), 15000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${stderr}`)); });
  });
  return { child, endpoint };
}

function cdp(endpoint) {
  const ws = new WebSocket(endpoint);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  return {
    ready,
    async send(method, params = {}, sessionId) {
      await ready;
      const callId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject });
        ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { ws.close(); }
  };
}

export async function renderPdf({ htmlFile, outputFile, paper }) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-chrome-'));
  const { child, endpoint } = await launchChrome(profile);
  const client = cdp(endpoint);
  try {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Page.navigate', { url: pathToFileURL(htmlFile).href }, sessionId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (state.result.value === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await client.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);
    await client.send('Runtime.evaluate', { expression: `document.documentElement.dataset.paper=${JSON.stringify(paper)}; document.fonts.ready`, awaitPromise: true }, sessionId);
    const overflow = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify(Array.from(document.querySelectorAll('.manual-page')).map((page,index)=>({page:index+1,id:page.id,height:page.clientHeight,scrollHeight:page.scrollHeight,width:page.clientWidth,scrollWidth:page.scrollWidth})).filter(x=>x.scrollHeight>x.height+1||x.scrollWidth>x.width+1))`,
      returnByValue: true
    }, sessionId);
    const collisions = JSON.parse(overflow.result.value);
    if (collisions.length) throw new Error(`${paper}: clipped manual pages ${JSON.stringify(collisions)}`);
    const geometry = paper === 'a4' ? { paperWidth: 8.2677165, paperHeight: 11.692913 } : { paperWidth: 8.5, paperHeight: 11 };
    const headerTemplate = '<div style="width:100%;font:700 8px Arial;letter-spacing:1.5px;color:#7b2632;text-align:right;padding-right:12mm">NON-RELEASE</div>';
    const footerTemplate = '<div style="width:100%;font:8px Arial;color:#334;text-align:center"><span>NON-RELEASE | </span><span class="pageNumber"></span><span> / </span><span class="totalPages"></span></div>';
    const result = await client.send('Page.printToPDF', {
      ...geometry,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: false,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
      transferMode: 'ReturnAsBase64'
    }, sessionId);
    await fs.writeFile(outputFile, Buffer.from(result.data, 'base64'));
  } finally {
    client.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    if (child.exitCode == null) child.kill('SIGKILL');
    await fs.rm(profile, { recursive: true, force: true });
  }
}

export async function captureHtmlReview({ htmlFile, outputDirectory }) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aperio-manual-screen-'));
  const { child, endpoint } = await launchChrome(profile);
  const client = cdp(endpoint);
  try {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Page.navigate', { url: pathToFileURL(htmlFile).href }, sessionId);
    await client.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);
    const captures = [
      { name: 'html-desktop-NON-RELEASE.png', width: 1440, height: 1000 },
      { name: 'html-narrow-NON-RELEASE.png', width: 390, height: 844 }
    ];
    for (const capture of captures) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: capture.width, height: capture.height, deviceScaleFactor: 1, mobile: capture.width < 500 }, sessionId);
      await client.send('Runtime.evaluate', { expression: 'scrollTo(0,0)' }, sessionId);
      const layout = await client.send('Runtime.evaluate', {
        expression: `JSON.stringify({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,pageOverflow:Array.from(document.querySelectorAll('.manual-page')).filter(page=>page.scrollWidth>page.clientWidth+1).map(page=>page.id)})`,
        returnByValue: true
      }, sessionId);
      const layoutReport = JSON.parse(layout.result.value);
      if (layoutReport.documentWidth > layoutReport.viewport + 1 || layoutReport.pageOverflow.length) {
        throw new Error(`${capture.name}: responsive overflow ${JSON.stringify(layoutReport)}`);
      }
      const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
      await fs.writeFile(path.join(outputDirectory, capture.name), Buffer.from(shot.data, 'base64'));
    }
    return captures.map((capture) => capture.name);
  } finally {
    client.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    if (child.exitCode == null) child.kill('SIGKILL');
    await fs.rm(profile, { recursive: true, force: true });
  }
}
