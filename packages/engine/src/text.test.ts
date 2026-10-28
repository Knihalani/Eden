import { describe, expect, test } from "bun:test";
import { Vocab } from "@eden/primitives";
import { ItemCache } from "./cache";
import { classifySituation } from "./situation";
import { contentTerms, distinctTermIds, extractEntities, isChatter, isChatterTerms } from "./text";

describe("extractEntities", () => {
  test("finds names, emails, handles, ids and quoted titles", () => {
    const e = extractEntities('Can you ask Dana Lee (dana@acme.com) about OPS-142 and the "Q3 pricing deck"? cc @sam');
    expect(e).toEqual(expect.arrayContaining(["Dana Lee", "dana@acme.com", "OPS-142", "Q3 pricing deck", "sam"]));
  });

  test("a single capitalised word that starts a sentence is not an entity", () => {
    expect(extractEntities("Book a table for tonight.")).toEqual([]);
    expect(extractEntities("lunch with Priya tomorrow")).toEqual(["Priya"]);
    // Weekdays and months are dates, not entities; a month that is also a first name, or a longer name, stays.
    expect(extractEntities("Find me a yoga class on Sunday mornings in Islington")).toEqual(["Islington"]);
    expect(extractEntities("the invoice is due in October, ask May")).toEqual(["May"]);
    expect(extractEntities("tickets for the Sunday Times quiz")).toEqual(["Sunday Times"]);
    for (const t of ["meet Sunday's crew", "meet on Sunday-morning", "the SUNDAY deadline", "due Fri, see you"]) {
      expect(extractEntities(t)).toEqual([]);
    }
    expect(extractEntities("on Friday Dana Lee is free")).toEqual(["Dana Lee"]);
    expect(extractEntities("dinner on Monday Tuesday")).toEqual([]);
    expect(extractEntities("lunch with Jun and Jan, ask Sun")).toEqual(["Jun", "Jan", "Sun"]);
    expect(extractEntities("the report is due in March, July at the latest")).toEqual([]);
  });
});

describe("chatter and terms", () => {
  test("acknowledgements carry no information need", () => {
    const v = new Vocab();
    for (const t of ["ok", "Thanks!", "sounds good", "👍"]) expect(isChatter(t, v)).toBe(true);
    expect(isChatter("ok, move it to Friday", v)).toBe(false);
  });

  test("contentTerms drops stopwords and possessives", () => {
    expect(contentTerms("What's Dana's flight to Berlin?", new Vocab())).toEqual(["dana", "flight", "berlin"]);
  });

  test("situations are coarse labels", () => {
    expect(classifySituation("can we meet tomorrow at 3")).toBe("scheduling");
    expect(classifySituation("reply to her email")).toBe("communication");
    expect(classifySituation("hmm")).toBe("general");
  });
});

describe("ItemCache search", () => {
  test("ranks the matching item first by coverage, and forgets removed items", () => {
    const scope = { tenantId: "t", userId: "u" };
    const cache = new ItemCache();
    const item = (ref: string, title: string, text: string) => ({
      id: `crm:${ref}`,
      sourceId: "crm",
      ref,
      title,
      text,
    });
    cache.put(scope, [
      item("a", "Acme renewal", "three year term, 12% discount"),
      item("b", "Offsite", "Team offsite in Lisbon"),
      item("c", "Acme support", "ticket about SSO"),
    ]);
    const vocab = cache.vocabOf(scope);
    const q = ["acme", "renewal", "discount"].map((t) => vocab.lookup(t));
    const hits = cache.search(scope, q, q.length, 3);
    expect(hits[0]!.item.id).toBe("crm:a");
    expect(hits[0]!.coverage).toBeGreaterThan(hits[1]!.coverage);
    expect(cache.containsAll(scope, hits[0]!.doc, [vocab.lookup("acme")], 1)).toBe(true);
    cache.forget(scope, "crm");
    expect(cache.search(scope, q, q.length, 3)).toEqual([]);
  });
});

describe("distinctTermIds", () => {
  test("one id per term, in first-occurrence order, across calls and vocabularies", () => {
    const a = new Vocab();
    const b = new Vocab();
    const ids = distinctTermIds("Dana's flight, dana FLIGHT to Berlin; Berlin", a);
    expect([...ids].map((id) => a.term(id))).toEqual(["dana", "flight", "to", "berlin"]);
    expect([...distinctTermIds("berlin berlin dana", a)]).toEqual([ids[3]!, ids[0]!]);
    expect([...distinctTermIds("zeta zeta alpha", b)].map((id) => b.term(id))).toEqual(["zeta", "alpha"]);
    expect(isChatterTerms("ok then", distinctTermIds("ok then", a), a)).toBe(true);
    expect(isChatterTerms("ok, Berlin", distinctTermIds("ok, Berlin", a), a)).toBe(false);
  });
});
