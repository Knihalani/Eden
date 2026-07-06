import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const html = document.documentElement;
  const body = document.body;
  const cs = getComputedStyle(html);
  const csb = getComputedStyle(body);
  // Use getBoundingClientRect
  const out = {
    htmlRect: html.getBoundingClientRect(),
    bodyRect: body.getBoundingClientRect(),
    htmlBounding: { top: html.getBoundingClientRect().top, bottom: html.getBoundingClientRect().bottom, height: html.getBoundingClientRect().height },
    bodyBounding: { top: body.getBoundingClientRect().top, bottom: body.getBoundingClientRect().bottom, height: body.getBoundingClientRect().height },
  };
  out.htmlStyle = {
    height: cs.height,
    minHeight: cs.minHeight,
    maxHeight: cs.maxHeight,
    overflow: cs.overflow,
    display: cs.display,
    position: cs.position,
  };
  out.bodyStyle = {
    height: csb.height,
    minHeight: csb.minHeight,
    display: csb.display,
    flexDirection: csb.flexDirection,
    overflow: csb.overflow,
    overflowY: csb.overflowY,
  };

  // What if we set html overflow to scroll
  html.style.overflow = 'scroll';
  out.afterOverflowScroll = {
    scrollH: html.scrollHeight,
    clientH: html.clientHeight,
    offsetH: html.offsetHeight,
    rect: html.getBoundingClientRect().height,
    scrollTop: html.scrollTop,
  };
  // Try scrolling now
  html.scrollTop = 500;
  out.afterOverflowScrollSet = html.scrollTop;

  // Reset
  html.style.overflow = '';
  html.scrollTop = 0;

  // What if we set body overflow to visible
  body.style.overflow = 'visible';
  out.afterBodyVisible = {
    htmlScrollH: html.scrollHeight,
    htmlClientH: html.clientHeight,
    winScrollY: window.scrollY,
  };
  window.scrollTo(0, 400);
  out.afterScroll = { winScrollY: window.scrollY, htmlScrollTop: html.scrollTop };

  return out;
});
console.log(JSON.stringify(r, null, 2));

await browser.close();
