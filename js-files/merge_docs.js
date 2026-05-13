/**
 * merge_docs.js
 *
 * Merges two or more Word documents (produced by this tool) into a single
 * DOCX, preserving images and Devanagari text in the order given.
 *
 * Usage:
 *   node merge_docs.js                              # interactive: lists output/ files
 *   node merge_docs.js out1.docx out2.docx ...      # explicit paths
 *
 * Each input document is appended after the previous one.
 * A clean page break is inserted between documents.
 */

const JSZip   = require('jszip');
const fs      = require('fs');
const path    = require('path');
const readline = require('readline');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadZip(filePath) {
  const buf = fs.readFileSync(filePath);
  return JSZip.loadAsync(buf);
}

/**
 * Parse a rels XML string into a map of { rId -> { type, target } }
 */
function parseRels(xml) {
  const map = {};
  const re = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    map[m[1]] = { type: m[2], target: m[3] };
  }
  return map;
}

/**
 * Given a rels map, produce the XML string for it.
 */
function buildRelsXml(relsMap) {
  const xmlns = 'http://schemas.openxmlformats.org/package/2006/relationships';
  let inner = '';
  for (const [id, rel] of Object.entries(relsMap)) {
    inner += `<Relationship Id="${id}" Type="${rel.type}" Target="${rel.target}"/>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${xmlns}">\n${inner}</Relationships>`;
}

/**
 * Extract the content inside <w:body>…</w:body>, minus the trailing <w:sectPr>
 * block that defines page layout (we keep the one from the first document only).
 */
function extractBodyContent(docXml) {
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return '';
  let body = bodyMatch[1];
  // Remove the terminal <w:sectPr … /> or <w:sectPr …>…</w:sectPr>
  body = body
    .replace(/<w:sectPr\b[^>]*\/>/g, '')
    .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '')
    .trimEnd();
  return body;
}

/**
 * Extract the <w:sectPr> block from the first document so we can keep the
 * page size / margin settings in the merged output.
 */
function extractSectPr(docXml) {
  const m = docXml.match(/(<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>)/);
  return m ? m[0] : '';
}

/**
 * Rebuild document.xml with new body content + sectPr.
 */
