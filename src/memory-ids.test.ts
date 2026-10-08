/**
 * P0.3 (ROADMAP; A4 §1; A1 D2, D3, D6, D8): row ids are ULIDs, every row carries a per-store `seq` assigned under
 * the store lock (or waits in `pending.jsonl` for sleep) and its wall time `t`, validity survives a reload, list
 * numbers are not clocks, and ages are real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";
import { ageInWords } from "./memory-hook-packet";
import { provenanceBracket } from "./memory-provenance";
import { SemanticStore } from "./semantic-store";
import { sleep } from "./sleep";

const REPO = join(import.meta.dir, "..");
const HOOK = join(REPO, "plugins", "eden-memory", "scripts", "hook.ts");
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-09-01T09:00:00.000Z");

const dirs: string[] = [];
const saved = { now: process.env.EDEN_NOW, dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME };
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_NOW", saved.now],
    ["EDEN_MEMORY_DIR", saved.dir],
    ["EDEN_HOME", saved.home],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-ids-"));
  dirs.push(dir);
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  return join(dir, "memory");
}

type DiskRow = Record<string, unknown> & { id: string; text: string };

/** The rows of one session's store as they are on disk. */
function diskRows(root: string, session: string): DiskRow[] {
  const path = join(root, session, "memories.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? { id: parsed[0], text: parsed[1] } : parsed;
    });
}

const rowWith = (rows: DiskRow[], words: string) => rows.find((row) => row.text.includes(words));

/** One hook process, as Claude Code runs it, with `process.pid` pinned by a preload. */
function submitAs(pid: number, root: string, prompt: string): void {
  const preload = join(root, "..", `pid-${pid}.ts`);
  writeFileSync(preload, `Object.defineProperty(process, "pid", { value: ${pid}, configurable: true });\n`);
  const payload = { hook_event_name: "UserPromptSubmit", session_id: "s98", prompt, cwd: REPO, transcript_path: "" };
  const run = Bun.spawnSync(["bun", "--preload", preload, HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    env: { ...process.env, EDEN_MEMORY_DIR: root, EDEN_HOME: join(root, "..", "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
}

describe("#98, A1 D2: row ids", () => {
  test("two writer processes with the same pid % 36, one after the other, both keep their rows", () => {
    const root = tempRoot();
    submitAs(1022, root, "The build tag for module alpha is tag-alpha.");
    submitAs(1058, root, "The build tag for module beta is tag-beta.");
    const rows = diskRows(root, "s98");
    expect(rowWith(rows, "tag-alpha")).toBeDefined();
    expect(rowWith(rows, "tag-beta")).toBeDefined();
  });

  test("row ids are ULIDs, distinct, and sort in creation order", () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    const first = mem.remember("The build tag for module alpha is tag-alpha.");
    const second = mem.remember("The build tag for module beta is tag-beta.");
    mem.close();
    expect(first.id).toMatch(ULID);
    expect(second.id).toMatch(ULID);
    expect(first.id < second.id).toBe(true);
  });
});

describe("A4 §1: seq and t", () => {
  test("every persisted row carries a per-store seq, increasing across stores and processes, and its time t", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const one = openMemory({ dir: root, session: "s1" });
    one.remember("The build tag for module alpha is tag-alpha.");
    one.close();
    process.env.EDEN_NOW = String(T0 + 1_000);
    const two = openMemory({ dir: root, session: "s2" });
    two.remember("The build tag for module beta is tag-beta.");
    two.close();
    const alpha = rowWith(diskRows(root, "s1"), "tag-alpha")!;
    const beta = rowWith(diskRows(root, "s2"), "tag-beta")!;
    expect(alpha.t).toBe(T0);
    expect(beta.t).toBe(T0 + 1_000);
    expect(typeof alpha.seq).toBe("number");
    expect(beta.seq as number).toBeGreaterThan(alpha.seq as number);
  });

  test("a writer that cannot take the store lock within 50 ms leaves its rows in pending.jsonl; sleep gives them a seq", async () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() }));
    const started = performance.now();
    mem.remember("The build tag for module alpha is tag-alpha.");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rowWith(diskRows(root, "s1"), "tag-alpha")).toBeUndefined();
    expect(readFileSync(join(root, "pending.jsonl"), "utf8")).toContain("tag-alpha");
    rmSync(join(root, ".lock"));
    await sleep({ dir: root, session: "s1", mem });
    mem.close();
    expect(typeof rowWith(diskRows(root, "s1"), "tag-alpha")?.seq).toBe("number");
    expect(readFileSync(join(root, "pending.jsonl"), "utf8")).not.toContain("tag-alpha");
  });
});

