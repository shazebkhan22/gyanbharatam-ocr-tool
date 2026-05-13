# Manuscript Digitization Automation

Automates scraping OCR results from intuist.ai (Pandulipi Mitram) and builds a Word document with manuscript images + Indic script text (Devanagari, Odia, Brahmi, and other scripts).

---

## Setup (Do Once)

### 1. Install Node.js
Download from https://nodejs.org — install the LTS version.

### 2. Install Python dependencies (for image sizing in DOCX)
```
pip install Pillow
```

### 3. Install project dependencies
Open a terminal in this folder and run:
```
npm install
```

### 4. Configure `src/config.ts`
Open `src/config.ts` and update:

**CHROME_PATH** — path to your Chrome executable:
- Windows: `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`
- Mac: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Linux: `/usr/bin/google-chrome`

**CHROME_PROFILE_PATH** — your Chrome user data folder:
- Windows: `C:\\Users\\YOUR_USERNAME\\AppData\\Local\\Google\\Chrome\\User Data`
- Mac: `/Users/YOUR_USERNAME/Library/Application Support/Google/Chrome`

To find your username on Windows: open Command Prompt and type `echo %USERNAME%`

---

## Every Time You Process a PDF

### Step 1: Upload PDF and run OCR on the website (you do this manually)
1. Open Chrome and go to https://app.intuist.ai/veda/pandulipi-mitram
2. Upload your PDF
3. Click **OCR All**
4. Wait for ALL pages to finish processing (all should show results in the left sidebar)
5. **Do not close the browser**

### Step 2: Run the automation
```
npm start
```
or
```
npx ts-node src/process.ts
```

The script will:
1. Open Chrome (reusing your existing login session)
2. Prompt you to upload your PDF and run OCR — press Enter when ready
3. Read all pages from the left sidebar
4. Click each page one by one
5. Download the page image
6. Extract Indic script text and strip transliterations (IAST, Roman, etc.)
7. Build a Word document

Output is saved in the `output/` folder as `manuscript-N.docx`.

---

## Merging Multiple Documents

If you processed a manuscript in multiple batches, you can merge the resulting DOCX files:

```
npm run merge
```
This shows an interactive list of files in `output/` — enter the numbers in the order you want them merged.

To specify files directly:
```
npx ts-node src/merge_docs.ts manuscript-1.docx manuscript-2.docx
```
Full paths or filenames relative to `output/` both work. The merged file is saved as `output/merged-<timestamp>.docx`.

---

## Output

Files are saved in the `output/` folder:
```
output/manuscript-1.docx
output/merged-1234567890.docx
```

Each page in the Word document contains:
1. The manuscript page image (capped at 400pt tall so text starts on the same page)
2. Cleaned Indic script text below the image (one paragraph per line)
3. A page break before the next manuscript page

### Supported OCR formats

The text extractor (`src/clean_text.ts`) handles three output formats from Pandulipi Mitram:

| Format | Example input | Kept |
|--------|---------------|------|
| A — Devanagari/Sanskrit (`L1:` labels) | `L1: सँगा अथाणम्पि...` | Yes |
| B — Regional scripts (`Odia:` labels) | `Odia: ନବଗ୍ରହଙ୍କ...` | Yes (label stripped) |
| C — Ancient scripts (`Line N:` labels) | `Line 1: ᳆ᳫᳯᳮ᳸ ॥` | Yes (label stripped) |

IAST/Roman transliterations and editorial annotations are always stripped.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the OCR scraper and build DOCX |
| `npm run merge` | Interactively merge DOCX files |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:compiled` | Run compiled output (faster, no ts-node) |
| `npm run merge:compiled` | Run compiled merge script |

---

## Troubleshooting

**"No pages found in sidebar"**
- Make sure OCR All has completed before pressing Enter
- Make sure you are logged in to the site

**Images not downloading**
- The site requires authentication — make sure `CHROME_PROFILE_PATH` points to your real Chrome profile so Puppeteer reuses your session

**Script crashes mid-way**
- Run `npm start` again — it starts fresh
- Check `workspace/session-N/debug-page-N.png` for a screenshot of what went wrong

**Merged document looks wrong**
- Make sure all input files were produced by this tool (same page structure)
- Select files in the correct order when prompted
