/**
 * Wave 6 part A — closed loop: dataset/playground first-class + citation → spanId.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { citationJumpHref, playgroundHref } from "@/lib/portal-cross-links";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6 closed-loop A — inspector secondary actions", () => {
  it("promotes Add to dataset / Iterate in playground as ghost secondary CTAs", () => {
    const topbar = read("components/trace-viewer/UnifiedTopBar.tsx");
    expect(topbar).toContain('data-wave-v3-6-loop="secondary"');
    expect(topbar).toContain("Iterate in playground");
    expect(topbar).toContain("Add to dataset");
    expect(topbar).toContain('variant="ghost"');
    expect(topbar).toContain('data-testid="trace-add-to-dataset"');
    expect(topbar).toContain('data-testid="trace-open-playground"');
    expect(topbar).toContain("playgroundHref(traceId, spanForPlayground, linkPreserve)");
    expect(topbar).toContain("promoteTraceToDatasetHref(traceId, linkPreserve)");
    expect(topbar).toContain('data-testid="trace-actions-overflow"');
    expect(topbar).not.toMatch(
      /data-wave-v3-6-loop="secondary"[\s\S]{0,600}variant="default"/,
    );
  });

  it("preserves Observe filters on playground deep link", () => {
    const href = playgroundHref("t1", "s9", { pastHours: "24", realm: "prod" });
    expect(href).toContain("tab=playgrounds");
    expect(href).toContain("trace_id=t1");
    expect(href).toContain("span_id=s9");
    expect(href).toContain("pastHours=24");
    expect(href).toContain("realm=prod");
  });
});

describe("W6 closed-loop A — citation chips → spanId", () => {
  it("citationJumpHref writes canonical ?traceId=&spanId=", () => {
    expect(
      citationJumpHref({
        kind: "span",
        id: "span-42",
        trace_id: "trace-9",
      }),
    ).toBe("/traces?traceId=trace-9&spanId=span-42");

    expect(citationJumpHref({ kind: "trace", id: "trace-9" })).toBe(
      "/traces?traceId=trace-9",
    );

    expect(
      citationJumpHref({ kind: "span", id: "orphan-span" }),
    ).toBeNull();
  });

  it("MessageList CitationChip uses citationJumpHref + data-span-id", () => {
    const list = read("components/ai-insights/MessageList.tsx");
    expect(list).toContain("citationJumpHref");
    expect(list).toContain("data-citation-chip");
    expect(list).toContain("data-span-id");
    expect(list).toContain('cite.kind === "span"');
    expect(list).not.toContain("/traces?trace_id=");
  });

  it("AiRail stays collapsed by default", () => {
    const rail = read("components/portal-chrome/AiRailHost.tsx");
    expect(rail).toContain('data-wave11-airail="collapsed-default"');
  });
});
