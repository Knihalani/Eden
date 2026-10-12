/**
 * P3.1 at the hook and the CLI (D3, A4 §2, A6 §3): the scope catalog is built when a turn ends with none, rebuilt
 * after a batch writes a manifest (or a file into a directory that held only its manifest) and at the idle sleep, read
 * by `eden memory remember` for each row's scope, by `eden memory forget --all-in <scope>` and by `eden doctor`, and
 * answered by `eden memory scopes`. Every step fails open, and with memory off or read-only nothing is written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storeRows } from "../../../src/index";
import { readRuleIndex } from "../../../src/memory-rule-index";
import { readCatalog } from "../../../src/memory-scopes";
import { repoKeyOf, storeFor } from "../../../src/memory-repo";
import { scopeCatalogCheck } from "./doctor-memory";
import { memoryHookResponse } from "./memory-hook";
import { sleepStore } from "./memory-sleep";

const CLI = join(import.meta.dir, "cli.ts");
let dir = "";
let root = "";
let top = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, memory: process.env.EDEN_MEMORY };

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function put(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

const pkg = (name: string, more: Record<string, unknown> = {}) => JSON.stringify({ name, ...more });

/** A workspace repo with one package, `packages/a`, committed. */
function workspace(name: string): string {
  const at = join(dir, name);
  put(at, {
    "package.json": pkg(name, { workspaces: ["packages/*"] }),
    "packages/a/package.json": pkg("a"),
    "packages/a/i.js": "",
  });
  git(at, "init", "-q", "-b", "main");
  git(at, "add", "-A");
  git(at, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  return at;
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-scope-catalog-")));
  root = join(dir, "memory");
  process.env.EDEN_MEMORY_DIR = root;
  process.env.EDEN_HOME = join(dir, "home");
  delete process.env.EDEN_MEMORY;
  top = workspace("repo");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_MEMORY", prev.memory],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const store = () => storeFor(root, top);
const catalogPath = () => join(store(), "scopes.json");

function stop(session = "s1"): void {
  memoryHookResponse({ hook_event_name: "Stop", session_id: session, cwd: top }, "stop-sleep");
}

function batch(calls: { tool: string; path: string }[], session = "s1"): void {
  memoryHookResponse({
    hook_event_name: "PostToolBatch",
    session_id: session,
    cwd: top,
    tool_calls: calls.map(({ tool, path }) => ({
      tool_name: tool,
      tool_input: { file_path: path },
      tool_response: "ok",
    })),
  });
}

function cli(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  const run = spawnSync("bun", [CLI, ...args], {
    cwd: opts.cwd ?? top,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...process.env, EDEN_MEMORY_DIR: root, EDEN_HOME: join(dir, "home"), ...opts.env },
  });
  return { code: run.status, out: run.stdout.trim() };
}

describe("the catalog at the hook", () => {
  test("a turn's end builds the catalog when the repo has none, and leaves one it has", () => {
    expect(existsSync(catalogPath())).toBe(false);
    stop();
    const built = readCatalog(store())!;
    expect(built.scopes).toEqual(["", "packages/a"]);
    expect(built.checkout).toBe(top);
    stop("s2");
    expect(readCatalog(store())!.built).toBe(built.built);
  });

  test("a batch writing a manifest rebuilds it; a new package waits for its second file", () => {
    stop();
    put(top, { "packages/b/package.json": pkg("b") });
    batch([{ tool: "Write", path: join(top, "packages/b/package.json") }]);
    expect(readCatalog(store())).toMatchObject({ scopes: ["", "packages/a"], waiting: ["packages/b"] });
    put(top, { "packages/b/index.ts": "" });
    batch([{ tool: "Write", path: join(top, "packages/b/index.ts") }]);
    expect(readCatalog(store())!.scopes).toEqual(["", "packages/a", "packages/b"]);
  });

  test("a batch that writes no manifest, reads one, or writes another repo's, rebuilds nothing", () => {
    stop();
    const before = readFileSync(catalogPath(), "utf8");
    const other = workspace("other");
    put(top, { "packages/c/package.json": pkg("c"), "packages/c/i.js": "" });
    batch([
      { tool: "Edit", path: join(top, "packages/a/i.js") },
      { tool: "Read", path: join(top, "packages/c/package.json") },
      { tool: "Write", path: join(other, "packages/a/package.json") },
    ]);
    expect(readFileSync(catalogPath(), "utf8")).toBe(before);
    expect(existsSync(join(storeFor(root, other), "scopes.json"))).toBe(false);
  });

  test("an Edit of the .eden/scopes override rebuilds", () => {
    stop();
    put(top, { ".eden/scopes": "tools/*\n", "tools/x/run.sh": "" });
    batch([{ tool: "Edit", path: join(top, ".eden/scopes") }]);
    expect(readCatalog(store())!.scopes).toEqual(["", "packages/a", "tools/x"]);
  });

  test("with memory read-only or off, nothing is built", () => {
    for (const mode of ["readonly", "off"]) {
      process.env.EDEN_MEMORY = mode;
      stop();
      batch([{ tool: "Write", path: join(top, "packages/a/package.json") }]);
      expect(existsSync(catalogPath())).toBe(false);
    }
  });

  test("a catalog that cannot be written fails open: the turn's other steps still run", () => {
    mkdirSync(catalogPath(), { recursive: true });
    expect(() => stop()).not.toThrow();
    expect(() => batch([{ tool: "Write", path: join(top, "package.json") }])).not.toThrow();
    expect(statSync(catalogPath()).isDirectory()).toBe(true);
    expect(existsSync(join(root, "windows", "s1", "ctx.log"))).toBe(true);
  });
});

describe("the idle sleep (D34)", () => {
  test("rebuilds the catalog from the checkout it was built from", () => {
    stop();
    put(top, { "packages/b/package.json": pkg("b"), "packages/b/i.js": "" });
    sleepStore(store(), "s1");
    expect(readCatalog(store())!.scopes).toEqual(["", "packages/a", "packages/b"]);
  });

  test("leaves a catalog whose checkout is another repo's, or gone", () => {
    stop();
    const other = workspace("other");
    put(other, { "packages/z/package.json": pkg("z"), "packages/z/i.js": "" });
    const recorded = { ...readCatalog(store())!, checkout: other };
    writeFileSync(catalogPath(), JSON.stringify(recorded));
    sleepStore(store(), "s1");
    expect(readCatalog(store())).toEqual(recorded);
    const repoStore = store();
    stop();
    const kept = readFileSync(catalogPath(), "utf8");
    rmSync(top, { recursive: true, force: true });
    sleepStore(repoStore, "s1");
    expect(readFileSync(join(repoStore, "scopes.json"), "utf8")).toBe(kept);
  });
});

describe("eden memory scopes", () => {
  test("--json answers the arm's contract: the repo's scopes, and each path's repo and scope", () => {
    const other = workspace("other");
    const { code, out } = cli([
      "memory",
      "scopes",
      "--json",
      "packages/a/i.js",
      "README.md",
      `${other}/packages/a/i.js`,
    ]);
    expect(code).toBe(0);
    const key = repoKeyOf(join(top, ".git"));
    expect(JSON.parse(out)).toEqual({
      scopes: ["", "packages/a"],
      of: {
        "packages/a/i.js": { repo: key, scope: "packages/a" },
        "README.md": { repo: key, scope: "" },
        [`${other}/packages/a/i.js`]: { repo: repoKeyOf(join(other, ".git")), scope: "packages/a" },
      },
    });
    expect(readCatalog(store())!.scopes).toEqual(["", "packages/a"]);
  });

  test("a path is relative to the folder the command runs in; outside git every scope is the root", () => {
    const inPackage = cli(["memory", "scopes", "--json", "i.js", "."], { cwd: join(top, "packages/a") });
    expect(JSON.parse(inPackage.out).of).toMatchObject({
      "i.js": { scope: "packages/a" },
      ".": { scope: "packages/a" },
    });
    mkdirSync(join(dir, "plain"));
    const plain = JSON.parse(cli(["memory", "scopes", "--json", "x.txt"], { cwd: join(dir, "plain") }).out);
    expect(plain).toEqual({ scopes: [""], of: { "x.txt": { repo: repoKeyOf(join(dir, "plain")), scope: "" } } });
  });

  test("without --json it lists the scopes; with memory off it answers but stores nothing", () => {
    const listed = cli(["memory", "scopes"], { env: { EDEN_MEMORY: "off" } });
    expect(listed.code).toBe(0);
    expect(listed.out.split("\n")).toEqual(expect.arrayContaining(['""', "packages/a"]));
    expect(existsSync(catalogPath())).toBe(false);
  });
});

describe("eden memory remember stores each row's scope", () => {
  test("a scope given, a path in a scope, the folder it runs in; the root and an unknown scope store none", () => {
    const lines = [
      { text: "The a package logs to stderr.", cwd: top, scope: "packages/a" },
      { text: "The a package has no tests.", cwd: top, scope: "packages/a/src" },
      { text: "The a package is ESM.", cwd: join(top, "packages/a") },
      { text: "The repo uses bun.", cwd: top },
      { text: "The docs are in markdown.", cwd: top, scope: "docs/guide" },
    ];
    const { out } = cli(["memory", "remember", "--jsonl", "-"], {
      input: lines.map((l) => JSON.stringify(l)).join("\n"),
    });
    expect(JSON.parse(out)).toEqual({ remembered: 5 });
    const scopes = storeRows(join(store(), "memories.jsonl")).map((row) => [row.text, row.scope]);
    expect(scopes).toEqual([
      ["The a package logs to stderr.", "packages/a"],
      ["The a package has no tests.", "packages/a"],
      ["The a package is ESM.", "packages/a"],
      ["The repo uses bun.", undefined],
      ["The docs are in markdown.", undefined],
    ]);
    const disk = readFileSync(join(store(), "memories.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(disk.filter((line) => line.includes('"scope"')).length).toBe(3);
  });
});

describe("eden memory forget --all-in <scope> (A6 §3)", () => {
  function plant(): void {
    const lines = [
      { text: "Never merge pull requests yourself.", cwd: top, scope: "packages/a" },
      { text: "We use pnpm in this package.", cwd: top, scope: "packages/a" },
      { text: "Never force-push to main.", cwd: top },
    ];
    cli(["memory", "remember", "--jsonl", "-"], { input: lines.map((l) => JSON.stringify(l)).join("\n") });
  }

  test("invalidates every keyed row of that scope, and only those", () => {
    plant();
    const { code, out } = cli(["memory", "forget", "--all-in", "packages/a"]);
    expect([code, out]).toEqual([0, "forgot 1 keyed row in packages/a"]);
    const rows = storeRows(join(store(), "memories.jsonl"));
    const gone = (text: string) => rows.find((row) => row.text === text)?.invalidAt !== undefined;
    expect(gone("Never merge pull requests yourself.")).toBe(true);
    expect(gone("We use pnpm in this package.")).toBe(false);
    expect(gone("Never force-push to main.")).toBe(false);
    expect(readRuleIndex(store()).map((row) => row.text)).toEqual(["Never force-push to main."]);
  });

  test("a name that is no scope changes nothing and lists the scopes", () => {
    plant();
    const { code, out } = cli(["memory", "forget", "--all-in", "packages"]);
    expect(code).toBe(2);
    expect(out).toContain("packages is not a scope of this repo");
    expect(out).toContain("packages/a");
    expect(readRuleIndex(store()).length).toBe(2);
  });

  test("forget --secret still purges", () => {
    expect(cli(["memory", "forget", "--secret", "nothing-matches-this"]).code).toBe(0);
  });
});

describe("eden doctor --memory: the scope catalog line", () => {
  test("names the scope count and when it was built, or that none is built yet", () => {
    expect(scopeCatalogCheck(root, top)).toMatchObject({ name: "scope catalog", ok: true });
    expect(scopeCatalogCheck(root, top).detail).toContain("none built yet");
    stop();
    expect(scopeCatalogCheck(root, top).detail).toMatch(/^2 scopes · built \d{4}-\d\d-\d\dT[\d:.]+Z from /);
    mkdirSync(join(dir, "plain"));
    expect(scopeCatalogCheck(root, join(dir, "plain")).detail).toBe("outside git: one scope");
  });
});
