import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  // Reproduce the original probe pattern
  const before = window.scrollY;
  window.scrollTo(0, 400);
  const after = window.scrollY;
  return { before, after, html: document.documentElement.scrollHeight, client: document.documentElement.clientHeight };
});

console.log('Test1:', JSON.stringify(r));

// Try with a different scroll value
const r2 = await page.evaluate(() => {
  const before = window.scrollY;
  window.scrollTo(0, 1000);
  const after = window.scrollY;
  return { before, after };
});
console.log('Test2:', JSON.stringify(r2));

// Try wheel
const r3 = await page.evaluate(async () => {
  // reset
  window.scrollTo(0, 0);
  const before = window.scrollY;
  // dispatch wheel on the element at center
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const target = document.elementFromPoint(cx, cy);
  target?.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 100));
  const after = window.scrollY;
  return { before, after, target: target?.tagName + '.' + target?.className?.toString().slice(0,40) };
});
console.log('Test3:', JSON.stringify(r3));

// Try scrollIntoView
const r4 = await page.evaluate(() => {
  window.scrollTo(0, 0);
  const before = window.scrollY;
  const footer = document.querySelector('footer') || document.body.lastElementChild;
  footer.scrollIntoView({ behavior: 'instant' });
  const after = window.scrollY;
  return { before, after, footer: footer?.tagName + '.' + footer?.className?.toString().slice(0,40) };
});
console.log('Test4:', JSON.stringify(r4));

// Now test docs page
await page.goto('http://127.0.0.1:3457/docs', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);
const r5 = await page.evaluate(() => {
  const before = window.scrollY;
  window.scrollTo(0, 400);
  const after = window.scrollY;
  return { before, after, html: document.documentElement.scrollHeight, client: document.documentElement.clientHeight };
});
console.log('Docs Test:', JSON.stringify(r5));

await browser.close();
