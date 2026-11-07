/**
 * A7 (D292): how often `bun run demo`'s path (no key, sync backfilled, the shipped wiring through HTTP and the client)
 * puts each training template's deciding item in front of the agent, so the demo's three picks can be read against
 * a rate. Every template of train1–6, hidden variant, seeds 41 and 42; $0.
 *
 *   bun packages/sim/lab/a7/demo-sweep.ts > packages/sim/lab/a7/demo-sweep.txt
 */
import { runDemo } from "../../src/demo";
import { worldOf } from "../../src/lab/ab-common";

let caught = 0;
let total = 0;
for (const suite of ["train1", "train2", "train3", "train4", "train5", "train6"]) {
  for (const seed of [41, 42]) {
    const { tasks } = worldOf(seed, suite, "hidden", { maxTasks: 30, maxOffworld: 0 });
    const { rows } = await runDemo({ seed, suite, picks: tasks.map((t) => t.type) });
    const acts = rows.filter((r) => r.kind === "act");
    const n = acts.filter((r) => r.caught).length;
    caught += n;
    total += acts.length;
    console.log(`${suite} seed ${seed}: ${n} of ${acts.length}`);
    for (const r of acts) console.log(`  ${r.caught ? "caught" : "missed"} ${r.label} (${r.added.length} items)`);
  }
}
console.log(`TOTAL: deciding item reached the agent for ${caught} of ${total} requests`);
process.exit(0);
