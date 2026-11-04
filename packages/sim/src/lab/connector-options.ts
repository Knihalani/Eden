/**
 * The connector options the live A/B harnesses share (`pi-ab.ts`, `hermes-ab.ts`):
 *
 * - `--source-profile FILE|JSON`: per-source overrides of `REALISTIC` (latency, errorRate, ratePerSec), e.g. the
 *   market-latency profiles in `packages/sim/lab/before-after/market-profiles/`. Only the named fields change; search
 *   semantics and snippets stay REALISTIC's.
 * - `--push none|signals|payload` (with the engine's `syncPush`): every sim source says it `notifies`. `signals`:
 *   before each task (an hour of Eden's clock) each source sends a change notification with chance 1 - exp(-rate), its
 *   rate per hour from `--push-rates` (assumed figures: a busy inbox and chat change every hour, a calendar, docs and
 *   a CRM a few times a day). The world does not change during a run, so the poll a notification causes is a cost
 *   with nothing new to find. `payload`: notifications carry their items (a Slack event, a trigger's payload), which
 *   costs no source call, and the static world sends none. `none` (the default): sources do not notify.
 */
import { readFileSync } from "node:fs";
import type { Scope } from "@eden/protocol";
import { Rng } from "../rng";
import { REALISTIC, withOverrides, type ProfileSet, type SimSource, type SourceProfile } from "../sources";

export type PushMode = "none" | "signals" | "payload";

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
  if (!["none", "signals", "payload"].includes(push)) throw new Error("--push must be none, signals or payload");
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
): (partner: { sourceChanged(scope: Scope, sourceId: string): boolean } | null, scope: Scope) => void {
  if (o.push !== "none") for (const s of sources) s.notifies = true;
  const rng = new Rng(seed * 7_919 + 17);
  return (partner, scope) => {
    if (!partner || o.push !== "signals") return;
    for (const s of sources)
      if (rng.chance(1 - Math.exp(-(o.pushRates[s.id] ?? 0)))) partner.sourceChanged(scope, s.id);
  };
}
