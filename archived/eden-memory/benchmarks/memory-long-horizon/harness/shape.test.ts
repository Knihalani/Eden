/**
 * P0.0a target 4: generated sessions have R6's shape (A5 §3.8), measured over 500 seeds, and a seed always
 * gives the same script.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalSession,
  CANONICAL_SHAPE,
  filler,
  generateSession,
  R6_SHAPE,
  shapeStats,
  type SessionScript,
  type Step,
} from "./shape";

const SEEDS = 500;
const scripts = Array.from({ length: SEEDS }, (_, i) => generateSession(i + 1));
const stats = scripts.map(shapeStats);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe("R6 shape over 500 sessions (pre-registered bands)", () => {
  const humans = stats.map((s) => s.humanPrompts);

  test("human prompts per session: median 3, max ≤ 24", () => {
    expect(median(humans)).toBe(3);
    expect(Math.max(...humans)).toBeLessThanOrEqual(24);
    expect(Math.min(...humans)).toBeGreaterThanOrEqual(1);
  });

  test("non-human ÷ human submits in 1.5–1.9 (R6: 1.7)", () => {
    const ratio = sum(stats.map((s) => s.nonHumanSubmits)) / sum(humans);
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(1.9);
  });

  test("sessions with a rewind: 22–32% (R6: 27%)", () => {
    const share = stats.filter((s) => s.rewinds > 0).length / SEEDS;
    expect(share).toBeGreaterThanOrEqual(0.22);
    expect(share).toBeLessThanOrEqual(0.32);
  });

  test("subagent windows per main window: 6.5–9.5 (R6: 8.2)", () => {
    const perSession = sum(stats.map((s) => s.subagentWindows)) / SEEDS;
    expect(perSession).toBeGreaterThanOrEqual(6.5);
    expect(perSession).toBeLessThanOrEqual(9.5);
  });

  test("tool calls per human turn, subagents included: p50 in 8–16 (R6: 12)", () => {
    const p50 = median(stats.flatMap((s) => s.toolCallsPerHumanTurn));
    expect(p50).toBeGreaterThanOrEqual(8);
    expect(p50).toBeLessThanOrEqual(16);
  });

  test("compaction happens only at ≥ 600k context tokens, and does happen in long sessions", () => {
    const compactions = scripts.flatMap((script) => script.steps.filter((step) => step.kind === "compact"));
    expect(R6_SHAPE.compactAtTokens).toBe(600_000);
    expect(compactions.length).toBeGreaterThan(0);
    for (const step of compactions) expect(step.atTokens).toBeGreaterThanOrEqual(600_000);
  });
});

describe("determinism", () => {
  test("the same seed gives the identical script; another seed does not", () => {
    expect(JSON.stringify(generateSession(42))).toBe(JSON.stringify(generateSession(42)));
    expect(JSON.stringify(generateSession(42))).not.toBe(JSON.stringify(generateSession(43)));
  });

  test("filler text depends only on its key, and has the asked length", () => {
    expect(filler("a", 500)).toBe(filler("a", 500));
    expect(filler("a", 500)).not.toBe(filler("b", 500));
    expect(filler("a", 500)).toHaveLength(500);
  });
});

describe("script structure", () => {
  const kinds = (script: SessionScript) => script.steps.map((step) => step.kind);

  test("a session starts once and ends with SessionEnd; a resume always follows an end", () => {
    for (const script of scripts.slice(0, 100)) {
      const steps = kinds(script);
      expect(steps[0]).toBe("start");
      expect(steps.at(-1)).toBe("end");
      steps.forEach((kind, i) => {
        if (kind === "resume") expect(steps[i - 1]).toBe("end");
      });
    }
  });

  test("every background subagent is notified exactly once, after its launch", () => {
    for (const script of scripts.slice(0, 200)) {
      const launched = new Map<string, number>();
      const notified = new Map<string, number>();
      script.steps.forEach((step, i) => {
        if (step.kind === "subagent" && step.background) launched.set(step.ref, i);
        if (step.kind === "notify") {
          expect(notified.has(step.ref)).toBe(false);
          notified.set(step.ref, i);
        }
      });
      expect([...notified.keys()].sort()).toEqual([...launched.keys()].sort());
      for (const [ref, at] of notified) expect(at).toBeGreaterThan(launched.get(ref)!);
    }
  });

  test("a rewind targets a human prompt on the branch since the last compaction", () => {
    for (const script of [...scripts, canonicalSession()]) {
      let onBranch = 0;
      for (const step of script.steps) {
        if (step.kind === "compact") onBranch = 0;
        if (step.kind === "rewind") {
          expect(step.index).toBeGreaterThanOrEqual(0);
          expect(step.index).toBeLessThan(onBranch);
          onBranch = step.index + 1;
        }
        if (step.kind === "prompt") onBranch++;
      }
    }
  });
});

describe("the canonical replay session", () => {
  const script = canonicalSession();
  const has = (match: (step: Step) => boolean) => script.steps.some(match);

  test("has every feature the gate names", () => {
    const features = {
      rewind: has((s) => s.kind === "rewind"),
      compaction: has((s) => s.kind === "compact"),
      resume: has((s) => s.kind === "resume"),
      foregroundSubagent: has((s) => s.kind === "subagent" && !s.background),
      backgroundSubagent: has((s) => s.kind === "subagent" && s.background),
      idleNotification: has((s) => s.kind === "notify" && s.delivery === "idle"),
      midTurnNotification: has((s) => s.kind === "notify" && s.delivery === "mid-turn"),
      peerMessage: has((s) => s.kind === "peer"),
      queuedPrompt: has((s) => s.kind === "prompt" && s.source === "queued"),
      midTurnPrompt: has((s) => s.kind === "queued-prompt"),
      failingTool: script.steps
        .flatMap((s) => (s.kind === "tools" ? [s] : s.kind === "subagent" ? s.body : []))
        .some((s) => s.kind === "tools" && s.calls.some((c) => c.tool === "Bash" && c.exitCode !== 0)),
      parallelBatch: has((s) => s.kind === "tools" && s.calls.length > 1),
    };
    expect(Object.entries(features).filter(([, present]) => !present)).toEqual([]);
  });

  test("keeps R6's proportions, inside the pre-registered bands, at its small scale", () => {
    const s = shapeStats(script);
    expect({ human: s.humanPrompts, nonHuman: s.nonHumanSubmits, subagents: s.subagentWindows }).toEqual({
      human: 6,
      nonHuman: 10,
      subagents: 8,
    });
    expect(s.nonHumanSubmits / s.humanPrompts).toBeGreaterThanOrEqual(1.5);
    expect(s.nonHumanSubmits / s.humanPrompts).toBeLessThanOrEqual(1.9);
    expect(s.subagentWindows).toBeGreaterThanOrEqual(6.5);
    expect(s.subagentWindows).toBeLessThanOrEqual(9.5);
    expect(CANONICAL_SHAPE.toolScale).toBeLessThan(1);
  });
});
