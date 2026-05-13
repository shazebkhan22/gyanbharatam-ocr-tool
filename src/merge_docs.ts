/**
 * merge_docs.ts
 *
 * Merges two or more Word documents (produced by this tool) into a single
 * DOCX, preserving images and Devanagari text in the order given.
 *
 * Usage:
 *   npx ts-node src/merge_docs.ts                         # interactive: lists output/ files
 *   npx ts-node src/merge_docs.ts out1.docx out2.docx ... # explicit paths
 */

import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

interface Rel {
  type: string;
  target: string;
}

interface RelMap {
  [rId: string]: Rel;
}

interface DocData {
  idx: number;
  zip: JSZip;
  docXml: string;
  rels: RelMap;
  media: { [filePath: string]: Buffer };
  ridMap: { [oldId: string]: string } | null;
  mediaMap: { [oldBase: string]: string } | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadZip(filePath: string): Promise<JSZip> {
  const buf = fs.readFileSync(filePath);
  return JSZip.loadAsync(buf);
}

function parseRels(xml: string): RelMap {
  const map: RelMap = {};
  const re = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    map[m[1]] = { type: m[2], target: m[3] };
  }
  return map;
}

function buildRelsXml(relsMap: RelMap): string {
  const xmlns = 'http://schemas.openxmlformats.org/package/2006/relationships';
  let inner = '';
  for (const [id, rel] of Object.entries(relsMap)) {
    inner += `<Relationship Id="${id}" Type="${rel.type}" Target="${rel.target}"/>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${xmlns}">\n${inner}</Relationships>`;
}

function extractBodyContent(docXml: string): string {
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return '';
  let body = bodyMatch[1];
  body = body
    .replace(/<w:sectPr\b[^>]*\/>/g, '')
    .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '')
    .trimEnd();
  return body;
}

function extractSectPr(docXml: string): string {
  const m = docXml.match(/(<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>)/);
  return m ? m[0] : '';
}

function rebuildDocXml(originalXml: string, mergedBodyContent: string, sectPr: string): string {
  return originalXml.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${mergedBodyContent}\n${sectPr}\n</w:body>`
  );
}

// ── Core merge ────────────────────────────────────────────────────────────────

async function mergeDocxFiles(inputPaths: string[], outputPath: string): Promise<void> {
  if (inputPaths.length < 2) {
    throw new Error('At least 2 input files are required.');
  }

  console.log(`\nMerging ${inputPaths.length} documents:`);
  inputPaths.forEach((p, i) => console.log(`  ${i + 1}. ${path.basename(p)}`));

  const zips = await Promise.all(inputPaths.map(loadZip));

  const docs: DocData[] = await Promise.all(zips.map(async (zip, idx) => {
    const docXml   = await zip.file('word/document.xml')!.async('string');
    const relsFile = zip.file('word/_rels/document.xml.rels');
    const relsXml  = relsFile ? await relsFile.async('string') : '';
    const rels     = parseRels(relsXml);

    const media: { [filePath: string]: Buffer } = {};
    for (const [name, file] of Object.entries(zip.files)) {
      if (name.startsWith('word/media/')) {
        media[name] = await file.async('nodebuffer');
      }
    }

    return { idx, zip, docXml, rels, media, ridMap: null, mediaMap: null };
  }));

  // ── Assign non-conflicting rIds for doc 2+ ──────────────────────────────
  function maxRidNum(rels: RelMap): number {
    return Object.keys(rels).reduce((max, id) => {
      const n = parseInt(id.replace(/\D/g, ''), 10) || 0;
      return Math.max(max, n);
    }, 0);
  }

  let ridOffset = maxRidNum(docs[0].rels);

  const remappedDocs: DocData[] = docs.map((doc, i) => {
    if (i === 0) return doc;

    const ridMap: { [oldId: string]: string } = {};
    for (const oldId of Object.keys(doc.rels)) {
      const num = parseInt(oldId.replace(/\D/g, ''), 10) || 0;
      ridMap[oldId] = `rId${num + ridOffset}`;
    }

    const mediaMap: { [oldBase: string]: string } = {};
    for (const fullPath of Object.keys(doc.media)) {
      const base = path.basename(fullPath);
      mediaMap[base] = `doc${i + 1}_${base}`;
    }

    ridOffset += maxRidNum(doc.rels);
    return { ...doc, ridMap, mediaMap };
  });

  // ── Build merged rels ────────────────────────────────────────────────────
  const mergedRels: RelMap = { ...docs[0].rels };

  for (let i = 1; i < remappedDocs.length; i++) {
    const { rels, ridMap, mediaMap } = remappedDocs[i];
    for (const [oldId, rel] of Object.entries(rels)) {
      const newId     = ridMap![oldId];
      let   newTarget = rel.target;

      const base = path.basename(newTarget);
      if (mediaMap![base]) {
        newTarget = newTarget.replace(base, mediaMap![base]);
      }

      mergedRels[newId] = { type: rel.type, target: newTarget };
    }
  }

  // ── Combine body content ─────────────────────────────────────────────────
  const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  let mergedBodyContent = '';

  for (let i = 0; i < remappedDocs.length; i++) {
    const { docXml, ridMap, mediaMap } = remappedDocs[i];
    let bodyContent = extractBodyContent(docXml);

    if (i > 0 && ridMap) {
      for (const [oldId, newId] of Object.entries(ridMap)) {
        bodyContent = bodyContent.replace(
          new RegExp(`(?<=["\'])${oldId}(?=["\'])`, 'g'),
          newId
        );
      }

      for (const [oldBase, newBase] of Object.entries(mediaMap!)) {
        bodyContent = bodyContent.split(oldBase).join(newBase);
      }
    }

    if (mergedBodyContent) mergedBodyContent += '\n' + PAGE_BREAK + '\n';
    mergedBodyContent += bodyContent;
  }

  // ── Assemble final ZIP ───────────────────────────────────────────────────
  const outZip = zips[0];

  const sectPr = extractSectPr(docs[0].docXml);
  const newDocXml = rebuildDocXml(docs[0].docXml, mergedBodyContent, sectPr);
  outZip.file('word/document.xml', newDocXml);
  outZip.file('word/_rels/document.xml.rels', buildRelsXml(mergedRels));

  for (let i = 1; i < remappedDocs.length; i++) {
    const { media, mediaMap } = remappedDocs[i];
    for (const [fullPath, buf] of Object.entries(media)) {
      const base    = path.basename(fullPath);
      const newBase = mediaMap![base] || base;
      outZip.file(`word/media/${newBase}`, buf);
    }
  }

  const buffer = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buffer);
  console.log(`\n✓ Merged document saved to: ${outputPath}`);
}

