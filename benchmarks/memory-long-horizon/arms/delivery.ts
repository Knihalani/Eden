/**
 * The delivery arms (A5 §4, G5; D23–D28, A4 §4–5): packets only on human turns, never twice while the item is
 * still in the window, back after a compaction drops it or a rewind abandons it, by task scope in subagents,
 * on the first touch of a folder, never for what the user just said or the instruction files already state, and
 * within the epoch budget.
 */
import { readFileSync } from "node:fs";
import type { AgentRun } from "../harness/session";
import { filler } from "../harness/shape";
import { bulletContent } from "../harness/statements";
import {
  AUTH,
  CACHE,
  DB,
  id,
  IN_FORCE,
  monorepo,
  NO_MERGE,
  NODE,
  PKG,
  rule,
  set,
  TEST,
  VITEST_ENV,
} from "./fixtures/world";
import {
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
  transcriptBytes,
  wideEvents,
  type Arm,
  type Turn,
} from "./kit";

/** The start of each delivered packet, for a check's detail. */
function shown(deliveries: readonly { content: string }[]): string {
  return deliveries.map((delivery) => JSON.stringify(delivery.content.slice(0, 100))).join("; ") || "none";
}

const nonhuman: Arm = {
  id: "nonhuman",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("Our auth provider is Clerk.", [set(AUTH, "", "Clerk")]);
    const runs: AgentRun[] = [];
    await session.turn("run the background checks on the auth flow and the database", {
      within: async (driver) => {
        for (let n = 0; n < 20; n++) {
          const task = n % 2 ? "audit the database migrations" : "check the Clerk auth flow in apps/web";
          const report = n % 2 ? "The postgres migrations are fine." : "The Clerk auth flow works.";
          const launched = await driver.subagent({ agentType: "general-purpose", task, background: true, report });
          if (launched.run) runs.push(launched.run);
        }
      },
    });
    for (const launched of runs) await session.notify(launched);
    // The control's fact is said after the notifications, so it does not ride on a row surviving their ~60 writers.
    await session.say("The database is postgres.", [set(DB, "", "postgres")]);
    await session.compact(BLANK_SUMMARY);
    const control = await session.ask("what database do we use?", { needs: [id(DB, "")] });
    await session.end();
    const silence = metricsOf(world, spec).silence.nonhuman;
    return [
      check(
        "silent-on-nonhuman",
        silence.k === 0 && silence.n > 0,
        `packets on ${silence.k} of ${silence.n} non-human submits`,
      ),
      needCheck("control-packs", world, spec, control),
    ];
  },
};

const repeat: Arm = {
  id: "repeat",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const first = await Driver.start(world, spec);
    await first.say("Our auth provider is Auth0.", [set(AUTH, "", "Auth0")]);
    await first.end();
    world.advance(DAY_MS);
    const second = await Driver.start(world, spec);
    const cue = { needs: [id(AUTH, "")] };
    const turns = [];
    for (let n = 0; n < 3; n++) turns.push(await second.ask("which auth provider do we use?", cue));
    await second.end();
    const other = await Driver.start(world, spec);
    await other.say("We switched auth from Auth0 to Clerk.", [set(AUTH, "", "Clerk")]);
    await other.end();
    await second.resume();
    const update = await second.ask("which auth provider do we use?", cue);
    await second.end();
    const repeated = turns.slice(1).flatMap((turn) => world.deliveries.filter((delivery) => delivery.seq === turn.seq));
    const updated = bulletsAt(world, spec, update.seq).filter(
      (bullet) => states(bullet, AUTH, "Clerk") && /^updated:/i.test(bulletContent(bullet.text)),
    );
    return [
      needCheck("first-packs", world, spec, turns[0]!),
      check("empty-2-3", repeated.length === 0, `packets on turns 2 and 3: ${shown(repeated)}`),
      check("updated", updated.length > 0, `after the switch: ${quote(bulletsAt(world, spec, update.seq))}`),
    ];
  },
};

