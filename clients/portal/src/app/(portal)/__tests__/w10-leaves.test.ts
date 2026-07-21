/**
 * Wave 10 (V2) — Agents/Fleet + Observe power-tool shells.
 * Focused contracts for 10.1–10.10. Does not re-gate Waves 1–9 polish.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W10.1–10.4 agents + fleet + connect", () => {
  it("10.1 agents list is table/list, not card grid", () => {
    const src = read("app/(portal)/agents/page.tsx");
    expect(src).toContain('data-testid="agents-table"');
    expect(src).toContain('data-wave10-agents="table"');
    expect(src).not.toContain("xl:grid-cols-3 gap-space-3");
    expect(src).not.toMatch(/function AgentCard/);
  });

  it("10.2 agent detail uses Panel stats + More overflow for book/drift/ledger/artifacts", () => {
    const src = read("app/(portal)/agents/[id]/page.tsx");
    expect(src).toContain('data-testid="agent-detail-stats"');
    expect(src).toContain('data-wave10-agent-detail="completed"');
    expect(src).toContain("DropdownMenu");
    expect(src).toContain("/ledger");
    expect(src).toContain("/artifacts");
    expect(src).toContain("/book");
    expect(src).toContain("/drift");
    expect(src).not.toContain('<Card className="p-6">');
  });

  it("10.3 fleet agents use table + thin KPI strip", () => {
    const src = read("app/(portal)/fleet/page.tsx");
    expect(src).toContain('data-testid="fleet-agents-table"');
    expect(src).toContain('data-wave10-fleet="table"');
    expect(src).toContain('data-testid="fleet-kpi-strip"');
    expect(src).not.toContain("md:grid-cols-2 xl:grid-cols-3");
    expect(src).not.toContain("CrossLinkBar");
  });

  it("10.4 connect flow uses kit Button + polished marker", () => {
    const src = read("app/(portal)/agents/connect/page.tsx");
    expect(src).toContain('data-wave10-connect="polished"');
    expect(src).toContain('from "@/components/ui/button"');
    expect(src).toContain("OnboardingConnectFlow");
    expect(src).toContain("Install SDK");
  });
});

describe("W10.5 observe deep-link shells", () => {
  it.each(["query", "time-travel", "memory", "retrieval"] as const)(
    "%s is deep-link shell with ObserveLeafHeader + back Button",
    (leaf) => {
      const src = read(`app/(portal)/observability/${leaf}/page.tsx`);
      expect(src).toContain("ObserveLeafHeader");
      expect(src).toContain("ObserveBackToTraces");
      expect(src).toContain("WAVE10_SHELL_ATTR");
      expect(src).not.toContain("CrossLinkBar");
    },
  );
});

describe("W10.6 inspector / replay / debugger slim", () => {
  it("inspector uses slim power marker + ObserveLeafHeader", () => {
    const src = read("app/(portal)/inspector/page.tsx");
    expect(src).toContain("WAVE10_POWER_ATTR");
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("ObserveBackToTraces");
    expect(src).toContain('data-testid="inspector-slim-toolbar"');
  });

  it("replay uses slim power marker; metric strip not StatCard wall", () => {
    const page = read("app/(portal)/replay/page.tsx");
    const timeline = read(
      "app/(portal)/replay/_components/replay-timeline.tsx",
    );
    const src = `${page}\n${timeline}`;
    expect(page).toContain("WAVE10_POWER_ATTR");
    expect(page).toContain("ObserveLeafHeader");
    expect(src).toContain('data-testid="replay-metric-strip"');
    expect(src).not.toContain("StatCard");
  });

  it("debugger uses ObserveLeafHeader + slim power marker", () => {
    const src = read("app/(portal)/debugger/page.tsx");
    expect(src).toContain("WAVE10_POWER_ATTR");
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("ObserveBackToTraces");
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="debugger-toolbar"');
  });
});

describe("W10.7 MCP / decisions quiet facets", () => {
  it("mcp is quiet facet with KPI strip (not 3-card wall)", () => {
    const src = read("app/(portal)/observability/mcp/page.tsx");
    expect(src).toContain("WAVE10_FACET_ATTR");
    expect(src).toContain('data-testid="mcp-kpi-strip"');
    expect(src).toContain("ObserveLeafHeader");
    expect(src).not.toMatch(/md:grid-cols-3[\s\S]*Servers/);
  });

  it("decisions is quiet facet under ObserveLeafHeader", () => {
    const src = read("app/(portal)/observability/decisions/page.tsx");
    expect(src).toContain("WAVE10_FACET_ATTR");
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("ObserveBackToTraces");
  });
});

describe("W10.8 debugger sessions Laminar-like", () => {
  it("calm list + ObserveLeafHeader + one primary New", () => {
    const src = read("app/(portal)/debugger-sessions/page.tsx");
    expect(src).toContain('data-testid="debugger-sessions-list"');
    expect(src).toContain('data-wave10-debugger="calm"');
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("New session");
  });
});

describe("W10.9 lineage kit Button", () => {
  it("back CTA uses kit Button asChild (not hand-rolled Link chrome)", () => {
    const src = read("app/(portal)/runs/[run_id]/lineage/page.tsx");
    expect(src).toContain('data-wave10-lineage="signed"');
    expect(src).toContain("<Button asChild");
    expect(src).toContain('from "@/components/ui/button"');
    expect(src).not.toMatch(
      /<Link\s+href="\/traces"\s+className="inline-flex items-center gap-2 text-sm/,
    );
  });
});

describe("W10.10 inventory signoff artifact", () => {
  it("writes .wave10-signoff.md checklist for V2 Wave 10", () => {
    const signoff = resolve(portalSrc, "../.wave10-signoff.md");
    expect(existsSync(signoff)).toBe(true);
    const body = readFileSync(signoff, "utf8");
    expect(body).toContain("Wave 10");
    expect(body).toContain("/agents");
    expect(body).toContain("/fleet");
    expect(body).toContain("/observability/query");
    expect(body).toContain("/inspector");
    expect(body).toContain("/replay");
    expect(body).toContain("/debugger");
    expect(body).toContain("/runs/");
    expect(body).toMatch(/signed off|✅|complete/i);
  });

  it("shared observe-leaf-shell exports Wave 10 markers", () => {
    const shell = read(
      "app/(portal)/observability/_components/observe-leaf-shell.tsx",
    );
    expect(shell).toContain("ObserveBackToTraces");
    expect(shell).toContain("WAVE10_SHELL_ATTR");
    expect(shell).toContain("WAVE10_POWER_ATTR");
    expect(shell).toContain("WAVE10_FACET_ATTR");
    expect(shell).toContain("WAVE_V3_8_POWER_ATTR");
    expect(shell).toContain("Advanced under Traces");
  });
});

describe("Observe V3 Wave 8 — power shells ≤400 LOC", () => {
  it.each([
    ["app/(portal)/replay/page.tsx", 400],
    ["app/(portal)/inspector/page.tsx", 400],
    ["app/(portal)/observability/query/page.tsx", 400],
  ] as const)("%s shell ≤%i LOC", (rel, max) => {
    const lines = read(rel).split("\n").length;
    expect(lines).toBeLessThanOrEqual(max);
  });

  it("power shells stay Overflow-only via LEGACY_TOOL_LINKS (no sidebar items)", () => {
    const toolbar = read(
      "app/(portal)/traces/_components/TracesToolbar.tsx",
    );
    expect(toolbar).toContain("LEGACY_TOOL_LINKS");
    expect(toolbar).toContain('/traces?view=inspect');
    expect(toolbar).toContain('/traces?view=replay');
    expect(toolbar).toContain('/traces?view=query');
    const sidebar = read("lib/sidebar-config.ts");
    expect(sidebar).not.toMatch(/href:\s*["']\/inspector["']/);
    expect(sidebar).not.toMatch(/href:\s*["']\/replay["']/);
    expect(sidebar).not.toMatch(
      /href:\s*["']\/observability\/query["']/,
    );
  });
});
