import { describe, expect, it } from "vitest";
import { parseInstallationId } from "@/lib/github-install";

describe("parseInstallationId", () => {
  it("parses positive digit strings", () => {
    expect(parseInstallationId("12345678")).toBe(12345678);
    expect(parseInstallationId(" 99 ")).toBe(99);
  });

  it("rejects nullish, empty, and non-digits", () => {
    expect(parseInstallationId(null)).toBeNull();
    expect(parseInstallationId(undefined)).toBeNull();
    expect(parseInstallationId("")).toBeNull();
    expect(parseInstallationId("abc")).toBeNull();
    expect(parseInstallationId("12.3")).toBeNull();
    expect(parseInstallationId("-1")).toBeNull();
    expect(parseInstallationId("0")).toBeNull();
  });
});
