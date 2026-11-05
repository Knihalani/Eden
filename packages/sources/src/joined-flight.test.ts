/**
 * A lookup that joins a call already in flight gets that call's items. A call that began before `dropResults` (the
 * source signalled a change) read the source as it was, so a lookup that arrives after the drop must not join it: it
 * leads a fresh call. Without a drop, joining stays free (one connector call for both).
 */
import type { ContextItem } from "@eden/protocol";
import { describe, expect, test } from "bun:test";
import { SourceFanout } from "./guarded";
import { PlannedSource, QueryPlanner } from "./planner";
import type { SearchQuery, Source } from "./source";

const scope = { tenantId: "t", userId: "u" };

/** A connector whose text can change between calls; each call waits until released. */
function held() {
  const gates: (() => void)[] = [];
  const src = {
    id: "s",
    kind: "t",
    description: "",
    text: "budget is old",
    calls: 0,
    async search(): Promise<ContextItem[]> {
      src.calls++;
      const text = src.text; // The read happens when the call starts.
      await new Promise<void>((r) => gates.push(r));
      return [{ id: "s:1", sourceId: "s", ref: "1", title: "budget", text }];
    },
  };
  const releaseAll = () => {
    while (gates.length > 0) gates.shift()!();
  };
  return { src, releaseAll };
}

const q = (text: string): SearchQuery => ({ scope, text, entities: [], limit: 5 });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("a fan-out call started before dropResults is not joinable", () => {
  test("search: a lookup after the drop leads a fresh call and gets the new text", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const { src, releaseAll } = held();
    const a = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    src.text = "budget is new";
    f.dropResults(scope, "s");
    const b = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    releaseAll();
    await tick();
    releaseAll();
    const [[ao], [bo]] = await Promise.all([a, b]);
    expect(ao!.items[0]!.text).toBe("budget is old");
    expect(bo!.status).toBe("ok");
    expect(bo!.joined).toBeUndefined();
    expect(bo!.items[0]!.text).toBe("budget is new");
    expect(src.calls).toBe(2);
    // Neither call wrote back a page from before the drop: the next lookup is the new text.
    const [c] = await f.search([src], q("budget"), { timeoutMs: 5_000 });
    expect(c!.status).toBe("cached");
    expect(c!.items[0]!.text).toBe("budget is new");
  });

  test("search: without a drop the second lookup joins and the connector sees one call", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const { src, releaseAll } = held();
    const a = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    const b = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    releaseAll();
    const [[ao], [bo]] = await Promise.all([a, b]);
    expect(ao!.status).toBe("ok");
    expect(bo!.joined).toBe(true);
    expect(bo!.items[0]!.text).toBe("budget is old");
    expect(src.calls).toBe(1);
  });

  test("search: another user's drop does not detach this user's flight", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const { src, releaseAll } = held();
    const a = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    f.dropResults({ tenantId: "t", userId: "other" }, "s");
    f.dropResults(scope, "another-source");
    const b = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    releaseAll();
    const [, [bo]] = await Promise.all([a, b]);
    expect(bo!.joined).toBe(true);
    expect(src.calls).toBe(1);
  });

  test("search: a joiner whose leader gave up still sees a later drop", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const { src, releaseAll } = held();
    const gaveUp = new AbortController();
    const a = f.search([src], q("budget"), { timeoutMs: 5_000, signal: gaveUp.signal });
    await tick();
    const b = f.search([src], q("budget"), { timeoutMs: 5_000 }); // joins A's flight
    await tick();
    gaveUp.abort(); // A leaves; B keeps the flight alive.
    await a;
    src.text = "budget is new";
    f.dropResults(scope, "s");
    const c = f.search([src], q("budget"), { timeoutMs: 5_000 });
    await tick();
    releaseAll();
    await tick();
    releaseAll();
    const [[bo], [co]] = await Promise.all([b, c]);
    expect(bo!.joined).toBe(true);
    expect(co!.joined).toBeUndefined();
    expect(co!.items[0]!.text).toBe("budget is new");
    expect(src.calls).toBe(2);
  });

  test("planCalls: a planner call after the drop does not join one from before it", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const { src, releaseAll } = held();
    const calls = f.planCalls(src as Source);
    const sig = new AbortController().signal;
    const a = calls.call(q("budget"), sig);
    await tick();
    src.text = "budget is new";
    f.dropResults(scope, "s");
    const b = calls.call(q("budget"), sig);
    await tick();
    releaseAll();
    await tick();
    releaseAll();
    const [ai, bi] = await Promise.all([a, b]);
    expect(ai[0]!.text).toBe("budget is old");
    expect(bi[0]!.text).toBe("budget is new");
    expect(src.calls).toBe(2);
    expect(calls.cached(q("budget"))?.[0]?.text).toBe("budget is new");
  });

  test("planCalls: without a drop the same query joins (one connector call)", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    const { src, releaseAll } = held();
    const calls = f.planCalls(src as Source);
    const sig = new AbortController().signal;
    const a = calls.call(q("budget"), sig);
    const b = calls.call(q("budget"), sig);
    await tick();
    releaseAll();
    await Promise.all([a, b]);
    expect(src.calls).toBe(1);
    expect(calls.made).toBe(1);
  });

  test("a planned source's lookups still join and are not gated twice", async () => {
    let gated = 0;
    const f = new SourceFanout({ sanitize: (x) => (gated++, x) });
    const { src, releaseAll } = held();
    const via = f.planCalls(src as Source);
    const planned = new PlannedSource(src as Source, new QueryPlanner({ seed: 1 }), undefined, via);
    const a = f.search([planned], q("budget"), { timeoutMs: 5_000 });
    const b = f.search([planned], q("budget"), { timeoutMs: 5_000 });
    for (let i = 0; i < 5; i++) {
      await tick();
      releaseAll();
    }
    const [[ao], [bo]] = await Promise.all([a, b]);
    expect(ao!.status).toBe("ok");
    expect(bo!.joined).toBe(true);
    expect(via.made).toBeGreaterThan(0); // The planned lookup's calls went through `planCalls`.
    expect(gated).toBe(src.calls);
  });
});
