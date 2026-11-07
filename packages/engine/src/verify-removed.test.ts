import { expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// Audit A5 (fixed): an ask's strict re-read (D211) of item A says "changed" (and stores the new copy); while another cited
// item's re-read is still on the wire, a deletion notice (`sourceRemoved`) for A lands. `verifyItems` then finds no
// cached copy for A (`cache.get` is null: held gone) and falls back to `[x]`: the OLD, pre-change copy of a deleted
// item is cited.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const A = itemId("mail", "holdA");

class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  items = new Map<string, ContextItem>();
  /** A fetch of this ref waits for `release`. */
  slowRef: string | null = null;
  release: (() => void) | null = null;
  onSlow: (() => void) | null = null;
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.items.values()].filter(
      (i) => !i.ref.startsWith("hold") && words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)),
    );
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const sorted = [...this.items.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    if (ref === this.slowRef) {
      this.onSlow?.();
      await new Promise<void>((r) => (this.release = r));
    }
    return this.items.get(ref) ?? null;
  }
}

test("a re-read 'changed' item deleted while another re-read runs is not cited (old copy of a deleted item)", async () => {
  const src = new Mail();
  let clock = T0;
  src.add(
    "holdA",
    "Harlow invoice on hold",
    "Harlow invoice payments are on hold until the dispute ends",
    T0 - 9 * HOUR,
  );
  src.add("holdB", "Harlow invoice hold note", "Harlow invoice on hold, says finance, until the audit", T0 - 10 * HOUR);
  for (let i = 0; i < 3; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (1 + i) * HOUR);
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncOnDemand: true,
      syncPageSize: 1,
      syncPollPageSize: 1,
      syncCallsPerMin: 600,
      verifyDelivery: true,
    },
  });
  const user = { tenantId: "t1", userId: "u1" };
  p.sync!.track(user, clock);
  while (!p.sync!.warm(user)) {
    clock += 1_000;
    await p.sync!.tick();
  }
  clock += 10 * 60_000;
  const ask = () => p.ask({ ...user, sessionId: "s1", question: "Is the Harlow invoice on hold?" });
  const before = await ask();
  const ids = before.citations.map((c) => c.itemId);
  expect(ids).toContain(A);
  expect(ids).toContain(itemId("mail", "holdB"));

  // A changes at the source (same age, so the newest-page poll does not list it); a signal doubts every copy.
  src.add("holdA", "Harlow invoice on hold", "Harlow invoice payments: hold lifted, pay now", T0 - 9 * HOUR);
  expect(p.sourceChanged(user, "mail")).toBe(true);
  clock += 60_000;
  src.slowRef = "holdB";
  // While B's re-read waits, A (already re-read as changed) is deleted and its deletion notified.
  src.onSlow = () =>
    setTimeout(() => {
      src.items.delete("holdA");
      p.sourceRemoved(user, "mail", ["holdA"]);
      src.release?.();
    }, 20);
  const r = await ask();
  // Bug: A is cited, with its old pre-change text.
  expect(r.citations.map((c) => c.itemId)).not.toContain(A);
  expect(r.answer).not.toContain("until the dispute ends");
});
