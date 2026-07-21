/**
 * Wave 15 — Portal HARDEN regression locks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPageContext } from "@/components/ai-insights/types";
import {
  buildNavCommands,
  SETTINGS_TAB_COMMANDS,
} from "@/lib/nav-commands";

const portalSrc = resolve(__dirname, "../..");
const root = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W15 Button sm + DataTable checkbox touch", () => {
  it("Button size=sm keeps ≥44px min-h", () => {
    const button = read("components/ui/button.tsx");
    // Desktop can be shorter; mobile keeps max-md:min-h-11 (≥44px).
    expect(button).toMatch(/sm:\s*"h-7 min-h-7 max-md:min-h-11/);
    expect(button).not.toMatch(/sm:\s*"h-8 /);
  });

  it("DataTable selection checkboxes use ≥44px hit labels", () => {
    const table = read("components/ui/data-table.tsx");
    expect(table).toContain("min-h-11 min-w-11");
    expect(table).toContain('aria-label="Select all on page"');
    expect(table).toMatch(/aria-label=\{`Select row/);
  });
});

describe("W15 peer closures (E-08 / E-04 / S-06 / I-02)", () => {
  it("buildPageContext includes eval object ids (E-08)", () => {
    const types = read("components/ai-insights/types.ts");
    expect(types).toContain("dataset_id");
    expect(types).toContain("playground_id");
    expect(types).toContain("experiment_id");
    expect(types).toContain('params?.get("datasetId")');
    expect(types).toContain('params?.get("playgroundId")');
    expect(types).toContain('params?.get("experimentId")');

    const ds = buildPageContext("/datasets/ds_abc");
    expect(ds.dataset_id).toBe("ds_abc");
    expect(ds.selected_id).toBe("ds_abc");

    const exp = buildPageContext("/experiments/exp_9");
    expect(exp.experiment_id).toBe("exp_9");
  });

  it("Playground creates dataset without leaving tab (E-04)", () => {
    const pg = read("app/(portal)/playgrounds/page.tsx");
    const hook = read(
      "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
    );
    expect(pg).toContain("createAndBindDataset");
    expect(hook).toContain("datasetsApi.create");
    expect(pg).toContain("Create dataset");
    expect(pg).toContain("Upload / manage");
  });

  it("S-06 settings tab commands + I-02 online scoring remain discoverable", () => {
    expect(SETTINGS_TAB_COMMANDS.length).toBeGreaterThanOrEqual(10);
    const cmds = buildNavCommands();
    expect(cmds.some((c) => c.href?.includes("/settings?tab="))).toBe(true);
    expect(cmds.some((c) => c.href === "/improve/online-scoring")).toBe(true);
  });
});

describe("W15 lint ratchet floors", () => {
  it("locks micro/half/accent + tablist baselines at post-W14 counts", () => {
    const classes = readFileSync(
      resolve(root, "scripts/lint-portal-classes.cjs"),
      "utf8",
    );
    const clutter = readFileSync(
      resolve(root, "scripts/lint-portal-clutter.cjs"),
      "utf8",
    );
    expect(classes).toMatch(/BASELINE_MICRO_TEXT\s*=\s*79/);
    expect(classes).toMatch(/BASELINE_HALF_STEP\s*=\s*112/);
    expect(classes).toMatch(/BASELINE_ACCENT_CTA\s*=\s*1/);
    expect(clutter).toMatch(/BASELINE_TABLIST_OUTSIDE\s*=\s*2/);
  });
});
