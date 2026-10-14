/**
 * The fact and cue arms (A5 §4, G1/G2; D7, D8, D10, D16, D21, D31): repo facts mined from files and overridden by
 * the user, citations that fail when their file changes, gotchas delivered at the error, superseded values kept out
 * of episodes, phrasings learnt from restatement, and continuations cued by the proposal they answer.
 *
 * Sleep (A4 §6) runs in detached processes on a timer. A script cannot wait for one, so where an arm needs sleep it
 * runs the entry point A4 names, `eden sleep --idle --after 0`, between sessions, with the simulated clock past the
 * idle threshold (the CLI gets `EDEN_NOW`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SimWorld } from "../harness/session";
import type { WorldSpec } from "../harness/world";
import { AUTH, DB, DEPLOY, ESM_FIX, id, monorepo, PKG, set, VITEST_ENV, webPackage } from "./fixtures/world";
import {
  bash,
  BLANK_SUMMARY,
  bulletsAt,
  bulletsIn,
  check,
  DAY_MS,
  Driver,
  judged,
  metricsOf,
  needCheck,
  needMet,
  quote,
  read,
  states,
  type Arm,
  type ArmRun,
  type Turn,
} from "./kit";

/** Idle long enough for heavy sleep (A4 §6: ≥ 30 min), then the sleep entry point. Returns its exit code. */
function sleep(run: ArmRun, world: SimWorld): number | null {
  world.advance(45 * 60_000);
  return run.cli(world, ["sleep", "--idle", "--after", "0"]).exitCode;
}

/**
 * A repo fact mined from its files (D8), cited, and overridden by the user. `cited` reads the bullets the second
 * session got from its start through its cue: since P3.4 a value that changed since the repo's last session comes as
 * an `Updated:` item at SessionStart (A4 §5.2), which then makes the cue's own bullet refractory (A4 §4).
 */
const repoFacts: Arm = {
  id: "repo-facts",
  flagged: true,
  async run(run) {
    const spec = monorepo({ initialTruth: [set(PKG, "", "npm")] });
    const world = run.world(spec);
    const install = { needs: [id(PKG, "")] };
    const sleeps = [sleep(run, world)];
    const first = await Driver.start(world, spec);
    const npm = await first.ask("install the dependencies", install);
    await first.end();
    world.changeRepo({ "package-lock.json": null, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }, [
      set(PKG, "", "pnpm"),
    ]);
    sleeps.push(sleep(run, world));
    const secondFrom = world.log.length;
    const second = await Driver.start(world, spec);
    const pnpm = await second.ask("install the dependencies", install);
    await second.say("Use bun as the package manager here.", [set(PKG, "", "bun")]);
    await second.end();
    sleeps.push(sleep(run, world));
    const from = world.log.length;
    const third = await Driver.start(world, spec);
    const bun = await third.ask("install the dependencies", install);
    await third.end();
    const cited = bulletsIn(judged(world, spec), secondFrom, pnpm.seq + 1).filter(
      (bullet) => states(bullet, PKG, "pnpm") && bullet.text.includes("pnpm-lock.yaml"),
    );
    const stale = bulletsIn(judged(world, spec), from).filter((bullet) => bullet.stale);
    return [
      needCheck("mined-npm", world, spec, npm, { note: `; sleep exit codes ${sleeps.join(",")}` }),
      needCheck("mined-pnpm", world, spec, pnpm),
      check("cited", cited.length > 0, `pnpm bullets naming pnpm-lock.yaml: ${quote(cited)}`),
      check(
        "user-overrides",
        needMet(metricsOf(world, spec), bun) && stale.length === 0,
        `after "use bun": ${quote(bulletsAt(world, spec, bun.seq))}; stale ${quote(stale)}`,
      ),
    ];
  },
};

/**
 * A cited fact (D8, D31): mined from apps/web/package.json, so its citation can fail. A user statement is not used:
 * D8 lets a user statement override a mined fact, and nothing in DECISIONS invalidates one when a file changes.
 */
