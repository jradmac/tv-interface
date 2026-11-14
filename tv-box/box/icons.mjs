// Dev tool (not shipped): renders the phone app icons from remote/icon.svg with Playwright.
//   PW=/path/to/playwright/index.js node box/icons.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PW || 'playwright');
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(APP, 'remote/icon.svg'), 'utf8');
const b = await chromium.launch();
for (const size of [180, 192, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden">${svg.replace(/<svg([^>]*?)\s(width|height)="[^"]*"/g, '<svg$1').replace(/<svg([^>]*?)\s(width|height)="[^"]*"/g, '<svg$1').replace('<svg', `<svg width="${size}" height="${size}"`)}</body></html>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(APP, `remote/icons/icon-${size}.png`), omitBackground: false });
  await p.close();
}
await b.close();
console.log('icons written to remote/icons/');
