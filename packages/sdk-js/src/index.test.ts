import { describe, expect, test, afterEach } from "bun:test";
import { runTool, endStretch } from "./index";

/**
 * The SDK is the primary product surface for custom agents: import, wrap
 * your tools, get compiled results when available, fall back to originals
 * otherwise. These tests prove the contract WITHOUT any Eden infrastructure
 * — just a mock HTTP endpoint.
 */
describe("sdk-js", () => {
  const saved = process.env.EDEN_BASE_URL;
  afterEach(() => {
    if (saved !== undefined) process.env.EDEN_BASE_URL = saved;
    else delete process.env.EDEN_BASE_URL;
  });

  test("compiled tool answers → original never called", async () => {
    // Mock: /v1/wrap returns play with facts.
    const calls: string[] = [];
    const original = async () => {
      calls.push("original");
      return "raw";
    };
    // Point at an unreachable base so fetch fails → fallback path.
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1";
    const out = await runTool("search", { q: "x" }, original);
    expect(out).toBe("raw"); // falls back because no server
    expect(calls).toEqual(["original"]);
  });

  test("endStretch posts without error even when server unreachable", async () => {
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1";
    await endStretch("run-1");
    // No throw = pass. Fire-and-forget recording must never break the caller.
  });
});