const compaction: Arm = {
  id: "compaction",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("The database is postgres.", [set(DB, "", "postgres")]);
    await session.say("Don't merge PRs yourself.", [rule(NO_MERGE, true)]);
    await session.compact(BLANK_SUMMARY);
    const factCue = { needs: [id(DB, "")] };
    const ruleCue = { needs: [id(NO_MERGE, "")] };
    const a1 = await session.ask("what database do we use?", factCue);
    const b1 = await session.ask("merge the PRs once CI passes", ruleCue);
    await session.compact("The database is postgres. The user asked about CI timing.");
    const a2 = await session.ask("what database do we use?", factCue);
    const b2 = await session.ask("merge the PRs once CI passes", ruleCue);
    await session.end();
    const fact = (turn: Turn) => bulletsAt(world, spec, turn.seq).filter((bullet) => states(bullet, DB, "postgres"));
    const ruled = (turn: Turn) =>
      bulletsAt(world, spec, turn.seq).filter((bullet) => states(bullet, NO_MERGE, "in force"));
    return [
      check(
        "delivered-before",
        fact(a1).length > 0 && ruled(b1).length > 0,
        `before: fact ${quote(fact(a1))}; rule ${quote(ruled(b1))}`,
      ),
      check("a-not-rearmed", fact(a2).length === 0, `fact A after the summary kept it: ${quote(fact(a2))}`),
      check("b-rearmed", ruled(b2).length > 0, `rule B after the summary dropped it: ${quote(ruled(b2))}`),
    ];
  },
};

const resume: Arm = {
  id: "resume",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("The database is postgres.", [set(DB, "", "postgres")]);
    await session.compact(BLANK_SUMMARY);
    const before = await session.ask("what database do we use?", { needs: [id(DB, "")] });
    await session.end();
    const resumed = world.log.length;
    await session.resume();
    await session.ask("what database do we use, again?", { needs: [id(DB, "")] });
    await session.end();
    const delivered = bulletsAt(world, spec, before.seq).filter((bullet) => states(bullet, DB, "postgres"));
    const again = bulletsIn(judged(world, spec), resumed).filter((bullet) => states(bullet, DB, "postgres"));
    return [
      check("delivered-before", delivered.length > 0, `before the resume: ${quote(delivered)}`),
      check("no-reinjection", again.length === 0, `after the resume: ${quote(again)}`),
    ];
  },
};

const subagent: Arm = {
  id: "subagent",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const facts = await Driver.start(world, spec);
    await facts.say("In apps/web the auth provider is Clerk.", [set(AUTH, "apps/web", "Clerk")], "apps/web");
    await facts.say("packages/cli has no auth.", [set(AUTH, "packages/cli", "none")], "packages/cli");
    await facts.say("Don't merge PRs yourself.", [rule(NO_MERGE, true)]);
    await facts.end();
    world.advance(DAY_MS);
    const parent = await Driver.start(world, spec);
    await parent.turn("open packages/cli/src/index.ts", {
      cue: { scope: "packages/cli" },
      tools: [[read("packages/cli/src/index.ts", "export function main() {}\n")]],
    });
    const web = { scope: "apps/web", needs: [id(AUTH, "apps/web")] };
    const cli = { scope: "packages/cli", needs: [id(AUTH, "packages/cli")] };
    let task: Turn | undefined;
    const explores: { turn: Turn; run: AgentRun | null }[] = [];
    let fork: Turn | undefined;
    await parent.turn("review the login code", {
      cue: { scope: "packages/cli" },
      within: async (driver) => {
        task = await driver.subagent(
          { agentType: "general-purpose", task: "fix the redirect in apps/web/app/login.ts", cue: web },
          [[read("apps/web/app/login.ts", "export function login() {}\n")]],
        );
      },
    });
    const own = await parent.ask("how does this package authenticate?", cli);
    await parent.turn("look at both login flows in parallel", {
      cue: { scope: "packages/cli" },
      within: async (driver) => {
        for (const [path, cue] of [
          ["apps/web/app/login.ts", web],
          ["packages/cli/src/index.ts", cli],
        ] as const) {
          const launched = await driver.subagent({
            agentType: "Explore",
            task: `look at ${path}`,
            background: true,
            cue,
          });
          explores.push({ turn: launched, run: launched.run });
        }
        fork = await driver.subagent({ agentType: "fork", task: "carry on with the cli review in a fork" });
      },
    });
    for (const explore of explores) if (explore.run) await parent.notify(explore.run);
    // The gate's policy part (ROADMAP P2.5, A4 §5.3): policies whose classes fit the agent type or the task.
    const policy = { needs: [id(NO_MERGE, "")] };
    let reviewer: Turn | undefined;
    let merger: Turn | undefined;
    await parent.turn("have someone look over the cli diff", {
      cue: { scope: "packages/cli" },
      within: async (driver) => {
        reviewer = await driver.subagent({
          agentType: "code-reviewer",
          task: "look over the diff in packages/cli/src/index.ts",
          cue: policy,
        });
        merger = await driver.subagent({
          agentType: "general-purpose",
          task: "merge the dependabot PR once CI is green",
          cue: policy,
        });
      },
    });
    await parent.end();
    const states_ = (turn: Turn | undefined, scope: string, value: string) =>
      turn !== undefined && bulletsAt(world, spec, turn.seq).some((bullet) => states(bullet, AUTH, value, scope));
    const own_ =
      explores.length === 2 &&
      states_(explores[0]!.turn, "apps/web", "Clerk") &&
      states_(explores[1]!.turn, "packages/cli", "none");
    const fallback =
      explores.length === 2 && explores.every((explore) => states_(explore.turn, "packages/cli", "none"));
    const forkBullets = fork ? bulletsAt(world, spec, fork.seq) : [];
    const repeated = forkBullets.filter((bullet) => bullet.redundant);
    const ownStale = bulletsAt(world, spec, own.seq).filter((bullet) => bullet.stale);
    const packetOf = (turn: Turn | undefined) => (turn ? bulletsAt(world, spec, turn.seq) : []);
    const noMerge = (turn: Turn | undefined) => packetOf(turn).some((bullet) => states(bullet, NO_MERGE, IN_FORCE, ""));
    const classless = [task, ...explores.map((explore) => explore.turn)];
    return [
      check(
        "subagent-packet",
        states_(task, "apps/web", "Clerk"),
        `the task subagent's packet: ${quote(task ? bulletsAt(world, spec, task.seq) : [])}`,
      ),
      check(
        "parent-scope",
        needMet(metricsOf(world, spec), own) && ownStale.length === 0,
        `the parent's cue: need ${needMet(metricsOf(world, spec), own) ? "met" : "missed"}; stale ${quote(ownStale)}`,
      ),
      check(
        "parallel-scopes",
        own_ || fallback,
        explores.map((explore) => quote(bulletsAt(world, spec, explore.turn.seq))).join(" | "),
      ),
      check("fork-no-repeat", repeated.length === 0, `the fork's packet repeats the parent's: ${quote(repeated)}`),
      check("policy-by-type", noMerge(reviewer), `the code-reviewer's packet: ${quote(packetOf(reviewer))}`),
      check("policy-by-task", noMerge(merger), `the merge task's packet: ${quote(packetOf(merger))}`),
      check(
        "policy-by-class-only",
        classless.every((turn) => !noMerge(turn)),
        `packets of subagents whose type and task name no class: ${classless.map((t) => quote(packetOf(t))).join(" | ")}`,
      ),
    ];
  },
};

