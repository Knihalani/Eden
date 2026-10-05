/**
 * The A5 §2 metrics of one run, computed from the oracle files: the world oracle, the annotated cues, the
 * simulated windows and every context the model received (session.ts), plus the event log for latency and
 * guard decisions. Hook output counts only as text the model received; the plugin's own logs are never read.
 *
 * How each definition is read (A5 §2):
 * - A packet is one delivered context; its bullets are its `- ` lines (statements.ts).
 * - `stale`: a bullet states a value that is not the oracle's value for that item at that event, in the scope
 *   the bullet names, else the packet header's, else the scope of the window's turn. When the bullet names no
 *   scope and no value of that item was ever set at the turn's scope or above it, the bullet is about whichever
 *   scope below it holds the value (a SessionStart packet at the root saying "auth is Clerk" while apps/web uses
 *   Clerk). An item that holds no value counts as a different value.
 * - `redundant`: the window already holds the bullet's content (normalized), or states every value the bullet
 *   states, in a sentence that names that value's scope or no scope at all (a bullet that names no scope is
 *   matched in any sentence). The window is the one the packet lands in, as it was before this event's
 *   contexts.
 * - `need_miss`: an annotated cue with needs, where a needed item's current value is neither stated by a bullet
 *   of its packet nor already in its window, in a sentence that names the needed scope, the scope that sets
 *   the value, or no scope.
 * - `false`: a bullet of an annotated packet that states no item in the cue's `needs ∪ allowed`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CueRecord } from "./cues";
import { itemId, parseItemId, type Oracle } from "./oracle";
import { tokensOf, type Delivery, type SimWorld } from "./session";
import {
  bulletContent,
  bulletsOf,
  containsNormalized,
  normalize,
  packetHeader,
  scopesNamed,
  statementsIn,
  statesValue,
  type Statement,
} from "./statements";
import type { WindowSnapshot } from "./window";

/** What a world gives the judge besides its subjects: its scopes and the strings no packet may carry. */
export interface Corpus {
  scopes: readonly string[];
  /** Planted canary secrets (A5 `secret_bytes`). */
  secrets: readonly string[];
  /** Planted instructions (A5 `poison_hits`). */
  poison: readonly string[];
}

/** k of n, with its Wilson 95% interval; null rate and interval when n is 0. */
export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  ci: [number, number] | null;
}

export interface Latency {
  n: number;
  p50: number;
  p99: number;
  max: number;
}

/** One annotated cue's outcome, for paired comparisons between runs (McNemar on `missed`). */
export interface CueOutcome {
  index: number;
  text: string;
  /** Null when the cue needs nothing. */
  missed: boolean | null;
  bullets: number;
  false: number;
  stale: number;
  redundant: number;
}

export interface Metrics {
  stale_rate: Rate;
  redundant_rate: Rate;
  need_miss_rate: Rate;
  false_rate: Rate;
  silence: { nonhuman: Rate; ack: Rate };
  packet_rate: Rate;
  tokens_per_epoch: { epochs: number; p99: number; max: number };
  guard_precision: Rate;
  guard_recall: Rate;
  secret_bytes: number;
  poison_hits: number;
  p99_hook_ms: Record<string, Latency>;
  bulletsByPoint: Record<string, number>;
  /** What A5 §2 defines that this harness cannot measure yet, and why. */
  not_measured: Record<string, string>;
  cues: CueOutcome[];
}

export const NOT_MEASURED: Record<string, string> = {
  "silence.real_negatives": "measured apart, one fresh session per negative: arms/silence.ts (P0.0d)",
  "poison_hits.pins": "P0.4 / P2.1: a pin is known only from Eden's store format; packets are counted",
  abort_rate: "P0.8: budget aborts are known only from Eden's wide events",
  restate_rate: "dogfood only (A5 §5)",
};

/** A value a bullet states, as the item the oracle defines then (`key@scope`). */
export interface Stated {
  item: string;
  value: string;
  stale: boolean;
}

export interface JudgedBullet {
  text: string;
  stated: Stated[];
  stale: boolean;
  redundant: boolean;
}

