/**
 * Noise-floor calibration runner.
 *
 * For every campaign scenario: run A/A (raw vs raw) with the Session driver,
 * feed wall_ms pairs into @eden/measure calibrate(), print a table, write
 * benchmarks/campaign/NOISE-FLOOR.md.
 *
 * Usage: bun run benchmarks/campaign/calibrate.ts [--fast] [--json]
 *
 * CAMPAIGN_THINK_MS is forced to 1 so think-time does not dominate wall.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { calibrate, type AaPair, type Calibration } from "@eden/measure";
import { Session, type WorldFactory } from "./session";
import {
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
  createThrash,
} from "./worlds";
import { createNoise, createCreative, createMicro, createFastDesk, createChaos } from "./negative-worlds";
import {
  LONG_SESSION_IDS,
  armSlowToolLive,
  createHighCard,
  createLongSession,
  createPagination,
  createPaginationBindable,
  createSlowTool,
} from "./coverage-worlds";

process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? "1";

const FAST = process.argv.includes("--fast");
const JSON_OUT = process.argv.includes("--json");

const REPEATS = FAST ? 4 : 8;
const STRETCHES = FAST ? 2 : 4;
/** Monte Carlo budget — keep the post-process cheap. */
const FL_TRIALS = FAST ? 1500 : 4000;
const LV_TRIALS = FAST ? 600 : 1500;

type ScenarioKind = "measured" | "modeled";

type ScenarioSpec = {
  name: string;
  kind: ScenarioKind;
  /** When modeled, copy jitter from this measured scenario. */
  proxyOf?: string;
  runAaPair: (repeat: number) => Promise<AaPair>;
};

async function rawSession(
  worldName: string,
  factory: WorldFactory,
  goals: Array<Record<string, unknown>>,
  seedPrefix: string,
  opts: { enforce?: boolean; concurrent?: boolean } = {},
): Promise<number> {
  const s = new Session([[worldName, factory]], false);
  if (opts.enforce) {
    // raw arm has no wrap state; enforce is a no-op here (A/A is raw×raw).
  }
  if (opts.concurrent && goals.length >= 3) {
    await s.stretchConcurrent(worldName, goals.slice(0, 3), blockSeed(seedPrefix, 0));
  } else {
    for (let i = 0; i < goals.length; i++) {
      await s.stretch(worldName, goals[i]!, blockSeed(seedPrefix, i));
    }
  }
  return s.finish().wall_ms;
}

async function aaPair(
  worldName: string,
  factory: WorldFactory,
  goals: Array<Record<string, unknown>>,
  repeat: number,
  opts: { concurrent?: boolean } = {},
): Promise<AaPair> {
  // Same goals + same seeds on both arms — isolates machine jitter.
  const seedPrefix = `cal-${worldName}-r${repeat}`;
  const a = await rawSession(worldName, factory, goals, seedPrefix, opts);
  const b = await rawSession(worldName, factory, goals, seedPrefix, opts);
  return { a, b };
}

function deskGoals(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: DESK_IDS[i % DESK_IDS.length],
    text: "requesting refund for outage",
  }));
}
function ordersGoals(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ orderId: ORDER_IDS[i % ORDER_IDS.length] }));
}
function etlGoals(n: number): Array<Record<string, unknown>> {
  const runs = ["R-8801", "R-8802", "R-8803", "R-8804"];
  return Array.from({ length: n }, (_, i) => ({ run: runs[i % runs.length] }));
}
function incidentGoals(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ key: INCIDENT_KEYS[i % INCIDENT_KEYS.length] }));
}
function researchGoals(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ topic: RESEARCH_TOPICS[i % RESEARCH_TOPICS.length] }));
}

