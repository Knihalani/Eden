/**
 * Wave 9 — Improve / Settings / Advanced / AI / onboarding gate.
 * CrossLinks in overflow (not peer bands); Settings IA; Guardrails KPI calm;
 * ApprovalCard quieter; ⌘K indexes Advanced.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNavCommands } from "@/lib/nav-commands";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";

const portalSrc = resolve(__dirname, "../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W9 improve hub + children", () => {
  it("improve hub: Tabs + QueryState + mobile list; Related strip (no path overflow)", () => {
    const src = read("app/(portal)/improve/page.tsx");
    const board = read("app/(portal)/improve/_components/queue-board.tsx");
    const strip = read("app/(portal)/improve/_components/improve-related-strip.tsx");
    const runs = read("app/(portal)/improve/runs/page.tsx");
    expect(src).toContain('from "@/components/ui/tabs"');
    expect(board).toContain("<QueryState");
    expect(board).toContain('data-wave11-mobile="cards"');
    expect(runs).toContain("lg:hidden");
    expect(src).toContain('data-testid="improve-toolbar"');
    expect(strip).toContain("RELATED_LINKS");
    expect(strip).toContain('data-testid="improve-related-strip"');
    expect(src).not.toContain("PATH_LINKS");
    expect(src).not.toContain("<CrossLinkBar");
  });

  it("plans/runs/scorecard share PageHeader grammar; scorecard has no CrossLinkBar band", () => {
    for (const rel of [
      "app/(portal)/improve/plans/page.tsx",
      "app/(portal)/improve/runs/page.tsx",
      "app/(portal)/improve/scorecard/page.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain("PageHeader");
    }
    const scorecard = read("app/(portal)/improve/scorecard/page.tsx");
    expect(scorecard).not.toContain("<CrossLinkBar");
    expect(scorecard).toContain("Advanced · Improve");
    const plans = read("app/(portal)/improve/plans/page.tsx");
    expect(plans).toContain('data-testid="improve-plans-kpi"');
    expect(plans).toContain('data-testid="improve-plans-list"');
  });
});

describe("W9 artifacts / ledger / promotions / audit", () => {
  it("moat hubs discoverable without CrossLinkBar peer bands", () => {
    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).not.toContain("<CrossLinkBar");
    expect(ledger).toContain('data-testid="ledger-related-strip"');

    const promo = read("app/(portal)/promotions/page.tsx");
    expect(promo).not.toContain("<CrossLinkBar");
    expect(promo).toContain('data-testid="promotions-toolbar"');
    expect(promo).toContain('data-testid="promotions-related-strip"');

    const artifacts = read("app/(portal)/artifacts/page.tsx");
    expect(artifacts).toContain('href="/ledger"');
    expect(artifacts).toContain('href="/improve"');
    expect(artifacts).not.toContain("<CrossLinkBar");
  });

  it("audit trail: quiet toolbar + compliance tools in details", () => {
    const page = read("app/(portal)/audit-trail/page.tsx");
    const chain = read("app/(portal)/audit-trail/_components/chain-panel.tsx");
    expect(chain).toContain('data-testid="audit-trail-toolbar"');
    expect(chain).toContain("<details");
    expect(chain).toContain("Compliance tools");
    expect(page).not.toContain("<CrossLinkBar");
    expect(chain).toContain("<QueryState");
  });
});

describe("W9 settings shell + IA + FormField", () => {
  it("one Settings title; no page org Select; skeleton Suspense; Advanced collapsed", () => {
    const page = read("app/(portal)/settings/page.tsx");
    expect(page).toContain('title="Settings"');
    expect(page).not.toMatch(/<h2[^>]*>Settings<\/h2>/);
    expect(page).not.toContain("settings-org-select");
    expect(page).not.toContain("SelectTrigger");
    expect(page).toContain("fallback={<SettingsLoading />}");
    expect(page).toContain("CATEGORY_ORDER");
    expect(page).toContain("CATEGORY_LABELS");
    const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");
    for (const cat of ["Org", "Members", "Security", "Billing", "Advanced"]) {
      expect(registry).toContain(`"${cat}"`);
    }
    expect(registry).not.toContain('"Compliance"');
    expect(registry).toContain("redirectOnly: true");

    const cat = read("components/settings/settings-category-group.tsx");
    expect(cat).toContain("Advanced: true");
  });

  it("org tab uses FormField; FormField uses spacing tokens", () => {
    const org = read("app/(portal)/settings/_components/org-tab.tsx");
    expect(org).toContain('from "@/components/ui/form-field"');
    expect(org).toContain("<FormField");
    const ff = read("components/ui/form-field.tsx");
    expect(ff).toContain("space-y-space-2");
  });
});

describe("W9 advanced leaves + guardrails", () => {
  it("cost/analytics use PageContent; users/tools/insights soft-redirect", () => {
    expect(read("app/(portal)/optimization/page.tsx")).toContain("PageContent");
    expect(read("app/(portal)/analytics/page.tsx")).toContain("PageContent");
    for (const rel of [
      "app/(portal)/insights/page.tsx",
      "app/(portal)/users/page.tsx",
      "app/(portal)/tools/page.tsx",
    ]) {
      expect(read(rel)).toMatch(/router\.replace\("\/analytics\?tab=/);
    }
  });

  it("guardrails: real KPI only (no unavailable StatCards); text tabs", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    const kpi = read("app/(portal)/guardrails/_components/guardrails-kpi.tsx");
    expect(kpi).toContain('data-testid="guardrails-kpi"');
    expect(page).not.toContain("StatCard");
    expect(kpi).not.toContain("StatCard");
    expect(page).not.toContain("Evaluations today");
    expect(page).not.toContain("Block rate");
    expect(kpi).toMatch(/statsPending \? ["']—["'] : policiesLength/);
  });
});

describe("W9 AI rail + onboarding + cmdk/profile", () => {
  it("ApprovalCard quieter; ChatSidebar rail z-40; citations marked", () => {
    const approval = read("components/ai-insights/ApprovalCard.tsx");
    expect(approval).toContain("data-approval-quiet");
    expect(approval).toContain("border-[var(--border-subtle)]");
    expect(approval).not.toMatch(/border-\[var\(--accent\)\]\/30/);

    const chat = read("components/ai-insights/ChatSidebar.tsx");
    expect(chat).toContain("data-ai-rail");
    expect(chat).toContain("z-[var(--z-ai-rail)]");

    const messages = read("components/ai-insights/MessageList.tsx");
    expect(messages).toContain("data-citation-chip");
  });

  it("connect success has one primary CTA path", () => {
    const src = read("app/(portal)/agents/connect/page.tsx");
    expect(src).toContain("Install SDK (docs)");
    expect(src).not.toMatch(/Create API key[\s\S]{0,80}Back to agents/);
  });

  it("⌘K indexes Advanced leaves regardless of sidebar collapse", () => {
    const cmds = buildNavCommands();
    const hrefs = cmds.map((c) => c.href.split("?")[0]);
    expect(hrefs).toContain("/guardrails");
    expect(hrefs).toContain("/optimization");
    expect(hrefs).toContain("/analytics");
    expect(hrefs).toContain("/agents");
    const advanced = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
      (i) => i.category === "advanced",
    );
    expect(advanced.length).toBeGreaterThan(0);
    for (const item of advanced) {
      expect(hrefs).toContain(item.href.split("?")[0]);
    }
  });

  it("profile uses FormField and quiet user section", () => {
    // Profile page shells AccountPanel; form fields live in account sections.
    const src = read(
      "app/(portal)/settings/_components/account-panel-sections.tsx",
    );
    expect(src).toContain('from "@/components/ui/form-field"');
    expect(src).toContain('data-testid="profile-user-section"');
    expect(src).toContain("<FormField");
  });
});
