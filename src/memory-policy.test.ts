/**
 * P2.1: D9's policy and intent extraction (A4 §3.1, A7 §5; R8 E3's fixes), read clause by clause from what the user
 * typed. Each rule is keyed `(class, polarity, object)`; a temporal qualifier makes it an intent.
 */
import { describe, expect, test } from "bun:test";
import { extractRules, ruleKey, rulesIn, type Rule } from "./memory-policy";

/** A text's rules as `kind:class|polarity|object`, with ` q=<qualifier>` on an intent. */
const read = (text: string) => rulesIn(text).map(show);
const show = (rule: Rule) => `${rule.kind}:${ruleKey(rule)}${rule.qualifier ? ` q=${rule.qualifier}` : ""}`;

describe("D9: an imperative on an action class, keyed (class, polarity, object)", () => {
  test("never, always and don't, one rule per clause", () => {
    expect(read("never merge PRs yourself")).toEqual(["policy:integrate|neg|*"]);
    expect(read("don't push to the remote without asking")).toEqual(["policy:push-upstream|neg|remote"]);
    expect(read("always work on a branch, never commit directly to main")).toEqual([
      "policy:branch|pos|*",
      "policy:commit|neg|main",
    ]);
    expect(read("I handle all merges, you never merge")).toEqual(["policy:integrate|neg|*"]);
    expect(read("rule: never touch the stripe webhooks")).toEqual(["policy:billing|neg|webhook"]);
  });

  test("only never and always are explicit: such a policy is a pin", () => {
    expect(rulesIn("never force-push")[0]).toMatchObject({ explicit: true, polarity: "neg" });
    expect(rulesIn("always squash when merging")[0]).toMatchObject({ explicit: true, polarity: "pos" });
    expect(rulesIn("don't force-push")[0]).toMatchObject({ explicit: false });
  });

  test("the class whose word comes first in the clause; a tie goes to the more specific class", () => {
    expect(read("don't touch main until the release is out")).toEqual(["intent:branch|neg|main q=until"]);
    expect(read("never drop tables in the prod database")).toEqual(["policy:destructive-db|neg|table"]);
    expect(read("please never git push --force on shared branches")).toEqual(["policy:history-rewrite|neg|shared"]);
    expect(read("always ask before force-pushing")).toEqual(["policy:history-rewrite|neg|*"]);
    expect(read("don't stash my changes, commit them to a wip branch")).toEqual(["policy:stash|neg|change"]);
  });

  test("a clause with no action class is no rule", () => {
    expect(read("always explain things plainly")).toEqual([]);
    expect(read("never use var in new code")).toEqual([]);
    expect(read("Reply with just OK")).toEqual([]);
  });
});

describe("D9: a temporal qualifier makes an intent", () => {
  test("yet, for now, until, this time, in this PR, today, this week", () => {
    expect(read("don't open the PR yet")).toEqual(["intent:review|neg|* q=yet"]);
    expect(read("hold off on pushing for now")).toEqual(["intent:push-upstream|neg|* q=for-now"]);
    expect(read("no merging until monday")).toEqual(["intent:integrate|neg|* q=until"]);
    expect(read("don't push this time, I want to look first")).toEqual(["intent:push-upstream|neg|* q=this-time"]);
    expect(read("don't add any dependencies in this PR")).toEqual(["intent:dependency|neg|* q=in-this-pr"]);
    expect(read("don't deploy today")).toEqual(["intent:deploy|neg|* q=today"]);
    expect(read("don't deploy this week")).toEqual(["intent:deploy|neg|* q=this-week"]);
    expect(read("not yet, don't commit")).toEqual(["intent:commit|neg|* q=yet"]);
  });

  test("fix 1: before/after a time or event is an intent; before/after a precondition clause stays a policy", () => {
    expect(read("don't deploy before the demo on friday")).toEqual(["intent:deploy|neg|* q=before"]);
    expect(read("don't push after this commit, I'll take it from here")).toEqual([
      "intent:push-upstream|neg|* q=after",
    ]);
    expect(read("only merge after CI is green")).toEqual(["policy:integrate|neg|*"]);
    expect(read("always ask before you delete a branch")).toEqual(["policy:delete|neg|branch"]);
    expect(read("you should always run the full test suite before you say it's done")).toEqual([
      "policy:complete|pos|*",
    ]);
    expect(read("never rebase before merging")).toEqual(["policy:history-rewrite|neg|*"]);
  });
});

