/**
 * POC 3 — Speculative execution: start every *ready* step, not just the next wave.
 *
 * Today playback runs Kahn waves through Promise.all and speculatively
 * prefetches ONLY the immediately-following wave, capped at 8 in-flight
 * (playback.ts MAX_PREFETCH_PER_RUN). Two structural losses follow:
 *
 *   1. WAVE BARRIERS × LATENCY VARIANCE: a wave finishes when its SLOWEST
 *      member finishes. With realistic API jitter (60–320 ms per read), every
 *      wave burns `max - median` idle time, and unrelated fast branches wait
 *      for slow strangers.
 *   2. PREFETCH STARVATION: next-wave prefetch cannot resolve its templates
 *      until the current wave completes (its binds reference same-wave
 *      results), so in mixed tools it often never fires at all.
 *
 * Proposed: continuously schedule any node whose data dependencies resolved
 * (read-only speculation, cap 8 in flight; writes stay strictly ordered).
 * This benchmark drives the REAL buildDag/layers output with simulated
 * network latency via real timers.
 */
import { buildDag, layers, type CompiledStep } from "../../packages/core/src/index.ts";
import { header, printRow, mulberry32 } from "./lib.ts";

// Realistic compiled tool: PR summary fan-out. One mutating label step, plus
// six independent read chains (files x checks x comments style analysis).
// Latencies vary per resource like real APIs do.
const LATENCY: Record<string, number> = {};
function makeTool(): CompiledStep[] {
  const rnd = mulberry32(7);
  const steps: CompiledStep[] = [
    { id: "root", kind: "cloud_http", name: "get_pr", method: "GET", commute: true, url: "/pulls/{{issue}}" },
  ];
  // 6 read chains of depth 4 hanging off root.
  const kinds = ["checks", "files", "comments", "reviews", "commits", "deploys"];
  for (let c = 0; c < 6; c++) {
    let prev = "root";
    for (let d = 0; d < 4; d++) {
      const id = `${kinds[c]}${d}`;
      LATENCY[id] = Math.round(40 + rnd() * 280); // 40–320 ms jitter
      steps.push({
        id,
        kind: "cloud_http",
        name: `get_${id}`,
        method: "GET",
        commute: true,
        url: `/${kinds[c]}?pr={{${prev}.id}}&n=${d}`,
      });
      prev = id;
    }
  }
  // A write fed by chain 0; downstream state-reads depend on it.
  LATENCY["label"] = 420;
  steps.push({
    id: "label",
    kind: "cloud_http",
    name: "post_label",
    method: "POST",
    commute: false,
    url: "/labels",
    bind: { b: "{{checks3.id}}" },
  });
  LATENCY["state"] = 90;
  steps.push({
    id: "state",
    kind: "cloud_http",
    name: "get_label_state",
    method: "GET",
    commute: true,
    url: "/state?label={{label.id}}",
  });
  return steps;
}

function readonly(s: CompiledStep): boolean {
  const flag = (s as { readOnly?: boolean }).readOnly;
  if (typeof flag === "boolean") return flag === true;
  return s.kind === "cloud_http" && (s.method || "GET") === "GET";
}

/** Data-dep ids from url/bind templates (same regex as dag.ts priorStepRefs). */
function dataDeps(steps: CompiledStep[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of steps) {
    const ids = new Set<string>();
    for (const raw of [...Object.values(s.bind ?? {}), s.url ?? ""]) {
      const re = /\{\{(\w+)\./g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(String(raw)))) ids.add(match[1]!);
    }
    m.set(s.id, [...ids]);
  }
  return m;
}

async function runSim(mode: "waves" | "waves+prefetch" | "ready"): Promise<number> {
  const steps = makeTool();
  const deps = dataDeps(steps);
  const dag = buildDag(steps);
  const waves = layers(dag);
  const results = new Map<string, number>();
  const started = new Set<string>();
  let inflight = 0;
  const t0 = Date.now();

  const launch = (s: CompiledStep): void => {
    if (started.has(s.id)) return;
    started.add(s.id);
    inflight++;
    setTimeout(() => {
      results.set(s.id, Date.now() - t0);
      inflight--;
      if (mode === "ready") pump();
    }, LATENCY[s.id] ?? 100);
  };

  const depsMet = (s: CompiledStep) => (deps.get(s.id) ?? []).every((d) => results.has(d));

  function pump(): void {
    // Fill every free slot. Writes are prioritized once runnable because they
    // gate their own successors; reads are interchangeable.
    for (;;) {
      if (inflight >= 8) return;
      const w = steps.find((s) => !readonly(s) && !started.has(s.id) && depsMet(s));
      if (w) {
        launch(w);
        continue;
      }
      const r = steps.find((s) => readonly(s) && !started.has(s.id) && depsMet(s));
      if (!r) return;
      launch(r);
    }
  }

  if (mode === "ready") {
    pump();
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (results.size === steps.length) {
          clearInterval(iv);
          resolve();
        }
      }, 4);
    });
    return Date.now() - t0;
  }

  for (let wi = 0; wi < waves.length; wi++) {
    const layer = waves[wi]!;
    // Today's prefetch: next wave, read-only only, cap 8 — fires only when
    // its templates already resolve (they usually do not until the barrier).
    const next = mode === "waves+prefetch" && wi + 1 < waves.length ? waves[wi + 1]! : [];
    for (const s of next.slice(0, 8)) {
      if (!readonly(s) || !depsMet(s)) continue;
      started.add(s.id);
      inflight++;
      setTimeout(() => {
        results.set(s.id, Date.now() - t0);
        inflight--;
      }, LATENCY[s.id] ?? 100);
    }
    await Promise.all(
      layer.map(
        (s) =>
          new Promise<void>((res) => {
            started.add(s.id);
            inflight++;
            setTimeout(() => {
              results.set(s.id, Date.now() - t0);
              inflight--;
              res();
            }, LATENCY[s.id] ?? 100);
          }),
      ),
    );
  }
  await new Promise((r) => setTimeout(r, 150)); // stragglers
  return Date.now() - t0;
}

header("POC 3 — speculative scheduling (27-step tool, 40–320ms read jitter, one 420ms write)");

const trials = 9;
const med = async (mode: Parameters<typeof runSim>[0]) => {
  const xs: number[] = [];
  for (let i = 0; i < trials; i++) xs.push(await runSim(mode));
  return xs.sort((a, b) => a - b)[Math.floor(trials / 2)]!;
};

const a = await med("waves");
const b = await med("waves+prefetch");
const c = await med("ready");
printRow(`A  strict waves (${wavesCount()} waves, Promise.all barriers)`, `${a} ms`);
printRow("B  today: waves + next-wave prefetch", `${b} ms`);
printRow("C  proposed: always-schedule-ready (cap 8)", `${c} ms`);
printRow("speedup vs strict waves", `${(a / c).toFixed(2)}x`);
printRow("speedup vs today", `${(b / c).toFixed(2)}x`);
console.log(
  `\nVERDICT: ${c < b * 0.98 ? "WIN" : c === b ? "TIE" : "LOSE"} — ready-node scheduling removes wave barriers:`,
);
console.log("         fast branches stop waiting for slow strangers; the write only gates its own successors.");

function wavesCount(): number {
  const dag = buildDag(makeTool());
  return layers(dag).length;
}
