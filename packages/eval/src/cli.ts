#!/usr/bin/env bun
/**
 * bun run eval [--live --usd-cap <usd> [--judge]] [--wait <ms>] [--no-planner] [--config '{"probes":true}']
 *   [--reader stub|oracle] [scenario dir]
 *
 * Without --live no model is used, so the run is free and deterministic: it measures the no-model paths.
 * --live (D128) wires what the servers wire with OPENROUTER_API_KEY set: no judge, and the reader on the servers' role
 * model (server/src/models.ts: EDEN_MODEL, default Haiku 5.5 through OpenRouter). It needs --usd-cap, a hard cap on
 * the run's model spend, and reports the real spend. --live --judge is the shape --live had before D128 (a judge from
 * OpenRouterModel.fromEnv, no live reader; --reader stub|oracle as before), kept so earlier numbers can be re-run.
 * Lookups go through the query planner, as the server's do by default (D33); --no-planner measures without it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type EngineConfig } from "@eden/engine";
// The server's own log line for a failing reader (one line, key removed, redacted).
import { readerFailureLog } from "@eden/server";
import { parseReaderOption, type ReaderKindOption } from "./reader-stub";
import { EVAL_TENANT, liveWiring, proxyOf, runScenarios, unwiredFlags } from "./run";
import type { Scenario } from "./scenario";

const args = process.argv.slice(2);
const live = args.includes("--live");
const judge = args.includes("--judge");
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
// A paid run is metered with a hard cap or not run (D128). Checked before anything else, so a run without one makes
// no call at all.
const capAt = args.indexOf("--usd-cap");
const usdCap = capAt >= 0 ? Number(args[capAt + 1]) : undefined;
if (judge && !live) fail("--judge is a --live shape: pass --live --judge --usd-cap <usd>");
if (capAt >= 0 && !live) fail("--usd-cap caps a --live run's spend: pass it with --live");
if (live && usdCap === undefined) {
  fail("--live makes paid model calls: pass --usd-cap <usd>, a hard cap on this run's spend (e.g. --usd-cap 0.05)");
}
if (usdCap !== undefined && !(usdCap > 0 && Number.isFinite(usdCap))) {
  fail(`--usd-cap ${args[capAt + 1] ?? ""}: expected a positive number of USD`);
}
const planner = !args.includes("--no-planner");
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
  fail((e as Error).message);
}
// The shipped shape wires the live reader itself: a stub beside it would measure something else.
const shipped = live && !judge;
if (shipped && reader !== undefined) fail("--live wires the shipped reader: --reader stub|oracle goes without --live");
const valued = ["--wait", "--config", "--reader", "--usd-cap"];
const dir =
  args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? "")) ??
  join(import.meta.dir, "..", "scenarios");

const load = (from: string) =>
  readdirSync(from)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(from, f), "utf8")) as Scenario);
const scenarios = load(dir);
// The acting suite (D810): requests that act, neutral or owing a fact beside a look-alike. Run on its own, so the
// three headline numbers stay those of the scenarios above, comparable with every earlier run; its block is `acting`.
const actingDir = join(dir, "acting");
const actingScenarios = existsSync(actingDir) ? load(actingDir) : [];

const wiring = live ? liveWiring({ judge, usdCap: usdCap! }) : null;
if (live && !wiring) fail("--live needs OPENROUTER_API_KEY", 1);
// The first failed reader call, as the server logs it: a reader refused on every call (an OpenRouter 403) would
// otherwise read as a reader that found nothing.
let readerFailure: string | undefined;
const onReaderFailure = readerFailureLog((line) => {
  readerFailure = line;
  console.error(line);
}, wiring?.scrub);
const config = { ...extra } as Partial<EngineConfig>;
// What runs: the override over the default (D112), whose cards, intent and reader are on. With no model and no
// dependency they are inert by design, the default's no-model path, which is what `bun run eval` measures; they are
// labelled in the output and on stderr. An override that names askReader itself without a reader is refused (its run
// would read as the reader's).
const run = { ...DEFAULT_CONFIG, ...config };
const unwired = unwiredFlags(run, { reader: reader !== undefined || shipped, checker: shipped });
if (config.askReader && reader === undefined && !shipped) {
  console.error(`this configuration has askReader: pass --reader stub (or oracle). Unwired: ${unwired.join("; ")}`);
  process.exit(2);
}
if (reader !== undefined && !run.askReader) {
  console.error("--reader needs a configuration with askReader (e.g. --config '{\"askReader\":true}')");
  process.exit(2);
}
for (const flag of unwired) console.error(`note: inert in the eval: ${flag}`);
const options = {
  model: wiring?.model ?? null,
  waitMs,
  planner,
  config,
  ...(wiring ? { spend: wiring.spend } : {}),
  ...(wiring?.readerModel ? { readerModel: wiring.readerModel, onReaderFailure } : {}),
};
// With the oracle, the headline metrics come from the stub run; the oracle's run is reported only as a proxy.
const metrics = await runScenarios(scenarios, { ...options, ...(reader ? { reader: "stub" as const } : {}) });
const proxy = reader === "oracle" ? proxyOf(await runScenarios(scenarios, { ...options, reader: "oracle" })) : null;
// Not under --live: its reader calls would share the run's cap and spend with the headline run, and `spentUsd` would
// no longer compare with earlier live runs. The acting block measures the no-model push.
const actingRun =
  actingScenarios.length && !live
    ? await runScenarios(actingScenarios, { ...options, ...(reader ? { reader: "stub" as const } : {}) })
    : null;
console.log(
  JSON.stringify(
    {
      live,
      ...(wiring
        ? {
            wiring: judge ? "judge (pre-D128: judge on, no live reader)" : "shipped (D128: no judge, the role reader)",
            ...(wiring.model ? { judgeModel: wiring.model.id } : {}),
            ...(wiring.readerModel ? { readerModel: wiring.readerModel.id } : {}),
            usdCap,
            spentUsd: wiring.spend.spent(EVAL_TENANT),
            ...(readerFailure ? { readerFailure } : {}),
          }
        : {}),
      waitMs,
      planner,
      ...(reader ? { reader } : {}),
      ...(unwired.length ? { inert: unwired } : {}),
      ...metrics,
      ...(proxy ? { oracleProxy: proxy } : {}),
      ...(actingRun
        ? { acting: { scenarios: actingRun.scenarios, ...actingRun.acting, decisions: actingRun.decisions } }
        : actingScenarios.length
          ? { acting: "not run under --live (its reader calls would share the cap; run it without --live)" }
          : {}),
    },
    null,
    2,
  ),
);
