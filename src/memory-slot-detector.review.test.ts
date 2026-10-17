/**
 * P4.4 review round 1 probes (slice-reviewer), committed as regression tests. Each states what it found on 40851abb0.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import { cuedSlots } from "./memory-slots";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "eden-slot-review-"));
  dirs.push(dir);
  return openMemory({ dir });
}

const texts = (rows: readonly MemoryRecord[]) => rows.map((row) => row.text);
const ask = (mem: ReturnType<typeof store>, prompt: string) => texts(mem.recall([{ role: "user", content: prompt }]));

describe("finding 1: a newer typed statement the extractor leaves unkeyed is hidden behind an older keyed value", () => {
  // 40851abb0: every case returns the older keyed value; main returns the newer statement.
  const cases: [string, string, string, string][] = [
    ["The database is postgres.", "The database is the managed cluster on neon.", "what database do we use?", "neon"],
    ["The database is postgres.", "The database is now the shared one in frankfurt.", "what is the database?", "frankfurt"],
    ["The test runner is jest.", "The test runner is our in-house harness.", "which test runner do we use?", "harness"],
    ["The package manager is pnpm.", "The package manager is whatever corepack pins.", "the package manager is?", "corepack"],
  ];
  for (const [older, newer, cue, word] of cases)
    test(`"${newer}" is not displaced by "${older}"`, () => {
      const mem = store();
      mem.remember(older, { tags: ["src:user"] });
      mem.remember(newer, { tags: ["src:user"] });
      expect(texts(mem.relevant(cue)).join("\n")).toContain(word);
      expect(ask(mem, cue).join("\n")).toContain(word);
    });
});

describe("finding 2: the red test's no-shared-word case passes on main; these cues need the detector", () => {
  // On main (c73f72c7b) each returns nothing; on 40851abb0 each returns its row. "which test runner do we use?"
  // reaches "We switched from jest to vitest." on main too (BM25F's subject field from the row's D7 key).
  const rows = [
    "We switched from jest to vitest.",
    "We use Clerk.",
    "We are on node 20.11.",
    "The gateway logs to stdout.",
    "The billing worker retries three times.",
    "Use the staging bucket for uploads.",
    "The design tokens live in packages/ui/tokens.ts.",
  ];
  // "the login page redirects twice" also needed the detector on 40851abb0; since round 1 "login" names the auth
  // provider only in a cue about this project (finding 3), so it is not one of these.
  const cases: [string, string][] = [
    ["what do we run the specs with?", "vitest"],
    ["bump .nvmrc", "20.11"],
  ];
  for (const [cue, word] of cases)
    test(`"${cue}" reaches the row with "${word}"`, () => {
      const mem = store();
      for (const row of rows) mem.remember(row, { tags: ["src:user"] });
      expect(ask(mem, cue).join("\n")).toContain(word);
    });
});

describe("finding 3: seed collisions name a slot on prompts that are not about it", () => {
  // 40851abb0 names the slot in brackets for each.
  test.each([
    ["there's an error in the log in production, can you look?"], // auth.provider: "log in" as a noun phrase
    ["the log in the console says null"], // auth.provider
    ["implement the parser per the spec"], // test.runner: "spec" = specification
    ["let us set up a meeting tomorrow"], // setup bundle: "let us" is not ownership
  ])("%s", (prompt) => {
    expect(cuedSlots(prompt)).toEqual([]);
  });
});

describe("finding 3 (judgement): general-knowledge questions about a slot's topic (R1's off-topic coding class)", () => {
  // 40851abb0: each names a slot, and with the slot's row in the store delivers it as STRONG evidence.
  test.each([
    ["how does SSO work with SAML?"], // auth.provider
    ["how does session-based authentication differ from JWT?"], // auth.provider
    ["how do I write unit tests in Go?"], // test.runner
    ["what's the best code formatter for python?"], // formatter
    ["explain linting to a beginner"], // linter
    ["what is an ORM and why use one?"], // orm
    ["compare hosting providers for a static blog"], // deploy.target
    ["how do I sign in to the AWS console?"], // auth.provider
  ])("%s", (prompt) => {
    expect(cuedSlots(prompt)).toEqual([]);
  });

  // Kept: P3.4's seeds, which main names the package manager by too; the full-scale FIR and the guards decide.
  test.each([["what is a lockfile in general?"], ["how do I go about installing rust on windows?"]])("%s", (prompt) => {
    expect(cuedSlots(prompt)).toEqual(["pkg.manager"]);
  });
});

describe("finding 4: the detector's cost grows with the prompt (a RegExp built per phrase per call)", () => {
  // 40851abb0, load ~15: 1 KB 5.0 ms, 4 KB 17.7 ms, 10 KB 36.1 ms, 20 KB 67.1 ms per call (main: 0.04 ms at 35 KB).
  test("a 20 KB prompt costs under 10 ms", () => {
    const para = "We refactored the parser and the lexer so the error path returns early; see the trace below. ";
    const text = para.repeat(Math.ceil(20_480 / para.length));
    cuedSlots(text);
    const start = performance.now();
    for (let i = 0; i < 5; i++) cuedSlots(text);
    expect((performance.now() - start) / 5).toBeLessThan(10);
  });
});
