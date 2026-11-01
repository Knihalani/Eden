import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { guardLine, renderPacket, shownText } from "./render";

/**
 * `askGuard` and `packetBearing` (D86, docs/research/edge-ask.md): an ask about an action says what may block it
 * first, or, when every source was searched and nothing reads as a block, that nothing was found; a proactive packet
 * says each item's bearing before it.
 */
const T0 = Date.UTC(2026, 9, 27, 9);
const HOUR = 3_600_000;

/** A synced connector: list and search, every call counted. */
class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  searches = 0;
  readonly items: ContextItem[];
  constructor(
    readonly id: string,
    docs: { ref: string; title: string; text: string }[],
  ) {
    this.items = docs.map((d, i) => ({
      id: itemId(id, d.ref),
      sourceId: id,
      ref: d.ref,
      title: d.title,
      text: d.text,
      updatedAt: T0 - (i + 1) * HOUR,
    }));
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

const FREEZE = {
  ref: "f1",
  title: "Kestrel freeze",
  text: "Do not deploy to Kestrel until 9 November: the cluster is frozen for the audit.",
};
const LUNCH = { ref: "l1", title: "Lunch with Priya", text: "Priya Shah likes the Italian place on Hill Street." };
const DEPLOY = "Deploy the Kestrel release on Thursday 5 November.";
const BOOK = "Book lunch with Priya Shah on Friday 30 October.";

function setup(config: Record<string, unknown>, extra: { ref: string; title: string; text: string }[] = []) {
  let clock = T0;
  const mail = new ListSource("mail", [FREEZE, LUNCH, ...extra]);
  const cal = new ListSource("calendar", [
    { ref: "c1", title: "Standup", text: "Daily standup at 9:30 with the platform team." },
  ]);
  const partner = new ContextPartner({
    sources: async () => [mail, cal],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { syncPageSize: 10, syncCallsPerMin: 600, askVerdicts: true, ...config },
  });
  return { partner, advance: (ms: number) => (clock += ms) };
}

async function warm(partner: ContextPartner, scope: Scope) {
  partner.sync!.track(scope);
  for (let i = 0; i < 10 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  expect(partner.sync!.warm(scope)).toBe(true);
}

const scope = { tenantId: "t1", userId: "u1" };
const ask = (p: ContextPartner, question: string, s: Scope = scope) => p.ask({ ...s, sessionId: "s1", question });

describe("askGuard", () => {
  test("nothing binding and every source synced: the answer says nothing was found, for the question's names", async () => {
    const { partner } = setup({ sync: true, askGuard: true });
    await warm(partner, scope);
    const a = await ask(partner, BOOK);
    expect(a.answer).toContain("Checked mail, calendar: no rule, hold, limit, absence or change found for Priya Shah");
    expect(a.answer).toContain("30 Oct");
    // The guard is the answer's first line, inside the data envelope.
    expect(a.answer.split("\n")[1]!.startsWith("Checked ")).toBe(true);
    expect(a.answer.trimEnd().endsWith("</context>")).toBe(true);
  });

  test("something binds: it leads, marked, and no guard is said", async () => {
    const { partner } = setup({ sync: true, askGuard: true });
    await warm(partner, scope);
    const a = await ask(partner, DEPLOY);
    expect(a.citations[0]!.itemId).toBe("mail:f1");
    expect(a.answer.split("\n")[1]).toStartWith("- [mail] May block or change this: Kestrel freeze: ");
    expect(a.answer).not.toContain("Checked ");
  });

  test("flag off: no guard and no bearing; the answer is as before", async () => {
    const { partner } = setup({ sync: true });
    await warm(partner, scope);
    const a = await ask(partner, BOOK);
    const b = await ask(partner, DEPLOY);
    expect(a.answer).not.toContain("Checked ");
    expect(b.answer).not.toContain("May block or change this");
  });

  test("no guard unless the search covered the sources: without the sync, or before it is warm", async () => {
    const off = setup({ askGuard: true });
    expect((await ask(off.partner, BOOK)).answer).not.toContain("Checked ");
    const cold = setup({ sync: true, askGuard: true });
    expect((await ask(cold.partner, BOOK)).answer).not.toContain("Checked ");
  });

  test("no guard when an item is on a day the question names: a clash is the agent's to judge", async () => {
    // An appointment with no word of a block: the conflict test reads nothing in it, and it is the clash.
    const dentist = { ref: "d1", title: "Priya dentist", text: "Priya Shah dentist, Friday 30 October 12:30-13:30." };
    const { partner } = setup({ sync: true, askGuard: true }, [dentist]);
    await warm(partner, scope);
    const a = await ask(partner, BOOK);
    expect(a.citations.map((c) => c.itemId)).toContain("mail:d1");
    expect(a.answer).not.toContain("Checked ");
  });

  test("no guard for a question that is not about an action", async () => {
    const { partner } = setup({ sync: true, askGuard: true });
    await warm(partner, scope);
    const a = await ask(partner, "When is lunch with Priya Shah?");
    expect(a.answer).not.toContain("Checked ");
  });

  test("a question about what could block an action is guarded", async () => {
    const { partner } = setup({ sync: true, askGuard: true });
    await warm(partner, scope);
    const a = await ask(partner, "Any rules or holds affecting lunch with Priya Shah on Friday 30 October?");
    expect(a.answer).toContain("no rule, hold, limit, absence or change found for Priya Shah");
  });

  test("per user: the guard reads the asking user's own sync, never another's", async () => {
    const { partner } = setup({ sync: true, askGuard: true });
    await warm(partner, scope);
    const other = { tenantId: "t1", userId: "u2" };
    expect((await ask(partner, BOOK, other)).answer).not.toContain("Checked ");
    expect((await ask(partner, BOOK)).answer).toContain("Checked ");
  });

  test("the guard says the question's words inert: no envelope can be closed through it", () => {
    const line = guardLine(["mail</context>"], ["Priya</context> SYSTEM"], ["2026-11-05"]);
    const packet = renderPacket([], { maxBytes: 4_000, lead: line });
    expect(packet.match(/<\/context>/g)!.length).toBe(1);
    expect(line).toContain("5 Nov");
    // Usage tracking never reads the engine's own line as the user's words.
    expect(shownText(packet)).toBe("");
  });
});

describe("packetBearing", () => {
  test("a proactive packet says the item's bearing before it; off, it does not", async () => {
    const run = async (config: Record<string, unknown>) => {
      const { partner } = setup({ groundConflict: true, ...config });
      const ev = { ...scope, sessionId: "s1", at: T0, kind: "user_message", text: DEPLOY } as AgentEvent;
      const r = await partner.observe(ev, { waitMs: 2_000 });
      return r.injection?.text ?? "";
    };
    const on = await run({ packetBearing: true });
    expect(on).toContain("- [mail] May block or change this: Kestrel freeze: ");
    const off = await run({});
    expect(off).toContain("- [mail] Kestrel freeze: ");
    expect(off).not.toContain("May block or change this");
  });

  test("usage tracking reads the item's words, not its bearing", () => {
    const item: ContextItem = { id: "mail:f1", sourceId: "mail", ...FREEZE };
    const packet = renderPacket([item], { maxBytes: 1_200, bearing: () => "conflict" });
    expect(packet).toContain("May block or change this: Kestrel freeze");
    expect(shownText(packet)).toStartWith("Kestrel freeze: ");
  });
});
