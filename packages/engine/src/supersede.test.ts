import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { assess, frameOf } from "./conflict";
import { ContextPartner } from "./partner";
import { chronological, matterKeys, supersededIn } from "./supersede";

/** `supersede` and `supersedeThreads` (D81, docs/research/smart-supersede.md). */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const mail = (id: string, title: string, date: string, body: string): ContextItem => ({
  id: `gmail:${id}`,
  sourceId: "gmail",
  ref: id,
  title,
  text: `From: Finance <finance@example.com>\nDate: ${date}\n\n${body}`,
});

describe("matterKeys", () => {
  test("a reply's subject is its thread's; an identifier in the title is a matter of its own", () => {
    const a = mail("a", "Globex credit hold", "Mon, 12 Oct 2026 09:00", "");
    const b = mail("b", "RE: Fwd: Globex credit hold", "Tue, 13 Oct 2026 09:00", "");
    expect(matterKeys(a)).toEqual(matterKeys(b));
    expect(matterKeys(mail("c", "OPS-142 outage", "Mon, 12 Oct 2026 09:00", ""))).toContain("id:ops-142");
  });

  test("a title too short to name a matter groups nothing", () => {
    expect(matterKeys(mail("a", "Re: Hi", "Mon, 12 Oct 2026 09:00", ""))).toEqual([]);
  });

  test("the same subject in another source is another matter", () => {
    const a = mail("a", "Globex credit hold", "Mon, 12 Oct 2026 09:00", "");
    expect(matterKeys({ ...a, sourceId: "drive" })).not.toEqual(matterKeys(a));
  });
});

describe("supersededIn", () => {
  const hold = mail("hold", "Globex credit hold", "Mon, 5 Oct 2026 09:00", "Globex is on credit hold.");
  const lifted = mail("lift", "Re: Globex credit hold", "Mon, 12 Oct 2026 09:00", "Credit hold lifted.");
  const thanks = mail("thx", "Re: Globex credit hold", "Tue, 13 Oct 2026 09:00", "Thanks!");
  const decisive = (i: ContextItem) => /hold|lifted/i.test(i.text.split("\n\n")[1] ?? "");

  test("an older item is superseded by the newest decisive one about its matter", () => {
    const out = supersededIn([hold, lifted], decisive);
    expect(out.get(hold.id)?.by).toBe(lifted.id);
    expect(out.has(lifted.id)).toBe(false);
  });

  test("a newer reply that says nothing decisive supersedes nothing; the decisive one before it still does", () => {
    const out = supersededIn([thanks, hold, lifted], decisive);
    expect(out.has(thanks.id)).toBe(false);
    expect(out.get(hold.id)?.by).toBe(lifted.id);
    expect(out.has(lifted.id)).toBe(false);
  });

  test("items with no date, or alone in their matter, are left alone", () => {
    const undated: ContextItem = { ...hold, id: "gmail:u", text: "Globex is on credit hold." };
    expect(supersededIn([undated, lifted], decisive).size).toBe(0);
    expect(supersededIn([hold], decisive).size).toBe(0);
  });
});

describe("chronological", () => {
  const reply = [
    "From: Ann <ann@example.com>",
    "Date: Tue, 13 Oct 2026 10:00",
    "",
    "Sorry, the hold is back on until Friday.",
    "",
    "On Mon, 12 Oct 2026 10:00, Ann <ann@example.com> wrote:",
    "> The hold is lifted.",
    "> ",
    "> On Sun, 11 Oct 2026 10:00, Ann <ann@example.com> wrote:",
    "> > Account on hold.",
  ].join("\n");

  test("quoted messages come oldest first, quote marks and 'wrote:' lines gone", () => {
    const out = chronological(reply);
    expect(out.indexOf("Account on hold.")).toBeLessThan(out.indexOf("The hold is lifted."));
    expect(out.indexOf("The hold is lifted.")).toBeLessThan(out.indexOf("back on until Friday"));
    expect(out.split("\n").some((l) => l.startsWith(">"))).toBe(false);
    expect(out).not.toContain("wrote:");
  });

  test("a text with no quote is unchanged", () => {
    expect(chronological("Plain note.\nSecond line.")).toBe("Plain note.\nSecond line.");
  });

  test("read oldest first, a reply that lifts a quoted hold clears the request", () => {
    const lifting: ContextItem = {
      id: "gmail:t",
      sourceId: "gmail",
      ref: "t",
      title: "Re: Globex account",
      text: [
        "Date: Tue, 13 Oct 2026 10:00",
        "",
        "Good news: the Globex credit hold is lifted.",
        "",
        "On Mon, 12 Oct 2026 10:00, Finance wrote:",
        "> Globex is on credit hold, no new orders.",
      ].join("\n"),
    };
    const frame = frameOf("Confirm the Globex order.", null, NOW, ["Globex"], true);
    expect(assess(frame, { ...lifting, text: chronological(lifting.text) }, NOW)).toBe("clear");
  });
});

/** A source that returns every item sharing a word of four letters or more with the query. */
const source = (items: ContextItem[]): Source => ({
  id: "gmail",
  kind: "test",
  description: "Mail",
  search: async (q) => {
    const words = (q.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4);
    return items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  },
});

async function ask(items: ContextItem[], question: string, config: Record<string, unknown>, userId = "u1") {
  const p = new ContextPartner({
    sources: async (scope) => (scope.userId === "u1" ? [source(items)] : [source([])]),
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config,
  });
  const a = await p.ask({ tenantId: "t", userId, sessionId: "s", question });
  return a.citations.map((c) => c.itemId);
}

