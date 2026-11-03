import { describe, expect, test } from "bun:test";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import { REDACTED } from "@eden/redact";
import { SourceFanout, type ListPage, type Source } from "@eden/sources";
import { ItemCache, sanitizeItem } from "./cache";
import { SyncManager, type SyncOptions } from "./sync";

// Secret-shaped values are assembled from parts so no literal in the repo is one (packages/redact/CLAUDE.md).
const secret = "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
const HOUR = 3_600_000;
const alice = { tenantId: "t", userId: "alice" };
const bob = { tenantId: "t", userId: "bob" };

/** A connector that lists its items as they are now (newest first is not needed here). */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  constructor(
    readonly id: string,
    public items: ContextItem[],
  ) {}
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

const mail = (ref: string, text: string, meta?: Record<string, string>): ContextItem => ({
  id: itemId("mail", ref),
  sourceId: "mail",
  ref,
  title: `Mail ${ref}`,
  text,
  ...(meta ? { meta } : {}),
});

/** The sync's store path (`SyncManager.store`): a listing through the fan-out's redaction hook, then the cache. */
function harness() {
  const cache = new ItemCache({ expireEveryMs: 0 });
  const redacted: string[] = []; // ids the hook was given, in order
  const fanout = new SourceFanout({
    sanitize: (items) => {
      for (const i of items) redacted.push(i.id);
      return items.map((i) => sanitizeItem(i, cache.maxTextChars));
    },
    ratePerSec: 1e6,
    burst: 1e6,
  });
  const ingest = async (scope: Scope, source: ListSource) => {
    const page = await fanout.list(source, scope, undefined, 100, { timeoutMs: 5_000, reuse: cache.reuseFor(scope) });
    if (typeof page === "string") throw new Error(page);
    return { page: page.items, changed: cache.put(scope, page.items, Date.now(), true, true) };
  };
  const held = (scope: Scope, id: string) => cache.get(scope, id) ?? undefined;
  return { cache, redacted, ingest, held };
}

