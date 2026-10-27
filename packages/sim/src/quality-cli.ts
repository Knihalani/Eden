#!/usr/bin/env bun
/**
 * bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic|ideal|entities]
 *   [--time 0] [--wait 0] [--noise 1] [--tool-rate 0.4] [--judge none|perfect|noisy] [--live] [--brief]
 *
 * Plays generated sessions over simulated sources and prints the quality report as JSON. Without --live no model is
 * used (free, deterministic at --time 0). --time 1 runs source latency and agent pacing in real time.
 */
import { OpenRouterModel } from "@eden/llm";
import { runQuality } from "./quality";
import { IDEAL, REALISTIC, REALISTIC_ENTITIES } from "./sources";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const profiles = { realistic: REALISTIC, ideal: IDEAL, entities: REALISTIC_ENTITIES }[arg("profile", "realistic")];
if (!profiles) throw new Error("--profile must be realistic, ideal or entities");
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
  agentToolRate: Number(arg("tool-rate", "0.4")),
  model,
  judge: arg("judge", "none") as "none" | "perfect" | "noisy",
});
const out = args.includes("--brief")
  ? {
      overall: report.overall,
      ask: report.ask,
      privacy: report.privacy,
      noiseShare: report.noiseShare,
      redundantShare: report.redundantShare,
    }
  : report;
console.log(
  JSON.stringify(
    {
      profile: arg("profile", "realistic"),
      live,
      wallSeconds: Math.round((performance.now() - t0) / 100) / 10,
      ...out,
    },
    null,
    2,
  ),
);
