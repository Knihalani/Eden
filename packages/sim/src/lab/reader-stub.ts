/**
 * Readers with no model, for $0 screens of the NEW family (lab only; docs/LAB.md "No-model readers").
 *
 * The NEW presets read each acting request with a model (D95, `reader.ts`), so their funnel needed a paid reader or a
 * replay cache keyed on the whole prompt: any change upstream of the reader missed. These makers stand in for the
 * model behind the real `AskReader`, so the engine builds and gates the reader's pool exactly as it would:
 *
 * - `CountingReader` (`--reader stub`, and `gate-traffic.ts`'s reader): counts the calls the engine makes, keeps the
 *   size of each prompt, and says nothing binds. What it measures is the pool (was the planted item in what the
 *   reader would have read), not delivery: with a reader that never binds, NEW's delivery collapses toward the rule
 *   paths, so the hidden and decoy counts of such a run are not NEW's numbers.
 * - `OracleReaderMaker` (`--reader oracle[:p_hit,p_false]`): a ground-truth proxy. It flags the planted hidden item as
 *   bearing (with probability `pHit`) and rejects the planted decoy (flagging it with probability `pFalse`), flipping
 *   with a hash of (task, item id) so a result does not depend on how the run was sharded. One pair of numbers cannot
 *   model how a real reader responds to the prompt's form, length or order: its deltas are a proxy for pool-composition
 *   changes only, to be confirmed by a paid screen.
 */
import { createHash } from "node:crypto";
import { readerMessages, type ReaderInput, type ReaderMaker } from "@eden/engine";

/** What one call would have sent: its items, the whole prompt's characters, and the standing (cached) prefix's. */
export interface StubCall {
  items: number;
  promptChars: number;
  prefixChars: number;
}

/** The size of a reader prompt as `ModelReaderMaker` would send it (`readerMessages`), with its cacheable prefix. */
export function promptSize(input: ReaderInput): StubCall {
  const messages = readerMessages(input);
  const chars = messages.map((m) => m.content.length);
  // With standing items the prompt is [system, standing prefix (cached), request]; without, [system, request].
  const prefixChars = messages.length === 3 ? chars[1]! : 0;
  return { items: input.items.length, promptChars: chars.reduce((a, b) => a + b, 0), prefixChars };
}

/** The reader with no model: counts the calls the engine makes and says nothing binds. */
export class CountingReader implements ReaderMaker {
  calls = 0;
  /** Every call's size, in order (`promptSize`). */
  readonly sizes: StubCall[] = [];
  async read(input: ReaderInput): ReturnType<ReaderMaker["read"]> {
    this.calls++;
    this.sizes.push(promptSize(input));
    return { bears: [], rejected: [], costUsd: 0 };
  }
}

/** A planted item's role in the current task: the item the task needs (hidden), or its near-miss (decoy). */
export type Planted = "hidden" | "decoy";

/** `p_hit,p_false` from `--reader oracle[:p_hit,p_false]` (default 1,0: a perfect reader). */
export function parseOracle(spec: string): { pHit: number; pFalse: number } {
  const rest = spec.slice("oracle".length);
  if (rest === "") return { pHit: 1, pFalse: 0 };
  const m = /^:([0-9.]+),([0-9.]+)$/.exec(rest);
  const pHit = Number(m?.[1]);
  const pFalse = Number(m?.[2]);
  if (!m || !(pHit >= 0 && pHit <= 1) || !(pFalse >= 0 && pFalse <= 1)) {
    throw new Error(`--reader ${spec}: expected oracle or oracle:p_hit,p_false with both in [0, 1]`);
  }
  return { pHit, pFalse };
}

