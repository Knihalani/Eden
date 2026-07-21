/**
 * Wave 6 — Analytics embeds: thin panels, no full-app embeds, soft-delete leaves.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6 Analytics hub thin panels", () => {
  it("6.1 hub is overview + progressive tabs without EmbeddedSurface full apps", () => {
    const src = read("app/(portal)/analytics/page.tsx");
    expect(src).toContain('data-wave6-analytics="thin-panels"');
    expect(src).toContain('ANALYTICS_TABS = ["overview"');
    expect(src).toContain("InsightsPanel");
    expect(src).toContain("TopicsPanel");
    expect(src).toContain("ToolsPanel");
    expect(src).toContain("UsersPanel");
    expect(src).not.toContain("EmbeddedSurface");
    expect(src).not.toMatch(
      /dynamic\(\(\) => import\("@\/app\/\(portal\)\/(users|tools|insights)/,
    );
    expect(src.split("\n").length).toBeLessThan(450);
  });

  it("6.2 users thin panel = table + drawer", () => {
    const panel = read("app/(portal)/analytics/_components/users-panel.tsx");
    expect(panel).toContain('data-wave6-analytics="users-thin"');
    expect(panel).toContain("DataTable");
    expect(panel).toContain("SheetContent");
    expect(panel).toContain("onRowClick");
    expect(panel).toContain("QueryState");
    expect(panel).not.toContain("PageHeader");
    expect(panel).not.toContain("<Card");
  });

  it("6.3 tools thin panel kills accent pill toggles", () => {
    const panel = read("app/(portal)/analytics/_components/tools-panel.tsx");
    expect(panel).toContain('data-wave6-analytics="tools-thin"');
    expect(panel).toContain('variant="underline"');
    expect(panel).not.toContain('variant="pills"');
    expect(panel).not.toContain('embedded ? "pills"');
    expect(panel).not.toContain("<Card");
  });

  it("6.4 insights thin panel caps widgets + QueryState", () => {
    const panel = read("app/(portal)/analytics/_components/insights-panel.tsx");
    expect(panel).toContain('data-wave6-analytics="insights-thin"');
    expect(panel).toContain("QueryState");
    expect(panel).toContain('data-testid="insights-kpi-cap"');
    expect(panel).toContain("MAX_RECENT");
    expect(panel).not.toContain("StatCard");
    expect(panel).not.toContain("closed-loop");
    expect(panel).not.toContain("PageHeader");
  });

  it("6.5 topics leaf is dense QueryState list", () => {
    const panel = read("app/(portal)/analytics/_components/topics-panel.tsx");
    expect(panel).toContain('data-wave6-analytics="topics-dense"');
    expect(panel).toContain("QueryState");
    expect(panel).toContain("py-1.5");
    expect(panel).not.toContain("PageHeader");
    expect(panel).toContain("traceHref");
    expect(panel).not.toMatch(/\/traces\/\$\{/);
  });

  it("6.6–6.7 soft-delete top-level leaves (no double headers)", () => {
    for (const [rel, tab] of [
      ["app/(portal)/users/page.tsx", "users"],
      ["app/(portal)/tools/page.tsx", "tools"],
      ["app/(portal)/insights/page.tsx", "insights"],
      ["app/(portal)/insights/topics/page.tsx", "topics"],
    ] as const) {
      const src = read(rel);
      expect(src).toContain(`router.replace("/analytics?tab=${tab}")`);
      expect(src).not.toContain("PageHeader");
      expect(src.split("\n").length).toBeLessThan(40);
    }
    const cfg = read("../next.config.ts");
    expect(cfg).toContain('source: "/users"');
    expect(cfg).toContain('source: "/tools"');
    expect(cfg).toContain('source: "/insights"');
  });

  it("6.8 Chart/StatCard quiet contracts", () => {
    expect(read("components/ui/stat-card.tsx")).toContain("quiet?: boolean");
    expect(read("components/ui/section.tsx")).toContain('data-chart-quiet="true"');
    const overview = read("app/(portal)/analytics/page.tsx");
    expect(overview).not.toContain("<Panel");
    expect(overview).toContain("Quiet KPI");
  });

  it("6.9 CrossLinkBar diet", () => {
    const bar = read("components/portal-os/CrossLinkBar.tsx");
    expect(bar).toContain('data-wave6-crosslink="diet"');
    expect(bar).toContain("maxLinks = 4");
    expect(bar).toContain("Related");
    expect(bar).not.toContain("bg-[var(--accent-faint)]");
  });

  it("ships panel modules on disk", () => {
    for (const f of [
      "app/(portal)/analytics/_components/users-panel.tsx",
      "app/(portal)/analytics/_components/tools-panel.tsx",
      "app/(portal)/analytics/_components/insights-panel.tsx",
      "app/(portal)/analytics/_components/topics-panel.tsx",
    ]) {
      expect(existsSync(resolve(portalSrc, f)), f).toBe(true);
    }
  });
});
