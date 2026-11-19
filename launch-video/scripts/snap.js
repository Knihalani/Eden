const { chromium } = require("playwright");
(async () => {
  const times = process.argv.slice(3).map(Number);
  const out = process.argv[2];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("console", (m) => console.log("console:", m.text()));
  p.on("pageerror", (e) => console.log("ERR", e.message));
  await p.goto("http://127.0.0.1:8777/index.html");
  await p.evaluate(() => window.READY);
  for (const t of times) {
    await p.evaluate((t) => renderFrame(t), t);
    await p.screenshot({ path: `${out}/f_${t.toFixed(2)}.png` });
  }
  await b.close();
})();
