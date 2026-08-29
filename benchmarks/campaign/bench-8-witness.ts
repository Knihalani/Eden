/**
 * Wave 3.5 — go-live at ≤8 witnesses, zero uncertified inflation.
 *
 *   CAMPAIGN_THINK_MS=0 bun benchmarks/campaign/bench-8-witness.ts
 *
 * Prints PASS/total and uncertified count. Exit 0 iff every cell PASSes
 * certified (uncertified === 0).
 */
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? "0";

import { Session } from "./session";
import {
  DESK_IDS,
  INCIDENT_KEYS,
  ORDER_IDS,
  blockSeed,
  createDesk,
  createEtl,
  createIncident,
  createOrders,
} from "./worlds";

type Cell = {
  world: string;
  factory: () => import("./worlds").World;
  pool: Array<Record<string, unknown>>;
};

const cells: Cell[] = [
  { world: "desk", factory: createDesk, pool: [...DESK_IDS].map((id) => ({ id })) },
  { world: "orders", factory: createOrders, pool: [...ORDER_IDS].map((orderId) => ({ orderId })) },
  { world: "etl", factory: () => createEtl(6), pool: ["R-S1", "R-S2", "R-S3", "R-S4"].map((run) => ({ run })) },
  { world: "incident", factory: () => createIncident(0), pool: [...INCIDENT_KEYS].map((key) => ({ key })) },
];

async function main() {
  const nWitness = 8;
  const compile = 5;
  const holdout = 3;
  let pass = 0;
  let uncertified = 0;
  const rows: string[] = [];
  for (const cell of cells) {
    const s = new Session([[cell.world, cell.factory]], true);
    for (let i = 0; i < nWitness; i++) {
      await s.stretch(cell.world, cell.pool[i % cell.pool.length]!, blockSeed(`w3-8-${cell.world}`, i));
    }
    const r = await s.goLive(cell.world, { compile, holdout, sandbox: cell.factory });
    const u = r.uncertified === true ? 1 : 0;
    uncertified += u;
    if (r.verdict === "PASS" && r.program && !u) pass++;
    rows.push(`${cell.world}\t${r.verdict}\tuncertified=${u}\tseq=${r.program?.sequence?.length ?? 0}`);
  }
  const total = cells.length;
  console.log(rows.join("\n"));
  console.log(`PASS/total=${pass}/${total} uncertified=${uncertified}`);
  if (pass !== total || uncertified !== 0) process.exit(1);
}

await main();
