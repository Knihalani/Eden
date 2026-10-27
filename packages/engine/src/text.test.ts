import { describe, expect, test } from "bun:test";
import { Bm25Index } from "./bm25";
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
    for (const t of ["ok", "Thanks!", "sounds good", "👍"]) expect(isChatter(t)).toBe(true);
    expect(isChatter("ok, move it to Friday")).toBe(false);
  });

  test("contentTerms drops stopwords and possessives", () => {
    expect(contentTerms("What's Dana's flight to Berlin?")).toEqual(["dana", "flight", "berlin"]);
  });

  test("situations are coarse labels", () => {
    expect(classifySituation("can we meet tomorrow at 3")).toBe("scheduling");
    expect(classifySituation("reply to her email")).toBe("communication");
    expect(classifySituation("hmm")).toBe("general");
  });
});

describe("Bm25Index", () => {
  test("ranks the matching document first and normalizes scores", () => {
    const idx = new Bm25Index();
    idx.add("a", "Acme renewal: three year term, 12% discount");
    idx.add("b", "Team offsite in Lisbon");
    idx.add("c", "Acme support ticket about SSO");
    const hits = idx.search("acme renewal discount", 3);
    expect(hits[0]!.id).toBe("a");
    expect(hits[0]!.coverage).toBeGreaterThan(hits[1]!.coverage);
    idx.remove("a");
    expect(idx.search("renewal", 3)).toEqual([]);
  });
});