const citation: Arm = {
  id: "citation",
  flagged: true,
  async run(run) {
    const spec = monorepo({
      projectFiles: { "apps/web/package.json": webPackage({ "@clerk/nextjs": "5.0.0" }) },
      initialTruth: [set(AUTH, "apps/web", "Clerk")],
    });
    const world = run.world(spec);
    const mined = sleep(run, world);
    const first = await Driver.start(world, spec);
    await first.turn("open apps/web/app/login.ts", { tools: [[read("apps/web/app/login.ts", "export {};\n")]] });
    const control = await first.ask("which auth provider does apps/web use?", {
      scope: "apps/web",
      needs: [id(AUTH, "apps/web")],
    });
    await first.end();
    world.changeRepo({ "apps/web/package.json": webPackage() }, [set(AUTH, "apps/web", null)]);
    const rechecked = sleep(run, world);
    const from = world.log.length;
    const second = await Driver.start(world, spec);
    await second.turn("open apps/web/app/login.ts", { tools: [[read("apps/web/app/login.ts", "export {};\n")]] });
    await second.ask("how does apps/web authenticate?", { scope: "apps/web", allowed: [id(AUTH, "apps/web")] });
    await second.end();
    const clerk = bulletsIn(judged(world, spec), from).filter((bullet) => states(bullet, AUTH, "Clerk"));
    return [
      needCheck("control-packs", world, spec, control, { note: `; sleep exit ${mined}` }),
      check(
        "skipped-after-removal",
        clerk.length === 0,
        `Clerk after @clerk/nextjs was removed: ${quote(clerk)}; sleep exit ${rechecked}`,
      ),
    ];
  },
};

const ESM_ERROR = "error: ERR_REQUIRE_ESM: require() of ES Module vitest/config from vitest.config.ts is not supported";

const gotcha: Arm = {
  id: "gotcha",
  flagged: true,
  async run(run) {
    const spec = monorepo({ projectFiles: { "vitest.config.ts": "export default {};\n" } });
    const world = run.world(spec);
    const first = await Driver.start(world, spec);
    await first.turn("run the tests", {
      tools: [
        [bash("bun test", 1, ESM_ERROR)],
        [{ tool: "Write", path: "vitest.config.mts", chars: 40 }],
        [bash("bun test", 0, "42 pass, 0 fail")],
      ],
      reply: "Renaming vitest.config.ts to vitest.config.mts fixed ERR_REQUIRE_ESM; the tests pass.",
    });
    await first.end();
    const slept = sleep(run, world);
    world.advance(7 * DAY_MS);
    const later = await Driver.start(world, spec);
    const from = world.log.length;
    await later.turn("run the tests", { tools: [[bash("bun test", 1, ESM_ERROR)]] });
    await later.end();
    const failure = world.log.find((record) => record.seq >= from && record.event === "PostToolUseFailure");
    const fix = failure
      ? bulletsAt(world, spec, failure.seq).filter((bullet) =>
          bullet.stated.some((s) => s.item.startsWith(`${ESM_FIX}@`)),
        )
      : [];
    return [
      check(
        "delivered-at-failure",
        fix.length > 0,
        `next to the same error a week later: ${quote(fix)}; sleep exit ${slept}`,
      ),
    ];
  },
};

const staleEpisode: Arm = {
  id: "stale-episode",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say(
      "packages/cli uses postgres for its database.",
      [set(DB, "packages/cli", "postgres")],
      "packages/cli",
    );
    const switched = await session.say(
      "packages/cli switched its database from postgres to sqlite.",
      [set(DB, "packages/cli", "sqlite")],
      "packages/cli",
    );
    await session.compact(BLANK_SUMMARY);
    await session.turn("open packages/cli/src/index.ts", {
      cue: { scope: "packages/cli" },
      tools: [[read("packages/cli/src/index.ts", "export function main() {}\n")]],
    });
    const cue = await session.ask("how do I set up the cli db?", {
      scope: "packages/cli",
      needs: [id(DB, "packages/cli")],
    });
    await session.end();
    const postgres = bulletsIn(judged(world, spec), switched.seq).filter((bullet) => states(bullet, DB, "postgres"));
    return [
      needCheck("sqlite-packs", world, spec, cue),
      check("no-postgres", postgres.length === 0, `postgres after the switch: ${quote(postgres)}`),
    ];
  },
};

