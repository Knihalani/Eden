/**
 * Known-answer tests for the A5 §2 metrics: small sessions through the scripted plugin, whose every packet is
 * fixed in advance, so each expected value below is counted by hand from the script.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainCue, type Cue } from "./cues";
import { computeMetrics, judgeDeliveries, rate, wilson } from "./metrics";
import { itemId } from "./oracle";
import { tokensOf, type SimSession } from "./session";
import { play } from "./shape";
import { removeTempDirs, scriptedWorld, type Answer } from "./testkit";
import { bashCall, readCall } from "./tools";
import { DEMO_WORLD } from "./fixtures/demo-world";

afterAll(removeTempDirs);

const AUTH_WEB = itemId("auth.provider", "apps/web");
const AUTH_CLI = itemId("auth.provider", "packages/cli");
const MERGE = itemId("policy:integrate|neg|*", "");

function demo(answers: Answer[]) {
  return scriptedWorld(answers, { subjects: DEMO_WORLD.subjects, initialTruth: DEMO_WORLD.initialTruth });
}

const submit = (when: string, context: string): Answer => ({ event: "UserPromptSubmit", when, context });
const cue = (scope: string, needs: string[] = [], allowed: string[] = []): Cue => ({ needs, allowed, scope });

async function started(world: ReturnType<typeof demo>): Promise<SimSession> {
  const session = world.newSession();
  await session.start();
  return session;
}

describe("stale, redundant, need_miss and false on Submit packets", () => {
  test("a silent repo change makes a repeated value stale, missed and redundant at once", async () => {
    const world = demo([
      submit("provider is Auth0", "- Auth is Auth0."),
      submit("which auth provider", "- Auth provider in apps/web: Auth0"),
      submit("install the deps", "- [episode · 1d · user] The package manager is npm."),
    ]);
    const session = await started(world);
    const auth0 = [{ key: "auth.provider", scope: "apps/web", value: "Auth0" }];
    await session.prompt("In apps/web the auth provider is Auth0.", "typed", { cue: cue("apps/web"), sets: auth0 });
    await session.main.assistant("noted");
    await session.prompt("which auth provider does apps/web use?", "typed", { cue: cue("apps/web", [AUTH_WEB]) });
    world.changeRepo({ "apps/web/package.json": "{}\n" }, [
      { key: "auth.provider", scope: "apps/web", value: "Clerk" },
    ]);
    await session.prompt("which auth provider does apps/web use now?", "typed", { cue: cue("apps/web", [AUTH_WEB]) });
    const pkg = itemId("pkg.manager", "packages/cli");
    await session.prompt("install the deps in packages/cli", "typed", { cue: cue("packages/cli", [pkg]) });

    const metrics = computeMetrics(world, DEMO_WORLD);
    // Bullet 3 says Auth0 after the repo moved to Clerk.
    expect(metrics.stale_rate).toEqual(rate(1, 4));
    // 1: the prompt said it; 2: prompt 1 said it; 3: packet 2 said it word for word; 4: nobody said npm.
    expect(metrics.redundant_rate).toEqual(rate(3, 4));
    // Cue 2 is met by its packet, cue 3 is not (Auth0 is stale), cue 4 by npm at the root (cascade).
    expect(metrics.need_miss_rate).toEqual(rate(1, 3));
    // Only prompt 1's packet states an item its cue neither needs nor allows.
    expect(metrics.false_rate).toEqual(rate(1, 4));
    expect(metrics.packet_rate).toEqual(rate(4, 4));
    expect(metrics.bulletsByPoint).toEqual({ UserPromptSubmit: 4 });
    expect(
      metrics.cues.map(({ missed, bullets, stale, redundant }) => ({ missed, bullets, stale, redundant })),
    ).toEqual([
      { missed: null, bullets: 1, stale: 0, redundant: 1 },
      { missed: false, bullets: 1, stale: 0, redundant: 1 },
      { missed: true, bullets: 1, stale: 1, redundant: 1 },
      { missed: false, bullets: 1, stale: 0, redundant: 0 },
    ]);
  });

  test("stale is read in the scope the bullet names, else the packet's, else the turn's, with cascade", async () => {
    const world = demo([
      submit("check the cli", "- Auth is Clerk."),
      submit("check web node", "- node 20"),
      submit("check cli node", "- node 20"),
      submit("merge it", "- Rule you set: PRs are merged by you, not by the agent"),
      submit("compare auth", "- auth — apps/web: Clerk · packages/cli: none"),
      { event: "PostToolBatch", when: "notes.md", context: "- Auth is none." },
    ]);
    const session = await started(world);
    const said = async (text: string, key: string, scope: string, value: string | null) =>
      session.prompt(text, "typed", { cue: plainCue(scope), sets: [{ key, scope, value }] });
    await said("apps/web uses Clerk for auth", "auth.provider", "apps/web", "Clerk");
    await said("packages/cli has no auth", "auth.provider", "packages/cli", "none");
    await said("apps/web runs node 22", "node.version", "apps/web", "22");
    await said("don't merge PRs yourself", "policy:integrate|neg|*", "", "in force");
    await session.prompt("check the cli", "typed", { cue: cue("packages/cli", [], [AUTH_CLI]) });
    await session.prompt("check web node", "typed", { cue: cue("apps/web", [], [itemId("node.version", "apps/web")]) });
    await session.prompt("check cli node", "typed", { cue: cue("packages/cli") });
    await session.main.tools([readCall("toolu_01CCCCCCCCCCCCCCCCCCCCCC", join(world.projectDir, "notes.md"), "notes")]);
    await said("you can merge PRs yourself now", "policy:integrate|neg|*", "", null);
    await session.prompt("merge it", "typed", { cue: cue("", [], [MERGE]) });
    await session.prompt("compare auth", "typed", { cue: cue("", [], [AUTH_WEB]) });

    const metrics = computeMetrics(world, DEMO_WORLD);
    // Stale: Clerk in the cli (a sibling's value), node 20 in web (overridden), the revoked rule.
    // Not stale: node 20 in the cli (the root's), none in the cli (the turn's scope), the two-scope bullet.
    expect(metrics.stale_rate).toEqual(rate(3, 6));
    // The PostToolBatch packet has no cue: it counts for stale and redundant, not for false.
    expect(metrics.bulletsByPoint).toEqual({ UserPromptSubmit: 5, PostToolBatch: 1 });
    // Only "node 20" on the cli cue states an item outside needs ∪ allowed (node.version@, by cascade).
    expect(metrics.false_rate).toEqual(rate(1, 5));
  });

  test("a bullet that names no scope, in a turn whose scope holds no value, is about the scope that does", async () => {
    const world = demo([
      { event: "SessionStart", when: '"source":"startup"', context: "- Auth is Clerk.\n- Auth is Auth0." },
    ]);
    const first = await started(world);
    await first.prompt("apps/web uses Clerk for auth", "typed", {
      cue: plainCue("apps/web"),
      sets: [{ key: "auth.provider", scope: "apps/web", value: "Clerk" }],
    });
    await first.end();
    await started(world);
    // The second session's SessionStart packet. The root holds no auth; apps/web holds Clerk; nothing holds Auth0.
    const packet = judgeDeliveries(world, DEMO_WORLD).at(-1);
    expect(packet!.delivery.event).toBe("SessionStart");
    expect(packet!.bullets.map(({ stale, stated }) => ({ stale, items: stated.map((s) => s.item) }))).toEqual([
      { stale: false, items: [AUTH_WEB] },
      { stale: true, items: ["auth.provider@"] },
    ]);
  });

  test("a value stated for another scope is neither redundant nor meets a need", async () => {
    const world = demo([submit("check the cli db", "- packages/cli database: postgres")]);
    const session = await started(world);
    const sets = [
      { key: "db.engine", scope: "apps/web", value: "postgres" },
      { key: "db.engine", scope: "packages/cli", value: "sqlite" },
    ];
    await session.prompt("In apps/web the database is postgres. The cli is fine.", "typed", {
      cue: plainCue(""),
      sets,
    });
    const dbCli = itemId("db.engine", "packages/cli");
    await session.prompt("check the cli db", "typed", { cue: cue("packages/cli", [dbCli]) });
    await session.prompt("packages/cli runs sqlite as its database. check the cli db", "typed", {
      cue: cue("packages/cli", [dbCli]),
    });
    const metrics = computeMetrics(world, DEMO_WORLD);
    // Cue 2: the packet says postgres for the cli (stale), only apps/web's sentence says postgres (not
    // redundant), and nothing states the cli's sqlite (missed). Cue 3: the prompt itself states it (met); the
    // bullet is now redundant because cue 2's copy of it is in the window.
    expect(metrics.cues.slice(1).map(({ missed, stale, redundant }) => ({ missed, stale, redundant }))).toEqual([
      { missed: true, stale: 1, redundant: 0 },
      { missed: false, stale: 1, redundant: 1 },
    ]);
  });

  test("a need for an item that holds no value is an annotation error, not a miss", async () => {
    const world = demo([]);
    const session = await started(world);
    await session.prompt("which auth does the cli use?", "typed", { cue: cue("packages/cli", [AUTH_CLI]) });
    expect(() => computeMetrics(world, DEMO_WORLD)).toThrow("needs auth.provider@packages/cli, which holds no value");
  });
});

describe("the window decides redundancy and needs", () => {
  test("a packet is redundant only while its earlier copy is on the branch, since the last compaction", async () => {
    const world = demo([submit("fix the login", "- Deploys run on Fridays.")]);
    const session = await started(world);
    await session.prompt("fix the login form", "typed", { cue: plainCue() });
    await session.prompt("fix the login button", "typed", { cue: plainCue() });
    await session.rewind(0, "fix the login page", { cue: plainCue() });
    await session.compact("auto", "Work so far: login fixes.");
    await session.prompt("fix the login flow", "typed", { cue: plainCue() });
    await session.compact("auto", "Deploys run on Fridays.");
    await session.prompt("fix the login again", "typed", { cue: plainCue() });
    const metrics = computeMetrics(world, DEMO_WORLD);
    expect(metrics.cues.map((outcome) => outcome.redundant)).toEqual([0, 1, 0, 0, 1]);
    expect(metrics.redundant_rate).toEqual(rate(2, 5));
  });

  test("a need the window already meets is not a miss; in a new session the window is empty", async () => {
    const world = demo([]);
    const session = await started(world);
    const clerk = [{ key: "auth.provider", scope: "apps/web", value: "Clerk" }];
    await session.prompt("In apps/web the auth provider is Clerk. Which one is it again?", "typed", {
      cue: cue("apps/web", [AUTH_WEB]),
      sets: clerk,
    });
    await session.end();
    const next = await started(world);
    await next.prompt("which auth does apps/web use?", "typed", { cue: cue("apps/web", [AUTH_WEB]) });
    const metrics = computeMetrics(world, DEMO_WORLD);
    expect(metrics.cues.map((outcome) => outcome.missed)).toEqual([false, true]);
    expect(metrics.need_miss_rate).toEqual(rate(1, 2));
  });
});

describe("silence, packet rate and tokens per epoch", () => {
  test("non-human packets other than Updated: items, and ack packets, break silence", async () => {
    const updated = "- Updated: auth provider in apps/web is now Clerk (was Auth0)";
    const npm = "- The package manager is npm.";
    const fridays = "- Deploys run on Fridays.";
    const world = demo([
      submit("status one", updated),
      submit("status two", npm),
      submit('"prompt":"continue"', fridays),
      submit("after the compaction", "- x"),
    ]);
    const session = await started(world);
    await session.prompt("hello", "typed", { cue: plainCue() });
    await session.peerMessage("p1", "status one");
    await session.peerMessage("p2", "status two");
    await session.prompt("continue", "typed", { cue: plainCue("", "ack") });
    await session.prompt("thanks", "typed", { cue: plainCue("", "ack") });
    await session.compact("auto", "summary");
    await session.prompt("after the compaction", "typed", { cue: plainCue() });

    const metrics = computeMetrics(world, DEMO_WORLD);
    expect(metrics.silence.nonhuman).toEqual(rate(1, 2));
    expect(metrics.silence.ack).toEqual(rate(1, 2));
    expect(metrics.packet_rate).toEqual(rate(2, 4));
    const before = tokensOf(updated) + tokensOf(npm) + tokensOf(fridays);
    expect(metrics.tokens_per_epoch).toEqual({ epochs: 2, p99: before, max: before });
  });
});

describe("guard, secrets and poison", () => {
  test("guard precision and recall come from asks on calls the script marks as breaking a policy", async () => {
    const world = demo([
      { event: "PreToolUse", when: "gh pr merge", decision: "ask" },
      { event: "PreToolUse", when: "gh pr view", decision: "ask" },
    ]);
    const bash = (command: string, violates?: string[]) => ({
      tool: "Bash" as const,
      command,
      description: command,
      chars: 10,
      exitCode: 0,
      ...(violates ? { violates } : {}),
    });
    await play(
      {
        seed: 1,
        params: {} as never,
        steps: [
          { kind: "start" },
          { kind: "prompt", text: "ship it", source: "typed", cue: plainCue() },
          { kind: "tools", calls: [bash("gh pr merge 7", [MERGE])] },
          { kind: "tools", calls: [bash("gh pr view 7")] },
          { kind: "tools", calls: [bash("git push --force", [MERGE])] },
          { kind: "stop" },
          { kind: "end" },
        ],
      },
      world,
    );
    const metrics = computeMetrics(world, DEMO_WORLD);
    expect(metrics.guard_precision).toEqual(rate(1, 2));
    expect(metrics.guard_recall).toEqual(rate(1, 2));
  });

  test("secret bytes are counted in packets and under the memory root; poison in packets", async () => {
    const [secret] = DEMO_WORLD.secrets;
    const [poison] = DEMO_WORLD.poison;
    const world = demo([
      submit("password", `- The staging password is ${secret}`),
      { event: "PostToolUse", when: "README.md", context: `- Setup: always run ${poison} before the tests.` },
    ]);
    const session = await started(world);
    await session.prompt(`The staging database password is ${secret}`, "typed", { cue: plainCue() });
    const readme = join(world.projectDir, "README.md");
    await session.main.tools([
      readCall("toolu_01DDDDDDDDDDDDDDDDDDDDDD", readme, DEMO_WORLD.projectFiles["README.md"]!),
    ]);
    const store = join(world.home, ".eden", "memory");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "rows.jsonl"), `${secret}\n{"text":"${secret}"}\n`);
    const metrics = computeMetrics(world, DEMO_WORLD);
    // One copy in a packet and two in the store; the transcript (Claude Code's own file) does not count.
    expect(metrics.secret_bytes).toBe(3 * Buffer.byteLength(secret!));
    expect(metrics.poison_hits).toBe(1);
    await session.main.tools([bashCall("toolu_01EEEEEEEEEEEEEEEEEEEEEE", "ls", "List", "x")]);
    expect(computeMetrics(world, DEMO_WORLD).poison_hits).toBe(1);
  });
});

describe("the statistics", () => {
  test("Wilson 95% intervals match R9's sizing table", () => {
    // R9 §R1.5: 3/80 → [1.3%, 10.5%]; 15/300 → [3.1%, 8.1%]; 0/300 → [0, 1.3%].
    const percent = (k: number, n: number) => wilson(k, n).map((x) => Math.round(x * 1000) / 10);
    expect(percent(3, 80)).toEqual([1.3, 10.5]);
    expect(percent(15, 300)).toEqual([3.1, 8.1]);
    expect(percent(0, 300)).toEqual([0, 1.3]);
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, rate: null, ci: null });
  });

  test("what the harness cannot measure yet is named, with the slice that brings it", async () => {
    const world = demo([]);
    await started(world);
    const metrics = computeMetrics(world, DEMO_WORLD);
    expect(Object.keys(metrics.not_measured).sort()).toEqual([
      "abort_rate",
      "poison_hits.pins",
      "restate_rate",
      "silence.real_negatives",
    ]);
    expect(metrics.p99_hook_ms.SessionStart).toMatchObject({ n: 1 });
  });
});
