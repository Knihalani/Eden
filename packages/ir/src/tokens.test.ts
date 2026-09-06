import { describe, expect, test } from "bun:test";
import {
  addTokenClass,
  billedTokens,
  emptyTokenClasses,
  IslandReply,
  providerCacheHitInput,
  providerCacheHitPct,
  reconcileTokenClasses,
  unwrapIsland,
} from "./index";

describe("token class ledger", () => {
  test("empty billed is 0", () => {
    expect(billedTokens(emptyTokenClasses())).toBe(0);
  });

  test("five classes sum to provider prompt+completion; cache is ignored", () => {
    const c = emptyTokenClasses();
    addTokenClass(c, "compiled", 10);
    addTokenClass(c, "frontier", 6);
    addTokenClass(c, "steered-skip", 0);
    c.providerCache = 1_000;
    expect(billedTokens(c)).toBe(16);
    expect(reconcileTokenClasses(c, { prompt: 12, completion: 4 })).toEqual({
      ok: true,
      billed: 16,
      provider: 16,
      delta: 0,
    });
  });

  test("mismatch fails recon", () => {
    const c = emptyTokenClasses();
    addTokenClass(c, "frontier", 3);
    expect(reconcileTokenClasses(c, { prompt: 1, completion: 1 }).ok).toBe(false);
  });

  test("providerCacheHitPct is stamped-denom; 0 when measured zero; null when unmeasured", () => {
    expect(providerCacheHitPct(1920, 2006)).toBe(1920 / 2006);
    expect(providerCacheHitInput(1920, 2006)).toBe(2006);
    expect(providerCacheHitPct(0, 100)).toBe(0);
    expect(providerCacheHitPct(0, 0)).toBe(0);
    expect(providerCacheHitPct(null, 100)).toBeNull();
    expect(providerCacheHitPct(40, null)).toBeNull();
    expect(providerCacheHitPct(undefined, undefined)).toBeNull();
    expect(providerCacheHitPct(Number.NaN, 10)).toBeNull();
  });

  test("Anthropic 40/50/10 is read+write+input, not cached/prompt subset", () => {
    expect(providerCacheHitPct(40, 50, 10)).toBe(0.4);
    expect(providerCacheHitInput(40, 50, 10)).toBe(100);
    expect(providerCacheHitPct(40, 50)).toBe(40 / 50);
    expect(providerCacheHitPct(40, 50, 10)).not.toBe(0.8);
    expect(providerCacheHitInput(100_000, 50, 0)).toBe(100_050);
    expect(providerCacheHitPct(100_000, 50, 0)).toBe(100_000 / 100_050);
    expect(providerCacheHitPct(100_000, 50, 0)).not.toBe(100_000 / 50);
    expect(providerCacheHitPct(100_000, 50, 0)).toBeLessThanOrEqual(1);
    expect(providerCacheHitPct(100_000, 50, 3_000)).toBe(100_000 / 103_050);
    expect(providerCacheHitPct(40, 50, null, 100)).toBe(0.4);
  });

  test("providerCache 800 does not change billedTokens", () => {
    const c = emptyTokenClasses();
    addTokenClass(c, "compiled", 6);
    addTokenClass(c, "frontier", 4);
    const billed = billedTokens(c);
    c.providerCache = 800;
    expect(billedTokens(c)).toBe(billed);
    expect(billedTokens(c)).toBe(10);
    expect(reconcileTokenClasses(c, { prompt: 6, completion: 4 }).ok).toBe(true);
  });
});

describe("IslandReply", () => {
  test("plain values unwrap without usage", () => {
    expect(unwrapIsland({ ok: true })).toEqual({ value: { ok: true } });
  });

  test("scraped usage rides with the value", () => {
    const r = new IslandReply({ draft: "x" }, { prompt_tokens: 80, completion_tokens: 20 });
    expect(unwrapIsland(r)).toEqual({
      value: { draft: "x" },
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    });
  });
});