const firstTouch: Arm = {
  id: "first-touch",
  flagged: true,
  async run(run) {
    const spec = monorepo({ projectFiles: { "packages/cli/src/main.ts": "export const main = 1;\n" } });
    const world = run.world(spec);
    const facts = await Driver.start(world, spec);
    await facts.say(
      "packages/cli has no auth, and its database is sqlite.",
      [set(AUTH, "packages/cli", "none"), set(DB, "packages/cli", "sqlite")],
      "packages/cli",
    );
    await facts.end();
    world.advance(DAY_MS);
    const session = await Driver.start(world, spec);
    const from = world.log.length;
    await session.turn("look around the repo", {
      tools: [
        [read("packages/cli/src/index.ts", "export function main() {}\n")],
        [read("packages/cli/src/main.ts", "export const main = 1;\n")],
      ],
    });
    await session.end();
    const batches = world.log.filter((record) => record.seq >= from && record.event === "PostToolBatch");
    const cliFacts = (seq: number | undefined) =>
      seq === undefined
        ? []
        : bulletsAt(world, spec, seq).filter(
            (bullet) => states(bullet, AUTH, "none", "packages/cli") || states(bullet, DB, "sqlite", "packages/cli"),
          );
    const first = cliFacts(batches[0]?.seq);
    const second = cliFacts(batches[1]?.seq);
    const both = first.some((b) => states(b, AUTH, "none")) && first.some((b) => states(b, DB, "sqlite"));
    return [
      check(
        "first-touch-delivers",
        both,
        `the first batch in packages/cli: ${quote(bulletsAt(world, spec, batches[0]?.seq ?? -1))}`,
      ),
      check("once", second.length === 0, `the second batch: ${quote(second)}`),
    ];
  },
};

