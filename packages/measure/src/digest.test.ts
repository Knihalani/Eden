import { describe, expect, test } from "bun:test";
import { dcShare } from "./dc";
import {
  EMPTY_DIGEST,
  cacheHitPctOf,
  formatDcPct,
  providerCacheHitLine,
  renderDigestHtml,
  renderDigestText,
  type DigestInput,
} from "./digest";

describe("digest", () => {
  test("opt-out renders nothing", () => {
    expect(renderDigestText({ ...EMPTY_DIGEST, optIn: false })).toBeNull();
    expect(renderDigestHtml({ ...EMPTY_DIGEST, optIn: false })).toBeNull();
  });

  test("empty workspace preserves honest zeros and unmeasured DC as dash", () => {
    const text = renderDigestText(EMPTY_DIGEST)!;
    expect(text).toMatch(/0 programs/);
    expect(text).toMatch(/Compiled runs 0/);
    expect(text).toMatch(/Waiting 0/);
    expect(text).toMatch(/Failed 0/);
    expect(text).toMatch(/Tokens saved 0/);
    expect(text).toMatch(/Deterministic share —/);
    expect(text).toMatch(/Needs attention 0/);
    expect(text).not.toMatch(/Deterministic share\n/);
    expect(text).not.toMatch(/provider cache hit %/);
    expect(formatDcPct(null)).toBe("—");
    expect(formatDcPct(0)).toBe("0%");
    const html = renderDigestHtml(EMPTY_DIGEST)!;
    expect(html).toContain(">0<");
    expect(html).toContain("Needs attention 0");
    expect(html).toContain("<h2>Stretches</h2>");
    expect((html.match(/Programs/g) ?? []).length).toBe(1);
  });

  test("mirrors Home tiles when receipts exist", () => {
    const input: DigestInput = {
      optIn: true,
      compiled: 2,
      runs: 4,
      waiting: 1,
      fails: 0,
      tokensSaved: 12,
      dcPct: 60,
      dcSeries: [
        { label: "Fri", dcPct: 50, measured: true },
        { label: "Sat", dcPct: 0, measured: false },
      ],
      novelty: [{ name: "bind loop", status: "Unbound loop" }],
      stretches: [{ name: "notify", state: "live", words: ["Served", "Skipped", "Degraded"] }],
    };
    const text = renderDigestText(input)!;
    expect(text).toContain("2 programs");
    expect(text).toContain("Compiled runs 4");
    expect(text).toContain("Waiting 1");
    expect(text).toContain("Failed 0");
    expect(text).toContain("Deterministic share 60%");
    expect(text).toContain("Tokens saved 12");
    expect(text).toContain("Fri 50%");
    expect(text).toContain("Sat 0");
    expect(text).toContain("bind loop · Unbound loop");
    expect(text).toContain("Live · Served · Skipped · Degraded");
  });

  test("canary stretch is Canary, not Live", () => {
    const text = renderDigestText({
      ...EMPTY_DIGEST,
      stretches: [{ name: "notify", state: "live", rollout: "canary", words: ["Served"] }],
    })!;
    expect(text).toContain("Canary · Served");
    expect(text).not.toContain("Live · Served");
  });

  test("canary-only fleet is not Live tools N", () => {
    const text = renderDigestText({
      ...EMPTY_DIGEST,
      compiled: 1,
      canary: 1,
      stretches: [{ name: "notify", state: "live", rollout: "canary", words: ["Served"] }],
    })!;
    expect(text).toContain("1 programs · 1 Canary");
    expect(text).not.toMatch(/Live tools/);
    expect(text).toContain("Canary · Served");
  });

  test("provider cache hit % line is dialect-aware; omitted when unmeasured; 0% when measured zero", () => {
    expect(providerCacheHitLine(null, 2006)).toBeNull();
    expect(providerCacheHitLine(1920, null)).toBeNull();
    expect(cacheHitPctOf(1920, 2006)).toBe((1920 / 2006) * 100);
    expect(providerCacheHitLine(1920, 2006)).toBe(`provider cache hit % ${formatDcPct((1920 / 2006) * 100)}`);
    expect(providerCacheHitLine(0, 100)).toBe("provider cache hit % 0%");
    expect(cacheHitPctOf(100_000, 50, 0)).toBe((100_000 / 100_050) * 100);
    expect(providerCacheHitLine(100_000, 50, 0)).toBe(`provider cache hit % ${formatDcPct((100_000 / 100_050) * 100)}`);
    expect(providerCacheHitLine(100_000, 50, 0)).not.toMatch(/2000/);
    expect(cacheHitPctOf(40, 50, 10)).toBe(40);
    expect(providerCacheHitLine(40, 50, 10)).toBe("provider cache hit % 40%");
    const withHit = renderDigestText({
      ...EMPTY_DIGEST,
      compiled: 1,
      dcPct: 60,
      cacheHitPct: cacheHitPctOf(1920, 2006),
    })!;
    expect(withHit).toContain("Deterministic share 60%");
    expect(withHit).toContain("provider cache hit % 96%");
    expect(withHit).not.toMatch(/3 of 4 reads from cache/);
    const anthropic = renderDigestText({
      ...EMPTY_DIGEST,
      compiled: 1,
      cacheHitPct: cacheHitPctOf(100_000, 50, 0),
    })!;
    expect(anthropic).toContain("provider cache hit % 100%");
    expect(anthropic).not.toMatch(/200000/);
    const zero = renderDigestText({ ...EMPTY_DIGEST, compiled: 1, cacheHitPct: 0 })!;
    expect(zero).toContain("provider cache hit % 0%");
    const unmeasured = renderDigestText({ ...EMPTY_DIGEST, compiled: 1, cacheHitPct: null })!;
    expect(unmeasured).not.toMatch(/provider cache hit %/);
    const html = renderDigestHtml({
      ...EMPTY_DIGEST,
      compiled: 1,
      cacheHitPct: cacheHitPctOf(1920, 2006),
    })!;
    expect(html).toContain("provider cache hit %");
    expect(html).toContain("96%");
  });

  test("providerCache 800 does not change DC%", () => {
    const base = { compiled: 6, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 4 };
    expect(dcShare({ ...base, providerCache: 800 })).toBe(dcShare(base));
    expect(dcShare({ ...base, providerCache: 800 })).toBe(6 / 10);
  });
});
