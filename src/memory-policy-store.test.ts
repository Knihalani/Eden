/**
 * P2.1 in the store (D9, A4 §3.1, L8, A7 §5): a typed rule row carries its `(class, polarity, object)` keys, an
 * intent expires after 7 days and is never a pin, `never`/`always` pins a policy, and a policy is superseded only by
 * the opposite polarity on its key or by a revocation. In the ledger, a rule's key is its cid and gives its value
 * tokens.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, storeRows, superseded, type MemoryRecord } from "./index";
import { ledgerKey } from "./memory-ledger";
import { INTENT_TTL_MS } from "./memory-policy";
import { invalidationsIn, readInvalidations, recordInvalidations, validText } from "./memory-validity";
import { keyValueTokens, summaryTokens } from "./memory-value-tokens";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const REPO = "a1b2c3d4e5f60718";

const dirs: string[] = [];
const savedNow = process.env.EDEN_NOW;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = savedNow;
});

function store(session = "s1") {
  const dir = mkdtempSync(join(tmpdir(), "eden-policy-"));
  dirs.push(dir);
  process.env.EDEN_NOW = String(T0);
  return openMemory({ dir, session });
}

/** What the user typed, as the hook gives it to `observe`. */
const typed = (content: string) => ({ role: "user", content, src: "user" });

function ruleRow(mem: ReturnType<typeof store>, words: string): MemoryRecord {
  const row = mem.memories().find((r) => r.text.includes(words));
  if (!row) throw new Error(`no row says "${words}"`);
  return row;
}

describe("D9: a typed rule row carries its keys", () => {
  test("a policy: its key, the rule kind, and no expiry", () => {
    const mem = store();
    mem.observe([typed("Don't merge PRs yourself.")]);
    const row = ruleRow(mem, "merge PRs");
    expect(row.kind).toBe("constraint");
    expect(row.rules).toEqual([{ k: "integrate|neg|*" }]);
    expect(row.validUntil).toBeUndefined();
    expect(row.tags ?? []).not.toContain("pin");
  });

  test("never and always pin a policy", () => {
    const mem = store();
    mem.observe([typed("Never force-push to shared branches.")]);
    mem.observe([typed("Always squash when merging.")]);
    expect(ruleRow(mem, "force-push").tags).toContain("pin");
    expect(ruleRow(mem, "squash").tags).toContain("pin");
  });

  test("an intent expires after 7 days and is never a pin, even with always", () => {
    const mem = store();
    mem.observe([typed("Don't open the PR yet.")]);
    mem.observe([typed("Always rebase onto main for now.")]);
    const notYet = ruleRow(mem, "open the PR");
    expect(notYet.rules).toEqual([{ k: "review|neg|*", q: "yet" }]);
    expect(notYet.validUntil).toBe(T0 + INTENT_TTL_MS);
    expect(notYet.tags ?? []).not.toContain("pin");
    expect(ruleRow(mem, "rebase onto main").tags ?? []).not.toContain("pin");
  });

  test("the keys and the expiry are on disk", () => {
    const mem = store();
    mem.observe([typed("Don't open the PR yet.")]);
    mem.close();
    const row = storeRows(join(mem.jsonlDir, "memories.jsonl")).find((r) => r.text.includes("open the PR"));
    expect(row?.rules).toEqual([{ k: "review|neg|*", q: "yet" }]);
    expect(row?.validUntil).toBe(T0 + INTENT_TTL_MS);
  });

  test("text the user did not type states no rule (A4 §3.0)", () => {
    const mem = store();
    mem.observe([{ role: "assistant", content: "Never merge PRs yourself." }]);
    mem.observe([{ role: "user", content: "Never merge PRs yourself.", src: "tool" }]);
    for (const row of mem.memories()) {
      expect(row.rules).toBeUndefined();
      expect(row.kind).not.toBe("constraint");
    }
  });

  test("D9's excluded wording is no rule: don't forget to, never mind", () => {
    const mem = store();
    mem.observe([typed("Don't forget to delete the debug logs before you finish.")]);
    mem.observe([typed("Never mind the tests, commit what you have.")]);
    for (const row of mem.memories()) {
      expect(row.kind).not.toBe("constraint");
      expect(row.tags ?? []).not.toContain("pin");
    }
  });
});

