import { describe, expect, test } from "bun:test";
import { Vocab } from "@eden/primitives";
import { ItemCache } from "./cache";
import { classifySituation } from "./situation";
import { contentTerms, extractEntities, isChatter } from "./text";

describe("extractEntities", () => {
  test("finds names, emails, handles, ids and quoted titles", () => {
    const e = extractEntities('Can you ask Dana Lee (dana@acme.com) about OPS-142 and the "Q3 pricing deck"? cc @sam');
    expect(e).toEqual(expect.arrayContaining(["Dana Lee", "dana@acme.com", "OPS-142", "Q3 pricing deck", "sam"]));
  });

  test("a single capitalised word that starts a sentence is not an entity", () => {
    expect(extractEntities("Book a table for tonight.")).toEqual([]);
    expect(extractEntities("lunch with Priya tomorrow")).toEqual(["Priya"]);
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
