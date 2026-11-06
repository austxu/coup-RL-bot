// Headless-Chrome check: plays one full game against the bot by pressing the
// game's keyboard shortcuts, then opens the review. Reports console errors and
// horizontal overflow, and saves screenshots.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/playthrough.mjs http://localhost:4173/ /tmp/coup 1440 900 [reduced]
//
// Uses /usr/bin/google-chrome (override with CHROME=...). SOUND=1 turns sound on first.
import { chromium } from 'playwright-core';

const [, , url = 'http://localhost:4173/', out = '/tmp/coup', w = '1440', h = '900', reduced = ''] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(`${m.type()}: ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));

await page.goto(url);
await page.waitForTimeout(1500);
if (process.env.SOUND) await page.click('button[aria-label^="Sound off"]');
if (!url.includes('autoplay=1')) await page.click('button[type=submit]');
const keys = ['i', 'f', 't', 's', 'e', 'a', 'c', '1', '2', 'Enter'];
const t0 = Date.now();
let shots = 0;
while (Date.now() - t0 < 240_000 && !(await page.$('.gameover'))) {
  await page.waitForTimeout(350);
  await page.keyboard.press(keys[Math.floor(Math.random() * keys.length)]);
  if (Date.now() - t0 > 15_000 * (shots + 1) && shots < 3) await page.screenshot({ path: `${out}-mid${shots++}.png` });
}
const finished = !!(await page.$('.gameover'));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-end.png` });
if (finished) {
  await page.keyboard.press('r');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}-review.png`, fullPage: true });
}
const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
console.log(JSON.stringify({ finished, seconds: Math.round((Date.now() - t0) / 1000), overflowX, errors: [...new Set(errors)] }));
await browser.close();
process.exit(finished && overflowX <= 0 && errors.length === 0 ? 0 : 1);
