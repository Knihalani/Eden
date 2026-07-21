/**
 * W5-A — Ledger picker / audit-trail / guardrails load-error polish.
 *
 * Load failures must use in-page ErrorState (not EmptyState / toast-only).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5-A ledger picker error vs empty", () => {
  it("uses ErrorState for load failures and gates empty behind !error", () => {
    const src = read("app/(portal)/ledger/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load ledgers");
    expect(src).toContain("Try again");
    expect(src).toMatch(/if \(error\)/);
    expect(src).toContain("No ledgers yet");
    expect(src).toContain('value="promotions"');
  });
});

describe("W5-A audit-trail load toast removed", () => {
  it("keeps QueryState error title and does not toast on ledgerQuery.error", () => {
    const src = read("app/(portal)/audit-trail/_components/chain-panel.tsx");
    expect(src).toContain("Could not load audit trail");
    expect(src).toContain("QueryState");
    expect(src).toContain("Load more events");
    expect(src).not.toMatch(/ledgerQuery\.error[\s\S]{0,80}toast\.error/);
  });
});

describe("W5-A guardrails scan history", () => {
  it("uses ErrorState for scan history and does not toast on loadScanHistory", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    const inj = read("app/(portal)/guardrails/_components/injections-tab.tsx");
    const pii = read("app/(portal)/guardrails/_components/pii-tab.tsx");
    const src = [page, inj, pii].join("\n");
    expect(src).toContain("Could not load injection history");
    expect(src).toContain("Could not load PII history");
    expect(src).not.toMatch(/Couldn't load scan history/);
    expect(page).toContain("loadScanHistory");
    expect(page).not.toMatch(/toast\.(error|success).*scan history/i);
  });
});
