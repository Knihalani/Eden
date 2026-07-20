/**
 * Wave 5.4 / w5-observe-leaves — Observability Advanced leaves:
 * ErrorState or QueryState async shell, ObserveLeafHeader template,
 * skeletons, no dead 501-only hub links.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

const CHILD_PAGES = [
  "cohorts",
  "decisions",
  "eval",
  "memory",
  "query",
  "retrieval",
  "time-travel",
  "mcp",
] as const;

describe("W5-4 observability hub children ErrorState", () => {
  it.each(CHILD_PAGES)("%s uses ErrorState or QueryState with retry", (child) => {
    const src = read(`app/(portal)/observability/${child}/page.tsx`);
    const hasErrorState =
      src.includes('from "@/components/ui/error-state"') && src.includes("ErrorState");
    const hasQueryState =
      src.includes('from "@/components/ui/query-state"') && src.includes("QueryState");
    expect(hasErrorState || hasQueryState).toBe(true);
    // Retry copy lives on the page or inside QueryState's errorTitle path
    expect(
      src.includes("Try again") || hasQueryState,
    ).toBe(true);
  });

  it("hub SUBPAGES includes cohorts and omits apm", () => {
    const src = read("app/(portal)/observability/page.tsx");
    expect(src).toContain('href: "/observability/cohorts"');
    expect(src).not.toContain('href: "/observability/apm"');
    expect(src).not.toContain('href: "/apm"');
  });

  it("legacy /apm hub-redirects to /traces (no standalone APM surface)", () => {
    const src = read("lib/portal-hub-redirect.ts");
    expect(src).toMatch(/"\/apm":\s*\{\s*destination:\s*"\/traces"/);
    expect(existsSync(resolve(portalSrc, "app/(portal)/observability/apm"))).toBe(
      false,
    );
  });
});

describe("W5 observe-leaves shared template", () => {
  it("ObserveLeafHeader defaults eyebrow Observe + Advanced framing", () => {
    const shell = read(
      "app/(portal)/observability/_components/observe-leaf-shell.tsx",
    );
    expect(shell).toContain("ObserveLeafHeader");
    expect(shell).toContain('eyebrow = "Observe"');
    expect(shell).toContain("Advanced under Traces");
  });

  it.each(CHILD_PAGES)("%s uses ObserveLeafHeader", (child) => {
    const src = read(`app/(portal)/observability/${child}/page.tsx`);
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("PageContent");
  });

  it("landing uses ObserveLeafHeader and points operators to Traces", () => {
    const src = read("app/(portal)/observability/page.tsx");
    expect(src).toContain("ObserveLeafHeader");
    expect(src).toContain("Open Traces");
    expect(src).toContain("Advanced tools");
  });
});

describe("W5-4 observability loading skeletons", () => {
  it.each(CHILD_PAGES)("%s has route loading.tsx skeleton", (child) => {
    const loadingPath = resolve(
      portalSrc,
      `app/(portal)/observability/${child}/loading.tsx`,
    );
    expect(existsSync(loadingPath)).toBe(true);
    const src = read(`app/(portal)/observability/${child}/loading.tsx`);
    expect(src).toMatch(/LoadingSkeleton|Skeleton/);
  });

  it("auto-load surfaces use Skeleton for initial empty load (not spinner-only)", () => {
    const mcp = read("app/(portal)/observability/mcp/page.tsx");
    expect(mcp).toContain("Skeleton");
    expect(mcp).toMatch(/loading &&[\s\S]*Skeleton|loadingSlot[\s\S]*Skeleton/);

    const memory = read("app/(portal)/observability/memory/page.tsx");
    expect(memory).toContain("Skeleton");
    expect(memory).toContain("Could not load reweaver suggestions");

    const retrieval = read("app/(portal)/observability/retrieval/page.tsx");
    expect(retrieval).toContain("Skeleton");
    expect(retrieval).toContain("Could not load knowledge gaps");

    const query = read("app/(portal)/observability/query/page.tsx");
    expect(query).toContain("Skeleton");
    expect(query).toContain("Could not load alerts");

    const evalPage = read("app/(portal)/observability/eval/page.tsx");
    expect(evalPage).toContain("Skeleton");
    expect(evalPage).toContain("Could not load failure clusters");
  });
});
