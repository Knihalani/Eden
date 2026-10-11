import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const shown = (text: string) =>
  invalidationsIn(text, 1).map((r) =>
    r.k === "retract" ? `retract:${r.o}` : r.k === "revoke" ? `revoke:${r.c}:${r.o.join("+")}` : `oppose:${r.r}`,
  );

describe("A4 §3.1, D7: what invalidates a value", () => {
  test("a retraction or a switch with a 'we' subject, of a capitalized or identifier-shaped value ending its clause", () => {
    const cases: [string, string[]][] = [
      ["We no longer use Redis.", ["retract:redis"]],
      ["we don't use Jest anymore", ["retract:jest"]],
      ["We're not using Jest anymore.", ["retract:jest"]],
      ["We dropped Sentry.", ["retract:sentry"]],
      ["We no longer use Redis, so drop the cache flag.", ["retract:redis"]],
      ["We switched apps/web from Auth0 to Clerk.", ["retract:auth0"]],
      ["We migrated the queue from SQS to Kafka.", ["retract:sqs"]],
    ];
    for (const [text, expected] of cases) expect(shown(text)).toEqual(expected);
  });

  test("questions, conditionals, other subjects, common words, paths, pasted spans and longer names invalidate nothing", () => {
    for (const text of [
      "Should we use pnpm instead of npm?",
      "What if we no longer use Redis?",
      "If we switched from Postgres to MySQL, what breaks?",
      "I moved the date helper from src to lib.",
      "Look at the logs instead of the code.",
      "use a Set for the lookup instead of an array",
      "use a map instead of the nested loops",
      "We switched the handlers from src/old to src/new.",
      "we no longer use the old helper",
      "> We no longer use Jest.",
      "```\nWe no longer use Redis.\n```",
      "<pasted_content id=1>\nWe no longer use Redis.\n</pasted_content id=1>",
      "We dropped Sentry\nthen the build\nkept failing",
      "fix the failing test in src/app.ts",
      "which auth provider does apps/web use?",
      "We no longer run CI on Fridays.",
      "We no longer use the AWS SDK v2.",
      "We no longer use Node 16.",
      "We stopped using Docker Compose.",
      "We no longer use GitHub Actions for deploys.",
      "We no longer have PRs open on the old repo.",
      "We no longer use the API key in CI.",
      "We dropped Sentry last week.",
      "Use POST instead of GET for this endpoint.",
      "Use Map instead of Object.",
      "Please use Error instead of String.",
      "Use Set, not Array.",
      "We use pnpm, not npm_v6.",
    ])
      expect(shown(text)).toEqual([]);
  });
});

describe("D7: a value shaped by its capitals alone is matched as typed", () => {
  const after = (said: string, text: string) => validText(text, 50, invalidationsIn(said, 100));

  test("the same English word, in lower case or opening a sentence, is not the value", () => {
    const kept: [string, string][] = [
      ["We no longer use Make.", "Make sure the zebra API returns JSON errors with a code field."],
      ["We no longer use Make.", "[fact · 0m] Make sure the zebra API returns JSON errors."],
      ["We switched from Next to Remix.", "The next release ships on Friday."],
      ["We no longer use Go.", "Go ahead and run the migrations after the deploy."],
      ["We no longer use React.", "The dashboard should react to config changes without a reload."],
      ["We dropped Express.", "Express the dates in UTC in the API."],
      [
        "We moved the login handler from GET to POST.",
        "The login handler should get the user from the session cookie.",
      ],
    ];
    for (const [said, text] of kept) expect(after(said, text)).toBe(text);
  });

  test("the value as typed, or opening a sentence as its subject, is", () => {
    const dropped: [string, string][] = [
      ["We no longer use Make.", "The build runs on Make."],
      ["We no longer use React.", "React is our UI library."],
      ["We no longer use Redis.", "redis is our cache"],
      ["We moved the login handler from GET to POST.", "The login handler answers GET requests."],
      ["We switched apps/web from Auth0 to Clerk.", "the auth provider is auth0"],
    ];
    for (const [said, text] of dropped) expect(after(said, text)).toBe("");
  });
});

