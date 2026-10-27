#!/usr/bin/env bun
/**
 * Runs the connector lab: seeds a world into each connector's backend, plays every case through every query
 * variant via `McpSource`, and prints one JSON report per connector. Needs Docker and the images from build.ts.
 *
 *   bun packages/sim/src/lab/lab-cli.ts [--world 1000] [--sessions 40] [--limit 10] [connector...]
 */
import { buildWorld } from "../world";
import { CONNECTORS, ensureNetwork, removeLabContainers } from "./connectors";
import { labCases, runConnector } from "./lab";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const worldSeed = flag("world", 1_000);
const sessions = flag("sessions", 40);
const limit = flag("limit", 10);
const names = args.length ? args : Object.keys(CONNECTORS);

ensureNetwork();
removeLabContainers();
const world = buildWorld({ seed: worldSeed });
const cases = labCases(world, worldSeed + 7, sessions);
console.error(`world ${worldSeed}: ${world.items.length} items, ${cases.length} cases`);
for (const name of names) {
  const make = CONNECTORS[name];
  if (!make) throw new Error(`no connector ${name}; have ${Object.keys(CONNECTORS).join(", ")}`);
  const report = await runConnector(make(), world, cases, { limit });
  console.log(JSON.stringify({ world: worldSeed, ...report }));
  removeLabContainers();
}
