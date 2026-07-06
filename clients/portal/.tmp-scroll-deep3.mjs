import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const html = document.documentElement;
  const body = document.body;
  const before = { win: window.scrollY, html: html.scrollTop, body: body.scrollTop };

  // Try html.scrollTop
  html.scrollTop = 300;
  const afterHtml = { win: window.scrollY, html: html.scrollTop, body: body.scrollTop };
  html.scrollTop = 0;

  // Try body.scrollTop
  body.scrollTop = 300;
  const afterBody = { win: window.scrollY, html: html.scrollTop, body: body.scrollTop };
  body.scrollTop = 0;

  // Try scroll on the .firstChild of body (the root layout wrapper)
  const firstChild = body.firstElementChild;
  firstChild.scrollTop = 300;
  const afterChild = { win: window.scrollY, html: html.scrollTop, body: body.scrollTop, child: firstChild.scrollTop, childScrollH: firstChild.scrollHeight, childClientH: firstChild.clientHeight };
  firstChild.scrollTop = 0;

  return { before, afterHtml, afterBody, afterChild, childTag: firstChild.tagName, childClass: firstChild.className };
});
console.log(JSON.stringify(r, null, 2));

await browser.close();