function rebuildDocXml(originalXml, mergedBodyContent, sectPr) {
  return originalXml.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${mergedBodyContent}\n${sectPr}\n</w:body>`
  );
}

// ── Core merge ────────────────────────────────────────────────────────────────

async function mergeDocxFiles(inputPaths, outputPath) {
  if (inputPaths.length < 2) {
    throw new Error('At least 2 input files are required.');
  }

  console.log(`\nMerging ${inputPaths.length} documents:`);
  inputPaths.forEach((p, i) => console.log(`  ${i + 1}. ${path.basename(p)}`));

  // Load all ZIPs
  const zips = await Promise.all(inputPaths.map(loadZip));

  // Read document.xml and rels from each
  const docs = await Promise.all(zips.map(async (zip, idx) => {
    const docXml  = await zip.file('word/document.xml').async('string');
    const relsFile = zip.file('word/_rels/document.xml.rels');
    const relsXml  = relsFile ? await relsFile.async('string') : '';
    const rels     = parseRels(relsXml);

    // Collect media files: { 'word/media/image1.jpeg' → Buffer }
    const media = {};
    for (const [name, file] of Object.entries(zip.files)) {
      if (name.startsWith('word/media/')) {
        media[name] = await file.async('nodebuffer');
      }
    }

    return { idx, zip, docXml, rels, media };
  }));

  // ── Assign non-conflicting rIds for doc 2+ ──────────────────────────────
  // Strategy: offset numeric part of each rId.
  // All rIds from doc[0] keep their names; doc[1]+ get a unique prefix.

  // Find max rId number across all docs so we can space them out
  function maxRidNum(rels) {
    return Object.keys(rels).reduce((max, id) => {
      const n = parseInt(id.replace(/\D/g, ''), 10) || 0;
      return Math.max(max, n);
    }, 0);
  }

  // Build per-doc rId remapping tables
  let ridOffset = maxRidNum(docs[0].rels);

  const remappedDocs = docs.map((doc, i) => {
    if (i === 0) return { ...doc, ridMap: null, mediaMap: null };

    // Remap rIds
    const ridMap = {}; // old rId → new rId
    for (const oldId of Object.keys(doc.rels)) {
      const num    = parseInt(oldId.replace(/\D/g, ''), 10) || 0;
      ridMap[oldId] = `rId${num + ridOffset}`;
    }

    // Remap media file names to avoid collisions (prefix with docN_)
    const mediaMap = {}; // old basename → new basename
    for (const fullPath of Object.keys(doc.media)) {
      const base    = path.basename(fullPath); // e.g. image1.jpeg
      mediaMap[base] = `doc${i + 1}_${base}`;  // e.g. doc2_image1.jpeg
    }

    ridOffset += maxRidNum(doc.rels);
    return { ...doc, ridMap, mediaMap };
  });

  // ── Build merged rels for the base document ──────────────────────────────
  const mergedRels = { ...docs[0].rels };

  for (let i = 1; i < remappedDocs.length; i++) {
    const { rels, ridMap, mediaMap } = remappedDocs[i];
    for (const [oldId, rel] of Object.entries(rels)) {
      const newId     = ridMap[oldId];
      let   newTarget = rel.target; // e.g. media/image1.jpeg

      // Remap media target if it points to a file we're renaming
      const base = path.basename(newTarget);
      if (mediaMap[base]) {
        newTarget = newTarget.replace(base, mediaMap[base]);
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
      // Update rId references in the XML: r:embed, r:id, etc.
      for (const [oldId, newId] of Object.entries(ridMap)) {
        // Match any attribute value equal to the old rId
        bodyContent = bodyContent.replace(
          new RegExp(`(?<=["\'])${oldId}(?=["\'])`, 'g'),
          newId
        );
      }

      // Update media filenames embedded in the XML (e.g. in drawing alt-text or
      // direct name attrs — usually handled via rIds, but cover this too)
      for (const [oldBase, newBase] of Object.entries(mediaMap)) {
        bodyContent = bodyContent.split(oldBase).join(newBase);
      }
    }

    if (mergedBodyContent) mergedBodyContent += '\n' + PAGE_BREAK + '\n';
    mergedBodyContent += bodyContent;
  }

  // ── Assemble final ZIP from doc[0] as base ───────────────────────────────
  const outZip = zips[0];

  // Write merged document.xml
  const sectPr = extractSectPr(docs[0].docXml);
  const newDocXml = rebuildDocXml(docs[0].docXml, mergedBodyContent, sectPr);
  outZip.file('word/document.xml', newDocXml);

  // Write merged rels
  outZip.file('word/_rels/document.xml.rels', buildRelsXml(mergedRels));

  // Copy media from doc 2+ (renamed to avoid conflicts)
  for (let i = 1; i < remappedDocs.length; i++) {
    const { media, mediaMap } = remappedDocs[i];
    for (const [fullPath, buf] of Object.entries(media)) {
      const base    = path.basename(fullPath);
      const newBase = mediaMap[base] || base;
      outZip.file(`word/media/${newBase}`, buf);
    }
  }

  // Save
  const buffer = await outZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, buffer);
  console.log(`\n✓ Merged document saved to: ${outputPath}`);
}

// ── Interactive file picker ───────────────────────────────────────────────────

async function pickFilesInteractively() {
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    console.error('No output/ directory found. Run process.js first to generate DOCX files.');
    process.exit(1);
  }

  const files = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.docx') && !f.startsWith('merged-'))
    .sort();

  if (files.length === 0) {
    console.error('No DOCX files found in output/. Run process.js first.');
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
      const chosen  = indices.map(i => {
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

async function main() {
  let inputPaths = process.argv.slice(2);

  if (inputPaths.length === 0) {
    // Interactive mode: show files in output/
    inputPaths = await pickFilesInteractively();
  } else {
    // Resolve paths: try as-is, then relative to output/, then relative to script dir
    const outputDir = path.join(__dirname, 'output');
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

  fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
  const outputPath = path.join(__dirname, 'output', `merged-${Date.now()}.docx`);

  await mergeDocxFiles(inputPaths, outputPath);
}

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
