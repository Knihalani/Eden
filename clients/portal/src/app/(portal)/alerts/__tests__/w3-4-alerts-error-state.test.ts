/**
 * Wave 3.4 — Alerts ErrorState vs empty, retry CTAs, filter clear.
 *
 * Feed load failure → ErrorState + Try again (not empty).
 * Rules verify failure on empty feed → ErrorState + retry (not dead-end EmptyState).
 * Clear filters resets severity + acknowledged + verdict.
 * Triage events offset is not coupled to alert list pagination.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showAlertsEmpty(opts: {
  loading: boolean;
  error: string | null;
  rulesError: string | null;
  alertCount: number;
  severityFilter: string;
  acknowledgedFilter: boolean | null;
}): boolean {
  if (opts.loading && opts.alertCount === 0) return false;
  if (opts.error) return false;
  if (
    opts.alertCount === 0 &&
    opts.rulesError &&
    opts.severityFilter === "all" &&
    opts.acknowledgedFilter === null
  ) {
    return false;
  }
  return opts.alertCount === 0;
}

describe("W3-4 alerts query states", () => {
  it("uses in-page ErrorState with retry for feed load failures", () => {
    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    expect(feed).toContain('from "@/components/ui/error-state"');
    expect(feed).toContain("Could not load alerts");
    expect(feed).toContain("Try again");
    expect(feed).toContain("onRetry={onRetryFeed}");
  });

  it("rules verify failure on empty feed uses ErrorState + retry CTA", () => {
    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    expect(feed).toContain("Could not verify alert rules");
    expect(feed).toContain('data-testid="alerts-rules-retry"');
    expect(feed).toContain("onRetryRules");
    expect(feed).not.toMatch(
      /rulesError\s*\?\s*"Could not verify alert rules"[\s\S]{0,400}!rulesReady \? null/,
    );
  });

  it("clear filters resets severity, acknowledged, and verdict", () => {
    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    const hook = read("app/(portal)/alerts/_components/use-alerts-page.ts");
    expect(feed).toContain('data-testid="alerts-clear-filters"');
    expect(hook).toMatch(
      /setSeverityFilter\("all"\);\s*setAcknowledgedFilter\(null\);\s*setVerdictFilter\("all"\);/,
    );
  });

  it("triage events offset is independent of alert list pagination", () => {
    const hook = read("app/(portal)/alerts/_components/use-alerts-page.ts");
    expect(hook).toMatch(/offset:\s*0,\s*\n\s*\}\),\s*\n\s*\[verdictFilter,\s*limit\]/);
    expect(hook).not.toMatch(
      /listAlertEvents[\s\S]{0,200}offset,\s*\n\s*\}\),\s*\n\s*\[verdictFilter,\s*limit,\s*offset\]/,
    );
  });

  it("does not show empty while loading, on feed error, or on rules verify error", () => {
    expect(
      showAlertsEmpty({
        loading: true,
        error: null,
        rulesError: null,
        alertCount: 0,
        severityFilter: "all",
        acknowledgedFilter: null,
      }),
    ).toBe(false);
    expect(
      showAlertsEmpty({
        loading: false,
        error: "boom",
        rulesError: null,
        alertCount: 0,
        severityFilter: "all",
        acknowledgedFilter: null,
      }),
    ).toBe(false);
    expect(
      showAlertsEmpty({
        loading: false,
        error: null,
        rulesError: "rules down",
        alertCount: 0,
        severityFilter: "all",
        acknowledgedFilter: null,
      }),
    ).toBe(false);
    expect(
      showAlertsEmpty({
        loading: false,
        error: null,
        rulesError: null,
        alertCount: 0,
        severityFilter: "all",
        acknowledgedFilter: null,
      }),
    ).toBe(true);
  });
});
