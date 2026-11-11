import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJunit, report, SLOW_MS } from "./test-report";

const root = join(import.meta.dir, "..");

describe("test-report (D811)", () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="packages/a/x.test.ts" file="packages/a/x.test.ts" tests="2" failures="0" time="4.2">
    <testsuite name="outer" file="packages/a/x.test.ts" line="3" tests="2" time="4.1">
      <testcase name="slow &amp; &quot;steady&quot;" classname="outer" time="4.0" file="packages/a/x.test.ts" />
      <testcase name="quick" classname="outer" time="0.1" file="packages/a/x.test.ts" />
    </testsuite>
  </testsuite>
  <testsuite name="packages/b/y.test.ts" file="packages/b/y.test.ts" tests="1" failures="0" time="0.5">
    <testcase name="fine" classname="" time="0.5" file="packages/b/y.test.ts" />
  </testsuite>
</testsuites>`;

  test("reads files from top-level suites only, and each test with its file", () => {
    const got = parseJunit(xml);
    expect(got.files.map((f) => [f.file, Math.round(f.ms)])).toEqual([
      ["packages/a/x.test.ts", 4200],
      ["packages/b/y.test.ts", 500],
    ]);
    expect(got.tests.map((t) => [t.file, t.name])).toEqual([
      ["packages/a/x.test.ts", 'slow & "steady"'],
      ["packages/a/x.test.ts", "quick"],
      ["packages/b/y.test.ts", "fine"],
    ]);
  });

  test("names the slowest files and every test over the bound, slowest first", () => {
    const lines = report([parseJunit(xml)]);
    expect(lines[0]).toBe("── slowest files: packages/a/x.test.ts 4.2 s, packages/b/y.test.ts 0.5 s");
    expect(lines.slice(1)).toEqual([
      `── tests over ${(SLOW_MS / 1000).toFixed(1)} s (70% of Bun's 5 s default; some set a longer timeout of their own):`,
      '   4.0 s  packages/a/x.test.ts > slow & "steady"',
    ]);
    expect(report([])).toEqual([]);
  });
});

describe("the tail (scripts/test-tail.txt, D811)", () => {
  const listed = readFileSync(join(root, "scripts/test-tail.txt"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));

  // A wall-clock difference (`performance.now() - t0`, `Date.now() - t0`) in a file of the main run: a bound on work
  // reads CPU time (`cpuMs`), and a bound on a wait belongs here (the review found three the first list missed).
  test("no file outside the tail measures elapsed wall time", () => {
    const tail = new Set(listed);
    const found = Bun.spawnSync(["git", "ls-files", "*.test.ts", "*.test.tsx"], { cwd: root })
      .stdout.toString()
      .split("\n")
      .filter((f) => f && !f.startsWith("archived/") && !tail.has(f) && f !== "scripts/test-report.test.ts")
      // A start time is a lowercase variable; `Date.now() - HOUR` dates something, it measures nothing.
      .filter((f) => /(?:performance|Date)\.now\(\)\s*-\s*[a-z]\w*/.test(readFileSync(join(root, f), "utf8")));
    expect(found).toEqual([]);
  });

  test("every listed file is a test file that exists, listed once", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed) {
      expect(f).toMatch(/\.test\.tsx?$/);
      expect(`${f} ${existsSync(join(root, f))}`).toBe(`${f} true`);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe("scripts/test.sh with a name filter (D811's review)", () => {
  test("a filter matching tests in only one part passes: it runs one invocation, unsplit", () => {
    // packages/sources holds tail files (list, guarded, regressions…) and main files; this name is in one main file.
    const r = Bun.spawnSync(["scripts/test.sh", "packages/sources", "-t", "idle pairs"], {
      cwd: root,
      env: { ...process.env, TEST_CACHE: "0" },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(out).not.toContain("matched 0 tests");
    expect(out).toMatch(/\b1 pass\b/);
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