describe("unchanged re-listed items skip redaction (ingest-skip-unchanged-redaction)", () => {
  test("a re-listed unchanged item is not redacted again and keeps its stored copy", async () => {
    const { redacted, ingest, cache } = harness();
    const src = new ListSource("mail", [mail("a", "Dana moved the budget review"), mail("b", "Lunch on Friday")]);
    const first = await ingest(alice, src);
    expect(redacted).toEqual(["mail:a", "mail:b"]);
    expect(first.changed).toHaveLength(2);
    redacted.length = 0;
    const again = await ingest(alice, src);
    expect(redacted).toEqual([]);
    expect(again.changed).toEqual([]);
    expect(again.page[0]).toBe(first.page[0]!); // the very object the cache holds
    expect(cache.syncedCount(alice)).toBe(2);
    // A copy listed again by a structurally equal (not identical) raw object is still recognised.
    src.items = src.items.map((i) => ({ ...i }));
    await ingest(alice, src);
    expect(redacted).toEqual([]);
  });

  test("changed or new text is always redacted: a secret in an edit or a new item is never held", async () => {
    const { redacted, ingest, cache } = harness();
    const src = new ListSource("mail", [mail("a", "Deploy notes"), mail("b", "Lunch on Friday")]);
    await ingest(alice, src);
    redacted.length = 0;
    src.items = [mail("a", `Deploy notes, token ${secret}`), mail("b", "Lunch on Friday"), mail("c", `key ${secret}`)];
    const { changed } = await ingest(alice, src);
    expect(redacted).toEqual(["mail:a", "mail:c"]); // b is unchanged
    expect(changed.map((i) => i.id).sort()).toEqual(["mail:a", "mail:c"]);
    for (const id of ["mail:a", "mail:c"]) {
      const text = cache.get(alice, id)?.text;
      expect(text).toBeDefined();
      expect(text).not.toContain(secret);
      expect(text).toContain(REDACTED);
    }
  });

  test("a change to any field (title, url, meta, updatedAt) is redacted again", async () => {
    const { redacted, ingest } = harness();
    const base = mail("a", "Standup", { start: "2026-11-03T09:00:00+01:00" });
    const src = new ListSource("mail", [base]);
    await ingest(alice, src);
    for (const edit of [
      { title: `Standup ${secret}` },
      { url: `https://x.example/?t=${secret}` },
      { meta: { start: "2026-11-03T09:00:00-05:00" } },
      { updatedAt: 5 },
    ]) {
      redacted.length = 0;
      src.items = [{ ...src.items[0]!, ...edit }];
      const { page } = await ingest(alice, src);
      expect(redacted).toEqual(["mail:a"]);
      expect(JSON.stringify(page)).not.toContain(secret);
    }
  });

  test("per user: one user's held copy is never served for another user's listing of the same item", async () => {
    const { redacted, ingest, held } = harness();
    const src = new ListSource("mail", [mail("a", "Shared text")]);
    await ingest(alice, src);
    redacted.length = 0;
    const forBob = await ingest(bob, src);
    expect(redacted).toEqual(["mail:a"]);
    expect(forBob.page[0]).not.toBe(held(alice, "mail:a"));
  });

  test("a lookup's copy of the item ends the reuse: the next listing redacts again", async () => {
    const { redacted, ingest, cache } = harness();
    const src = new ListSource("mail", [mail("a", "Budget review")]);
    await ingest(alice, src);
    cache.put(alice, [sanitizeItem(mail("a", "Budget review"))], Date.now(), true); // a lookup returned it
    redacted.length = 0;
    await ingest(alice, src);
    expect(redacted).toEqual(["mail:a"]);
  });

  test("a rebuild of the user's index (forgetting another source) keeps the reuse", async () => {
    const { redacted, ingest, cache } = harness();
    const src = new ListSource("mail", [mail("a", "Budget review")]);
    await ingest(alice, src);
    cache.put(alice, [sanitizeItem({ ...mail("x", "Other"), id: itemId("docs", "x"), sourceId: "docs" })]);
    cache.forget(alice, "docs"); // rebuilds the user's vocabulary and index from the live items
    redacted.length = 0;
    await ingest(alice, src);
    expect(redacted).toEqual([]);
  });

  test("an item whose ref the gate redacts is redacted on every listing (its stored id is not its raw id)", async () => {
    const { redacted, ingest } = harness();
    const src = new ListSource("mail", [mail(`ref-${secret}`, "Some text")]);
    await ingest(alice, src);
    redacted.length = 0;
    const { page } = await ingest(alice, src);
    expect(redacted).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(secret);
  });

  test("a redaction hook that leaves items out: nothing is paired wrongly, every returned item is redacted", async () => {
    const cache = new ItemCache({ expireEveryMs: 0 });
    let calls = 0;
    const fanout = new SourceFanout({
      // Drops the first item it is given.
      sanitize: (items) => (calls++, items.slice(1).map((i) => sanitizeItem(i))),
      ratePerSec: 1e6,
      burst: 1e6,
    });
    const src = new ListSource("mail", [mail("a", "one"), mail("b", `two ${secret}`), mail("c", "three")]);
    const go = async () => {
      const page = await fanout.list(src, alice, undefined, 100, { timeoutMs: 5_000, reuse: cache.reuseFor(alice) });
      if (typeof page === "string") throw new Error(page);
      cache.put(alice, page.items, Date.now(), true, true);
      return page.items;
    };
    const first = await go();
    expect(first.map((i) => i.id)).toEqual(["mail:b", "mail:c"]);
    expect(JSON.stringify(first)).not.toContain(secret);
    const second = await go();
    expect(calls).toBe(2);
    expect(JSON.stringify(second)).not.toContain(secret);
    expect(cache.syncedCount(alice)).toBe(2);
  });

  test("through the sync: a sweep of an unchanged source redacts nothing, and an edited item is redacted", async () => {
    let clock = Date.UTC(2026, 10, 3, 9);
    const now = () => clock;
    const cache = new ItemCache({ expireEveryMs: 0 });
    let redactions = 0;
    const fanout = new SourceFanout({
      sanitize: (items) => ((redactions += items.length), items.map((i) => sanitizeItem(i))),
      ratePerSec: 1e6,
      burst: 1e6,
      now,
    });
    const src = new ListSource(
      "mail",
      Array.from({ length: 6 }, (_, i) => ({ ...mail(`m${i}`, `Note ${i}`), updatedAt: clock - i * HOUR })),
    );
    const options: SyncOptions = {
      maxItems: 100,
      pageSize: 4,
      everyMs: 0,
      staleChance: 0.5,
      maxStaleMs: 24 * HOUR,
      activeMs: 24 * HOUR,
      sweepMs: HOUR,
      dropMs: 30 * 24 * HOUR,
      callsPerMin: 1e6,
      catchupPages: 1,
      maxUsersPerTenant: 10,
      timeoutMs: 5_000,
      push: false,
      pushMaxStaleMs: 24 * HOUR,
      pushSweepMs: 24 * HOUR,
      pushGapMs: 0,
    };
    const sync = new SyncManager({ sources: async () => [src], fanout, cache, now }, options);
    const listAll = async () => {
      const target = sync.stats.backgroundItems + src.items.length;
      for (let i = 0; i < 50 && sync.stats.backgroundItems < target; i++) await sync.tick();
      expect(sync.stats.backgroundItems).toBeGreaterThanOrEqual(target);
    };
    sync.track(alice, clock);
    await listAll();
    expect(redactions).toBe(6);
    expect(cache.syncedCount(alice)).toBe(6);
    clock += HOUR + 1;
    sync.track(alice, clock);
    await listAll(); // the sweep
    expect(redactions).toBe(6);
    src.items[2] = { ...src.items[2]!, text: `Note 2, token ${secret}` };
    clock += HOUR + 1;
    sync.track(alice, clock);
    await listAll();
    expect(redactions).toBe(7);
    const text = cache.get(alice, itemId("mail", "m2"), clock)?.text;
    expect(text).toContain(REDACTED);
    expect(text).not.toContain(secret);
  });
});
