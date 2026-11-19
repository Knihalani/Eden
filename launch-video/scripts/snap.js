const { chromium } = require("playwright");
(async () => {
  const out = process.argv[2],
    times = process.argv.slice(3).map(Number);
  const b = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", (e) => console.log("ERR", e.message));
  p.on("console", (m) => {
    if (!/GPU stall|GL Driver/.test(m.text())) console.log("c:", m.text());
  });
  await p.goto("http://127.0.0.1:8778/index.html");
  await p.waitForFunction(() => window.READY === true, { timeout: 120000 });
  for (const t of times) {
    await p.evaluate((t) => renderFrame(t), t);
    await p.screenshot({ path: `${out}/f_${t.toFixed(2)}.png` });
  }
  await b.close();
})();
