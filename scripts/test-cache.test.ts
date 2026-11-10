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
/** Records tests as the audit would after tracing them on these bytes (D658): only then is a key narrow. */
const trust = (...tests: string[]) =>
  write(
    "scripts/test-cache-verified.txt",
    tests.map((t) => `${/closure ([0-9a-f]{40})/.exec(cache(["why", t]).stdout)![1]!} ${t}\n`).join(""),
  );
const plan = (...tests: string[]) => cache(["plan", state, ...tests]);
const junit = (suites: Array<[file: string, tests: number, failures: number, skipped?: number]>) => {
  const body = suites
    .map(
      ([f, t, x, k]) =>
        `<testsuite name="${f}" file="${f}" tests="${t}" assertions="1" failures="${x}" skipped="${k ?? 0}" time="0.1">\n` +
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
write("lib/loc.test.ts", `const here = import.meta.dir;\ntest("l", () => here);\n`);
write("lib/spawn.test.ts", `import { spawnSync } from "node:child_process";\ntest("s", () => spawnSync("true"));\n`);
write("lib/where.test.ts", `import { join } from "node:path";\nconst d = join(import.meta.dir, "..", "docs");\n`);
write("lib/named.test.ts", `import { readFileSync } from "node:fs";\nreadFileSync("docs/NOTES.md");\n`);
write("docs/NOTES.md", "notes\n");
write("README.md", "readme\n");

describe("a test file's key (D650)", () => {
  test("changes with the file and what it imports, transitively; not with a file it cannot reach, nor with prose", () => {
    trust("lib/pure.test.ts");
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
    trust("lib/pure.test.ts", "lib/url.test.ts");
    expect(cache(["why", "lib/pure.test.ts"]).stdout).not.toContain("whole tree");
    const why = cache(["why", "lib/url.test.ts"]).stdout;
    expect(why).not.toContain("whole tree");
    expect(why).toContain("lib/worker.ts");
    const k0 = key("lib/url.test.ts");
    write("lib/worker.ts", `postMessage(2);\n`);
    expect(key("lib/url.test.ts")).not.toBe(k0);
  });

  test("a file that learns its location is keyed on every file but prose; one that spawns, on prose too", () => {
    expect(cache(["why", "lib/loc.test.ts"]).stdout).toContain("the whole tree without prose");
    const k0 = key("lib/loc.test.ts");
    const s0 = key("lib/spawn.test.ts");
    write("docs/NOTES.md", "notes 3\n");
    write("README.md", "readme 2\n");
    expect(key("lib/loc.test.ts")).toBe(k0);
    // A process it starts can read anything (the review: Python tests reading their README).
    expect(cache(["why", "lib/spawn.test.ts"]).stdout).toMatch(/and the whole tree \(/);
    expect(key("lib/spawn.test.ts")).not.toBe(s0);
    write("lib/other.ts", `export const other = 3;\n`);
    const k1 = key("lib/loc.test.ts");
    expect(k1).not.toBe(k0);
    write("lib/added.json", "{}\n"); // untracked, not ignored: part of the tree
    expect(key("lib/loc.test.ts")).not.toBe(k1);
  });

  test("reads the import graph does not show are tree signs (the review of D650)", () => {
    const cases: Record<string, string> = {
      "a directory listed by a bare name": `import { readdirSync } from "node:fs";\nreaddirSync("lib");\n`,
      "a root file by name": `import { readFileSync } from "node:fs";\nreadFileSync(".env.example");\n`,
      "a root file named in a string": `const f = "LICENSE";\nexport { f };\n`,
      "a path joined from a top-level directory": `import { join } from "node:path";\njoin("lib", "x", "y.json");\n`,
      "a path under a top-level directory": `const p = "./lib/data.json";\nexport { p };\n`,
      "import.meta.require": `const j = import.meta.require("./data.json");\nexport { j };\n`,
      "a template import": "const n = 'data';\nconst j = await import(`./${n}.json`);\nexport { j };\n",
      "a template require": "const n = 'data';\nconst j = require(`./${n}.json`);\nexport { j };\n",
      "any relative read": `import { existsSync } from "node:fs";\nexistsSync("data.json");\n`,
      // Bun's module reached other than as `Bun.x`, and a module named by a sum (the review of D657).
      "file imported from bun": `import { file } from "bun";\nexport const g = () => file(["fixtures", "g.txt"].join("/"));\n`,
      "bun's module as a namespace": `import * as B from "bun";\nexport const s = () => B.$\`git status\`;\n`,
      "Bun destructured": `const { spawnSync } = Bun;\nexport const s = () => spawnSync(["git", "status"]);\n`,
      "Bun indexed": `export const s = () => Bun["spawnSync"](["git", "status"]);\n`,
      "a built-in by name at run time": `export const cp = process.getBuiltinModule("node:child_" + "process");\n`,
      // Not a comment: the string ends at its quote, and the sign after it must be seen.
      "a sign after a string that looks like a comment": `const g = "fixtures/*.tmp";\nconst d = import.meta.dir;\nconst h = "*/";\nexport { g, d, h };\n`,
    };
    write(".env.example", "A=1\n");
    write("LICENSE", "x\n");
    let i = 0;
    for (const [what, code] of Object.entries(cases)) {
      const t = `lib/sign${i++}.test.ts`;
      write(t, code);
      const why = cache(["why", t]).stdout;
      expect({ what, tree: /whole tree/.test(why) && !why.includes("not traced") }).toEqual({ what, tree: true });
    }
    // A Markdown file named in a string is read from the working directory: the tree, with prose.
    write("lib/md.test.ts", `const name = "README.md";\nexport { name };\n`);
    expect(cache(["why", "lib/md.test.ts"]).stdout).toMatch(/and the whole tree \(/);
  });

  test("a test the audit has not traced is keyed on the tree, whatever the signs miss (D658)", () => {
    // Forms the second review of D657 got past every sign: only the audit's trace can vouch for a narrow key.
    const unseen: Record<string, string> = {
      "Bun passed as an argument": `const run = (b: typeof Bun) => b.spawnSync(["cat", "x"]);\nexport const r = () => run(Bun);\n`,
      "globalThis.Bun": `const b = globalThis.Bun;\nexport const f = () => b.file(["lib", "d.txt"].join("/"));\n`,
      "Bun.mmap": `export const m = () => Bun.mmap(["lib", "d.txt"].join("/"));\n`,
      "a Worker by a built path": `export const w = () => new Worker(["lib", "w.ts"].join("/"));\n`,
      "an import the transpiler folds": `export const w = await import("./w" + ".ts");\n`,
    };
    let i = 0;
    for (const [what, code] of Object.entries(unseen)) {
      const t = `lib/unseen${i++}.test.ts`;
      write(t, code);
      expect({ what, why: /whole tree/.test(cache(["why", t]).stdout) }).toEqual({ what, why: true });
    }
    // A comment that looks like a dynamic import does not cost a traced test its narrow key.
    write("lib/comment.test.ts", "/** The module a pool imports (`import(`x`)`). */\nexport const c = 1;\n");
    const why = () => cache(["why", "lib/comment.test.ts"]).stdout;
    expect(why()).toContain("not traced by the audit");
    const hash = /closure ([0-9a-f]{40})/.exec(why())![1]!;
    write("scripts/test-cache-verified.txt", `${hash} lib/comment.test.ts\n`);
    expect(why()).not.toContain("whole tree");
    write("scripts/test-cache-verified.txt", "");
  });

  test("a closure that reads files is keyed on the tree unless the audit traced it on these bytes", () => {
    const reads = (enc: string) =>
      `import { readFileSync } from "node:fs";\nexport const read = (p: string) => readFileSync(p${enc});\n`;
    write("lib/reads.ts", reads(""));
    write("lib/reads.test.ts", `import { read } from "./reads";\ntest("r", () => read);\n`);
    const why = () => cache(["why", "lib/reads.test.ts"]).stdout;
    expect(why()).toContain("not traced by the audit");
    const hash = /closure ([0-9a-f]{40})/.exec(why())![1]!;
    write("scripts/test-cache-verified.txt", `${hash} lib/reads.test.ts\n`);
    expect(why()).not.toContain("whole tree");
    const k0 = key("lib/reads.test.ts");
    write("lib/other.ts", `export const other = 9;\n`);
    expect(key("lib/reads.test.ts")).toBe(k0);
    // An edit in its closure: the audit's line no longer matches, so it is back on the tree.
    write("lib/reads.ts", reads(', "utf8"'));
    expect(why()).toContain("not traced by the audit");
  });

  test("a file that names prose, in one string or in path parts beside a location, is keyed on prose too", () => {
    for (const t of ["lib/named.test.ts", "lib/where.test.ts"]) {
      expect(cache(["why", t]).stdout).toMatch(/and the whole tree \(/);
      const k0 = key(t);
      write("docs/NOTES.md", `notes for ${t}\n`);
      expect(key(t)).not.toBe(k0);
    }
  });

  test("changes with the lockfile, the preload's imports, a root .env file and any variable but the shell's own", () => {
    const k0 = key("lib/pure.test.ts");
    // FUZZ_SEEDS=1 runs a weaker fuzz: its pass is not the full run's (the review).
    expect(key("lib/pure.test.ts", { FUZZ_SEEDS: "1" })).not.toBe(k0);
    expect(key("lib/pure.test.ts", { ANY_NAME_AT_ALL: "1" })).not.toBe(k0);
    expect(key("lib/pure.test.ts", { OLDPWD: "/elsewhere", TERM: "dumb", SHLVL: "7" })).toBe(k0);
    write("bun.lock", "lock 2\n");
    const k1 = key("lib/pure.test.ts");
    expect(k1).not.toBe(k0);
    write("scripts/preload-helper.ts", "export const zone = 'UTC';\n");
    write("scripts/test-preload.ts", `import { zone } from "./preload-helper";\nprocess.env.TZ = zone;\n`);
    const k2 = key("lib/pure.test.ts");
    expect(k2).not.toBe(k1);
    write("scripts/preload-helper.ts", "export const zone = 'Asia/Tokyo';\n");
    const k3 = key("lib/pure.test.ts");
    expect(k3).not.toBe(k2);
    // Ignored by git, loaded by Bun into every test.
    write(".gitignore", ".env.test\n");
    const k4 = key("lib/pure.test.ts");
    write(".env.test", "SECRET_FLAG=1\n");
    expect(key("lib/pure.test.ts")).not.toBe(k4);
    // The same without Bun loading .env.test into the planner's own environment: the file itself is keyed.
    const noEnv = () =>
      /key ([0-9a-f]{40})/.exec(
        sh("bun", ["--no-env-file", join(import.meta.dir, "test-cache.ts"), "why", "lib/pure.test.ts"]).stdout,
      )![1]!;
    const e0 = noEnv();
    write(".env.test", "SECRET_FLAG=2\n");
    expect(noEnv()).not.toBe(e0);
  });

  test("changes with the node on PATH, and sees files the user's own git excludes", () => {
    const bin = join(repo, ".git", "fake-bin");
    const node = (v: string) => {
      write(".git/fake-bin/node", `#!/bin/sh\necho ${v}\n`);
      sh("chmod", ["+x", join(bin, "node")]);
    };
    const path = { PATH: `${bin}:${process.env.PATH}` };
    node("v1.0.0");
    const n1 = key("lib/pure.test.ts", path);
    node("v2.0.0");
    expect(key("lib/pure.test.ts", path)).not.toBe(n1);
    // A global excludes file that hides lib/extra.txt: a tree-keyed test must still see it change.
    write(".git/user-excludes", "lib/extra.txt\n");
    write(".git/user-gitconfig", `[core]\n\texcludesFile = ${join(repo, ".git", "user-excludes")}\n`);
    const user = { GIT_CONFIG_GLOBAL: join(repo, ".git", "user-gitconfig") };
    write("lib/extra.txt", "1\n");
    const x1 = key("lib/spawn.test.ts", user);
    write("lib/extra.txt", "2\n");
    expect(key("lib/spawn.test.ts", user)).not.toBe(x1);
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
    // Every test skipped (a missing tool): nothing was proved.
    cache(["record", state, junit([["lib/pure.test.ts", 2, 0, 2]])]);
    expect(lines(plan(...all))).toEqual(all);
  });

  test("a pass older than the age bound is run again", () => {
    expect(MAX_AGE_MS).toBe(24 * 3_600_000); // a day: the bound on what a date-dependent test could hide
    plan(...all);
    cache(["record", state, junit([["lib/pure.test.ts", 1, 0]])]);
    expect(lines(plan("./lib/pure.test.ts"))).toEqual([]);
    const store = join(repo, ".git", "eden-check-cache", "tests-v2");
    const old = Date.now() - MAX_AGE_MS - 60_000;
    writeFileSync(store, readFileSync(store, "utf8").replace(/^([0-9a-f]{40}) \d+ /gm, `$1 ${old} `));
    expect(lines(plan("./lib/pure.test.ts"))).toEqual(["./lib/pure.test.ts"]);
  });
});
