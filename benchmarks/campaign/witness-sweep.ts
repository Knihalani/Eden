/**
 * Wave 2.4 witness-economics sweep.
 *
 * ≥50 go-lives across desk/orders/etl/incident/research (+ high-card).
 * Some rounds starve witnesses so SKIP fires. Prints per-mechanism counts,
 * writes `.gauntlet/refs/08-witness-sweep.json`, exits 0 iff mapped ≥ 0.95
 * and unknown < 0.05 over n ≥ 50.
 *
 *   CAMPAIGN_THINK_MS=0 bun benchmarks/campaign/witness-sweep.ts
 *
 * THINK_MS is forced before session.ts loads (the const is captured at import).
 */
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? "0";

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyGoLive, GO_LIVE_MECHANISMS, type GoLiveMechanism } from "./witness-econ";

type Job = {
  world: string;
  nWitness: number;
  compile: number;
  holdout: number;
  seed: number;
  /** Unscrapable host — traces omit provider tokens. */
  silent?: boolean;
};

type RunRow = {
  world: string;
  nWitness: number;
  compile: number;
  holdout: number;
  seed: number;
  silent?: boolean;
  verdict: string;
  reasons: string[];
  /** Named mechanism, or null for a certified PASS with nothing to tag. */
  mechanism: GoLiveMechanism | null;
  detail: string;
  uncertified?: boolean;
};

const ROOT = resolve(import.meta.dir, "../..");
const OUT = resolve(ROOT, ".gauntlet/refs/08-witness-sweep.json");

