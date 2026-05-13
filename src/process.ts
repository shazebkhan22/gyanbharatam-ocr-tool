/**
 * MANUSCRIPT AUTOMATION - process.ts
 *
 * Usage: npx ts-node src/process.ts
 *
 * Before running:
 *   1. npm install
 *   2. Run this script — it will open Chrome and prompt you to upload + OCR
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';

import { cleanText, extractDevanagariFromDOM } from './clean_text';
import { buildDocx, PageResult } from './build_docx';
import config from './config';

interface PageItem {
  id: string | null;
  name: string;
  thumbSrc: string;
}

// ─── Image Download ───────────────────────────────────────────────────────────
async function downloadImage(browser: Browser, imageUrl: string, destPath: string): Promise<void> {
  const imgPage = await browser.newPage();
  try {
    const response = await imgPage.goto(imageUrl, { timeout: 30000 });
    if (!response) throw new Error('No response received');
    if (!response.ok()) {
      throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    }
    const buffer = await response.buffer();
    fs.writeFileSync(destPath, buffer);
  } finally {
    await imgPage.close().catch(() => {});
  }
}

// ─── Element Screenshot Fallback ─────────────────────────────────────────────
async function screenshotThumb(page: Page, itemId: string, destPath: string): Promise<void> {
  const el = await page.$(`.script-item[data-id="${itemId}"] img.thumb`);
  if (!el) throw new Error('thumb element not found');
  await el.screenshot({ path: destPath, type: 'jpeg' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  MANUSCRIPT DIGITIZATION AUTOMATION');
  console.log('='.repeat(60));

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  // ── Step 1: Navigate ──────────────────────────────────────────────────────
  console.log('\n[1/5] Opening Pandulipi Mitram...');
  await page.goto(config.OCR_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  console.log('\n⚠️  UPLOAD YOUR PDF FIRST');
  console.log('  The browser is now open at Pandulipi Mitram.');
  console.log('  In the browser window:');
  console.log('    1. Log in if prompted');
  console.log('    2. Click "Upload Script" and select your PDF');
  console.log('    3. Click "⚡ OCR All" button');
  console.log('    4. Wait until ALL pages show OCR results in the left sidebar');
  console.log('    5. Press ENTER here to start automation...\n');

  await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));

  console.log('  ✓ Starting automation...');
  await page.waitForSelector('#scriptList', { timeout: 30000 });
  console.log('  ✓ Found page list');

  // ── Step 2: Read sidebar ──────────────────────────────────────────────────
  console.log('\n[2/5] Reading page list from sidebar...');
  console.log(`  Current URL: ${page.url()}`);

  const pageItems = await page.$$eval('#scriptList .script-item', (items): PageItem[] =>
    items.map(el => ({
      id: el.getAttribute('data-id'),
      name: (el.querySelector('.name') as HTMLElement)?.innerText || '',
      thumbSrc: (el.querySelector('img.thumb') as HTMLImageElement)?.src || '',
    }))
  );

  if (pageItems.length === 0) {
    console.error('  ✗ No pages found — taking debug screenshot...');
    await page.screenshot({ path: './debug-screenshot.png', fullPage: true });
    console.error('  Saved: debug-screenshot.png');
    await browser.close();
    process.exit(1);
  }

  pageItems.sort((a, b) => {
    const numA = parseInt((a.name.match(/\(p\.(\d+)\)/) || [])[1] ?? '0');
    const numB = parseInt((b.name.match(/\(p\.(\d+)\)/) || [])[1] ?? '0');
    return numA - numB;
  });

  console.log(`  ✓ Found ${pageItems.length} pages`);

  fs.mkdirSync('./output', { recursive: true });
  const existing = fs.readdirSync('./output').filter(f => /^manuscript-\d+\.docx$/.test(f));
  const sessionId = existing.length + 1;
  const workDir = path.join('./workspace', `session-${sessionId}`);
  fs.mkdirSync(workDir, { recursive: true });

  // ── Step 3: Process each page ─────────────────────────────────────────────
  console.log('\n[3/5] Processing each page...\n');

  const results: PageResult[] = [];

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i];
    const pageNum = i + 1;

    process.stdout.write(`  [Page ${pageNum}/${pageItems.length}]`);

    let text = '[OCR could not be retrieved for this page]';
    let imgPath: string | null = null;

    // ── Text extraction ───────────────────────────────────────────────────
    try {
      process.stdout.write(' clicking...');
      await page.click(`.script-item[data-id="${item.id}"]`);

      await page.waitForSelector(`.script-item.selected[data-id="${item.id}"]`, { timeout: 15000 });

      await page.waitForFunction(
        () => {
          const el = document.querySelector('.ocr-pane') as HTMLElement | null;
          return el && el.innerText && el.innerText.trim().length > 30;
        },
        { timeout: 30000 }
      );

      const devanagariLines = await page.evaluate(extractDevanagariFromDOM);

      if (devanagariLines && devanagariLines.length > 0) {
        text = devanagariLines.join('\n');
        process.stdout.write(` text✓(${devanagariLines.length} lines)`);
      } else {
        const rawText = await page.$eval('.ocr-pane', (el: Element) => (el as HTMLElement).innerText);
        const cleaned = cleanText(rawText);
        text = cleaned || rawText.substring(0, 2000);
        process.stdout.write(` text-fallback(${rawText.length}chars)`);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(` text-FAIL(${msg.substring(0, 50)})`);
      try {
        const rawText = await page.$eval('.ocr-pane', (el: Element) => (el as HTMLElement).innerText);
        if (rawText.trim().length > 10) {
          text = cleanText(rawText) || rawText.substring(0, 2000);
          process.stdout.write('[recovered]');
        }
        await page.screenshot({
          path: path.join(workDir, `debug-page-${pageNum}.png`),
        }).catch(() => {});
      } catch {}
    }

    // ── Image download ────────────────────────────────────────────────────
    const destPath = path.join(workDir, `page-${String(pageNum).padStart(4, '0')}.jpg`);

    if (item.thumbSrc && item.thumbSrc.startsWith('http')) {
      try {
        await downloadImage(browser, item.thumbSrc, destPath);
        imgPath = destPath;
        process.stdout.write(' img✓');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(` img-HTTP-FAIL(${msg.substring(0, 40)})`);
        try {
          await screenshotThumb(page, item.id ?? '', destPath);
          imgPath = destPath;
          process.stdout.write('[thumb-screenshot]');
        } catch {
          process.stdout.write(' img-FAIL');
        }
      }
    } else {
      process.stdout.write(' no-img-url');
    }

    process.stdout.write('\n');

    results.push({ pageNum, imagePath: imgPath, text, name: item.name });

    await new Promise<void>(r => setTimeout(r, config.DELAY_BETWEEN_PAGES_MS));
  }

  await browser.close();

  // ── Step 4: Build DOCX ────────────────────────────────────────────────────
  console.log('\n[4/5] Building Word document...');

  const outputName = `manuscript-${sessionId}.docx`;
  const outputPath = path.join('./output', outputName);
  await buildDocx(results, outputPath);

  const successText  = results.filter(r => !r.text.startsWith('[OCR')).length;
  const successImage = results.filter(r => r.imagePath).length;

  console.log('\n' + '='.repeat(60));
  console.log('  ✓ DONE!');
  console.log(`  Output:        ${outputPath}`);
  console.log(`  Text success:  ${successText}/${results.length} pages`);
  console.log(`  Image success: ${successImage}/${results.length} pages`);
  console.log('='.repeat(60) + '\n');
}

run().catch(err => {
  console.error('\n[FATAL ERROR]', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
});
