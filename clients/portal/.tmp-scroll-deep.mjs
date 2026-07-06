import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const html = document.documentElement;
  const body = document.body;

  // Try every scroll method
  const out = { htmlScrollHeight: html.scrollHeight, htmlClientHeight: html.clientHeight, bodyScrollHeight: body.scrollHeight, bodyClientHeight: body.clientHeight };

  // Method 1: scrollTo on window
  out.before1 = window.scrollY;
  window.scrollTo({ top: 200, behavior: 'instant' });
  out.after1 = window.scrollY;

  // Method 2: scrollTo on html
  out.before2 = window.scrollY;
  html.scrollTop = 200;
  out.after2 = html.scrollTop;

  // Method 3: scrollTo on body
  body.scrollTop = 200;
  out.after3 = body.scrollTop;

  // Method 4: scrollIntoView on first child
  out.before4 = window.scrollY;
  const firstSection = document.querySelector('main > *') || document.querySelector('section');
  if (firstSection) firstSection.scrollIntoView();
  out.after4 = window.scrollY;

  // Method 5: scroll by user gesture
  document.documentElement.scrollTop = 500;
  out.after5 = document.documentElement.scrollTop;
  document.body.scrollTop = 500;
  out.after5b = document.body.scrollTop;

  // Method 6: dispatch wheel and check preventDefault was called
  let wheelDefaultPrevented = false;
  const handler = (e) => { if (e.defaultPrevented) wheelDefaultPrevented = true; };
  document.addEventListener('wheel', handler, true);
  document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true }));
  document.removeEventListener('wheel', handler, true);
  out.wheelDefaultPrevented = wheelDefaultPrevented;
  out.afterWheel = window.scrollY;

  // Check html computed style more thoroughly
  const htmlCs = getComputedStyle(html);
  const bodyCs = getComputedStyle(body);
  out.htmlDetails = {
    position: htmlCs.position,
    overflow: htmlCs.overflow,
    overflowX: htmlCs.overflowX,
    overflowY: htmlCs.overflowY,
    height: htmlCs.height,
    minHeight: htmlCs.minHeight,
    maxHeight: htmlCs.maxHeight,
  };
  out.bodyDetails = {
    position: bodyCs.position,
    overflow: bodyCs.overflow,
    overflowX: bodyCs.overflowX,
    overflowY: bodyCs.overflowY,
    height: bodyCs.height,
    minHeight: bodyCs.minHeight,
    maxHeight: bodyCs.maxHeight,
    display: bodyCs.display,
    flexDirection: bodyCs.flexDirection,
  };

  // Walk to find any ancestor with overflow hidden between body and html
  let walker = body.firstElementChild;
  while (walker) {
    const cs = getComputedStyle(walker);
    out.firstChildOverflow = `${walker.tagName}.${walker.className?.toString().slice(0,80)}: overflow=${cs.overflow}, overflowY=${cs.overflowY}, height=${cs.height}, minHeight=${cs.minHeight}, scrollHeight=${walker.scrollHeight}`;
    walker = walker.firstElementChild;
    if (walker && walker.children.length > 5) break;
  }

  return out;
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