describe("L8: a policy is superseded only by the opposite polarity on its key, or a revocation", () => {
  test("the opposite polarity moves the older row to history", () => {
    const mem = store();
    mem.observe([typed("Always squash when merging.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("Never squash.")]);
    expect(superseded(ruleRow(mem, "Always squash"))).toBe(true);
    expect(superseded(ruleRow(mem, "Never squash"))).toBe(false);
  });

  test("a revocation moves the rule it revokes to history, and no other", () => {
    const mem = store();
    mem.observe([typed("Never merge PRs yourself.")]);
    mem.observe([typed("Never push to main.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("You can merge PRs yourself now.")]);
    expect(superseded(ruleRow(mem, "Never merge"))).toBe(true);
    expect(superseded(ruleRow(mem, "Never push"))).toBe(false);
  });

  test("a revocation on another branch leaves the main branch's rule", () => {
    const mem = store();
    mem.observe([typed("Don't push directly to the main branch.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("You can push to the feature branch now.")]);
    expect(ruleRow(mem, "main branch").rules).toEqual([{ k: "push-upstream|neg|main" }]);
    expect(superseded(ruleRow(mem, "main branch"))).toBe(false);
  });

  test("another object, or a row with a rule left standing, is not superseded", () => {
    const mem = store();
    mem.observe([typed("Never push to main.")]);
    mem.observe([typed("Always work on a branch, never commit directly to main.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("Always push to the remote.")]);
    mem.observe([typed("Always commit directly to main.")]);
    expect(superseded(ruleRow(mem, "Never push to main"))).toBe(false);
    expect(superseded(ruleRow(mem, "work on a branch"))).toBe(false);
  });

  test("the validity log keeps the opposition: older text stating the overturned rule loses that sentence", () => {
    const opposed = invalidationsIn("Never squash.", 1);
    expect(opposed).toEqual([{ k: "oppose", r: "history-rewrite|pos|*|squash", t: 1 }]);
    expect(invalidationsIn("Don't squash yet.", 1)).toEqual([]);
    expect(validText("Always squash when merging.", 0, opposed)).toBe("");
    expect(validText("Always squash when merging. Never merge PRs yourself.", 0, opposed)).toBe(
      "Never merge PRs yourself.",
    );
    expect(validText("Always squash when merging, never push to main.", 0, opposed)).toBe("never push to main.");
    expect(validText("Always squash when merging.", 2, opposed)).toBe("Always squash when merging.");
  });

  test("a permission lifts no narrowed prohibition; a prohibition overturns a narrowed permission", () => {
    const mem = store();
    mem.observe([typed("Never merge PRs without a review.")]);
    mem.observe([typed("Always squash when merging.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("You can merge now.")]);
    mem.observe([typed("Never squash.")]);
    expect(superseded(ruleRow(mem, "without a review"))).toBe(false);
    expect(superseded(ruleRow(mem, "Always squash"))).toBe(true);
  });

  test("the log reads each key's newest opposition only, so its cost is bounded by the keys", () => {
    const root = mkdtempSync(join(tmpdir(), "eden-policy-log-"));
    dirs.push(root);
    for (let t = 1; t <= 500; t++) recordInvalidations(root, "Never squash.", t);
    expect(readInvalidations(root)).toEqual([{ k: "oppose", r: "history-rewrite|pos|*|squash", t: 500 }]);
    const many = Array.from({ length: 500 }, (_, n) => ({
      k: "oppose" as const,
      r: `delete|pos|thing${n}-file|delet`,
      t: 2,
    }));
    const notes = Array.from({ length: 200 }, (_, n) => `Always delete the thing${n % 50} files. Never push to main.`);
    const started = performance.now();
    for (const note of notes) validText(note, 1, many);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(validText("Always delete the thing7 files. Never push to main.", 1, many)).toBe("Never push to main.");
  });

  test("validText drops an intent's clause 7 days after the text was said (A4 §5.1 step 5)", () => {
    const mixed = "Never force-push, and don't open the PR yet.";
    process.env.EDEN_NOW = String(T0 + INTENT_TTL_MS - 1);
    expect(validText(mixed, T0, [])).toBe(mixed);
    process.env.EDEN_NOW = String(T0 + INTENT_TTL_MS);
    expect(validText(mixed, T0, [])).toBe("Never force-push.");
  });

  test("one action of a class does not overturn another: never force-push leaves always squash", () => {
    const mem = store();
    mem.observe([typed("Always squash when merging.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("Never force-push.")]);
    expect(superseded(ruleRow(mem, "Always squash"))).toBe(false);
    expect(ruleRow(mem, "force-push").rules).toEqual([{ k: "history-rewrite|neg|*", v: "force-push" }]);
    const cid = (row: MemoryRecord) => ledgerKey(row, REPO).cid;
    expect(cid(ruleRow(mem, "force-push"))).not.toBe(cid(ruleRow(mem, "Always squash")));
  });

  test("text the user did not type supersedes nothing", () => {
    const mem = store();
    mem.observe([typed("Always squash when merging.")]);
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([{ role: "assistant", content: "Never squash." }]);
    expect(superseded(ruleRow(mem, "Always squash"))).toBe(false);
  });
});

describe("A7 §5: a rule's key is its ledger cid and gives its value tokens", () => {
  const rule = (text: string, k: string) => ({ id: text, text, kind: "constraint", rules: [{ k }] });

  test("two rows of one key share a cid and a ver; another key does not", () => {
    const one = ledgerKey(rule("Never merge PRs yourself.", "integrate|neg|*"), REPO);
    const two = ledgerKey(rule("Don't merge anything, I do the merging.", "integrate|neg|*"), REPO);
    const other = ledgerKey(rule("Never merge to main.", "integrate|neg|main"), REPO);
    expect(two.cid).toBe(one.cid);
    expect(two.ver).toBe(one.ver);
    expect(one.cid).toMatch(new RegExp(`^${REPO.slice(0, 8)}/P:`));
    expect(other.cid).not.toBe(one.cid);
    expect(one.rule).toBe(true);
  });

  test("the class and the object; a class's default object for *, and none without one", () => {
    expect(keyValueTokens([{ k: "push-upstream|neg|main" }])).toEqual(["@push-upstream", "main"]);
    expect(keyValueTokens([{ k: "integrate|neg|*" }])).toEqual(["@integrate", "pr"]);
    expect(keyValueTokens([{ k: "delete|neg|old-api" }])).toEqual(["@delete", "old", "api"]);
    expect(keyValueTokens([{ k: "commit|neg|*" }])).toEqual([]);
    expect(keyValueTokens([{ k: "integrate|neg|*" }, { k: "commit|neg|*" }])).toEqual([]);
  });

  test("a summary names a default object by its synonyms", () => {
    const tokens = summaryTokens("The user said pull requests are never merged by the agent.");
    for (const token of keyValueTokens([{ k: "integrate|neg|*" }])) expect(tokens.has(token)).toBe(true);
    expect(summaryTokens("Nothing goes to production on fridays.").has("prod")).toBe(true);
    expect(summaryTokens("No new dependencies.").has("package")).toBe(true);
  });
});
