/**
 * W6-B — Guardrails stat strip must not show false zeros before policies load.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6-B guardrails stats ready", () => {
  it("loads policies on org mount (not only Policies tab)", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    const hook = read("app/(portal)/guardrails/_components/use-guardrails.ts");
    expect(hook).toContain("policiesReady");
    expect(page).toContain("statsPending");
    expect(hook).toMatch(/if \(orgId\) void loadPolicies\(\)/);
    expect(hook).not.toMatch(/activeTab === ["']policies["']\) loadPolicies/);
  });

  it("stat cards show em-dash while policies are pending", () => {
    const kpi = read("app/(portal)/guardrails/_components/guardrails-kpi.tsx");
    expect(kpi).toMatch(/statsPending \? ["']—["'] : policiesLength/);
    expect(kpi).toMatch(/statsPending\s*\?\s*["']Loading…["']/);
    expect(kpi).toContain("enabledCount");
  });
});

describe("W6-B ErrorState sweep", () => {
  it("incidents uses QueryState error path (not ad-hoc banner)", () => {
    const src = read("app/(portal)/incidents/page.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain('errorTitle="Could not load incidents"');
    expect(src).not.toMatch(/role="alert"[\s\S]{0,120}AlertTriangle/);
  });

  it("issue detail uses ErrorState with retry", () => {
    const src = read("app/(portal)/issues/[id]/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load issue"');
    expect(src).toContain("issueQuery.refetch()");
  });

  it("prompt versions load failure uses ErrorState not toast", () => {
    const page = read("app/(portal)/prompts/page.tsx");
    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    expect(editor).toContain('title="Could not load prompt versions"');
    expect(page).toContain("versionsError");
    expect(page).not.toMatch(/toast\.error\(["']Failed to load prompt versions/);
    expect(editor).not.toMatch(/toast\.error\(["']Failed to load prompt versions/);
  });

  it("insights soft-redirect; panel uses QueryState (no ad-hoc error banner)", () => {
    const redirect = read("app/(portal)/insights/page.tsx");
    expect(redirect).toContain('/analytics?tab=insights');
    const src = read("app/(portal)/analytics/_components/insights-panel.tsx");
    expect(src).toContain('errorTitle="Could not load insights"');
    expect(src).not.toMatch(
      /\{error && <div className="bg-\[var\(--error-bg\)\]/,
    );
  });
});

describe("W6-B hub navigation", () => {
  it("AI chat sidebar navigates via router.push (not window.location.assign)", () => {
    const src = read("components/ai-insights/hooks/useChatSidebar.ts");
    expect(src).toMatch(/navigateRef[\s\S]{0,80}router\.push/);
    expect(src).not.toMatch(/window\.location\.assign\(href\)/);
  });
});
