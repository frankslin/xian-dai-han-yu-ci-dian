// Headless preview/driver for the 现代汉语词典 reader. Requires
// playwright-core + a downloaded chromium (see SKILL.md) and, on a
// container with no ALSA, the libasound stub from setup-libasound-stub.sh
// on LD_LIBRARY_PATH.
//
// Usage:
//   node preview.mjs <url> [out.png] [WIDTHxHEIGHT]
//
// Prints JSON: { consoleErrors, dataRequests, imageRequests, title } and
// writes a screenshot. dataRequests/imageRequests are listed explicitly
// because for this project "did it fetch what it should have, and nothing
// more" (consent gate, per-shard dict fetching) matters as much as what's
// on screen — always check these, not just the screenshot.
//
// Example: verify the consent gate blocks everything before consent —
//   node preview.mjs 'http://localhost:8931/' before.png
//   (expect dataRequests: [], imageRequests: [])
import pw from 'playwright-core';
const { chromium } = pw;

const [, , url, outPath = 'preview.png', size = '1280x900'] = process.argv;
if (!url) {
  console.error('usage: node preview.mjs <url> [out.png] [WIDTHxHEIGHT]');
  process.exit(1);
}
const [width, height] = size.split('x').map(Number);

const errors = [];
const dataRequests = [];
const imageRequests = [];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width, height } });
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/data/')) dataRequests.push(u.replace(/^https?:\/\/[^/]+\//, ''));
  else if (u.includes('/images/')) imageRequests.push(u.replace(/^https?:\/\/[^/]+\//, ''));
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const title = await page.title();
await page.screenshot({ path: outPath });
await browser.close();

console.log(JSON.stringify({ title, consoleErrors: errors, dataRequests, imageRequests }, null, 2));
