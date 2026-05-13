/**
 * MANUSCRIPT AUTOMATION - process.js
 *
 * Usage: node process.js
 *
 * Before running:
 *   1. npm install
 *   2. Run this script — it will open Chrome and prompt you to upload + OCR
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const { cleanText, extractDevanagariFromDOM } = require('./clean_text');
const { buildDocx } = require('./build_docx');
const config = require('./config');

// ─── Image Download ───────────────────────────────────────────────────────────
// Opens a new browser tab and navigates to the image URL.
// Puppeteer shares session cookies across tabs, so auth and redirects work
// automatically — no need to pass cookies or follow redirects manually.
async function downloadImage(browser, imageUrl, destPath) {
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
// If HTTP download fails, screenshot the <img> DOM element directly.
// Lower resolution but always works since the browser already rendered it.
async function screenshotThumb(page, itemId, destPath) {
  const el = await page.$(`.script-item[data-id="${itemId}"] img.thumb`);
  if (!el) throw new Error('thumb element not found');
  await el.screenshot({ path: destPath, type: 'jpeg' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
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

  await new Promise(resolve => process.stdin.once('data', resolve));

  console.log('  ✓ Starting automation...');
  await page.waitForSelector('#scriptList', { timeout: 30000 });
  console.log('  ✓ Found page list');

  // ── Step 2: Read sidebar ──────────────────────────────────────────────────
  console.log('\n[2/5] Reading page list from sidebar...');
  console.log(`  Current URL: ${page.url()}`);

  const pageItems = await page.$$eval('#scriptList .script-item', items =>
    items.map(el => ({
      id: el.getAttribute('data-id'),
      name: el.querySelector('.name')?.innerText || '',
      thumbSrc: el.querySelector('img.thumb')?.src || '',
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
    const numA = parseInt((a.name.match(/\(p\.(\d+)\)/) || [])[1] || 0);
    const numB = parseInt((b.name.match(/\(p\.(\d+)\)/) || [])[1] || 0);
    return numA - numB;
  });

  console.log(`  ✓ Found ${pageItems.length} pages`);

  const sessionId = Date.now();
  const workDir = path.join('./workspace', `session-${sessionId}`);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync('./output', { recursive: true });

  // ── Step 3: Process each page ─────────────────────────────────────────────
  console.log('\n[3/5] Processing each page...\n');

  const results = [];

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i];
    const pageNum = i + 1;

    process.stdout.write(`  [Page ${pageNum}/${pageItems.length}]`);

    let text = '[OCR could not be retrieved for this page]';
    let imgPath = null;

    // ── Text extraction (independent try/catch) ───────────────────────────
    try {
      process.stdout.write(' clicking...');
      await page.click(`.script-item[data-id="${item.id}"]`);

      // Wait for this sidebar item to become selected
      await page.waitForSelector(`.script-item.selected[data-id="${item.id}"]`, { timeout: 15000 });

      // Wait for the OCR pane to have substantial content.
      // Using a character-count check instead of a Devanagari regex — more
      // robust if content is briefly empty or in an unexpected encoding.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.ocr-pane');
          return el && el.innerText && el.innerText.trim().length > 30;
        },
        { timeout: 30000 }
      );

      // Primary: DOM-based extraction (targets <strong>L1:</strong> labels,
      // skips <em> Roman transliteration)
      const devanagariLines = await page.evaluate(extractDevanagariFromDOM);

      if (devanagariLines && devanagariLines.length > 0) {
        text = devanagariLines.join('\n');
        process.stdout.write(` text✓(${devanagariLines.length} lines)`);
      } else {
        // Fallback: grab all innerText and filter for Devanagari lines
        const rawText = await page.$eval('.ocr-pane', el => el.innerText);
        const cleaned = cleanText(rawText);
        text = cleaned || rawText.substring(0, 2000);
        process.stdout.write(` text-fallback(${rawText.length}chars)`);
      }

    } catch (err) {
      process.stdout.write(` text-FAIL(${err.message.substring(0, 50)})`);
      // Last-resort: grab whatever is in the pane without waiting
      try {
        const rawText = await page.$eval('.ocr-pane', el => el.innerText);
        if (rawText.trim().length > 10) {
          text = cleanText(rawText) || rawText.substring(0, 2000);
          process.stdout.write('[recovered]');
        }
        // Save a debug screenshot so you can see what the browser showed
        await page.screenshot({
          path: path.join(workDir, `debug-page-${pageNum}.png`),
        }).catch(() => {});
      } catch {}
    }

    // ── Image download (independent try/catch) ────────────────────────────
    const destPath = path.join(workDir, `page-${String(pageNum).padStart(4, '0')}.jpg`);

    if (item.thumbSrc && item.thumbSrc.startsWith('http')) {
      try {
        // Primary: open new tab → navigate → read response bytes.
        // This follows redirects and uses the authenticated browser session.
        await downloadImage(browser, item.thumbSrc, destPath);
        imgPath = destPath;
        process.stdout.write(' img✓');
      } catch (err) {
        process.stdout.write(` img-HTTP-FAIL(${err.message.substring(0, 40)})`);
        // Fallback: screenshot the <img class="thumb"> element that's
        // already rendered in the sidebar — lower resolution but always works.
        try {
          await screenshotThumb(page, item.id, destPath);
          imgPath = destPath;
          process.stdout.write('[thumb-screenshot]');
        } catch (err2) {
          process.stdout.write(' img-FAIL');
        }
      }
    } else {
      process.stdout.write(' no-img-url');
    }

    process.stdout.write('\n');

    results.push({ pageNum, imagePath: imgPath, text, name: item.name });

    await new Promise(r => setTimeout(r, config.DELAY_BETWEEN_PAGES_MS));
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
  console.error('\n[FATAL ERROR]', err.message);
  console.error(err.stack);
  process.exit(1);
});
