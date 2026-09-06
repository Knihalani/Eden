import { describe, expect, test } from "bun:test";
import { dcPct, dcShare, type TokenClasses } from "./dc";

const empty: TokenClasses = {
  compiled: 0,
  memoized: 0,
  transparent: 0,
  steeredSkip: 0,
  frontier: 0,
};

describe("DC% frozen formula (ROADMAP §13 / Arc 1 catcher)", () => {
  test("empty ledger is 0, not NaN", () => {
    expect(dcShare(empty)).toBe(0);
    expect(dcPct(empty)).toBe(0);
  });

  test("numerator is compiled+memoized+transparent+steeredSkip over frontier", () => {
    expect(
      dcShare({ compiled: 4, memoized: 1, transparent: 2, steeredSkip: 3, frontier: 10 }),
    ).toBe(10 / 20);
    expect(dcPct({ compiled: 1, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 1 })).toBe(50);
  });

  test("providerCache is ignored even when huge", () => {
    const base: TokenClasses = {
      compiled: 1,
      memoized: 0,
      transparent: 0,
      steeredSkip: 0,
      frontier: 1,
      providerCache: 1_000_000,
    };
    expect(dcShare(base)).toBe(0.5);
    expect(dcShare({ ...base, providerCache: 0 })).toBe(0.5);
  });
});
