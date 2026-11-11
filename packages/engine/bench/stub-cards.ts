/**
 * A card enricher whose maker answers every batch at once at no cost: a deadline card and two requests an item (the
 * shape a model's batch gives), so a bench holds the per-user card and intent state of a user with a model key
 * (`live-heap.bench.ts --cards`, `users.bench.ts --cards`, D998). Budgets are the servers' (`DEFAULT_LIMITS`).
 */
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import { type Card, CardEnricher } from "../src/cards";

export function stubCards(now: () => number): CardEnricher {
  return new CardEnricher({
    maker: {
      async make(items, _today, _signal, _retry, intent) {
        const cards = items.map((it): Card => ({
          kind: "deadline",
          actions: ["pay"],
          entities: [it.title.split(" ")[0] ?? "x"],
          end: "2026-11-20",
          statement: `Pay ${it.title.slice(0, 60)} before the 20th`,
        }));
        const requests = intent ? items.map((it) => [`pay ${it.title.slice(0, 30)}`, "book the offsite"]) : undefined;
        return { cards, ...(requests ? { requests } : {}), costUsd: 0 };
      },
    },
    budget: new Budget(DEFAULT_LIMITS),
    now,
  });
}