describe("D7: a switch stays within its scope and subject", () => {
  const after = (switched: string) => (text: string) => validText(text, 50, invalidationsIn(switched, 100));
  test("a scoped switch keeps the value in another scope", () => {
    const valid = after("We switched packages/cli from Postgres to SQLite.");
    expect(valid("apps/web uses Postgres.")).toBe("apps/web uses Postgres.");
    expect(valid("packages/cli uses Postgres.")).toBe("");
    expect(valid("packages/cli/src/db.ts opens Postgres.")).toBe("");
    expect(valid("The database is Postgres.")).toBe("");
  });

  test("a switch of a subject keeps the value for another subject", () => {
    const docs = after("We moved the docs from Notion to GitHub.");
    expect(docs("Design specs live in Notion.")).toBe("Design specs live in Notion.");
    expect(docs("The docs live in Notion.")).toBe("");
    const queue = after("We migrated the queue from SQS to Kafka.");
    expect(queue("The job queue runs on SQS.")).toBe("");
    expect(queue("Logs are archived to SQS.")).toBe("Logs are archived to SQS.");
  });
});

describe("A4 §3.1, D9: what revokes a rule", () => {
  test("'you can <action> … now' with an A7 §5 action verb, keeping its object, and the prohibition it lifts (P2.1)", () => {
    expect(shown("You can merge PRs yourself now.")).toEqual(["revoke:integrate:pr", "oppose:integrate|neg|*"]);
    expect(shown("You can merge now.")).toEqual(["revoke:integrate:", "oppose:integrate|neg|*"]);
    expect(shown("You can push the feature branch now.")).toEqual([
      "revoke:push-upstream:feature+branch",
      "oppose:push-upstream|neg|feature",
    ]);
  });

  test("other verbs, questions and statements about the user are no revocation", () => {
    for (const text of ["You can run the tests now.", "You can use the staging server now.", "Can you merge it now?"])
      expect(shown(text)).toEqual([]);
  });

  test("a revocation drops a rule of its class on its object, and nothing else", () => {
    const kept = (rule: string, permit: string) => validText(rule, 50, invalidationsIn(permit, 100));
    expect(kept("Push the fix to the PR, but don't merge it yourself", "You can merge PRs yourself now.")).toBe("");
    expect(kept("Never merge PRs yourself", "You can merge PRs yourself now.")).toBe("");
    expect(kept("Don't merge it yourself.", "You can merge now.")).toBe("");
    const unrevoked: [string, string][] = [
      ["Never push directly to main.", "You can merge PRs yourself now."],
      ["Never push directly to main.", "You can push the feature branch now."],
      ["Never merge PRs without a review.", "You can merge now."],
      ["Never delete the main branch.", "You can delete the branch now."],
      ["Don't push directly to the main branch.", "You can push to the feature branch now."],
      ["Never merge PRs without a review.", "You may merge PR 12 now."],
      ["Never merge.", "You may merge PR 12 now."],
      ["Never install packages globally.", "You can install the types package now."],
      ["Never drop the production table.", "You can drop the test table now."],
      ["Don't deploy on Fridays without checking the PR.", "You can deploy the PR preview now."],
      ["Never remove the audit logs.", "You can remove the old logs now."],
      ["Never run database migrations against production.", "You can run the tests now."],
      ["Never run database migrations against production.", "You can use the staging server now."],
    ];
    for (const [rule, permit] of unrevoked) expect(kept(rule, permit)).toBe(rule);
  });

  test("a class's default object counts as no object (D9 fix 3: pr, branch, package, prod)", () => {
    const kept = (rule: string, permit: string) => validText(rule, 50, invalidationsIn(permit, 100));
    const revoked: [string, string][] = [
      ["Never merge PRs yourself.", "You can merge now."],
      ["Don't merge the PR yourself.", "You can merge now."],
      ["Don't merge it yourself.", "You can merge PRs yourself now."],
      ["Don't push the branch.", "You can push now."],
      ["Never deploy to prod yourself.", "You can deploy now."],
    ];
    for (const [rule, permit] of revoked) expect(kept(rule, permit)).toBe("");
  });

  test("a revoked rule goes with the clauses that qualify it; a retracted clause goes alone", () => {
    expect(validText("Never push to main; ask first.", 50, invalidationsIn("You can push to main now.", 100))).toBe("");
    expect(
      validText("stack uses Redis; the queue runs on SQS.", 50, invalidationsIn("We no longer use Redis.", 100)),
    ).toBe("the queue runs on SQS.");
  });

  test("a retraction never supersedes a rule sentence, even beside a fact it does supersede", () => {
    const records = [...invalidationsIn("We no longer use Redis.", 100)];
    expect(validText("Never flush Redis in production.", 50, records)).toBe("Never flush Redis in production.");
    expect(validText("stack uses Redis", 50, records)).toBe("");
    expect(validText("stack uses Redis. Push the fix to the PR, but don't merge it yourself.", 50, records)).toBe(
      "Push the fix to the PR, but don't merge it yourself.",
    );
  });

  test("a revocation of an unknown class in the log is ignored", () => {
    const root = tempRoot();
    writeFileSync(join(root, "validity.jsonl"), '{"k":"revoke","c":"branch","o":[],"t":9}\n');
    expect(readInvalidations(root)).toEqual([]);
  });
});

