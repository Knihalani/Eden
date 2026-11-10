import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../lab/ab-common";
import { IDEAL, simSources } from "../sources";
import { buildWorld } from "../world";
import { annotate, blindOrder } from "./annotate";
import { importSources, labSourceOf, MAX_TEXT_CHARS } from "./import";
import { newTask, parseFlags, sendNotice } from "./pilot";
import { buildReport, MIN_DISCORDANT, renderReport, signTest } from "./report";
import { insideGit, PilotDirError, PilotStore, type PilotMarks } from "./store";
import { readBundle, taskId, worldFromPilot } from "./world";

// Sim data only: a generated world stands in for the consenting account (its items carry planted secrets).
const SCOPE = { tenantId: "pilot", userId: "owner" };
const USER = { name: "Robin Carter", email: "robin@example.com" };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-pilot-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function imported(maxItems = 400) {
  const world = buildWorld({ seed: 41_000 });
  const sources = simSources(world, IDEAL, 0, 41);
  const got = await importSources(sources, SCOPE, USER, {
    maxItems,
    queries: ["dentist appointment"],
    now: () => 1_000,
  });
  return { world, ...got };
}

test("the import keeps each source's items with every planted secret redacted, and counts them", async () => {
  const { world, meta, items } = await imported(5_000);
  const secrets = world.items.filter((i) => i.secret).map((i) => i.secret!);
  expect(secrets.length).toBeGreaterThan(0);
  const stored = JSON.stringify(items);
  for (const s of secrets) expect(stored).not.toContain(s);
  expect(stored).toContain("[REDACTED]");
  expect(Object.values(meta.counts).reduce((n, c) => n + c.redacted, 0)).toBeGreaterThan(0);
  // Every source the world has, under the lab's connector ids, and every item of each.
  expect(Object.keys(meta.sources).sort()).toEqual(Object.keys(world.sources).sort());
  expect(items.length).toBe(world.items.length);
  expect(Object.values(meta.counts).reduce((n, c) => n + c.items, 0)).toBe(items.length);
  for (const it of items) expect(it.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  expect(meta.user).toEqual(USER);
});

test("the import stops at the cap per source, and a source that fails leaves the others' items", async () => {
  const { meta, items } = await imported(50);
  for (const c of Object.values(meta.counts)) expect(c.items).toBeLessThanOrEqual(50);
  const world = buildWorld({ seed: 41_000 });
  const [first, ...others] = simSources(world, IDEAL, 0, 41);
  const broken = { ...first!, id: first!.id, kind: "sim", description: first!.description, list: undefined };
  const failing = {
    ...broken,
    search: async () => {
      throw new Error("token=sk_live_kITFXe56pD5IHjmXdkNld3Ct rejected");
    },
  };
  const lines: string[] = [];
  const got = await importSources([failing, ...others], SCOPE, USER, { queries: ["x"], log: (l) => lines.push(l) });
  expect(got.items.length).toBeGreaterThan(0);
  expect(got.items.length).toBeLessThan(items.length + world.items.length);
  // A connector's error message is redacted before it is printed.
  expect(lines.join("\n")).toContain("stopped");
  expect(lines.join("\n")).not.toContain("sk_live_kITFXe56pD5IHjmXdkNld3Ct");
});

test("sources are served under the lab's connector ids", () => {
  expect(labSourceOf({ id: "gmail", description: "x" })).toBe("gmail");
  expect(labSourceOf({ id: "mail", description: "The user's Gmail: mail threads" })).toBe("gmail");
  expect(labSourceOf({ id: "cal", description: "The user's Google Calendar: events" })).toBe("calendar");
  expect(labSourceOf({ id: "notes", description: "The user's notes" })).toBe("drive");
});

test("the store is owner-only, refuses a git work tree, and forget deletes everything", async () => {
  const { meta, items } = await imported(20);
  const store = new PilotStore(join(dir, "pilot"));
  store.saveImport(meta, items);
  store.saveTasks([newTask("dentist", "Book the dentist", ["Friday 9:00 clashes with the school run"], 1)]);
  expect(statSync(store.dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(store.dir, "items.jsonl")).mode & 0o777).toBe(0o600);
  expect(statSync(join(store.dir, "tasks.json")).mode & 0o777).toBe(0o600);
  expect(store.items()).toEqual(items);
  expect(store.meta()).toEqual(meta);
  expect(() => store.runDir("../escape")).toThrow(PilotDirError);
  expect(store.forget()).toBe(true);
  expect(store.exists()).toBe(false);
  expect(store.forget()).toBe(false);
  // Real data never sits where a commit could take it.
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  expect(insideGit(join(dir, "repo", "data", "pilot"))).toBe(true);
  expect(() => new PilotStore(join(dir, "repo", "data", "pilot"))).toThrow(PilotDirError);
  expect(insideGit(import.meta.dir)).toBe(true);
  // A directory the pilot did not make owner-only is not removed.
  mkdirSync(join(dir, "shared"), { mode: 0o755 });
  expect(() => new PilotStore(join(dir, "shared")).forget()).toThrow(PilotDirError);
});

test("a bundle becomes a lab world: the redacted items behind the lab's connectors, the owner's requests as tasks", async () => {
  const { meta, items } = await imported(5_000);
  const tasks = [
    newTask("dentist", "Book the dentist for Friday morning", ["Friday 9:00 clashes with the school run"], 1),
    newTask("thanks", "Thank Priya for lunch", [], 2),
  ];
  const { world, tasks: labTasks } = worldFromPilot(readBundle(JSON.stringify({ meta, items, tasks })), 7);
  expect(world.user.full).toBe("Robin Carter");
  expect(world.user.first).toBe("Robin");
  expect(world.now).toBe(1_000);
  expect(world.items.length).toBe(items.length);
  expect(labTasks.map((t) => [t.id, t.kind, t.must.length])).toEqual([
    ["pilot:dentist", "hidden", 1],
    ["pilot:thanks", "neutral", 0],
  ]);
  // The lab's connectors serve the import: a search finds an imported item by its own words.
  const probe = items.find((i) => i.sourceId === "gmail" && i.title.split(" ").length > 2)!;
  const gmail = simSources(world, IDEAL, 0, 7).find((s) => s.id === "gmail")!;
  const found = await gmail.search(
    { scope: SCOPE, text: probe.title, entities: [], limit: 20 },
    AbortSignal.timeout(5_000),
  );
  expect(found.map((f) => f.ref)).toContain(probe.ref);
  expect(() => readBundle("{}")).toThrow("not a pilot bundle");
});

const result = (task: string, condition: string, answer: string, facts?: Record<string, boolean>): RunResult =>
  ({
    task,
    condition,
    answer,
    modelCalls: condition === "eden" ? 1 : 2,
    toolCalls: condition === "eden" ? 0 : 2,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0.001,
    wallMs: condition === "eden" ? 1_000 : 2_000,
    injectedItems: 0,
    injectedChars: 0,
    edenModelCalls: 0,
    edenCostUsd: condition === "eden" ? 0.0005 : 0,
    lateItems: 0,
    ...(facts ? { facts } : {}),
  }) as RunResult;

/** A scripted owner: yes to a fact only in Eden's answers (which the owner cannot tell apart; the test can). */
function scripted(wrongIn = "") {
  const shown: string[] = [];
  let current = "";
  let saves = 0;
  let retried = false;
  return {
    shown,
    saves: () => saves,
    io: {
      print: (l: string) => {
        shown.push(l);
        if (l.startsWith("\n--- Answer")) current = l;
      },
      ask: async (q: string) => {
        // An answer that is neither yes nor no is asked again.
        if (!retried) return ((retried = true), "maybe");
        if (q.startsWith("Did it raise:")) return current.includes("eden answer") ? "y" : "n";
        return wrongIn && current.includes(wrongIn) ? "yes" : "no";
      },
      save: () => void saves++,
    },
  };
}

const TASKS = Array.from({ length: 12 }, (_, i) => newTask(`t${i}`, `request ${i}`, i < 8 ? [`fact ${i}`] : [], i));
const RESULTS = TASKS.flatMap((t) => [
  result(taskId(t.id), "tools", `alone answer ${t.id}`, t.facts.length ? { [t.facts[0]!.id]: false } : undefined),
  result(taskId(t.id), "eden", `eden answer ${t.id}`, t.facts.length ? { [t.facts[0]!.id]: true } : undefined),
]);

test("annotation shows answers without their arm, in an order that does not follow it, and saves as it goes", async () => {
  const firsts = TASKS.map((t) => blindOrder(taskId(t.id), ["tools", "eden"])[0]);
  expect(new Set(firsts).size).toBe(2); // neither arm is always first
  expect(blindOrder("x", ["tools", "eden"])).toEqual(blindOrder("x", ["eden", "tools"]));
  const owner = scripted();
  const marks = await annotate(TASKS, RESULTS, {}, owner.io);
  // No line names an arm: only "Answer 1" and "Answer 2" and the answers' own text.
  for (const line of owner.shown) expect(line.replace(/(alone|eden) answer t\d+/g, "")).not.toMatch(/tools|eden/i);
  expect(owner.saves()).toBe(12);
  expect(marks["pilot:t0"]).toEqual({
    tools: { facts: { "t0-1": false }, wrong: false },
    eden: { facts: { "t0-1": true }, wrong: false },
  });
  expect(marks["pilot:t9"]!.eden).toEqual({ facts: {}, wrong: false });
  // A second sitting asks nothing about answers already marked.
  const again = scripted();
  expect(await annotate(TASKS, RESULTS, marks, again.io)).toEqual(marks);
  expect(again.shown).toEqual([]);
});

test("the report pairs the arms on the owner's marks and says how little a small pilot can show", async () => {
  const marks: PilotMarks = await annotate(TASKS, RESULTS, {}, scripted("alone answer t10").io);
  const r = buildReport(TASKS, RESULTS, marks);
  expect([r.factTasks, r.raisedAlone, r.raisedWithEden, r.onlyWithEden, r.onlyAlone]).toEqual([8, 0, 8, 8, 0]);
  expect(r.p).toBeCloseTo(2 * 0.5 ** 8);
  expect(r.wrong).toEqual({ marked: 12, alone: 1, withEden: 0 });
  expect(r.grader).toEqual({ tasks: 8, alone: 0, withEden: 8 });
  expect(r.arms.eden!.usdPerTask).toBeCloseTo(0.0015);
  expect(r.arms.tools!.wallMeanS).toBeCloseTo(2);
  expect(r.arms.eden!.turns).toBe(1);
  const text = renderReport(r);
  expect(text).toContain("with Eden 8 of 8 (100%)");
  expect(text).toContain(`at least ${MIN_DISCORDANT} requests differ`);
  // Unmarked answers are counted, never guessed from the grader.
  const partial = buildReport(TASKS, RESULTS, { "pilot:t0": marks["pilot:t0"]! });
  expect([partial.factTasks, partial.unmarked]).toEqual([1, 11]);
  expect(signTest(5, 0)).toBeCloseTo(0.0625);
  expect(signTest(6, 0)).toBeLessThan(0.05);
  expect(signTest(3, 3)).toBe(1);
  expect(signTest(0, 0)).toBe(1);
});

test("a run names what it sends and where before it starts; tasks and flags are checked", () => {
  const notice = sendNotice("claude-haiku-5-5", ["tools", "eden"], 120, 9);
  for (const role of ["the agent", "cards", "reader", "grader"]) expect(notice).toContain(role);
  expect(notice).toContain("Anthropic");
  expect(() => newTask("Bad Id", "x", [], 1)).toThrow();
  expect(() => newTask("ok", " ", [], 1)).toThrow();
  expect(newTask("ok", "do it", ["a", "b"], 1).facts.map((f) => f.id)).toEqual(["ok-1", "ok-2"]);
  expect(parseFlags(["add", "--id", "x", "--fact", "a", "--fact", "b"], ["fact"])).toEqual({
    one: { id: "x" },
    many: { fact: ["a", "b"] },
    rest: ["add"],
  });
  expect(() => parseFlags(["--id"])).toThrow();
});

test("the CLI end to end on sim data with no model: tasks, status, a refused run, and the harness reads the bundle", async () => {
  const home = join(dir, "pilot");
  const env = { ...process.env, EDEN_PILOT_DIR: home, HAIKU_API_KEY: "not-a-real-key" };
  const cli = (...args: string[]) =>
    spawnSync("bun", [join(import.meta.dir, "pilot.ts"), ...args], { env, encoding: "utf8", timeout: 60_000 });
  expect(cli("task", "add", "--id", "dentist", "--text", "Book the dentist", "--fact", "Friday clashes").status).toBe(
    0,
  );
  expect(cli("task", "add", "--id", "dentist", "--text", "again").stderr).toContain("exists");
  expect(cli("task", "list").stdout).toContain("1 requests, 1 with facts that mattered");
  // A run before an import is refused; so is a run inside a git work tree.
  expect(cli("run", "--model", "claude-haiku-5-5", "--cap", "0.1").stderr).toContain("import first");
  const inRepo = spawnSync("bun", [join(import.meta.dir, "pilot.ts"), "status"], {
    env: { ...env, EDEN_PILOT_DIR: join(import.meta.dir, "data") },
    encoding: "utf8",
  });
  expect(inRepo.status).toBe(2);
  expect(inRepo.stderr).toContain("inside a git repository");
  // The import through a sources file: a static source stands in for a connector.
  const specs = [
    {
      kind: "static",
      id: "gmail",
      description: "The user's email",
      docs: [{ ref: "m1", title: "Dentist", text: "Dentist Friday 9am. Portal password: Tr0ub4dor&30xQ" }],
    },
  ];
  writeFileSync(join(dir, "sources.json"), JSON.stringify(specs));
  const imp = cli(
    "import",
    "--sources",
    join(dir, "sources.json"),
    "--name",
    "Robin Carter",
    "--email",
    "r@example.com",
  );
  expect(imp.stderr).toBe("");
  expect(imp.stdout).toContain("kept 1 items");
  expect(cli("status").stdout).toContain("gmail: 1 items");
  // Without --send-to the run prints what it would send and starts nothing.
  const held = cli("run", "--model", "claude-haiku-5-5", "--cap", "0.1");
  expect(held.status).toBe(2);
  expect(held.stdout).toContain("Not started");
  expect(cli("run", "--model", "z-ai/glm-5.3-flash", "--cap", "0.1", "--send-to", "anthropic").stderr).toContain(
    "claude-",
  );
  // The harness takes the bundle (--dry: nothing is sent).
  const store = new PilotStore(home);
  const bundle = store.write(
    "bundle.json",
    JSON.stringify({ meta: store.meta(), items: store.items(), tasks: store.tasks() }),
  );
  const dry = spawnSync(
    "bun",
    [
      join(import.meta.dir, "..", "lab", "pi-ab.ts"),
      ...["--world-file", bundle, "--conditions", "tools,eden", "--model", "claude-haiku-5-5"],
      ...["--grader", "claude-haiku-5-5", "--card-model", "claude-haiku-5-5", "--reader-model", "claude-haiku-5-5"],
      ...["--spend-ledger", join(dir, "ledger.jsonl"), "--spend-cap", "0.01", "--budget", "0.01"],
      ...["--out", join(dir, "out.json"), "--dry"],
    ],
    { env: { ...env, OPENROUTER_API_KEY: "" }, encoding: "utf8", timeout: 60_000 },
  );
  expect(dry.status).toBe(0);
  expect(dry.stderr).toContain("1 tasks × 2 conditions");
  expect(dry.stderr).toContain("suites pilot");
  expect(cli("forget").stdout).toContain("deleted");
}, 120_000);
