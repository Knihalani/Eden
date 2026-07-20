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
    const src = read("app/(portal)/guardrails/page.tsx");
    expect(src).toContain("policiesReady");
    expect(src).toContain("statsPending");
    expect(src).toMatch(/if \(currentOrg\) void loadPolicies\(\)/);
    expect(src).not.toMatch(/activeTab === ["']policies["']\) loadPolicies/);
  });

  it("stat cards show em-dash while policies are pending", () => {
    const src = read("app/(portal)/guardrails/page.tsx");
    expect(src).toMatch(/statsPending \? ["']—["'] : policies\.length/);
    expect(src).toMatch(/statsPending \? ["']—["'] : enabledCount/);
  });
});

describe("W6-B ErrorState sweep", () => {
  it("incidents uses ErrorState with retry (not ad-hoc banner)", () => {
    const src = read("app/(portal)/incidents/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load incidents"');
    expect(src).toContain("Try again");
    expect(src).not.toMatch(/role="alert"[\s\S]{0,120}AlertTriangle/);
  });

  it("issue detail uses ErrorState with retry", () => {
    const src = read("app/(portal)/issues/[id]/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load issue"');
    expect(src).toContain("issueQuery.refetch()");
  });

  it("prompt versions load failure uses ErrorState not toast", () => {
    const src = read("app/(portal)/prompts/page.tsx");
    expect(src).toContain('title="Could not load prompt versions"');
    expect(src).toContain("versionsError");
    expect(src).not.toMatch(/toast\.error\(["']Failed to load prompt versions/);
  });

  it("insights overview drops duplicate ad-hoc error banner", () => {
    const src = read("app/(portal)/insights/page.tsx");
    expect(src).toContain('title="Could not load insights"');
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