function buildSpecs(): ScenarioSpec[] {
  const n = STRETCHES;
  const measured: ScenarioSpec[] = [
    {
      name: "short-support",
      kind: "measured",
      runAaPair: (r) => aaPair("desk", createDesk, deskGoals(1), r),
    },
    {
      name: "short-overhead",
      kind: "measured",
      runAaPair: async (r) => {
        const run = async () => {
          const s = new Session(
            [
              ["desk", createDesk],
              ["research", createResearch],
            ],
            false,
          );
          await s.stretch("desk", { id: DESK_IDS[0] }, blockSeed(`cal-ovh-${r}`, 0));
          await s.stretch("research", { topic: RESEARCH_TOPICS[0] }, blockSeed(`cal-ovh-${r}`, 1));
          return s.finish().wall_ms;
        };
        return { a: await run(), b: await run() };
      },
    },
    {
      name: "long-desk",
      kind: "measured",
      runAaPair: (r) => aaPair("desk", createDesk, deskGoals(n), r),
    },
    {
      name: "long-orders",
      kind: "measured",
      runAaPair: (r) => aaPair("orders", createOrders, ordersGoals(n), r),
    },
    {
      name: "long-etl",
      kind: "measured",
      runAaPair: (r) => aaPair("etl", () => createEtl(8), etlGoals(n), r),
    },
    {
      name: "long-incident",
      kind: "measured",
      runAaPair: (r) => aaPair("incident", () => createIncident(0.12), incidentGoals(n), r),
    },
    {
      name: "ood-long",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "incident",
          () => createIncident(0),
          Array.from({ length: n }, (_, i) => ({ key: `novel-${i % 3}` })),
          r,
        ),
    },
    {
      name: "oblivious-long",
      kind: "measured",
      runAaPair: async (r) => {
        const goals = deskGoals(n);
        const run = async () => {
          const s = new Session([["desk", createDesk]], false, { aware: false });
          for (let i = 0; i < goals.length; i++) {
            await s.stretch("desk", goals[i]!, blockSeed(`cal-obl-${r}`, i));
          }
          return s.finish().wall_ms;
        };
        return { a: await run(), b: await run() };
      },
    },
    {
      name: "thrash-enforce",
      kind: "measured",
      runAaPair: async (r) => {
        const cycles = FAST ? 4 : 6;
        const run = async (tag: string) => {
          const svc = `cal-thrash-${r}-${tag}`;
          const s = new Session([["thrash", () => createThrash(cycles)]], false);
          await s.stretch("thrash", { svc }, blockSeed(svc, 0));
          return s.finish().wall_ms;
        };
        // Same seed material via deterministic svc naming pattern + blockSeed.
        const a = await run("a");
        const b = await run("a"); // identical goal seed path
        return { a, b };
      },
    },
    {
      name: "unique-work",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "noise",
          createNoise,
          Array.from({ length: Math.min(n, 3) }, (_, i) => ({ id: `N-${i}` })),
          r,
        ),
    },
    {
      name: "creative",
      kind: "measured",
      runAaPair: (r) => aaPair("creative", createCreative, [{ id: "C-1" }, { id: "C-2" }].slice(0, Math.min(n, 2)), r),
    },
    {
      name: "micro",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "micro",
          createMicro,
          Array.from({ length: Math.min(n * 2, 6) }, (_, i) => ({ id: `M-${(i % 2) + 1}` })),
          r,
        ),
    },
    {
      name: "fastdesk-live",
      kind: "measured",
      runAaPair: (r) => aaPair("fastdesk", createFastDesk, [{ id: "F-1" }], r),
    },
    {
      name: "drift",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "desk",
          createDesk,
          [...DESK_IDS.slice(0, 2).map((id) => ({ id })), { id: "Z-9001" }, { id: "Z-9002" }].slice(0, n),
          r,
        ),
    },
    {
      name: "chaos-observe",
      kind: "measured",
      runAaPair: (r) => aaPair("chaos", createChaos, [{ key: "svc-a" }, { key: "svc-b" }].slice(0, Math.min(n, 2)), r),
    },
    {
      name: "concurrent",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "desk",
          createDesk,
          DESK_IDS.slice(0, 3).map((id) => ({ id, text: "requesting refund for outage" })),
          r,
          { concurrent: true },
        ),
    },
    {
      name: "chaos-enforce",
      kind: "measured",
      runAaPair: (r) => aaPair("chaos", createChaos, [{ key: "svc-a" }, { key: "svc-b" }].slice(0, Math.min(n, 2)), r),
    },
    {
      name: "slow-tool-timeout",
      kind: "measured",
      runAaPair: (r) => {
        // Unarmed: sleep is short so A/A isolates machine jitter, not wrap timeout.
        armSlowToolLive(false);
        return aaPair(
          "slow-tool",
          createSlowTool,
          Array.from({ length: Math.min(n, 2) }, (_, i) => ({ id: `T-${i + 1}` })),
          r,
        );
      },
    },
    {
      name: "very-long-session",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "long-session",
          createLongSession,
          Array.from({ length: n }, (_, i) => ({ id: LONG_SESSION_IDS[i % LONG_SESSION_IDS.length] })),
          r,
        ),
    },
    {
      name: "high-card-ids",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "high-card",
          createHighCard,
          Array.from({ length: n }, (_, i) => ({ id: `H-cal-${r}-${i}` })),
          r,
        ),
    },
    {
      name: "pagination-loop",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "pagination",
          createPagination,
          Array.from({ length: Math.min(n, 2) }, (_, i) => ({ batch: `B-${r}-${i}` })),
          r,
        ),
    },
    {
      name: "pagination-bindable",
      kind: "measured",
      runAaPair: (r) =>
        aaPair(
          "pagination-bindable",
          createPaginationBindable,
          Array.from({ length: Math.min(n, 2) }, (_, i) => ({ batch: `PB-${r}-${i}` })),
          r,
        ),
    },
  ];

  return measured;
}

