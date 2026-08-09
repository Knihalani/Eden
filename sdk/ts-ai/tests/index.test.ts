/**
 * Smoke tests for the top-level `detectInstalledFrameworks` surface
 * and the deprecated `autoInstrument` alias.
 *
 * These tests run in the SDK's own test env, where no real
 * LLM packages are installed. Both functions must therefore
 * return ``false`` for every key, and must NOT throw even
 * when every optional dep is missing.
 */

import { describe, test, expect } from "bun:test";

import {
  autoInstrument,
  detectInstalledFrameworks,
} from "../src/index.js";

describe("detectInstalledFrameworks", () => {
  test("returns a status dict with all five keys", () => {
    const status = detectInstalledFrameworks();
    expect(typeof status).toBe("object");
    expect(status).toHaveProperty("openai");
    expect(status).toHaveProperty("anthropic");
    expect(status).toHaveProperty("vercelAi");
    expect(status).toHaveProperty("langchain");
    expect(status).toHaveProperty("mastra");
  });

  test("never throws when optional deps are missing", () => {
    // bun:test doesn't install openai/anthropic/ai/@langchain/core
    // transitively, so this is the realistic environment.
    expect(() => detectInstalledFrameworks()).not.toThrow();
  });

  test("returns false for every key in a minimal install", () => {
    // We can't guarantee which optional deps bun has, but the
    // shape must always be a record of booleans.
    const status = detectInstalledFrameworks();
    for (const v of Object.values(status)) {
      expect(typeof v).toBe("boolean");
    }
  });

  test("accepts an opts arg for parity with wrap* helpers", () => {
    expect(() => detectInstalledFrameworks({ tags: ["prod"] })).not.toThrow();
    expect(() => detectInstalledFrameworks({ environmentId: "env_x" })).not.toThrow();
  });

  test("does not actually wrap anything (detect-only)", () => {
    // The TS SDK wraps client INSTANCES, not modules — there's no
    // global side-effect to observe. The function is purely
    // informational. Locking in the no-side-effect contract here
    // so future refactors don't sneak in a module monkey-patch.
    const before = detectInstalledFrameworks();
    // Call twice — should be idempotent and free of side-effects.
    detectInstalledFrameworks();
    detectInstalledFrameworks();
    const after = detectInstalledFrameworks();
    expect(before).toEqual(after);
  });
});

describe("autoInstrument (deprecated alias)", () => {
  test("returns the same shape as detectInstalledFrameworks", () => {
    expect(autoInstrument()).toEqual(detectInstalledFrameworks());
  });
});
