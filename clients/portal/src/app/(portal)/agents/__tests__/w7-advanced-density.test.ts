/**
 * Wave 7 — Advanced Observe density: Agents / Analytics / Debug sessions.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MASTER_DETAIL_QUERY_KEYS } from "@/components/portal-os/CoreResourcePage";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W7 Agents master–detail density", () => {
  it("agentId is a master–detail URL key", () => {
    expect(MASTER_DETAIL_QUERY_KEYS.agentId[0]).toBe("agentId");
    const url = read("components/portal-os/useResourceUrlState.ts");
    expect(url).toContain("agentId");
    expect(url).toContain('writeMasterDetailParam(params, "agentId"');
  });

  it("list keeps table mounted and peeks via DetailPanelShell", () => {
    const page = read("app/(portal)/agents/page.tsx");
    expect(page).toContain("AgentsDetailPanel");
    expect(page).toContain("useResourceUrlState");
    expect(page).toContain("agentId");
    expect(page).toContain('data-wave7-agents="toolbar-one-band"');
    expect(page).not.toContain("eyebrow=");
    expect(page).toContain("useListKeyboardNav");
    expect(existsSync(resolve(portalSrc, "app/(portal)/agents/_components/agents-detail-panel.tsx"))).toBe(
      true,
    );
    const panel = read("app/(portal)/agents/_components/agents-detail-panel.tsx");
    expect(panel).toContain("DetailPanelShell");
    expect(panel).toContain('data-wave7-agents="master-detail"');
  });

  it("full agent leaf is flat meta (no Panel card collage / back band)", () => {
    const detail = read("app/(portal)/agents/[id]/page.tsx");
    expect(detail).toContain('data-wave7-agents="detail-flat"');
    expect(detail).toContain('data-wave7-agents="flat-meta"');
    expect(detail).not.toContain("<Panel");
    expect(detail).not.toContain("ArrowLeft");
    expect(detail).not.toContain("eyebrow=");
  });
});

describe("W7 Analytics density + canonical trace links", () => {
  it("topics panel uses traceHref (no path-form /traces/${id})", () => {
    const topics = read("app/(portal)/analytics/_components/topics-panel.tsx");
    expect(topics).toContain("traceHref");
    expect(topics).toContain('data-wave7-analytics="one-job"');
    expect(topics).not.toMatch(/\/traces\/\$\{/);
    expect(topics).not.toContain("`/traces/");
  });

  it("hub marks wave7 density and keeps quiet KPI (no Card walls)", () => {
    const page = read("app/(portal)/analytics/page.tsx");
    expect(page).toContain('data-wave7-analytics="density"');
    expect(page).toContain("Quiet KPI");
    expect(page).not.toContain("<Card");
    expect(page).not.toContain("<Panel");
  });
});

describe("W7 Debugger sessions Trace-mode grammar", () => {
  it("detail uses Runs|Compare modes and kills Card collage", () => {
    const detail = read("app/(portal)/debugger-sessions/[id]/page.tsx");
    expect(detail).toContain('data-wave7-debugger="session-modes"');
    expect(detail).toContain('data-wave7-debugger="mode-tabs"');
    expect(detail).toContain('value="runs"');
    expect(detail).toContain('value="compare"');
    expect(detail).toContain("traceHref");
    expect(detail).not.toContain('from "@/components/ui/card"');
    expect(detail).not.toContain("<Card");
  });

  it("list stays dense CoreResourcePage (no Card)", () => {
    const list = read("app/(portal)/debugger-sessions/page.tsx");
    expect(list).toContain("CoreResourcePage");
    expect(list).toContain('data-wave7-debugger="dense-list"');
    expect(list).not.toContain("<Card");
  });
});
