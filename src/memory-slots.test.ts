/**
 * P3.3: D7's slot table, read from what the user typed. The phrasing table is ROADMAP's gate: R3 E8's phrasings, the
 * D7 base forms and R8's additional ones, and the status and trap phrasings that state no slot.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_SCOPES, SLOT_IDS, slotsIn, STATUS_LEXICON, type SlotStatement } from "./memory-slots";

/** A text's slot statements, as `slot=value !was …` (a retraction has no `=value`). */
const read = (text: string) => slotsIn(text).map(show);
const show = (s: SlotStatement) =>
  [`${s.slot}${s.value === undefined ? "" : `=${s.value}`}`, ...s.was.map((was) => `!${was}`)].join(" ");

/** The phrasing table: each text and what it states (an empty list: no slot). */
const TABLE: [string, string[]][] = [
  // R3 E8: one key per slot, `here` is no part of the value, `use A for B` is B's slot, a negated copula invalidates.
  ["we use pnpm", ["pkg.manager=pnpm"]],
  ["we use postgres for the db", ["db.engine=postgres"]],
  ["we use pnpm here", ["pkg.manager=pnpm"]],
  ["we moved web auth to Auth0 last week", ["auth.provider=auth0"]],
  ["we use Clerk for auth", ["auth.provider=clerk"]],
  ["the database is not postgres", ["db.engine !postgres"]],
  ["The staging DB password is hunter2hunter2", []],
  // D7's base forms.
  ["The package manager is pnpm, not npm.", ["pkg.manager=pnpm !npm"]],
  ["orm: drizzle", ["orm=drizzle"]],
  ["node version is 20.11", ["node.version=20.11"]],
  ["In apps/web the auth provider is Clerk.", ["auth.provider=clerk"]],
  ["We use PostgreSQL for the database.", ["db.engine=postgres"]],
  ["the auth provider is Zitadel", ["auth.provider=zitadel"]],
  ["use pnpm not npm", ["pkg.manager=pnpm !npm"]],
  ["use pnpm instead of yarn please", ["pkg.manager=pnpm !yarn"]],
  ["we switched from jest to vitest", ["test.runner=vitest !jest"]],
  ["We switched auth from Auth0 to Clerk.", ["auth.provider=clerk !auth0"]],
  ["packages/cli switched its database from postgres to sqlite.", ["db.engine=sqlite !postgres"]],
  ["i always use pnpm", ["pkg.manager=pnpm"]],
  ["the base branch is develop, not main", ["branch.base=develop !main"]],
  ["use my work account acme-dev for gh", ["gh.account=acme-dev"]],
  // R8's additional patterns (D7).
  ["we don't use yarn anymore", ["pkg.manager !yarn"]],
  ["we no longer use prettier", ["formatter !prettier"]],
  ["we're dropping jest", ["test.runner !jest"]],
  ["we're on node 22 now", ["node.version=22"]],
  ["our tests run on playwright", ["test.runner=playwright"]],
  ["we deploy to Vercel", ["deploy.target=vercel"]],
  ["we host on fly.io", ["deploy.target=fly.io"]],
  ["PRs go against develop", ["branch.base=develop"]],
  ["we migrated to Postgres from MySQL last month", ["db.engine=postgres !mysql"]],
  ["use biome for formatting, not prettier", ["formatter=biome !prettier"]],
  ["we use yarn berry", ["pkg.manager=yarn"]],
  ["we're not on heroku anymore, it's render", ["deploy.target !heroku", "deploy.target=render"]],
  // Status words, questions, conditionals and instructions state no slot (D7, R7 §9).
  ["the auth is broken", []],
  ["auth is broken", []],
  ["the db is down again", []],
  ["tests are flaky today", []],
  ["the formatter is weird, it keeps moving my imports", []],
  ["the package manager is being slow today", []],
  ["auth: fixed now", []],
  ["framework is new to me, can you explain the layout file", []],
  ["what database do we use?", []],
  ["if we use pnpm, does the lockfile change", []],
  ["use a Set for the lookup instead of an array", []],
  ["use the existing Button component for this", []],
  ["we moved the helpers to packages/shared last week, update the imports", []],
  ["switch to the dark theme in the storybook preview", []],
  ["We use Redis for caching.", []],
  ["use vitest's fake timers in this test", []],
];

describe("D7: the slot phrasing table", () => {
  test("the table has at least 30 rows, E8's and the status rows among them", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(30);
  });

  for (const [text, expected] of TABLE)
    test(JSON.stringify(text), () => {
      expect(read(text)).toEqual(expected);
    });
});

describe("D7: the table itself", () => {
  test("the 15 launch slots, each with its default scope", () => {
    expect([...SLOT_IDS].sort()).toEqual(
      [
        "auth.provider",
        "branch.base",
        "ci.system",
        "commit.style",
        "db.engine",
        "deploy.target",
        "formatter",
        "framework",
        "gh.account",
        "lang.version",
        "linter",
        "node.version",
        "orm",
        "pkg.manager",
        "test.runner",
      ].sort(),
    );
    const root = SLOT_IDS.filter((slot) => DEFAULT_SCOPES[slot] === "root").sort();
    expect(root).toEqual(["branch.base", "ci.system", "commit.style", "deploy.target", "gh.account", "pkg.manager"]);
  });

  test("the status lexicon is D7's", () => {
    expect([...STATUS_LEXICON].sort()).toEqual(
      "broken down failing flaky slow fixed working done weird annoying wrong fine ok good bad new old".split(" ").sort(),
    );
  });

  test("a status word is never a value, even capitalized", () => {
    expect(read("The database is Down.")).toEqual([]);
    expect(read("deploy target: Broken")).toEqual([]);
  });
});
