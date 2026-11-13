import { describe, expect, test } from "bun:test";
import { CORE_CONFIG, ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { CallCauses, causeOf, sourceKey } from "./call-causes";

// D1746: the lab's per-cause book of connector calls. Each call is booked to the innermost frame it ran under.

describe("causeOf", () => {
  test("listings by the sync's frames, innermost first", () => {
    expect(causeOf(["step", "backfill"], "list")).toBe("backfill");
    expect(causeOf(["backfillPool"], "list")).toBe("kick backfill");
    expect(causeOf(["step", "poll"], "list")).toBe("floor poll");
    expect(causeOf(["step", "sweep"], "list")).toBe("sweep");
    expect(causeOf(["ask:push", "freshen", "poll"], "list")).toBe("on-demand poll (push)");
    expect(causeOf(["ask", "freshen", "poll"], "list")).toBe("on-demand poll (ask)");
    expect(causeOf(["ask:push", "freshen", "poll", "poll"], "list")).toBe("catch-up poll");
    expect(causeOf(["revision", "poll"], "list")).toBe("revision poll");
    expect(causeOf([], "list")).toBe("other");
  });

  test("searches and fetches by the partner's frames", () => {
    expect(causeOf(["ask:push", "probe"], "search")).toBe("probe");
    expect(causeOf(["lookup", "cutBehind"], "search")).toBe("cut-behind search");
    expect(causeOf(["ask"], "search")).toBe("live search (ask)");
    expect(causeOf(["ask:push", "verify"], "fetch")).toBe("re-read (push verify)");
    expect(causeOf(["ask", "verify:strict"], "fetch")).toBe("re-read (ask strict)");
    expect(causeOf(["refs"], "fetch")).toBe("ref notice read");
  });

  test("noise connectors are one row", () => {
    expect(sourceKey("wiki-17")).toBe("noise");
    expect(sourceKey("gmail")).toBe("gmail");
  });
});

class Notes implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly callPriced = false;
  docs = new Map<string, { text: string; at: number }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem {
    const d = this.docs.get(ref)!;
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title: ref, text: d.text, updatedAt: d.at };
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const all = [...this.docs.keys()].map((r) => this.item(r)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

describe("CallCauses on a partner", () => {
  test("books the backfill and an ask's on-demand poll; what they stored; JSON round trip", async () => {
    const T0 = Date.UTC(2026, 10, 2, 9);
    const clock = { now: T0 };
    const notes = new Notes("notes");
    for (let k = 0; k < 12; k++) notes.docs.set(`n${k}`, { text: `note ${k} about the budget`, at: T0 - k * 60_000 });
    const partner = new ContextPartner({
      sources: async () => [notes],
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock.now,
      config: { ...CORE_CONFIG, sync: true, syncOnDemand: true, syncPageSize: 5 },
    });
    const causes = new CallCauses();
    causes.watchPartner(partner);
    causes.watchSource(notes);
    const scope = { tenantId: "t", userId: "u" };
    partner.sync!.track(scope, clock.now);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    expect(causes.counts.get("backfill")).toBe(3);
    expect(causes.found.get("backfill")).toBe(12);
    // A day on, the copy is stale: the ask polls it first.
    clock.now += 24 * 3_600_000;
    notes.docs.set("n99", { text: "a new note about the budget", at: clock.now });
    await partner.ask({ ...scope, sessionId: "s", question: "what about the budget?" });
    expect(causes.counts.get("on-demand poll (ask)")).toBeGreaterThanOrEqual(1);
    expect(causes.found.get("on-demand poll (ask)")).toBe(1);
    const again = new CallCauses();
    again.add(causes.toJSON());
    expect(again.toJSON()).toEqual(causes.toJSON());
    expect(again.total()).toBe(causes.total());
    expect(causes.table(1, "task")).toContain("on-demand poll (ask)");
    expect(causes.detail(1, "task")).toContain("backfill @ notes");
  });
});
