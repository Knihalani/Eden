import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

// Each test reloads to start fresh
async function cleanTest(label, fn) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const r = await page.evaluate(fn);
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(r, null, 2));
}

await cleanTest('baseline', () => {
  window.scrollTo(0, 0);
  window.scrollTo(0, 300);
  return { scrollY: window.scrollY };
});

await cleanTest('remove body min-height:100dvh', () => {
  document.body.style.minHeight = '0px';
  window.scrollTo(0, 0);
  window.scrollTo(0, 300);
  return { scrollY: window.scrollY, bodyMinH: getComputedStyle(document.body).minHeight };
});

await cleanTest('remove body min-height:100dvh and keep flex', () => {
  document.body.style.minHeight = '0px';
  // keep flex
  window.scrollTo(0, 0);
  window.scrollTo(0, 300);
  return { scrollY: window.scrollY, bodyMinH: getComputedStyle(document.body).minHeight, bodyDisplay: getComputedStyle(document.body).display };
});

await cleanTest('remove body min-height:100dvh and overflow-y:auto', () => {
  document.body.style.minHeight = '0px';
  document.body.style.overflow = 'visible';
  window.scrollTo(0, 0);
  window.scrollTo(0, 300);
  return { scrollY: window.scrollY, bodyMinH: getComputedStyle(document.body).minHeight, bodyOverflow: getComputedStyle(document.body).overflow };
});

await cleanTest('remove body min-height:100dvh, only that', () => {
  document.body.style.minHeight = 'auto';
  window.scrollTo(0, 0);
  window.scrollTo(0, 300);
  return { scrollY: window.scrollY, bodyMinH: getComputedStyle(document.body).minHeight };
});

await browser.close();
