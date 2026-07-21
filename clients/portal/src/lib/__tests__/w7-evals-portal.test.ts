/**
 * Wave 7 — Evaluate hub exit contracts.
 * 3 primary tabs; Advanced embeds; no Go-to dupes; master–detail datasets;
 * one Run CTA; side-by-side compare; labeling empty sources; deep-link preserve.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  playgroundHref,
  promoteTraceToDatasetHref,
  traceHref,
  tracesFilteredHref,
} from "@/lib/portal-cross-links";
import { MASTER_DETAIL_QUERY_KEYS } from "@/components/portal-os/CoreResourcePage";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W7 Evaluate hub shell", () => {
  it("exposes exactly three primary TabsTriggers + Advanced overflow", () => {
    const page = src("app/(portal)/evals/page.tsx");
    expect(page).toContain('PRIMARY_TABS = ["datasets", "playgrounds", "experiments"]');
    expect(page).toContain(
      'ADVANCED_TABS = ["eval", "labeling", "studio", "synthetic"]',
    );
    expect(page).toContain('data-testid="evals-advanced"');
    expect(page).toContain("Advanced");
    // No redundant Go-to path links duplicating primary tabs
    expect(page).not.toContain("PATH_LINKS");
    expect(page).not.toContain("DropdownMenuLabel>Go to");
    expect(page).not.toContain(">Go to<");
  });

  it("embeds labeling / studio / synthetic behind Advanced tabs", () => {
    const page = src("app/(portal)/evals/page.tsx");
    for (const tab of ["labeling", "studio", "synthetic", "eval"]) {
      expect(page).toContain(`value="${tab}"`);
    }
    expect(page).toContain('import("@/app/(portal)/labeling/page")');
    expect(page).toContain('import("@/app/(portal)/studio/page")');
    expect(page).toContain('import("@/app/(portal)/synthetic/page")');
  });
});

describe("W7 datasets master–detail", () => {
  it("peeks via datasetId DetailPanelShell without Card walls", () => {
    const page = src("app/(portal)/datasets/page.tsx");
    const peek = src("app/(portal)/datasets/_components/datasets-detail-peek.tsx");
    const table = src("app/(portal)/datasets/_components/datasets-table.tsx");
    const hook = src("app/(portal)/datasets/_components/use-datasets-page.ts");
    expect(hook).toContain("datasetId");
    expect(peek).toContain("DetailPanelShell");
    expect(peek).toContain("dataset-detail-peek");
    expect(table).toContain("onRowClick");
    expect(page).not.toContain("DropdownMenuLabel>Go to");
    expect(page).not.toContain(">Go to<");
    expect(MASTER_DETAIL_QUERY_KEYS.datasetId[0]).toBe("datasetId");
  });
});

describe("W7 playgrounds one Run CTA", () => {
  it("keeps a single primary Run button; New is outline", () => {
    const page = src("app/(portal)/playgrounds/page.tsx");
    expect(page).toContain('data-testid="playground-run-cta"');
    // New playground is outline/secondary; Run is the solid primary CTA
    const newIdx = page.indexOf("New playground");
    const runIdx = page.indexOf('data-testid="playground-run-cta"');
    expect(newIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    const newWindow = page.slice(Math.max(0, newIdx - 200), newIdx);
    expect(newWindow).toContain('variant="outline"');
    expect(page).toContain("<Play className=\"h-3.5 w-3.5\" /> Run");
  });
});

describe("W7 experiments side-by-side compare", () => {
  it("renders compare score columns and drops Go to overflow", () => {
    const page = src("app/(portal)/experiments/page.tsx");
    const panel = src("app/(portal)/experiments/_components/compare-panel.tsx");
    expect(panel).toContain("Side-by-side scores");
    expect(panel).toContain("compare-score-headers");
    expect(page).toContain("Compare selected");
    expect(page).not.toContain("DropdownMenuLabel>Go to");
    expect(page).not.toContain(">Go to<");
  });
});

describe("W7 labeling empty sources", () => {
  it("teaches three next steps on empty queue", () => {
    const table = src("app/(portal)/labeling/_components/labeling-items-table.tsx");
    expect(table).toContain("labeling-empty-sources");
    expect(table).toContain("From traces");
    expect(table).toContain("labeling-empty-seed");
    expect(table).toContain("Create queue");
  });
});

describe("W7 studio split", () => {
  it("moves tab bodies under _components; page stays a shell", () => {
    const page = src("app/(portal)/studio/page.tsx");
    expect(page.split("\n").length).toBeLessThan(200);
    expect(existsSync(resolve(ROOT, "src/app/(portal)/studio/_components/templates-tab.tsx"))).toBe(
      true,
    );
    expect(
      existsSync(resolve(ROOT, "src/app/(portal)/studio/_components/from-examples-tab.tsx")),
    ).toBe(true);
    expect(
      existsSync(resolve(ROOT, "src/app/(portal)/studio/_components/my-metrics-tab.tsx")),
    ).toBe(true);
  });
});

describe("W7 Eval ↔ Trace deep links preserve filters/time", () => {
  it("traceHref and promote helpers carry pastHours / q / realm", () => {
    const href = traceHref("t1", {
      pastHours: "24",
      q: "status:error",
      realm: "prod",
      outcome: "error",
    });
    expect(href).toContain("traceId=t1");
    expect(href).toContain("pastHours=24");
    expect(href).toContain("q=status%3Aerror");
    expect(href).toContain("realm=prod");
    expect(href).toContain("outcome=error");

    const pg = playgroundHref("t1", "s1", { pastHours: "6", agent_id: "a1" });
    expect(pg).toContain("tab=playgrounds");
    expect(pg).toContain("trace_id=t1");
    expect(pg).toContain("pastHours=6");
    expect(pg).toContain("agent_id=a1");

    const promote = promoteTraceToDatasetHref("t9", { pastHours: "12" });
    expect(promote).toContain("tab=datasets");
    expect(promote).toContain("promote_trace=t9");
    expect(promote).toContain("pastHours=12");

    const filtered = tracesFilteredHref({
      agent_id: "a1",
      pastHours: "48",
      outcome: "error",
    });
    expect(filtered).toContain("pastHours=48");
    expect(filtered).toContain("outcome=error");
  });
});
