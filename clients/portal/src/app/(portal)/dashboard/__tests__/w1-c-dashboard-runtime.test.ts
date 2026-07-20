/**
 * W1-C — Dashboard runtime crashes (max-update-depth + nested <a>).
 *
 * Source-level regression: first-run must be derived (no installPath
 * effect), and chrome Logos must not nest anchors.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirror of dashboard first-run derivation (keep in sync with page.tsx). */
function deriveIsFirstRun(opts: {
  hasTraceTraffic: boolean;
  isError: boolean;
  honestlyEmpty: boolean;
  softMissing: boolean;
  settled: boolean;
}): boolean {
  const {
    hasTraceTraffic,
    isError,
    honestlyEmpty,
    softMissing,
    settled,
  } = opts;
  return (
    !hasTraceTraffic &&
    !isError &&
    (honestlyEmpty || softMissing || !settled)
  );
}

describe("W1-C dashboard runtime", () => {
  it("derives isFirstRun without installPath setState effect", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).not.toMatch(/setInstallPath/);
    expect(src).not.toMatch(/useState\(true\);\s*\n\s*useEffect\(\(\) => \{[^}]*setInstallPath/s);
    expect(src).toMatch(/const isFirstRun =/);
    expect(src).toMatch(/!tracesQuery\.isError/);
  });

  it("leaves install path on hard traces error (outage → banner, not checklist)", () => {
    expect(
      deriveIsFirstRun({
        hasTraceTraffic: false,
        isError: true,
        honestlyEmpty: false,
        softMissing: false,
        settled: true,
      }),
    ).toBe(false);
  });

  it("stays install-forward while unsettled or soft-empty", () => {
    expect(
      deriveIsFirstRun({
        hasTraceTraffic: false,
        isError: false,
        honestlyEmpty: false,
        softMissing: false,
        settled: false,
      }),
    ).toBe(true);
    expect(
      deriveIsFirstRun({
        hasTraceTraffic: false,
        isError: false,
        honestlyEmpty: true,
        softMissing: false,
        settled: true,
      }),
    ).toBe(true);
    expect(
      deriveIsFirstRun({
        hasTraceTraffic: false,
        isError: false,
        honestlyEmpty: false,
        softMissing: true,
        settled: true,
      }),
    ).toBe(true);
  });

  it("exits install path once traffic exists", () => {
    expect(
      deriveIsFirstRun({
        hasTraceTraffic: true,
        isError: false,
        honestlyEmpty: false,
        softMissing: false,
        settled: true,
      }),
    ).toBe(false);
  });

  it("chrome Logos use href={null} inside outer Link (no nested <a>)", () => {
    const chrome = read("app/(portal)/portal-chrome.tsx");
    // Both sidebar + mobile header Logos must opt out of Logo's default Link.
    const logoNullCount = (chrome.match(/<Logo[^>]*href=\{null\}/g) ?? []).length;
    expect(logoNullCount).toBeGreaterThanOrEqual(2);
    // TooltipTrigger must not wrap a div that contains the nav <a>.
    expect(chrome).not.toMatch(
      /TooltipTrigger asChild>\{\s*linkWithPin\s*\}/,
    );
  });

  it("gates cost/alerts/agentic shards behind layoutReady + show(widget)", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toMatch(/layoutReady/);
    expect(src).toMatch(/enabled:\s*layoutReady\s*&&\s*show\(["']cost["']\)/);
    expect(src).toMatch(/enabled:\s*layoutReady\s*&&\s*!orgSyncing\s*&&\s*show\(["']anomalies["']\)/);
    expect(src).toMatch(/enabled:\s*layoutReady\s*&&\s*show\(["']agentic["']\)/);
  });

  it("latency/throughput wrap Card (div) in a single Link — no nested anchors", () => {
    const latency = read(
      "app/(portal)/dashboard/_components/latency-card.tsx",
    );
    const throughput = read(
      "app/(portal)/dashboard/_components/throughput-card.tsx",
    );
    for (const src of [latency, throughput]) {
      expect(src).toMatch(/<Link[\s\S]*?<Card/);
      expect(src).not.toMatch(/<Card[\s\S]*?<Link/);
      expect(src).not.toMatch(/<a[\s>]/);
    }
  });
});