function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return "∞";
  return `${(x * 100).toFixed(2)}%`;
}

function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return "∞";
  if (Math.abs(x) >= 100) return x.toFixed(1);
  if (Math.abs(x) >= 1) return x.toFixed(2);
  return x.toFixed(4);
}

type Row = {
  name: string;
  kind: ScenarioKind;
  proxyOf?: string;
  pairs: AaPair[];
  cal: Calibration;
};

function renderMarkdown(
  rows: Row[],
  meta: { fast: boolean; repeats: number; stretches: number; host: string; when: string },
): string {
  const lines: string[] = [];
  lines.push("# Noise floor — A/A calibration");
  lines.push("");
  lines.push(`Generated: ${meta.when}`);
  lines.push(`Host: \`${meta.host}\``);
  const mode = meta.fast
    ? "**--fast** (reduced repeats/stretches — treat as indicative)"
    : "full (modest stretch counts)";
  lines.push(`Mode: ${mode}`);
  lines.push(
    `Design: ${meta.repeats} A/A pairs × ${meta.stretches} stretches/session (scenario-specific; see ` +
      `runner), \`CAMPAIGN_THINK_MS=${process.env.CAMPAIGN_THINK_MS}\`.`,
  );
  lines.push("");
  lines.push("## Frozen formulas");
  lines.push("");
  lines.push("```");
  lines.push("relativeDelta_i = (b_i - a_i) / max(a_i, eps)");
  lines.push("relativeSd      = stdev(relativeDeltas)");
  lines.push("stability       = clamp(1 - relativeSd / 0.05, 0, 1)   # 1 = quieter than 5% CV");
  lines.push("mdeAbs(n)       = minDetectableEffect(stdev(b-a), n)  # alpha=0.05, power=0.8");
  lines.push("mdeRel(n)       = mdeAbs(n) / max(|mean(a)|, eps)");
  lines.push("falseLoss(n)    = P(sign(mean) flips | trueRel=+0.1%, relSd)  # mulberry32 MC");
  lines.push("lossVerdict(n)  = P(LOSS @ α=0.05 | trueRel=+0.1%, relSd)     # perm+bootstrap");
  lines.push("```");
  lines.push("");
  lines.push("## Per-scenario MDE (wall_ms)");
  lines.push("");
  lines.push(
    "| scenario | kind | n pairs | stability | relSd | MDE@8 abs / rel | MDE@12 abs / rel | MDE@16 abs " +
      "/ rel | P(sign-flip)\\|0.1% @8 | P(LOSS)\\|0.1% @8 |",
  );
  lines.push("|---|---|---:|---:|---:|---|---|---|---:|---:|");
  for (const r of rows) {
    const m8 = r.cal.mde.find((m) => m.n === 8)!;
    const m12 = r.cal.mde.find((m) => m.n === 12)!;
    const m16 = r.cal.mde.find((m) => m.n === 16)!;
    const fl = r.cal.falseLoss.find((f) => f.n === 8)?.rate ?? NaN;
    const lv = r.cal.lossVerdict.find((f) => f.n === 8)?.rate ?? NaN;
    const kind = r.kind === "modeled" ? `MODELED←${r.proxyOf}` : "measured";
    lines.push(
      `| ${r.name} | ${kind} | ${r.cal.nPairs} | ${r.cal.stability.toFixed(3)} ` +
        `| ${fmtPct(r.cal.relativeSd)} | ${fmtNum(m8.absolute)} / ${fmtPct(m8.relative)} ` +
        `| ${fmtNum(m12.absolute)} / ${fmtPct(m12.relative)} | ${fmtNum(m16.absolute)} ` +
        `/ ${fmtPct(m16.relative)} | ${fmtPct(fl)} | ${fmtPct(lv)} |`,
    );
  }
  lines.push("");
  lines.push("## How to read this");
  lines.push("");
  lines.push("- **stability** near 1 → machine quieter than 5% A/A CV; near 0 → too noisy for sub-percent claims.");
  lines.push("- **P(sign-flip)|0.1%** predicts creative-style direction flips of a true +0.1% wall overhead.");
  lines.push("- **P(LOSS)|0.1%** predicts how often `decide()` would call LOSS at α=0.05 for that tiny true overhead.");
  lines.push("- Re-run after hardware / runner image changes. See `CI-RUNNER.md`.");
  const noisy = rows.filter((r) => r.cal.stability < 0.2);
  if (noisy.length) {
    lines.push("");
    lines.push("## CI implications");
    lines.push("");
    lines.push("Rows with **stability < 0.2** must not gate merges on `wall_ms`:");
    lines.push("");
    lines.push("| scenario | stability | relSd | MDE@8 rel | what gates instead |");
    lines.push("|---|---:|---:|---:|---|");
    for (const r of noisy) {
      const m8 = r.cal.mde.find((m) => m.n === 8)!;
      lines.push(
        `| ${r.name} | ${r.cal.stability.toFixed(3)} | ${fmtPct(r.cal.relativeSd)} | ${fmtPct(m8.relative)} ` +
          `| correctness / compile outcome; not wall_ms |`,
      );
    }
  }
  if (meta.fast) {
    lines.push("- This file was produced with `--fast`. Re-run without `--fast` before trusting CI thresholds.");
  }
  lines.push("");
  return lines.join("\n");
}

