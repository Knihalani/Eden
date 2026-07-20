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
  it("improve hub: Tabs + QueryState + mobile list; CrossLinks in More overflow", () => {
    const src = read("app/(portal)/improve/page.tsx");
    expect(src).toContain('from "@/components/ui/tabs"');
    expect(src).toContain("<QueryState");
    expect(src).toContain("lg:hidden");
    expect(src).toContain('data-testid="improve-toolbar"');
    expect(src).toContain("DropdownMenuLabel>Go to");
    expect(src).toContain("PATH_LINKS");
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
    expect(scorecard).toContain("DropdownMenuLabel>Go to");
    const plans = read("app/(portal)/improve/plans/page.tsx");
    expect(plans).toContain('data-testid="improve-plans-kpi"');
    expect(plans).toContain("md:grid-cols-3");
  });
});

describe("W9 artifacts / ledger / promotions / audit", () => {
  it("moat hubs discoverable without CrossLinkBar peer bands", () => {
    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).not.toContain("<CrossLinkBar");
    expect(ledger).toContain("DropdownMenuLabel>Go to");

    const promo = read("app/(portal)/promotions/page.tsx");
    expect(promo).not.toContain("<CrossLinkBar");
    expect(promo).toContain('data-testid="promotions-toolbar"');
    expect(promo).toContain("DropdownMenuLabel>Go to");

    const artifacts = read("app/(portal)/artifacts/page.tsx");
    expect(artifacts).toContain('href="/ledger"');
    expect(artifacts).toContain('href="/improve"');
    expect(artifacts).not.toContain("<CrossLinkBar");
  });

  it("audit trail: quiet toolbar + compliance tools in details", () => {
    const src = read("app/(portal)/audit-trail/page.tsx");
    expect(src).toContain('data-testid="audit-trail-toolbar"');
    expect(src).toContain("<details");
    expect(src).toContain("Compliance tools");
    expect(src).not.toContain("<CrossLinkBar");
    expect(src).toContain("<QueryState");
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
    expect(page).toContain(
      '["Org", "Members", "Security", "Compliance", "Billing", "Advanced"]',
    );

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
  it("cost/analytics/insights/users/tools use PageContent", () => {
    for (const rel of [
      "app/(portal)/optimization/page.tsx",
      "app/(portal)/analytics/page.tsx",
      "app/(portal)/insights/page.tsx",
      "app/(portal)/users/page.tsx",
      "app/(portal)/tools/page.tsx",
    ]) {
      expect(read(rel)).toContain("PageContent");
    }
  });

  it("guardrails: real KPI only (no unavailable StatCards); text tabs", () => {
    const src = read("app/(portal)/guardrails/page.tsx");
    expect(src).toContain('data-testid="guardrails-kpi"');
    expect(src).not.toContain("StatCard");
    expect(src).not.toContain("Evaluations today");
    expect(src).not.toContain("Block rate");
    expect(src).toMatch(/statsPending \? ["']—["'] : policies\.length/);
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
    expect(chat).toContain("z-40");

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
    const src = read("app/(portal)/profile/page.tsx");
    expect(src).toContain('from "@/components/ui/form-field"');
    expect(src).toContain('data-testid="profile-user-section"');
    expect(src).toContain("<FormField");
  });
});
