const { chromium } = require("playwright");
const { spawn } = require("child_process");
const [, , outDir, fpsS, startS, endS, wid] = process.argv;
const fps = +fpsS,
  f0 = Math.round(+startS * fps),
  f1 = Math.round(+endS * fps);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", (e) => console.log("ERR", e.message));
  await p.goto("http://127.0.0.1:8777/index.html");
  await p.evaluate(() => window.READY);
  const ff = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-c:v",
      "png",
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv444p",
      `${outDir}/chunk_${wid}.mkv`,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  for (let f = f0; f < f1; f++) {
    await p.evaluate((t) => renderFrame(t), f / fps);
    const buf = await p.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if ((f - f0) % 120 === 0) console.log(`w${wid} ${f - f0}/${f1 - f0}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await b.close();
  console.log(`w${wid} done`);
})();
