/** P0.6: the delta encoder (A4 §3.3): each line once, its turn and time, and rewinds found by `parentUuid`. */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { abandonedPrompts, encodeDelta, TURN_MAP_LINES, type Delta } from "./memory-delta";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-delta-"));
  dirs.push(dir);
  return dir;
}

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (second: number) => new Date(T0 + second * 1000).toISOString();

type Line = Record<string, unknown>;
const typed = (uuid: string, parentUuid: string | null, promptId: string, text: string, second = 0): Line => ({
  parentUuid,
  isSidechain: false,
  promptId,
  type: "user",
  message: { role: "user", content: text },
  uuid,
  timestamp: at(second),
  origin: { kind: "human" },
  promptSource: "typed",
});
const said = (uuid: string, parentUuid: string, text: string, second = 0): Line => ({
  parentUuid,
  isSidechain: false,
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  uuid,
  timestamp: at(second),
});
const toolResult = (uuid: string, parentUuid: string, promptId: string, text: string): Line => ({
  parentUuid,
  isSidechain: false,
  promptId,
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] },
  uuid,
  timestamp: at(9),
});
const jsonl = (lines: readonly Line[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

/** A window and its transcript, with the lines written so far. */
function setup(lines: readonly Line[] = []): { win: string; path: string } {
  const root = tempDir();
  const path = join(root, "t.jsonl");
  writeFileSync(path, jsonl(lines));
  return { win: join(root, "win"), path };
}

/** One delta, as an encoder would receive it. */
function read(win: string, path: string): Delta {
  let seen: Delta = { messages: [], abandoned: [], branchTexts: [] };
  const delta = encodeDelta(win, path, (d) => (seen = d));
  expect(delta).toBeDefined();
  return seen;
}

const contents = (delta: Delta) => delta.messages.map((message) => message.content);

describe("A4 §3.3: each complete line once, from the mark", () => {
  test("a partial last line waits for its newline; a second read starts where the first stopped", () => {
    const { win, path } = setup([typed("u1", null, "p1", "first"), said("a1", "u1", "One.")]);
    appendFileSync(path, JSON.stringify(said("a2", "a1", "Two.")).slice(0, 20));
    expect(contents(read(win, path))).toEqual(["One."]);
    appendFileSync(path, `${JSON.stringify(said("a2", "a1", "Two.")).slice(20)}\n`);
    expect(contents(read(win, path))).toEqual(["Two."]);
    expect(contents(read(win, path))).toEqual([]);
    const mark = JSON.parse(readFileSync(join(win, "hwm.json"), "utf8")) as { off: number };
    expect(mark.off).toBe(readFileSync(path).length);
  });

  test("typed prompts are not encoded (the Submit payload carries them); agent text and tool results are", () => {
    const { win, path } = setup([
      typed("u1", null, "p1", "The database is postgres.", 1),
      said("a1", "u1", "Noted: postgres.", 2),
      toolResult("r1", "a1", "p1", "config.ts: db = postgres"),
    ]);
    const delta = read(win, path);
    expect(delta.messages).toEqual([
      { role: "assistant", content: "Noted: postgres.", src: "agent", at: T0 + 2000, uuid: "a1", promptId: "p1" },
      { role: "user", content: "config.ts: db = postgres", src: "tool", at: T0 + 9000, uuid: "r1", promptId: "p1" },
    ]);
    expect(delta.branchTexts).toContain("The database is postgres.");
  });

  test("a window with no mark starts at its transcript's last 256 KB", () => {
    const old = Array.from({ length: 400 }, (_, i) =>
      said(`o${i}`, i ? `o${i - 1}` : "u0", `old ${i} ${"x".repeat(900)}`),
    );
    const { win, path } = setup([typed("u0", null, "p0", "start"), ...old, said("n1", "o399", "Newest.")]);
    const delta = read(win, path);
    expect(contents(delta)).toContain("Newest.");
    expect(contents(delta)).not.toContain(`old 0 ${"x".repeat(900)}`);
    expect(delta.messages.length).toBeLessThan(300);
  });

  test("a read that finds nothing new leaves the mark as it is", () => {
    const { win, path } = setup([typed("u1", null, "p1", "first"), said("a1", "u1", "One.")]);
    read(win, path);
    const before = statSync(join(win, "hwm.json")).mtimeMs;
    Bun.sleepSync(20);
    expect(read(win, path).messages).toEqual([]);
    expect(statSync(join(win, "hwm.json")).mtimeMs).toBe(before);
  });

  test("a delta whose encoder throws is still marked read: one bad line cannot stall the window", () => {
    const { win, path } = setup([typed("u1", null, "p1", "first"), said("a1", "u1", "One.")]);
    encodeDelta(win, path, () => {
      throw new Error("boom");
    });
    expect(contents(read(win, path))).toEqual([]);
  });

  test("another hook holding the mark's lock leaves the delta to it", () => {
    const { win, path } = setup([typed("u1", null, "p1", "first"), said("a1", "u1", "One.")]);
    read(win, path);
    appendFileSync(path, jsonl([said("a2", "a1", "Two.")]));
    const holder = { pid: process.pid, host: hostname(), ts: Date.now() };
    writeFileSync(join(win, "hwm.lock"), JSON.stringify(holder));
    expect(encodeDelta(win, path, () => {})).toBeUndefined();
    rmSync(join(win, "hwm.lock"));
    expect(contents(read(win, path))).toEqual(["Two."]);
  });

  test(`the turn map keeps the last ${TURN_MAP_LINES} lines`, () => {
    const lines = [typed("u0", null, "p0", "start")];
    for (let i = 0; i < TURN_MAP_LINES + 100; i++) lines.push(said(`a${i}`, i ? `a${i - 1}` : "u0", "."));
    const { win, path } = setup(lines.slice(0, 2));
    read(win, path);
    appendFileSync(path, jsonl(lines.slice(2)));
    read(win, path);
    const mark = JSON.parse(readFileSync(join(win, "hwm.json"), "utf8")) as { lines: unknown[] };
    expect(mark.lines).toHaveLength(TURN_MAP_LINES);
  });
});

describe("A4 §3.3: rewind detection", () => {
  test("a typed prompt whose parent turn is not the newest prompt abandons the prompts back to that turn", () => {
    const { win, path } = setup([
      typed("u1", null, "p1", "first", 1),
      said("a1", "u1", "One.", 2),
      typed("u2", "a1", "p2", "second", 3),
      said("a2", "u2", "Two.", 4),
      typed("u3", "a2", "p3", "third", 5),
      said("a3", "u3", "Three.", 6),
    ]);
    expect(read(win, path).abandoned).toEqual([]);
    // The user rewinds to the second prompt: the new prompt's parent is the second prompt's parent.
    appendFileSync(path, jsonl([typed("u4", "a1", "p4", "second, again", 7)]));
    expect(read(win, path).abandoned).toEqual(["p3", "p2"]);
    expect([...abandonedPrompts(win)].sort()).toEqual(["p2", "p3"]);
  });

  test("a rewind to the first prompt abandons every prompt", () => {
    const { win, path } = setup([
      typed("u1", null, "p1", "first"),
      said("a1", "u1", "One."),
      typed("u2", "a1", "p2", "x"),
    ]);
    appendFileSync(path, jsonl([typed("u3", null, "p3", "first, again")]));
    expect(read(win, path).abandoned).toEqual(["p2", "p1"]);
  });

  test("an abandoned turn's lines in the same delta are neither encoded nor said on the current branch", () => {
    const { win, path } = setup([
      typed("u1", null, "p1", "first"),
      said("a1", "u1", "One."),
      typed("u2", "a1", "p2", "The test runner is jest."),
      said("a2", "u2", "Jest it is."),
      typed("u3", "a1", "p3", "The database is sqlite."),
      said("a3", "u3", "Sqlite it is."),
    ]);
    const delta = read(win, path);
    expect(delta.abandoned).toEqual(["p2"]);
    expect(contents(delta)).toEqual(["One.", "Sqlite it is."]);
    expect(delta.branchTexts).not.toContain("The test runner is jest.");
    expect(delta.branchTexts).toContain("The database is sqlite.");
  });

  test("a compaction's boundary (no parentUuid, a logicalParentUuid) is not a branch point", () => {
    const boundary = {
      parentUuid: null,
      logicalParentUuid: "a1",
      type: "system",
      subtype: "compact_boundary",
      uuid: "b1",
    };
    const summary = {
      parentUuid: "b1",
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "S" },
      uuid: "s1",
    };
    const { win, path } = setup([typed("u1", null, "p1", "first"), said("a1", "u1", "One."), boundary, summary]);
    read(win, path);
    appendFileSync(path, jsonl([typed("u2", "s1", "p2", "after the compaction")]));
    expect(read(win, path).abandoned).toEqual([]);
  });

  test("a parent outside the map abandons nothing: one missed re-injection beats a repeat every turn", () => {
    const { win, path } = setup([typed("u1", null, "p1", "first"), said("a1", "u1", "One.")]);
    read(win, path);
    appendFileSync(path, jsonl([typed("u2", "not-in-the-map", "p2", "second")]));
    expect(read(win, path).abandoned).toEqual([]);
    expect(abandonedPrompts(win).size).toBe(0);
  });
});
