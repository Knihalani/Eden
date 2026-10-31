#!/usr/bin/env bun
/**
 * What keeping a synced index current costs, by sync mode (docs/research/econ-background.md): one simulated user whose
 * sources receive new items through the working day (and lose a few to deletes), synced by the real `SyncManager`
 * inside a `ContextPartner`, over several days after the backfill. Each lookup is played as the partner plays it
 * with `syncOnDemand`: every source not current is polled (`freshen`) before the lookup reads the local index.
 *
 * Modes:
 * - `poll` (D57 as configured: no timed polls, on-demand polls by each source's learned change rate, a daily sweep);
 * - `timed` (the same plus a timed poll every 15 minutes);
 * - `push` (`syncPush`: the push-capable sources declare a watch and send a notice per change, deletes named in it;
 *   the CRM still polls), with a source's notices read at the next tick (`push`), at most every 30 minutes in the
 *   background (`push30`, `syncPushGapMs`), or only by lookups and the daily check (`pushLazy`).
 *
 * Reports per user-day: listing calls in the background and inside lookups (request-time calls), and freshness: at
 * each lookup, the share of the items that arrived (since the backfill) at least a minute before it that the index
 * holds, the share of deleted items it still holds, and the delay from an item's arrival to its being synced. No
 * model call.
 *
 *   bun packages/sim/src/lab/sync-econ.ts [--days 3] [--lookups 30] [--seed 1] [--json out.json]
 *
 * The arrival rates (per working day: mail 60, chat 150, calendar 6, docs 8, CRM 4) and the 3% same-day deletes are
 * assumptions for the comparison, not measurements of real users.
 */
import { writeFileSync } from "node:fs";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem, Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { Rng } from "../rng";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DAYS = Number(opt("days", "3"));
const LOOKUPS = Number(opt("lookups", "30"));
const SEED = Number(opt("seed", "1"));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 26, 0, 0);
/** Per working day (09:00-18:00), the assumed arrival rate of each source, and whether it can push. */
const RATES: [string, number, boolean][] = [
  ["gmail", 60, true],
  ["slack", 150, true],
  ["calendar", 6, true],
  ["drive", 8, true],
  ["crm", 4, false],
];
const HISTORY_DAYS = 14;

interface Planned {
  item: ContextItem;
  arrive: number;
  deleteAt: number;
}

/** A source whose listing shows what has arrived by the simulated clock, newest first; counts its listing calls. */
class ArrivingSource implements Source {
  readonly kind = "sim";
  readonly description: string;
  lists = 0;
  constructor(
    readonly id: string,
    readonly planned: Planned[],
    private readonly clock: () => number,
  ) {
    this.description = `${id} (arrivals)`;
  }
  visible(at: number): Planned[] {
    return this.planned.filter((p) => p.arrive <= at && p.deleteAt > at).sort((a, b) => b.arrive - a.arrive);
  }
  async search(_q: SearchQuery, _signal: AbortSignal): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const all = this.visible(this.clock());
    const at = cursor === undefined ? 0 : Number(cursor) || 0;
    return {
      items: all.slice(at, at + limit).map((p) => p.item),
      next: at + limit < all.length ? String(at + limit) : null,
    };
  }
}

/** Working-day arrival times for `n` items a day over [from, to), uniform within 09:00-18:00. */
function arrivals(rng: Rng, perDay: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d < to; d += DAY) {
    const n = Math.round(perDay * (0.8 + 0.4 * rng.next()));
    for (let i = 0; i < n; i++) out.push(d + 9 * HOUR + rng.next() * 9 * HOUR);
  }
  return out.sort((a, b) => a - b);
}

type Mode = "poll" | "timed" | "push" | "push30" | "pushLazy";

