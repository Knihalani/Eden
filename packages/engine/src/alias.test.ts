import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { aliasTerms } from "./alias";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

describe("aliasTerms (P3, D833)", () => {
  test("a day-and-month date also says its weekday and month in full and its day unpadded", () => {
    expect(aliasTerms("Your flight on Sun 08 Nov has been retimed.").split(" ").sort()).toEqual(
      ["8", "november", "sunday"].sort(),
    );
    expect(aliasTerms("festive do sorted: Thu 10 Dec, 7pm")).toBe("thursday december");
    expect(aliasTerms("Window: Sat 31 Oct 2026, 00:00")).toBe("saturday october");
  });

  test("words that only look like a month or weekday are not dates", () => {
    expect(aliasTerms("We decided 3 times and I sat 3 hours.")).toBe("");
    expect(aliasTerms("on 3 Decks")).toBe("");
  });

  test("a full first name gives its nicknames; an unambiguous nickname gives its full names", () => {
    expect(aliasTerms("[05:00] Alexander Novak: can we swap?")).toBe("alex sasha");
    expect(aliasTerms("Thanks, Becky")).toBe("rebecca");
    // A nickname that is also a word, or the word itself, gives nothing.
    expect(aliasTerms("Will you send it? will do")).toBe("");
  });

  test("a form the text already writes is not added twice", () => {
    expect(aliasTerms("Thursday 10 December, Thu 10 Dec")).toBe("");
  });

  test("with the switch on, an item holding only the other form is found by the request's form", () => {
    const scope = { tenantId: "t", userId: "u" };
    const make = (aliasTermsOn: boolean) => {
      const cache = new ItemCache();
      new ContextPartner({
        sources: async () => [],
        sourceMap: new SourceMap(":memory:", { seed: 1 }),
        cache,
        budget: new Budget(),
        model: null,
        config: { ...CORE_CONFIG, aliasTerms: aliasTermsOn },
      });
      cache.put(scope, [
        { id: "m1", sourceId: "mail", ref: "m1", title: "Rota", text: "Alexander Novak primary from Thu 10 Dec" },
      ]);
      return cache;
    };
    const find = (cache: ItemCache, words: string[]) => {
      const vocab = cache.peekVocab(scope)!;
      const ids = words.map((w) => vocab.lookup(w)).filter((i) => i >= 0);
      return ids.length === words.length ? cache.search(scope, ids, ids.length, 5).map((h) => h.item.id) : [];
    };
    expect(find(make(false), ["alex", "december"])).toEqual([]);
    expect(find(make(true), ["alex", "december"])).toEqual(["m1"]);
  });
});
