const { chromium } = require("playwright");
const { spawn } = require("child_process");
const [, , out, f0S, f1S, wid] = process.argv;
const f0 = +f0S,
  f1 = +f1S,
  FPS = 30;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", (e) => console.log("ERR", e.message));
  await p.goto("http://127.0.0.1:8779/index.html");
  await p.waitForFunction(() => window.READY === true, { timeout: 120000 });
  const ff = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(FPS),
      "-c:v",
      "png",
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "10",
      "-pix_fmt",
      "yuv444p",
      `${out}/chunk_${wid}.mkv`,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  for (let f = f0; f < f1; f++) {
    await p.evaluate((t) => renderFrame(t), f / FPS);
    const buf = await p.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await b.close();
  console.log("done", wid);
})();