// ── Interactive file picker ───────────────────────────────────────────────────

async function pickFilesInteractively(): Promise<string[]> {
  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) {
    console.error('No output/ directory found. Run process.ts first to generate DOCX files.');
    process.exit(1);
  }

  const files = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.docx') && !f.startsWith('merged-'))
    .sort();

  if (files.length === 0) {
    console.error('No DOCX files found in output/. Run process.ts first.');
    process.exit(1);
  }

  console.log('\nAvailable documents in output/:');
  files.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  console.log('\nEnter the numbers of the files to merge, in order (e.g. 1 3 2):');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve, reject) => {
    rl.question('> ', answer => {
      rl.close();
      const indices = answer.trim().split(/\s+/).map(n => parseInt(n, 10) - 1);
      const chosen = indices.map(i => {
        if (i < 0 || i >= files.length) throw new Error(`Invalid selection: ${i + 1}`);
        return path.join(outputDir, files[i]);
      });
      if (chosen.length < 2) {
        reject(new Error('Please select at least 2 files.'));
      } else {
        resolve(chosen);
      }
    });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let inputPaths = process.argv.slice(2);

  if (inputPaths.length === 0) {
    inputPaths = await pickFilesInteractively();
  } else {
    const outputDir = path.join(__dirname, '..', 'output');
    inputPaths = inputPaths.map(p => {
      if (fs.existsSync(p)) return path.resolve(p);
      const inOutput = path.join(outputDir, p);
      if (fs.existsSync(inOutput)) return inOutput;
      const inCwd = path.join(process.cwd(), p);
      if (fs.existsSync(inCwd)) return inCwd;
      console.error(`File not found: ${p}`);
      process.exit(1);
    });
  }

  fs.mkdirSync(path.join(__dirname, '..', 'output'), { recursive: true });
  const outputPath = path.join(__dirname, '..', 'output', `merged-${Date.now()}.docx`);

  await mergeDocxFiles(inputPaths, outputPath);
}

main().catch(err => {
  console.error('\n[ERROR]', (err as Error).message);
  process.exit(1);
});
