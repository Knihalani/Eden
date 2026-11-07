import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope: Scope = { tenantId: "t1", userId: "u1" };

/** A listing that, once `hang` is set, takes `hang` ms and does not watch its signal (an MCP connect in progress). */
class HangSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  hang = 0;
  items: ContextItem[] = [];
  constructor(readonly id: string) {
    for (let i = 0; i < 3; i++)
      this.items.push({
        id: itemId(id, `m${i}`),
        sourceId: id,
        ref: `m${i}`,
        title: `Mail ${i}`,
        text: "quarterly plan",
        updatedAt: T0 - i * HOUR,
      });
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_s: Scope, _c: string | undefined, limit: number): Promise<ListPage> {
    if (this.hang) await new Promise((r) => setTimeout(r, this.hang));
    return { items: this.items.slice(0, limit), next: null };
  }
}

describe("audit A5: a lookup's on-demand poll and its deadline (D140)", () => {
  test("an ask returns near sourceTimeoutMs when the stale source's listing hangs", async () => {
    const src = new HangSource("mail");
    let clock = T0;
    const partner = new ContextPartner({
      sources: async () => [src],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: {
        ...CORE_CONFIG,
        sync: true,
        syncOnDemand: true,
        syncPageSize: 10,
        syncCallsPerMin: 600,
        syncMaxStaleMs: 4 * HOUR,
        sourceTimeoutMs: 100,
      },
    });
    partner.sync!.track(scope);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    clock += 5 * HOUR;
    src.hang = 1_500;
    await partner.observe({ ...scope, sessionId: "s1", at: clock, kind: "user_message", text: "hi" } as AgentEvent, {
      waitMs: 10,
    });
    const t0 = performance.now();
    await partner.ask({ ...scope, sessionId: "s1", question: "Where is the quarterly plan?" } as never);
    const ms = performance.now() - t0;
    console.log("ask took", Math.round(ms), "ms with sourceTimeoutMs 100 and a 1500 ms listing");
    expect(ms).toBeLessThan(800);
  });
});
