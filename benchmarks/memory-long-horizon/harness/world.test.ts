/**
 * The world scenario: a fixed storyline woven into R6-shaped sessions, annotated, checked, and played.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMetrics } from "./metrics";
import { loadPlugin } from "./runner";
import { SimWorld } from "./session";
import { generateSession, shapeStats, type Step } from "./shape";
import { removeTempDirs, tempDir } from "./testkit";
import { DEMO_WORLD } from "./fixtures/demo-world";
import { fillerCue, generateWorldScenario, keptPrompts, playScenario } from "./world";

afterAll(removeTempDirs);

const humanSteps = (steps: readonly Step[]) =>
  steps.filter((step) => step.kind === "prompt" || step.kind === "rewind" || step.kind === "queued-prompt");

describe("generating a scenario", () => {
  test("a seed gives one scenario; seeds change the schedule, not the story", () => {
    const first = generateWorldScenario(2);
    expect(JSON.stringify(generateWorldScenario(2))).toBe(JSON.stringify(first));
    const story = (seed: number) =>
      generateWorldScenario(seed)
        .sessions.flatMap((script) => humanSteps(script.steps))
        .filter((step) => step.cue.needs.length || step.sets || !step.cue.allowed.length)
        .map((step) => step.text)
        .filter((text) => !/^(continue|fix|add|why|refactor|rename|the build|write|explain)\b/.test(text));
    expect(story(1)).toEqual(story(3));
    expect(story(1).length).toBeGreaterThan(15);
    expect(first.sessions.length).toBeGreaterThanOrEqual(7);
  });

  test("every human prompt is annotated, and the sessions keep the generator's shape", () => {
    const scenario = generateWorldScenario(1);
    for (const script of scenario.sessions) {
      for (const step of humanSteps(script.steps)) expect(step.cue).toBeDefined();
      const generated = generateSession(script.seed, script.params);
      const { toolCallsPerHumanTurn: _woven, ...woven } = shapeStats(script);
      const { toolCallsPerHumanTurn: _plain, ...plain } = shapeStats(generated);
      expect(woven).toEqual(plain);
    }
  });

  test("a storyline prompt is never one a later rewind abandons", () => {
    const steps: Step[] = [
      { kind: "start" },
      { kind: "prompt", text: "a", source: "typed", cue: fillerCue("a", undefined, DEMO_WORLD) },
      { kind: "prompt", text: "b", source: "typed", cue: fillerCue("b", undefined, DEMO_WORLD) },
      { kind: "rewind", index: 1, text: "b2", cue: fillerCue("b2", undefined, DEMO_WORLD) },
      { kind: "compact", trigger: "auto", summary: "s", atTokens: 1 },
      { kind: "prompt", text: "c", source: "typed", cue: fillerCue("c", undefined, DEMO_WORLD) },
    ];
    expect(keptPrompts(steps)).toEqual([1, 3, 5]);
  });

  test("a generated prompt allows the items it names, at the scope of the path it names", () => {
    expect(fillerCue("fix the failing test in apps/web/src/auth.ts", undefined, DEMO_WORLD)).toEqual({
      needs: [],
      allowed: ["auth.provider@apps/web"],
      scope: "apps/web",
    });
    expect(fillerCue("continue", "ack", DEMO_WORLD)).toEqual({ needs: [], allowed: [], scope: "", mode: "ack" });
    expect(fillerCue("explain what packages/wrap/src/db.ts does", undefined, DEMO_WORLD).allowed).toEqual([
      "db.engine@",
    ]);
  });

  test("a story that cues a need before it is true is rejected", () => {
    const story = [
      { text: "which node does apps/web use?", scope: "apps/web", needs: ["node.version@apps/web"] },
      { text: "the cache is Redis", scope: "", needs: ["cache.store@"] },
    ];
    expect(() => generateWorldScenario(1, DEMO_WORLD, story)).toThrow("needs cache.store@, which holds no value");
    expect(() => generateWorldScenario(1, DEMO_WORLD, [{ text: "x", scope: "", needs: ["test.runner@"] }])).toThrow(
      "no subject test.runner",
    );
  });
});

describe("playing a scenario", () => {
  test("with a plugin that never answers: the truth moves as the story says, and no need is met", async () => {
    const root = tempDir("eden-silent-plugin");
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    const scenario = generateWorldScenario(1);
    const world = new SimWorld({
      runDir: tempDir("eden-world"),
      plugin: loadPlugin(root),
      seed: scenario.seed,
      projectFiles: scenario.world.projectFiles,
      subjects: scenario.world.subjects,
      initialTruth: scenario.world.initialTruth,
    });
    const results = await playScenario(scenario, world);
    expect(results.map((result) => result.skipped)).toEqual(scenario.sessions.map(() => 0));
    const end = world.log.length;
    const truth = (key: string, scope: string) => world.oracle.truth(key, scope, end)?.value;
    expect(truth("pkg.manager", "packages/cli")).toBe("pnpm");
    expect(truth("node.version", "apps/web")).toBe("22");
    expect(truth("node.version", "packages/cli")).toBe("20");
    expect(truth("auth.provider", "apps/web")).toBeNull();
    expect(truth("auth.provider", "packages/cli")).toBe("none");
    expect(truth("cache.store", "")).toBeNull();
    expect(truth("policy:integrate|neg|*", "")).toBeNull();
    const causes = new Set(world.oracle.entries.map((entry) => entry.cause));
    expect([...causes].sort()).toEqual(["init", "repo", "user"]);
    const metrics = computeMetrics(world, scenario.world);
    expect(world.deliveries).toEqual([]);
    expect(metrics.packet_rate.k).toBe(0);
    const humanSubmits = world.log.filter((record) => record.submit === "human").length;
    expect(world.cues.length).toBe(humanSubmits);
    // Six storyline cues need an item. Each needed value was said in an earlier session or never said at all
    // (npm → pnpm and node 20 come from the repo), so with no packets every one is missed.
    expect(metrics.need_miss_rate).toMatchObject({ k: 6, n: 6 });
    expect(world.violations.size).toBe(1);
  }, 60_000);
});
