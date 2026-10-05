/**
 * Reading packets and windows: bullets, normalized content, and which values a text states.
 */
import { describe, expect, test } from "bun:test";
import {
  bulletContent,
  bulletsOf,
  containsNormalized,
  mentions,
  normalize,
  packetHeader,
  scopesNamed,
  statementsIn,
  statesValue,
} from "./statements";
import { DEMO_WORLD } from "./fixtures/demo-world";

const { subjects, scopes } = DEMO_WORLD;
const subject = (key: string) => subjects.find((candidate) => candidate.key === key)!;
const states = (text: string) => statementsIn(text, subjects, scopes);

describe("packets and bullets", () => {
  test("bullets are the list lines; a packet with none is one bullet", () => {
    const packet = "Eden memory (apps/web), recalled from earlier sessions:\n- Auth provider: Clerk\n* two\n3. three";
    expect(bulletsOf(packet)).toEqual(["Auth provider: Clerk", "two", "three"]);
    expect(packetHeader(packet)).toBe("Eden memory (apps/web), recalled from earlier sessions:");
    expect(bulletsOf("probe saw UserPromptSubmit")).toEqual(["probe saw UserPromptSubmit"]);
    expect(bulletsOf("  \n")).toEqual([]);
  });

  test("today's `[kind · age · src]` tag and D14's trailing provenance are metadata, not content", () => {
    expect(bulletContent("[episode · 0m · user] The database is postgres.")).toBe("The database is postgres.");
    expect(bulletContent("Rule you set: never merge")).toBe("Rule you set: never merge");
    expect(bulletContent("fix the login (you said, 3 weeks ago)")).toBe("fix the login");
    expect(bulletContent("Database: postgres (you said)")).toBe("Database: postgres");
    expect(bulletContent("stack uses Redis (from a summary of earlier work, 1 hour ago)")).toBe("stack uses Redis");
    expect(bulletContent("CI is green (from a tool result)")).toBe("CI is green");
    expect(bulletContent("Updated: test runner is now vitest (was jest)")).toBe(
      "Updated: test runner is now vitest (was jest)",
    );
  });

  test("normalized content ignores case, punctuation and spacing, and matches whole tokens", () => {
    expect(normalize("Auth is  Clerk.")).toBe("auth is clerk");
    expect(normalize("see apps/web/app/login.ts, then @clerk/nextjs!")).toBe(
      "see apps/web/app/login.ts then @clerk/nextjs",
    );
    expect(containsNormalized(normalize("fix it: auth is Clerk, fix login"), normalize("Auth is Clerk."))).toBe(true);
    expect(containsNormalized(normalize("auth is clerkish"), normalize("auth is clerk"))).toBe(false);
    expect(containsNormalized("anything", "")).toBe(false);
  });
});

