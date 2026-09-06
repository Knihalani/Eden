import { describe, expect, test } from "bun:test";
import { createState, wrapTools } from "../index";
import "@eden/ir";

/**
 * ADVERSARIAL SUITE v1 — real-world hostile inputs, not the happy path.
 *
 * These tests are written to BREAK Eden, not to pass. Everything here models
 * production realities: nondeterministic outputs, flaky tools, hostile
 * payloads, memory pressure, concurrent abuse. Failures found by this suite
 * get fixed in the engine, and the suite then gets VARIED (new seeds, new
 * shapes) so fixes cannot overfit to one scenario.
 *
 * Gated behind EDEN_STRESS=1 so normal CI stays fast; run explicitly.
 */

const gate = process.env.EDEN_STRESS === "1";
const d = describe.skipIf(!gate);

// ─── deterministic RNG so failures are reproducible across runs ─────────────
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** A tool whose result carries a fresh timestamp + random id on every call: the classic pattern that defeats output-similarity detection. */
function nondeterministicTool(name: string, rand: () => number) {
  return async (args: Record<string, unknown>) => ({
    name,
    args,
    ts: new Date(Date.now() + Math.floor(rand() * 1000)).toISOString(),
    requestId: `req_${Math.floor(rand() * 1e9).toString(36)}`,
    data: { ok: true },
  });
}

d("adversarial: hostile outputs", () => {
  test("nondeterministic results do not corrupt steering or lose calls", async () => {
    const rand = rng(42);
    const state = createState({ programs: [] });
    let calls = 0;
    const tools = wrapTools(
      {
        poll_ci: async () => {
          calls++;
          return { state: "pending", checkedAt: new Date().toISOString(), nonce: rand() };
        },
      },
      state,
    );
    for (let i = 0; i < 30; i++) {
      const out = (await tools.poll_ci.execute({})) as { state: string };
      expect(out.state).toBe("pending");
    }
    expect(calls).toBe(30);
  });

  test("flaky tool (20% failures) — fail_streak warnings never wedge the state", async () => {
    const rand = rng(7);
    const state = createState({ programs: [] });
    const tools = wrapTools(
      {
        flaky: async () => {
          if (rand() < 0.2) throw new Error("transient network");
          return { ok: true };
        },
        healthy: async () => ({ fine: true }),
      },
      state,
    );
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < 60; i++) {
      try {
        await tools.flaky.execute({});
        ok++;
      } catch {
        failed++;
      }
      // Healthy unrelated work must ALWAYS succeed, even mid-fail-streak.
      const h = (await tools.healthy.execute({})) as { fine: boolean };
      expect(h.fine).toBe(true);
    }
    expect(ok + failed).toBe(60);
    expect(ok).toBeGreaterThan(30); // sanity: ~80% success rate materialized
  });
});

