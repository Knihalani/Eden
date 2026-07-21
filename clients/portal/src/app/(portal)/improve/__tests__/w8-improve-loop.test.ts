/**
 * Wave 8 — Improve loop exit criteria.
 * Queue ≤3 columns; related strip (not path overflow); plans/runs calm;
 * Artifacts modes without card walls; Ledger+promotions; Advanced scorecard;
 * Diff polish; U20 toasts; Issue→Artifact→Promote ≤5 clicks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildNavCommands, PALETTE_ACTIONS } from "@/lib/nav-commands";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import {
  U20_TOAST_MUTATIONS,
  U20_TOAST_MUTATION_SOURCES,
} from "@/lib/portal-polish";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function readArtifactsSurface(): string {
  return [
    read("app/(portal)/artifacts/page.tsx"),
    read("app/(portal)/artifacts/_components/artifacts-list.tsx"),
    read("app/(portal)/artifacts/_components/use-artifacts-page.ts"),
  ].join("\n");
}

describe("Wave 8 improve loop exit", () => {
  const improve = read("app/(portal)/improve/page.tsx");

  it("marks wave8-improve completed", () => {
    expect(improve).toContain("WAVE8_IMPROVE_COMPLETED = true");
    expect(improve).toContain('data-wave8-improve="completed"');
  });

  it("queue uses exactly 3 views (Needs you / In progress / Verify)", () => {
    const cols = read("app/(portal)/improve/_components/improve-constants.ts");
    const board = read("app/(portal)/improve/_components/queue-board.tsx");
    expect(cols).toContain('id: "needs_you"');
    expect(cols).toContain('id: "in_progress"');
    expect(cols).toContain('id: "verify"');
    expect(board).toContain("IMPROVE_QUEUE_VIEW_PRESETS");
    expect(board).toContain("ViewsMenu");
    expect(board).not.toContain("lg:grid-cols-3");
    expect(improve).not.toContain('id: "urgent"');
    expect(improve).not.toContain('id: "proposed"');
    expect(improve).not.toContain('id: "autonomous"');
    expect(improve).not.toContain("2xl:grid-cols-5");
    expect(cols).toContain("queueColumnId");
  });

  it("kills path overflow soup — related strip only (no More Go-to PATH_LINKS)", () => {
    expect(improve).toContain("ImproveRelatedStrip");
    expect(improve).not.toContain("PATH_LINKS");
    expect(improve).not.toContain("DropdownMenuLabel>Go to");
    expect(improve).not.toContain('href: "/improve/scorecard"');
    expect(improve).not.toContain('href: "/improve/online-scoring"');
    expect(improve).not.toContain("<CrossLinkBar");
    const related = read("app/(portal)/improve/_components/improve-constants.ts");
    const strip = read(
      "app/(portal)/improve/_components/improve-related-strip.tsx",
    );
    expect(strip).toContain('data-testid="improve-related-strip"');
    expect(related).toContain('href: "/prompts"');
    expect(related).not.toContain("/improve/scorecard");
  });
});

describe("W8 plans / history / artifacts / ledger", () => {
  it("plans list uses calm hierarchy (inline KPI + row list, no StatCard wall)", () => {
    const plans = read("app/(portal)/improve/plans/page.tsx");
    expect(plans).toContain('data-testid="improve-plans-kpi"');
    expect(plans).toContain('data-testid="improve-plans-list"');
    expect(plans).not.toContain("StatCard");
    expect(plans).not.toContain('from "@/components/ui/card"');
    expect(plans).toContain("PageHeader");
  });

  it("runs history uses dense table", () => {
    const runs = read("app/(portal)/improve/runs/page.tsx");
    expect(runs).toContain('data-testid="improve-runs-table"');
    expect(runs).toContain("py-space-1");
    expect(runs).toContain("PageHeader");
  });

  it("artifacts modes without KPI card walls", () => {
    const artifacts = readArtifactsSurface();
    expect(artifacts).toContain('variant="underline"');
    expect(artifacts).toContain("<details");
    expect(artifacts).toContain("Author from plain English");
    expect(artifacts).toContain('data-testid="artifacts-related-strip"');
    expect(artifacts).not.toContain("<CrossLinkBar");
    // No decorative KPI Panel grid
    expect(artifacts).not.toMatch(/grid-cols-2[\s\S]{0,80}Shadow[\s\S]{0,80}Promoted/);
  });

  it("ledger merges promotions as mode with related strip", () => {
    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).toContain('value="promotions"');
    expect(ledger).toContain('data-testid="ledger-related-strip"');
    expect(ledger).not.toContain("DropdownMenuLabel>Go to");
    expect(ledger).not.toContain("<CrossLinkBar");
  });
});

describe("W8 advanced scorecard / online-scoring + diff", () => {
  it("scorecard and online-scoring are Advanced Improve only", () => {
    const scorecard = read("app/(portal)/improve/scorecard/page.tsx");
    expect(scorecard).toContain("Advanced · Improve");
    expect(scorecard).not.toContain("DropdownMenuLabel>Go to");
    expect(scorecard).not.toContain("<CrossLinkBar");

    const online = read("app/(portal)/improve/online-scoring/page.tsx");
    expect(online).toContain("Advanced · Improve");
    expect(online).toContain('href="/improve"');

    const changeImpact = read("app/(portal)/improve/change-impact/page.tsx");
    expect(changeImpact).toContain("Advanced · Improve");
    expect(changeImpact).not.toContain("DropdownMenuLabel>Go to");
    expect(changeImpact).not.toContain("<CrossLinkBar");
    expect(changeImpact).toContain('data-testid="change-impact-related-strip"');

    const advanced = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
      (i) => i.category === "advanced",
    );
    const hrefs = advanced.map((i) => i.href);
    expect(hrefs).toContain("/improve/scorecard");
    expect(hrefs).toContain("/improve/online-scoring");
    expect(hrefs).toContain("/improve/change-impact");

    const cmds = buildNavCommands();
    expect(cmds.some((c) => c.href === "/improve/scorecard")).toBe(true);
    expect(cmds.some((c) => c.href === "/improve/online-scoring")).toBe(true);
    expect(cmds.some((c) => c.href === "/improve/change-impact")).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/scorecard")).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/online-scoring")).toBe(true);
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/change-impact")).toBe(true);
  });

  it("diff viewer polish — kit Button toggle, no text-[10px]", () => {
    const diff = read("components/improve/diff-viewer.tsx");
    expect(diff).toContain('data-testid="diff-viewer"');
    expect(diff).toContain('from "@/components/ui/button"');
    expect(diff).not.toContain("text-[10px]");
    expect(diff).toContain('aria-label="Diff layout"');
  });
});

describe("W8 toast mutations + click path", () => {
  it("U20_TOAST_MUTATIONS complete with source anchors", () => {
    expect(U20_TOAST_MUTATIONS.length).toBeGreaterThanOrEqual(11);
    for (const key of U20_TOAST_MUTATIONS) {
      const rel = U20_TOAST_MUTATION_SOURCES[key];
      expect(rel, key).toBeTruthy();
      const src = read(rel);
      expect(src, key).toContain("toast.success");
    }
    const playgrounds = read(
      "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
    );
    expect(playgrounds).toContain("Compare complete");
    expect(playgrounds).toContain("playground.compare");
  });

  /**
   * Issue → Artifact → Promote ≤5 clicks:
   * 1) Issues list → open issue
   * 2) Actions → Open artifacts
   * 3) Select shadow artifact row
   * 4) Promote (list or detail header)
   */
  it("Issue→Artifact→Promote path stays ≤5 clicks", () => {
    const issueHeader = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(issueHeader).toContain('href="/artifacts"');
    expect(issueHeader).toContain("Open artifacts");

    const artifacts = readArtifactsSurface();
    expect(artifacts).toContain("doPromote");
    expect(artifacts).toMatch(/Promote/);
    expect(artifacts).toContain('toast.success("Artifact promoted")');
  });
});
