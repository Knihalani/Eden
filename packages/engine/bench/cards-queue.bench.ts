// Measures CardEnricher.enqueue CPU on the intent+order queue workload: the duplicate read per item and the
// queue's re-sorts while a backfill fills it faster than the maker drains it (`cardsOrder`, D483).
// Run from the repo root: bun packages/engine/bench/cards-queue.bench.ts [items]
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { CardEnricher } from "../src/cards";

const N = Number(process.argv[2] ?? 40_000);
const maker = {
  // The call never answers: the drain starts but takes nothing, so the queue fills to its bound and stays full.
  async make(): Promise<never> {
    return new Promise(() => {}) as Promise<never>;
  },
};
const enricher = new CardEnricher({ maker: maker as never, budget: new Budget(DEFAULT_LIMITS), now: () => Date.now() });
enricher.intend();
enricher.order();
const scope = { tenantId: "t", userId: "u" };
const items: ContextItem[] = [];
for (let i = 0; i < N; i++) {
  items.push({
    id: `s:item-${i}`,
    sourceId: "s",
    title: `standup note ${i}`,
    text: `from: alice@example.com\nto: bob@example.com\n\nThe deploy deadline is Friday; action on ticket ${i}.`,
    updatedAt: Date.now() - i * 60_000,
  } as ContextItem);
}
const cpu0 = process.cpuUsage();
const t0 = performance.now();
enricher.enqueue(scope, items);
const wall = performance.now() - t0;
const cpu = (process.cpuUsage().user + process.cpuUsage().system) / 1000 - (cpu0.user + cpu0.system) / 1000;
console.log(
  `enqueue ${N} items (intent+order, maxQueue 2000): ` +
    `${wall.toFixed(0)} ms wall, ${cpu.toFixed(0)} ms CPU, ${((cpu * 1000) / N).toFixed(1)} us/item`,
);
