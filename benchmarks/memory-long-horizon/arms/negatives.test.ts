/**
 * The silence set and its replay (A5 §2 `silence` (c), §3.7; EXECUTION §8; P0.0d), and `eden eval build-negatives`
 * checked against what the simulator knows: which submits were human, and which secrets were planted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimWorld } from "../harness/session";
import { generateSession, play, type Step } from "../harness/shape";
import { loadPlugin } from "../harness/runner";
import { PROBE_PLUGIN, removeTempDirs, SCRIPTED_PLUGIN, tempDir } from "../harness/testkit";
import type { BenchCue } from "./cuebench";
import { monorepo } from "./fixtures/world";
import { EDEN_CLI } from "./kit";
import { fixtureNegatives, PRIVATE_SET_ABSENT, realNegatives, type NegativeSet } from "./negatives";
import { secretCases } from "./secrets";
import { replaySilence } from "./silence";

afterAll(removeTempDirs);

const cue = (id: string, text: string, cat = "neg-test"): BenchCue => ({
  id,
  cat,
  scope: "",
  gold: [],
  cue: text,
  last_paths: [],
  prev_turn: "",
  split: "test",
});

/** Runs `eden eval build-negatives` over a transcripts root, with its own home; returns the draft's texts. */
function build(root: string): { texts: string[]; stdout: string; exitCode: number | null } {
  const home = tempDir("eden-negatives-home");
  const result = Bun.spawnSync([...EDEN_CLI, "eval", "build-negatives", "--transcripts", root], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, EDEN_HOME: join(home, ".eden") },
    stdout: "pipe",
    stderr: "pipe",
  });
  let texts: string[] = [];
  try {
    texts = readFileSync(join(home, ".eden", "eval", "real-negatives.draft.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { text: string }).text);
  } catch {}
  return { texts, stdout: result.stdout.toString(), exitCode: result.exitCode };
}

describe("the silence set", () => {
  test("R1's 150 negatives and R8's 98, as two sources", () => {
    const sets = fixtureNegatives();
    expect(sets.map((set) => [set.source, set.cues.length])).toEqual([
      ["r1", 150],
      ["r8", 98],
    ]);
    expect(new Set(sets[0]!.cues.map((item) => item.cat))).toEqual(
      new Set(["neg-chat", "neg-hard", "neg-math", "neg-offtopic"]),
    );
  });

  test("without EDEN_EVAL_NEGATIVES the private set is absent, and the replay says it is skipped", () => {
    expect(realNegatives({})).toEqual({ status: "absent" });
    console.log(PRIVATE_SET_ABSENT);
    expect(PRIVATE_SET_ABSENT).toBe("skipped: private set absent");
  });

  test("a frozen set loads only while its sha256 matches", () => {
    const dir = tempDir("eden-frozen");
    const path = join(dir, "real-negatives.v1.jsonl");
    const body = '{"id":"a1","text":"what is a monad?"}\n{"id":"b2","text":"thanks!"}\n';
    writeFileSync(path, body);
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    writeFileSync(`${path}.sha256`, `${sha}  real-negatives.v1.jsonl\n`);
    const loaded = realNegatives({ EDEN_EVAL_NEGATIVES: path });
    expect(loaded).toMatchObject({ status: "loaded", sha256: sha });
    if (loaded.status === "loaded") expect(loaded.set.cues.map((item) => [item.id, item.cat])).toEqual([
      ["a1", "neg-real"],
      ["b2", "neg-real"],
    ]);
    writeFileSync(path, body.replace("monad", "Monad"));
    expect(() => realNegatives({ EDEN_EVAL_NEGATIVES: path })).toThrow("sha256");
  });
});

describe("the replay", () => {
  const sets: NegativeSet[] = [
    { source: "r1", cues: [cue("q1", "please FIRE now"), cue("q2", "quiet one"), cue("q3", "FIRE again")] },
    { source: "real", cues: [cue("r1", "nothing here"), cue("r2", "FIRE")] },
  ];
  const store = { seed: 1, world: monorepo(), sessions: [] };

  test("counts the packets on each source's prompts, with a Wilson interval and the ids of false fires", async () => {
    const runDir = tempDir("eden-silence");
    const table = join(runDir, "answers.json");
    writeFileSync(table, JSON.stringify([{ event: "UserPromptSubmit", when: "FIRE", context: "Eden memory:\n- x" }]));
    const result = await replaySilence({
      pluginDir: SCRIPTED_PLUGIN,
      store,
      sets,
      runDir,
      env: { SCRIPTED_ANSWERS: table },
    });
    expect(result.map((item) => [item.source, item.fir.k, item.fir.n, item.falseFires])).toEqual([
      ["r1", 2, 3, ["q1", "q3"]],
      ["real", 1, 2, ["r2"]],
    ]);
    expect(result[0]!.fir.ci).toEqual([0.2077, 0.9385]);
  });

  test("every negative meets the store as the seed sessions left it, never the earlier negatives", async () => {
    const runDir = tempDir("eden-silence-isolated");
    const table = join(runDir, "answers.json");
    const once = [{ event: "UserPromptSubmit", when: "prompt", context: "Eden memory:\n- y", once: true }];
    writeFileSync(table, JSON.stringify(once));
    const result = await replaySilence({
      pluginDir: SCRIPTED_PLUGIN,
      store,
      sets: [sets[0]!],
      runDir,
      env: { SCRIPTED_ANSWERS: table, SCRIPTED_REFERENCE: "1" },
    });
    expect(result[0]!.fir.k).toBe(3);
  });
});

describe("eden eval build-negatives on simulated transcripts", () => {
  /** The texts a script's human submits carry: typed and queued prompts, rewinds and mid-turn prompts. */
  const humanTexts = (steps: readonly Step[]) =>
    steps.flatMap((step) =>
      step.kind === "prompt" || step.kind === "rewind" || step.kind === "queued-prompt" ? [step.text] : [],
    );

  test("the draft holds exactly the human prompts (precision and recall 1.0)", async () => {
    const runDir = tempDir("eden-select");
    const world = new SimWorld({ runDir, plugin: loadPlugin(PROBE_PLUGIN), seed: 5, env: { PROBE_MODE: "silent" } });
    const scripts = [3, 17, 29].map((seed) => generateSession(seed, { toolScale: 0.1, growthScale: 0.1 }));
    const kinds = new Set(scripts.flatMap((script) => script.steps.map((step) => step.kind)));
    for (const kind of ["notify", "peer", "compact", "subagent", "rewind", "queued-prompt"]) expect(kinds).toContain(kind);
    for (const script of scripts) await play(script, world);
    const expected = [...new Set(scripts.flatMap((script) => humanTexts(script.steps)).map((text) => text.trim()))];
    const { texts, exitCode } = build(join(world.home, ".claude", "projects"));
    expect(exitCode).toBe(0);
    expect(texts.sort()).toEqual(expected.sort());
  }, 120_000);

  test("the secrets arm's 360 texts, typed and pasted: every prompt dropped, no secret byte in the draft", () => {
    const root = tempDir("eden-secret-prompts");
    const project = join(root, "-tmp-demo");
    mkdirSync(project);
    const lines = secretCases().flatMap((item, n) => [
      { type: "user", message: { role: "user", content: `${item.text}\nwhy does staging reject it?` } },
      {
        type: "user",
        message: {
          role: "user",
          content: `here is the env file:\n<pasted_content id="s${n}">\n${item.text}\n</pasted_content id="s${n}">`,
        },
      },
    ]);
    lines.push({ type: "user", message: { role: "user", content: "a control prompt that stays." } });
    writeFileSync(join(project, "s.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const { texts, stdout } = build(root);
    expect(texts).toEqual(["a control prompt that stays."]);
    expect(stdout).toContain("dropped for a secret: 720");
    const draft = texts.join("\n");
    expect(secretCases().filter((item) => draft.includes(item.secret))).toEqual([]);
  });
});
