/**
 * The connector options the live A/B harnesses share (`pi-ab.ts`, `hermes-ab.ts`):
 *
 * - `--source-profile FILE|JSON`: per-source overrides of `REALISTIC` (latency, errorRate, ratePerSec), e.g. the
 *   market-latency profiles in `packages/sim/lab/before-after/market-profiles/`. Only the named fields change; search
 *   semantics and snippets stay REALISTIC's.
 * - `--push none|signals|payload|refs` (with the engine's `syncPush`): every sim source says it `notifies`. `signals`:
 *   before each task (an hour of Eden's clock) each source sends a change notification with chance 1 - exp(-rate), its
 *   rate per hour from `--push-rates` (assumed figures: a busy inbox and chat change every hour, a calendar, docs and
 *   a CRM a few times a day). The world does not change during a run, so the poll a notification causes is a cost
 *   with nothing new to find. `payload`: notifications carry their items (a Slack event, a trigger's payload), which
 *   costs no source call, and the static world sends none. `refs` (D347): the notices `signals` sends, each naming
 *   one ref (the source's newest item), which Eden reads; content unchanged. `none` (the default): sources do not
 *   notify.
 */
import { readFileSync } from "node:fs";
import type { ContextItem, Scope } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { Rng } from "../rng";
import { REALISTIC, withOverrides, type ProfileSet, type SimSource, type SourceProfile } from "../sources";

export type PushMode = "none" | "signals" | "payload" | "refs";

export interface ConnectorOptions {
  /** The `--source-profile` argument as given ("" when absent). */
  sourceProfileArg: string;
  profiles: ProfileSet;
  push: PushMode;
  pushRates: Record<string, number>;
}

export const DEFAULT_PUSH_RATES = "gmail=4,slack=6,calendar=0.3,drive=0.3,crm=0.2";

export function connectorOptions(opt: (name: string, fallback: string) => string): ConnectorOptions {
  const sourceProfileArg = opt("source-profile", "");
  const profiles = sourceProfileArg
    ? withOverrides(
        REALISTIC,
        JSON.parse(
          sourceProfileArg.trim().startsWith("{") ? sourceProfileArg : readFileSync(sourceProfileArg, "utf8"),
        ) as Record<string, Partial<SourceProfile>>,
      )
    : REALISTIC;
  const push = opt("push", "none") as PushMode;
  if (!["none", "signals", "payload", "refs"].includes(push))
    throw new Error("--push must be none, signals, payload or refs");
  const pushRates = Object.fromEntries(
    opt("push-rates", DEFAULT_PUSH_RATES)
      .split(",")
      .map((kv) => kv.split("=") as [string, string])
      .map(([k, v]) => {
        const n = Number(v);
        if (!k || !Number.isFinite(n) || n < 0) throw new Error(`--push-rates: bad entry "${k}=${v}"`);
        return [k, n];
      }),
  );
  return { sourceProfileArg, profiles, push, pushRates };
}

/**
 * The fields a wrapper around a source must keep (a harness's timing wrapper): everything the engine reads off a
 * `Source` besides its calls. A wrapper that dropped `notifies` once made `--push` do nothing (pi-ab, then hermes-ab).
 */
export function sourceFields(
  source: Source,
): Pick<Source, "id" | "kind" | "description" | "listsByTime" | "notifies" | "fetchReportsGone" | "fetchesById"> {
  return {
    id: source.id,
    kind: source.kind,
    description: source.description,
    listsByTime: source.listsByTime,
    notifies: source.notifies,
    fetchReportsGone: source.fetchReportsGone,
    fetchesById: source.fetchesById,
  };
}

export type ConnectorKind = "push" | "delta" | "plain";

/** `--connector-mix P,D`: the share of connectors that push (and have a change feed), and that only have a feed. */
export function parseConnectorMix(arg: string): { push: number; delta: number } | null {
  if (!arg) return null;
  const [push, delta] = arg.split(",").map(Number);
  if (!(push! >= 0) || !(delta! >= 0) || push! + delta! > 1) {
    throw new Error("--connector-mix takes two shares, push,delta, each at least 0 and at most 1 together (0.3,0.3)");
  }
  return { push: push!, delta: delta! };
}

/**
 * `--connector-mix` (F1, D478): gives each connector one of three kinds, by a hash of its id and the seed, so a run
 * holds the kinds a user's connectors really come in rather than all of one:
 * - "push": it sends change notifications and has a change feed (Gmail watch + history, Graph notifications + delta,
 *   Calendar channels + sync token, Salesforce CDC): `notifies` and `changes`;
 * - "delta": a change feed only (a delta cursor with no webhook): `changes`, not `notifies`;
 * - "plain": neither: a listing and a search, polled and swept.
 * The shares are an assumption (the brief's 30% / 30% / 40%), not a census of connectors. Overrides the `--push`
 * rule that every source notifies; what a notice carries is still `--push`'s. Returns each source's kind.
 */
