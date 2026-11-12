/**
 * F5 (docs/research/f5-rule-sheet.md §4): what the shipped enricher reads for one world on the wall clock (as
 * cold-start.ts records shipped coverage) against the world's own clock (as the funnel and pi-ab run). $0: the card
 * role is a fake model that answers `none` for every item, with requests, so every read is counted and nothing paid.
 *   bun packages/sim/lab/f5/clock-check.ts train1:41 train3:42
 */
import type { CardEnricher } from "@eden/engine";
import { FakeModel } from "@eden/llm";
import { buildPartner } from "@eden/server";
import { REALISTIC, simSources } from "../../src/sources";
import { worldOf } from "../../src/lab/ab-common";
import { warmAll } from "../../src/server";

const reply = (n: number) =>
  JSON.stringify({
    cards: Array.from({ length: n }, (_, i) => ({ i, kind: "none" })),
    requests: Array.from({ length: n }, (_, i) => ({ i, r: ["do the thing"] })),
  });
console.log("start");
for (const u of process.argv.slice(2)) {
  const [suite, seed] = u.split(":");
  const clocks = (process.env.CC_CLOCKS ?? "wall,world").split(",") as ("wall" | "world")[];
  for (const clockName of clocks) {
    console.log("world");
    const { world } = worldOf(Number(seed), suite!, "hidden", { maxTasks: 30, maxOffworld: 5 });
    const sources = simSources(world, REALISTIC, 0, Number(seed));
    let chars = 0;
    const model = new FakeModel((req) => {
      chars += req.messages.reduce((n, m) => n + m.content.length, 0);
      const n = (req.messages.at(-1)!.content.match(/<item /g) ?? []).length || 20;
      return reply(n);
    });
    const t0 = Date.now();
    const now = clockName === "world" ? () => world.now + (Date.now() - t0) : undefined;
    const partner = buildPartner({
      sources: async () => sources,
      sourceMapPath: ":memory:",
      queryPlanner: "off",
      models: { reader: null, cards: model, cardsRetry: null, usdPerTenantDay: 25 },
      // `CC_SET`: engine settings over the default (e.g. `{"cardsLean":false}`), as cold-start's `--set`.
      ...(process.env.CC_SET ? { engine: JSON.parse(process.env.CC_SET) } : {}),
      ...(now ? { now } : {}),
    });
    partner.stopSync();
    const cards = (partner as unknown as { deps: { cards?: CardEnricher } }).deps.cards!;
    console.log("built");
    const scope = { tenantId: "cold", userId: `${suite}-${seed}` };
    const at = now ? now() : Date.now();
    await partner.observe({ ...scope, sessionId: "s0", at, kind: "session_start", agent: "clock-check" });
    console.log(`${u} ${clockName}: warming`);
    await warmAll(partner.sync!, [scope], 2_000);
    console.log(`${u} ${clockName}: warm, ${cards.stats.enqueued} enqueued; draining`);
    await cards.idle();
    const s = cards.stats;
    console.log(
      `${u} ${clockName}: enqueued ${s.enqueued} prefiltered ${s.prefiltered} leanSkipped ${s.leanSkipped} ` +
        `sent ${s.sent} (requestOnly ${s.requestOnly}) calls ${s.calls} prompt chars ${chars}`,
    );
    partner.stopSync();
  }
}
process.exit(0);
