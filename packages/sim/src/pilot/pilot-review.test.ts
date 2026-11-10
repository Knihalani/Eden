import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticSource, type Source } from "@eden/sources";
import type { Background, RunResult } from "../lab/ab-common";
import { SpendLedger } from "../lab/spend";
import { importSources, MAX_TEXT_CHARS } from "./import";
import { headroomFor, newTask, readSpecs } from "./pilot";
import { buildReport, renderReport } from "./report";
import { insideGit, MARKER, PilotDirError, PilotStore } from "./store";
import { taskId } from "./world";

// Each test is a defect the F3 review found in the first version of the kit (D489). Sim data only.
const SCOPE = { tenantId: "pilot", userId: "owner" };
const USER = { name: "Robin Carter", email: "robin@example.com" };
const TOKEN = "sk_live_kITFXe56pD5IHjmXdkNld3Ct";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-pilot-review-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("forget removes only a directory the pilot marked, and only the pilot's own entries in it", () => {
  // An owner-only directory the pilot never made (a ~/.ssh): untouched.
  const ssh = join(dir, "ssh");
  mkdirSync(ssh, { mode: 0o700 });
  writeFileSync(join(ssh, "id_rsa"), "key");
  expect(() => new PilotStore(ssh).forget()).toThrow(PilotDirError);
  expect(existsSync(join(ssh, "id_rsa"))).toBe(true);
  // A directory with someone else's files is never taken over: not narrowed, not written to, not deleted later.
  const docs = join(dir, "docs");
  mkdirSync(docs, { mode: 0o755 });
  writeFileSync(join(docs, "thesis.txt"), "work");
  const taken = new PilotStore(docs);
  expect(() => taken.saveTasks([newTask("a", "do it", [], 1)])).toThrow("holds other files");
  expect(statSync(docs).mode & 0o777).toBe(0o755);
  expect(() => taken.forget()).toThrow(PilotDirError);
  expect(existsSync(join(docs, "thesis.txt"))).toBe(true);
  // The pilot's own directory: marked, and a stray file added to it later survives forget.
  const store = new PilotStore(join(dir, "pilot"));
  store.saveTasks([newTask("a", "do it", [], 1)]);
  expect(existsSync(join(store.dir, MARKER))).toBe(true);
  writeFileSync(join(store.dir, "notes.txt"), "mine");
  expect(store.forget()).toBe(true);
  expect(existsSync(join(store.dir, "tasks.json"))).toBe(false);
  expect(existsSync(join(store.dir, MARKER))).toBe(false);
  expect(existsSync(join(store.dir, "notes.txt"))).toBe(true);
});

test("a link from outside a repository into one is refused", () => {
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  mkdirSync(join(dir, "repo", "data"));
  symlinkSync(join(dir, "repo", "data"), join(dir, "link"));
  expect(insideGit(join(dir, "link"))).toBe(true);
  expect(insideGit(join(dir, "link", "pilot"))).toBe(true);
  expect(() => new PilotStore(join(dir, "link", "pilot"))).toThrow(PilotDirError);
});

test("a secret that straddles the text cut is not stored, nor one in a field name or a source's description", async () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC" + "\nQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB".repeat(100);
  const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  // The key begins before the cut and ends after it.
  const text = `${"notes about the deploy. ".repeat(320)}${key} end`;
  expect(text.indexOf("-----BEGIN")).toBeLessThan(MAX_TEXT_CHARS);
  expect(text.length).toBeGreaterThan(MAX_TEXT_CHARS + 1_000);
  const inner = new StaticSource("drive", `Docs at https://example.com/?token=${TOKEN}`, [
    { ref: "d1", title: "Deploy notes", text, meta: { [`x-${TOKEN}`]: "v" } },
  ]);
  const { meta, items } = await importSources([inner], SCOPE, USER, { queries: ["deploy notes"] });
  const stored = JSON.stringify({ meta, items });
  expect(items).toHaveLength(1);
  expect(stored).not.toContain("QUFBQUFBQUFBQUFB");
  expect(stored).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
  expect(stored).not.toContain(TOKEN);
  expect(meta.counts.drive!.redacted).toBe(1);
  expect(items[0]!.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS + 20);
});

test("the owner's own request and facts pass the gate before they are stored", () => {
  const t = newTask("deploy", `Rotate the key ${TOKEN} today`, [`the old key ${TOKEN} is in the wiki`], 1);
  expect(JSON.stringify(t)).not.toContain(TOKEN);
  expect(t.text).toContain("[REDACTED]");
  expect(t.facts[0]!.detail).toContain("[REDACTED]");
});

