#!/usr/bin/env bun
/**
 * bun run eval [--live [--ask-model]] [--wait <ms>] [--no-planner] [--config '{"probes":true}'] [--reader stub|oracle]
 *   [scenario dir]
 *
 * Without --live no model is used, so the run is free and deterministic: it measures the no-model paths.
 * --live uses OPENROUTER_API_KEY and EDEN_MODEL and reports the real spend. Lookups go through the query planner, as
 * the server's do by default (D33); --no-planner measures without it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineConfig } from "@eden/engine";
import { OpenRouterModel } from "@eden/llm";
import { parseReaderOption, type ReaderKindOption } from "./reader-stub";
import { proxyOf, runScenarios, unwiredFlags } from "./run";
import type { Scenario } from "./scenario";

const args = process.argv.slice(2);
const live = args.includes("--live");
const planner = !args.includes("--no-planner");
// Model-composed ask answers (D43) are off by default; --ask-model covers them, and their privacy checks, live.
const askWithModel = args.includes("--ask-model");
const waitAt = args.indexOf("--wait");
const waitMs = waitAt >= 0 ? Number(args[waitAt + 1]) : 2_000;
// Any engine setting, as JSON (`--config '{"probes":true}'`): for experiments behind a flag.
const configAt = args.indexOf("--config");
const extra = configAt >= 0 ? (JSON.parse(args[configAt + 1] ?? "{}") as Record<string, unknown>) : {};
// `--reader stub|oracle`: a no-model reader behind the real AskReader (reader-stub.ts), for configurations with
// askReader. The output gains `readerPool` (expected items in the reader's pool, per category); `oracle` adds an
// `oracleProxy` block from a second run whose reader reads the gold labels, while the headline metrics stay the stub's.
const readerAt = args.indexOf("--reader");
let reader: ReaderKindOption | undefined;
try {
  reader = readerAt >= 0 ? parseReaderOption(args[readerAt + 1]) : undefined;
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const dir =
  args.find((a, i) => !a.startsWith("--") && !["--wait", "--config", "--reader"].includes(args[i - 1] ?? "")) ??
  join(import.meta.dir, "..", "scenarios");

const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);

const model = live ? OpenRouterModel.fromEnv() : null;
if (live && !model) {
  console.error("--live needs OPENROUTER_API_KEY");
  process.exit(1);
}
const config = { askWithModel, ...extra } as Partial<EngineConfig>;
// A flag whose dependency the eval does not wire runs as if off: askReader without a reader is refused (its run would
// read as the preset's), the rest are labelled in the output and on stderr.
const unwired = unwiredFlags(config, { reader: reader !== undefined });
if (config.askReader && reader === undefined) {
  console.error(`this configuration has askReader: pass --reader stub (or oracle). Unwired: ${unwired.join("; ")}`);
  process.exit(2);
}
if (reader !== undefined && !config.askReader) {
  console.error("--reader needs a configuration with askReader (e.g. --config '{\"askReader\":true}')");
  process.exit(2);
}
for (const flag of unwired) console.error(`note: inert in the eval: ${flag}`);
const options = { model, waitMs, planner, config };
// With the oracle, the headline metrics come from the stub run; the oracle's run is reported only as a proxy.
const metrics = await runScenarios(scenarios, { ...options, ...(reader ? { reader: "stub" as const } : {}) });
const proxy = reader === "oracle" ? proxyOf(await runScenarios(scenarios, { ...options, reader: "oracle" })) : null;
console.log(
  JSON.stringify(
    {
      live,
      waitMs,
      planner,
      askWithModel,
      ...(reader ? { reader } : {}),
      ...(unwired.length ? { inert: unwired } : {}),
      ...metrics,
      ...(proxy ? { oracleProxy: proxy } : {}),
    },
    null,
    2,
  ),
);
