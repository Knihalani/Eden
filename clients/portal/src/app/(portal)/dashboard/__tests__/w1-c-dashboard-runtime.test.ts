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

/** Mirror of dashboard first-run derivation (keep in sync with hook). */
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
    const src = read(
      "app/(portal)/dashboard/_components/use-home-dashboard.ts",
    );
    expect(src).not.toMatch(/setInstallPath/);
    expect(src).not.toMatch(
      /useState\(true\);\s*\n\s*useEffect\(\(\) => \{[\s\S]*?setInstallPath/,
    );
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
    const sidebar = read("components/portal-chrome/SidebarNav.tsx");
    const header = read("components/portal-chrome/PortalHeader.tsx");
    const logoNullCount =
      (sidebar.match(/<Logo[^>]*href=\{null\}/g) ?? []).length +
      (header.match(/<Logo[^>]*href=\{null\}/g) ?? []).length;
    expect(logoNullCount).toBeGreaterThanOrEqual(2);
    expect(sidebar).not.toMatch(
      /TooltipTrigger asChild>\{\s*linkWithPin\s*\}/,
    );
  });

  it("gates cost/alerts shards behind layoutReady + show(widget)", () => {
    const src = read(
      "app/(portal)/dashboard/_components/use-home-dashboard.ts",
    );
    expect(src).toMatch(/layoutReady/);
    expect(src).toMatch(
      /enabled:\s*layoutReady\s*&&\s*show\(["']cost["']\)/,
    );
    expect(src).toMatch(/show\(["']failures["']\)/);
    expect(src).not.toContain("agenticQuery");
    expect(src).not.toContain('show("agentic")');
  });

  it("KPI restraint strip has no nested card anchors", () => {
    const kpi = read(
      "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
    );
    expect(kpi).toContain('data-home-shell-kpi="restraint"');
    expect(kpi).not.toContain("<Link");
    expect(kpi).not.toContain("<Card");
    expect(kpi).not.toMatch(/from ["']@\/components\/ui\/stat-card["']/);
  });
});
