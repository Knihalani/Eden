/**
 * Wave 10.2 — error / empty / loading consistency for remaining
 * settings surfaces that Waves 3–6 left on ad-hoc banners or
 * false-empty defaults.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W10-2 error-empty-loading consistency", () => {
  it("analytics tab uses ErrorState + retry, EmptyState, and Skeleton", () => {
    const src = read("app/(portal)/settings/_components/analytics-tab.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('from "@/components/ui/empty-state"');
    expect(src).toContain('from "@/components/ui/skeleton"');
    expect(src).toContain('title="Could not load analytics"');
    expect(src).toContain("Try again");
    expect(src).toContain('title="No analytics data yet"');
    expect(src).toContain("if (error)");
    expect(src).toMatch(/if \(error\) \{[\s\S]*<ErrorState/);
    expect(src).not.toMatch(
      /if \(error\) \{[\s\S]*bg-\[var\(--error-dim\)\]/,
    );
  });

  it("SCIM tab gates Disabled toggle behind ErrorState on load failure", () => {
    const src = read("app/(portal)/settings/_components/scim-tab.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load SCIM configuration"');
    expect(src).toContain("queryError && !config");
    expect(src).toContain("configQuery.refetch()");
    // Must not soft-render the status card when config is missing after error.
    expect(src).toMatch(
      /if \(queryError && !config\) \{[\s\S]*ErrorState[\s\S]*return/,
    );
  });

  it("billing tab hides false $0 KPIs on load failure; ErrorState for retryable", () => {
    const src = read("app/(portal)/settings/_components/billing-tab.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("showUsage = plan != null && !planError");
    expect(src).toContain("{showUsage && (");
    expect(src).toContain("isPaidPlansDisabledError");
    expect(src).toContain("featureGatedErrorCopy");
    expect(src).toContain("Try again");
  });

  it("org-tab transfer members use ErrorState (not false empty list)", () => {
    const src = read(
      "app/(portal)/settings/_components/transfer-ownership-section.tsx",
    );
    expect(src).toContain('title="Could not load members"');
    expect(src).toContain("membersError");
    expect(src).toContain("membersQuery.refetch()");
    expect(src).toMatch(
      /membersError \? \([\s\S]*ErrorState[\s\S]*\) : members\.length > 0/,
    );
  });

  it("autonomous tab surfaces schedule/policy load failures with ErrorState", () => {
    const src = read("app/(portal)/settings/_components/autonomous-tab.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load improvement schedule"');
    expect(src).toContain('title="Could not load autonomy policy"');
    expect(src).toContain("n23ScheduleError");
    expect(src).toContain("n22PolicyError");
    expect(src).not.toMatch(
      /catch \{\s*if \(!cancelled\) \{\s*setN23Schedule\(DEFAULT_N23_SCHEDULE\)/,
    );
  });
});
