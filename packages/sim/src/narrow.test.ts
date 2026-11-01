import { describe, expect, test } from "bun:test";
import { narrowQuestion } from "./narrow";

describe("narrowQuestion", () => {
  test("a name, an object and the action as a noun", () => {
    expect(narrowQuestion("Approve the 15% discount Globex asked for on the renewal.")).toBe(
      "Globex discount approval?",
    );
    expect(narrowQuestion("Reserve a table for six at Hoppers on the 31st, around 7:30pm.")).toBe(
      "Hoppers table reservation?",
    );
  });

  test("openers, days and amounts are dropped; a request that opens with a name acts at its verb", () => {
    expect(narrowQuestion("Can I take Wednesday afternoon off to go to the match?")).toBe("time off?");
    expect(narrowQuestion("Pay the outstanding £340 plumbing invoice today.")).toBe("outstanding payment?");
    expect(narrowQuestion("Tyrell Bio says invoice INV-4054 is overdue. Please pay it today.")).toBe(
      "Tyrell Bio payment?",
    );
  });

  test("deterministic, and never empty", () => {
    const q = "Send Rose Kimura the Q3 report.";
    expect(narrowQuestion(q)).toBe(narrowQuestion(q));
    expect(narrowQuestion("")).toBe("?");
  });
});
