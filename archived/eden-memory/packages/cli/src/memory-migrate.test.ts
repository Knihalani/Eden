/**
 * `eden memory migrate` (EXECUTION §9, A6 §4), run as the user runs it: the mapping, what a legacy row becomes, the
 * swap and its crash points, rollback with rows written since, and the contract step's 30 days.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readInvalidations, validText } from "../../../src/memory-validity";
import { legacyTree, migrationStage, repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";

const CLI = join(import.meta.dir, "cli.ts");
const DAY = 86_400_000;
const T0 = Date.parse("2026-09-20T10:00:00Z");
/** A synthetic npm token, built so no literal secret is committed. */
const TOKEN = `npm_${"a1B2c3D4e5F6".repeat(3)}`;

let dir = "";
let root = "";
let eden = "";
let app = "";
let worktree = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, now: process.env.EDEN_NOW };

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function jsonl(path: string, rows: unknown[], tail = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join("") + tail);
}

/** A transcript whose first line records where and when the session ran. */
function transcript(session: string, cwd: string, at: number): void {
  const line = { type: "user", sessionId: session, cwd, timestamp: new Date(at).toISOString() };
  jsonl(join(dir, "claude", "projects", "project", `${session}.jsonl`), [line]);
}

/**
 * The stores a pre-P0.5 plugin left: a main-checkout session (mapped by R-7's snapshot) with a rule, a superseded
 * row, a secret and a corrupt last line; its subagent's store; a worktree session mapped by its transcript; a
 * session whose directory is gone; one with neither a snapshot entry nor a transcript.
 */
