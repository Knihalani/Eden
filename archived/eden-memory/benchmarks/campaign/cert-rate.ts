/**
 * Wave 2.1 cert rate: PASS/total across the five campaign factories
 * without simulated provider usage. Exit 0 iff rate ≥ 0.95.
 *
 *   bun benchmarks/campaign/cert-rate.ts
 */
process.env.CAMPAIGN_THINK_MS = process.env.CAMPAIGN_THINK_MS ?? "0";

import { Session, type WorldFactory } from "./session";
import {
  DESK_IDS,
  INCIDENT_KEYS,
  ORDER_IDS,
  RESEARCH_TOPICS,
  blockSeed,
  createDesk,
  createEtl,
  createIncident,
  createOrders,
  createResearch,
} from "./worlds";

const FACTORIES: Array<[string, WorldFactory]> = [
  ["desk", createDesk],
  ["orders", createOrders],
  ["etl", () => createEtl(6)],
  ["incident", () => createIncident(0.08)],
  ["research", createResearch],
];
const POOLS: Record<string, Array<Record<string, unknown>>> = {
  desk: [...DESK_IDS].map((id) => ({ id })),
  orders: [...ORDER_IDS].map((orderId) => ({ orderId })),
  etl: ["R-S1", "R-S2", "R-S3", "R-S4"].map((run) => ({ run })),
  incident: [...INCIDENT_KEYS].map((key) => ({ key })),
  research: [...RESEARCH_TOPICS].map((topic) => ({ topic })),
};

const nWitness = 13;

async function main() {
  let pass = 0;
  const total = FACTORIES.length;
  const lines: string[] = [];
  for (const [worldName, factory] of FACTORIES) {
    const pool = POOLS[worldName]!;
    const s = new Session([[worldName, factory]], true);
    for (let i = 0; i < nWitness; i++) {
      await s.stretch(worldName, pool[i % pool.length]!, blockSeed(`cert-rate-${worldName}`, i));
    }
    const r = await s.goLive(worldName, { compile: 9, holdout: 3, sandbox: factory, maxGram: 26 });
    const ok = r.verdict === "PASS" && r.program != null && r.uncertified !== true;
    if (ok) pass++;
    const line =
      `${worldName}: ${r.verdict}${r.uncertified ? " UNCERTIFIED" : ""} ` +
      `program=${r.program ? r.program.sequence.join("→") : "null"} ${r.reasons.slice(0, 2).join("; ")}`;
    lines.push(line);
    process.stdout.write(`  ${line}\n`);
  }
  const rate = total ? pass / total : 0;
  process.stdout.write(`cert-rate: ${pass}/${total} = ${rate.toFixed(4)}\n`);
  process.stdout.write(rate >= 0.95 ? "CERT RATE PASS\n" : "CERT RATE FAIL\n");
  process.exitCode = rate >= 0.95 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
