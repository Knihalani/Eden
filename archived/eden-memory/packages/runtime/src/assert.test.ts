import { describe, expect, test } from "bun:test";
import { evalAssert } from "../src/assert";

describe("assert expr", () => {
  test("and/or/not", () => {
    const prev = { ok: true, n: 2 };
    const steps = new Map<string, unknown>([["v", { verified: true }]]);
    expect(evalAssert("ok == true && n == 2", prev, {}, steps)).toBe(true);
    expect(evalAssert("ok == false || steps.v.verified == true", prev, {}, steps)).toBe(true);
    expect(evalAssert("!ok", prev, {}, steps)).toBe(false);
    expect(evalAssert(".5 == 0.5", prev, {}, steps)).toBe(true);
    expect(evalAssert("x == y", { x: {}, y: { a: 1 } }, {}, steps)).toBe(false);
  });

  test("short-circuiting operands are still parsed", () => {
    // The cases above only cover the branch where the right operand has to be
    // evaluated. When the result is already decided, the parser must still
    // consume the right operand's tokens — otherwise the expression fails as
    // "trailing assert tokens" and a false assertion surfaces as a thrown
    // error instead of a clean deopt.
    const steps = new Map<string, unknown>();
    expect(evalAssert("ok == true && n == 2", { ok: false, n: 2 }, {}, steps)).toBe(false);
    expect(evalAssert("ok == true || n == 2", { ok: true, n: 0 }, {}, steps)).toBe(true);
    expect(evalAssert("a == 1 && b == 2 && c == 3", { a: 9, b: 2, c: 3 }, {}, steps)).toBe(false);
    expect(evalAssert("a == 1 || b == 2 || c == 3", { a: 1, b: 0, c: 0 }, {}, steps)).toBe(true);
    expect(evalAssert("(ok == true && n == 1) || n == 2", { ok: false, n: 2 }, {}, steps)).toBe(true);
  });
});
