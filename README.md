# Manuscript Digitization Automation

Automates scraping OCR results from intuist.ai (Pandulipi Mitram) and builds a Word document with manuscript images + Devanagari text.

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

### 4. Configure config.js
Open `config.js` and update:

**CHROME_PATH** — path to your Chrome.exe:
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Mac: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

**CHROME_PROFILE_PATH** — your Chrome user data folder:
- Windows: `C:\Users\YOUR_USERNAME\AppData\Local\Google\Chrome\User Data`
- Mac: `/Users/YOUR_USERNAME/Library/Application Support/Google/Chrome`

To find your username on Windows: open Command Prompt and type `echo %USERNAME%`

---

## Every Time You Process a PDF

### Step 1: Upload PDF and run OCR on the website (you do this manually)
1. Open Chrome and go to https://app.intuist.ai/veda/pandulipi-mitram
2. Upload your PDF
3. Click **OCR All**
4. Wait for ALL pages to finish processing (all should show results in sidebar)
5. **Do not close the browser**

### Step 2: Find the right panel selector (first time only)
```
node debug_selector.js
```
This opens the site and tries to find which CSS selector contains the OCR text.
Look at the output and copy the best selector into `config.js` as `OCR_RESULT_SELECTOR`.

### Step 3: Run the automation
```
node process.js
```
OR
```
npm start
```

The script will:
1. Open Chrome (using your existing login session)
2. Read all pages from the left sidebar
3. Click each page one by one
4. Download the page image
5. Copy the OCR text and clean it (keep only Devanagari)
6. Build a Word document

Output will be saved in the `output/` folder.

---

## Troubleshooting

**"No pages found in sidebar"**
- Make sure OCR All has completed before running the script
- Make sure you're logged in

**"selector not found" or empty text**
- Run `node debug_selector.js` first to find the correct selector
- Update `OCR_RESULT_SELECTOR` in config.js

**Images not downloading**
- The site requires authentication — make sure CHROME_PROFILE_PATH is set correctly
  so Puppeteer uses your logged-in Chrome session

**Script crashes mid-way**
- Just run `node process.js` again — it will start from scratch
- All results are saved at the end, so partial runs produce no output

---

## Output

Files are saved in the `output/` folder as:
```
output/manuscript-1234567890.docx
```

Each page in the Word document contains:
1. The manuscript page image
2. Page number label
3. Cleaned Devanagari text below the image
