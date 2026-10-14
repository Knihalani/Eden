/**
 * P3.3: D7's slot table, read from what the user typed. The phrasing table is ROADMAP's gate: R3 E8's phrasings, the
 * D7 base forms and R8's additional ones, and the status and trap phrasings that state no slot.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCOPES,
  mayStateSlot,
  SLOT_IDS,
  slotLabel,
  slotsIn,
  STATUS_LEXICON,
  type SlotStatement,
} from "./memory-slots";

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
  ["We're not using Jest anymore.", ["test.runner !jest"]],
  ["we're on node 22 now", ["node.version=22"]],
  ["our tests run on playwright", ["test.runner=playwright"]],
  ["we deploy to Vercel", ["deploy.target=vercel"]],
  ["we host on fly.io", ["deploy.target=fly.io"]],
  ["PRs go against develop", ["branch.base=develop"]],
  ["we migrated to Postgres from MySQL last month", ["db.engine=postgres !mysql"]],
  ["use biome for formatting, not prettier", ["formatter=biome !prettier"]],
  ["we use yarn berry", ["pkg.manager=yarn"]],
  ["we're not on heroku anymore, it's render", ["deploy.target !heroku", "deploy.target=render"]],
  // The same forms, in other words D7's forms take.
  ["Clerk is our auth provider", ["auth.provider=clerk"]],
  ["our tests use vitest", ["test.runner=vitest"]],
  ["Node version is pinned to 20.11 in .nvmrc", ["node.version=20.11"]],
  ["auth is handled by Clerk", ["auth.provider=clerk"]],
  ["we're on GitHub Actions for CI", ["ci.system=github actions"]],
  ["we just switched to vitest", ["test.runner=vitest"]],
  ["we replaced jest with vitest", ["test.runner=vitest !jest"]],
  ["we use pnpm and vitest", ["pkg.manager=pnpm", "test.runner=vitest"]],
  ["we lint with biome", ["linter=biome"]],

  ["We use node 20 across the repo.", ["node.version=20"]],
  ["apps/web runs node 22.", ["node.version=22"]],
  ["packages/cli uses yarn as its package manager.", ["pkg.manager=yarn"]],
  // After the disclosed look at E3 batch B's misses (2026-10-14): D7's and R8's forms they use, in other words.
  ["we migrated from mysql to postgres in the summer", ["db.engine=postgres !mysql"]],
  ["use Drizzle for queries, not TypeORM", ["orm=drizzle !typeorm"]],
  ["switched the worker to hono from express", ["framework=hono !express"]],
  ["everything is pnpm now", ["pkg.manager=pnpm"]],
  ["my gh account is kn-dev", ["gh.account=kn-dev"]],
  ["we switched from main to develop", []],
  // Status words, questions, conditionals, reminders and instructions state no slot (D7, R7 §9); nor does a value
  // that is an everyday word without its slot, or a word outside the class where the form takes class values only.
  ["don't forget to use Clerk for auth because SSO", []],
  ["I switched branches to main", []],
  ["Render the login form server-side.", []],
  ["tests run in CI", []],
  ["the tests run on Fridays", []],
  ["test the endpoint with Postgres", []],
  // A qualified subject is another instance, whose value is not the slot's.
  ["The staging database is postgres.", []],
  ["End-to-end tests use Playwright.", []],
  ["The web app deploys on Vercel.", []],
  ["We deploy the storybook to Chromatic.", []],
  ["The frontend deploys to Vercel.", []],
  // Code review round 1: a retraction or `we're on` names its value whole; a noun after it is a part of it.
  ["We don't run jest locally.", []],
  ["We no longer need jest mocks.", []],
  ["We dropped the jest config.", []],
  ["We're not using Vercel previews anymore.", []],
  ["We don't use npm scripts here, use the Makefile", []],
  ["We no longer use the yarn lockfile", []],
  ["We removed the Prisma schema", []],
  ["I'm running npm install and it fails.", []],
  ["use jest mocks", []],
  ["use npm scripts", []],
  // A placeholder, a day, a colour or a number is no value.
  ["The deploy is Friday.", []],
  ["CI is Red again", []],
  ["Auth: TODO", []],
  ["DB: TBD", []],
  ["lint: 3", []],
  ["the database is postgres, it's PG15", ["db.engine=postgres"]],
  // An instruction is one task, not the repo's practice.
  ["install the dependencies with npm", []],
  ["lint with biome", []],
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

describe("the cheap test before reading (`mayStateSlot`)", () => {
  test("never rejects a text that states a slot: every row of the table that states one passes for that slot", () => {
    for (const [text] of TABLE)
      for (const { slot } of slotsIn(text)) {
        expect(mayStateSlot(text, slot)).toBe(true);
        expect(mayStateSlot(text)).toBe(true);
      }
  });

  test("rejects text naming no slot's word", () => {
    expect(mayStateSlot("refactor the retry logic in packages/wrap/src/db.ts")).toBe(false);
    expect(mayStateSlot("add input validation to apps/web/app/junk33.ts", "auth.provider")).toBe(false);
  });
});

describe("D7: the table itself", () => {
  test("the 15 launch slots, each with its default scope", () => {
    expect(([...SLOT_IDS] as string[]).sort()).toEqual(
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

  test("every slot's label is one of its aliases, so a sentence naming it reads back (the session gist's)", () => {
    for (const slot of SLOT_IDS) {
      const value = slot.endsWith(".version") ? "20" : slot === "gh.account" ? "acme-dev" : "Zitadel";
      expect(slotsIn(`The ${slotLabel(slot)} is ${value}`).map((s) => s.slot)).toEqual([slot]);
    }
  });

  test("the status lexicon is D7's", () => {
    expect([...STATUS_LEXICON].sort()).toEqual(
      "broken down failing flaky slow fixed working done weird annoying wrong fine ok good bad new old"
        .split(" ")
        .sort(),
    );
  });

  test("a status word is never a value, even capitalized", () => {
    expect(read("The database is Down.")).toEqual([]);
    expect(read("deploy target: Broken")).toEqual([]);
  });
});
