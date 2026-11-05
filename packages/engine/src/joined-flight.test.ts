/**
 * D133 through the fan-out's shared calls: a lookup that starts after a change signal must not join a live search
 * begun before it. The joiner would get the copy from before the change and store it under its own later read mark,
 * so the copy would never be doubted (and, stored unchanged, would raise the leader's correctly doubted mark too).
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const scope: Scope = { tenantId: "t", userId: "u" };

/**
 * A connector that lists and notifies (`syncPush`). Its search reads the docs when it starts and answers only when
 * released (`hold`), so a change and its signal can land while it is on the wire. Its listing can fail alone.
 */
class Held implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  searches = 0;
  fetches = 0;
  failSearch = false;
  failList = false;
  hold = false;
  private gates: (() => void)[] = [];
  docs = new Map<string, { title: string; text: string }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    return d ? { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text } : null;
  }
  release(): void {
    while (this.gates.length > 0) this.gates.shift()!();
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    if (this.failSearch) throw new Error("503 Service Unavailable");
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    const found = [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
    if (this.hold) await new Promise<void>((r) => this.gates.push(r));
    return found;
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    return this.item(ref);
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    if (this.failList) throw new Error("503 Service Unavailable");
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const LISBON = { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon on 12 November." };
const PORTO = { title: "Quarterly offsite", text: "The quarterly offsite moved to Porto on 19 November." };

/** A partner whose sync has read `src` once, then sees its listing fail and a first signal: the copy is behind. */
async function behind(src: Held) {
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
      confidentScore: 0.1,
      minMatchedTerms: 1,
      sync: true,
      syncPush: true,
      syncPageSize: 100,
      verifyDelivery: true,
    },
  });
  partner.sync!.track(scope, clock);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  clock += 5 * MIN;
  src.failList = true; // The on-demand poll fails: a lookup searches the source live.
  expect(partner.sourceChanged(scope, "notes")).toBe(true);
  clock += MIN;
  return { partner, advance: (ms: number) => (clock += ms), now: () => clock };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
/** Lets the lookups reach the source's held search. */
async function untilSearches(src: Held, n: number): Promise<void> {
  for (let i = 0; i < 200 && src.searches < n; i++) await tick();
}

describe("a lookup after a change signal does not join a search begun before it", () => {
  test("observe: s2, after the signal, does not deliver the copy from before it", async () => {
    const src = new Held("notes");
    src.docs.set("q1", LISBON);
    const { partner, now } = await behind(src);
    const say = async (text: string, sessionId: string) => {
      const r = await partner.observe({ ...scope, sessionId, at: now(), kind: "user_message", text } as AgentEvent, {
        waitMs: 5_000,
      });
      return [r.injection, ...partner.takePending({ ...scope, sessionId })].filter((x) => x !== null);
    };
    src.hold = true;
    const s1 = say("Remind me where the quarterly offsite is", "s1");
    await untilSearches(src, 1);
    src.docs.set("q1", PORTO);
    expect(partner.sourceChanged(scope, "notes")).toBe(true);
    const s2 = say("Remind me where the quarterly offsite is", "s2");
    await untilSearches(src, 2);
    src.hold = false;
    src.release();
    await tick();
    src.release();
    const [, got2] = await Promise.all([s1, s2]);
    const text2 = got2.map((i) => i.text).join("\n");
    expect(text2).not.toContain("Lisbon");
    expect(text2).toContain("Porto");
    expect(src.searches).toBe(2);
  });

  test("ask: s2 leads its own search; a later ask with search failing answers Porto", async () => {
    const src = new Held("notes");
    src.docs.set("q1", LISBON);
    const { partner, advance } = await behind(src);
    const ask = (sessionId: string) =>
      partner.ask({ ...scope, sessionId, question: "Where is the quarterly offsite?" });
    src.hold = true;
    const s1 = ask("s1");
    await untilSearches(src, 1);
    src.docs.set("q1", PORTO);
    expect(partner.sourceChanged(scope, "notes")).toBe(true);
    const s2 = ask("s2");
    await untilSearches(src, 2);
    src.hold = false;
    src.release();
    await tick();
    src.release();
    const [r1, r2] = await Promise.all([s1, s2]);
    expect(src.searches).toBe(2);
    // s1's read began before the signal: its copy is doubted and re-read before it is said.
    expect(r1.answer).not.toContain("Lisbon");
    expect(r2.answer).toContain("Porto");
    expect(r2.answer).not.toContain("Lisbon");
    advance(MIN);
    src.failSearch = true;
    const r3 = await ask("s3");
    expect(r3.answer).toContain("Porto");
    expect(r3.answer).not.toContain("Lisbon");
  });

  test("control, no signal between: the second lookup joins the first's search (one connector call)", async () => {
    const src = new Held("notes");
    src.docs.set("q1", LISBON);
    const { partner } = await behind(src);
    const ask = (sessionId: string) =>
      partner.ask({ ...scope, sessionId, question: "Where is the quarterly offsite?" });
    src.hold = true;
    const s1 = ask("s1");
    await untilSearches(src, 1);
    const s2 = ask("s2");
    await tick();
    await tick();
    src.hold = false;
    src.release();
    const [r1, r2] = await Promise.all([s1, s2]);
    expect(src.searches).toBe(1);
    expect(r1.answer).toContain("Lisbon");
    expect(r2.answer).toContain("Lisbon");
  });
});
