import { describe, expect, test } from "bun:test";
import { envelopeLine, llmBadge, withVersion, type StretchProgram } from "@eden/ir";
import {
  approveContractLines,
  envelopeValueRows,
  liveCanaryLine,
  liveStretchLine,
  pinIslandsOffer,
  programDecor,
  tipLine,
} from "./contract";
import type { CanvasModel } from "./model";

function program(over: Partial<StretchProgram> = {}): StretchProgram {
  return withVersion({
    id: "p",
    name: "resolve_ticket",
    description: "test",
    inputSchema: { type: "object" },
    steps: [
      { id: "lookup", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } }, readOnly: true },
    ],
    returns: { kind: "from", step: "lookup", path: "" },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { id: ["T-1", "T-2"], n: ["a"] } },
    },
    manifest: null,
    ...over,
  });
}

function model(over: Partial<CanvasModel> = {}): CanvasModel {
  const p = over.program === undefined ? program() : over.program;
  const decor = programDecor(p);
  return {
    mode: "request",
    id: "p",
    name: "resolve_ticket",
    program: p,
    version: p?.version ?? "abc1234567xxxx",
    manifest: null,
    siblings: [],
    fail: null,
    envelopeLine: decor.envelopeLine,
    llmBadge: decor.llmBadge,
    ...over,
  };
}

describe("canvas envelope line on the model", () => {
  test("programDecor uses frozen envelopeLine and llmBadge", () => {
    const p = program();
    expect(programDecor(p).envelopeLine).toBe("Envelope · 2 keys · 3 values");
    expect(programDecor(p).llmBadge).toBe("Zero-LLM");
    expect(programDecor(p).envelopeLine).toBe(envelopeLine(p.contract.envelope));
    expect(programDecor(p).llmBadge).toBe(llmBadge(p));
    const island = program({
      steps: [{ id: "think", kind: "island", input: { kind: "input", path: "q" }, system: "s", outputSchema: {} }],
    });
    expect(programDecor(island).llmBadge).toBe("Island remains");
    expect(programDecor(null).envelopeLine).toBe("Envelope · none");
  });

  test("Approve contract strip is Reads/Writes/version plus envelope plus badge", () => {
    const lines = approveContractLines(model({ version: "ver123456789" }));
    expect(lines[0]).toMatch(/^Reads 1 · Writes none · ver1234567$/);
    expect(lines).toContain("Envelope · 2 keys · 3 values");
    expect(lines).toContain("Zero-LLM");
    const island = approveContractLines(
      model({
        program: program({
          steps: [{ id: "think", kind: "island", input: { kind: "input", path: "q" }, system: "s", outputSchema: {} }],
        }),
      }),
    );
    expect(island).toContain("Island remains");
    expect(island).not.toContain("Zero-LLM");
  });

  test("extra envelope values can drop; emptying a key cannot", () => {
    const env = { inputs: { id: ["T-1", "T-2"] } };
    const open = envelopeValueRows(env);
    expect(open.map((r) => r.text)).toEqual(["id · T-1", "id · T-2"]);
    expect(open.every((r) => r.canDrop)).toBe(true);
    const after = envelopeValueRows(env, [{ path: "id", value: "T-2" }]);
    const kept = after.find((r) => r.value === "T-1")!;
    const dropped = after.find((r) => r.value === "T-2")!;
    expect(kept.canDrop).toBe(false);
    expect(dropped.dropped).toBe(true);
  });

  test("pin islands shows when unpinned; ready when counts exist", () => {
    expect(pinIslandsOffer(program()).show).toBe(false);
    const unpinned = program({
      steps: [{ id: "think", kind: "island", input: { kind: "input", path: "q" }, system: "s", outputSchema: {} }],
    });
    expect(pinIslandsOffer(unpinned)).toEqual({ show: true, ready: null });
    const counted = program({
      steps: [
        {
          id: "think",
          kind: "island",
          input: { kind: "input", path: "q" },
          system: "s",
          outputSchema: {},
          agreeing: 4,
          disagreeing: 0,
        } as StretchProgram["steps"][number] & { agreeing: number; disagreeing: number },
      ],
    });
    expect(pinIslandsOffer(counted)).toEqual({ show: true, ready: true });
  });

  test("Live tip and strip say Canary vs Live", () => {
    expect(tipLine(model({ verdict: "INCONCLUSIVE" }))).toBe("Not measured");
    expect(tipLine(model({ origin: { mode: "loop", firstWarningAt: 3 } }))).toBe(
      "Compiled from a loop · warning at call 3",
    );
    expect(tipLine(model({ mode: "live", state: "live", rollout: "canary" }))).toMatch(/^Canary/);
    expect(tipLine(model({ mode: "live", state: "live" }))).toMatch(/^Live/);
    expect(liveCanaryLine(model({ mode: "live", state: "live", rollout: "canary" }))).toBe("Canary · 10% of sessions.");
    expect(liveCanaryLine(model({ mode: "live", state: "live" }))).toBeNull();
    expect(liveStretchLine(model({ mode: "live", state: "live", rollout: "canary" }), ["Served"])).toBe(
      "Canary · Served",
    );
    expect(liveStretchLine(model({ mode: "live", state: "live" }), ["Served"])).toBe("Live · Served");
    expect(liveStretchLine(model({ mode: "live", state: "paused", rollout: "canary" }), ["Served"])).toBe(
      "Paused · Served",
    );
  });
});
