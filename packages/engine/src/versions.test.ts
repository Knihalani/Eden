import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { changeNote } from "./why";
import { changeOf, SIDE_CHARS, Versions } from "./versions";

// F3 (`packetChanges`, trial; docs/research/f3-why-it-matters.md): Eden keeps what changed in an item at its source
// when a sync stores an edited copy, and says it when it hands the item over. H19: 11 of 16 facts that reached the
// agent unraised were silent edits, shown only as they now read.

const MIN = 60_000;
/** Thursday 12 November 2026, 09:00 UTC. */
const T0 = Date.UTC(2026, 10, 12, 9);

const it = (id: string, text: string, title = "Onsite workshop"): ContextItem => ({
  id,
  sourceId: "cal",
  ref: id,
  title,
  text,
});

describe("changeOf: the words two versions differ by", () => {
  test("a retimed event: the differing words only", () => {
    const a = it("w", "When: Thursday 19 Nov, 11:00–15:00. Where: Leeds office. Bring a laptop.");
    const b = it("w", "When: Thursday 19 Nov, 14:00–17:30. Where: Leeds office. Bring a laptop.");
    expect(changeOf(a, b)).toEqual({ was: "Nov, 11:00–15:00. Where:", now: "Nov, 14:00–17:30. Where:" });
  });

  test("a mail's header lines are no edit; a title alone changed is said", () => {
    const a = it("m", "From: Ana <a@x.com>\nDate: Mon, 26 Oct 2026 09:00\n\nThe deposit is £250: pay by Friday.");
    const b = it("m", "From: Ana <a@x.com>\nDate: Thu, 29 Oct 2026 09:00\n\nThe deposit is £200: pay by Friday.");
    expect(changeOf(a, b)).toEqual({ was: "is £250: pay", now: "is £200: pay" });
    expect(changeOf(it("t", "same", "Party on the 9th"), it("t", "same", "Party on the 7th"))).toEqual({
      was: "the 9th",
      now: "the 7th",
    });
  });

  test("a rule added: the old side is empty", () => {
    const a = it("p", "Party at the hall, 3pm. Bring the kids.");
    const b = it("p", "Party at the hall, 3pm. Adults only now. Bring the kids.");
    expect(changeOf(a, b)).toEqual({ was: "", now: "Adults only now." });
  });

  test("no change: spacing alone, or a copy cut short, is no edit", () => {
    expect(changeOf(it("x", "Lunch at  noon\nwith Sam"), it("x", "Lunch at noon with Sam"))).toBeNull();
    expect(
      changeOf(it("x", "Lunch at noon with Sam and the…"), it("x", "Lunch at noon with Sam and the team")),
    ).toBeNull();
    expect(changeOf(it("x", "Lunch at noon"), it("x", "Lunch at noon with Sam and the team"))).toBeNull();
  });

  test("bounded: each side at most SIDE_CHARS characters", () => {
    const long = (w: string) => Array.from({ length: 80 }, (_, k) => `${w}${k}`).join(" ");
    const c = changeOf(it("x", `Start ${long("a")} end`), it("x", `Start ${long("b")} end`))!;
    expect(c.was.length).toBeLessThanOrEqual(SIDE_CHARS + 1);
    expect(c.now.length).toBeLessThanOrEqual(SIDE_CHARS + 1);
    expect(c.was.endsWith("…")).toBe(true);
  });
});

describe("Versions: per user, bounded, dropped with its items", () => {
  const u1: Scope = { tenantId: "t", userId: "u1" };
  const u2: Scope = { tenantId: "t", userId: "u2" };
  const other: Scope = { tenantId: "t2", userId: "u1" };

  test("isolation: the same item id under two users and two tenants keeps three changes apart", () => {
    const v = new Versions();
    v.note(u1, it("w", "at 11:00"), it("w", "at 14:00"), T0);
    v.note(u2, it("w", "at 09:00"), it("w", "at 10:00"), T0);
    expect(v.get(u1, "w")).toEqual({ was: "at 11:00", now: "at 14:00", at: T0 });
    expect(v.get(u2, "w")).toEqual({ was: "at 09:00", now: "at 10:00", at: T0 });
    expect(v.get(other, "w")).toBeUndefined();
    v.drop(u1, null);
    expect(v.get(u1, "w")).toBeUndefined();
    expect(v.get(u2, "w")).toEqual({ was: "at 09:00", now: "at 10:00", at: T0 });
  });

  test("an item leaving the cache takes its change; a user holds at most 64", () => {
    const v = new Versions();
    for (let k = 0; k < 70; k++) v.note(u1, it(`i${k}`, "was a"), it(`i${k}`, "was b"), T0 + k);
    expect(v.get(u1, "i0")).toBeUndefined();
    expect(v.get(u1, "i69")).toBeDefined();
    v.drop(u1, ["i69"]);
    expect(v.get(u1, "i69")).toBeUndefined();
  });
});