const residual: Arm = {
  id: "residual",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("Our auth provider is Clerk.", [set(AUTH, "", "Clerk")]);
    await session.compact(BLANK_SUMMARY);
    const said = await session.say("auth is Clerk, fix login", [set(AUTH, "", "Clerk")]);
    await session.compact(BLANK_SUMMARY);
    const login = 'import { auth } from "@clerk/nextjs";\nexport function login() {}\n';
    await session.turn("open apps/web/app/login.ts", { tools: [[read("apps/web/app/login.ts", login)]] });
    const after = await session.ask("fix the auth redirect", { needs: [id(AUTH, "")] });
    await session.end();
    const clerk = (turn: Turn) => bulletsAt(world, spec, turn.seq).filter((bullet) => states(bullet, AUTH, "Clerk"));
    return [
      check("no-residual-bullet", clerk(said).length === 0, `Clerk on the prompt that said it: ${quote(clerk(said))}`),
      check(
        "tool-output-no-suppress",
        clerk(after).length > 0,
        `Clerk after a Read that mentions it: ${quote(bulletsAt(world, spec, after.seq))}`,
      ),
    ];
  },
};

const shadow: Arm = {
  id: "shadow",
  flagged: true,
  async run(run) {
    const claude = "# Project\n\nA TypeScript monorepo. Use pnpm, not npm, for every install.\n";
    // A nested file, loaded lazily (InstructionsLoaded `nested_traversal`) by the first Read under apps/web.
    const web = "# Web\n\nThe test runner is vitest.\n";
    const spec = monorepo({ projectFiles: { "CLAUDE.md": claude, "apps/web/CLAUDE.md": web } });
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("The package manager is pnpm.", [set(PKG, "", "pnpm")]);
    await session.say("The database is postgres.", [set(DB, "", "postgres")]);
    await session.say("The test runner is vitest.", [set(TEST, "", "vitest")]);
    await session.compact(BLANK_SUMMARY);
    await session.ask("install the dependencies", { needs: [id(PKG, "")] });
    const control = await session.ask("what database do we use?", { needs: [id(DB, "")] });
    const login = read("apps/web/app/login.ts", "export function login() {}\n");
    await session.turn("open apps/web/app/login.ts", { tools: [[login]] });
    const nested = await session.ask("which test runner do we use?", { needs: [id(TEST, "")] });
    await session.end();
    const pnpm = judged(world, spec)
      .flatMap((packet) => packet.bullets)
      .filter((bullet) => states(bullet, PKG, "pnpm"));
    const vitest = bulletsAt(world, spec, nested.seq).filter((bullet) => states(bullet, TEST, "vitest"));
    return [
      check("never-injected", pnpm.length === 0, `pnpm bullets: ${quote(pnpm)}`),
      needCheck("control-packs", world, spec, control),
      check("nested-never-injected", vitest.length === 0, `vitest bullets once apps/web loaded: ${quote(vitest)}`),
    ];
  },
};

const continueArm: Arm = {
  id: "continue",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("In vitest.config.ts we set the test environment to jsdom.", [set(VITEST_ENV, "", "jsdom")]);
    await session.compact(BLANK_SUMMARY);
    const control = await session.ask("which test environment does vitest.config use?", {
      needs: [id(VITEST_ENV, "")],
    });
    await session.turn("check the test setup", {
      reply: "I checked the test setup: all 42 tests pass and nothing needs changing.",
    });
    const ack = await session.ask("continue", { mode: "ack" });
    await session.turn("the web tests are flaky", {
      reply: "Next I'll update vitest.config.ts so the web tests run in jsdom. Shall I go ahead?",
    });
    const proposal = await session.ask("continue", { mode: "continuation", allowed: [id(VITEST_ENV, "")] });
    await session.end();
    const metrics = metricsOf(world, spec);
    const acked = world.deliveries.filter((delivery) => delivery.seq === ack.seq);
    const strayed = metrics.cues[proposal.cue]?.false ?? 0;
    return [
      needCheck("control-packs", world, spec, control),
      check("ack-silent", acked.length === 0, `packets on "continue" after a report: ${shown(acked)}`),
      check(
        "continuation-strong-only",
        strayed === 0,
        `bullets outside the proposal's item on "continue" after it: ${strayed}`,
      ),
    ];
  },
};

/** The facts the budget soak cues, and prompts that touch them. */
const SOAK_FACTS: [string, ReturnType<typeof set>][] = [
  ["Our auth provider is Clerk.", set(AUTH, "", "Clerk")],
  ["The database is postgres.", set(DB, "", "postgres")],
  ["We use Redis for caching.", set(CACHE, "", "Redis")],
  ["We use node 20 across the repo.", set(NODE, "", "20")],
  ["The test runner is vitest.", set(TEST, "", "vitest")],
];
const SOAK_PROMPTS = [
  "fix the auth check in apps/web/app/login.ts",
  "speed up the database query in packages/cli/src/index.ts",
  "the cache misses too often, look at packages/cli/src/index.ts",
  "bump the node version in the CI config",
  "make the vitest run faster in apps/web",
];

