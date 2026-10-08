/**
 * `eden memory purge <regex>` and `eden memory forget --secret <regex>` (D13, A6 §2.2.4): every file under the
 * memory root is rewritten without the match, SQLite stores with secure_delete and VACUUM, and the Claude
 * transcripts that still hold it are listed, never edited.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCli } from "./memory-import";

const SECRET = "zq-secret-4821937";

let dir = "";
let root = "";
let projects = "";
const prev = {
  dir: process.env.EDEN_MEMORY_DIR,
  home: process.env.EDEN_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-purge-"));
  root = join(dir, "memory");
  projects = join(dir, "claude", "projects");
  process.env.EDEN_MEMORY_DIR = root;
  process.env.EDEN_HOME = join(dir, "home");
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["CLAUDE_CONFIG_DIR", prev.claude],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function put(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A store as today's writers lay it out, with the secret in rows, gists, a window log, a key and a SQLite table. */
function seed(): { db: string; holding: string; clean: string } {
  put(
    join(root, "s1", "memories.jsonl"),
    [
      JSON.stringify({ id: "a", text: `The deploy token is ${SECRET}.`, kind: "fact", t: 1 }),
      JSON.stringify({ id: "b", text: "The database is postgres.", kind: "fact", t: 2 }),
    ].join("\n") + "\n",
  );
  put(join(root, "gists.jsonl"), JSON.stringify({ text: `deploys use ${SECRET}`, t: 3 }) + "\n");
  put(join(root, "windows", "s1", "delivery.log"), JSON.stringify({ k: "deliver", text: SECRET }) + "\n");
  put(join(root, "postings.json"), JSON.stringify({ [SECRET]: [1, 2], postgres: [3] }));
  put(join(root, "hook.log"), `2026-10-08 delivered ${SECRET}\n`);
  const db = join(root, "store.sqlite");
  const sqlite = new Database(db);
  sqlite.run("CREATE TABLE rows (id TEXT, body TEXT)");
  sqlite.run("INSERT INTO rows VALUES ('a', ?), ('b', 'The database is postgres.')", [`token ${SECRET}`]);
  sqlite.close();
  const holding = put(join(projects, "-repo", "s1.jsonl"), JSON.stringify({ text: `the token is ${SECRET}` }) + "\n");
  const clean = put(join(projects, "-repo", "s2.jsonl"), JSON.stringify({ text: "nothing here" }) + "\n");
  return { db, holding, clean };
}

function filesUnder(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => void lines.push(parts.join(" ")));
  try {
    return { code: await memoryCli(args), out: lines.join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("eden memory purge", () => {
  for (const args of [
    ["purge", "zq-secret-[0-9]+"],
    ["forget", "--secret", "zq-secret-[0-9]+"],
  ]) {
    test(`${args.join(" ")} leaves no match under the memory root and keeps the rest`, async () => {
      const { db, holding, clean } = seed();
      const transcript = readFileSync(holding, "utf8");
      const { code, out } = await run(args);
      expect(code).toBe(0);
      for (const path of filesUnder(root)) expect(readFileSync(path).includes(SECRET)).toBe(false);
      const rows = readFileSync(join(root, "s1", "memories.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(rows.map((line) => JSON.parse(line).id)).toEqual(["a", "b"]);
      expect(rows[1]).toContain("The database is postgres.");
      expect(JSON.parse(readFileSync(join(root, "postings.json"), "utf8")).postgres).toEqual([3]);
      const sqlite = new Database(db);
      expect(sqlite.query("SELECT id FROM rows").all()).toEqual([{ id: "b" }]);
      sqlite.close();
      // The transcript is listed for the user to decide, and left as it was.
      expect(out).toContain(holding);
      expect(out).not.toContain(clean);
      expect(readFileSync(holding, "utf8")).toBe(transcript);
    });
  }

  test("a file it cannot read is named and fails the run; every other file is still rewritten", async () => {
    seed();
    const locked = put(join(root, "a", "aaa-unreadable.jsonl"), JSON.stringify({ text: SECRET }) + "\n");
    chmodSync(locked, 0o000);
    try {
      const { code, out } = await run(["purge", "zq-secret-[0-9]+"]);
      expect(code).toBe(1);
      expect(out).toContain(locked);
      for (const path of filesUnder(root).filter((path) => path !== locked))
        expect(readFileSync(path).includes(SECRET)).toBe(false);
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  test("an invalid pattern changes nothing", async () => {
    seed();
    const before = filesUnder(root).map((path) => readFileSync(path, "utf8"));
    const { code } = await run(["purge", "zq-secret-(["]);
    expect(code).not.toBe(0);
    expect(filesUnder(root).map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });
});