async function run(mode: Mode) {
  const push = mode.startsWith("push");
  const rng = new Rng(SEED);
  let clock = T0 - 30 * MIN;
  const end = T0 + DAYS * DAY;
  const sources: ArrivingSource[] = [];
  let n = 0;
  for (const [id, perDay] of RATES) {
    const planned: Planned[] = arrivals(rng, perDay, T0 - HISTORY_DAYS * DAY, end).map((arrive) => {
      const k = n++;
      const deleteAt = arrive >= T0 && rng.next() < 0.03 ? arrive + rng.next() * 6 * HOUR : Infinity;
      const item: ContextItem = {
        id: `${id}:${k}`,
        sourceId: id,
        ref: `${id}-${k}`,
        title: `${id} item ${k}`,
        text: `Item ${k} from ${id}.`,
        updatedAt: arrive,
      };
      return { item, arrive, deleteAt };
    });
    sources.push(new ArrivingSource(id, planned, () => clock));
  }
  const scope: Scope = { tenantId: "t", userId: "u" };
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      sync: true,
      ...(mode === "timed" ? { syncEveryMs: 15 * MIN } : {}),
      ...(push ? { syncPush: true } : {}),
      ...(mode === "push30" ? { syncPushGapMs: 30 * MIN } : {}),
      ...(mode === "pushLazy" ? { syncPushGapMs: Infinity } : {}),
    },
  });
  const sync = partner.sync!;
  sync.track(scope, clock);
  for (let i = 0; i < 120 && !sync.warm(scope); i++) {
    await sync.tick();
    clock += MIN;
  }
  // The watch's one poll (what changed before it, no notice names) counts with the backfill.
  if (push) for (const [id, , pushes] of RATES) if (pushes) partner.sourcePushes(scope, id);
  if (push) await sync.tick();
  const backfill = sources.reduce((a, s) => a + s.lists, 0);
  for (const s of sources) s.lists = 0;
  sync.stats.backgroundCalls = 0;
  sync.stats.demandCalls = 0;
  // Lookups through each working day; events between ticks, as a webhook would deliver them.
  const lookupsAt: number[] = arrivals(rng, LOOKUPS, T0, end);
  const notices = sources.flatMap((s, i) =>
    RATES[i]![2]
      ? s.planned.flatMap((p) => [
          ...(p.arrive >= T0 ? [{ at: p.arrive, id: s.id, deleted: undefined as string[] | undefined }] : []),
          ...(p.deleteAt < end ? [{ at: p.deleteAt, id: s.id, deleted: [p.item.id] }] : []),
        ])
      : [],
  );
  notices.sort((a, b) => a.at - b.at);
  let ni = 0;
  let li = 0;
  const fresh: number[] = [];
  const staleDeleted: number[] = [];
  let demandCalls = 0;
  const syncedAt = new Map<string, number>();
  const TICK = 5 * MIN;
  for (let t = T0; t < end; t += TICK) {
    // Within this tick's five minutes: notices and lookups in time order, then the tick.
    for (;;) {
      const nextNotice = push && ni < notices.length && notices[ni]!.at < t + TICK ? notices[ni]!.at : Infinity;
      const nextLookup = li < lookupsAt.length && lookupsAt[li]! < t + TICK ? lookupsAt[li]! : Infinity;
      if (nextNotice === Infinity && nextLookup === Infinity) break;
      if (nextNotice <= nextLookup) {
        const x = notices[ni++]!;
        clock = x.at;
        partner.sourceChanged(scope, x.id, x.deleted ? { deleted: x.deleted } : {});
      } else {
        li++;
        clock = nextLookup;
        sync.track(scope, clock);
        demandCalls += await sync.freshen(scope, sources, AbortSignal.timeout(10_000));
        let due = 0;
        let held = 0;
        let gone = 0;
        let ghost = 0;
        for (const s of sources) {
          for (const p of s.planned) {
            // Items that arrived during the measured days (the history beyond `syncMaxItems` is never synced).
            if (p.arrive < T0 || p.arrive > clock - MIN) continue;
            const has = cache.get(scope, p.item.id, clock) !== null;
            if (p.deleteAt <= clock - MIN) {
              gone++;
              if (has) ghost++;
            } else if (p.deleteAt > clock) {
              due++;
              if (has) held++;
            }
          }
        }
        fresh.push(held / Math.max(1, due));
        staleDeleted.push(ghost / Math.max(1, gone));
      }
      for (const s of sources) {
        for (const p of s.planned) {
          if (!syncedAt.has(p.item.id) && cache.get(scope, p.item.id, clock) !== null) syncedAt.set(p.item.id, clock);
        }
      }
    }
    clock = t + TICK;
    await sync.tick();
    for (const s of sources) {
      for (const p of s.planned) {
        if (!syncedAt.has(p.item.id) && cache.get(scope, p.item.id, clock) !== null) syncedAt.set(p.item.id, clock);
      }
    }
  }
  const delays: number[] = [];
  for (const s of sources) {
    for (const p of s.planned) {
      if (p.arrive < T0 || p.deleteAt < end) continue;
      const at = syncedAt.get(p.item.id);
      delays.push(at === undefined ? end - p.arrive : Math.max(0, at - p.arrive));
    }
  }
  delays.sort((a, b) => a - b);
  const calls = sources.reduce((a, s) => a + s.lists, 0);
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  return {
    mode,
    backfillCalls: backfill,
    callsPerUserDay: Number((calls / DAYS).toFixed(1)),
    requestTimeCallsPerUserDay: Number((demandCalls / DAYS).toFixed(1)),
    requestTimeCallsPerLookup: Number((demandCalls / Math.max(1, lookupsAt.length)).toFixed(2)),
    backgroundCallsPerUserDay: Number(((calls - demandCalls) / DAYS).toFixed(1)),
    freshAtLookup: Number(mean(fresh).toFixed(4)),
    deletedStillHeld: Number(mean(staleDeleted).toFixed(4)),
    syncDelayP50Min: Number(((delays[Math.floor(delays.length / 2)] ?? 0) / MIN).toFixed(1)),
    syncDelayP90Min: Number(((delays[Math.floor(delays.length * 0.9)] ?? 0) / MIN).toFixed(1)),
    notices: sync.stats.notices,
    pushPolls: sync.stats.pushPolls,
    lookups: lookupsAt.length,
  };
}

const out = [];
for (const mode of ["poll", "timed", "push", "push30", "pushLazy"] as const) {
  const r = await run(mode);
  console.log(JSON.stringify(r));
  out.push(r);
}
const json = opt("json", "");
if (json) writeFileSync(json, JSON.stringify(out, null, 2));