function legacyStores(): void {
  jsonl(
    join(root, "s-main", "memories.jsonl"),
    [
      { id: "d1", text: "The database is postgres", ep: "e-main" },
      { id: "h1", text: "Never merge PRs yourself", kind: "constraint", tags: ["never", "merge"] },
      { id: "x1", text: "The cache is memcached", invalid_at: 3 },
      { id: "k1", text: `For staging the npm credential is ${TOKEN}` },
    ],
    '{"id":"c1","text":"The trunca',
  );
  jsonl(join(root, "s-main--agent-1", "memories.jsonl"), [{ id: "a1", text: "The queue is called hermes" }]);
  jsonl(join(root, "s-worktree", "memories.jsonl"), [{ id: "t1", text: "The auth provider is Clerk", t: T0 }]);
  jsonl(join(root, "s-gone", "memories.jsonl"), [{ id: "g1", text: "The staging server is called orbit" }]);
  jsonl(join(root, "s-none", "memories.jsonl"), [{ id: "n1", text: "Releases are tagged on Fridays" }]);
  jsonl(join(root, "memories.jsonl"), [{ id: "w1", text: "The wrap wrote this without a session" }]);
  jsonl(join(root, "gists.jsonl"), [{ text: "database is postgres", session: "e-main", t: T0, kind: "session" }]);
  jsonl(join(root, "validity.jsonl"), [{ k: "retract", o: "redis", t: T0 - DAY }]);
  transcript("s-worktree", worktree, T0 - DAY);
  transcript("s-main", app, T0 - 2 * DAY);
  mkdirSync(join(eden, "migrate"), { recursive: true });
  writeFileSync(
    join(eden, "migrate", "session-map.json"),
    JSON.stringify({ "s-main": app, "s-gone": join(dir, "deleted-scratch") }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-migrate-"));
  eden = join(dir, "eden");
  root = join(eden, "memory");
  app = join(dir, "app");
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "src", "index.ts"), "export {};\n");
  git(app, "init", "-q", "-b", "main");
  git(app, "add", "-A");
  git(app, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  worktree = join(app, ".claude", "worktrees", "agent-x");
  git(app, "worktree", "add", "-q", "-b", "agent-x", worktree);
  process.env.EDEN_MEMORY_DIR = root;
  process.env.EDEN_HOME = eden;
  process.env.EDEN_NOW = String(T0);
  legacyStores();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_NOW", prev.now],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function migrate(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const run = Bun.spawnSync(["bun", CLI, "memory", "migrate", ...args], {
    env: {
      ...process.env,
      HOME: dir,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      EDEN_HOME: eden,
      EDEN_MEMORY_DIR: root,
      EDEN_NOW: String(T0),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode, out: run.stdout.toString() };
}

/** Every file under `path` with its sha256, by relative path; `skip` drops paths that may change. */
function snapshot(path: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const files = existsSync(path) ? readdirSync(path, { recursive: true, withFileTypes: true }) : [];
  return Object.fromEntries(
    files
      .filter((entry) => entry.isFile())
      .map((entry) => relative(path, join(entry.parentPath, entry.name)))
      .filter((rel) => !skip(rel))
      .sort()
      .map((rel) => [
        rel,
        createHash("sha256")
          .update(readFileSync(join(path, rel)))
          .digest("hex"),
      ]),
  );
}

const key = () => repoIdentity(app)!.key;
const store = () => repoStoreDir(root, key());

function storeRows(): Record<string, unknown>[] {
  return readFileSync(join(store(), "memories.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("eden memory migrate --dry-run", () => {
  test("maps each session through R-7's snapshot or its transcript, names the unmappable, writes nothing", () => {
    // A store directory of the old root that is no session's.
    jsonl(join(root, "experience", "index.jsonl"), [{ id: "x" }]);
    const before = snapshot(eden);
    const { code, out } = migrate(["--dry-run", "--json"]);
    expect(code).toBe(0);
    const plan = JSON.parse(out) as {
      steps: string[];
      sessions: { session: string; repo: string | null; via?: string }[];
      unmappable: string[];
      rows: Record<string, number>;
    };
    expect(plan.steps).toEqual(["backup", "stage", "verify", "swap"]);
    const by = Object.fromEntries(plan.sessions.map((row) => [row.session, row]));
    expect(by["s-main"]).toMatchObject({ repo: key(), via: "session-map" });
    expect(by["s-main--agent-1"]).toMatchObject({ repo: key(), via: "session-map" });
    expect(by["s-worktree"]).toMatchObject({ repo: key(), via: "transcript" });
    expect(plan.unmappable.sort()).toEqual(["(root)", "s-gone", "s-none"]);
    // The rule is left empty once its instruction is dropped (A6 §2.3).
    expect(plan.rows).toEqual({ in: 7, out: 4, corrupt: 1, superseded: 1, empty: 1, redacted: 1 });
    expect(snapshot(eden)).toEqual(before);
  });
});

describe("eden memory migrate --apply", () => {
  test("legacy rows become sanitized episodes in their repo's store; the old tree is kept read-only and backed up", () => {
    const { code } = migrate(["--apply"]);
    expect(code).toBe(0);
    const rows = storeRows();
    const texts = rows.map((row) => row.text);
    expect(texts).toContain("The database is postgres");
    expect(texts).toContain("The auth provider is Clerk");
    expect(texts).toContain("The queue is called hermes");
    // A6 §2.1: an episode only, its rule's instruction dropped, its secret redacted; a superseded value stays history.
    expect(texts.join("\n")).not.toMatch(/Never merge|memcached|staging server|Fridays/);
    expect(texts.join("\n")).not.toContain(TOKEN);
    for (const row of rows) {
      expect(String(row.id)).toMatch(/^legacy:[0-9a-f]{24}$/);
      expect(row).toMatchObject({ kind: "episode", tags: ["src:legacy"] });
    }
    // A row without a time takes its session's first transcript time; one with a time keeps it.
    expect(rows.find((row) => row.text === "The database is postgres")?.t).toBe(T0 - 2 * DAY);
    expect(rows.find((row) => row.text === "The auth provider is Clerk")?.t).toBe(T0);
    expect(readFileSync(join(store(), "validity.jsonl"), "utf8")).toContain('"o":"redis"');
    expect(JSON.parse(readFileSync(join(store(), "format.json"), "utf8"))).toEqual({ major: 2 });
    const legacy = legacyTree(root);
    expect(statSync(join(legacy, "s-main", "memories.jsonl")).mode & 0o777).toBe(0o400);
    const tars = readdirSync(join(eden, "migrate")).filter((name) => name.endsWith(".tar"));
    expect(tars).toEqual([`memory-v1-${T0}.tar`]);
    expect(statSync(join(eden, "migrate", tars[0]!)).mode & 0o777).toBe(0o600);
    expect(existsSync(migrationStage(root))).toBe(false);
  });

  test("a staged tree left beside a migrated root is reported, not passed over as applied", () => {
    migrate(["--apply"]);
    mkdirSync(migrationStage(root));
    const { code, out } = migrate(["--apply"]);
    expect(code).toBe(1);
    expect(out).toContain("a staged tree is left");
  });

  test("a second --apply changes nothing", () => {
    migrate(["--apply"]);
    const after = snapshot(eden);
    expect(migrate(["--apply"]).out).toContain("already applied");
    expect(snapshot(eden)).toEqual(after);
  });

  test("a crash after any step leaves the old tree or the new one", () => {
    const old = snapshot(root);
    migrate(["--apply"]);
    const applied = snapshot(eden, (rel) => rel.endsWith(".tar"));
    for (const step of ["backup", "stage", "verify", "swap"]) {
      rmSync(eden, { recursive: true, force: true });
      legacyStores();
      expect(migrate(["--apply"], { EDEN_MIGRATE_CRASH_AFTER: step }).code).toBe(137);
      const state = snapshot(eden, (rel) => rel.endsWith(".tar"));
      const unchanged = !existsSync(legacyTree(root)) && JSON.stringify(snapshot(root)) === JSON.stringify(old);
      expect(unchanged || JSON.stringify(state) === JSON.stringify(applied)).toBe(true);
    }
  });

  test("an interrupted swap (the old tree moved, the new one still staged) is finished by the next --apply", () => {
    migrate(["--apply"]);
    const applied = snapshot(root);
    renameSync(root, migrationStage(root));
    const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: app, prompt: "hi" });
    expect(out).toBeNull();
    expect(existsSync(root)).toBe(false);
    expect(migrate(["--apply"]).out).toContain("finished an interrupted swap");
    expect(snapshot(root)).toEqual(applied);
  });

  test("slot values the legacy sessions disagree on: the older is logged stale from the newer one's time", () => {
    jsonl(join(root, "s-worktree", "memories.jsonl"), [{ id: "t2", text: "The database is sqlite", t: T0 }]);
    migrate(["--apply"]);
    const invalid = readInvalidations(store());
    const rows = storeRows();
    const at = (text: string) => rows.find((row) => row.text === text)?.t;
    expect(validText("The database is postgres", at("The database is postgres"), invalid)).toBe("");
    expect(validText("The database is sqlite", at("The database is sqlite"), invalid)).toBe("The database is sqlite");
  });
});

