/**
 * Wave 19 — Improve depth + onboarding structural + contract tests.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { textToUnifiedDiff } from "@/components/improve/markdown-prose";
import { readApiModules } from "./_read-api";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const apiSrc = () => readApiModules(ROOT);
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");

describe("W19 Improve cockpit", () => {
  it("sorts queue items by severity and keeps CrossLinks/Empty/Error/NoOrg", () => {
    const page = src("app/(portal)/improve/page.tsx");
    expect(page).toContain("severityRank");
    expect(page).toContain("SEVERITY_RANK");
    expect(page).toContain("CrossLinkBar");
    expect(page).toContain("EmptyState");
    expect(page).toContain("ErrorState");
    expect(page).toContain("NoOrgState");
  });

  it("humanizes change-impact and scorecard pages", () => {
    const impact = src("app/(portal)/improve/change-impact/page.tsx");
    expect(impact).toContain("REC_META");
    expect(impact).toContain("recommendation_reasons");
    expect(impact).not.toMatch(/JSON\.stringify\(report\.regression_eval/);
    const score = src("app/(portal)/improve/scorecard/page.tsx");
    expect(score).toContain("METRIC_LABELS");
    expect(score).toContain("All process gates passed");
    expect(score).toContain("Synthetic process gate");
    expect(score).toContain("n/a (synthetic)");
  });
});

describe("W19 U05 Book / Drift", () => {
  it("renders markdown prose and DiffViewer on ledger/book", () => {
    expect(existsSync(resolve(ROOT, "src/components/improve/markdown-prose.tsx"))).toBe(
      true,
    );
    const ledger = src("app/(portal)/agents/[id]/ledger/page.tsx");
    expect(ledger).toContain("MarkdownProse");
    expect(ledger).toContain("DiffViewer");
    expect(ledger).toContain("CitationChip");
    expect(ledger).toContain("Preview inject");
    const book = src("app/(portal)/agents/[id]/book/page.tsx");
    expect(book).toContain("ledger/page");
    expect(book).not.toContain("redirect(");
  });

  it("builds unified diffs for DiffViewer", () => {
    const diff = textToUnifiedDiff("a\nb", "a\nc", "ch");
    expect(diff).toContain("--- a/ch");
    expect(diff).toContain("+c");
    expect(diff).toContain("-b");
  });

  it("drift drills to filtered traces", () => {
    const drift = src("app/(portal)/agents/[id]/drift/page.tsx");
    expect(drift).toContain("tracesFilteredHref");
    expect(drift).toContain("DriftHistogram");
  });
});

describe("W19 Promotions EvidenceGate + bulk", () => {
  it("shows EvidenceGate and BulkActionBar approve", () => {
    const page = src("app/(portal)/promotions/page.tsx");
    expect(page).toContain("EvidenceGateSummary");
    expect(page).toContain("data-testid=\"evidence-gate\"");
    expect(page).toContain("BulkActionBar");
    expect(page).toContain("Bulk approve");
    expect(page).toContain("getPromotion");
  });
});

describe("W19 U17 prompt environments + F68", () => {
  it("ships env deploy panel wired to wave6Api", () => {
    expect(
      existsSync(resolve(ROOT, "src/components/prompts/PromptEnvironmentsPanel.tsx")),
    ).toBe(true);
    const panel = src("components/prompts/PromptEnvironmentsPanel.tsx");
    expect(panel).toContain("listPromptEnvironments");
    expect(panel).toContain("deployPrompt");
    expect(src("app/(portal)/prompts/page.tsx")).toContain("PromptEnvironmentsPanel");
    expect(apiSrc()).toContain("listPromptEnvironments");
  });
});

describe("W19 U09 editable Home + cost Δ", () => {
  it("persists editable layout and surfaces cost delta", () => {
    const dash = src("app/(portal)/dashboard/page.tsx");
    expect(dash).toContain("Edit layout");
    expect(dash).toContain("eden.home.layout");
    expect(dash).toContain("costDeltaPct");
    expect(dash).toContain("costKpi");
  });
});

describe("W19 live improvement-loop onboarding", () => {
  it("API route + client consume live steps", () => {
    const learn = py("eden/api/routes/learn.py");
    expect(learn).toContain("/onboarding/improvement-loop");
    expect(learn).toContain("improvement_loop_status");
    const page = src("app/(portal)/onboarding/improvement-loop.tsx");
    expect(page).toContain("improvementLoopStatus");
    expect(page).not.toContain("const STEPS = [");
    expect(apiSrc()).toContain("improvementLoopStatus");
  });
});

describe("W19 agents/fleet/audit + Settings FinOps", () => {
  it("migrates hubs to CoreResourcePage", () => {
    expect(src("app/(portal)/agents/page.tsx")).toContain("CoreResourcePage");
    expect(src("app/(portal)/fleet/page.tsx")).toContain("CoreResourcePage");
    expect(src("app/(portal)/audit-trail/page.tsx")).toContain("CoreResourcePage");
  });

  it("adds searchable FinOps kills settings tab", () => {
    expect(existsSync(resolve(ROOT, "src/app/(portal)/settings/_components/finops-kills-tab.tsx"))).toBe(
      true,
    );
    const settings = src("app/(portal)/settings/page.tsx");
    expect(settings).toContain("finops");
    expect(settings).toContain("FinOps kills");
    expect(settings).toContain("keywords");
    expect(apiSrc()).toContain("setFinopsKillSwitch");
  });
});