describe("A4 §5.1 step 5: validity at delivery", () => {
  const records = [
    ...invalidationsIn("We no longer use Redis.", 100),
    ...invalidationsIn("We switched apps/web from Auth0 to Clerk.", 100),
  ];

  test("a sentence older than an invalidation that still names its value is dropped", () => {
    expect(validText("stack uses Redis", 50, records)).toBe("");
    expect(validText("in apps web the auth provider is Auth0, and the database is postgres", 50, records)).toBe("");
    expect(validText("stack uses Redis. Never commit .env files", 50, records)).toBe("Never commit .env files");
  });

  test("newer text, the change itself, and the value inside a path or a filename stay", () => {
    expect(validText("We use Redis again", 150, records)).toBe("We use Redis again");
    expect(validText("We switched apps/web from Auth0 to Clerk", 50, records)).toBe(
      "We switched apps/web from Auth0 to Clerk",
    );
    expect(validText("redis.conf sets maxmemory", 50, records)).toBe("redis.conf sets maxmemory");
    expect(validText("see vendor/redis/README", 50, records)).toBe("see vendor/redis/README");
    expect(validText("stack uses Redis", 50, [])).toBe("stack uses Redis");
  });
});

describe("the validity log", () => {
  test("a prompt's invalidations are appended, owner-only, and read back", () => {
    const root = tempRoot();
    recordInvalidations(root, "fix the tests", 1);
    recordInvalidations(root, "We no longer use Redis. You can merge PRs yourself now.", 2);
    expect(readInvalidations(root)).toEqual([
      { k: "retract", o: "redis", t: 2, f: "Redis" },
      { k: "revoke", c: "integrate", o: ["pr"], t: 2 },
      { k: "oppose", r: "integrate|neg|*", t: 2 },
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

describe("P0.2 review round 4, closed in P0.3", () => {
  const after = (said: string, text: string) => validText(text, 50, invalidationsIn(said, 100));

  test("plural objects and subjects match their singular, whatever the stem ends in", () => {
    expect(after("We migrated the caches from Memcached to Redis.", "The cache runs on Memcached.")).toBe("");
    expect(after("You can delete the caches now.", "Never delete the cache.")).toBe("");
    expect(after("You can delete the prizes now.", "Never delete the prize.")).toBe("");
    expect(after("You can delete the release branches now.", "Never delete the release branch.")).toBe("");
    expect(after("You can delete the caches now.", "Never delete the cache table.")).toBe(
      "Never delete the cache table.",
    );
  });

  test("a capital-shaped value opening a clause after a label, colon or list marker is not the value", () => {
    for (const text of [
      "Note: Make sure the zebra API returns JSON errors.",
      "1. Make sure the zebra API returns JSON errors.",
      "- Make sure the zebra API returns JSON errors.",
    ])
      expect(after("We no longer use Make.", text)).toBe(text);
    expect(after("We no longer use Make.", "Note: Make is our build tool.")).toBe("");
    // After a comma a capital marks a name, not a clause opening, so these clauses name the value.
    expect(after("We no longer use Make.", "The build needs Redis, Make and Docker.")).toBe("");
    expect(after("We no longer use Make.", "Before the deploy, Make sure the zebra API returns JSON errors.")).toBe("");
  });

  test("what is left of a dropped item is not a bare list marker", () => {
    expect(after("We switched the database from SQLite to Postgres.", "1. The database is SQLite")).toBe("");
    expect(
      after("We switched the database from SQLite to Postgres.", "1. The database is SQLite. 2. Logs go to stdout."),
    ).toBe("2. Logs go to stdout.");
  });

  test("a revocation keeps a joined rule about another action", () => {
    expect(after("You can merge now.", "Never merge PRs yourself; never push to main.")).toBe("never push to main.");
    expect(after("You can merge now.", "Never merge PRs yourself, never push to main.")).toBe("never push to main.");
    expect(after("You can push to main now.", "Never push to main; ask first.")).toBe("");
  });
});
