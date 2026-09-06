/**
 * Wave 10 red-team: invented values, emptying keys, Zero-LLM lies,
 * canary isolation, JIT storm.
 */
import { describe, expect, test } from "bun:test";
import {
  dropEnvelopeValue,
  inCanary,
  jitMax,
  llmBadge,
  matchClass,
  mayServe,
  zeroLlm,
} from "./graduate";
import { withVersion } from "./hash";
import type { StretchProgram } from "./types";

const mini = (over: Partial<StretchProgram> = {}): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { id: ["T-1", "T-2"] } },
    },
    manifest: null,
    ...over,
  });

describe("wave 10 red-team", () => {
  test("invented envelope value is OOD and does not serve", () => {
    const p = mini();
    expect(matchClass(p, { id: "T-invented" })).toBe("soft");
    expect(mayServe(p, { id: "T-invented" })).toBe(false);
    expect(dropEnvelopeValue(p.contract.envelope!, "id", "T-invented").ok).toBe(false);
  });

  test("extra input key is ood even when the witnessed id matches", () => {
    const p = mini();
    expect(matchClass(p, { id: "T-1", role: "admin" })).toBe("ood");
    expect(mayServe(p, { id: "T-1", role: "admin" })).toBe(false);
  });

  test("emptying a key is refused", () => {
    const once = dropEnvelopeValue({ inputs: { id: ["T-1"] } }, "id", "T-1");
    expect(once.ok).toBe(false);
    if (!once.ok) expect(once.error).toMatch(/emptying a key is refused/);
  });

  test("unpinned island is never Zero-LLM", () => {
    const p = mini({
      steps: [
        { id: "isle", kind: "island", input: { kind: "input", path: "q" }, system: "s", outputSchema: {} },
      ],
    });
    expect(zeroLlm(p)).toBe(false);
    expect(llmBadge(p)).toBe("Island remains");
  });

  test("hosted out-of-bucket session hashes below 10%; operator empty session is in canary", () => {
    expect(inCanary("")).toBe(true);
    let out = "";
    for (let i = 0; i < 400 && !out; i++) if (!inCanary(`sess-${i}`)) out = `sess-${i}`;
    expect(out).toBeTruthy();
    expect(inCanary(out)).toBe(false);
  });

  test("JIT max default is 4", () => {
    expect(jitMax()).toBe(4);
  });
});
