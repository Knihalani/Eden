/**
 * D9's pins (`memory-pins.ts`): which rules are pins, what sleep promotes, and what a session that types a rule's
 * text again records on the one row the store keeps for it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import { isPinnedRule, pinnedText, policyRecurrences, promotions } from "./memory-pins";
import { invalidationsIn } from "./memory-validity";

const row = (id: string, text: string, rules: MemoryRecord["rules"], ep = "e0", extra: Partial<MemoryRecord> = {}) =>
  ({ id, text, kind: "constraint", at: 1, rules, ep, ...extra }) as MemoryRecord;

describe("which rules are pins", () => {
  test("a promoted policy, or a policy of a row that pins itself; never an intent", () => {
    expect(isPinnedRule({}, { k: "integrate|neg|*", p: true })).toBe(true);
    expect(isPinnedRule({ tags: ["pin"] }, { k: "integrate|neg|*" })).toBe(true);
    expect(isPinnedRule({ tags: ["pin"] }, { k: "review|neg|*", q: "yet" })).toBe(false);
    expect(isPinnedRule({}, { k: "integrate|neg|*" })).toBe(false);
  });

  test("a row's pinned text keeps only its pinned rules' clauses", () => {
    const both = row("r1", "Don't merge PRs yourself, and don't delete the fixtures.", [
      { k: "integrate|neg|*", p: true },
      { k: "delete|neg|fixture" },
    ]);
    expect(pinnedText(both)).toBe("Don't merge PRs yourself.");
    expect(pinnedText({ ...both, rules: [{ k: "integrate|neg|*" }, { k: "delete|neg|fixture" }] })).toBe("");
  });
});

describe("promotion at sleep (D9)", () => {
  const merge = [{ k: "integrate|neg|*" }];

  test("2 sessions promote every row stating the rule; 1 session does not", () => {
    expect(promotions([row("a", "Don't merge PRs yourself.", merge, "e1")], []).size).toBe(0);
    const promoted = promotions(
      [row("a", "Don't merge PRs yourself.", merge, "e1"), row("b", "Never merge it yourself, ok?", merge, "e2")],
      [],
    );
    expect([...promoted.keys()].sort()).toEqual(["a", "b"]);
    expect(promoted.get("a")).toEqual([{ k: "integrate|neg|*", p: true }]);
  });

  test("a row's eps counts the sessions that typed it again", () => {
    const promoted = promotions([row("a", "Don't merge PRs yourself.", merge, "e1", { eps: ["e2"] })], []);
    expect(promoted.get("a")).toEqual([{ k: "integrate|neg|*", p: true }]);
  });

  test("a rule a later revocation took is no recurrence; an already promoted row is not patched again", () => {
    const revoked = invalidationsIn("You can merge PRs yourself now.", 5);
    const rows = [row("a", "Don't merge PRs yourself.", merge, "e1"), row("b", "Don't merge PRs.", merge, "e2")];
    expect(promotions(rows, []).size).toBe(2);
    expect(promotions(rows, revoked).size).toBe(0);
    const done = rows.map((r) => ({ ...r, rules: [{ k: "integrate|neg|*", p: true as const }] }));
    expect(promotions(done, []).size).toBe(0);
  });

  test("intents never promote, and two actions of history-rewrite are two rules", () => {
    const intent = [{ k: "review|neg|*", q: "yet" as const }];
    const rows = [row("a", "Don't open the PR yet.", intent, "e1"), row("b", "Don't open the PR yet.", intent, "e2")];
    expect(promotions(rows, []).size).toBe(0);
    const squash = row("s", "Don't squash.", [{ k: "history-rewrite|neg|*", v: "squash" }], "e1");
    const force = row("f", "Don't force-push.", [{ k: "history-rewrite|neg|*", v: "force-push" }], "e2");
    expect(promotions([squash, force], []).size).toBe(0);
  });

  test("policy_recur: a typed policy another session stated, as a policy or an intent", () => {
    const rows = [row("a", "Don't open the PR yet.", [{ k: "review|neg|*", q: "yet" }], "e1")];
    expect(policyRecurrences(rows, "Don't open the PR.", "e2")).toEqual(["review|neg|*"]);
    expect(policyRecurrences(rows, "Don't open the PR.", "e1")).toEqual([]);
    expect(policyRecurrences(rows, "Don't open the PR yet.", "e2")).toEqual([]);
  });
});

describe("a rule typed again word for word (one row)", () => {
  let dir = "";
  const prev = process.env.EDEN_MEMORY_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eden-pins-"));
    process.env.EDEN_MEMORY_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
    else process.env.EDEN_MEMORY_DIR = prev;
  });

  const say = (session: string, uuid: string, reread = false) => {
    const mem = openMemory({ dir, session, perRepo: true });
    mem.observe([{ role: "user", content: "Don't merge PRs yourself.", src: "user", uuid }], { reread });
    mem.close();
  };
  const merges = () =>
    openMemory({ dir, perRepo: true })
      .memories()
      .filter((r) => r.rules?.length);

  test("another session records itself on the row; its own session, a re-read or a copied line does not", () => {
    say("s1", "u1");
    say("s1", "u2");
    say("s2", "u1");
    say("s3", "u3", true);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]!.eps).toBeUndefined();
    say("s2", "u4");
    expect(merges()).toHaveLength(1);
    expect(merges()[0]!.eps).toHaveLength(1);
  });
});
