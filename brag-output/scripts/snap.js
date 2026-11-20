const { chromium } = require("playwright");
(async () => {
  const out = process.argv[2];
  const beats = process.argv.slice(3).map(Number);
  const PB = 0.41386;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", (e) => console.log("ERR", e.message));
  await p.goto("http://127.0.0.1:8779/index.html");
  await p.waitForFunction(() => window.READY === true, { timeout: 120000 });
  for (const bt of beats) {
    const t = bt * PB;
    await p.evaluate((t) => renderFrame(t), t);
    await p.screenshot({ path: `${out}/b${bt.toFixed(2).padStart(6, "0")}.png` });
  }
  await b.close();
})();
