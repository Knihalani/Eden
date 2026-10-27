/**
 * gate-know-v2: wraps `bun .gauntlet/benches/know-v2/bench.ts --out <tmp.json>` and prints:
 *   v2_gold_hit: N     (gold_hit_rate * 1000, integer)
 *   v2_pack_bytes: N
 * The bench opens the know store at $EDEN_HOME/know, so we point EDEN_HOME at a scratch
 * copy of ~/.eden/know/graph.* to avoid touching the live store.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = "/Users/kaiavnihalani/Downloads/Eden";
const SCRATCH = "/private/tmp/claude-501/-Users-kaiavnihalani-Downloads-Eden/e33660fb-cfbd-4686-a261-fbbcefbe3776/scratchpad";
const home = join(SCRATCH, `gate-know-v2-home-${process.pid}`);
mkdirSync(join(home, "know"), { recursive: true });
for (const f of ["graph.kpk", "graph.jnl", "graph.sqlite"]) {
  const src = join(homedir(), ".eden", "know", f);
  if (existsSync(src)) copyFileSync(src, join(home, "know", f));
}
const out = join(SCRATCH, `gate-know-v2-${process.pid}.json`);

const r = Bun.spawnSync(["bun", ".gauntlet/benches/know-v2/bench.ts", "--out", out], {
  cwd: ROOT,
  env: { ...process.env, EDEN_HOME: home },
  stdout: "pipe",
  stderr: "pipe",
});
const stdout = r.stdout.toString();
const start = stdout.indexOf("\n{");
if (r.exitCode !== 0 || start < 0) {
  process.stderr.write(`know-v2 failed (exit ${r.exitCode})\n${r.stderr.toString().slice(-2000)}`);
  process.exit(1);
}
const j = JSON.parse(stdout.slice(start + 1)) as { gold_hit_rate?: number; pack_bytes?: number };
try {
  rmSync(out, { force: true });
  rmSync(home, { recursive: true, force: true });
} catch {}
console.log(`v2_gold_hit: ${Math.round(Number(j.gold_hit_rate ?? 0) * 1000)}`);
console.log(`v2_pack_bytes: ${Math.round(Number(j.pack_bytes ?? 0))}`);
