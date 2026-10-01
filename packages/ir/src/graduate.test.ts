import { describe, expect, test } from "bun:test";
import { inDistribution } from "./envelope";
import {
  CANARY_PCT,
  WIDTH_INHERIT_K,
  dropEnvelopeValue,
  envelopeLine,
  inCanary,
  inheritEnvelopeValues,
  islandStability,
  llmBadge,
  matchClass,
  mayServe,
  canaryLiveParts,
  rolloutPartition,
  toolsInventoryLine,
  toolsListTitle,
  shouldInheritWidth,
  whenToUseOf,
  zeroLlm,
} from "./graduate";
import { withVersion } from "./hash";
import type { StretchProgram } from "./types";

const mini = (opts?: { ids?: unknown[]; soft?: boolean; islands?: Array<{ pinned?: boolean }> }): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: (opts?.islands ?? []).map((isle, i) => ({
      id: `isle_${i}`,
      kind: "island" as const,
      input: { kind: "input" as const, path: "q" },
      system: "s",
      outputSchema: {},
      ...(isle.pinned ? { pinned: true } : {}),
    })),
    returns: { kind: "literal" as const, value: null },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { id: opts?.ids ?? ["T-1", "T-2"] } },
      ...(opts?.soft ? { softMatch: true } : {}),
    },
    manifest: null,
  });

describe("zeroLlm", () => {
  test("no islands is Zero-LLM", () => {
    expect(zeroLlm(mini())).toBe(true);
    expect(llmBadge(mini())).toBe("Zero-LLM");
  });
  test("unpinned island is Island remains", () => {
    const p = mini({ islands: [{}] });
    expect(zeroLlm(p)).toBe(false);
    expect(llmBadge(p)).toBe("Island remains");
  });
  test("pinned island is Zero-LLM", () => {
    const p = mini({ islands: [{ pinned: true }] });
    expect(zeroLlm(p)).toBe(true);
    expect(llmBadge(p)).toBe("Zero-LLM");
  });
  test("mixed unpinned still remains", () => {
    expect(zeroLlm(mini({ islands: [{ pinned: true }, {}] }))).toBe(false);
  });
});

describe("islandStability", () => {
  test("ready at 4 agreeing and zero disagreements", () => {
    expect(islandStability({ agreeing: 4, disagreeing: 0 })).toEqual({ score: 1, ready: true });
    expect(islandStability({ agreeing: 3, disagreeing: 0 }).ready).toBe(false);
    expect(islandStability({ agreeing: 8, disagreeing: 1 }).ready).toBe(false);
    expect(islandStability({ agreeing: 0, disagreeing: 0 })).toEqual({ score: 0, ready: false });
  });
});

describe("matchClass / mayServe", () => {
  test("exact stays inDistribution", () => {
    const p = mini();
    expect(matchClass(p, { id: "T-1" })).toBe("exact");
    expect(inDistribution(p, { id: "T-1" })).toBe(true);
    expect(mayServe(p, { id: "T-1" })).toBe(true);
  });
  test("novel id is soft, served only with softMatch", () => {
    const strict = mini();
    const soft = mini({ soft: true });
    expect(matchClass(strict, { id: "T-100" })).toBe("soft");
    expect(inDistribution(strict, { id: "T-100" })).toBe(false);
    expect(mayServe(strict, { id: "T-100" })).toBe(false);
    expect(mayServe(soft, { id: "T-100" })).toBe(true);
  });
  test("wrong type or missing key is ood", () => {
    const p = mini();
    expect(matchClass(p, { id: 1 })).toBe("ood");
    expect(matchClass(p, {})).toBe("ood");
    expect(mayServe(p, {})).toBe(false);
  });
  test("extra key is ood, not exact — additionalProperties false", () => {
    const p = mini();
    expect(matchClass(p, { id: "T-1", role: "admin" })).toBe("ood");
    expect(inDistribution(p, { id: "T-1", role: "admin" })).toBe(false);
    expect(mayServe(p, { id: "T-1", role: "admin" })).toBe(false);
    expect(matchClass(p, { id: "T-1" })).toBe("exact");
  });
});

