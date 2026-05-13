/**
 * clean_text.ts
 *
 * Handles all output formats from intuist.ai (Pandulipi Mitram).
 *
 * Format A — Devanagari/Sanskrit manuscripts:
 *   <strong>L1:</strong> सँगा अथाणम्पि...   ← KEEP
 *   <em>sāṃgā athāṇampi...</em>              ← SKIP
 *
 * Format B — Odia/regional script (label on its own line):
 *   Line 1                                   ← SKIP (bare heading)
 *   Odia: ନବଗ୍ରହଙ୍କ...                      ← KEEP (strip label)
 *   IAST: nabagrahaṅka...                    ← SKIP
 *
 * Format C — Brahmi/ancient scripts (label + text on same line):
 *   Transliteration (Line-by-Line)           ← SKIP (section header)
 *   Line 1: ᳆ᳫᳯᳮ᳸ ॥                        ← KEEP (strip "Line N:" prefix)
 *   IAST: sastitamo //                       ← SKIP
 *   Note on reading: ...                     ← SKIP
 */

// Devanagari + Vedic Ext + Odia + Bengali + Telugu + Kannada + Malayalam +
// Tamil + Gujarati + Gurmukhi + Brahmi (U+11000–U+1107F) + Siddham (U+11580–U+115FF)
// + Sundanese Supp (U+1CC0–U+1CCF) + broader coverage for ancient scripts
const HAS_INDIC = /[ऀ-ॿ᳐-᳿᳀-᳏଀-୿਀-੿ঀ-৿ఀ-౿ಀ-೿ഀ-ൿ஀-௿઀-૿਀-੿ᄀ0-ᄇFᅘ0-ᅟF]/;

// Script label at start of line: "Odia:", "Bengali:", "Sanskrit:", etc.
const SCRIPT_LABEL = /^(Odia|Bengali|Telugu|Kannada|Malayalam|Tamil|Gujarati|Punjabi|Devanagari|Sanskrit|Hindi|Script|Original)\s*:\s*/i;

