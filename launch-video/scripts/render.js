const { chromium } = require("playwright");
const { spawn } = require("child_process");
const [, , outDir, fpsS, f0S, f1S, wid] = process.argv;
const fps = +fpsS,
  f0 = +f0S,
  f1 = +f1S;
(async () => {
  const b = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on("pageerror", (e) => console.log("ERR", e.message));
  await p.goto("http://127.0.0.1:8778/index.html");
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
      String(fps),
      "-c:v",
      "mjpeg",
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "10",
      "-pix_fmt",
      "yuv420p",
      `${outDir}/chunk_${wid}.mkv`,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  for (let f = f0; f < f1; f++) {
    await p.evaluate((t) => renderFrame(t), f / fps);
    const buf = await p.screenshot({ type: "jpeg", quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if ((f - f0) % 60 === 0) console.log(`w${wid} ${f - f0}/${f1 - f0}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await b.close();
  console.log(`w${wid} done`);
})();
