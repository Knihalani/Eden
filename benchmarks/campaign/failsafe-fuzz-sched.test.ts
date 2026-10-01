/**
 * Wave 6.3 — Failsafe fuzz × both playback schedulers.
 *
 * Wrap-shaped tools cannot run through playback; this file maps the same
 * 0xF5A1 suite onto compiled GET+POST programs the site DB already
 * understands (insertTool + playTool, same shape as cache.test.ts) and
 * asserts identical mutation / cache-safety outcomes on waves vs ready.
 *
 * Does not edit playback.ts or cache.ts. Routes via exported playTool and
 * EDEN_SCHED (unset = playOne waves; ready = playOneReady).
 *
 * Seed: 0xF5A1. Do not use Math.random.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { CompiledStep, Receipt } from "@eden/core";
import { openDb } from "../../apps/site/src/db";
import { playTool } from "../../apps/site/src/playback";
import { drainPrefetches, resultCacheKey } from "../../apps/site/src/cache";
import { FUZZ_SEED, MUTATING_TOOLS, N_CASES, N_FAST, generateSuite, type FuzzCase } from "./failsafe-gen";

const TIMEOUT = 120_000;
const TIMEOUT_10K = 180_000;

const GET_PATH: Record<string, string> = {
  lookup: "status",
  fetch: "files",
  audit: "reviews",
};

function playbackBound(): Record<string, string> {
  const pinnedOwner = process.env.EDEN_GH_OWNER;
  const pinnedRepo = process.env.EDEN_GH_REPO;
  return {
    ...(pinnedOwner ? { owner: pinnedOwner } : { owner: "" }),
    ...(pinnedRepo ? { repo: pinnedRepo } : { repo: "" }),
    issue: "",
    id: "",
  };
}

function compiledSteps(spec: FuzzCase): CompiledStep[] {
  const n = (spec.index % 40) + 1;
  const seen = new Map<string, number>();
  const steps: CompiledStep[] = [];
  for (let i = 0; i < spec.sequence.length; i++) {
    const tool = spec.sequence[i]!;
    const occ = seen.get(tool) ?? 0;
    seen.set(tool, occ + 1);
    const id = occ === 0 ? tool : `${tool}_${occ}`;
    const injectFail =
      i === spec.faultAt && (spec.fault === "timeout" || spec.fault === "throw500" || spec.fault === "abort");
    if (injectFail) {
      // Fast fail without network retries (runner_unbound). commute:false so
      // later POSTs chain behind it — both schedulers then skip those writes.
      steps.push({ id, kind: "runner", name: tool, command: "false", commute: false });
      continue;
    }
    if (MUTATING_TOOLS.has(tool)) {
      steps.push({
        id,
        kind: "cloud_http",
        name: tool,
        method: "POST",
        commute: false,
        url: `https://x.test/shop/${n}/orders`,
      });
    } else {
      const path = GET_PATH[tool] ?? "status";
      steps.push({
        id,
        kind: "cloud_http",
        name: tool,
        method: "GET",
        commute: true,
        url: `https://x.test/forge/${n}/${path}`,
      });
    }
  }
  return steps;
}

type Safety = {
  ok: boolean;
  error: string | null;
  posts: string;
  steps_ok: number;
  steps_attempted: number;
  hasFailStep: boolean;
};

function executedPosts(steps: CompiledStep[], receipt: Receipt | null): string {
  if (!receipt || receipt.result === null || typeof receipt.result !== "object" || Array.isArray(receipt.result)) {
    return "";
  }
  const rec = receipt.result as Record<string, unknown>;
  return steps
    .filter((s) => (s.method || "GET") === "POST" && s.kind === "cloud_http" && Object.hasOwn(rec, s.id))
    .map((s) => s.id)
    .sort()
    .join(",");
}

function summarize(steps: CompiledStep[], receipt: Receipt | null, error: string | null): Safety {
  const hasFailStep = steps.some((s) => s.kind === "runner");
  return {
    ok: error !== null ? false : Boolean(receipt?.ok),
    error,
    posts: executedPosts(steps, receipt),
    steps_ok: receipt?.steps_ok ?? 0,
    steps_attempted: receipt?.steps_attempted ?? 0,
    hasFailStep,
  };
}

function sameSafety(a: Safety, b: Safety): boolean {
  if (a.error !== b.error) return false;
  if (a.ok !== b.ok) return false;
  if (a.posts !== b.posts) return false;
  if (!a.hasFailStep && !b.hasFailStep) {
    if (a.steps_ok !== b.steps_ok) return false;
    if (a.steps_attempted !== b.steps_attempted) return false;
  }
  return true;
}

async function withSched<T>(mode: "waves" | "ready", fn: () => Promise<T>): Promise<T> {
  const prev = process.env.EDEN_SCHED;
  if (mode === "ready") process.env.EDEN_SCHED = "ready";
  else delete process.env.EDEN_SCHED;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.EDEN_SCHED;
    else process.env.EDEN_SCHED = prev;
  }
}

async function insertTool(db: Awaited<ReturnType<typeof openDb>>, id: string, steps: CompiledStep[], ws: string) {
  await db.run(
    `INSERT OR REPLACE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen) VALUES (?, ?, ?, '', 'on', ?, '[]')`,
    [id, ws, id, JSON.stringify(steps)],
  );
  return { id, name: id, steps: JSON.stringify(steps), workspace_id: ws };
}

function postCacheKeys(steps: CompiledStep[], workspaceId: string, toolId: string): string[] {
  const bound = playbackBound();
  return steps
    .filter((s) => (s.method || "GET") === "POST" && s.kind === "cloud_http" && s.url)
    .map((s) =>
      resultCacheKey({
        workspaceId,
        toolId,
        step: { id: s.id, name: s.name, method: s.method },
        url: s.url!,
        bound,
      }),
    );
}

describe("failsafe fuzz × schedulers", () => {
  const dbP = openDb(`/tmp/eden-failsafe-fuzz-sched-${Date.now()}.db`);
  const prevSched = process.env.EDEN_SCHED;

  afterAll(() => {
    if (prevSched === undefined) delete process.env.EDEN_SCHED;
    else process.env.EDEN_SCHED = prevSched;
  });

  test(
    "pin: GET cache hits on replay; POST never cached (waves and ready)",
    async () => {
      const db = await dbP;
      const getSteps: CompiledStep[] = [
        {
          id: "g0",
          kind: "cloud_http",
          name: "g0",
          method: "GET",
          commute: true,
          url: "https://x.test/forge/11/status",
        },
      ];
      const mixed: CompiledStep[] = [
        {
          id: "g0",
          kind: "cloud_http",
          name: "g0",
          method: "GET",
          commute: true,
          url: "https://x.test/forge/12/status",
        },
        {
          id: "w0",
          kind: "cloud_http",
          name: "w0",
          method: "POST",
          commute: false,
          url: "https://x.test/shop/12/orders",
        },
      ];

      for (const mode of ["waves", "ready"] as const) {
        await withSched(mode, async () => {
          const getTool = await insertTool(db, `t_get_${mode}`, getSteps, `ws_pin_${mode}`);
          const first = await playTool(db, getTool, {});
          expect(first.ok).toBe(true);
          await drainPrefetches();
          const again = await playTool(db, getTool, {});
          expect(again.ok).toBe(true);
          expect(again.cache_hits).toBeGreaterThanOrEqual(1);

          const mixTool = await insertTool(db, `t_mix_${mode}`, mixed, `ws_pin_${mode}`);
          const before = await db.all<{ cache_key: string }>(`SELECT cache_key FROM result_cache`);
          const known = new Set(before.map((r) => r.cache_key));
          const mix = await playTool(db, mixTool, {});
          expect(mix.ok).toBe(true);
          await drainPrefetches();
          const postKeys = postCacheKeys(mixed, `ws_pin_${mode}`, mixTool.id);
          const after = await db.all<{ cache_key: string }>(`SELECT cache_key FROM result_cache`);
          const fresh = after.map((r) => r.cache_key).filter((k) => !known.has(k));
          for (const k of postKeys) {
            expect(fresh.includes(k)).toBe(false);
            expect(after.some((r) => r.cache_key === k)).toBe(false);
          }
        });
      }
    },
    TIMEOUT,
  );

  test(
    "failsafe fuzz: seed subset (50 cases) × waves vs ready",
    async () => {
      const db = await dbP;
      const cases = generateSuite(FUZZ_SEED, N_FAST);
      let divergences = 0;
      const firstErr: string[] = [];
      const waves: Safety[] = [];
      await withSched("waves", async () => {
        for (const spec of cases) {
          const steps = compiledSteps(spec);
          const tool = {
            id: `fw-fast-${spec.index}`,
            name: `fw-fast-${spec.index}`,
            steps: JSON.stringify(steps),
            workspace_id: "ws_fuzz_waves",
          };
          try {
            const receipt = await playTool(db, tool, {});
            waves.push(summarize(steps, receipt, null));
          } catch (err) {
            waves.push(summarize(steps, null, String(err)));
          }
        }
      });
      await withSched("ready", async () => {
        for (let i = 0; i < cases.length; i++) {
          const spec = cases[i]!;
          const steps = compiledSteps(spec);
          const tool = {
            id: `fr-fast-${spec.index}`,
            name: `fr-fast-${spec.index}`,
            steps: JSON.stringify(steps),
            workspace_id: "ws_fuzz_ready",
          };
          let got: Safety;
          try {
            const receipt = await playTool(db, tool, {});
            got = summarize(steps, receipt, null);
          } catch (err) {
            got = summarize(steps, null, String(err));
          }
          const want = waves[i]!;
          if (!sameSafety(want, got)) {
            divergences++;
            if (firstErr.length < 4) {
              firstErr.push(
                `case=${spec.index} seq=[${spec.sequence.join(",")}] fault=${spec.fault}@${spec.faultAt} waves=${JSON.stringify(want)} ready=${JSON.stringify(got)}`,
              );
            }
          }
        }
      });
      console.log(
        `failsafe-fuzz-sched n=${N_FAST} divergences=${divergences} seed=0x${FUZZ_SEED.toString(16).toUpperCase()}`,
      );
      if (firstErr[0]) throw new Error(firstErr[0]);
      expect(divergences).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "failsafe fuzz: 10000 generated programs × waves vs ready",
    async () => {
      const db = await dbP;
      const cases = generateSuite(FUZZ_SEED, N_CASES);
      const postKeys: string[] = [];
      const t0 = performance.now();
      const waves: Safety[] = new Array(cases.length);
      await withSched("waves", async () => {
        for (let i = 0; i < cases.length; i++) {
          const spec = cases[i]!;
          const steps = compiledSteps(spec);
          const toolId = `fw-${spec.index}`;
          const ws = "ws_fuzz_waves";
          const tool = { id: toolId, name: toolId, steps: JSON.stringify(steps), workspace_id: ws };
          postKeys.push(...postCacheKeys(steps, ws, toolId));
          try {
            const receipt = await playTool(db, tool, {});
            waves[i] = summarize(steps, receipt, null);
          } catch (err) {
            waves[i] = summarize(steps, null, String(err));
          }
        }
      });
      const wavesMs = Math.round(performance.now() - t0);

      const t1 = performance.now();
      let divergences = 0;
      const firstErr: string[] = [];
      await withSched("ready", async () => {
        for (let i = 0; i < cases.length; i++) {
          const spec = cases[i]!;
          const steps = compiledSteps(spec);
          const toolId = `fr-${spec.index}`;
          const ws = "ws_fuzz_ready";
          const tool = { id: toolId, name: toolId, steps: JSON.stringify(steps), workspace_id: ws };
          postKeys.push(...postCacheKeys(steps, ws, toolId));
          let got: Safety;
          try {
            const receipt = await playTool(db, tool, {});
            got = summarize(steps, receipt, null);
          } catch (err) {
            got = summarize(steps, null, String(err));
          }
          const want = waves[i]!;
          if (!sameSafety(want, got)) {
            divergences++;
            if (firstErr.length < 8) {
              firstErr.push(
                `case=${spec.index} seq=[${spec.sequence.join(",")}] fault=${spec.fault}@${spec.faultAt} waves=${JSON.stringify(want)} ready=${JSON.stringify(got)}`,
              );
            }
          }
        }
      });
      const readyMs = Math.round(performance.now() - t1);

      await drainPrefetches();
      const cached = new Set(
        (await db.all<{ cache_key: string }>(`SELECT cache_key FROM result_cache`)).map((r) => r.cache_key),
      );
      let cachedPosts = 0;
      for (const k of postKeys) {
        if (cached.has(k)) cachedPosts++;
      }
      if (cachedPosts > 0) {
        divergences++;
        firstErr.push(`POST keys in result_cache: ${cachedPosts}`);
      }

      const ms = wavesMs + readyMs;
      console.log(
        `failsafe-fuzz-sched n=${N_CASES} divergences=${divergences} seed=0x${FUZZ_SEED.toString(16).toUpperCase()} waves_ms=${wavesMs} ready_ms=${readyMs} ms=${ms}`,
      );
      if (firstErr[0]) throw new Error(firstErr[0]);
      expect(divergences).toBe(0);
      expect(N_CASES).toBe(10000);
    },
    TIMEOUT_10K,
  );
});
