import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_AGE_MS } from "./test-cache";

/** A small repository of its own: the cache under test reads it through EDEN_TEST_CACHE_ROOT. */
const repo = mkdtempSync(join(tmpdir(), "eden-test-cache-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd: repo, encoding: "utf8", env: { ...process.env, EDEN_TEST_CACHE_ROOT: repo, ...env } });
const cache = (args: string[], env: Record<string, string> = {}) =>
  sh("bun", [join(import.meta.dir, "test-cache.ts"), ...args], env);
const key = (t: string, env: Record<string, string> = {}) =>
  /key ([0-9a-f]{40})/.exec(cache(["why", t], env).stdout)![1]!;
const state = join(repo, ".git", "state.json");
const plan = (...tests: string[]) => cache(["plan", state, ...tests]);
const junit = (suites: Array<[file: string, tests: number, failures: number]>) => {
  const body = suites
    .map(
      ([f, t, x]) =>
        `<testsuite name="${f}" file="${f}" tests="${t}" assertions="1" failures="${x}" skipped="0" time="0.1">\n` +
        `<testsuite name="${f}" file="${f}" line="3" tests="${t}" assertions="1" failures="0" time="0.1"></testsuite>\n` +
        `</testsuite>`,
    )
    .join("\n");
  writeFileSync(join(repo, ".git", "junit.xml"), `<testsuites name="bun test">\n${body}\n</testsuites>\n`);
  return join(repo, ".git", "junit.xml");
};

sh("git", ["init", "-q"]);
write("bun.lock", "lock 1\n");
write("lib/a.ts", `import { b } from "./b";\nexport const a = b + 1;\n`);
write("lib/b.ts", `export const b = 1;\n`);
write("lib/other.ts", `export const other = 1;\n`);
write("lib/worker.ts", `postMessage(1);\n`);
write(
  "lib/pure.test.ts",
  `import { a } from "./a";\n// docs/NOTES.md and import.meta.dir are only named here\ntest("a", () => a);\n`,
);
write("lib/url.test.ts", `const w = new URL("./worker.ts", import.meta.url);\ntest("w", () => w);\n`);
write("lib/spawn.test.ts", `import { spawnSync } from "node:child_process";\ntest("s", () => spawnSync("true"));\n`);
write("lib/where.test.ts", `import { join } from "node:path";\nconst d = join(import.meta.dir, "..", "docs");\n`);
write("lib/named.test.ts", `import { readFileSync } from "node:fs";\nreadFileSync("docs/NOTES.md");\n`);
write("docs/NOTES.md", "notes\n");
write("README.md", "readme\n");

describe("a test file's key (D650)", () => {
  test("changes with the file and what it imports, transitively; not with a file it cannot reach, nor with prose", () => {
    const k0 = key("lib/pure.test.ts");
    expect(key("lib/pure.test.ts")).toBe(k0);
    write("lib/other.ts", `export const other = 2;\n`);
    write("docs/NOTES.md", "notes 2\n");
    write("lib/new-file.ts", "export {};\n");
    expect(key("lib/pure.test.ts")).toBe(k0);
    write("lib/b.ts", `export const b = 2;\n`);
    const k1 = key("lib/pure.test.ts");
    expect(k1).not.toBe(k0);
    write("lib/pure.test.ts", readFileSync(join(repo, "lib/pure.test.ts"), "utf8") + "\n");
    expect(key("lib/pure.test.ts")).not.toBe(k1);
  });

  test("a comment that names a path or a location is not a sign; a module named by URL is followed", () => {
    expect(cache(["why", "lib/pure.test.ts"]).stdout).not.toContain("whole tree");
    const why = cache(["why", "lib/url.test.ts"]).stdout;
    expect(why).not.toContain("whole tree");
    expect(why).toContain("lib/worker.ts");
    const k0 = key("lib/url.test.ts");
    write("lib/worker.ts", `postMessage(2);\n`);
    expect(key("lib/url.test.ts")).not.toBe(k0);
  });

  test("a file that spawns is keyed on every file but prose", () => {
    expect(cache(["why", "lib/spawn.test.ts"]).stdout).toContain("the whole tree without prose");
    const k0 = key("lib/spawn.test.ts");
    write("docs/NOTES.md", "notes 3\n");
    write("README.md", "readme 2\n");
    expect(key("lib/spawn.test.ts")).toBe(k0);
    write("lib/other.ts", `export const other = 3;\n`);
    const k1 = key("lib/spawn.test.ts");
    expect(k1).not.toBe(k0);
    write("lib/added.json", "{}\n"); // untracked, not ignored: part of the tree
    expect(key("lib/spawn.test.ts")).not.toBe(k1);
  });

  test("a file that names prose, in one string or in path parts beside a location, is keyed on prose too", () => {
    for (const t of ["lib/named.test.ts", "lib/where.test.ts"]) {
      expect(cache(["why", t]).stdout).toMatch(/and the whole tree \(/);
      const k0 = key(t);
      write("docs/NOTES.md", `notes for ${t}\n`);
      expect(key(t)).not.toBe(k0);
    }
  });

  test("changes with the lockfile and with a variable a test can see; not with another variable", () => {
    const k0 = key("lib/pure.test.ts");
    expect(key("lib/pure.test.ts", { TEST_SERIAL: "1" })).not.toBe(k0);
    expect(key("lib/pure.test.ts", { UNRELATED_NAME: "1" })).toBe(k0);
    write("bun.lock", "lock 2\n");
    expect(key("lib/pure.test.ts")).not.toBe(k0);
  });
});

describe("plan and record (D650)", () => {
  const all = ["./lib/pure.test.ts", "./lib/url.test.ts", "./lib/spawn.test.ts"];
  const lines = (r: { stdout: string }) => r.stdout.split("\n").filter(Boolean);

  test("a file that passed is skipped until an input changes; a file that failed is run again", () => {
    expect(lines(plan(...all))).toEqual(all);
    cache([
      "record",
      state,
      junit([
        ["lib/pure.test.ts", 1, 0],
        ["lib/url.test.ts", 2, 1],
        ["lib/spawn.test.ts", 1, 0],
      ]),
    ]);
    const second = plan(...all);
    expect(lines(second)).toEqual(["./lib/url.test.ts"]);
    expect(second.stderr).toContain("2 of 3 files passed on these inputs and are skipped, 1 run");
    write("lib/b.ts", `export const b = 3;\n`);
    expect(lines(plan(...all))).toEqual(all); // pure imports b; spawn is keyed on the tree; url failed
  });

  test("a pass is not recorded when an input changed while the tests ran, or for a file with no tests", () => {
    plan(...all);
    write("lib/b.ts", `export const b = 4;\n`);
    cache([
      "record",
      state,
      junit([
        ["lib/pure.test.ts", 1, 0],
        ["lib/url.test.ts", 0, 0],
      ]),
    ]);
    expect(lines(plan(...all))).toEqual(all);
  });

  test("a pass older than the age bound is run again", () => {
    plan(...all);
    cache(["record", state, junit([["lib/pure.test.ts", 1, 0]])]);
    expect(lines(plan("./lib/pure.test.ts"))).toEqual([]);
    const store = join(repo, ".git", "eden-check-cache", "tests-v1");
    const old = Date.now() - MAX_AGE_MS - 60_000;
    writeFileSync(store, readFileSync(store, "utf8").replace(/^([0-9a-f]{40}) \d+ /gm, `$1 ${old} `));
    expect(lines(plan("./lib/pure.test.ts"))).toEqual(["./lib/pure.test.ts"]);
  });
});
