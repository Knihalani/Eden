/**
 * Wave 5 — Issues + Alerts master–detail declutter.
 * Exit: Issues/Alerts scannable without config chrome fighting the feed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W5 issues master–detail", () => {
  it("Issues hub uses CoreResourcePage / ResourcePageShell contract", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain("IssuesDetailPanel");
    expect(src).toContain("useResourceUrlState");
    expect(src).toContain("bulkBar=");
    expect(src).toContain("TOP_TABS");
    expect(src).toContain('incidents: "Incidents"');
    const panel = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(panel).toContain("DetailPanelShell");
  });

  it("Issue full-page detail is evidence-first with actions secondary", () => {
    const src = read("app/(portal)/issues/[id]/page.tsx");
    expect(src).toContain('data-testid="issue-detail-evidence-first"');
    expect(src).toContain("IssueStumblesList");
    expect(src).toContain("IssueDetailHeader");

    const header = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(header).toContain('data-testid="issue-detail-actions"');
    expect(header).toContain("DropdownMenu");
    expect(header).toMatch(/Resolve[\s\S]*Actions|Actions[\s\S]*Resolve/);
    // Primary Resolve is the solid default CTA — not a 7-button wall
    expect(header).not.toMatch(
      /mt-space-4 flex flex-wrap gap-space-2">\s*<Button[\s\S]*Re-triage[\s\S]*Export fixture[\s\S]*Save regression[\s\S]*View improvement/,
    );
  });

  it("list detail panel leads with Evidence", () => {
    const panel = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(panel).toContain('data-testid="issues-detail-evidence"');
    expect(panel).toContain('data-testid="issues-detail-slim"');
  });

  it("peek includes stumble→trace scent with preserve params", () => {
    const panel = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(panel).toContain("IssueStumblesList");
    expect(panel).toContain("compact");
    expect(panel).toContain("preserveFromSearchParams");

    const stumbles = read("app/(portal)/issues/_components/issue-stumbles-list.tsx");
    expect(stumbles).toContain('data-testid="issues-detail-stumbles-peek"');
    expect(stumbles).toContain("preserve");

    const triage = read("app/(portal)/issues/_components/issue-triage-panel.tsx");
    expect(triage).toContain("traceHref(tid, preserve, { spanId: span })");
    expect(triage).not.toMatch(/trace_id=/);
  });
});

describe("W5 incidents IA", () => {
  it("Incidents are Issues tab only; /incidents redirects", () => {
    const issues = read("app/(portal)/issues/page.tsx");
    expect(issues).toContain('TOP_TABS = ["issues", "incidents"]');
    expect(issues).toContain("IncidentsView");
    expect(issues).toContain("EmbeddedSurface");

    const nextCfg = readFileSync(
      resolve(__dirname, "../../../../next.config.ts"),
      "utf8",
    );
    expect(nextCfg).toMatch(
      /source:\s*"\/incidents"[\s\S]*destination:\s*"\/issues\?tab=incidents"/,
    );

    const sidebar = read("lib/sidebar-config.ts");
    expect(sidebar).not.toMatch(/href:\s*"\/incidents"/);
    expect(sidebar).not.toMatch(/label:\s*"Incidents"/);
  });
});

describe("W5 alerts feed declutter", () => {
  it("severity chips + clear filters; Rules/Channels not in feed viewport", () => {
    const page = read("app/(portal)/alerts/page.tsx");
    const strip = read("app/(portal)/alerts/_components/alerts-severity-strip.tsx");
    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    expect(strip).toContain('data-testid="alerts-severity-strip"');
    expect(feed).toContain('data-testid="alerts-clear-filters"');
    expect(page).toContain("AlertRulesSheet");
    expect(page).toContain('data-testid="alerts-more-rules"');
    expect(page).toContain('data-testid="alerts-more-channels"');
    expect(page).toContain('data-testid="alerts-more-signals"');
    // No inline Rules panel fighting the feed
    expect(page).not.toMatch(/\{rulesOpen && \([\s\S]*AlertRulesPanel/);
    expect(page).not.toContain("Megaphone");
  });

  it("detail Ack is primary; config secondary", () => {
    const detail = read("app/(portal)/alerts/_components/alerts-detail-panel.tsx");
    expect(detail).toContain('data-testid="alerts-detail-ack"');
    expect(detail).toContain("Configure rules");
    expect(detail).toContain("Open channel settings");
    // Ack button appears before More overflow in headerActions
    const ackIdx = detail.indexOf('data-testid="alerts-detail-ack"');
    const moreIdx = detail.indexOf('aria-label="More actions"');
    expect(ackIdx).toBeGreaterThan(-1);
    expect(moreIdx).toBeGreaterThan(ackIdx);
  });

  it("Rules live in a sheet; Channels link to Settings", () => {
    const sheet = read("app/(portal)/alerts/_components/alert-rules-sheet.tsx");
    expect(sheet).toContain('data-testid="alerts-rules-sheet"');
    expect(sheet).toContain('data-testid="alerts-channels-settings-link"');
    expect(sheet).toContain("/settings?tab=security");
    expect(sheet).toContain("SheetContent");
  });

  it("Signals quiet entry from Alerts More only", () => {
    const src = read("app/(portal)/alerts/page.tsx");
    expect(src).toContain('data-testid="alerts-more-signals"');
    // Feed is the only underline tab; Signals is not a peer TabsTrigger
    expect(src).toMatch(/TabsTrigger[^>]*value="feed"/);
    expect(src).not.toMatch(/TabsTrigger[^>]*value="signals"/);
  });

  it("uses U20 empty / filter-empty copy", () => {
    const polish = read("lib/portal-polish.ts");
    expect(polish).toContain("alerts:");
    expect(polish).toContain("alertsClear:");
    expect(polish).toMatch(/U20_FILTER_EMPTY_COPY[\s\S]*alerts:/);

    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    expect(feed).toContain("U20_EMPTY_COPY");
    expect(feed).toContain("U20_FILTER_EMPTY_COPY");
    expect(feed).toContain("U20_EMPTY_COPY.alerts");
    expect(feed).toContain("U20_FILTER_EMPTY_COPY.alerts");
  });

  it("Alert → Traces preserves pastHours / q / realm / outcome / agent_id", () => {
    const detail = read("app/(portal)/alerts/_components/alerts-detail-panel.tsx");
    const page = read("app/(portal)/alerts/page.tsx");
    expect(detail).toContain("traceHref");
    expect(detail).toContain("tracesFilteredHref");
    expect(detail).toContain("mergeTracePreserve");
    expect(detail).toContain("preserveFromRecord");
    expect(detail).toContain('data-testid="alerts-detail-traces-link"');
    expect(detail).not.toMatch(/href=\{\s*"\/traces"\s*\}/);
    expect(page).toContain("preserveFromSearchParams");
    expect(page).toContain("tracesFilteredHref");
    expect(page).toContain('data-testid="alerts-more-traces"');
    expect(page).toContain("preserve={pagePreserve}");
    expect(page).not.toMatch(/<Link href="\/traces">Traces<\/Link>/);
  });

  it("filtered-empty considers verdictFilter (Wave 0 gap)", () => {
    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    expect(feed).toContain("verdictFilter");
    expect(feed).toMatch(
      /severityFilter !== "all"[\s\S]*acknowledgedFilter !== null[\s\S]*verdictFilter !== "all"/,
    );
    expect(feed).toContain("No alerts match");
    expect(feed).toContain('data-testid="alerts-filtered-empty"');
  });

  it("density: feed + strip + rules avoid decorative card soup", () => {
    const feed = read("app/(portal)/alerts/_components/alerts-feed.tsx");
    const strip = read("app/(portal)/alerts/_components/alerts-severity-strip.tsx");
    const sheet = read("app/(portal)/alerts/_components/alert-rules-sheet.tsx");
    expect(feed).toContain('divide-y divide-[var(--border-subtle)]');
    expect(feed).not.toMatch(/rounded-lg bg-\[var\(--bg-primary\)\] p-space-3/);
    expect(feed).not.toMatch(/p-space-2 rounded-lg flex-shrink-0[\s\S]*config\.bg/);
    expect(strip).not.toMatch(/rounded-md px-space-2\.5.*ring-1 ring-current/);
    expect(sheet).toContain("divide-y divide-[var(--border-subtle)]");
    expect(sheet).not.toContain("rounded-lg bg-[var(--bg-tertiary)]/50 p-space-3");
  });

  it("Traces → Alerts create-alert prefills pastHours and q", () => {
    const hub = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(hub).toMatch(
      /handleCreateAlertFromFilters[\s\S]*params\.set\("pastHours", pastHours\)[\s\S]*params\.set\("q", query\)/,
    );
    expect(hub).toMatch(
      /\[router,\s*pastHours,\s*query\]/,
    );
    const sheet = read("app/(portal)/alerts/_components/alert-rules-sheet.tsx");
    expect(sheet).toContain("pastHours?: string");
    expect(sheet).toContain("prefillFilters.pastHours");
    expect(sheet).toContain("prefillFilters.q");
  });
});


describe("W5 BulkActionBar collision", () => {
  it("hides on mobile when FAB present (default hideOnMobile)", () => {
    const bar = read("components/portal-os/BulkActionBar.tsx");
    expect(bar).toContain("hideOnMobile");
    expect(bar).toContain("hidden lg:flex");
    expect(bar).toContain('data-hide-on-mobile');

    const issues = read("app/(portal)/issues/page.tsx");
    expect(issues).toContain("hideOnMobile");

    const alerts = read("app/(portal)/alerts/page.tsx");
    expect(alerts).toContain("hideOnMobile");
    expect(alerts).toContain("bulkBar=");
  });
});