describe("D9 fix 2: more triggers, and the wording that is no rule", () => {
  test("hold off, no <verb>ing, leave … unmerged / as a draft / alone, wait before/for, without checking with me", () => {
    expect(read("hold off on deploying")).toEqual(["policy:deploy|neg|*"]);
    expect(read("no merging, I do that")).toEqual(["policy:integrate|neg|*"]);
    expect(read("leave it unmerged")).toEqual(["policy:integrate|neg|*"]);
    expect(read("leave the PR as a draft")).toEqual(["policy:review|neg|*"]);
    expect(read("leave main alone")).toEqual(["policy:branch|neg|main"]);
    expect(read("before you merge, wait for my ok")).toEqual(["policy:integrate|neg|*"]);
    expect(read("no deploys without checking with me")).toEqual(["policy:deploy|neg|*"]);
  });

  test("don't forget to, never mind, questions and descriptive clauses are excluded", () => {
    expect(read("don't forget to push the branch when you're done")).toEqual([]);
    expect(read("never mind, delete that file")).toEqual([]);
    expect(read("why does it always fail when I merge main into my branch")).toEqual([]);
    expect(read("don't the tests cover this already?")).toEqual([]);
    expect(read("we always forget to bump the version")).toEqual([]);
    expect(read("the deploy always breaks on fridays")).toEqual([]);
    expect(read("I don't think we need the extra query, remove it")).toEqual([]);
  });
});

describe("D9 fix 3 and 4: objects", () => {
  test("a class's default object, and words that name none, key as *", () => {
    for (const text of ["never merge PRs", "don't merge it yourself", "don't merge anything, I do the merging"])
      expect(read(text)).toEqual(["policy:integrate|neg|*"]);
    expect(read("never rebase branches")).toEqual(["policy:history-rewrite|neg|*"]);
    expect(read("don't install packages without asking me first")).toEqual(["policy:dependency|neg|*"]);
    expect(read("don't deploy to production")).toEqual(["policy:deploy|neg|*"]);
    expect(read("never open pull requests on your own")).toEqual(["policy:review|neg|*"]);
  });

  test("another object keeps its own key", () => {
    expect(read("never push to main")).toEqual(["policy:push-upstream|neg|main"]);
    expect(read("never push to master")).toEqual(["policy:push-upstream|neg|main"]);
    expect(read("don't push directly to the main branch")).toEqual(["policy:push-upstream|neg|main"]);
    expect(read("never rebase shared branches")).toEqual(["policy:history-rewrite|neg|shared"]);
    expect(read("don't delete the fixtures")).toEqual(["policy:delete|neg|fixture"]);
    expect(read("don't remove the old API")).toEqual(["policy:delete|neg|old-api"]);
    expect(read("never delete migrations")).toEqual(["policy:delete|neg|migration"]);
  });

  test("protected-path: .env, infra/ and lockfiles", () => {
    expect(read("do not touch the .env file")).toEqual(["policy:protected-path|neg|.env"]);
    expect(read("never edit pnpm-lock.yaml by hand")).toEqual(["policy:protected-path|neg|pnpm-lock.yaml"]);
    expect(read("never delete anything under infra/ without asking")).toEqual(["policy:delete|neg|infra"]);
  });
});

describe("D12: only the user's own words", () => {
  test("extractRules strips pasted spans, fenced code and quotes first", () => {
    const texts = [
      "```\nnever push to main\nalways squash\n```\nturn these into a CONTRIBUTING section",
      "the doc says:\n> Don't merge on Fridays.\nshould we add that to the PR template?",
      "<pasted_content id=9>\nNever push to main.\n</pasted_content id=9>\nupdate this paragraph",
    ];
    for (const text of texts) expect(extractRules(text)).toEqual([]);
    expect(extractRules("please don't merge.\n> we always merge on fridays").map(show)).toEqual([
      "policy:integrate|neg|*",
    ]);
  });
});
