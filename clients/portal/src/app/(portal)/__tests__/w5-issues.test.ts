/**
 * Wave 5 V2 — Issues list + detail (Issues-only; Alerts = Wave 4).
 * Exit: master–detail, status presets, slim detail, ≤350 modules, deep links, Signals quiet, axe.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { U20_SERIOUS_AXE_ROUTES } from "@/lib/portal-polish";
import {
  improveHref,
  CROSS_LINK_MATRIX,
  traceHref,
  preserveFromSearchParams,
} from "@/lib/portal-cross-links";
import { ISSUE_STATUS_VIEW_PRESETS } from "../issues/_components/issue-status-views";

const portalSrc = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function loc(rel: string): number {
  return read(rel).split("\n").length;
}

describe("W5.1 Issues master–detail shell", () => {
  it("uses CoreResourcePage / ResourcePageShell contract", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain("useResourceUrlState");
    expect(src).toContain("bulkBar=");
    expect(src).toContain("TOP_TABS");
    expect(src).toContain('incidents: "Incidents"');
    expect(src).toContain("IssuesDetailPanel");
    expect(src).toContain("IssuesList");
  });

  it("list shell stays ≤400 LOC", () => {
    expect(loc("app/(portal)/issues/page.tsx")).toBeLessThanOrEqual(400);
  });
});

describe("W5.2 Status as saved views", () => {
  it("exposes status presets into ViewsMenu via ResourceOsToolbar", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain("viewPresets={ISSUE_STATUS_VIEW_PRESETS}");
    expect(src).toContain('resourceKey="issues"');
    expect(src).toContain('key: "status"');
    expect(ISSUE_STATUS_VIEW_PRESETS.some((p) => p.id === "preset:open")).toBe(true);
    expect(ISSUE_STATUS_VIEW_PRESETS[0]?.state.filter?.status).toBe("open");

    const toolbar = read("components/portal-os/ResourceOsToolbar.tsx");
    expect(toolbar).toContain("viewPresets");
    expect(toolbar).toContain("presets={viewPresets}");

    const menu = read("components/portal-os/ViewsMenu.tsx");
    expect(menu).toContain('data-testid="views-status-presets"');
  });
});

describe("W5.3–5.4 Detail slim + badge burial", () => {
  it("list detail is evidence + one primary Improve action", () => {
    const panel = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(panel).toContain('data-testid="issues-detail-evidence"');
    expect(panel).toContain('data-testid="issues-detail-slim"');
    expect(panel).toContain('data-testid="issues-detail-one-action"');
    expect(panel).toContain("Open Improve");
    expect(panel).toContain("improveHref");
    expect(panel).toContain("StatusBadge");
  });

  it("full-page detail is evidence-first with Resolve primary", () => {
    const src = read("app/(portal)/issues/[id]/page.tsx");
    expect(src).toContain('data-testid="issue-detail-evidence-first"');
    expect(src).toContain("IssueDetailHeader");
    expect(src).toContain("IssueStumblesList");

    const header = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(header).toContain('data-testid="issue-detail-actions"');
    expect(header).toContain("Resolve");
    expect(header).toContain("StatusBadge");
    expect(header).toMatch(/Resolve[\s\S]*Actions|Actions[\s\S]*Resolve/);
  });

  it("issue badges wrap StatusBadge family only", () => {
    const badges = read("app/(portal)/issues/_components/issue-badges.tsx");
    expect(badges).toContain("IssueWorkflowBadge as StatusBadge");
    expect(badges).toContain("IssuePriorityBadge as IssueSeverityBadge");
  });
});

describe("W5.5 Incidents as Issues tab", () => {
  it("Incidents are Issues tab only; /incidents redirects", () => {
    const issues = read("app/(portal)/issues/page.tsx");
    expect(issues).toContain('TOP_TABS = ["issues", "incidents"]');
    expect(issues).toContain("IncidentsView");
    expect(issues).toContain("EmbeddedSurface");

    const nextCfg = readFileSync(resolve(__dirname, "../../../../next.config.ts"), "utf8");
    expect(nextCfg).toMatch(
      /source:\s*"\/incidents"[\s\S]*destination:\s*"\/issues\?tab=incidents"/,
    );

    const sidebar = read("lib/sidebar-config.ts");
    expect(sidebar).not.toMatch(/href:\s*"\/incidents"/);
    expect(sidebar).not.toMatch(/label:\s*"Incidents"/);
  });
});

describe("W5.6 Split issues/[id] ≤350 modules", () => {
  it("page shell and modules stay under LOC caps", () => {
    expect(loc("app/(portal)/issues/[id]/page.tsx")).toBeLessThanOrEqual(350);
    const modules = [
      "app/(portal)/issues/_components/issue-detail-header.tsx",
      "app/(portal)/issues/_components/issue-stumbles-list.tsx",
      "app/(portal)/issues/_components/issue-triage-panel.tsx",
      "app/(portal)/issues/_components/issue-handoff.tsx",
      "app/(portal)/issues/_components/issue-experiment-panel.tsx",
      "app/(portal)/issues/_components/issue-regression-panel.tsx",
      "app/(portal)/issues/_components/use-issue-detail.ts",
    ];
    for (const m of modules) {
      expect(loc(m), m).toBeLessThanOrEqual(350);
    }
  });
});

describe("W5.7 Issue→Trace→Improve deep links", () => {
  it("wires improveHref + trace links on detail surfaces", () => {
    expect(improveHref("iss-1")).toBe("/improve?issue=iss-1");
    expect(improveHref()).toBe("/improve");

    const pairs = CROSS_LINK_MATRIX.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain("issue->trace");
    expect(pairs).toContain("issue->improve");

    const stumbles = read("app/(portal)/issues/_components/issue-stumbles-list.tsx");
    expect(stumbles).toContain("traceHref");
    expect(stumbles).toContain("preserve");
    expect(stumbles).toContain('data-testid="issue-trace-link"');

    const handoff = read("app/(portal)/issues/_components/issue-handoff.tsx");
    expect(handoff).toContain("improveHref");
    expect(handoff).toContain('data-testid="issue-improve-link"');
  });

  it("preserves Observe window on Issue → Trace and unifies ?traceId= dialect", () => {
    const preserve = preserveFromSearchParams(
      new URLSearchParams("pastHours=24&q=error&realm=prod&outcome=error&agent_id=a1"),
    );
    expect(preserve).toMatchObject({
      pastHours: "24",
      q: "error",
      realm: "prod",
      outcome: "error",
      agent_id: "a1",
    });
    const href = traceHref("t1", preserve, { spanId: "s1" });
    expect(href).toContain("traceId=t1");
    expect(href).toContain("spanId=s1");
    expect(href).toContain("pastHours=24");
    expect(href).not.toContain("trace_id=");

    const stumbles = read("app/(portal)/issues/_components/issue-stumbles-list.tsx");
    expect(stumbles).toContain("traceHref(");
    expect(stumbles).toContain("preserve");

    const triage = read("app/(portal)/issues/_components/issue-triage-panel.tsx");
    expect(triage).toContain("preserve");
    expect(triage).toContain("traceHref(tid, preserve, { spanId: span })");
    expect(triage).not.toMatch(/trace_id=/);
    expect(triage).toContain('view: "debug"');

    const hook = read("app/(portal)/issues/_components/use-issue-detail.ts");
    expect(hook).toContain("preserveFromSearchParams");
    expect(hook).toContain("preserve");
  });
});

describe("W5.7b Issues peek evidence → trace scent", () => {
  it("list peek shows live stumbles compact, not only summary counts", () => {
    const panel = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(panel).toContain("IssueStumblesList");
    expect(panel).toContain("compact");
    expect(panel).toContain("preserveFromSearchParams");
    expect(panel).toContain("agentIssuesApi");
    expect(panel).toContain("stumbles");

    const stumbles = read("app/(portal)/issues/_components/issue-stumbles-list.tsx");
    expect(stumbles).toContain('data-testid="issues-detail-stumbles-peek"');
    expect(stumbles).toContain("QueryState");
    expect(stumbles).toContain("compact");
    expect(stumbles).toMatch(/maxRows|COMPACT_MAX_ROWS/);
  });
});

describe("W5.8 Empty copy", () => {
  it("uses U20 empty / filter-empty copy", () => {
    const list = read("app/(portal)/issues/_components/issues-list.tsx");
    expect(list).toContain("U20_EMPTY_COPY.issues");
    expect(list).toContain("U20_FILTER_EMPTY_COPY.issues");
    expect(list).toContain("Clear status filter");
  });
});

describe("W5.9 Signals quiet entry", () => {
  it("Signals is More overflow only — not a peer Issues tab", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain('data-testid="issues-more-signals"');
    expect(src).toContain('href="/signals"');
    expect(src).not.toMatch(/TabsTrigger[^>]*value="signals"/);
    expect(src).toMatch(/TOP_TABS = \["issues", "incidents"\]/);
  });
});

describe("W5.10 Critic + axe focused", () => {
  it("adds /issues to serious axe gate", () => {
    expect([...U20_SERIOUS_AXE_ROUTES]).toContain("/issues");
    const script = readFileSync(resolve(__dirname, "../../../../scripts/audit-a11y.cjs"), "utf8");
    expect(script).toMatch(/SERIOUS_GATE_ROUTES[\s\S]*"\/issues"/);
  });

  it("ships Wave 5 critic artifact", () => {
    const critic = readFileSync(resolve(__dirname, "../../../../.wave5-critic.md"), "utf8");
    expect(critic).toMatch(/Wave 5/i);
    expect(critic).toMatch(/Issues/i);
  });
});

describe("W5 BulkActionBar collision", () => {
  it("hides on mobile when FAB present", () => {
    const issues = read("app/(portal)/issues/page.tsx");
    expect(issues).toContain("hideOnMobile");
  });
});
