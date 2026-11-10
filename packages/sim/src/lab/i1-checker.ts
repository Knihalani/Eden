/**
 * I1 (D471): the lab's `PairChecker`, a client of the CPU sidecar `packages/sim/lab/i1/sidecar.py` (`POST /score`).
 * `--checker URL` in the funnel and pi-ab wires it; the engine's `pushCheck` trial reads it. Lab only: no product
 * package wires a checker. Every call the push makes is counted (`calls`, `ms`) for the run's report.
 */
import type { PairChecker } from "@eden/engine";

export interface SidecarChecker extends PairChecker {
  calls: number;
  failures: number;
  ms: number[];
}

export function sidecarChecker(url: string): SidecarChecker {
  const c: SidecarChecker = {
    calls: 0,
    failures: 0,
    ms: [],
    async score(_scope, request, items, signal) {
      const t0 = performance.now();
      c.calls++;
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/score`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request, items: items.map((x) => ({ title: x.title, text: x.text })) }),
          signal,
        });
        if (!res.ok) throw new Error(`checker ${res.status}`);
        const { scores } = (await res.json()) as { scores: number[] };
        return scores;
      } catch (e) {
        c.failures++;
        throw e;
      } finally {
        c.ms.push(performance.now() - t0);
      }
    },
  };
  return c;
}

/** The run's checker line: calls, failures and the round trip's p50/p90 in ms. */
export function checkerLine(c: SidecarChecker): string {
  const ms = [...c.ms].sort((a, b) => a - b);
  const at = (q: number) => (ms.length ? ms[Math.floor(q * (ms.length - 1))]!.toFixed(1) : "-");
  return `CHECKER (I1, lab sidecar): ${c.calls} calls, ${c.failures} failed, round trip p50 ${at(0.5)} ms, p90 ${at(0.9)} ms`;
}
