import { describe, expect, it } from "vitest";
import { formatCurrency, formatUsd } from "@/lib/format";

describe("money grammar (R041)", () => {
  it("formats known zero as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatCurrency(0)).toBe("$0.00");
  });
  it("formats unknown as em dash", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatCurrency(null)).toBe("—");
  });
  it("never uses a USD prefix", () => {
    expect(formatUsd(0)).not.toMatch(/USD/);
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