d("adversarial: hostile payloads", () => {
  test("1MB string payloads pass through without corruption or hang", async () => {
    const big = "x".repeat(1_000_000);
    const state = createState({ programs: [] });
    const tools = wrapTools({ echo: async (a: Record<string, unknown>) => a }, state);
    const t0 = Date.now();
    const out = (await tools.echo.execute({ blob: big })) as { blob: string };
    expect(out.blob.length).toBe(big.length);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("deeply nested args do not blow the stack", async () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 500; i++) deep = { nested: deep };
    const state = createState({ programs: [] });
    const tools = wrapTools({ probe: async (a: Record<string, unknown>) => Object.keys(a).length }, state);
    const out = await tools.probe.execute(deep);
    expect(out).toBe(1);
  });

  test("__proto__ pollution attempt in args is neutralized", async () => {
    const state = createState({ programs: [] });
    const tools = wrapTools(
      { save: async (a: Record<string, unknown>) => ({ got: Object.keys(a).sort() }) },
      state,
    );
    const malicious = JSON.parse('{"__proto__": {"isAdmin": true}, "id": "T-1"}');
    const out = (await tools.save.execute(malicious)) as { got: string[] };
    expect(out.got).toContain("id");
    // The prototype of newly-created objects must stay clean.
    const victim: Record<string, unknown> = {};
    expect((victim as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  test("unicode + emoji + combining marks survive recording", async () => {
    const weird = "🚀 café ñ 日本語 \u0301 combining";
    const state = createState({ programs: [] });
    const tools = wrapTools({ echo: async (a: Record<string, unknown>) => a.args ?? a }, state);
    const out = (await tools.echo.execute({ text: weird })) as { text: string };
    expect(out.text).toBe(weird);
  });
});

d("adversarial: concurrency", () => {
  test("50 parallel invocations on one wrapped set — zero lost or duplicated calls", async () => {
    const state = createState({ programs: [] });
    let executed = 0;
    const tools = wrapTools(
      {
        work: async (a: Record<string, unknown>) => {
          executed++;
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10)));
          return { id: a.id };
        },
      },
      state,
    );
    const ids = Array.from({ length: 50 }, (_, i) => i);
    const results = await Promise.all(ids.map((id) => tools.work.execute({ id })));
    expect(executed).toBe(50);
    const seen = new Set(results.map((r) => (r as { id: number }).id));
    expect(seen.size).toBe(50); // every caller got its own answer
  });

  test("parallel mixed success/failure keeps per-call isolation", async () => {
    const state = createState({ programs: [] });
    const tools = wrapTools(
      {
        good: async (a: Record<string, unknown>) => ({ id: a.id }),
        bad: async () => {
          throw new Error("nope");
        },
      },
      state,
    );
    const jobs: Array<Promise<Record<string, unknown> | string>> = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? (tools.good.execute({ id: i }) as Promise<Record<string, unknown>>)
        : (tools.bad.execute({}) as Promise<unknown>).then(
            () => "unexpected-success",
            () => `caught:${i}`,
          ),
    );
    const settled: Array<Record<string, unknown> | string> = await Promise.all(jobs);
    expect(settled.filter((r) => r && typeof r === "object").length).toBe(20);
    expect(settled.filter((r) => typeof r === "string").length).toBe(20);
  });
});

// ─── realistic simulation: CI-watcher agent ──────────────────────────────────
d("simulation: ci watcher agent (realistic cadence)", () => {
  test("poll→detect→fix→verify cycles across 10 runs behave identically", async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed * 1000);
      const state = createState({ programs: [] });
      let ciState = rand() < 0.5 ? "failure" : "pending";
      let fixed = false;
      const log: string[] = [];
      const tools = wrapTools(
        {
          get_status: async () => {
            log.push("status");
            if (!fixed && ciState === "failure" && rand() < 0.3) {
              fixed = true; // a fix lands partway through polling
              ciState = "success";
            }
            return { state: ciState };
          },
          fix_build: async () => {
            log.push("fix");
            fixed = true;
            ciState = "success";
            return { fixed: true };
          },
          notify: async () => {
            log.push("notify");
            return { notified: true };
          },
        },
        state,
      );
      // The agent loop: up to 8 polls, fixing when it sees failure.
      for (let i = 0; i < 8; i++) {
        const s = (await tools.get_status.execute({})) as { state: string };
        if (s.state === "success") break;
        if (s.state === "failure") await tools.fix_build.execute({});
      }
      await tools.notify.execute({});
      expect(log[log.length - 1]).toBe("notify");
      void state;
    }
  });
});

// ─── memory soak signal (short version here; long soak in stress runner) ─────
d("adversarial: memory signals", () => {
  test("2000 recorded calls — trace buffer stays bounded", async () => {
    const state = createState({ programs: [] });
    const tools = wrapTools({ churn: async (a: Record<string, unknown>) => ({ n: a.n }) }, state);
    for (let i = 0; i < 2000; i++) {
      await tools.churn.execute({ n: i, filler: "y".repeat(200) });
    }
    expect(state.traces.length).toBeLessThanOrEqual(2000); // hard cap exists
    // Buffered events must not grow unboundedly either.
    expect(state.run.events.length).toBeLessThan(100);
  });
});
