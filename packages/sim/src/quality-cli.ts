#!/usr/bin/env bun
/**
 * bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic|ideal|entities|
 *   zoo-tune|zoo-a|zoo-b] [--planner [--planner-max-calls 3] [--planner-no-cascade] [--planner-cascade-min 0.05]
 *   [--planner-no-reuse] [--planner-deadline-margin 2] [--planner-latency-quantile 0.9]
 *   [--planner-mode serve|shadow] [--promote-after N]] [--time 0] [--wait 0]
 *   [--noise 1] [--updates 0] [--deletes 0] [--push none|signals|payload] [--lost-notices 0]
 *   [--null-proves-nothing]
 *   [--refresh-after-hours H] [--tool-rate 0.4]
 *   [--judge none|perfect|noisy] [--live] [--brief] [--config '{"probes":true}']
 *   [--timeline out.jsonl] [--sync]
 *   [--cards DIR/cards-v2.jsonl]
 *   [--jobs N] [--user-range A:B] [--tally] [--source-profile JSON|FILE]
 *
 * `--source-profile` overrides fields of the chosen `--profile` per source (`withOverrides`, as pi-ab.ts's flag does
 * over REALISTIC): e.g. `'{"gmail":{"errorRate":1}}'` for a Gmail outage, `'{"crm":{"ratePerSec":1}}'` for a 429 storm.
 *
 * Plays generated sessions over simulated sources and prints the quality report as JSON. Without --live no model is
 * used (free, deterministic at --time 0). --time 1 runs source latency and agent pacing in real time.
 * --timeline records every engine span, per user, with CPU% and RSS each second (`lab/timeline.ts`); read it with
 * `lab/timeline-report.ts`.
 *
 * Shards: users are independent (own world, seeds, engine), and at --time 0 they play one after another, so
 * `--jobs N` runs N processes of this script, each on a contiguous `--user-range A:B` (users A to B-1, with the seeds
 * they have in the whole run) printing its raw tally (`--tally`), and merges the tallies before any ratio or
 * percentile: the JSON is the one-process run's except wall time, CPU time and latency. Refused with --live (each
 * shard would spend on its own, outside any shared ledger) and --timeline (one file, one writer).
 */
import { checkEngineConfig } from "@eden/engine";
import { OpenRouterModel } from "@eden/llm";
import { flags, parseJson } from "./lab/flags";
import { Timeline } from "./lab/timeline";
import { DiskCardMaker } from "./lab/cards-disk";
import { mergeTallies, qualityReport, tallyQuality, type QualityOptions, type QualityTally } from "./quality";
import { readFileSync } from "node:fs";
import {
  IDEAL,
  REALISTIC,
  REALISTIC_ENTITIES,
  withOverrides,
  ZOO_HELDOUT_A,
  ZOO_HELDOUT_B,
  ZOO_TUNE,
  type ProfileSet,
  type SourceProfile,
} from "./sources";

// Strict (lab/flags.ts): an unknown flag exits 2 before any world is built; `--help` prints the header above.
const cli = flags(
  "quality-cli",
  {
    ...Object.fromEntries(
      [
        "users",
        "sessions",
        "seed",
        "profile",
        "planner-max-calls",
        "planner-cascade-min",
        "planner-deadline-margin",
        "planner-latency-quantile",
        "planner-mode",
        "planner-incumbent-mean",
        "planner-incumbent-strength",
        "promote-after",
        "time",
        "wait",
        "noise",
        "updates",
        "deletes",
        "push",
        "lost-notices",
        "refresh-after-hours",
        "tool-rate",
        "judge",
        "config",
        "timeline",
        "cards",
        "jobs",
        "user-range",
        "source-profile",
      ].map((k) => [k, "value" as const]),
    ),
    ...Object.fromEntries(
      [
        "planner",
        "planner-no-cascade",
        "planner-no-reuse",
        "live",
        "brief",
        "sync",
        "tally",
        "null-proves-nothing",
      ].map((k) => [k, "bool" as const]),
    ),
  },
  `
bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic|ideal|entities|
  zoo-tune|zoo-a|zoo-b] [--planner ...] [--time 0] [--wait 0] [--noise 1] [--updates 0] [--tool-rate 0.4]
  [--judge none|perfect|noisy] [--live] [--brief] [--config '{"probes":true}'] [--timeline F] [--sync]
  [--cards F] [--jobs N] [--user-range A:B] [--tally]
  [--source-profile JSON|FILE]
  (bun run sim; the header of quality-cli.ts has every flag)`,
);
if (cli.rest.length) {
  console.error(`quality-cli: unexpected arguments after --: ${cli.rest.join(" ")}; --help lists the flags`);
  process.exit(2);
}
const arg = cli.opt;
const has = (name: string) => cli.has(name);
/**
 * `--config`: engine settings, checked (checkEngineConfig) with the dependencies runQuality wires: cards with
 * `--cards`, never a bridge or a reader. A typo, a wrong type or a child flag whose parent is off exits 2.
 */