describe("A1 D3: validity survives a reload", () => {
  test("a superseded value stays invalid in the next process: invalid_at is the superseding row's seq", () => {
    const root = tempRoot();
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("The auth provider is Auth0.");
    first.remember("The auth provider is Clerk.");
    first.close();
    const rows = diskRows(root, "s1");
    expect(rowWith(rows, "Auth0")?.invalid_at).toBe(rowWith(rows, "Clerk")?.seq);
    const next = openMemory({ dir: root, session: "s1" });
    const recalled = next.recall([{ role: "user", content: "which auth provider do we use?" }]).map((r) => r.text);
    next.close();
    expect(recalled.join("\n")).toContain("Clerk");
    expect(recalled.join("\n")).not.toContain("Auth0");
  });

  test("a rule's valid_until survives a reload and ends it", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("Use the staging database for the zebra tests until 2026-09-15.");
    first.close();
    expect(rowWith(diskRows(root, "s1"), "staging")?.valid_until).toBe(Date.parse("2026-09-15"));
    process.env.EDEN_NOW = String(T0 + 30 * DAY_MS);
    const later = openMemory({ dir: root, session: "s1" });
    const recalled = later.recall([{ role: "user", content: "which database for the zebra tests?" }]);
    later.close();
    expect(recalled.map((r) => r.text).join("\n")).not.toContain("staging");
  });
});

describe("A1 D8: list numbers are not clocks", () => {
  const recallIn = (root: string, cue: string) => {
    const mem = openMemory({ dir: root, session: "s1" });
    const texts = mem.recall([{ role: "user", content: cue }]).map((r) => r.text);
    mem.close();
    return texts.join("\n");
  };

  test("a later plain statement supersedes a numbered item, in the rows and in the semantic store", () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    mem.remember("1. The database is sqlite");
    mem.remember("The database is postgres.");
    mem.close();
    const recalled = recallIn(root, "what database do we use?");
    expect(recalled).toContain("postgres");
    expect(recalled).not.toContain("sqlite");
    expect(new SemanticStore(root).get("database", "is")?.o).toBe("postgres");
  });

  test("a later numbered item supersedes an earlier plain statement", () => {
    const root = tempRoot();
    const mem = openMemory({ dir: root, session: "s1" });
    mem.remember("The database is postgres.");
    mem.remember("2. The database is sqlite");
    mem.close();
    const recalled = recallIn(root, "what database do we use?");
    expect(recalled).toContain("sqlite");
    expect(recalled).not.toContain("postgres");
    expect(new SemanticStore(root).get("database", "is")?.o).toBe("sqlite");
  });
});

describe("A1 D6: real ages", () => {
  test("EDEN_NOW is the clock rows are stamped with", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const mem = openMemory({ dir: root, session: "s1" });
    expect(mem.remember("The build tag for module alpha is tag-alpha.").at).toBe(T0);
    mem.close();
  });

  test("a reloaded row keeps its time, so its age is how long ago it was said", () => {
    const root = tempRoot();
    process.env.EDEN_NOW = String(T0);
    const first = openMemory({ dir: root, session: "s1" });
    first.remember("The build tag for module alpha is tag-alpha.");
    first.close();
    process.env.EDEN_NOW = String(T0 + 3 * DAY_MS);
    const later = openMemory({ dir: root, session: "s1" });
    const row = later.memories().find((r) => r.text.includes("tag-alpha"))!;
    later.close();
    expect(row.at).toBe(T0);
    expect(ageInWords(row.at, T0 + 3 * DAY_MS)).toBe("3 days ago");
  });

  test("a row without a time claims no age", () => {
    expect(provenanceBracket({ text: "The database is postgres.", kind: "fact" }, "fact")).toBe("[fact · user]");
  });
});
