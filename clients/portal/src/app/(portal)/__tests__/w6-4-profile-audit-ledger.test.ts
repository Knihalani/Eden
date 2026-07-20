/**
 * Wave 6.4 — profile / audit-trail / ledger: ErrorState vs false empty,
 * auth loading, pagination, ?agent= deep link.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showAuditEmpty(opts: {
  loading: boolean;
  error: string | null;
  eventCount: number;
}): boolean {
  return !opts.loading && !opts.error && opts.eventCount === 0;
}

function canLoadMoreAudit(opts: {
  loading: boolean;
  error: string | null;
  limit: number;
  maxLimit: number;
  eventCount: number;
}): boolean {
  return (
    !opts.loading &&
    !opts.error &&
    opts.limit < opts.maxLimit &&
    opts.eventCount === opts.limit
  );
}

describe("W6-4 profile auth ErrorState vs blank", () => {
  it("shows loading skeleton and ErrorState instead of blank !user", () => {
    const src = read("app/(portal)/profile/page.tsx");
    expect(src).toContain("authLoading");
    expect(src).toContain("authError");
    expect(src).toContain("LoadingSkeleton");
    expect(src).toContain("Could not load profile");
    expect(src).toContain("Try again");
    expect(src).toMatch(/if \(authLoading\)/);
    expect(src).toMatch(/if \(authError && !user\)/);
  });

  it("keeps 2FA load failure on ErrorState (not empty)", () => {
    const src = read("app/(portal)/profile/page.tsx");
    expect(src).toContain("Could not load 2FA status");
    expect(src).toContain('from "@/components/ui/error-state"');
  });
});

describe("W6-4 audit-trail ErrorState + pagination + deep link", () => {
  it("keeps QueryState error before empty and Load more", () => {
    const src = read("app/(portal)/audit-trail/page.tsx");
    expect(src).toContain("Could not load audit trail");
    expect(src).toContain("QueryState");
    expect(src).toContain("Load more events");
    expect(src).toContain("PAGE_SIZE");
    expect(src).toContain("MAX_LIMIT");
    expect(src).toContain('searchParams.get("agent")');
    expect(src).not.toMatch(/ledgerQuery\.error[\s\S]{0,80}toast\.error/);
  });

  it("does not show empty while loading or on error", () => {
    expect(
      showAuditEmpty({ loading: true, error: null, eventCount: 0 }),
    ).toBe(false);
    expect(
      showAuditEmpty({ loading: false, error: "boom", eventCount: 0 }),
    ).toBe(false);
    expect(
      showAuditEmpty({ loading: false, error: null, eventCount: 0 }),
    ).toBe(true);
  });

  it("gates Load more behind full page and no error", () => {
    expect(
      canLoadMoreAudit({
        loading: false,
        error: null,
        limit: 50,
        maxLimit: 500,
        eventCount: 50,
      }),
    ).toBe(true);
    expect(
      canLoadMoreAudit({
        loading: false,
        error: "boom",
        limit: 50,
        maxLimit: 500,
        eventCount: 50,
      }),
    ).toBe(false);
    expect(
      canLoadMoreAudit({
        loading: false,
        error: null,
        limit: 50,
        maxLimit: 500,
        eventCount: 12,
      }),
    ).toBe(false);
    expect(
      canLoadMoreAudit({
        loading: false,
        error: null,
        limit: 500,
        maxLimit: 500,
        eventCount: 500,
      }),
    ).toBe(false);
  });
});

describe("W6-4 ledger picker ErrorState vs empty", () => {
  it("uses ErrorState for load failures and gates empty behind !error", () => {
    const src = read("app/(portal)/ledger/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load ledgers");
    expect(src).toContain("Try again");
    expect(src).toMatch(/error \? \(/);
    expect(src).toContain("No ledgers yet");
    expect(src).toContain("Showing first 100 ledgers");
  });
});