test("a sources file that is not JSON is named, never quoted; a bad --max-items is an error", async () => {
  const file = join(dir, "sources.json");
  writeFileSync(file, `[{"preset": "gmail", "headers": {"Authorization": ${TOKEN}}}]`);
  let message = "";
  try {
    readSpecs(file);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toBe(`${file} is not valid JSON`);
  expect(() => readSpecs(join(dir, "missing.json"))).toThrow("cannot read");
  const cli = spawnSync(
    "bun",
    [join(import.meta.dir, "pilot.ts"), "import", "--sources", file, "--name", "R", "--email", "r@x"],
    {
      env: { ...process.env, EDEN_PILOT_DIR: join(dir, "pilot") },
      encoding: "utf8",
    },
  );
  expect(cli.status).toBe(2);
  expect(cli.stderr + cli.stdout).not.toContain(TOKEN);
  const source = new StaticSource("gmail", "mail", [{ ref: "m1", title: "a", text: "b" }]);
  expect(importSources([source], SCOPE, USER, { maxItems: Number("abc") })).rejects.toThrow("whole number");
});

test("a listing whose cursor never ends stops when a page adds nothing new", async () => {
  let calls = 0;
  const looping: Source = {
    id: "gmail",
    kind: "test",
    description: "mail",
    search: async () => [],
    list: async () => {
      calls++;
      return {
        items: [{ id: "gmail:m1", sourceId: "gmail", ref: "m1", title: "same", text: "again" }],
        next: "more",
      };
    },
  };
  const { items } = await importSources([looping], SCOPE, USER);
  expect(items).toHaveLength(1);
  expect(calls).toBe(2);
});

test("a run name cannot leave the pilot directory, and a run's files are made owner-only", () => {
  const store = new PilotStore(join(dir, "pilot"));
  store.init();
  for (const bad of ["../../elsewhere", "a/b", ".hidden", ""]) {
    expect(() => store.runFile(bad, "report.txt")).toThrow(PilotDirError);
    expect(() => store.marks(bad)).toThrow(PilotDirError);
    expect(() => store.saveMarks(bad, {})).toThrow(PilotDirError);
  }
  const cli = spawnSync("bun", [join(import.meta.dir, "pilot.ts"), "report", "--run", "../../elsewhere"], {
    env: { ...process.env, EDEN_PILOT_DIR: store.dir },
    encoding: "utf8",
  });
  expect(cli.status).toBe(2);
  expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  // What the harness writes with the default mode is narrowed after the run.
  const run = store.runDir("r1");
  mkdirSync(join(run, "timeline"), { recursive: true, mode: 0o755 });
  writeFileSync(join(run, "out.json"), "{}", { mode: 0o644 });
  writeFileSync(join(run, "timeline", "tasks.jsonl"), "", { mode: 0o644 });
  store.lockRun("r1");
  expect(statSync(join(run, "out.json")).mode & 0o777).toBe(0o600);
  expect(statSync(join(run, "timeline")).mode & 0o777).toBe(0o700);
  expect(statSync(join(run, "timeline", "tasks.jsonl")).mode & 0o777).toBe(0o600);
});

test("the documented cap lets the first call through: the run's headroom scales with its cap", () => {
  expect(headroomFor(0.5)).toBeCloseTo(0.05);
  expect(headroomFor(0.1)).toBeCloseTo(0.01);
  expect(headroomFor(10)).toBe(0.25);
  // The ledger's default headroom ($0.50) refuses every call under a $0.50 cap; the run's own does not.
  expect(() => new SpendLedger(join(dir, "a.jsonl"), 0.5, "t").meter("agent").reserve(0.001)).toThrow();
  const ledger = new SpendLedger(join(dir, "b.jsonl"), 0.5, "t", headroomFor(0.5));
  expect(() => ledger.meter("agent").reserve(0.001)).not.toThrow();
});

test("a second run under one name is refused, so old marks never meet new answers", () => {
  const home = join(dir, "pilot");
  const env = { ...process.env, EDEN_PILOT_DIR: home, HAIKU_API_KEY: "not-a-real-key" };
  const store = new PilotStore(home);
  store.saveImport({ user: USER, importedAt: 1, sources: { gmail: "mail" }, counts: {} }, []);
  store.saveTasks([newTask("a", "do it", [], 1)]);
  store.write(store.runFile("pilot", "out.json"), JSON.stringify({ results: [] }));
  const args = ["run", "--model", "claude-haiku-5-5", "--cap", "0.5", "--send-to", "anthropic"];
  const cli = spawnSync("bun", [join(import.meta.dir, "pilot.ts"), ...args], { env, encoding: "utf8" });
  expect(cli.status).toBe(2);
  expect(cli.stderr).toContain("a run named pilot exists");
});

test("the report charges Eden's background cards to its arm", () => {
  const task = newTask("a", "do it", ["x"], 1);
  const one = (condition: string): RunResult =>
    ({
      task: taskId("a"),
      condition,
      answer: "ok",
      modelCalls: 1,
      toolCalls: 0,
      costUsd: 0.001,
      edenCostUsd: 0,
      wallMs: 1_000,
    }) as RunResult;
  const background = [
    { seed: 1, suite: "pilot", condition: "eden", tasks: [taskId("a")], cardsUsd: 0.004, bridgeUsd: 0, calls: 3 },
  ] as unknown as Background[];
  const r = buildReport([task], [one("tools"), one("eden")], {}, "tools", "eden", background);
  expect(r.arms.tools!.usdPerTask).toBeCloseTo(0.001);
  expect(r.arms.eden!.usdPerTask).toBeCloseTo(0.005);
  expect(r.arms.eden!.backgroundUsd).toBeCloseTo(0.004);
  expect(renderReport(r)).toContain("of it cards");
});

test("second pass: forget leaves the owner's .tmp, works through a link, and takes a directory from before the marker", async () => {
  // Only the pilot's own temporary files go.
  const store = new PilotStore(join(dir, "pilot"));
  store.saveTasks([newTask("a", "do it", [], 1)]);
  writeFileSync(join(store.dir, "notes.tmp"), "mine");
  writeFileSync(join(store.dir, "tasks.json.tmp"), "torn");
  expect(store.forget()).toBe(true);
  expect(existsSync(join(store.dir, "notes.tmp"))).toBe(true);
  expect(existsSync(join(store.dir, "tasks.json.tmp"))).toBe(false);
  // EDEN_PILOT_DIR as a link to a directory outside git: forget succeeds and removes the real directory.
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "link"));
  const linked = new PilotStore(join(dir, "link"));
  linked.saveTasks([newTask("a", "do it", [], 1)]);
  expect(linked.forget()).toBe(true);
  expect(existsSync(join(dir, "real"))).toBe(false);
  // A directory holding only pilot data and no marker (made before the marker existed) is the pilot's.
  const old = join(dir, "old");
  mkdirSync(old, { mode: 0o700 });
  writeFileSync(join(old, "items.jsonl"), "");
  const legacy = new PilotStore(old);
  legacy.saveTasks([newTask("a", "do it", [], 1)]);
  expect(existsSync(join(old, MARKER))).toBe(true);
  expect(legacy.forget()).toBe(true);
  expect(existsSync(old)).toBe(false);
  // A path that is a file is refused with a message.
  writeFileSync(join(dir, "file"), "x");
  expect(() => new PilotStore(join(dir, "file")).init()).toThrow(PilotDirError);
  // The owner-only pass does not follow a link out of the run.
  const outside = join(dir, "outside");
  mkdirSync(outside, { mode: 0o755 });
  writeFileSync(join(outside, "f"), "x", { mode: 0o644 });
  const s2 = new PilotStore(join(dir, "p2"));
  s2.init();
  mkdirSync(s2.runDir("r"), { recursive: true });
  symlinkSync(outside, join(s2.runDir("r"), "out"));
  s2.lockRun("r");
  expect(statSync(outside).mode & 0o777).toBe(0o755);
  expect(statSync(join(outside, "f")).mode & 0o777).toBe(0o644);
  // One malformed item does not stop its source's import, and the log counts what was kept.
  const odd = { id: "x", sourceId: "gmail", ref: "m0", title: undefined, text: 42 } as unknown as never;
  const good = { id: "y", sourceId: "gmail", ref: "m1", title: "Dentist", text: "Friday 9am" };
  const source: Source = { id: "gmail", kind: "test", description: "mail", search: async () => [odd, good] };
  const lines: string[] = [];
  const got = await importSources([source], SCOPE, USER, { queries: ["dentist"], log: (l) => lines.push(l) });
  expect(got.items.map((i) => [i.ref, i.title, i.text])).toEqual([
    ["m0", "", "42"],
    ["m1", "Dentist", "Friday 9am"],
  ]);
  expect(lines.join("\n")).toContain("2 items");
  expect(lines.join("\n")).not.toContain("stopped");
});
