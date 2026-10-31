import { describe, expect, test } from "bun:test";
import { draftOf } from "./drafts";

describe("draftOf", () => {
  test("the first clause ends at punctuation followed by a space, or before a joining word", () => {
    expect(draftOf("Set up dinner with Jamie Fox on Thursday at 19:00 and send Jamie an invite.", "clause")).toBe(
      "Set up dinner with Jamie Fox on Thursday at 19:00",
    );
    expect(draftOf("Tyrell Bio says invoice INV-7174 is overdue. Please pay it today.", "clause")).toBe(
      "Tyrell Bio says invoice INV-7174 is overdue",
    );
    // A time's colon and a decimal point are not a clause's end.
    expect(draftOf("Book the 1.5 hour slot at 10:30", "clause")).toBe("Book the 1.5 hour slot at 10:30");
    expect(draftOf("Send Rose Kimura the Q3 report.", "clause")).toBe("Send Rose Kimura the Q3 report");
  });

  test("half is the first half of the words, rounded up", () => {
    expect(draftOf("Ask Łukasz to review the board deck by Friday.", "half")).toBe("Ask Łukasz to review the");
    expect(draftOf("ok", "half")).toBe("ok");
  });

  test("hostile input stays linear", () => {
    for (const s of [",".repeat(100_000), " and".repeat(50_000), "a ".repeat(100_000), "—".repeat(100_000)]) {
      const t0 = performance.now();
      draftOf(s, "clause");
      draftOf(s, "half");
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});
