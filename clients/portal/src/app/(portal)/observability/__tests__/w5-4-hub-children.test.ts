/**
 * Wave 5.4 — Observability hub children: ErrorState + refresh, skeletons,
 * no dead 501-only hub links (APM redirects to traces; cohorts listed).
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
  it.each(CHILD_PAGES)("%s uses ErrorState (not Alert-only / ad-hoc banner)", (child) => {
    const src = read(`app/(portal)/observability/${child}/page.tsx`);
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("ErrorState");
    expect(src).toContain("Try again");
    expect(src).not.toMatch(
      /\{error && \(\s*<div className="bg-\[var\(--error-bg\)\]/,
    );
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
    expect(mcp).toMatch(/loading &&[\s\S]*Skeleton/);

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
