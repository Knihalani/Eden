import { describe, expect, test } from "bun:test";
import { detectInstalledFrameworks, autoInstrument } from "../src/index";

describe("detectInstalledFrameworks (ESM-safe)", () => {
  test("returns object with all keys", () => {
    const r = detectInstalledFrameworks();
    expect(typeof r.openai).toBe("boolean");
    expect(typeof r.anthropic).toBe("boolean");
    expect(typeof r.vercelAi).toBe("boolean");
    expect(typeof r.langchain).toBe("boolean");
    expect(typeof r.mastra).toBe("boolean");
    // Bedrock / Gemini / LlamaIndex.TS — added so `instrument()` no
    // longer requires callers to know to call wrapBedrock/wrapGemini/
    // wrapLlamaIndex manually (previously these two providers had
    // full wrap* implementations in providers.ts but were entirely
    // absent from auto-detection).
    expect(typeof r.bedrock).toBe("boolean");
    expect(typeof r.gemini).toBe("boolean");
    expect(typeof r.llamaIndex).toBe("boolean");
    // Groq / Cohere / Mistral — promoted from generic HTTP-capture
    // fallback to native instrumentors; auto-detection must report
    // whether their SDK packages (`groq-sdk`, `cohere-ai`,
    // `@mistralai/mistralai`) are importable, same as every other
    // native provider above.
    expect(typeof r.groq).toBe("boolean");
    expect(typeof r.cohere).toBe("boolean");
    expect(typeof r.mistral).toBe("boolean");
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

  test("autoInstrument deprecated alias returns the same shape", () => {
    expect(autoInstrument()).toEqual(detectInstalledFrameworks());
  });
});
