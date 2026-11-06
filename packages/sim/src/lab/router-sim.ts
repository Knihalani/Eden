/**
 * The helpers behind `router-sim.bench.ts` (audit 2026-11-06 F23): the router gate on simulated connectors instead
 * of an in-process StaticSource. Each server process holds a few generated worlds; every (tenant, user) gets its own
 * SimSource connectors over its world's shared indexes (own quota, error draws and latency draws, as `server.ts`
 * does for `sim:perf`), with a REALISTIC or market latency profile.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeKey, type Scope } from "@eden/protocol";
import { worldOf } from "../server";
import { buildSessions } from "../sessions";
import {
  REALISTIC,
  simIndexes,
  sourcesFor,
  withOverrides,
  type ProfileSet,
  type SimIndex,
  type SimSource,
  type SourceProfile,
} from "../sources";
import { buildWorld, type World } from "../world";

const MARKET = join(import.meta.dir, "../../lab/before-after/market-profiles");

/** `realistic` (REALISTIC), or a market latency profile over it (`direct`, `hosted`: latency and errors only). */
export function profilesNamed(name: string): ProfileSet {
  if (name === "realistic") return REALISTIC;
  if (name !== "direct" && name !== "hosted") throw new Error(`profile "${name}": use realistic, direct or hosted`);
  const over = JSON.parse(readFileSync(join(MARKET, `${name}.json`), "utf8")) as Record<string, Partial<SourceProfile>>;
  return withOverrides(REALISTIC, over);
}

/** The worlds every process builds (seeds 1,000 + w, as `sim:perf`), each indexed once and shared by its users. */
export function worldIndexes(count: number): SimIndex[][] {
  return Array.from({ length: count }, (_, w) => simIndexes(buildWorld({ seed: 1_000 + w })));
}

/** Per-(tenant, user) connectors, built on first use and kept (the state a real per-user connector cache holds). */
export function simResolver(indexes: SimIndex[][], profiles: ProfileSet, timeScale: number) {
  const users = new Map<string, SimSource[]>();
  const resolver = async (scope: Scope): Promise<SimSource[]> => {
    const key = scopeKey(scope);
    let s = users.get(key);
    if (!s) {
      // track = false: a load run must not keep every returned id.
      s = sourcesFor(indexes[worldOf(scope.userId, indexes.length)]!, profiles, timeScale, users.size + 1, false);
      users.set(key, s);
    }
    return s;
  };
  return { resolver, users };
}

/**
 * One user's events as `/v1/events` bodies, in session order: generated sessions over the user's own world (user
 * messages, tool calls and results, agent messages, external mail), so searches hit what that world holds.
 */
export function userEventBodies(world: World, userId: string, sessions: number, seed: number): string[] {
  const out: string[] = [];
  for (const s of buildSessions(world, { seed, sessions }).sessions) {
    for (const task of s.tasks) {
      for (const turn of task.turns)
        out.push(JSON.stringify({ userId, sessionId: `${userId}-${s.id}`, ...turn.event }));
    }
  }
  return out;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round2 = (x: number) => +x.toFixed(2);

/**
 * D172's reading of `runs[arm][rep]` (arms: single, router over 1, router over N): each repetition's ratio divides by
 * the single process of the same repetition (0 when that arm met the target at no step).
 */
export function gateSummary(runs: number[][]) {
  const [single, hop, many] = runs as [number[], number[], number[]];
  const ratios = many.map((m, r) => (single[r]! > 0 ? m / single[r]! : 0)).map(round2);
  const hopRatios = hop.map((h, r) => (single[r]! > 0 ? h / single[r]! : 0)).map(round2);
  const medianRatio = round2(median(ratios));
  const lowestRatio = round2(Math.min(...ratios));
  return {
    ratios,
    medianRatio,
    lowestRatio,
    hopRatios,
    medianHopRatio: round2(median(hopRatios)),
    meetsD172: ratios.length >= 3 && medianRatio >= 1.5 && lowestRatio >= 1.2,
  };
}