const engineConfig = ((): Record<string, unknown> => {
  if (!has("config")) return {};
  try {
    return checkEngineConfig(parseJson(arg("config", "{}"), "--config"), {
      where: "--config",
      deps: { cards: has("cards") },
      depNote: "which quality-cli.ts wires only for cards (with --cards)",
    }) as Record<string, unknown>;
  } catch (error) {
    console.error(`quality-cli: ${(error as Error).message}`);
    process.exit(2);
  }
})();
const PROFILES = {
  realistic: REALISTIC,
  ideal: IDEAL,
  entities: REALISTIC_ENTITIES,
  "zoo-tune": ZOO_TUNE,
  "zoo-a": ZOO_HELDOUT_A,
  "zoo-b": ZOO_HELDOUT_B,
};
const baseProfiles = PROFILES[arg("profile", "realistic") as keyof typeof PROFILES];
if (!baseProfiles) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(", ")}`);
const profiles = ((): ProfileSet => {
  if (!has("source-profile")) return baseProfiles;
  const text = arg("source-profile", "");
  try {
    const over = parseJson(text.trim().startsWith("{") ? text : readFileSync(text, "utf8"), "--source-profile");
    return withOverrides(baseProfiles, over as Record<string, Partial<SourceProfile>>);
  } catch (error) {
    console.error(`quality-cli: ${(error as Error).message}`);
    process.exit(2);
  }
})();
const live = has("live");
const model = live ? OpenRouterModel.fromEnv() : null;
if (live && !model) throw new Error("--live needs OPENROUTER_API_KEY");

const timelinePath = arg("timeline", "");
const timeline = timelinePath
  ? new Timeline(timelinePath, {
      tool: "quality-cli",
      profile: arg("profile", "realistic"),
      seed: Number(arg("seed", "1")),
      time: Number(arg("time", "0")),
      judge: arg("judge", "none"),
    })
  : null;
const t0 = performance.now();
const users = Number(arg("users", "6"));
const opts: QualityOptions = {
  ...(timeline ? { spanSink: (lane: string) => timeline.sink(lane) } : {}),
  users,
  sessionsPerUser: Number(arg("sessions", "15")),
  seed: Number(arg("seed", "1")),
  profiles,
  timeScale: Number(arg("time", "0")),
  waitMs: Number(arg("wait", "0")),
  noiseScale: Number(arg("noise", "1")),
  updates: Number(arg("updates", "0")),
  deletes: Number(arg("deletes", "0")),
  push: (() => {
    const m = arg("push", "none");
    if (m !== "none" && m !== "signals" && m !== "payload") {
      console.error("quality-cli: --push must be none, signals or payload");
      process.exit(2);
    }
    return m;
  })(),
  lostNotices: (() => {
    const v = Number(arg("lost-notices", "0"));
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      console.error("quality-cli: --lost-notices takes a share in [0, 1]");
      process.exit(2);
    }
    return v;
  })(),
  nullProvesNothing: has("null-proves-nothing"),
  config: {
    ...(has("refresh-after-hours") ? { refreshAfterMs: Number(arg("refresh-after-hours", "0")) * 3_600_000 } : {}),
    // Any engine setting, as JSON (`--config '{"probes":true}'`): for experiments behind a flag.
    ...engineConfig,
  },
  agentToolRate: Number(arg("tool-rate", "0.4")),
  model,
  judge: arg("judge", "none") as "none" | "perfect" | "noisy",
  promoteAfter: has("promote-after") ? Number(arg("promote-after", "0")) : undefined,
  // Lab only: every source item synced into Eden's cache before each session (docs/research/moon-graph.md).
  sync: has("sync"),
  // Implication cards replayed from a disk cache (`cards-enrich.ts`); `"cards": true` in --config uses them.
  ...(has("cards") ? { cardMaker: new DiskCardMaker(arg("cards", "")) } : {}),
  planner: has("planner")
    ? {
        maxCalls: Number(arg("planner-max-calls", "3")),
        cascade: !has("planner-no-cascade"),
        reuse: !has("planner-no-reuse"),
        ...(has("planner-latency-quantile") ? { latencyQuantile: Number(arg("planner-latency-quantile", "0.9")) } : {}),
        ...(has("planner-deadline-margin") ? { deadlineMargin: Number(arg("planner-deadline-margin", "2")) } : {}),
        ...(has("planner-cascade-min") ? { cascadeMin: Number(arg("planner-cascade-min", "0.05")) } : {}),
        mode: arg("planner-mode", "serve") as "serve" | "shadow",
        incumbent: {
          shape: "terms" as const,
          mean: Number(arg("planner-incumbent-mean", "0.75")),
          strength: Number(arg("planner-incumbent-strength", "8")),
        },
      }
    : undefined,
  ...(has("user-range") ? { userRange: userRange(arg("user-range", "")) } : {}),
};

/** `A:B`: users A to B-1 of `--users`. */
function userRange(text: string): [number, number] {
  const m = /^(\d+):(\d+)$/.exec(text);
  const r: [number, number] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  if (!m || r[0] >= r[1] || r[1] > users) {
    console.error(`quality-cli: --user-range must be A:B with 0 <= A < B <= --users (${users}), got "${text}"`);
    process.exit(2);
  }
  return r;
}

const jobs = has("jobs") ? Number(arg("jobs", "1")) : 1;
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error("quality-cli: --jobs must be a whole number of at least 1");
  process.exit(2);
}
if (jobs > 1) {
  for (const f of ["live", "timeline", "user-range", "tally"])
    if (has(f)) {
      console.error(`quality-cli: --jobs cannot run with --${f} (the header of quality-cli.ts says why)`);
      process.exit(2);
    }
}

/**
 * The tallies of `n` shard processes over contiguous user ranges, in user order (`mergeTallies` relies on it): each
 * runs this script with this run's flags but --jobs, plus its --user-range and --tally.
 */
async function shardTallies(n: number): Promise<QualityTally[]> {
  const shards = Math.min(n, users);
  const argv = process.argv.slice(2);
  const own: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--jobs")
      i++; // And its value.
    else own.push(argv[i]!);
  }
  const ranges = Array.from({ length: shards }, (_, k) => [
    Math.floor((k * users) / shards),
    Math.floor(((k + 1) * users) / shards),
  ]);
  return Promise.all(
    ranges.map(async ([a, b]) => {
      const p = Bun.spawn([process.execPath, import.meta.path, ...own, "--user-range", `${a}:${b}`, "--tally"], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      if (code !== 0) {
        console.error(`quality-cli: shard ${a}:${b} exited ${code}`);
        process.exit(1);
      }
      return JSON.parse(out) as QualityTally;
    }),
  );
}

const tally = jobs > 1 ? mergeTallies(await shardTallies(jobs)) : await tallyQuality(opts);
await timeline?.close();
if (has("tally")) {
  console.log(JSON.stringify(tally));
  process.exit(0);
}
const report = qualityReport(tally, opts);
const out = has("brief")
  ? {
      overall: report.overall,
      ask: report.ask,
      shadow: report.shadow,
      privacy: report.privacy,
      updates: report.updates,
      deletes: report.deletes,
      freshness: report.freshness,
      noiseShare: report.noiseShare,
      redundantShare: report.redundantShare,
    }
  : report;
console.log(
  JSON.stringify(
    {
      profile: arg("profile", "realistic"),
      planner: has("planner"),
      live,
      wallSeconds: Math.round((performance.now() - t0) / 100) / 10,
      ...out,
    },
    null,
    2,
  ),
);