describe("supersede in ask", () => {
  const lifted = mail(
    "lift",
    "Globex account",
    "Mon, 12 Oct 2026 09:00",
    "Globex credit hold lifted 12 Oct after the overdue invoices were paid.",
  );
  const other = mail("note", "Globex order notes", "Fri, 23 Oct 2026 09:00", "Globex pallets order notes for October.");

  test("an action's answer leaves out an item whose latest statement clears it; flag off, it is cited", async () => {
    const q = "Confirm the Globex pallets order on our usual terms.";
    expect(await ask([lifted, other], q, {})).toContain(lifted.id);
    const on = await ask([lifted, other], q, { supersede: true });
    expect(on).not.toContain(lifted.id);
    expect(on).toContain(other.id);
  });

  test("a question keeps the clearing item: it is the answer", async () => {
    const q = "Is the Globex credit hold still on?";
    expect(await ask([lifted, other], q, { supersede: true })).toContain(lifted.id);
  });

  test("an older item about the same matter is dropped once a newer one decides it", async () => {
    const hold = mail("hold", "Kestrel release", "Mon, 19 Oct 2026 09:00", "Kestrel release is on hold until 9 Nov.");
    const moved = mail(
      "move",
      "Re: Kestrel release",
      "Thu, 22 Oct 2026 09:00",
      "Update: the Kestrel release hold is lifted, go ahead.",
    );
    const q = "Is the Kestrel release still on hold?";
    const off = await ask([hold, moved], q, {});
    expect(off).toEqual(expect.arrayContaining([hold.id, moved.id]));
    const on = await ask([hold, moved], q, { supersede: true });
    expect(on).toContain(moved.id);
    expect(on).not.toContain(hold.id);
  });

  test("with askRank and askContext on too, what supersede drops stays out of the answer", async () => {
    // The combined configuration (docs/research/smart-combined.md): the ranker's swap seat and the request's fused
    // finds are read against the same supersession, so neither brings a settled or replaced item back.
    const hold = mail("hold", "Kestrel release", "Mon, 19 Oct 2026 09:00", "Kestrel release is on hold until 9 Nov.");
    const moved = mail(
      "move",
      "Re: Kestrel release",
      "Thu, 22 Oct 2026 09:00",
      "Update: the Kestrel release hold is lifted, go ahead.",
    );
    const all = { supersede: true, askRank: true, askContext: true, askVerdicts: true };
    const q = "Is the Kestrel release still on hold?";
    const on = await ask([hold, moved], q, all);
    expect(on).toContain(moved.id);
    expect(on).not.toContain(hold.id);
    const action = "Confirm the Globex pallets order on our usual terms.";
    const cited = await ask([lifted, other], action, all);
    expect(cited).not.toContain(lifted.id);
    expect(cited).toContain(other.id);
  });

  test("with askContext, a settled item only the request's words found stays out of a narrow question's answer", async () => {
    const p = (config: Record<string, unknown>) =>
      new ContextPartner({
        sources: async () => [source([lifted, other])],
        sourceMap: new SourceMap(),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        now: () => NOW,
        config,
      });
    const scope = { tenantId: "t", userId: "u1", sessionId: "s" };
    const run = async (config: Record<string, unknown>) => {
      const partner = p(config);
      const text = "Confirm the Globex account order on our usual terms.";
      await partner.observe({ ...scope, at: NOW, kind: "user_message", text }, { waitMs: 1_000 });
      const a = await partner.ask({ ...scope, question: "pallets order notes?" });
      return a.citations.map((c) => c.itemId);
    };
    // The request's words ("Globex account") pull in the cleared hold; the narrow question never asked about it.
    const fused = await run({ askContext: true });
    expect(fused).toContain(lifted.id);
    const both = await run({ askContext: true, supersede: true });
    expect(both).not.toContain(lifted.id);
    expect(both).toContain(other.id);
  });

  test("per user: another user's items never reach this user's answer", async () => {
    const q = "Is the Globex credit hold still on?";
    expect(await ask([lifted, other], q, { supersede: true }, "u2")).toEqual([]);
  });
});

describe("supersede in a packet", () => {
  const hold = mail("hold", "Kestrel release", "Mon, 19 Oct 2026 09:00", "Kestrel release is frozen until 9 Nov.");
  const moved = mail(
    "move",
    "Re: Kestrel release",
    "Thu, 22 Oct 2026 09:00",
    "Kestrel release freeze moved: now frozen until 12 Nov.",
  );

  async function packet(config: Record<string, unknown>) {
    const p = new ContextPartner({
      sources: async () => [source([hold, moved])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config,
    });
    const ev = {
      tenantId: "t",
      userId: "u1",
      sessionId: "s",
      at: NOW,
      kind: "user_message" as const,
      text: "Ship the Kestrel release on Tuesday 10 November.",
    };
    const r = await p.observe(ev, { waitMs: 1_000 });
    const pending = p.takePending(ev);
    return [r.injection, ...pending].flatMap((x) => x?.citations.map((c) => c.itemId) ?? []);
  }

  test("a packet keeps the newer item of a matter and drops the one it supersedes", async () => {
    const off = await packet({ groundConflict: true });
    expect(off).toEqual(expect.arrayContaining([hold.id, moved.id]));
    const on = await packet({ groundConflict: true, supersede: true });
    expect(on).toContain(moved.id);
    expect(on).not.toContain(hold.id);
  });
});
