#!/usr/bin/env bun
/**
 * bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic|ideal|entities|
 *   zoo-tune|zoo-a|zoo-b] [--planner [--planner-max-calls 3] [--planner-no-cascade] [--planner-cascade-min 0.05]
 *   [--planner-no-reuse] [--planner-deadline-margin 2] [--planner-latency-quantile 0.9]
 *   [--planner-mode serve|shadow] [--promote-after N]] [--time 0] [--wait 0]
 *   [--noise 1] [--updates 0] [--refresh-after-hours H] [--max-refreshes 3] [--tool-rate 0.4]
 *   [--judge none|perfect|noisy] [--ask-model] [--live] [--brief] [--config '{"probes":true}']
 *   [--drafts clause|half [--typing-ms 1500]]
 *
 * Plays generated sessions over simulated sources and prints the quality report as JSON. Without --live no model is
 * used (free, deterministic at --time 0). --time 1 runs source latency and agent pacing in real time.
 */
import { OpenRouterModel } from "@eden/llm";
import { runQuality } from "./quality";
import { IDEAL, REALISTIC, REALISTIC_ENTITIES, ZOO_HELDOUT_A, ZOO_HELDOUT_B, ZOO_TUNE } from "./sources";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
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
const live = args.includes("--live");
const model = live ? OpenRouterModel.fromEnv() : null;
if (live && !model) throw new Error("--live needs OPENROUTER_API_KEY");

const t0 = performance.now();
const report = await runQuality({
  users: Number(arg("users", "6")),
  sessionsPerUser: Number(arg("sessions", "15")),
  seed: Number(arg("seed", "1")),
  profiles,
  timeScale: Number(arg("time", "0")),
  waitMs: Number(arg("wait", "0")),
  noiseScale: Number(arg("noise", "1")),
  updates: Number(arg("updates", "0")),
  config: {
    ...(args.includes("--refresh-after-hours")
      ? { refreshAfterMs: Number(arg("refresh-after-hours", "0")) * 3_600_000 }
      : {}),
    ...(args.includes("--max-refreshes") ? { maxRefreshes: Number(arg("max-refreshes", "3")) } : {}),
    ...(args.includes("--ask-model") ? { askWithModel: true } : {}),
    // Any engine setting, as JSON (`--config '{"probes":true}'`): for experiments behind a flag.
    ...(args.includes("--config") ? (JSON.parse(arg("config", "{}")) as Record<string, unknown>) : {}),
  },
  agentToolRate: Number(arg("tool-rate", "0.4")),
  ...(args.includes("--drafts")
    ? { drafts: arg("drafts", "clause") as "clause" | "half", typingMs: Number(arg("typing-ms", "1500")) }
    : {}),
  model,
  judge: arg("judge", "none") as "none" | "perfect" | "noisy",
  promoteAfter: args.includes("--promote-after") ? Number(arg("promote-after", "0")) : undefined,
  planner: args.includes("--planner")
    ? {
        maxCalls: Number(arg("planner-max-calls", "3")),
        cascade: !args.includes("--planner-no-cascade"),
        reuse: !args.includes("--planner-no-reuse"),
        ...(args.includes("--planner-latency-quantile")
          ? { latencyQuantile: Number(arg("planner-latency-quantile", "0.9")) }
          : {}),
        ...(args.includes("--planner-deadline-margin")
          ? { deadlineMargin: Number(arg("planner-deadline-margin", "2")) }
          : {}),
        ...(args.includes("--planner-cascade-min") ? { cascadeMin: Number(arg("planner-cascade-min", "0.05")) } : {}),
        mode: arg("planner-mode", "serve") as "serve" | "shadow",
        incumbent: {
          shape: "terms" as const,
          mean: Number(arg("planner-incumbent-mean", "0.75")),
          strength: Number(arg("planner-incumbent-strength", "8")),
        },
      }
    : undefined,
});
const out = args.includes("--brief")
  ? {
      overall: report.overall,
      ask: report.ask,
      shadow: report.shadow,
      privacy: report.privacy,
      updates: report.updates,
      noiseShare: report.noiseShare,
      redundantShare: report.redundantShare,
    }
  : report;
console.log(
  JSON.stringify(
    {
      profile: arg("profile", "realistic"),
      planner: args.includes("--planner"),
      live,
      wallSeconds: Math.round((performance.now() - t0) / 100) / 10,
      ...out,
    },
    null,
    2,
  ),
);
