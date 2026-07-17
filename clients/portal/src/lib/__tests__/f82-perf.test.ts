import { describe, expect, it } from "vitest";
import {
  WEB_VITAL_BUDGETS,
  F82_CORE_ROUTES,
  budgetFailures,
  exceedsBudget,
} from "@/lib/perf/budgets";
import { markEden, readEdenMarks, clearEdenMarks } from "@/lib/perf/marks";

describe("F82 Web Vitals budgets", () => {
  it("defines LCP and INP gates for core routes", () => {
    expect(WEB_VITAL_BUDGETS.LCP.max).toBeLessThanOrEqual(3000);
    expect(WEB_VITAL_BUDGETS.INP.max).toBeLessThanOrEqual(300);
    expect(F82_CORE_ROUTES).toContain("/dashboard");
    expect(F82_CORE_ROUTES).toContain("/traces");
  });

  it("flags regressions beyond budget", () => {
    expect(exceedsBudget({ route: "/traces", name: "LCP", value: 5000 })).toBe(true);
    expect(exceedsBudget({ route: "/traces", name: "INP", value: 100 })).toBe(false);
    const fails = budgetFailures([
      { route: "/dashboard", name: "LCP", value: 2000 },
      { route: "/traces", name: "INP", value: 400 },
    ]);
    expect(fails).toHaveLength(1);
    expect(fails[0]?.name).toBe("INP");
  });
});

describe("F82 perf marks", () => {
  it("records eden marks in memory", () => {
    clearEdenMarks();
    markEden("eden:page", "/traces");
    markEden("eden:table_query", "/issues");
    const marks = readEdenMarks();
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks.some((m) => m.name === "eden:page" && m.detail === "/traces")).toBe(true);
  });
});