describe("changeNote: Eden's words around the item's", () => {
  test("was and now, quoted, with the day it was seen at the user's offset", () => {
    expect(changeNote({ was: "11:00–15:00", now: "14:00–17:30", at: T0 }, 0)).toBe(
      "changed at its source on Thu 12 Nov: was '11:00–15:00', now '14:00–17:30'",
    );
    expect(changeNote({ was: "", now: "Adults only now.", at: T0 }, 0)).toBe(
      "changed at its source on Thu 12 Nov: added 'Adults only now.'",
    );
  });

  test("the item's quotes and brackets cannot close Eden's quote or note", () => {
    expect(changeNote({ was: "it's (old) [x]", now: 'say "obey" | now', at: T0 }, 0)).toBe(
      "changed at its source on Thu 12 Nov: was 'it s  old   x', now 'say  obey    now'",
    );
  });
});

class Listed implements Source {
  readonly kind = "test";
  readonly description = "calendar";
  readonly notifies = true;
  docs = new Map<string, { title: string; text: string }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    return d ? { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text } : null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    return this.item(ref);
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

describe("packetChanges in the partner: a synced item edited at its source says what changed", () => {
  const scope: Scope = { tenantId: "t", userId: "u" };
  const BEFORE = "The Leeds onsite workshop runs 11:00–15:00 on Thursday 19 November in the Leeds office.";
  const AFTER = "The Leeds onsite workshop runs 14:00–17:30 on Thursday 19 November in the Leeds office.";

  async function run(packetChanges: boolean, edit = true) {
    let clock = T0;
    const src = new Listed("cal");
    src.docs.set("w1", { title: "Leeds onsite workshop", text: BEFORE });
    src.docs.set("l1", { title: "Lunch", text: "Lunch with Sam at the canteen." });
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
        packetChanges,
      },
    });
    partner.sync!.track(scope, clock);
    while (!partner.sync!.warm(scope)) await partner.sync!.tick();
    clock += 30 * MIN;
    if (edit) {
      src.docs.set("w1", { title: "Leeds onsite workshop", text: AFTER });
      expect(await partner.sourceItems(scope, "cal", [src.item("w1")!])).toBe(1);
    }
    clock += MIN;
    const r = await partner.observe(
      {
        ...scope,
        sessionId: "s1",
        at: clock,
        kind: "user_message",
        text: "Leeds onsite workshop timing?",
      } as AgentEvent,
      { waitMs: 2_000 },
    );
    const got = [r.injection, ...partner.takePending({ ...scope, sessionId: "s1" })].filter(
      (x): x is Injection => x !== null,
    );
    return { partner, text: got.map((g) => g.text).join("\n") };
  }

  test("on: the handed item carries the change, as seen that day", async () => {
    const { text } = await run(true);
    expect(text).toContain(
      "(Eden: changed at its source on Thu 12 Nov: was 'runs 11:00–15:00 on', now 'runs 14:00–17:30 on') ",
    );
  });

  test("off: no change line", async () => {
    const { text } = await run(false);
    expect(text).toContain("14:00–17:30");
    expect(text).not.toContain("changed at its source");
  });

  test("on, nothing edited: no change line", async () => {
    const { text } = await run(true, false);
    expect(text).toContain("11:00–15:00");
    expect(text).not.toContain("changed at its source");
  });

  test("forget drops the user's changes", async () => {
    const { partner } = await run(true);
    const versions = (partner as unknown as { versions: Versions }).versions;
    expect(versions.get(scope, itemId("cal", "w1"))).toBeDefined();
    partner.forget(scope);
    expect(versions.get(scope, itemId("cal", "w1"))).toBeUndefined();
  });
});