async function main() {
  const { Session, THINK_MS } = await import("./session");
  const {
    DESK_IDS,
    INCIDENT_KEYS,
    ORDER_IDS,
    RESEARCH_TOPICS,
    blockSeed,
    createDesk,
    createEtl,
    createIncident,
    createOrders,
    createResearch,
  } = await import("./worlds");
  const { createHighCard } = await import("./coverage-worlds");

  type WorldFactory = () => import("./worlds").World;
  const factories: Record<string, WorldFactory> = {
    desk: createDesk,
    orders: createOrders,
    etl: () => createEtl(6),
    incident: () => createIncident(0.08),
    research: createResearch,
    "high-card": createHighCard,
  };
  const pools: Record<string, (n: number, seed: number) => Array<Record<string, unknown>>> = {
    desk: () => [...DESK_IDS].map((id) => ({ id })),
    orders: () => [...ORDER_IDS].map((orderId) => ({ orderId })),
    etl: () => ["R-S1", "R-S2", "R-S3", "R-S4"].map((run) => ({ run })),
    incident: () => [...INCIDENT_KEYS].map((key) => ({ key })),
    research: () => [...RESEARCH_TOPICS].map((topic) => ({ topic })),
    "high-card": (n, seed) => Array.from({ length: Math.max(n, 1) }, (_, i) => ({ id: `H-${seed}-${i}` })),
  };

  const jobs: Job[] = [];
  const campaign = ["desk", "orders", "etl", "incident", "research"] as const;
  const all = [...campaign, "high-card"] as const;

  // Starve traces → insufficient_traces (compile+holdout = 12, nWitness << 12).
  for (const world of all) {
    for (const nWitness of [3, 4, 5]) {
      jobs.push({ world, nWitness, compile: 9, holdout: 3, seed: 100 + nWitness });
    }
  }
  // Mid witness (8–10): fidelity / width-class / envelope start to show.
  for (const world of all) {
    for (const nWitness of [8, 10]) {
      jobs.push({
        world,
        nWitness,
        compile: nWitness - 3,
        holdout: 3,
        seed: 200 + nWitness,
      });
    }
  }
  // Soak-shaped: 13 witnesses, compile 9 / holdout 3.
  for (const world of campaign) {
    for (const seed of [301, 302]) {
      jobs.push({ world, nWitness: 13, compile: 9, holdout: 3, seed });
    }
  }
  // High-card unique ids: hold-out often empty / OOD → envelope_gap.
  jobs.push({ world: "high-card", nWitness: 12, compile: 9, holdout: 3, seed: 401 });
  jobs.push({ world: "high-card", nWitness: 9, compile: 6, holdout: 3, seed: 402 });
  // Research silent host → unmeasured_usage (no provider tokens on the trace).
  jobs.push({ world: "research", nWitness: 12, compile: 9, holdout: 3, silent: true, seed: 501 });
  jobs.push({ world: "research", nWitness: 10, compile: 7, holdout: 3, silent: true, seed: 502 });
  // Extra cells so n ≥ 50 with a second seed on the mid band.
  jobs.push({ world: "desk", nWitness: 9, compile: 6, holdout: 3, seed: 601 });
  jobs.push({ world: "orders", nWitness: 9, compile: 6, holdout: 3, seed: 602 });
  jobs.push({ world: "incident", nWitness: 9, compile: 6, holdout: 3, seed: 603 });
  jobs.push({ world: "etl", nWitness: 12, compile: 9, holdout: 3, seed: 604 });
  jobs.push({ world: "desk", nWitness: 13, compile: 9, holdout: 3, seed: 605 });
  jobs.push({ world: "orders", nWitness: 8, compile: 5, holdout: 3, seed: 606 });

  const CONCURRENCY = 4;
  console.log(
    `witness-sweep: ${jobs.length} go-lives, CAMPAIGN_THINK_MS=${process.env.CAMPAIGN_THINK_MS} THINK_MS=${THINK_MS}, concurrency=${CONCURRENCY}`,
  );

  async function runJob(job: Job): Promise<RunRow> {
    const factory = factories[job.world]!;
    const pool = pools[job.world]!(job.nWitness, job.seed);
    const s = new Session([[job.world, factory]], true, { scrapeUsage: job.silent ? false : undefined });
    for (let i = 0; i < job.nWitness; i++) {
      await s.stretch(job.world, pool[i % pool.length]!, blockSeed(`we-${job.world}-${job.seed}`, i));
    }
    const r = await s.goLive(job.world, {
      compile: job.compile,
      holdout: job.holdout,
      sandbox: factory,
      maxGram: 26,
    });
    const classified = classifyGoLive(r.reasons, r.verdict);
    let mechanism: GoLiveMechanism | null = r.mechanism ?? classified.mechanism;
    // Certified PASS omits mechanism — that is mapped, not unknown.
    if (r.verdict === "PASS" && !r.uncertified && r.mechanism == null && classified.mechanism === "unknown") {
      mechanism = null;
    }
    return {
      world: job.world,
      nWitness: job.nWitness,
      compile: job.compile,
      holdout: job.holdout,
      silent: job.silent,
      seed: job.seed,
      verdict: r.verdict,
      reasons: r.reasons,
      mechanism,
      detail: classified.detail,
      uncertified: r.uncertified,
    };
  }

  const rows: RunRow[] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const chunk = jobs.slice(i, i + CONCURRENCY);
    const got = await Promise.all(chunk.map(runJob));
    rows.push(...got);
    const done = Math.min(i + CONCURRENCY, jobs.length);
    process.stdout.write(
      `  ${done}/${jobs.length}  last=${got.map((g) => `${g.world}:${g.verdict}/${g.mechanism ?? "pass"}`).join(" ")}\n`,
    );
  }

  const n = rows.length;
  const counts: Record<string, number> = {};
  for (const m of GO_LIVE_MECHANISMS) counts[m] = 0;
  counts["pass"] = 0;
  for (const r of rows) {
    if (r.mechanism == null) counts["pass"] = (counts["pass"] ?? 0) + 1;
    else counts[r.mechanism] = (counts[r.mechanism] ?? 0) + 1;
  }
  const unknownN = rows.filter((r) => r.mechanism === "unknown").length;
  const mappedN = n - unknownN;
  const mapped = mappedN / n;
  const unknown = unknownN / n;
  const unknowns = rows.filter((r) => r.mechanism === "unknown");

  console.log("\n==================== WITNESS-ECON SWEEP ====================");
  const nameWidth = Math.max(...Object.keys(counts).map((k) => k.length));
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (v === 0 && k !== "unknown") continue;
    console.log(`  ${k.padEnd(nameWidth)}  ${v}`);
  }
  console.log(
    `n=${n}  mapped=${mapped.toFixed(4)} (${mappedN}/${n})  unknown=${unknown.toFixed(4)} (${unknownN}/${n})`,
  );
  if (unknowns.length) {
    console.log("\nunknown leftover (tighten classify from these strings):");
    for (const u of unknowns) {
      console.log(`  [${u.world} nW=${u.nWitness} ${u.verdict}] ${u.reasons.join(" ; ") || "(empty)"}`);
    }
  }

  mkdirSync(resolve(ROOT, ".gauntlet/refs"), { recursive: true });
  const payload = {
    n,
    mapped,
    unknown,
    mappedN,
    unknownN,
    counts,
    thinkMs: Number(process.env.CAMPAIGN_THINK_MS ?? 0),
    unknowns: unknowns.map((u) => ({
      world: u.world,
      nWitness: u.nWitness,
      verdict: u.verdict,
      reasons: u.reasons,
      detail: u.detail,
    })),
    runs: rows,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`wrote ${OUT}`);

  const ok = n >= 50 && mapped >= 0.95 && unknown < 0.05;
  console.log(ok ? "SWEEP OK" : "SWEEP FAIL");
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