export function applyConnectorMix(
  sources: SimSource[],
  mix: { push: number; delta: number } | null,
  seed: number,
): Map<string, ConnectorKind> {
  const kinds = new Map<string, ConnectorKind>();
  if (!mix) return kinds;
  for (const s of sources) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < s.id.length; i++) h = Math.imul(h ^ s.id.charCodeAt(i), 0x01000193) >>> 0;
    // The low bits of FNV over short ids are poor: mix before reading a share.
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    const u = h / 0x1_0000_0000;
    const kind: ConnectorKind = u < mix.push ? "push" : u < mix.push + mix.delta ? "delta" : "plain";
    kinds.set(s.id, kind);
    s.notifies = kind === "push";
    if (kind !== "plain") s.enableDelta();
  }
  return kinds;
}

/** A wrapper's `changes`, when the source has a change feed (a wrapper that drops it turns the feed off). */
export function changesField(
  source: Source,
  around: (run: () => ReturnType<NonNullable<Source["changes"]>>) => ReturnType<NonNullable<Source["changes"]>> = (
    run,
  ) => run(),
): Pick<Source, "changes"> {
  const changes = source.changes?.bind(source);
  return changes ? { changes: (scope, cursor, signal) => around(() => changes(scope, cursor, signal)) } : {};
}

/** What a results file records of these options (nothing when both are at their defaults). */
export function connectorHeader(o: ConnectorOptions): Record<string, unknown> {
  return {
    ...(o.sourceProfileArg ? { sourceProfile: o.profiles } : {}),
    ...(o.push !== "none" ? { push: { mode: o.push, rates: o.pushRates } } : {}),
  };
}

/**
 * Marks one world's sources as notifying (any push mode) and returns what to call before each task: with `signals`,
 * one hour's notifications. Its random stream is its own, so notifications never shift the sources' latency and
 * error draws.
 */
export function pushNotifier(
  sources: SimSource[],
  o: ConnectorOptions,
  seed: number,
  /** The world's clock (`refs`: an item dated after it is a future event, not a change). */
  now = Date.now(),
): (
  partner: {
    sourceChanged(scope: Scope, sourceId: string): boolean;
    sourceRefs?(scope: Scope, sourceId: string, refs: string[]): { settled: Promise<number> };
  } | null,
  scope: Scope,
) => void {
  if (o.push !== "none") for (const s of sources) s.notifies = true;
  const rng = new Rng(seed * 7_919 + 17);
  return (partner, scope) => {
    if (!partner || (o.push !== "signals" && o.push !== "refs")) return;
    for (const s of sources) {
      if (!rng.chance(1 - Math.exp(-(o.pushRates[s.id] ?? 0)))) continue;
      // `refs` (D347): the same notices, each naming the ref it is about (the source's newest item, as a new mail or
      // an edit to the latest message would be); its content is unchanged, so the re-read finds nothing new.
      const newest = o.push === "refs" ? newestRef(s, now) : null;
      if (newest && partner.sourceRefs) void partner.sourceRefs(scope, s.id, [newest]).settled;
      else partner.sourceChanged(scope, s.id);
    }
  };
}

/** The ref of a source's most recently updated item that is not in the future (a calendar holds future events). */
function newestRef(source: Pick<SimSource, "listAll">, now: number): string | null {
  let best: ContextItem | null = null;
  for (const it of source.listAll())
    if ((it.updatedAt ?? 0) <= now && (!best || (it.updatedAt ?? 0) > (best.updatedAt ?? 0))) best = it;
  return best?.ref ?? null;
}

/**
 * `--days` (pi-ab): the notice for the items a day's recap moved, as the push mode says an integration sends it. A
 * `payload` notice carries the moved items (`sourceItems`, what `EdenClient.sourceChanged(id, { items })` sends: no
 * signal, so no other copy of the source is put in doubt); `signals` is a bare signal per source. Before A3 (D272)
 * every mode sent the bare signal, so from each day's first recap on every push re-read its candidates from that source
 * on the agent's critical path (about 650 ms a task in CL5-CL8's long payload runs). Returns the items sent.
 */
export async function recapNotice(
  partner: {
    sourceChanged(scope: Scope, sourceId: string): boolean;
    sourceItems(scope: Scope, sourceId: string, items: ContextItem[]): Promise<number>;
    sourceRefs(scope: Scope, sourceId: string, refs: string[]): { settled: Promise<number> };
  },
  scope: Scope,
  sources: readonly Pick<SimSource, "id" | "listAll">[],
  moved: ReadonlySet<string>,
  push: PushMode,
): Promise<number> {
  let sent = 0;
  for (const src of sources) {
    const items = src.listAll().filter((x) => moved.has(x.id));
    if (items.length === 0 || push === "none") continue;
    if (push === "payload") {
      await partner.sourceItems(scope, src.id, items);
      sent += items.length;
    } else if (push === "refs") {
      // D347: the moved items named by ref; Eden reads them (awaited: the change lands hours before the recap).
      await partner.sourceRefs(
        scope,
        src.id,
        items.map((x) => x.ref),
      ).settled;
      sent += items.length;
    } else partner.sourceChanged(scope, src.id);
  }
  return sent;
}