describe("dropEnvelopeValue", () => {
  test("drops a witnessed value", () => {
    const r = dropEnvelopeValue({ inputs: { id: ["T-1", "T-2"] } }, "id", "T-2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.inputs.id).toEqual(["T-1"]);
  });
  test("refuses emptying a key", () => {
    const r = dropEnvelopeValue({ inputs: { id: ["T-1"] } }, "id", "T-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/emptying a key is refused/);
  });
  test("refuses inventing a drop of a value that was never there", () => {
    const r = dropEnvelopeValue({ inputs: { id: ["T-1", "T-2"] } }, "id", "T-9");
    expect(r.ok).toBe(false);
  });
  test("refuses unknown keys", () => {
    const r = dropEnvelopeValue({ inputs: { id: ["T-1"] } }, "nope", "x");
    expect(r.ok).toBe(false);
  });
});

describe("inheritEnvelopeValues", () => {
  test("adds a live id onto an existing key", () => {
    const next = inheritEnvelopeValues({ inputs: { id: ["T-1"] } }, { id: "T-7" });
    expect(next.inputs.id).toEqual(["T-1", "T-7"]);
  });
  test("does not invent a new key", () => {
    const next = inheritEnvelopeValues({ inputs: { id: ["T-1"] } }, { id: "T-1", extra: "nope" });
    expect(next.inputs.extra).toBeUndefined();
  });
  test("idempotent on already-witnessed", () => {
    const next = inheritEnvelopeValues({ inputs: { id: ["T-1"] } }, { id: "T-1" });
    expect(next.inputs.id).toEqual(["T-1"]);
  });
});

describe("envelopeLine", () => {
  test("counts keys and values", () => {
    expect(envelopeLine({ inputs: { id: ["T-1", "T-2"], n: ["a"] } })).toBe("Envelope · 2 keys · 3 values");
    expect(envelopeLine()).toBe("Envelope · none");
  });
});

describe("canary / width inherit constants", () => {
  test("K is 3 and canary default is 10", () => {
    expect(WIDTH_INHERIT_K).toBe(3);
    expect(CANARY_PCT).toBe(10);
    expect(shouldInheritWidth(2)).toBe(false);
    expect(shouldInheritWidth(3)).toBe(true);
  });
  test("same session is stable; empty session is the operator canary", () => {
    expect(inCanary("")).toBe(true);
    expect(inCanary(undefined)).toBe(true);
    const a = inCanary("sess-alpha");
    const b = inCanary("sess-alpha");
    expect(a).toBe(b);
    let hits = 0;
    for (let i = 0; i < 200; i++) if (inCanary(`sess-${i}`)) hits++;
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(40);
  });
  test("canary is never counted as Live", () => {
    const mix = rolloutPartition([{ rollout: "canary" }, {}, { rollout: "live" }]);
    expect(mix).toEqual({ n: 3, canary: 1, live: 2 });
    expect(canaryLiveParts(mix)).toEqual(["1 Canary", "2 Live"]);
    expect(canaryLiveParts({ canary: 2, live: 0 })).toEqual(["2 Canary"]);
    expect(toolsInventoryLine({ n: 1, canary: 1, live: 0 })).toBe("1 programs · 1 Canary");
    expect(toolsInventoryLine({ n: 2, canary: 0, live: 2 })).toBe("2 programs");
    expect(toolsListTitle({ canary: 1, live: 0 })).toBe("Canary");
    expect(toolsListTitle({ canary: 1, live: 1 })).toBe("Tools");
    expect(toolsListTitle({ canary: 0, live: 2 })).toBe("Live tools");
    expect(toolsListTitle({ canary: 0, live: 0 })).toBe("0 programs");
  });
  test("whenToUseOf prefers island one-liner, then description", () => {
    expect(whenToUseOf({ description: "Run the stretch", when_to_use: "Triage open PRs in one call" })).toBe(
      "Triage open PRs in one call",
    );
    expect(
      whenToUseOf({
        description: "Run the stretch",
        steps: [{ kind: "island", when_to_use: "Judge the reply after the fetches" }],
      }),
    ).toBe("Judge the reply after the fetches");
    expect(
      whenToUseOf({
        description: "Run the stretch",
        steps: [{ kind: "island", when_to_use: "  " }, { kind: "tool" }],
      }),
    ).toBe("Run the stretch");
    expect(whenToUseOf({ description: "Run the stretch", steps: [{ kind: "island" }] })).toBe("Run the stretch");
    expect(
      whenToUseOf({
        description: "Run the stretch",
        when_to_use: "",
        steps: [{ kind: "island", when_to_use: null }],
      }),
    ).toBe("Run the stretch");
  });
});
