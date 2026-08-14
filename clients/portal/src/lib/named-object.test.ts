import { describe, expect, it } from "vitest";
import {
  CATCH_ALL_EQL_MESSAGE,
  countEventRows,
  isCatchAllEql,
  isUsableObjectName,
  parseAlertIntervalMinutes,
  sanitizeCompileWarnings,
} from "@/lib/named-object";

describe("named-object helpers (R022/R025/R026/R037)", () => {
  it("requires a non-empty trimmed name", () => {
    expect(isUsableObjectName("")).toBe(false);
    expect(isUsableObjectName("   ")).toBe(false);
    expect(isUsableObjectName("Eval set")).toBe(true);
  });

  it("rejects catch-all EQL", () => {
    expect(isCatchAllEql("WHERE 1=1")).toBe(true);
    expect(isCatchAllEql("select * from spans where 1 = 1")).toBe(true);
    expect(isCatchAllEql("")).toBe(true);
    expect(isCatchAllEql("status = 'error' AND latency_ms > 2000")).toBe(false);
  });

  it("strips internal compiler talk", () => {
    expect(
      sanitizeCompileWarnings([
        "Auto-injecting org filter",
        "returning 400 in strict mode",
        "No time window — defaulting to 24h",
      ]),
    ).toEqual(["No time window — defaulting to 24h"]);
  });

  it("rejects interval < 1 and non-numeric", () => {
    expect(parseAlertIntervalMinutes("-99")).toBeNull();
    expect(parseAlertIntervalMinutes("0")).toBeNull();
    expect(parseAlertIntervalMinutes("asdf")).toBeNull();
    expect(parseAlertIntervalMinutes("60")).toBe(60);
  });

  it("counts event rows for check-for-events toasts", () => {
    expect(countEventRows([])).toBe(0);
    expect(countEventRows([{ id: "1" }, { id: "2" }])).toBe(2);
    expect(countEventRows({ traces: [1] })).toBe(1);
    expect(CATCH_ALL_EQL_MESSAGE).toMatch(/real condition/);
  });
});
