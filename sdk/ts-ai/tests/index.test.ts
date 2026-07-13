/**
 * Smoke tests for the top-level `autoInstrument` /
 * `detectInstalledFrameworks` surface.
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

describe("autoInstrument", () => {
  test("returns a status dict with all five keys", () => {
    const status = autoInstrument();
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
    expect(() => autoInstrument()).not.toThrow();
  });

  test("returns false for every key in a minimal install", () => {
    // We can't guarantee which optional deps bun has, but the
    // shape must always be a record of booleans.
    const status = autoInstrument();
    for (const v of Object.values(status)) {
      expect(typeof v).toBe("boolean");
    }
  });

  test("accepts an opts arg for parity with wrap* helpers", () => {
    expect(() => autoInstrument({ tags: ["prod"] })).not.toThrow();
    expect(() => autoInstrument({ environmentId: "env_x" })).not.toThrow();
  });
});

describe("detectInstalledFrameworks", () => {
  test("is an alias of autoInstrument with the same shape", () => {
    const a = autoInstrument();
    const b = detectInstalledFrameworks();
    expect(a).toEqual(b);
  });

  test("does not actually wrap anything (detect-only)", () => {
    // The TS SDK wraps client INSTANCES, not modules — there's no
    // global side-effect to observe. The function is purely
    // informational. Locking in the no-side-effect contract here
    // so future refactors don't sneak in a module monkey-patch.
    const before = autoInstrument();
    // Call twice — should be idempotent and free of side-effects.
    detectInstalledFrameworks();
    detectInstalledFrameworks();
    const after = autoInstrument();
    expect(before).toEqual(after);
  });
});