/** A delivered packet, bullet by bullet, as the oracle reads it. */
export interface Judged {
  delivery: Delivery;
  bullets: JudgedBullet[];
}

/** Every delivered packet of a run, read against the oracle and the window it landed in. */
export function judgeDeliveries(world: SimWorld, corpus: Corpus): Judged[] {
  const judge = new Judge(world.oracle, corpus);
  return world.deliveries.map((delivery) => judge.packet(delivery));
}

export function computeMetrics(world: SimWorld, corpus: Corpus): Metrics {
  const judge = new Judge(world.oracle, corpus);
  const judged = world.deliveries.map((delivery) => judge.packet(delivery));
  const all = judged.flatMap((packet) => packet.bullets);
  const outcomes = world.cues.map((record, index) => judge.cue(record, index, judged));
  const annotated = outcomes.filter((outcome) => outcome.bullets > 0);
  const needing = outcomes.filter((outcome) => outcome.missed !== null);
  return {
    stale_rate: rate(
      count(all, (bullet) => bullet.stale),
      all.length,
    ),
    redundant_rate: rate(
      count(all, (bullet) => bullet.redundant),
      all.length,
    ),
    need_miss_rate: rate(
      count(needing, (outcome) => outcome.missed === true),
      needing.length,
    ),
    false_rate: rate(
      sum(annotated, (outcome) => outcome.false),
      sum(annotated, (outcome) => outcome.bullets),
    ),
    silence: silence(world),
    packet_rate: packetRate(world),
    tokens_per_epoch: tokensPerEpoch(world),
    ...guard(world),
    secret_bytes: secretBytes(world, corpus.secrets),
    poison_hits: count(world.deliveries, (delivery) => corpus.poison.some((text) => delivery.content.includes(text))),
    p99_hook_ms: latencyByPoint(world),
    bulletsByPoint: countBy(judged.flatMap((packet) => packet.bullets.map(() => packet.delivery.event))),
    not_measured: NOT_MEASURED,
    cues: outcomes,
  };
}

/** Reads packets and windows against the oracle. Window texts are prepared once per snapshot. */
class Judge {
  private readonly lower = new WeakMap<WindowSnapshot, string>();
  private readonly normalized = new WeakMap<WindowSnapshot, string>();

  constructor(
    private readonly oracle: Oracle,
    private readonly corpus: Corpus,
  ) {}

  packet(delivery: Delivery): Judged {
    const fallback = scopesNamed(packetHeader(delivery.content), this.corpus.scopes)[0]?.scope ?? delivery.scope;
    const bullets = bulletsOf(delivery.content).map((bullet): JudgedBullet => {
      const content = bulletContent(bullet);
      const statements = statementsIn(content, this.oracle.subjects, this.corpus.scopes);
      const stated = statements.map((statement) => this.stated(statement, fallback, delivery.seq));
      return {
        text: bullet,
        stated,
        stale: stated.some((statement) => statement.stale),
        redundant: this.redundant(content, statements, delivery.seen),
      };
    });
    return { delivery, bullets };
  }

  cue(record: CueRecord, index: number, judged: readonly Judged[]): CueOutcome {
    const packets = judged.filter((packet) => packet.delivery.cue === index);
    const bullets = packets.flatMap((packet) => packet.bullets);
    const wanted = new Set([...record.cue.needs, ...record.cue.allowed].map((id) => this.resolve(id, record.seq)));
    const missed = record.cue.needs.length
      ? record.cue.needs.some((id) => !this.met(id, record, index, bullets))
      : null;
    return {
      index,
      text: record.text,
      missed,
      bullets: bullets.length,
      false: count(bullets, (bullet) => !bullet.stated.some((statement) => wanted.has(statement.item))),
      stale: count(bullets, (bullet) => bullet.stale),
      redundant: count(bullets, (bullet) => bullet.redundant),
    };
  }