/** R1's hard negatives (CueBench-code fixture), the first `n` by id: prompts that must stay silent. */
function hardNegatives(n: number): string[] {
  const path = join(import.meta.dir, "../../memory-cues/fixture/cues.json");
  const cues = JSON.parse(readFileSync(path, "utf8")) as { id: string; cat: string; cue: string }[];
  return cues
    .filter((cue) => cue.cat === "neg-hard")
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, n)
    .map((cue) => cue.cue);
}

/** Asks each prompt in a fresh session; returns the prompts that got a packet. */
async function silenceReplay(world: SimWorld, spec: WorldSpec, prompts: readonly string[]): Promise<string[]> {
  const fired: string[] = [];
  for (const prompt of prompts) {
    const session = await Driver.start(world, spec);
    const turn = await session.ask(prompt, {});
    await session.end();
    if (world.deliveries.some((delivery) => delivery.seq === turn.seq)) fired.push(prompt);
  }
  return fired;
}

const PHRASING_B = "how do I push this to production?";

const restateLearn: Arm = {
  id: "restate-learn",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const negatives = hardNegatives(10);
    const first = await Driver.start(world, spec);
    await first.say("Deploys go through the release pipeline named shipit.", [set(DEPLOY, "", "shipit")]);
    await first.end();
    const before = await silenceReplay(world, spec, negatives);
    const misses: Turn[] = [];
    for (let n = 0; n < 2; n++) {
      world.advance(DAY_MS);
      const session = await Driver.start(world, spec);
      misses.push(await session.ask(PHRASING_B, { needs: [id(DEPLOY, "")] }));
      await session.say("Remember, deploys go through shipit.", [set(DEPLOY, "", "shipit")]);
      await session.end();
    }
    const slept = sleep(run, world);
    const last = await Driver.start(world, spec);
    const learnt = await last.ask(PHRASING_B, { needs: [id(DEPLOY, "")] });
    await last.end();
    const after = await silenceReplay(world, spec, negatives);
    const metrics = metricsOf(world, spec);
    const missedTwice = misses.every((turn) => !needMet(metrics, turn));
    const newFires = after.filter((prompt) => !before.includes(prompt));
    const afterSleep = quote(bulletsAt(world, spec, learnt.seq));
    return [
      check(
        "b-packs-after-sleep",
        missedTwice && needMet(metrics, learnt),
        `missed twice before: ${missedTwice}; after sleep (exit ${slept}): ${afterSleep}`,
      ),
      check(
        "no-new-fire",
        newFires.length === 0,
        `silence replay: ${before.length} → ${after.length} fires; new: ${JSON.stringify(newFires)}`,
      ),
    ];
  },
};

const continuation: Arm = {
  id: "continuation",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("In vitest.config.ts we set the test environment to jsdom.", [set(VITEST_ENV, "", "jsdom")]);
    await session.compact(BLANK_SUMMARY);
    await session.turn("the web tests fail in CI", {
      reply: "Next I'll update vitest.config.ts so the web tests run in the right environment. Shall I go ahead?",
    });
    const cue = await session.ask("yes do it", { mode: "continuation", needs: [id(VITEST_ENV, "")] });
    await session.end();
    return [needCheck("packs", world, spec, cue)];
  },
};

export const FACT_ARMS: Arm[] = [repoFacts, citation, gotcha, staleEpisode, restateLearn, continuation];
