/**
 * V2 Wave 7 — Improve loop exit criteria.
 * Queue ≤3 cols; ?issue= deep-link; path soup killed; Advanced satellites;
 * Ledger+promotions; diff polish; U20 toasts; Issue→Artifact→Promote ≤5 clicks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { improveHref } from "@/lib/portal-cross-links";
import { queueItemMatchesIssue } from "@/lib/improve-queue-issue";
import type { ImproveQueueItem } from "@/lib/api";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import { buildNavCommands, PALETTE_ACTIONS } from "@/lib/nav-commands";
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

function item(partial: Partial<ImproveQueueItem>): ImproveQueueItem {
  return {
    ref: "issue:x",
    item_type: "issue",
    title: "t",
    column: "needs_you",
    severity: "medium",
    status: "open",
    ...partial,
  };
}

describe("Wave 7 improve loop exit", () => {
  const improve = read("app/(portal)/improve/page.tsx");

  it("marks wave7-improve completed", () => {
    expect(improve).toContain("WAVE7_IMPROVE_COMPLETED = true");
    expect(improve).toContain('data-wave7-improve="completed"');
  });

  it("7.1 queue uses exactly 3 views (Needs you / In progress / Verify)", () => {
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
    expect(improve).not.toContain("2xl:grid-cols-5");
    expect(cols).toContain("queueColumnId");
  });

  it("7.2 kills path overflow — related strip only", () => {
    expect(improve).toContain("ImproveRelatedStrip");
    expect(improve).not.toContain("PATH_LINKS");
    expect(improve).not.toContain("DropdownMenuLabel>Go to");
    expect(improve).not.toContain('href: "/improve/scorecard"');
    expect(improve).not.toContain("<CrossLinkBar");
    const related = read("app/(portal)/improve/_components/improve-constants.ts");
    const strip = read(
      "app/(portal)/improve/_components/improve-related-strip.tsx",
    );
    expect(strip).toContain('data-testid="improve-related-strip"');
    expect(related).toContain('href: "/prompts"');
    expect(related).not.toContain("/improve/scorecard");
  });

  it("honors improveHref(?issue=) without Issues chrome", () => {
    const hook = read("app/(portal)/improve/_components/use-improve-queue.ts");
    const board = read("app/(portal)/improve/_components/queue-board.tsx");
    expect(improveHref("iss-42")).toBe("/improve?issue=iss-42");
    expect(hook).toContain('searchParams.get("issue")');
    expect(hook).toContain("queueItemMatchesIssue");
    expect(board).toContain('data-testid="improve-issue-filter"');
    expect(improve).not.toContain("Issues list");
    expect(improve).not.toContain("alert-rules");
  });

  it("queueItemMatchesIssue matches ref / payload / href", () => {
    expect(queueItemMatchesIssue(item({ ref: "issue:abc" }), "abc")).toBe(true);
    expect(
      queueItemMatchesIssue(
        item({ ref: "closed_loop:1", payload: { issue_id: "abc" } }),
        "abc",
      ),
    ).toBe(true);
    expect(
      queueItemMatchesIssue(
        item({
          ref: "improvement_plan:p1",
          payload: { source_ref: "issue:abc" },
        }),
        "abc",
      ),
    ).toBe(true);
    expect(queueItemMatchesIssue(item({ ref: "issue:other" }), "abc")).toBe(false);
  });
});

describe("W7 plans / runs / artifacts / ledger", () => {
  it("7.3 plans list calm — inline KPI + row list", () => {
    const plans = read("app/(portal)/improve/plans/page.tsx");
    expect(plans).toContain('data-testid="improve-plans-kpi"');
    expect(plans).toContain('data-testid="improve-plans-list"');
    expect(plans).not.toContain("StatCard");
    expect(plans).not.toContain('from "@/components/ui/card"');
  });

  it("7.3 plans detail uses Panel not Card walls", () => {
    const detail = read("app/(portal)/improve/plans/[id]/page.tsx");
    const body = read(
      "app/(portal)/improve/plans/[id]/_components/plan-detail-body.tsx",
    );
    expect(body).toContain("DiffViewer");
    expect(body).toContain('from "@/components/ui/panel"');
    expect(detail).not.toContain('from "@/components/ui/card"');
    expect(body).not.toContain('from "@/components/ui/card"');
  });

  it("7.4 runs history dense table", () => {
    const runs = read("app/(portal)/improve/runs/page.tsx");
    expect(runs).toContain('data-testid="improve-runs-table"');
    expect(runs).toContain("py-space-1.5");
  });

  it("7.5 artifacts hub without CrossLinkBar card walls", () => {
    const artifacts = readArtifactsSurface();
    expect(artifacts).toContain('variant="underline"');
    expect(artifacts).toContain("<details");
    expect(artifacts).toContain('data-testid="artifacts-related-strip"');
    expect(artifacts).not.toContain("<CrossLinkBar");
  });

  it("7.6 ledger merges promotions as one institutional memory surface", () => {
    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).toContain('value="promotions"');
    expect(ledger).toContain('data-testid="ledger-related-strip"');
    expect(ledger).not.toContain("<CrossLinkBar");
  });
});

describe("W7 advanced / diff / toasts / E2E", () => {
  it("7.7 scorecard / online-scoring / change-impact are Advanced Improve", () => {
    for (const rel of [
      "app/(portal)/improve/scorecard/page.tsx",
      "app/(portal)/improve/online-scoring/page.tsx",
      "app/(portal)/improve/change-impact/page.tsx",
    ]) {
      expect(read(rel)).toContain("Advanced · Improve");
      expect(read(rel)).not.toContain("<CrossLinkBar");
    }
    const advanced = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
      (i) => i.category === "advanced",
    );
    const hrefs = advanced.map((i) => i.href);
    expect(hrefs).toContain("/improve/scorecard");
    expect(hrefs).toContain("/improve/online-scoring");
    expect(hrefs).toContain("/improve/change-impact");
    expect(PALETTE_ACTIONS.some((a) => a.href === "/improve/change-impact")).toBe(
      true,
    );
    expect(buildNavCommands().some((c) => c.href === "/improve/change-impact")).toBe(
      true,
    );
  });

  it("7.8 diff viewer polish", () => {
    const diff = read("components/improve/diff-viewer.tsx");
    expect(diff).toContain('data-testid="diff-viewer"');
    expect(diff).toContain('from "@/components/ui/button"');
    expect(diff).not.toContain("text-[10px]");
    expect(diff).toContain('aria-label="Diff layout"');
  });

  it("7.9 U20_TOAST_MUTATIONS complete", () => {
    expect(U20_TOAST_MUTATIONS).toContain("improve.approve");
    expect(U20_TOAST_MUTATIONS).toContain("plan.approve");
    expect(U20_TOAST_MUTATIONS).toContain("artifact.promote");
    for (const key of U20_TOAST_MUTATIONS) {
      const rel = U20_TOAST_MUTATION_SOURCES[key];
      expect(read(rel), key).toContain("toast.success");
    }
  });

  it("7.10 Issue→Artifact→Promote ≤5 clicks", () => {
    const header = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(header).toContain('href="/artifacts"');
    expect(header).toContain("Open artifacts");
    expect(header).toContain("improveHref");

    const artifacts = readArtifactsSurface();
    expect(artifacts).toContain("doPromote");
    expect(artifacts).toContain('toast.success("Artifact promoted")');
  });
});
