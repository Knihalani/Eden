#!/usr/bin/env bun
/**
 * bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic|ideal|entities|
 *   zoo-tune|zoo-a|zoo-b] [--planner [--planner-max-calls 3] [--planner-no-cascade] [--planner-cascade-min 0.05]
 *   [--planner-no-reuse] [--planner-deadline-margin 2] [--planner-latency-quantile 0.9]
 *   [--planner-mode serve|shadow] [--promote-after N]] [--time 0] [--wait 0]
 *   [--noise 1] [--updates 0] [--deletes 0] [--push none|signals|payload] [--refresh-after-hours H] [--tool-rate 0.4]
 *   [--judge none|perfect|noisy] [--live] [--brief] [--config '{"probes":true}']
 *   [--timeline out.jsonl] [--sync]
 *   [--cards DIR/cards-v2.jsonl]
 *   [--drafts clause|half [--typing-ms 1500]]
 *
 * Plays generated sessions over simulated sources and prints the quality report as JSON. Without --live no model is
 * used (free, deterministic at --time 0). --time 1 runs source latency and agent pacing in real time.
 * --timeline records every engine span, per user, with CPU% and RSS each second (`lab/timeline.ts`); read it with
 * `lab/timeline-report.ts`.
 */
import { checkEngineConfig } from "@eden/engine";
import { OpenRouterModel } from "@eden/llm";
import { flags, parseJson } from "./lab/flags";
import { Timeline } from "./lab/timeline";
import { DiskCardMaker } from "./lab/cards-disk";
import { runQuality } from "./quality";
import { IDEAL, REALISTIC, REALISTIC_ENTITIES, ZOO_HELDOUT_A, ZOO_HELDOUT_B, ZOO_TUNE } from "./sources";

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
        "refresh-after-hours",
        "tool-rate",
        "judge",
        "config",
        "timeline",
        "cards",
        "drafts",
        "typing-ms",
      ].map((k) => [k, "value" as const]),
    ),
    ...Object.fromEntries(
      ["planner", "planner-no-cascade", "planner-no-reuse", "live", "brief", "sync"].map((k) => [k, "bool" as const]),
    ),
  },
  `
bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic|ideal|entities|
  zoo-tune|zoo-a|zoo-b] [--planner ...] [--time 0] [--wait 0] [--noise 1] [--updates 0] [--tool-rate 0.4]
  [--judge none|perfect|noisy] [--live] [--brief] [--config '{"probes":true}'] [--timeline F] [--sync]
  [--cards F] [--drafts clause|half [--typing-ms 1500]]   (bun run sim; the header of quality-cli.ts has every flag)`,
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
const profiles = PROFILES[arg("profile", "realistic") as keyof typeof PROFILES];
if (!profiles) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(", ")}`);
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
const report = await runQuality({
  ...(timeline ? { spanSink: (lane: string) => timeline.sink(lane) } : {}),
  users: Number(arg("users", "6")),
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
  config: {
    ...(has("refresh-after-hours") ? { refreshAfterMs: Number(arg("refresh-after-hours", "0")) * 3_600_000 } : {}),
    // Any engine setting, as JSON (`--config '{"probes":true}'`): for experiments behind a flag.
    ...engineConfig,
  },
  agentToolRate: Number(arg("tool-rate", "0.4")),
  ...(has("drafts")
    ? { drafts: arg("drafts", "clause") as "clause" | "half", typingMs: Number(arg("typing-ms", "1500")) }
    : {}),
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
});
await timeline?.close();
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
