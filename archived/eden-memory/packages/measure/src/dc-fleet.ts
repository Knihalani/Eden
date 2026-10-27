/**
 * Fleet-wide DC% (Wave 7.1). Same frozen dcShare() as workspace×day.
 * Extra keys fleet / agent / region are labels. providerCache never enters.
 */
import { emptyTokenClasses, type TokenClasses } from "@eden/ir";
import { dcPct, dcShare } from "./dc";
import { addTokenClasses } from "./dc-day";

export type FleetDcRun = {
  fleet?: string;
  agent?: string;
  region?: string;
  classes: TokenClasses;
};

export type FleetDcRow = {
  fleet?: string;
  agent?: string;
  region?: string;
  classes: TokenClasses;
  dcShare: number;
  dcPct: number;
};

export function aggregateFleetDc(runs: FleetDcRun[]): FleetDcRow {
  const classes = emptyTokenClasses();
  let fleet: string | undefined;
  let agent: string | undefined;
  let region: string | undefined;
  for (const run of runs) {
    addTokenClasses(classes, run.classes);
    if (typeof run.fleet === "string") fleet = run.fleet;
    if (typeof run.agent === "string") agent = run.agent;
    if (typeof run.region === "string") region = run.region;
  }
  const share = dcShare(classes);
  const pct = dcPct(classes);
  return {
    classes,
    dcShare: Number.isFinite(share) ? share : 0,
    dcPct: Number.isFinite(pct) ? pct : 0,
    ...(fleet != null ? { fleet } : {}),
    ...(agent != null ? { agent } : {}),
    ...(region != null ? { region } : {}),
  };
}