describe("eden memory migrate --rollback", () => {
  test("restores the old tree byte for byte", () => {
    const old = snapshot(root);
    migrate(["--apply"]);
    expect(migrate(["--rollback"]).code).toBe(0);
    expect(snapshot(root)).toEqual(old);
    expect(existsSync(legacyTree(root))).toBe(false);
  });

  test("takes back the validity records the migration added, with the legacy rows", () => {
    jsonl(join(root, "s-worktree", "memories.jsonl"), [{ id: "t2", text: "The database is sqlite", t: T0 }]);
    migrate(["--apply"]);
    expect(readFileSync(join(store(), "validity.jsonl"), "utf8")).toContain('"src":"legacy"');
    memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-new",
      cwd: app,
      prompt: "We no longer use Kafka.",
    });
    expect(migrate(["--rollback"]).code).toBe(0);
    const validity = readFileSync(join(store(), "validity.jsonl"), "utf8");
    expect(validity).toContain("kafka");
    expect(validity).not.toContain('"src":"legacy"');
  });

  test("keeps what was written since the swap, without the legacy rows", () => {
    migrate(["--apply"]);
    memoryHookResponse({
      hook_event_name: "UserPromptSubmit",
      session_id: "s-new",
      cwd: app,
      prompt: "The CI is buildkite.",
    });
    expect(migrate(["--rollback"]).code).toBe(0);
    const rows = readFileSync(join(store(), "memories.jsonl"), "utf8");
    expect(rows).toContain("The CI is buildkite");
    expect(rows).not.toContain("legacy:");
    expect(readFileSync(join(root, "s-main", "memories.jsonl"), "utf8")).toContain("The database is postgres");
  });
});

describe("eden memory migrate --contract", () => {
  test("waits 30 days after the backup, then asks for --yes, then deletes the legacy tree and the backups", () => {
    migrate(["--apply"]);
    const at = (days: number) => ({ EDEN_NOW: String(T0 + days * DAY) });
    expect(migrate(["--contract", "--yes"], at(29))).toMatchObject({ code: 1 });
    expect(migrate(["--contract"], at(31)).out).toContain("--yes");
    expect(existsSync(legacyTree(root))).toBe(true);
    expect(migrate(["--contract", "--yes"], at(31)).code).toBe(0);
    expect(existsSync(legacyTree(root))).toBe(false);
    expect(readdirSync(join(eden, "migrate")).filter((name) => name.endsWith(".tar"))).toEqual([]);
  });
});
