import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.goto('http://127.0.0.1:3457/', { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const body = document.body;
  // walk children
  const tree = [];
  function walk(el, depth) {
    if (depth > 3) return;
    const cs = getComputedStyle(el);
    tree.push({
      depth,
      tag: el.tagName,
      class: el.className?.toString().slice(0, 60) || '',
      id: el.id || '',
      overflow: cs.overflow,
      overflowY: cs.overflowY,
      height: cs.height,
      minHeight: cs.minHeight,
      maxHeight: cs.maxHeight,
      position: cs.position,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      scrollTop: el.scrollTop,
    });
    for (const c of el.children) walk(c, depth + 1);
  }
  walk(body, 0);
  return tree;
});
console.log(JSON.stringify(r, null, 2));

await browser.close();
