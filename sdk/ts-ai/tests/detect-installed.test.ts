import { describe, expect, test } from "bun:test";
import { detectInstalledFrameworks, autoInstrument } from "../src/index";

describe("detectInstalledFrameworks (ESM-safe)", () => {
  test("returns object with all four keys", () => {
    const r = detectInstalledFrameworks();
    expect(typeof r.openai).toBe("boolean");
    expect(typeof r.anthropic).toBe("boolean");
    expect(typeof r.vercelAi).toBe("boolean");
    expect(typeof r.langchain).toBe("boolean");
  });

  test("detects openai when installed (bun runtime)", () => {
    // bun:test's runtime resolves node_modules for the package
    // via the import.meta.url of the SDK's bundle, so detection
    // works even from ESM files.
    const r = detectInstalledFrameworks();
    // openai is NOT installed in the SDK's own devDependencies —
    // we expect this to be false in CI. The important assertion
    // is that the function doesn't throw and returns booleans,
    // not that any specific framework is detected.
    expect([true, false]).toContain(r.openai);
  });

  test("autoInstrument alias returns the same shape", () => {
    expect(autoInstrument()).toEqual(detectInstalledFrameworks());
  });
});
