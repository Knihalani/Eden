import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

// Test removing each style one at a time
async function test(label, fn) {
  const r = await page.evaluate(fn);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(r, null, 2));
}

await test('baseline', () => {
  window.scrollTo(0, 0);
  const before = window.scrollY;
  window.scrollTo(0, 300);
  const after = window.scrollY;
  return { before, after, htmlH: document.documentElement.offsetHeight, htmlClientH: document.documentElement.clientHeight };
});

await test('remove body.overflow-x:hidden', () => {
  document.body.style.overflowX = '';
  window.scrollTo(0, 0);
  const before = window.scrollY;
  window.scrollTo(0, 300);
  const after = window.scrollY;
  return { before, after, htmlH: document.documentElement.offsetHeight, htmlClientH: document.documentElement.clientHeight, bodyOverflowY: getComputedStyle(document.body).overflowY };
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);

await test('remove body flex-col', () => {
  document.body.style.display = 'block';
  window.scrollTo(0, 0);
  const before = window.scrollY;
  window.scrollTo(0, 300);
  const after = window.scrollY;
  return { before, after, htmlH: document.documentElement.offsetHeight, htmlClientH: document.documentElement.clientHeight, bodyDisplay: getComputedStyle(document.body).display };
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);

await test('remove body min-height:100dvh', () => {
  document.body.style.minHeight = '';
  window.scrollTo(0, 0);
  const before = window.scrollY;
  window.scrollTo(0, 300);
  const after = window.scrollY;
  return { before, after, htmlH: document.documentElement.offsetHeight, htmlClientH: document.documentElement.clientHeight, bodyMinH: getComputedStyle(document.body).minHeight };
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);

await test('make body overflow visible', () => {
  document.body.style.overflow = 'visible';
  window.scrollTo(0, 0);
  const before = window.scrollY;
  window.scrollTo(0, 300);
  const after = window.scrollY;
  return { before, after, htmlH: document.documentElement.offsetHeight, htmlClientH: document.documentElement.clientHeight, bodyOverflow: getComputedStyle(document.body).overflow };
});

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);

await test('force html to overflow scroll', () => {
  document.documentElement.style.overflow = 'scroll';
  window.scrollTo(0, 0);
  const before = window.scrollY;
  window.scrollTo(0, 300);
  const after = window.scrollY;
  return { before, after, htmlH: document.documentElement.offsetHeight, htmlClientH: document.documentElement.clientHeight };
});

await browser.close();