  /** A statement read against the truth at its scope (see the header for an unscoped one). */
  private stated(statement: Statement, fallback: string, seq: number): Stated {
    const { key, value } = statement;
    const scope = statement.scope ?? fallback;
    const truth = this.oracle.truth(key, scope, seq);
    if (truth === undefined && statement.scope === undefined) {
      const holder = this.oracle.within(key, scope, seq).find((candidate) => candidate.value === value);
      if (holder) return { item: itemId(key, holder.scope), value, stale: false };
    }
    return { item: itemId(key, truth?.scope ?? scope), value, stale: truth?.value !== value };
  }

  /** A need is met when a bullet of the cue's packet states the item's current value, or the window does. */
  private met(id: string, record: CueRecord, index: number, bullets: readonly JudgedBullet[]): boolean {
    const { key, scope } = parseItemId(id);
    const truth = this.oracle.truth(key, scope, record.seq);
    if (!truth || truth.value === null) {
      throw new Error(`cue ${index} ("${record.text}") needs ${id}, which holds no value then`);
    }
    const item = itemId(key, truth.scope);
    const stated = bullets.some((bullet) =>
      bullet.stated.some((statement) => statement.item === item && statement.value === truth.value),
    );
    const where = { scopes: this.corpus.scopes, accept: [scope, truth.scope] };
    return stated || statesValue(this.lowerOf(record.seen), this.oracle.subject(key), truth.value, where);
  }

  private redundant(content: string, statements: readonly Statement[], seen: WindowSnapshot): boolean {
    if (containsNormalized(this.normalizedOf(seen), normalize(content))) return true;
    if (!statements.length) return false;
    const lower = this.lowerOf(seen);
    return statements.every((statement) => {
      const where =
        statement.scope === undefined ? undefined : { scopes: this.corpus.scopes, accept: [statement.scope] };
      return statesValue(lower, this.oracle.subject(statement.key), statement.value, where);
    });
  }

  /** An item as the oracle defines it then: `pkg.manager@apps/web` is `pkg.manager@` while only the root sets it. */
  private resolve(id: string, seq: number): string {
    const { key, scope } = parseItemId(id);
    return itemId(key, this.oracle.truth(key, scope, seq)?.scope ?? scope);
  }

  private lowerOf(seen: WindowSnapshot): string {
    let text = this.lower.get(seen);
    if (text === undefined) this.lower.set(seen, (text = seen.text.toLowerCase()));
    return text;
  }

  private normalizedOf(seen: WindowSnapshot): string {
    let text = this.normalized.get(seen);
    if (text === undefined) this.normalized.set(seen, (text = normalize(seen.text)));
    return text;
  }
}

/** Packets on non-human submits (only `Updated:` items may be delivered there) and on `ack` turns. */
function silence(world: SimWorld): Metrics["silence"] {
  const nonhuman = world.log.filter((record) => record.submit !== undefined && record.submit !== "human");
  const breaks = (seq: number) =>
    world.deliveries.some(
      (delivery) =>
        delivery.seq === seq && bulletsOf(delivery.content).some((bullet) => !/^updated:/i.test(bulletContent(bullet))),
    );
  const acks = world.cues.flatMap((record, index) => (record.cue.mode === "ack" ? [index] : []));
  return {
    nonhuman: rate(
      count(nonhuman, (record) => breaks(record.seq)),
      nonhuman.length,
    ),
    ack: rate(
      count(acks, (index) => world.deliveries.some((delivery) => delivery.cue === index)),
      acks.length,
    ),
  };
}

/** Human submits that got a packet ÷ human submits. */
function packetRate(world: SimWorld): Rate {
  const human = world.log.filter((record) => record.submit === "human");
  const got = (seq: number) => world.deliveries.some((delivery) => delivery.seq === seq);
  return rate(
    count(human, (record) => got(record.seq)),
    human.length,
  );
}

/**
 * Eden's tokens per epoch: per window, the packets between compactions (a `/clear` starts a new session). The
 * epochs are every window's, including those that received nothing.
 */
