/**
 * ui-audit 2026-07-06 H1: lock the SSR-fallback contract for the
 * chart palette. If someone changes --chart-pie-N in globals.css
 * and forgets to update STORAGE_COLORS_SSR_FALLBACK, the first
 * server render will flash the wrong colors. This test catches
 * the drift between the design tokens and the SSR fallback.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  STORAGE_COLORS,
  STORAGE_COLORS_SSR_FALLBACK,
  getStorageColorsResolved,
  CHART_COLORS,
} from "../chart-colors";

describe("chart-colors SSR fallback contract (audit H1)", () => {
  it("fallback hex values match the --chart-pie-N tokens in globals.css", () => {
    // Read globals.css and parse --chart-pie-N out of it.
    const globalsPath = resolve(__dirname, "../../app/globals.css");
    const css = readFileSync(globalsPath, "utf8");
    const tokenMap: Record<number, string> = {};
    const re = /--chart-pie-(\d+):\s*(#[0-9a-fA-F]{3,8})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      tokenMap[Number(m[1])] = m[2];
    }

    // STORAGE_COLORS_SSR_FALLBACK[i] should match --chart-pie-(i+1).
    for (let i = 0; i < STORAGE_COLORS_SSR_FALLBACK.length; i++) {
      const tokenIdx = i + 1;
      const expected = tokenMap[tokenIdx];
      expect(expected, `--chart-pie-${tokenIdx} not found in globals.css`).toBeTruthy();
      expect(STORAGE_COLORS_SSR_FALLBACK[i]).toBe(expected);
    }
  });

  it("STORAGE_COLORS exposes var() refs to all five --chart-pie-N tokens", () => {
    expect(STORAGE_COLORS).toHaveLength(5);
    expect(STORAGE_COLORS[0]).toBe("var(--chart-pie-1)");
    expect(STORAGE_COLORS[4]).toBe("var(--chart-pie-5)");
  });

  it("getStorageColorsResolved returns SSR fallback on the server", () => {
    // No window in vitest by default — should fall back.
    const result = getStorageColorsResolved();
    expect(result).toEqual(STORAGE_COLORS_SSR_FALLBACK);
  });

  it("CHART_COLORS uses var() refs (recharts accepts var() for some props)", () => {
    // Sanity-check the canonical token set is wired up.
    expect(CHART_COLORS.accent).toBe("var(--chart-accent)");
    expect(CHART_COLORS.primary).toBe("var(--chart-primary)");
    expect(CHART_COLORS.outcome.gold).toBe("var(--chart-outcome-gold)");
    expect(CHART_COLORS.outcome.failed).toBe("var(--chart-outcome-failed)");
    expect(CHART_COLORS.grid).toBe("var(--chart-grid)");
  });
});
