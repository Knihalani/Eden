import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asksHistory, invalidationsIn, readInvalidations, recordInvalidations, validText } from "./memory-validity";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-validity-"));
  dirs.push(dir);
  return dir;
}

describe("A4 §3.1: what invalidates a value or a rule", () => {
  test("retractions, switches and revocations, one token each", () => {
    const cases: [string, string[]][] = [
      ["We no longer use Redis.", ["retract:redis"]],
      ["we don't use jest anymore", ["retract:jest"]],
      ["We dropped Sentry last week.", ["retract:sentry"]],
      ["We switched apps/web from Auth0 to Clerk.", ["retract:auth0"]],
      ["we replaced npm with pnpm", ["retract:npm"]],
      ["Use pnpm, not npm.", ["retract:npm"]],
      ["Run vitest instead of jest.", ["retract:jest"]],
      ["You can merge PRs yourself now.", ["revoke:merge"]],
    ];
    for (const [text, expected] of cases) {
      const found = invalidationsIn(text, 1).map((r) => (r.k === "retract" ? `retract:${r.o}` : `revoke:${r.v}`));
      expect(found).toEqual(expected);
    }
  });

  test("questions, tasks and pronouns invalidate nothing", () => {
    for (const text of [
      "Can you merge it now?",
      "fix the failing test in src/app.ts",
      "this is no longer needed",
      "the build no longer uses it",
      "I removed the unused import",
      "which auth provider does apps/web use?",
    ])
      expect(invalidationsIn(text, 1)).toEqual([]);
  });
});

describe("A4 §5.1 step 5: validity at delivery", () => {
  const records = [
    ...invalidationsIn("We no longer use Redis.", 100),
    ...invalidationsIn("We switched apps/web from Auth0 to Clerk.", 100),
    ...invalidationsIn("You can merge PRs yourself now.", 100),
  ];

  test("a sentence older than an invalidation that still asserts its value is dropped", () => {
    expect(validText("stack uses Redis", 50, records)).toBe("");
    expect(validText("in apps web the auth provider is Auth0, and the database is postgres", 50, records)).toBe("");
    expect(validText("stack uses Redis. Never commit .env files", 50, records)).toBe("Never commit .env files");
  });

  test("a revoked rule is dropped; the action itself is not", () => {
    expect(validText("Push the fix to the PR, but don't merge it yourself", 50, records)).toBe("");
    expect(validText("Never merge PRs yourself", undefined, records)).toBe("");
    expect(validText("merge the pr once ci is green", 50, records)).toBe("merge the pr once ci is green");
  });

  test("newer text, the change itself and look-alike tokens stay", () => {
    expect(validText("We use Redis again", 150, records)).toBe("We use Redis again");
    expect(validText("We switched apps/web from Auth0 to Clerk", 50, records)).toBe(
      "We switched apps/web from Auth0 to Clerk",
    );
    expect(validText("redis.conf sets maxmemory", 50, records)).toBe("redis.conf sets maxmemory");
    expect(validText("stack uses Redis", 50, [])).toBe("stack uses Redis");
  });
});

describe("the validity log", () => {
  test("a prompt's invalidations are appended, owner-only, and read back", () => {
    const root = tempRoot();
    recordInvalidations(root, "fix the tests", 1);
    recordInvalidations(root, "We no longer use Redis. You can merge PRs yourself now.", 2);
    expect(readInvalidations(root)).toEqual([
      { k: "retract", o: "redis", t: 2 },
      { k: "revoke", v: "merge", t: 2 },
    ]);
    expect(statSync(join(root, "validity.jsonl")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "validity.jsonl"), "utf8")).not.toContain("We no longer");
  });

  test("a missing or torn log reads as none", () => {
    expect(readInvalidations(join(tempRoot(), "missing"))).toEqual([]);
  });
});

describe("A4 §5.1 step 5: a cue that asks history", () => {
  test("R3's markers", () => {
    for (const prompt of ["what did we use before Clerk?", "the cache we used to have", "why did we drop Redis?"])
      expect(asksHistory(prompt)).toBe(true);
    for (const prompt of ["which cache do we use?", "fix the login redirect"]) expect(asksHistory(prompt)).toBe(false);
  });
});
