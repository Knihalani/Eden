/**
 * P2.2's compiled triggers (A7 §1 layer 3 and §5, D18, A4 §5.1 step 4b): which classes a typed prompt fires, and
 * which rule rows a fired class delivers.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryRecord } from "./index";
import { firedClasses, PER_CLASS, triggeredRows } from "./memory-triggers";

describe("firedClasses", () => {
  test("fires a class on an action word the prompt asks for or announces", () => {
    expect(firedClasses("looks done, can you land it?")).toEqual(["complete", "integrate"]);
    expect(firedClasses("commit this and push")).toEqual(["commit", "push-upstream"]);
    expect(firedClasses("put this up for review")).toEqual(["review"]);
    expect(firedClasses("let's roll this out to prod now")).toEqual(["deploy"]);
    expect(firedClasses("reset my local db, it's in a weird state")).toEqual(["destructive-db"]);
    expect(firedClasses("squash the last five commits")).toEqual(["history-rewrite", "commit"]);
  });

  test("fires on a question about doing the action", () => {
    expect(firedClasses("are we done?")).toEqual(["complete"]);
    expect(firedClasses("can we release to customers today?")).toEqual(["deploy"]);
    expect(firedClasses("should I push this?")).toEqual(["push-upstream"]);
  });

  test("fires nothing in a clause that asks for information (R1 Addendum A: topical words overfire)", () => {
    expect(firedClasses("where do prod credentials live?")).toEqual([]);
    expect(firedClasses("how do git rebase and merge differ?")).toEqual([]);
    expect(firedClasses("in general, what are the tradeoffs of soft deletes?")).toEqual([]);
    expect(firedClasses("Can you remind me how Stripe webhooks work?")).toEqual([]);
    expect(firedClasses("Need help with production deploy steps?")).toEqual([]);
    expect(firedClasses("I added a helper, what should I run before pushing?")).toEqual([]);
    // the clause that asks for the action still fires
    expect(firedClasses("what changed? merge it when CI is green")).toEqual(["integrate"]);
    expect(firedClasses("how about we merge it now")).toEqual(["integrate"]);
  });

  test("reads main and master as a branch only where a branch is meant", () => {
    expect(firedClasses("refactor the main function")).toEqual([]);
    expect(firedClasses("rebase onto main")).toEqual(["history-rewrite", "branch"]);
    expect(firedClasses("update the main branch")).toEqual(["branch"]);
  });

  test("orders the classes by where the prompt first names them", () => {
    expect(firedClasses("deploy it, then merge the PR")).toEqual(["deploy", "integrate", "review"]);
  });
});

let seq = 0;
/** A rule row; rows are made in the order they were stated. */
function rule(key: string, opts: { src?: string } = {}): MemoryRecord {
  seq++;
  return {
    id: `r${seq}`,
    text: `rule ${seq} on ${key}`,
    kind: "constraint",
    at: seq,
    seq,
    tags: [`src:${opts.src ?? "user"}`],
    rules: [{ k: key }],
  };
}

describe("triggeredRows", () => {
  test("delivers at most 2 rows of a fired class, the newest first", () => {
    const rows = [rule("integrate|neg|*"), rule("integrate|pos|main"), rule("integrate|neg|dependabot")];
    expect(PER_CLASS).toBe(2);
    expect(triggeredRows(rows, ["integrate"]).map((row) => row.id)).toEqual([rows[2]!.id, rows[1]!.id]);
  });

  test("ranks the rows the user stated before the others (A7 §5)", () => {
    const own = rule("deploy|neg|*");
    const other = rule("deploy|neg|friday", { src: "sleep" });
    expect(triggeredRows([own, other], ["deploy"]).map((row) => row.id)).toEqual([own.id, other.id]);
  });

  test("takes every class's first row before any class's second", () => {
    const [merge0, push0, merge1, push1] = [
      rule("integrate|neg|*"),
      rule("push-upstream|neg|*"),
      rule("integrate|neg|main"),
      rule("push-upstream|neg|main"),
    ];
    const order = triggeredRows([merge0!, push0!, merge1!, push1!], ["push-upstream", "integrate"]);
    expect(order.map((row) => row.id)).toEqual([push1!.id, merge1!.id, push0!.id, merge0!.id]);
  });

  test("delivers a row keyed on two fired classes once", () => {
    const merge = rule("integrate|neg|*");
    const push = rule("push-upstream|neg|*");
    const both: MemoryRecord = {
      ...rule("integrate|neg|main"),
      rules: [{ k: "integrate|neg|main" }, { k: "push-upstream|neg|main" }],
    };
    const order = triggeredRows([merge, push, both], ["push-upstream", "integrate"]);
    expect(order.map((row) => row.id)).toEqual([both.id, push.id, merge.id]);
  });

  test("delivers nothing for a class no row is keyed on", () => {
    expect(triggeredRows([rule("integrate|neg|*")], ["deploy"])).toEqual([]);
  });
});
