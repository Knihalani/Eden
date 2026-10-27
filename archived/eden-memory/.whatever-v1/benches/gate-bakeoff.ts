/**
 * gate-bakeoff: wraps `EDEN_BAKEOFF_SKIP_LLM=1 bun benchmarks/memory-bakeoff/run.ts`,
 * parses the stdout JSON and prints:
 *   bakeoff_rec5: N      (locomo.eden.rec5)
 *   bakeoff_capture: N   (passive.eden.capture)
 *   bakeoff_junkfp: N    (passive.eden.junkFp)
 * EDEN_HOME is pointed at a scratch dir so nothing under ~/.eden is touched.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/kaiavnihalani/Downloads/Eden";
const SCRATCH = "/private/tmp/claude-501/-Users-kaiavnihalani-Downloads-Eden/e33660fb-cfbd-4686-a261-fbbcefbe3776/scratchpad";
const home = join(SCRATCH, `gate-bakeoff-home-${process.pid}`);
mkdirSync(home, { recursive: true });

const r = Bun.spawnSync(["bun", "benchmarks/memory-bakeoff/run.ts"], {
  cwd: ROOT,
  env: { ...process.env, EDEN_BAKEOFF_SKIP_LLM: "1", EDEN_HOME: home },
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = r.stdout.toString();
const start = stdout.indexOf("{");
if (r.exitCode !== 0 || start < 0) {
  process.stderr.write(`bakeoff failed (exit ${r.exitCode})\n${r.stderr.toString().slice(-2000)}`);
  process.exit(1);
}
type Out = { locomo?: { eden?: { rec5?: number } }; passive?: { eden?: { capture?: number; junkFp?: number } } };
const j = JSON.parse(stdout.slice(start)) as Out;
try {
  rmSync(home, { recursive: true, force: true });
} catch {}
console.log(`bakeoff_rec5: ${Math.round(Number(j.locomo?.eden?.rec5 ?? 0))}`);
console.log(`bakeoff_capture: ${Math.round(Number(j.passive?.eden?.capture ?? 0))}`);
console.log(`bakeoff_junkfp: ${Math.round(Number(j.passive?.eden?.junkFp ?? 0))}`);