// Lines to skip entirely
const IAST_LABEL    = /^(IAST|Roman|Transliteration|Latin)\s*:/i;
const SKIP_LINES    = /^(Note\s*:|Note on reading|Transliteration\s*\(Line|Download PDF|Script\s*&\s*Language|Script:\s|Language:)/i;
const STOP_HEADINGS = /^(Translation|Epigraphic|Script\s*(&|and)\s*Language|Paleographic|Literal|Interpretive)/i;

/**
 * cleanText()
 * Input:  raw innerText scraped from .ocr-pane
 * Output: only the Indic script lines, joined by newlines
 */
export function cleanText(raw: string): string {
  if (!raw || raw.trim().length === 0) return '';

  const lines = raw.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (STOP_HEADINGS.test(trimmed)) break;
    if (IAST_LABEL.test(trimmed)) continue;
    if (SKIP_LINES.test(trimmed)) continue;

    if (/^(Upper|Middle|Lower|Bottom|Top)\s+(Main|Text|Block)/i.test(trimmed)) continue;

    // Skip "Line N (label): text" — editorial/archival annotation, not manuscript text
    if (/^Line\s+\d+\s*\(/.test(trimmed)) continue;

    const lineCMatch = trimmed.match(/^Line\s+\d+\s*:\s*(.+)$/i);
    if (lineCMatch) {
      const content = lineCMatch[1].trim();
      if (HAS_INDIC.test(content)) kept.push(content);
      continue;
    }

    if (/^Line\s+\d+$/i.test(trimmed)) continue;

    const scriptMatch = trimmed.match(SCRIPT_LABEL);
    if (scriptMatch) {
      const content = trimmed.slice(scriptMatch[0].length).trim();
      if (HAS_INDIC.test(content)) kept.push(content);
      continue;
    }

    const lineMatch = trimmed.match(/^L\d+\s*:\s*(.+)$/);
    if (lineMatch) {
      const content = lineMatch[1].trim();
      if (HAS_INDIC.test(content)) kept.push(content);
      continue;
    }

    if (HAS_INDIC.test(trimmed)) kept.push(trimmed);
  }

  return kept.join('\n').trim();
}

/**
 * extractDevanagariFromDOM()
 *
 * Runs INSIDE the browser via page.evaluate().
 * Handles Format A (L1:/L2: labels), Format B (Odia:/IAST:), and
 * Format C (Line N: <text> on same line).
 * Returns an array of Indic script strings (one per manuscript line).
 */
export function extractDevanagariFromDOM(): string[] {
  const HAS_INDIC  = /[ऀ-ॿ᳐-᳿᳀-᳏଀-୿਀-੿ঀ-৿ఀ-౿ಀ-೿ഀ-ൿ஀-௿઀-૿]/;
  const STOP       = /^(Translation|Epigraphic|Script\s*(&|and)\s*Language|Paleographic|Literal|Interpretive)/i;
  const IAST_LBL   = /^(IAST|Roman|Transliteration|Latin)\s*:/i;
  const SKIP_LN    = /^(Note\s*:|Note on reading|Transliteration\s*\(Line|Download PDF|Script\s*&\s*Language|Script:\s|Language:)/i;
  const SCRIPT_LBL = /^(Odia|Bengali|Telugu|Kannada|Malayalam|Tamil|Gujarati|Punjabi|Devanagari|Sanskrit|Hindi|Script|Original)\s*:\s*/i;

  const pane = document.querySelector('.ocr-pane');
  if (!pane) return [];

  const lines: string[] = [];
  const paragraphs = pane.querySelectorAll('p');

  for (const p of paragraphs) {
    const pText = (p as HTMLElement).innerText?.trim() || '';
    if (STOP.test(pText)) break;

    const strongs = p.querySelectorAll('strong');
    let foundFormatA = false;

    for (const strong of strongs) {
      const label = (strong as HTMLElement).innerText?.trim() || '';
      if (!/^L\d+\s*:?$/.test(label)) continue;

      foundFormatA = true;
      let node: Node | null = strong.nextSibling;
      let lineText = '';

      while (node) {
        if (node.nodeType === Node.TEXT_NODE) lineText += node.textContent;
        if ((node as Element).nodeName === 'EM') break;
        if ((node as Element).nodeName === 'BR') break;
        if ((node as Element).nodeName === 'STRONG') break;
        node = node.nextSibling;
      }

      lineText = lineText.replace(/^\s*:\s*/, '').trim();
      if (lineText && HAS_INDIC.test(lineText)) lines.push(lineText);
    }

    if (foundFormatA) continue;

    for (const rawLine of pText.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (STOP.test(trimmed)) return lines;
      if (IAST_LBL.test(trimmed)) continue;
      if (SKIP_LN.test(trimmed)) continue;
      if (/^Line\s+\d+\s*\(/.test(trimmed)) continue;

      const lineCMatch = trimmed.match(/^Line\s+\d+\s*:\s*(.+)$/i);
      if (lineCMatch) {
        const content = lineCMatch[1].trim();
        if (HAS_INDIC.test(content)) lines.push(content);
        continue;
      }

      if (/^Line\s+\d+$/i.test(trimmed)) continue;

      const scriptMatch = trimmed.match(SCRIPT_LBL);
      if (scriptMatch) {
        const content = trimmed.slice(scriptMatch[0].length).trim();
        if (HAS_INDIC.test(content)) lines.push(content);
      }
    }
  }

  // Fallback: innerText line filtering (covers all three formats)
  if (lines.length === 0) {
    const allText = (pane as HTMLElement).innerText || '';
    for (const line of allText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (STOP.test(trimmed)) break;
      if (IAST_LBL.test(trimmed)) continue;
      if (SKIP_LN.test(trimmed)) continue;
      if (/^Line\s+\d+\s*\(/.test(trimmed)) continue;

      const lineCMatch = trimmed.match(/^Line\s+\d+\s*:\s*(.+)$/i);
      if (lineCMatch) {
        const content = lineCMatch[1].trim();
        if (HAS_INDIC.test(content)) lines.push(content);
        continue;
      }

      if (/^Line\s+\d+$/i.test(trimmed)) continue;

      const scriptMatch = trimmed.match(SCRIPT_LBL);
      if (scriptMatch) {
        const content = trimmed.slice(scriptMatch[0].length).trim();
        if (HAS_INDIC.test(content)) lines.push(content);
        continue;
      }

      if (/^L\d+\s*:/.test(trimmed)) {
        const content = trimmed.replace(/^L\d+\s*:\s*/, '').trim();
        if (HAS_INDIC.test(content)) lines.push(content);
        continue;
      }

      if (HAS_INDIC.test(trimmed) && !/^[a-zA-Zāīūṭḍṇśṣḥṃṁḷ]/.test(trimmed)) {
        lines.push(trimmed);
      }
    }
  }

  return lines;
}