/** A uniform draw in [0, 1) fixed by its key: the same task and item flip the same way in any process. */
export function draw(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/**
 * The ground-truth proxy reader. `task` is the current task's key (seed included; set by the harness before each
 * task) and `planted` names the planted items it may judge; every other item is passed over, as unrelated.
 */
export class OracleReaderMaker extends CountingReader {
  task = "";
  planted = new Map<string, Planted>();
  constructor(
    readonly pHit = 1,
    readonly pFalse = 0,
  ) {
    super();
  }
  override async read(input: ReaderInput): ReturnType<ReaderMaker["read"]> {
    await super.read(input);
    const bears: { i: number; kind: "blocks"; why: string }[] = [];
    const rejected: number[] = [];
    for (const [i, it] of input.items.entries()) {
      const role = this.planted.get(it.id);
      if (!role) continue;
      const u = draw(`${this.task}\t${it.id}`);
      if (role === "hidden" ? u < this.pHit : u < this.pFalse) bears.push({ i, kind: "blocks", why: "oracle proxy" });
      else rejected.push(i);
    }
    return { bears, rejected, costUsd: 0 };
  }
}

/** A funnel task's fields these screens read (hidden-funnel.ts's per-task row). */
export interface ScreenRow {
  variant: "hidden" | "control";
  delivered: boolean;
  askCited?: boolean;
  /** The planted item was in a pool the reader was given for the request, and the pool's distinct items. */
  poolHas?: boolean;
  poolItems?: number;
  /** With a no-model reader: its calls for the task and their prompt and standing-prefix characters, summed. */
  stubCalls?: number;
  promptChars?: number;
  prefixChars?: number;
  /** With `--packet-k`: the planted item's rank among the ask's candidates (-1: absent), and top-K bytes per K. */
  askRank?: number;
  packetKBytes?: Record<string, number>;
  /** With `--lead-in` and a no-model reader: the draft's pool against the request's first read. */
  draftPool?: string[];
  draftHas?: boolean;
  draftJaccard?: number;
  draftSubset?: boolean;
}

/** The banner a stub run prints: its delivery counts are not NEW's. */
export const STUB_BANNER =
  "--reader stub: the reader says nothing binds, so hidden and decoy delivered here are NOT the preset's numbers " +
  "(NEW falls back toward its rule paths); only the pool lines measure something (pool content, not a bound)";

const mean = (a: number, n: number) => (n > 0 ? a / n : 0).toFixed(1);
const split = (rows: ScreenRow[]) => [
  rows.filter((t) => t.variant === "hidden"),
  rows.filter((t) => t.variant !== "hidden"),
];

/** Hidden and decoy in pool, mean pool items, mean prompt and standing-prefix chars; null with no pool data. */
export function poolLine(name: string, rows: ScreenRow[]): string | null {
  const read = rows.filter((t) => t.poolHas !== undefined);
  if (!read.length) return null;
  const [h, c] = split(read);
  const calls = read.reduce((n, t) => n + (t.stubCalls ?? 0), 0);
  const sum = (f: (t: ScreenRow) => number) => read.reduce((n, t) => n + f(t), 0);
  const chars =
    calls > 0
      ? `, mean prompt ${mean(
          sum((t) => t.promptChars ?? 0),
          calls,
        )} chars (standing prefix ` +
        `${mean(
          sum((t) => t.prefixChars ?? 0),
          calls,
        )}) over ${calls} reader calls`
      : "";
  return (
    `${name.padEnd(10)} hidden in pool ${h!.filter((t) => t.poolHas).length}/${h!.length}, decoy in pool ` +
    `${c!.filter((t) => t.poolHas).length}/${c!.length}, mean pool items ` +
    `${mean(
      sum((t) => t.poolItems ?? 0),
      read.length,
    )}${chars}`
  );
}

/** Per K: the planted item in the ask's top K (by rank alone, and with today's delivered or cited), bytes, position. */
export function packetLines(name: string, rows: ScreenRow[], ks: number[]): string[] {
  const ranked = rows.filter((t) => t.askRank !== undefined);
  if (!ranked.length) return [];
  const [h, c] = split(ranked);
  return ks.map((k) => {
    const top = (t: ScreenRow) => t.askRank! >= 0 && t.askRank! < k;
    const held = (t: ScreenRow) => top(t) || t.delivered || !!t.askCited;
    const inTop = h!.filter(top);
    const bytes = ranked.reduce((n, t) => n + (t.packetKBytes?.[k] ?? 0), 0);
    return (
      `${name.padEnd(10)} top-${k}: hidden ${inTop.length}/${h!.length} (with delivered or cited ` +
      `${h!.filter(held).length}), decoys ${c!.filter(top).length}/${c!.length} (${c!.filter(held).length}), ` +
      `mean ${mean(bytes, ranked.length)} bytes, hidden at mean position ` +
      `${mean(
        inTop.reduce((n, t) => n + t.askRank! + 1, 0),
        inTop.length,
      )}`
    );
  });
}

/** The draft's pool against the request's: how often the draft was read, Jaccard, final ⊆ draft, planted in draft. */
export function draftLine(name: string, rows: ScreenRow[]): string | null {
  const led = rows.filter((t) => t.draftPool !== undefined);
  if (!led.length) return null;
  const read = led.filter((t) => t.draftPool!.length > 0);
  const both = led.filter((t) => t.draftJaccard !== undefined);
  const [h] = split(led);
  const j = both.reduce((n, t) => n + t.draftJaccard!, 0) / Math.max(1, both.length);
  return (
    `${name.padEnd(10)} draft pool non-empty ${read.length}/${led.length}; both non-empty ${both.length}: Jaccard ` +
    `mean ${j.toFixed(3)}, final pool ⊆ draft pool ${both.filter((t) => t.draftSubset).length}/${both.length}; hidden ` +
    `in draft pool ${h!.filter((t) => t.draftHas).length}/${h!.length} (in final pool ` +
    `${h!.filter((t) => t.poolHas).length})`
  );
}

/** Every reader-screen line for one group of tasks (pool, packet-k, draft). */
export function screenLines(name: string, rows: ScreenRow[], ks: number[]): string[] {
  return [poolLine(name, rows), ...packetLines(name, rows, ks), draftLine(name, rows)].filter(
    (x): x is string => x !== null,
  );
}
