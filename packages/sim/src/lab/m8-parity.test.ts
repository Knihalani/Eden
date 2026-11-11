/**
 * M8 (D944): the engine's router against the trainer. `packages/sim/lab/m8/parity.json` holds 64 held-out requests
 * from synth-test route logs (`parity.py`), each with up to 16 sources' keys and inputs, and the probabilities and
 * gate decisions Python computed with the shipped weights' int8 table. The engine's functions, reading the shipped
 * asset, must agree on every request: probabilities to 1e-6 and every gate decision.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  conjScore,
  defaultRouterWeights,
  routeProbabilities,
  ROUTER_NF,
  ROUTER_NULL_NF,
} from "@eden/engine";

interface Case {
  features: number[];
  keys: number[][];
  x: number[][];
  terms: number;
  p: number[];
  pNull: number;
  gate: boolean[];
}

const fixture = JSON.parse(
  readFileSync(new URL("../../lab/m8/parity.json", import.meta.url).pathname, "utf8"),
) as { floor: number; cases: Case[] };

describe("router parity (M8, D944)", () => {
  test("the shipped weights load, and the fixture was made with them", () => {
    const w = defaultRouterWeights();
    expect(w).not.toBeNull();
    expect(w!.floor).toBeCloseTo(fixture.floor, 9);
    expect(fixture.cases.length).toBe(64);
  });

  test("64 of 64 requests: probabilities and gate decisions agree", () => {
    const w = defaultRouterWeights()!;
    let agree = 0;
    for (const c of fixture.cases) {
      const n = c.x.length;
      const feats = Uint32Array.from(c.features);
      const x = new Float64Array(n * ROUTER_NF);
      for (let i = 0; i < n; i++) {
        x[i * ROUTER_NF] = conjScore(w, feats, Uint32Array.from(c.keys[i]!));
        for (let f = 1; f < ROUTER_NF; f++) x[i * ROUTER_NF + f] = c.x[i]![f - 1]!;
      }
      let maxConj = -Infinity;
      let maxLocal = 0;
      let named = 0;
      let rare = 0;
      for (let i = 0; i < n; i++) {
        maxConj = Math.max(maxConj, x[i * ROUTER_NF]!);
        maxLocal = Math.max(maxLocal, x[i * ROUTER_NF + 1]!);
        if (x[i * ROUTER_NF + 3]! > 0) named = 1;
        if (x[i * ROUTER_NF + 4]! > 0) rare = 1;
      }
      const summary = new Float64Array(ROUTER_NULL_NF);
      summary.set([maxConj, maxLocal, named, rare, Math.log1p((c.terms + 1) / 2)]);
      const p = new Float64Array(n);
      const pNull = routeProbabilities(w, x, n, summary, p);
      const close = c.p.every((v, i) => Math.abs(v - p[i]!) < 1e-6) && Math.abs(pNull - c.pNull) < 1e-6;
      const gates = c.gate.every((g, i) => g === p[i]! >= w.floor);
      if (close && gates) agree++;
    }
    expect(agree).toBe(64);
  });
});
