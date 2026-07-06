import { chromium } from 'playwright';

const targets = [
  { url: 'http://127.0.0.1:3457/', name: 'marketing-home' },
  { url: 'http://127.0.0.1:3457/sign-in', name: 'sign-in' },
  { url: 'http://127.0.0.1:3457/sign-up', name: 'sign-up' },
  { url: 'http://127.0.0.1:3457/forgot-password', name: 'forgot-password' },
  { url: 'http://127.0.0.1:3457/reset-password', name: 'reset-password' },
  { url: 'http://127.0.0.1:3457/dashboard', name: 'dashboard' },
  { url: 'http://127.0.0.1:3457/agents', name: 'agents' },
  { url: 'http://127.0.0.1:3457/traces', name: 'traces' },
  { url: 'http://127.0.0.1:3457/settings', name: 'settings' },
  { url: 'http://127.0.0.1:3457/docs', name: 'docs' },
];

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

for (const vp of [{w:1280,h:720,name:'desktop'}, {w:390,h:844,name:'mobile'}]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  const page = await ctx.newPage();
  console.log(`\n###### VIEWPORT: ${vp.name} ${vp.w}x${vp.h} ######`);
  for (const t of targets) {
    try {
      const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        const html = document.documentElement;
        const cs = (el) => getComputedStyle(el);
        const htmlCs = cs(html);
        const bodyCs = cs(document.body);
        // find element at viewport center
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const elAtCenter = document.elementFromPoint(cx, cy);
        // Walk up and check if any ancestor has overflow hidden
        let overflowTrapper = null;
        let walker = elAtCenter;
        while (walker && walker !== html) {
          const w = cs(walker);
          if ((w.overflowY === 'hidden' || w.overflow === 'hidden' || w.overflow === 'clip') && walker.scrollHeight > walker.clientHeight + 2) {
            overflowTrapper = `${walker.tagName}.${walker.className?.toString().slice(0,80)} (${walker.scrollHeight} > ${walker.clientHeight})`;
            break;
          }
          walker = walker.parentElement;
        }
        const scrollBefore = window.scrollY;
        window.scrollTo(0, 400);
        const scrollAfter = window.scrollY;
        window.scrollTo(0, 0);
        // Try a wheel event
        document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }));
        const scrollWheel = window.scrollY;
        return {
          htmlOverflowY: htmlCs.overflowY,
          bodyOverflow: bodyCs.overflow,
          scrollHeight: html.scrollHeight,
          clientHeight: html.clientHeight,
          canScroll: html.scrollHeight > html.clientHeight,
          scrollBefore, scrollAfter, scrollWheel,
          centerTag: elAtCenter ? `${elAtCenter.tagName}` : null,
          centerClass: elAtCenter?.className?.toString().slice(0,80),
          overflowTrapper,
          title: document.title,
        };
      });
      const verdict = (r.canScroll && r.scrollAfter > 0) ? 'SCROLLS OK' :
                      (r.canScroll && r.scrollAfter === 0) ? 'CANNOT SCROLL (bug)' : 'no scroll needed';
      console.log(`[${resp?.status()||'??'}] ${t.name}: ${verdict}`);
      console.log(`    scrollH=${r.scrollHeight}, html.overflowY=${r.htmlOverflowY}, center=${r.centerTag}.${r.centerClass}, trapper=${r.overflowTrapper||'none'}, title="${r.title}"`);
    } catch (e) {
      console.log(`[ERR] ${t.name}: ${e.message.split('\n')[0]}`);
    }
  }
  await ctx.close();
}

await browser.close();
