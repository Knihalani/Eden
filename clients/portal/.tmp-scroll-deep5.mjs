import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const html = document.documentElement;
  const cs = getComputedStyle(html);
  const out = {
    html: {
      scrollH: html.scrollHeight,
      clientH: html.clientHeight,
      offsetH: html.offsetHeight,
      scrollTop: html.scrollTop,
      overflow: cs.overflow,
      overflowY: cs.overflowY,
      height: cs.height,
      minHeight: cs.minHeight,
    },
    win: {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      pageYOffset: window.pageYOffset,
    },
    documentScroll: document.scrollingElement ? document.scrollingElement.tagName : null,
    scrollingEl: document.scrollingElement === html ? 'html' : (document.scrollingElement === document.body ? 'body' : 'unknown'),
    bodyScrollH: document.body.scrollHeight,
    bodyClientH: document.body.clientHeight,
    bodyScrollTop: document.body.scrollTop,
  };

  // Try various scroll methods
  html.scrollTop = 500;
  out.after_htmlSet = html.scrollTop;

  document.documentElement.scrollTop = 700;
  out.after_docSet = document.documentElement.scrollTop;

  document.body.scrollTop = 800;
  out.after_bodySet = document.body.scrollTop;

  return out;
});
console.log(JSON.stringify(r, null, 2));

await browser.close();
