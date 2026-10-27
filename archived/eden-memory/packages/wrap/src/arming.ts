import type { StretchProgram } from "@eden/ir";

export const ARM_TTL_MS = 60_000;
export const ARM_SLACK_CALLS = 32;
export const ARM_MAX_PER_SESSION = 64;

export function armMaxPerSession(explicit?: number): number {
  const env = Number(process.env.EDEN_ARM_MAX);
  const raw = explicit && explicit > 0 ? explicit : Number.isFinite(env) && env > 0 ? env : ARM_MAX_PER_SESSION;
  return Math.min(10_000, Math.max(1, Math.floor(raw)));
}

export type Armed = {
  rest: Map<string, number>;
  input: Record<string, unknown>;
  programId: string;
  armedAt: number;
  armedAtCall: number;
  budgetCalls: number;
  matchedCalls: number;
  settled: Promise<boolean>;
  resolveSettled: (ok: boolean) => void;
  headErr?: unknown;
  closed: boolean;
  hintId: unknown;
  readOnly?: boolean;
  fleetId?: string;
  served?: Set<string>;
  agentIds?: Set<string>;
};

export type FleetHit = { session: string; key: string; armed: Armed };

export type ArmingStats = {
  sessions: number;
  armings: number;
  admits: number;
  rejects: number;
};

export type ArmingStore = {
  readonly perSessionMax: number;
  readonly globalMax: number;
  insert(session: string, key: string, armed: Armed): boolean;
  delete(session: string, key: string): void;
  get(session: string, key: string): Armed | undefined;
  scan(session: string, name: string, args: Record<string, unknown>, now: number): Array<[string, Armed]>;
  scanFleet(fleetId: string, name: string, args: Record<string, unknown>, now: number): FleetHit[];
  all(session: string, now: number): Array<[string, Armed]>;
  allFleet(fleetId: string, now: number): FleetHit[];
  sessionSize(session: string): number;
  globalSize(): number;
  stats(): ArmingStats;
};

type Bucket = {
  byKey: Map<string, Armed>;
  recency: string[];
};

export function restCounts(program: StretchProgram): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of (program.sequence ?? []).slice(1)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function totalRest(rest: Map<string, number>): number {
  let n = 0;
  for (const c of rest.values()) n += c;
  return n;
}

export function hintIdOf(rec: Record<string, unknown>): unknown {
  for (const k of ["id", "ticket_id", "ticketId", "orderId", "key"]) if (k in rec) return rec[k];
  return undefined;
}

export function armExpired(a: Armed, now: number): boolean {
  if (!a.closed) return false;
  return now - a.armedAt > ARM_TTL_MS || a.matchedCalls >= a.budgetCalls;
}

export function mightClaim(armed: Armed, name: string, args: Record<string, unknown>): boolean {
  const argHint = hintIdOf(args);
  if (armed.hintId !== undefined && argHint !== undefined && armed.hintId !== argHint) return false;
  return armed.rest.has(name) || (armed.hintId !== undefined && argHint !== undefined);
}

export function createArmingStore(opts?: { perSessionMax?: number; globalMax?: number }): ArmingStore {
  const perSessionMax = armMaxPerSession(opts?.perSessionMax);
  const envGlobal = Number(process.env.EDEN_ARM_GLOBAL);
  const globalRaw =
    opts?.globalMax && opts.globalMax > 0
      ? opts.globalMax
      : Number.isFinite(envGlobal) && envGlobal > 0
        ? envGlobal
        : 4_096;
  const globalMax = Math.min(1_000_000, Math.max(1, Math.floor(globalRaw)));
  const sessions = new Map<string, Bucket>();
  let global = 0;
  let admits = 0;
  let rejects = 0;

  const bucket = (session: string): Bucket => {
    let b = sessions.get(session);
    if (!b) {
      b = { byKey: new Map(), recency: [] };
      sessions.set(session, b);
    }
    return b;
  };

  const drop = (session: string, b: Bucket, key: string): void => {
    if (!b.byKey.delete(key)) return;
    global--;
    const i = b.recency.indexOf(key);
    if (i >= 0) b.recency.splice(i, 1);
    if (!b.byKey.size) sessions.delete(session);
  };

  const sweepSession = (session: string, now: number): Bucket | undefined => {
    const b = sessions.get(session);
    if (!b) return undefined;
    for (const [key, a] of b.byKey) {
      if (armExpired(a, now)) drop(session, b, key);
    }
    return sessions.get(session);
  };

  const newest = (b: Bucket): Array<[string, Armed]> => {
    const out: Array<[string, Armed]> = [];
    for (let i = b.recency.length - 1; i >= 0; i--) {
      const key = b.recency[i]!;
      const a = b.byKey.get(key);
      if (a) out.push([key, a]);
    }
    return out;
  };

  return {
    perSessionMax,
    globalMax,
    insert(session, key, armed) {
      const now = performance.now();
      let b = sweepSession(session, now) ?? bucket(session);
      if (b.byKey.size >= perSessionMax) {
        rejects++;
        return false;
      }
      if (global >= globalMax) {
        for (const session of [...sessions.keys()]) sweepSession(session, now);
        b = sessions.get(session) ?? bucket(session);
        if (global >= globalMax || b.byKey.size >= perSessionMax) {
          rejects++;
          return false;
        }
      }
      b.byKey.set(key, armed);
      b.recency.push(key);
      global++;
      admits++;
      return true;
    },
    delete(session, key) {
      const b = sessions.get(session);
      if (!b) return;
      drop(session, b, key);
    },
    get(session, key) {
      return sessions.get(session)?.byKey.get(key);
    },
    scan(session, name, args, now) {
      return this.all(session, now).filter(([, armed]) => mightClaim(armed, name, args));
    },
    scanFleet(fleetId, name, args, now) {
      return this.allFleet(fleetId, now).filter((hit) => mightClaim(hit.armed, name, args));
    },
    all(session, now) {
      const b = sweepSession(session, now);
      if (!b) return [];
      return newest(b);
    },
    allFleet(fleetId, now) {
      if (!fleetId) return [];
      const out: FleetHit[] = [];
      for (const session of [...sessions.keys()]) {
        const b = sweepSession(session, now);
        if (!b) continue;
        for (const [key, armed] of newest(b)) {
          if (armed.readOnly !== true) continue;
          if (armed.fleetId !== fleetId) continue;
          out.push({ session, key, armed });
        }
      }
      return out;
    },
    sessionSize(session) {
      return sessions.get(session)?.byKey.size ?? 0;
    },
    globalSize() {
      return global;
    },
    stats() {
      return { sessions: sessions.size, armings: global, admits, rejects };
    },
  };
}
