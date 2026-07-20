/**
 * Wave 4.2 — Datasets + labeling CRUD UX, empty CTAs, ErrorState vs false empty.
 *
 * Load failures must use in-page ErrorState (not empty table / toast-only).
 * Filter misses must not claim first-run empty. Route error boundaries ship
 * under datasets/ and labeling/. Spreadsheet cells read top-level input fields.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showDatasetsEmpty(opts: {
  loading: boolean;
  error: string | null;
  filteredCount: number;
}): boolean {
  return !opts.loading && !opts.error && opts.filteredCount === 0;
}

function datasetsEmptyCopy(opts: {
  filterActive: boolean;
  datasetsCount: number;
}): { title: string; clearFilter: boolean } {
  if (opts.filterActive && opts.datasetsCount > 0) {
    return { title: "No matching datasets", clearFilter: true };
  }
  return { title: "No datasets", clearFilter: false };
}

function cellValue(
  row: { input?: string; expected_output?: string; values?: Record<string, unknown> },
  key: string,
): string {
  if (key === "input" && row.input != null && String(row.input).length > 0) {
    return String(row.input);
  }
  if (
    key === "expected_output" &&
    row.expected_output != null &&
    String(row.expected_output).length > 0
  ) {
    return String(row.expected_output);
  }
  const fromValues = row.values?.[key];
  if (fromValues != null && String(fromValues).length > 0) return String(fromValues);
  if (key === "input") return String(row.input ?? "");
  if (key === "expected_output") return String(row.expected_output ?? "");
  return "";
}

describe("W4-2 datasets query states", () => {
  it("gates list behind QueryState with retry (not false empty on 5xx)", () => {
    const src = read("app/(portal)/datasets/page.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain("Could not load datasets");
    expect(src).toContain("<QueryState");
    expect(src).toContain("onRetry={load}");
  });

  it("does not show empty while loading or on error", () => {
    expect(
      showDatasetsEmpty({ loading: true, error: null, filteredCount: 0 }),
    ).toBe(false);
    expect(
      showDatasetsEmpty({ loading: false, error: "boom", filteredCount: 0 }),
    ).toBe(false);
    expect(
      showDatasetsEmpty({ loading: false, error: null, filteredCount: 0 }),
    ).toBe(true);
  });

  it("filter miss uses clear-filter CTA, not first-run empty", () => {
    const src = read("app/(portal)/datasets/page.tsx");
    expect(src).toContain("No matching datasets");
    expect(src).toContain('data-testid="datasets-clear-filter"');
    expect(src).toContain('data-testid="datasets-empty-create"');
    expect(
      datasetsEmptyCopy({ filterActive: true, datasetsCount: 3 }),
    ).toEqual({ title: "No matching datasets", clearFilter: true });
    expect(
      datasetsEmptyCopy({ filterActive: false, datasetsCount: 0 }),
    ).toEqual({ title: "No datasets", clearFilter: false });
  });

  it("ships route error.tsx under datasets/", () => {
    expect(existsSync(resolve(portalSrc, "app/(portal)/datasets/error.tsx"))).toBe(true);
    expect(existsSync(resolve(portalSrc, "app/(portal)/datasets/[id]/error.tsx"))).toBe(true);
    const err = read("app/(portal)/datasets/error.tsx");
    expect(err).toContain("ErrorState");
    expect(err).toContain("Try again");
  });
});

describe("W4-2 dataset detail spreadsheet cells", () => {
  it("reads top-level input/expected_output (not values-only)", () => {
    const src = read("app/(portal)/datasets/[id]/page.tsx");
    expect(src).toContain("function cellValue");
    expect(src).toContain("row.input");
    expect(src).toContain("row.expected_output");
    expect(src).toContain('key === "input"');
    expect(src).toContain("expected_output: value");
    // Load failure is ErrorState-only (no toast on load catch).
    expect(src).not.toMatch(/catch \(e\) \{\s*const msg[\s\S]*toast\.error\(msg\)/);
  });

  it("cellValue prefers top-level spreadsheet fields", () => {
    expect(
      cellValue(
        { input: "hello", expected_output: "world", values: {} },
        "input",
      ),
    ).toBe("hello");
    expect(
      cellValue(
        { input: "hello", expected_output: "world", values: {} },
        "expected_output",
      ),
    ).toBe("world");
    expect(
      cellValue({ values: { custom: "x" } }, "custom"),
    ).toBe("x");
  });

  it("gates mutation chrome and empty CTAs behind successful load", () => {
    const src = read("app/(portal)/datasets/[id]/page.tsx");
    expect(src).toContain("Could not load dataset");
    expect(src).toContain("Import file");
    expect(src).toMatch(/disabled=\{!canMutate\}/);
    expect(src).toMatch(/\{error && !loading \?[\s\S]*ErrorState/);
    expect(src).toMatch(/\{!error \? \(/);
  });
});

describe("W4-2 labeling CRUD + empty CTAs", () => {
  it("uses UI Tag chips (not lucide Tag as chip wrapper)", () => {
    const src = read("app/(portal)/labeling/page.tsx");
    expect(src).toContain('from "@/components/ui/tag"');
    expect(src).toContain("Tag as TagIcon");
    expect(src).toMatch(/<(Tag)\s+key=\{t\}/);
    expect(src).not.toMatch(/import \{\s*Tag\s*,/);
  });

  it("gates items list behind QueryState; empty has seed CTA", () => {
    const src = read("app/(portal)/labeling/page.tsx");
    expect(src).toContain("Could not load labeling queue");
    expect(src).toContain('data-testid="labeling-empty-seed"');
    expect(src).toContain("No matching items");
    expect(src).toContain('data-testid="labeling-clear-filter"');
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain("<QueryState");
  });

  it("surfaces queue list + create with ErrorState on queues 5xx", () => {
    const src = read("app/(portal)/labeling/page.tsx");
    expect(src).toContain("labelingQueuesApi");
    expect(src).toContain("Could not load labeling queues");
    expect(src).toContain('data-testid="labeling-create-queue"');
    expect(src).toContain("/labeling/queues/");
    expect(src).toContain("router.push");
  });

  it("ships route error.tsx under labeling/", () => {
    expect(existsSync(resolve(portalSrc, "app/(portal)/labeling/error.tsx"))).toBe(true);
    expect(
      existsSync(resolve(portalSrc, "app/(portal)/labeling/queues/[id]/error.tsx")),
    ).toBe(true);
  });

  it("queue board empty has CTA back to labeling", () => {
    const src = read("app/(portal)/labeling/queues/[id]/page.tsx");
    expect(src).toContain("Could not load labeling board");
    expect(src).toContain("Back to labeling · seed item");
    expect(src).toMatch(/loadError \?[\s\S]*ErrorState/);
  });
});
