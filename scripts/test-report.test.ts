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
      `── tests over ${(SLOW_MS / 1000).toFixed(1)} s (within 30% of Bun's 5 s default):`,
      '   4.0 s  packages/a/x.test.ts > slow & "steady"',
    ]);
    expect(report([])).toEqual([]);
  });
});

describe("the tail (scripts/test-tail.txt, D811)", () => {
  const listed = readFileSync(join(root, "scripts/test-tail.txt"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));

  test("every listed file is a test file that exists, listed once", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const f of listed) {
      expect(f).toMatch(/\.test\.tsx?$/);
      expect(`${f} ${existsSync(join(root, f))}`).toBe(`${f} true`);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });
});
