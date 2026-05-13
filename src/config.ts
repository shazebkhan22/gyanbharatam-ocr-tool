/**
 * config.ts — Edit these values before running
 */

export interface Config {
  OCR_URL: string;
  CHROME_PATH: string;
  CHROME_PROFILE_PATH: string;
  OCR_RESULT_SELECTOR: string;
  DELAY_BETWEEN_PAGES_MS: number;
}

const config: Config = {

  // URL of the OCR tool
  OCR_URL: 'https://app.intuist.ai/veda/pandulipi-mitram',

  // ─── CHROME SETTINGS ──────────────────────────────────────────────────────
  // Path to your Chrome/Chromium executable
  // Windows examples:
  //   'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  //   'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  // Mac example:
  //   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  // Linux example:
  //   '/usr/bin/google-chrome'
  CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  CHROME_PROFILE_PATH: '/Users/shazebkhan/Library/Application Support/Google/Chrome',

  // ─── SELECTOR FOR OCR RESULT PANEL (RIGHT SIDE) ───────────────────────────
  // Confirmed from your HTML inspection — the right panel is .ocr-pane
  // No need to change this.
  OCR_RESULT_SELECTOR: '.ocr-pane',

  // ─── PERFORMANCE ──────────────────────────────────────────────────────────
  // Milliseconds to wait between processing each page
  // Increase if the site is slow or you're getting errors
  DELAY_BETWEEN_PAGES_MS: 800,

};

export default config;
