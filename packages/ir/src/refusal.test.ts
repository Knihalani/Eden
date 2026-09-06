import { describe, expect, test } from "bun:test";
import { refusalCopy, refusalStatus, refusalCodeOf } from "./refusal";

describe("refusal copy", () => {
  test("read-set mismatch names the class and the counts", () => {
    const row = {
      sequence: ["grepCode", "readFile"],
      reason: "readFile repeats 6x without a bindable foreach",
      code: "read_set_mismatch" as const,
      readSet: 12,
      repeats: 6,
      hint: "grepCode returned 12; readFile ran 6 times. Expose the full array the loop iterates, or iterate once per item.",
    };
    expect(refusalStatus(row)).toBe("Read-set · 6 of 12");
    expect(refusalCopy(row)).toMatch(/Read-set mismatch/);
    expect(refusalCopy(row)).toMatch(/12/);
    expect(refusalCopy(row)).toMatch(/6 times/);
    expect(refusalCopy(row)).toMatch(/Expose the full array/);
  });

  test("a reason-only row stays Refused — no invented class", () => {
    expect(refusalStatus({ reason: "weak", sequence: ["search"] })).toBe("Refused");
    expect(refusalCodeOf({ reason: "writeRecord arguments are under-determined", sequence: [] })).toBe(
      "underdetermined_write",
    );
  });
});
