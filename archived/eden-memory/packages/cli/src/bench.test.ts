import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StretchTrace } from "@eden/ir";
import { createTicketShip, runNaive, toNaiveTrace, WITNESS_IDS } from "../../runtime/src/ticketship";
import { bench, collectBench, formatBench, loadTraces } from "./bench";

async function ticketShipTraces(dir: string, count: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  let file = 0;
  for (let rep = 0; rep < count && file < count; rep++) {
    for (const tid of WITNESS_IDS) {
      if (file >= count) break;
      const world = createTicketShip({ llmMs: 0 });
      const run = await runNaive(world, tid, { skipVerifyP: 0, seed: rep + 1 });
      const details = run.events.find((e) => e.name === "fetchDetails");
      if (details) details.result = { ...(details.result as Record<string, unknown>), session_note: `session ${rep}` };
      const trace = toNaiveTrace(`b${file}`, tid, run);
      writeFileSync(join(dir, `trace-${file}.json`), JSON.stringify(trace));
      file++;
    }
  }
}

describe("eden bench", () => {
  const dir = join(import.meta.dir, "../../.tmp-eden-bench-traces");

  test("PASS path: paired blocks print the full verdict shape", async () => {
    rmSync(dir, { recursive: true, force: true });
    await ticketShipTraces(dir, 9);
    const traces = await loadTraces(dir);
    expect(traces.length).toBe(9);
    const report = await collectBench(traces);

    expect(report.verdict).toBe("WIN");
    expect(report.n).toBe(9);
    expect(report.p_value).toBeLessThan(0.05);
    expect(report.ci.point).toBeLessThan(0);
    expect(report.ci.lo).toBeLessThanOrEqual(report.ci.point!);
    expect(report.ci.hi).toBeGreaterThanOrEqual(report.ci.point!);

    expect(report.tokens.measured).toBe(true);
    expect(report.tokens.estimated).toBe(true);
    expect(report.tokens.delta).toBeLessThan(0);

    expect(report.time_ms).toEqual({ delta: null, measured: false });
    expect(report.notes.join("\n")).toContain("time not measured");
    expect(report.notes.join("\n")).toContain("tokens estimated");

    const printed = JSON.parse(formatBench(report)) as Record<string, unknown>;
    expect(Object.keys(printed).sort()).toEqual(["ci", "n", "notes", "p_value", "time_ms", "tokens", "verdict"].sort());
    expect(printed.verdict).toBe("WIN");
  });

  test("too few distinct blocks is an honest INSUFFICIENT_DATA, not a shrug", async () => {
    const small = `${dir}-small`;
    rmSync(small, { recursive: true, force: true });
    await ticketShipTraces(small, 4);
    const report = await collectBench(await loadTraces(small));
    expect(report.verdict).toBe("INSUFFICIENT_DATA");
    expect(report.notes.some((s) => s.includes("cannot return a p below"))).toBe(true);
    rmSync(small, { recursive: true, force: true });
  });

  test("empty directory errors with a clear message", async () => {
    const empty = `${dir}-empty`;
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    try {
      await loadTraces(empty).catch((e: Error) => {
        expect(e.message).toContain("no trace files found");
        throw e;
      });
      throw new Error("expected loadTraces to reject");
    } catch (e) {
      expect((e as Error).message).toContain("no trace files found");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("malformed files error instead of being skipped", async () => {
    const bad = `${dir}-bad`;
    rmSync(bad, { recursive: true, force: true });
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "junk.json"), "{ not json");
    writeFileSync(join(bad, "wrong.json"), JSON.stringify({ hello: "world" }));
    try {
      let message = "";
      await loadTraces(bad).catch((e: Error) => {
        message = e.message;
        return null;
      });
      expect(message).toContain("eden bench:");
      expect(message).toContain("not valid JSON");
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test("synthetic clocks alone force time to not measured", async () => {
    const syn = `${dir}-synthetic`;
    rmSync(syn, { recursive: true, force: true });
    await ticketShipTraces(syn, 6);
    const traces = (await loadTraces(syn)).map((t) => ({
      ...t,
      duration_ms: 200 * t.llmCalls, // the fixture stamp, verbatim
    }));
    const report = await collectBench(traces as StretchTrace[]);
    expect(report.time_ms.measured).toBe(false);
    expect(report.time_ms.delta).toBeNull();
    const real = traces.map((t, i) => ({
      ...t,
      duration_ms: 200 * t.llmCalls + 37 + i,
      events: t.events.map((e, j) => ({ ...e, duration_ms: 3 + ((i + j) % 7) })),
    }));
    const honest = await collectBench(real);
    expect(honest.time_ms.measured).toBe(true);
    expect(typeof honest.time_ms.delta).toBe("number");
  });

  test("cli plumbing: help succeeds, missing --traces exits nonzero, bad input exits nonzero", async () => {
    expect(await bench(["--help"])).toBe(0);
    expect(await bench([])).not.toBe(0);
    expect(await bench(["--traces", join(dir, "does-not-exist")])).not.toBe(0);
  });
});