describe("what a text states", () => {
  test("a subject word and a value in one sentence", () => {
    expect(states("The database is postgres.")).toEqual([{ key: "db.engine", value: "postgres" }]);
    expect(states("apps/web runs node 22.")).toEqual([{ key: "node.version", value: "22", scope: "apps/web" }]);
    expect(states("node is great. we have 22 files")).toEqual([]);
  });

  test("a value that names its subject alone needs no subject word", () => {
    expect(states("we use pnpm here")).toEqual([{ key: "pkg.manager", value: "pnpm" }]);
    expect(states("We use Redis for caching.")).toEqual([{ key: "cache.store", value: "Redis" }]);
    // `none` does not name auth on its own.
    expect(states("none of this works")).toEqual([]);
    expect(states("packages/cli has no auth")).toEqual([
      { key: "auth.provider", value: "none", scope: "packages/cli" },
    ]);
  });

  test("a value in a historic or negated context is not stated", () => {
    expect(states("We switched apps/web from Auth0 to Clerk.")).toEqual([
      { key: "auth.provider", value: "Clerk", scope: "apps/web" },
    ]);
    expect(states("Updated: package manager is now pnpm (was npm)")).toEqual([{ key: "pkg.manager", value: "pnpm" }]);
    expect(states("We no longer use Redis.")).toEqual([]);
    expect(states("use pnpm, not npm")).toEqual([{ key: "pkg.manager", value: "pnpm" }]);
    expect(states("the database is postgres instead of sqlite")).toEqual([{ key: "db.engine", value: "postgres" }]);
    expect(states("You can merge PRs yourself now.")).toEqual([]);
  });

  test("words inside other words do not count", () => {
    expect(states("pnpm is fine")).toEqual([{ key: "pkg.manager", value: "pnpm" }]);
    expect(states("the Auth0 thing in authority.ts")).toEqual([{ key: "auth.provider", value: "Auth0" }]);
    expect(states("ClerkProvider wraps the app")).toEqual([]);
  });

  test("policies are stated by their phrases", () => {
    expect(states("Rule you set: .env files are never committed")).toEqual([
      { key: "policy:commit|neg|.env", value: "never" },
    ]);
    expect(states("Push the fix to the PR, but don't merge it yourself.")).toEqual([
      { key: "policy:integrate|neg|*", value: "in force" },
    ]);
  });

  test("a sentence's scope is the one named nearest before the value; ` · ` splits A4's two-scope bullet", () => {
    expect(states("auth — apps/web: Clerk · packages/cli: none")).toEqual([
      { key: "auth.provider", value: "Clerk", scope: "apps/web" },
      { key: "auth.provider", value: "none", scope: "packages/cli" },
    ]);
    expect(states("Auth provider in apps/web: Clerk (you said, 3 weeks ago)")).toEqual([
      { key: "auth.provider", value: "Clerk", scope: "apps/web" },
    ]);
    expect(states("In apps/web the auth provider is Auth0, and the database is postgres.")).toEqual([
      { key: "auth.provider", value: "Auth0", scope: "apps/web" },
      { key: "db.engine", value: "postgres", scope: "apps/web" },
    ]);
  });

  test("scopes are named as paths, the longest at a place winning, never inside another word", () => {
    expect(scopesNamed("see /repo/apps/web/app/login.ts and packages/cli", scopes)).toEqual([
      { scope: "apps/web", at: 10 },
      { scope: "packages/cli", at: 36 },
    ]);
    expect(scopesNamed("myapps/web-old", scopes)).toEqual([]);
  });

  test("a scope written with spaces, as today's gists write it, is still named", () => {
    expect(states("in apps web the auth provider is Auth0")).toEqual([
      { key: "auth.provider", value: "Auth0", scope: "apps/web" },
    ]);
    expect(scopesNamed("packages cli has no auth", scopes)).toEqual([{ scope: "packages/cli", at: 0 }]);
    expect(scopesNamed("the apps webpack config", scopes)).toEqual([]);
  });
});

describe("what a window states", () => {
  test("a value anywhere in a large text, with its subject in the same sentence", () => {
    const filler = "const value = await request;\n".repeat(20_000);
    const window = `${filler}The user said: auth is Clerk. ${filler}`.toLowerCase();
    expect(statesValue(window, subject("auth.provider"), "Clerk")).toBe(true);
    expect(statesValue(window, subject("auth.provider"), "Auth0")).toBe(false);
    expect(statesValue("clerk is a nice word. auth is fine.", subject("auth.provider"), "none")).toBe(false);
    expect(statesValue("we dropped redis.", subject("cache.store"), "Redis")).toBe(false);
  });

  test("with a scope filter, a sentence that names another scope does not count", () => {
    const db = subject("db.engine");
    const window = "in apps/web the database is postgres. we use pnpm.";
    const cli = { scopes, accept: ["packages/cli"] };
    expect(statesValue(window, db, "postgres")).toBe(true);
    expect(statesValue(window, db, "postgres", cli)).toBe(false);
    expect(statesValue(window, db, "postgres", { scopes, accept: ["apps/web"] })).toBe(true);
    // A sentence that names no scope counts for any scope.
    expect(statesValue(window, subject("pkg.manager"), "pnpm", cli)).toBe(true);
  });

  test("in a sentence naming two scopes, each value counts only for its own", () => {
    const db = subject("db.engine");
    const auth = subject("auth.provider");
    const cli = { scopes, accept: ["packages/cli"] };
    const both = "in apps/web the database is postgres, and in packages/cli it is sqlite.";
    expect(statesValue(both, db, "postgres", cli)).toBe(false);
    expect(statesValue(both, db, "sqlite", cli)).toBe(true);
    const fanOut = "auth — apps/web: clerk · packages/cli: none";
    expect(statesValue(fanOut, auth, "Clerk", cli)).toBe(false);
    expect(statesValue(fanOut, auth, "none", cli)).toBe(true);
    expect(statesValue(fanOut, auth, "Clerk", { scopes, accept: ["apps/web"] })).toBe(true);
  });

  test("a subject is mentioned by a word or by a value that names it alone", () => {
    expect(mentions("fix the failing test in apps/web/src/auth.ts", subject("auth.provider"))).toBe(true);
    expect(mentions("bump pnpm", subject("pkg.manager"))).toBe(true);
    expect(mentions("fix the config loader", subject("pkg.manager"))).toBe(false);
  });
});
