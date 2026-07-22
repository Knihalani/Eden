/**
 * Wave 8 — Evaluate ecosystem exit gate (V2).
 * 3 primary tabs; Advanced hide; Datasets M–D; one Run; compare matrix;
 * Labeling empty; Studio split; Eval↔Trace preserve; Scores quiet; axe focused.
 * No PATH_LINKS / Go-to overflow soup (V1 7.9 + Improve path-soup kill).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ResourcePageShell } from "@/components/portal-os/ResourcePageShell";
import {
  playgroundHref,
  promoteTraceToDatasetHref,
  traceHref,
} from "@/lib/portal-cross-links";
import { U20_SERIOUS_AXE_ROUTES } from "@/lib/portal-polish";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W8 evals-ecosystem", () => {
  it("marks wave8-evals completed", () => {
    const src = read("app/(portal)/evals/page.tsx");
    expect(src).toContain("WAVE8_EVALS_COMPLETED = true");
    expect(src).toContain('data-wave8-evals="completed"');
  });

  it("ResourcePageShell reports data-page-bands ≤ 2", () => {
    const { container } = render(
      <ResourcePageShell
        header={<h1>Evals</h1>}
        toolbar={<div data-testid="tb">tabs</div>}
        table={<div>table</div>}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-page-bands", "2");
    expect(Number(root.getAttribute("data-page-bands"))).toBeLessThanOrEqual(2);
  });

  it("evals hub: 3 primary tabs + Advanced overflow; no Go-to PATH_LINKS", () => {
    const src = read("app/(portal)/evals/page.tsx");
    expect(src).toContain('from "@/components/ui/tabs"');
    expect(src).toContain("CoreResourcePage");
    expect(src).toContain('data-testid="evals-toolbar"');
    expect(src).toContain('PRIMARY_TABS = ["datasets", "playgrounds", "experiments"]');
    expect(src).toContain(
      'ADVANCED_TABS = ["eval", "labeling", "studio", "synthetic"]',
    );
    expect(src).toContain('data-testid="evals-advanced"');
    expect(src).toContain("sm:hidden");
    expect(src).toContain(">More<");
    expect(src).not.toContain("PATH_LINKS");
    expect(src).not.toContain("DropdownMenuLabel>Go to");
    expect(src).not.toContain("CrossLinkBar");
  });

  it("sidebar Advanced-hides labeling / studio / synthetic (hub = /evals only)", () => {
    const evaluate = DEFAULT_SIDEBAR.find((g) => g.id === "evaluate");
    expect(evaluate).toBeTruthy();
    const hrefs = (evaluate?.items ?? []).map((i) => i.href);
    expect(hrefs).toEqual(["/evals"]);
    expect(hrefs).not.toContain("/labeling");
    expect(hrefs).not.toContain("/studio");
    expect(hrefs).not.toContain("/synthetic");
    expect(hrefs).not.toContain("/observability/eval");
  });

  it("playgrounds / datasets / labeling use QueryState (synthetic history deferred)", () => {
    for (const rel of [
      "app/(portal)/playgrounds/page.tsx",
      "app/(portal)/datasets/page.tsx",
      "app/(portal)/labeling/_components/labeling-items-table.tsx",
    ]) {
      const src = read(rel);
      expect(src).toContain('from "@/components/ui/query-state"');
      expect(src).toContain("<QueryState");
    }
    // E5: Synthetic drops QueryState history table for an honest deferred callout.
    const synthetic = read("app/(portal)/synthetic/page.tsx");
    expect(synthetic).toContain('data-wave-e5-synthetic="history-deferred"');
    expect(synthetic).not.toContain("<QueryState");
  });

  it("datasets master–detail peek without Card walls", () => {
    const src = read("app/(portal)/datasets/page.tsx");
    const peek = read(
      "app/(portal)/datasets/_components/datasets-detail-peek.tsx",
    );
    const table = read(
      "app/(portal)/datasets/_components/datasets-table.tsx",
    );
    expect(peek).toContain("DetailPanelShell");
    expect(peek).toContain("dataset-detail-peek");
    expect(table).toContain("onRowClick");
    expect(src).not.toContain("CrossLinkBar");
  });

  it("playgrounds keeps one solid Run CTA", () => {
    const src = read("app/(portal)/playgrounds/page.tsx");
    expect(src).toContain('data-testid="playground-run-cta"');
    const newWindow = src.slice(
      Math.max(0, src.indexOf("New playground") - 200),
      src.indexOf("New playground"),
    );
    expect(newWindow).toContain('variant="outline"');
    // Promote is secondary (outline); Run is the only solid accent CTA in the editor.
    expect(src).toMatch(
      /variant="outline"\s*\n\s*onClick=\{promote\}[\s\S]*?Promote → experiment/,
    );
  });

  it("experiments compare matrix in detail with baseline", () => {
    const page = read("app/(portal)/experiments/page.tsx");
    const panel = read(
      "app/(portal)/experiments/_components/compare-panel.tsx",
    );
    const matrix = read(
      "app/(portal)/experiments/_components/compare-matrix.tsx",
    );
    const grades = read(
      "app/(portal)/experiments/_components/compare-grades.ts",
    );
    expect(panel).toContain('data-testid="compare-baseline"');
    expect(matrix).toContain('data-testid="compare-score-headers"');
    expect(panel).toContain("Side-by-side scores");
    expect(panel).toContain("DetailPanelShell");
    expect(grades).toContain("score_delta");
    expect(page).not.toContain("CrossLinkBar");
    expect(page).not.toContain("DropdownMenuLabel>Go to");
    expect(page).not.toMatch(/table=\{\s*<Card/);
  });

  it("studio split shell: underline tabs + subtle border; no Card", () => {
    const src = read("app/(portal)/studio/page.tsx");
    expect(src).toContain('variant="underline"');
    expect(src).toContain("useEmbeddedSurface");
    expect(src).toContain("border-[var(--border-subtle)]");
    expect(src).not.toContain('from "@/components/ui/card"');
    expect(src).not.toContain('variant="pills"');
    expect(src.split("\n").length).toBeLessThan(200);
    expect(
      existsSync(resolve(portalSrc, "app/(portal)/studio/_components/templates-tab.tsx")),
    ).toBe(true);
  });

  it("labeling empty teaches three sources + progressive queues", () => {
    const page = read("app/(portal)/labeling/page.tsx");
    const queues = read(
      "app/(portal)/labeling/_components/labeling-queues-section.tsx",
    );
    const items = read(
      "app/(portal)/labeling/_components/labeling-items-table.tsx",
    );
    expect(page).toContain("LabelingQueuesSection");
    expect(queues).toContain("<details");
    expect(queues).toContain("Annotation queues");
    expect(items).toContain("labeling-empty-sources");
    expect(items).toContain("From traces");
    expect(items).toContain("labeling-empty-seed");
    expect(items).toContain("Create queue");
  });

  it("Eval↔Trace deep links preserve filters/time", () => {
    const href = traceHref("t1", { pastHours: "24", q: "status:error", realm: "prod" });
    expect(href).toContain("traceId=t1");
    expect(href).toContain("pastHours=24");
    expect(href).toContain("q=status%3Aerror");

    const pg = playgroundHref("t1", "s1", { pastHours: "6", agent_id: "a1" });
    expect(pg).toContain("tab=playgrounds");
    expect(pg).toContain("pastHours=6");

    const promote = promoteTraceToDatasetHref("t9", { pastHours: "12" });
    expect(promote).toContain("promote_trace=t9");
    expect(promote).toContain("pastHours=12");

    const topbar = read("components/trace-viewer/UnifiedTopBar.tsx");
    expect(topbar).toContain("preserveFromSearch");
    expect(topbar).toContain("playgroundHref(traceId, spanForPlayground, linkPreserve)");
    expect(topbar).toContain("promoteTraceToDatasetHref(traceId, linkPreserve)");
    expect(topbar).toContain('data-testid="trace-add-to-dataset"');
    expect(topbar).toContain('data-testid="trace-open-playground"');
  });

  it("Scores quiet under Advanced — no Card walls; embedded hides header", () => {
    const page = read("app/(portal)/observability/eval/page.tsx");
    const hook = read(
      "app/(portal)/observability/eval/_components/use-scores-page.ts",
    );
    const src = `${page}\n${hook}`;
    expect(page).toContain('title="Scores"');
    expect(src).toContain("useEmbeddedSurface");
    expect(page).toContain('data-testid="scores-advanced-tabs"');
    expect(page).toContain("border-[var(--border-subtle)]");
    expect(page).not.toContain('from "@/components/ui/card"');
    expect(page).not.toContain("ObserveLeafHeader");
  });

  it("axe serious gate includes /evals (Wave 8.10)", () => {
    expect([...U20_SERIOUS_AXE_ROUTES]).toContain("/evals");
    const script = readFileSync(
      resolve(portalSrc, "../scripts/audit-a11y.cjs"),
      "utf8",
    );
    expect(script).toContain('"/evals"');
    expect(script).toMatch(/SERIOUS_GATE_ROUTES[\s\S]*\/evals/);
  });
});
