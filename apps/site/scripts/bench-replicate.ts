#!/usr/bin/env bun
/**
 * Repeat the frozen fair and harder protocols. Does not change prompts or scoring.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const DEST = join(ROOT, "apps/site/scripts/replicate");
const N = Number(process.env.BENCH_REPLICATE_N || 3);

mkdirSync(DEST, { recursive: true });

function killPort(port: number) {
  const r = Bun.spawnSync(["sh", "-c", `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`]);
  void r;
}

function summarize(path: string) {
  const j = JSON.parse(readFileSync(path, "utf8")) as {
    totals: {
      without: { wall_ms: number; cost_usd: number; quality: number; qualityMax: number };
      with: { wall_ms: number; cost_usd: number; quality: number; qualityMax: number };
    };
  };
  const w = j.totals.with;
  const n = j.totals.without;
  return {
    quality_with: w.quality,
    quality_without: n.quality,
    quality_max: w.qualityMax,
    wall_with_s: Math.round(w.wall_ms / 100) / 10,
    wall_without_s: Math.round(n.wall_ms / 100) / 10,
    cost_with: Number(w.cost_usd.toFixed(4)),
    cost_without: Number(n.cost_usd.toFixed(4)),
    win_quality: w.quality >= n.quality,
    win_wall: w.wall_ms < n.wall_ms,
    win_cost: w.cost_usd < n.cost_usd,
    win_all: w.quality >= n.quality && w.wall_ms < n.wall_ms && w.cost_usd < n.cost_usd,
  };
}

const jobs = [
  {
    name: "fair",
    script: join(ROOT, "apps/site/scripts/bench-horizon.ts"),
    tmp: "/tmp/eden-horizon",
    ports: [8793, 8794],
    live: join(ROOT, "apps/site/scripts/bench-horizon-results.json"),
  },
  {
    name: "hard",
    script: join(ROOT, "apps/site/scripts/bench-horizon-hard.ts"),
    tmp: "/tmp/eden-horizon-hard",
    ports: [8795, 8796],
    live: join(ROOT, "apps/site/scripts/bench-horizon-hard-results.json"),
  },
];

const rows: Array<{ protocol: string; i: number } & ReturnType<typeof summarize>> = [];

for (const job of jobs) {
  for (let i = 1; i <= N; i++) {
    console.log(`\n=== replicate ${job.name} ${i}/${N} ===`);
    for (const p of job.ports) killPort(p);
    Bun.spawnSync(["rm", "-rf", job.tmp]);
    const proc = Bun.spawn(["bun", job.script], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`${job.name} ${i} exited ${code}`);
      writeFileSync(join(DEST, "summary.json"), JSON.stringify({ ok: false, failed: `${job.name}-${i}`, rows }, null, 2));
      process.exit(code || 1);
    }
    const dest = join(DEST, `${job.name}-${i}.json`);
    if (existsSync(job.live)) {
      writeFileSync(dest, readFileSync(job.live));
      const s = summarize(dest);
      rows.push({ protocol: job.name, i, ...s });
      console.log(JSON.stringify({ protocol: job.name, i, ...s }));
    }
  }
}

const summary = {
  ok: true,
  n: N,
  fair_wins: rows.filter((r) => r.protocol === "fair" && r.win_all).length,
  hard_wins: rows.filter((r) => r.protocol === "hard" && r.win_all).length,
  rows,
};
writeFileSync(join(DEST, "summary.json"), JSON.stringify(summary, null, 2));
console.log("\n=== REPLICATE SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));
if (summary.fair_wins < N || summary.hard_wins < N) process.exit(2);