function tokensPerEpoch(world: SimWorld): Metrics["tokens_per_epoch"] {
  const compactions = world.log.filter(
    (record) => record.event === "SessionStart" && record.payload.source === "compact",
  );
  const epochOf = (sessionId: string, window: string, seq: number) => {
    const before = window === "main" ? compactions.filter((c) => c.sessionId === sessionId && c.seq <= seq) : [];
    return `${sessionId}/${window}/${before.length}`;
  };
  const tokens = new Map<string, number>();
  for (const record of world.log) {
    if (record.window === "main" || record.event === "SubagentStart") {
      tokens.set(epochOf(record.sessionId, record.window, record.seq), 0);
    }
  }
  for (const delivery of world.deliveries) {
    const epoch = epochOf(delivery.sessionId, delivery.window, delivery.seq);
    tokens.set(epoch, (tokens.get(epoch) ?? 0) + tokensOf(delivery.content));
  }
  const values = [...tokens.values()].sort((a, b) => a - b);
  return { epochs: values.length, p99: values.length ? quantile(values, 0.99) : 0, max: values.at(-1) ?? 0 };
}

/** Guard `ask`s on calls the script marks as breaking a policy, and the breaking calls that got one. */
function guard(world: SimWorld): Pick<Metrics, "guard_precision" | "guard_recall"> {
  const calls = world.log.filter((record) => record.event === "PreToolUse");
  const asked = (record: (typeof calls)[number]) =>
    record.invocations.some((invocation) => invocation.outcome.permissionDecision === "ask");
  const breaking = (record: (typeof calls)[number]) => world.violations.has(String(record.payload.tool_use_id));
  const asks = calls.filter(asked);
  const breaks = calls.filter(breaking);
  return {
    guard_precision: rate(count(asks, breaking), asks.length),
    guard_recall: rate(count(breaks, asked), breaks.length),
  };
}

/** Bytes of planted secrets under the memory root and the plugin's data directory, and in any packet. */
function secretBytes(world: SimWorld, secrets: readonly string[]): number {
  if (!secrets.length) return 0;
  const roots = [join(world.home, ".eden"), join(world.home, ".claude", "plugins", "data")];
  const blobs = [
    ...roots.flatMap((root) => listFiles(root)).map((path) => readFileSync(path)),
    ...world.deliveries.map((delivery) => Buffer.from(delivery.content)),
  ];
  let bytes = 0;
  for (const blob of blobs) {
    for (const secret of secrets) {
      const needle = Buffer.from(secret);
      for (let at = blob.indexOf(needle); at >= 0; at = blob.indexOf(needle, at + 1)) bytes += needle.length;
    }
  }
  return bytes;
}

/** Every file under `dir`, recursively; none when it does not exist. */
export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  } catch {
    return [];
  }
}

/** Wall time per hook invocation, spawn included, by delivery point. */
export function latencyByPoint(world: SimWorld): Record<string, Latency> {
  const byPoint = new Map<string, number[]>();
  for (const record of world.log) {
    for (const invocation of record.invocations) {
      const samples = byPoint.get(record.event) ?? [];
      samples.push(invocation.endedAt - invocation.startedAt);
      byPoint.set(record.event, samples);
    }
  }
  return Object.fromEntries([...byPoint].map(([point, ms]) => [point, latency(ms)]));
}

export function latency(values: readonly number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    n: sorted.length,
    p50: round(quantile(sorted, 0.5)),
    p99: round(quantile(sorted, 0.99)),
    max: round(sorted.at(-1)!),
  };
}

/** The nearest-rank quantile of sorted values. */
function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

export function rate(k: number, n: number): Rate {
  return { k, n, rate: n ? k / n : null, ci: n ? wilson(k, n) : null };
}

/** The Wilson score interval at 95% (EXECUTION X6). */
export function wilson(k: number, n: number, z = 1.959964): [number, number] {
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z / (1 + (z * z) / n)) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

function count<T>(items: readonly T[], test: (item: T) => boolean): number {
  return items.reduce((n, item) => n + (test(item) ? 1 : 0), 0);
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((n, item) => n + value(item), 0);
}

export function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