const budget: Arm = {
  id: "budget",
  flagged: true,
  async run(run) {
    const turns = run.options.scale === "full" ? 300 : 100;
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    for (const [text, effect] of SOAK_FACTS) await session.say(text, [effect]);
    for (let n = SOAK_FACTS.length; n < turns; n++) {
      const text = SOAK_PROMPTS[n % SOAK_PROMPTS.length]!;
      await session.turn(text, { cue: { allowed: SOAK_FACTS.map(([, effect]) => id(effect.key, "")) } });
    }
    await session.end();
    const epochs = metricsOf(world, spec).tokens_per_epoch;
    return [
      check("delivers", world.deliveries.length > 0, `${world.deliveries.length} packets over ${turns} human turns`),
      check(
        "tokens-per-epoch",
        epochs.max <= 6_000,
        `max ${epochs.max} tokens in an epoch (p99 ${epochs.p99}; ${epochs.epochs} epochs)`,
      ),
    ];
  },
};

/** Distances on the main transcript (A4 §4): below 400 KB and above it, read as 400,000 or 409,600 bytes. */
const REFRACTORY = { lo: 390_000, hi: 399_900 };
const ELIGIBLE = { lo: 409_700, hi: 425_000 };

/** Grows the transcript with log Reads until it is `lo`–`hi` bytes past `base`; returns the distance reached. */
async function growTo(session: Driver, base: number, window: { lo: number; hi: number }): Promise<number> {
  for (let step = 0; ; step++) {
    const gap = window.lo - (transcriptBytes(session.session) - base);
    if (gap <= 0) break;
    const chars = Math.max(60, Math.floor((gap - 4_000) / 2.4));
    await session.turn("summarize the build log", {
      tools: [[read(`logs/build-${step}.log`, filler(`log:${step}`, chars))]],
      reply: "The build log shows nothing unusual.",
    });
  }
  return transcriptBytes(session.session) - base;
}

/** The context size the latest `message.usage` of the session's transcript reports. */
function latestUsageTokens(session: Driver): number | undefined {
  const lines = readFileSync(session.session.transcriptPath, "utf8").trim().split("\n").reverse();
  for (const line of lines) {
    const usage = (JSON.parse(line) as { message?: { usage?: Record<string, number> } }).message?.usage;
    if (usage)
      return (
        (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
      );
  }
  return undefined;
}

const reEligibility: Arm = {
  id: "re-eligibility",
  flagged: true,
  async run(run) {
    const spec = monorepo();
    const world = run.world(spec);
    const session = await Driver.start(world, spec);
    await session.say("Never merge PRs yourself.", [rule(NO_MERGE, true)]);
    await session.compact(BLANK_SUMMARY);
    const cue = { needs: [id(NO_MERGE, "")] };
    const base = transcriptBytes(session.session);
    const first = await session.ask("merge the PRs when CI is green", cue);
    const near = await growTo(session, base, REFRACTORY);
    const refractory = await session.ask("can you merge the PRs now?", cue);
    const far = await growTo(session, base, ELIGIBLE);
    const noCue = await session.turn("format the code");
    const tokens = latestUsageTokens(session);
    const fresh = await session.ask("merge the PRs once CI passes", cue);
    await session.end();
    const pin = (turn: Turn) =>
      bulletsAt(world, spec, turn.seq).filter((bullet) => states(bullet, NO_MERGE, "in force"));
    const placed = near <= REFRACTORY.hi && far <= ELIGIBLE.hi;
    const logged = tokens !== undefined && new RegExp(`\\b${tokens}\\b`).test(wideEvents(world));
    return [
      check("delivered-at-0", pin(first).length > 0, `the pin at offset 0: ${quote(pin(first))}`),
      check("refractory-399", placed && pin(refractory).length === 0, `at ${near} bytes: ${quote(pin(refractory))}`),
      check("no-cue-no-pin", pin(noCue).length === 0, `with no cue at ${far} bytes: ${quote(pin(noCue))}`),
      check("reeligible-401", placed && pin(fresh).length > 0, `a fresh cue at ${far}+ bytes: ${quote(pin(fresh))}`),
      check("usage-logged", logged, `context tokens ${tokens ?? "?"} ${logged ? "are" : "are not"} in a wide event`),
    ];
  },
};

export const DELIVERY_ARMS: Arm[] = [
  nonhuman,
  repeat,
  compaction,
  resume,
  subagent,
  firstTouch,
  residual,
  shadow,
  continueArm,
  budget,
  reEligibility,
];
