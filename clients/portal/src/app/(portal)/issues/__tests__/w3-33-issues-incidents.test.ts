/**
 * W3-3.3 — Issues ↔ Incidents clarity, ErrorState, handoff touch targets.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W3-3.3 issues/incidents cross-link clarity", () => {
  it("labels Agent Issues vs Incidents without competing raw tab tokens", () => {
    const src = read("app/(portal)/issues/page.tsx");
    expect(src).toContain('title="Agent Issues"');
    expect(src).toContain('issues: "Agent Issues"');
    expect(src).toContain('incidents: "Incidents"');
    expect(src).toContain("TOP_TAB_LABELS[t]");
    expect(src).toMatch(/Switch to Incidents for systemic RCA/);
  });

  it("incidents empty/subtitle link to Agent Issues (not plain text)", () => {
    const src = read("app/(portal)/incidents/page.tsx");
    expect(src).toContain('href="/issues"');
    expect(src).toContain("View Agent Issues");
    expect(src).toContain("Agent Issues");
    expect(src).not.toMatch(
      /emptyDescription="[^"]*see Agent Issues[^"]*"/,
    );
  });

  it("incident detail links Agent Issues and member traces", () => {
    const src = read("app/(portal)/incidents/[cluster_id]/page.tsx");
    expect(src).toContain('href="/issues"');
    expect(src).toContain("Agent Issues");
    expect(src).toContain("traceHref(m.trace_id)");
    expect(src).toContain("min-h-11");
  });
});

describe("W3-3.3 ErrorState consistency", () => {
  it("incident detail uses shared ErrorState with Try again", () => {
    const src = read("app/(portal)/incidents/[cluster_id]/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain('title="Could not load incident"');
    expect(src).toContain("Try again");
    expect(src).not.toMatch(/AlertTriangle/);
    expect(src).not.toMatch(/bg-\[var\(--error-bg\)\]/);
  });

  it("issues detail panel uses ErrorState on fetch failure", () => {
    const src = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(src).toContain('title="Could not load issue"');
    expect(src).toContain("ErrorState");
  });

  it("gates incidents empty behind QueryState error path", () => {
    const src = read("app/(portal)/incidents/page.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain('errorTitle="Could not load incidents"');
    expect(src).toContain("DataTable");
    expect(src).not.toMatch(/bg-\[var\(--accent\)\] text-\[var\(--bg-base\)\]/);
  });
});

describe("W3-3.3 issue detail handoff touch targets", () => {
  it("handoff / primary actions use min-h-11 (≥44px)", () => {
    const src = read("app/(portal)/issues/_components/issue-handoff.tsx");
    expect(src).toContain('data-testid="coding-agent-handoff"');
    expect(src).toMatch(/Copy prompt[\s\S]*min-h-11|min-h-11[\s\S]*Copy prompt/);
    expect(src).toContain('className="min-h-11"');
    expect(src).toMatch(/Open in coding agent/);
    expect(src).not.toMatch(/In-portal fix chat \(F22\) was deleted/);
  });
});
