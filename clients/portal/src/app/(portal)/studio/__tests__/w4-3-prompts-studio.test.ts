/**
 * W4.3 — Studio editors, save path, unsaved guards, ErrorState vs empty.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirror of studio metrics empty gate — keep in sync with page.tsx. */
function showStudioMetricsEmpty(opts: {
  loading: boolean;
  hasError: boolean;
  metricCount: number;
}): boolean {
  return !opts.loading && !opts.hasError && opts.metricCount === 0;
}

type ExampleRow = {
  input: string;
  output: string;
  label: "pass" | "fail";
  rationale: string;
};

/** Mirror of studioExamplesIsDirty — keep in sync with page.tsx. */
function studioExamplesIsDirty(opts: {
  generated: boolean;
  name: string;
  examples: ExampleRow[];
}): boolean {
  if (opts.generated) return true;
  if (opts.name.trim()) return true;
  return opts.examples.some(
    (e) => e.input.trim() || e.output.trim() || e.rationale.trim(),
  );
}

describe("W4.3 studio unsaved guards + template seed", () => {
  it("gates metrics empty behind !loading && !hasError", () => {
    const src = read("app/(portal)/studio/page.tsx");
    expect(src).toContain("showStudioMetricsEmpty");
    expect(src).toContain("Could not load metrics");
    expect(src).toContain("Try again");

    expect(
      showStudioMetricsEmpty({ loading: true, hasError: false, metricCount: 0 }),
    ).toBe(false);
    expect(
      showStudioMetricsEmpty({ loading: false, hasError: true, metricCount: 0 }),
    ).toBe(false);
    expect(
      showStudioMetricsEmpty({ loading: false, hasError: false, metricCount: 0 }),
    ).toBe(true);
  });

  it("marks from-examples dirty when generated or fields filled", () => {
    expect(
      studioExamplesIsDirty({
        generated: false,
        name: "",
        examples: [
          { input: "", output: "", label: "pass", rationale: "" },
          { input: "", output: "", label: "fail", rationale: "" },
        ],
      }),
    ).toBe(false);
    expect(
      studioExamplesIsDirty({
        generated: true,
        name: "",
        examples: [
          { input: "", output: "", label: "pass", rationale: "" },
          { input: "", output: "", label: "fail", rationale: "" },
        ],
      }),
    ).toBe(true);
    expect(
      studioExamplesIsDirty({
        generated: false,
        name: "Tone",
        examples: [
          { input: "", output: "", label: "pass", rationale: "" },
          { input: "", output: "", label: "fail", rationale: "" },
        ],
      }),
    ).toBe(true);
    expect(
      studioExamplesIsDirty({
        generated: false,
        name: "",
        examples: [
          { input: "hi", output: "", label: "pass", rationale: "" },
          { input: "", output: "", label: "fail", rationale: "" },
        ],
      }),
    ).toBe(true);
  });

  it("wires unsaved guards + Start from template into From examples", () => {
    const src = read("app/(portal)/studio/page.tsx");
    expect(src).toContain("beforeunload");
    expect(src).toContain("You have unsaved rubric work");
    expect(src).toContain("Discard the generated rubric?");
    expect(src).toContain("Start from template");
    expect(src).toContain("onUseTemplate");
    expect(src).toContain("onDirtyChange");
    expect(src).toContain("requestTabChange");
    expect(src).toContain("Save failed");
    expect(src).toContain("createMetric");
  });

  it("templates load uses in-page ErrorState without page-level onError side effect", () => {
    const src = read("app/(portal)/studio/page.tsx");
    expect(src).toContain("Could not load templates");
    expect(src).not.toMatch(
      /TemplatesTab[\s\S]*useEffect\(\(\) => \{\s*if \(templatesQuery\.error\) \{\s*onError/m,
    );
  });
});