function printTable(rows: Row[]): void {
  console.log("\n==================== NOISE FLOOR ====================");
  console.log(
    `${"scenario".padEnd(22)} ${"stab".padStart(5)} ${"relSd".padStart(8)} ${"MDE@8".padStart(14)} ` +
      `${"MDE@12".padStart(14)} ${"MDE@16".padStart(14)} ${"flip@8".padStart(8)} ${"LOSS@8".padStart(8)}`,
  );
  for (const r of rows) {
    const m8 = r.cal.mde.find((m) => m.n === 8)!;
    const m12 = r.cal.mde.find((m) => m.n === 12)!;
    const m16 = r.cal.mde.find((m) => m.n === 16)!;
    const fl = r.cal.falseLoss.find((f) => f.n === 8)?.rate ?? NaN;
    const lv = r.cal.lossVerdict.find((f) => f.n === 8)?.rate ?? NaN;
    const tag = r.kind === "modeled" ? "*" : " ";
    console.log(
      `${(r.name + tag).padEnd(22)} ${r.cal.stability.toFixed(2).padStart(5)} ` +
        `${fmtPct(r.cal.relativeSd).padStart(8)} ` +
        `${(fmtNum(m8.absolute) + "/" + fmtPct(m8.relative)).padStart(14)} ` +
        `${(fmtNum(m12.absolute) + "/" + fmtPct(m12.relative)).padStart(14)} ` +
        `${(fmtNum(m16.absolute) + "/" + fmtPct(m16.relative)).padStart(14)} ${fmtPct(fl).padStart(8)} ` +
        `${fmtPct(lv).padStart(8)}`,
    );
  }
  console.log("(* = MODELED from proxy; see NOISE-FLOOR.md)");
  console.log("=====================================================\n");
}

async function main() {
  console.log(
    `Noise-floor calibration — fast=${FAST} think_ms=${process.env.CAMPAIGN_THINK_MS} ` +
      `repeats=${REPEATS} stretches≈${STRETCHES}`,
  );
  const specs = buildSpecs();
  const rows: Row[] = [];

  for (let si = 0; si < specs.length; si++) {
    const spec = specs[si]!;
    console.log(`[${si + 1}/${specs.length}] ${spec.name} (${spec.kind})…`);
    const pairs: AaPair[] = [];
    for (let r = 0; r < REPEATS; r++) {
      pairs.push(await spec.runAaPair(r));
      if ((r + 1) % 2 === 0 || r === REPEATS - 1) {
        console.log(`  pairs ${r + 1}/${REPEATS}`);
      }
    }
    const cal = calibrate(pairs, {
      ns: [8, 12, 16],
      trueRelativeOverhead: 0.001,
      falseLossTrials: FL_TRIALS,
      lossVerdictTrials: LV_TRIALS,
      seed: 0x5eed ^ blockSeed(spec.name, 0),
    });
    rows.push({ name: spec.name, kind: spec.kind, proxyOf: spec.proxyOf, pairs, cal });
  }

  printTable(rows);

  const host = `${process.platform}-${process.arch}`;
  const when = new Date().toISOString();
  const md = renderMarkdown(rows, { fast: FAST, repeats: REPEATS, stretches: STRETCHES, host, when });
  const outPath = resolve(import.meta.dir, "NOISE-FLOOR.md");
  writeFileSync(outPath, md);
  console.log(`Wrote ${outPath}`);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          name: r.name,
          kind: r.kind,
          proxyOf: r.proxyOf,
          stability: r.cal.stability,
          relativeSd: r.cal.relativeSd,
          deltaSd: r.cal.deltaSd,
          mde: r.cal.mde,
          falseLoss: r.cal.falseLoss,
          lossVerdict: r.cal.lossVerdict,
        })),
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
