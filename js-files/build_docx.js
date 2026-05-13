/**
 * build_docx.js
 *
 * Layout per manuscript page:
 *
 *   ┌─────────────────────────────┐
 *   │        [Image]              │  ← always fits on one Word page
 *   │   [Devanagari text line 1]  │  ← starts immediately below image
 *   │   [Devanagari text line 2]  │  ← if text is long, overflows naturally
 *   │   ...                       │    to the next Word page(s)
 *   └─────────────────────────────┘
 *   ← PAGE BREAK inserted here after ALL text ends →
 *   ┌─────────────────────────────┐
 *   │   [Next manuscript image]   │  ← always starts on a fresh page
 *   │   ...                       │
 *
 * Key decisions:
 *   - Image is capped at MAX_IMAGE_HEIGHT (400pt) so text always starts
 *     on the same Word page as the image, even for tall manuscript scans
 *   - Each Devanagari line is a separate Paragraph so Word reflows them
 *     naturally across pages if needed
 *   - Page break goes AFTER the last text line of each manuscript page,
 *     NOT after the image — this prevents blank pages when text overflows
 */

const {
  Document,
  Packer,
  Paragraph,
  ImageRun,
  PageBreak,
  TextRun,
  AlignmentType,
} = require('docx');
const fs = require('fs');
const { execSync } = require('child_process');

// ── Constants ────────────────────────────────────────────────────────────────

// A4 page at 0.5in margins gives ~724pt usable width, ~1011pt usable height
// We cap the image at 400pt tall so the first text line always starts on
// the same Word page as the image, regardless of how tall the scan is.
const MAX_IMAGE_WIDTH_PT  = 700;
const MAX_IMAGE_HEIGHT_PT = 400;  // ← key value: leaves ~600pt for text

// Devanagari font and size
const DEVA_FONT = 'Mangal';
const DEVA_SIZE = 21; // half-points → 13pt. Readable, not huge.

// ── Helpers ──────────────────────────────────────────────────────────────────

function getImageDimensions(imagePath) {
  try {
    // Use Python Pillow — most reliable cross-platform image size reader
    const escaped = imagePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = execSync(
      `python3 -c "from PIL import Image; img=Image.open('${escaped}'); print(img.size[0], img.size[1])"`,
      { encoding: 'utf8' }
    ).trim();
    const [w, h] = result.split(' ').map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch {}
  // Fallback: assume landscape manuscript proportions
  return { width: 1200, height: 800 };
}

function scaleToFit(origW, origH, maxW, maxH) {
  const ratio = Math.min(maxW / origW, maxH / origH);
  return {
    width:  Math.round(origW * ratio),
    height: Math.round(origH * ratio),
  };
}

// Split text into individual lines, filtering empty ones
function splitLines(text) {
  if (!text || !text.trim()) return ['[No OCR text retrieved for this page]'];
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

// ── Builder ──────────────────────────────────────────────────────────────────

async function buildDocx(pages, outputPath) {
  console.log(`  Building DOCX with ${pages.length} manuscript pages...`);

  const children = [];

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    console.log(`  Composing page ${p.pageNum}/${pages.length}...`);

    const isLast = (i === pages.length - 1);

    // ── 1. Page label ───────────────────────────────────────────────────────
    // Small gray label above the image so you can identify pages in Word
    // children.push(new Paragraph({
    //   children: [new TextRun({
    //     text: `Manuscript Page ${p.pageNum}`,
    //     size: 16,         // 8pt
    //     color: 'AAAAAA',
    //     bold: false,
    //   })],
    //   alignment: AlignmentType.CENTER,
    //   spacing: { before: 0, after: 80 },
    // }));

    // ── 2. Image ────────────────────────────────────────────────────────────
    if (p.imagePath && fs.existsSync(p.imagePath)) {
      const imageBuffer = fs.readFileSync(p.imagePath);
      const dims   = getImageDimensions(p.imagePath);
      const scaled = scaleToFit(dims.width, dims.height, MAX_IMAGE_WIDTH_PT, MAX_IMAGE_HEIGHT_PT);

      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: imageBuffer,
            transformation: { width: scaled.width, height: scaled.height },
            type: 'jpg',
          }),
        ],
        spacing: { before: 0, after: 160 }, // 8pt gap between image and text
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({
          text: `[Image not available for page ${p.pageNum}]`,
          italics: true,
          color: 'FF0000',
          size: 20,
        })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
      }));
    }

    // ── 3. Devanagari text — one paragraph per line ─────────────────────────
    // Splitting into separate paragraphs means Word reflows them naturally
    // across Word pages if the text is longer than the remaining space.
    // Using a single paragraph with \n would collapse everything on one line.
    const lines = splitLines(p.text);

    for (let j = 0; j < lines.length; j++) {
      const isLastLine = (j === lines.length - 1);

      children.push(new Paragraph({
        children: [new TextRun({
          text: lines[j],
          font: DEVA_FONT,
          size: DEVA_SIZE,
          color: '1A1A1A',
        })],
        alignment: AlignmentType.START,
        spacing: {
          before: 0,
          after: isLastLine ? 0 : 40, // small gap between lines; no extra after last
          line: 320,                   // 1.1× line spacing — breathing room for Devanagari
          lineRule: 'auto',
        },
      }));
    }

    // ── 4. Page break after all text — but NOT after the last manuscript page
    // This is the critical rule:
    //   ✓ Page break comes AFTER the last text line
    //   ✓ Next manuscript image always starts on a clean new Word page
    //   ✓ If text overflows naturally to a 2nd Word page, the break still
    //     appears at the correct place — after all the text
    if (!isLast) {
      children.push(new Paragraph({
        children: [new PageBreak()],
        spacing: { before: 0, after: 0 },
      }));
    }
  }

  // ── Build Document ────────────────────────────────────────────────────────
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: DEVA_FONT,
            size: DEVA_SIZE,
          },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          // A4 with 0.5in margins all around
          size: { width: 11906, height: 16838 }, // EMU units (A4)
          margin: { top: 720, bottom: 720, left: 720, right: 720 },
        },
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`  ✓ Saved to: ${outputPath}`);
  return outputPath;
}

module.exports = { buildDocx };