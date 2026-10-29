#!/usr/bin/env bun
/**
 * bun run eval [--live [--ask-model]] [--wait <ms>] [--no-planner] [scenario dir]
 *
 * Without --live no model is used, so the run is free and deterministic: it measures the no-model paths.
 * --live uses OPENROUTER_API_KEY and EDEN_MODEL and reports the real spend. Lookups go through the query planner, as
 * the server's do by default (D33); --no-planner measures without it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenRouterModel } from "@eden/llm";
import { runScenarios } from "./run";
import type { Scenario } from "./scenario";

const args = process.argv.slice(2);
const live = args.includes("--live");
const planner = !args.includes("--no-planner");
// Model-composed ask answers (D43) are off by default; --ask-model covers them, and their privacy checks, live.
const askWithModel = args.includes("--ask-model");
const waitAt = args.indexOf("--wait");
const waitMs = waitAt >= 0 ? Number(args[waitAt + 1]) : 2_000;
const dir =
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--wait") ?? join(import.meta.dir, "..", "scenarios");

const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);

const model = live ? OpenRouterModel.fromEnv() : null;
if (live && !model) {
  console.error("--live needs OPENROUTER_API_KEY");
  process.exit(1);
}
const metrics = await runScenarios(scenarios, { model, waitMs, planner, config: { askWithModel } });
console.log(JSON.stringify({ live, waitMs, planner, askWithModel, ...metrics }, null, 2));
