/**
 * Wave E2 — Datasets curate OS contracts (M6 / M13 / M15).
 * Unit/source greps only — no full E2E/axe.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function countLines(rel: string): number {
  return read(rel).split("\n").length;
}

describe("Wave E2 datasets list shell (E2.1 / M13 / M15)", () => {
  it("splits list into use-datasets-page + _components; shell ≤400 LOC", () => {
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/datasets/_components/use-datasets-page.ts"),
      ),
    ).toBe(true);
    const shell = countLines("app/(portal)/datasets/page.tsx");
    expect(shell).toBeLessThanOrEqual(400);
    const page = read("app/(portal)/datasets/page.tsx");
    expect(page).toContain("WAVE_E2_DATASETS_LIST_COMPLETED");
    expect(page).toContain('data-wave-e2-datasets="list"');
    expect(page).toMatch(/use-datasets-page/);
  });

  it("kills dual search — single ResourceOsToolbar q only (M13)", () => {
    const page = read("app/(portal)/datasets/page.tsx");
    const hook = read("app/(portal)/datasets/_components/use-datasets-page.ts");
    const combined = `${page}\n${hook}`;
    // No DataTableSearch on list surface
    expect(combined).not.toContain("DataTableSearch");
    expect(combined).toContain("ResourceOsToolbar");
    expect(combined).toContain('resourceKey="datasets"');
    expect(combined).toContain('data-wave-e2-search="single"');
  });

  it("wires saved views via ResourceOsToolbar / useSavedViews (M15)", () => {
    const page = read("app/(portal)/datasets/page.tsx");
    const hook = read("app/(portal)/datasets/_components/use-datasets-page.ts");
    const toolbarPath = resolve(
      portalSrc,
      "app/(portal)/datasets/_components/datasets-toolbar.tsx",
    );
    const toolbar = existsSync(toolbarPath)
      ? read("app/(portal)/datasets/_components/datasets-toolbar.tsx")
      : "";
    const combined = `${page}\n${hook}\n${toolbar}`;
    expect(combined).toMatch(/resourceKey=["']datasets["']/);
    expect(combined).toContain('data-wave-e2-saved-views="datasets"');
  });

  it("create + promote stay in Evaluate IA", () => {
    const hook = read("app/(portal)/datasets/_components/use-datasets-page.ts");
    expect(hook).toContain("/evals?tab=datasets");
    expect(hook).toContain("promoteFromTrace");
    expect(hook).toContain("datasetId");
    // Create must not deep-link only to /datasets/${id} leaf as primary IA land
    expect(hook).toMatch(/\/evals\?tab=datasets&datasetId=/);
  });

  it("keeps QueryState completeness", () => {
    const page = read("app/(portal)/datasets/page.tsx");
    const tablePath = resolve(
      portalSrc,
      "app/(portal)/datasets/_components/datasets-table.tsx",
    );
    const table = existsSync(tablePath)
      ? read("app/(portal)/datasets/_components/datasets-table.tsx")
      : "";
    const combined = `${page}\n${table}`;
    expect(combined).toContain("<QueryState");
    expect(combined).toContain("Could not load datasets");
    expect(combined).toContain("onRetry=");
  });
});

describe("Wave E2 dataset detail (E2.2 / M6)", () => {
  it("splits detail into hook + _components; shell ≤400 LOC", () => {
    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/datasets/[id]/_components/use-dataset-detail.ts",
        ),
      ),
    ).toBe(true);
    const shell = countLines("app/(portal)/datasets/[id]/page.tsx");
    expect(shell).toBeLessThanOrEqual(400);
    const page = read("app/(portal)/datasets/[id]/page.tsx");
    expect(page).toContain("WAVE_E2_DATASETS_DETAIL_COMPLETED");
    expect(page).toContain('data-wave-e2-datasets="detail"');
  });

  it("Start experiment is solid primary CTA (M6 Langfuse)", () => {
    const page = read("app/(portal)/datasets/[id]/page.tsx");
    const hook = read(
      "app/(portal)/datasets/[id]/_components/use-dataset-detail.ts",
    );
    const toolbarCandidates = [
      "app/(portal)/datasets/[id]/_components/dataset-detail-header.tsx",
      "app/(portal)/datasets/[id]/_components/dataset-detail-actions.tsx",
      "app/(portal)/datasets/[id]/page.tsx",
    ];
    const surfaces = [
      page,
      hook,
      ...toolbarCandidates
        .filter((p) => existsSync(resolve(portalSrc, p)))
        .map((p) => read(p)),
    ].join("\n");
    expect(surfaces).toContain("Start experiment");
    expect(surfaces).toContain('data-wave-e2-start-experiment="primary"');
    expect(surfaces).toContain('data-testid="dataset-start-experiment"');
    expect(surfaces).toContain("offlineExperimentsApi.create");
    expect(surfaces).toContain("/evals?tab=experiments");
    // Must not be outline-only primary (Langfuse solid)
    expect(surfaces).toMatch(
      /data-wave-e2-start-experiment="primary"[\s\S]{0,200}Start experiment|Start experiment[\s\S]{0,200}data-wave-e2-start-experiment="primary"/,
    );
    // Outline variant must not sit on the Start experiment primary button
    const primaryBlock = surfaces.match(
      /data-testid="dataset-start-experiment"[\s\S]{0,120}|dataset-start-experiment[\s\S]{0,200}Start experiment/,
    );
    expect(primaryBlock?.[0] ?? "").not.toMatch(/variant=["']outline["']/);
  });

  it("spreadsheet marker + density-aware virtualization", () => {
    const page = read("app/(portal)/datasets/[id]/page.tsx");
    const sheetPath = resolve(
      portalSrc,
      "app/(portal)/datasets/[id]/_components/dataset-spreadsheet.tsx",
    );
    const sheet = existsSync(sheetPath)
      ? read("app/(portal)/datasets/[id]/_components/dataset-spreadsheet.tsx")
      : page;
    expect(`${page}\n${sheet}`).toContain('data-wave-e2-spreadsheet="grid"');
  });

  it("preserves cellValue top-level input/expected_output contract", () => {
    const cellsPath = resolve(
      portalSrc,
      "app/(portal)/datasets/[id]/_components/dataset-cells.ts",
    );
    const src = existsSync(cellsPath)
      ? read("app/(portal)/datasets/[id]/_components/dataset-cells.ts")
      : read("app/(portal)/datasets/[id]/page.tsx");
    expect(src).toMatch(/function cellValue|export function cellValue/);
    expect(src).toContain("row.input");
    expect(src).toContain("row.expected_output");
    expect(src).toContain('key === "input"');
  });
});
