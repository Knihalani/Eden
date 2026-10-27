import { describe, expect, test } from "bun:test";
import { decodePack, decodePostIndex, encodePack, encodePostIndex, POST_PERSIST_MIN } from "./pack";
import { noisyPostTerm } from "./tokens";
import { needleLane } from "./needles";
import { remoteKnowSearch, shardForLane, shardForQuery } from "./route";
import { injectFromText } from "./inject";
import { knowQuery } from "./query";

const leftover = {
  s: "Acme Widgets",
  p: "is",
  o: "a leftover intern firm",
  e: "",
  url: "https://example.org/acme",
};
const facts = [
  { s: "Kenya", p: "capital", o: "Nairobi", e: "", url: "https://example.org/ke" },
  { s: "IANA media application/json", p: "is", o: "JSON", e: "", url: "https://example.org/json" },
  leftover,
];

describe("scale retrieval", () => {
  test("DF prune keeps catalog identifiers and RFC numbers", () => {
    expect(noisyPostTerm("json", 9_000, 10_000)).toBe(false);
    expect(noisyPostTerm("iana", 9_000, 10_000)).toBe(false);
    expect(noisyPostTerm("3986", 9_000, 10_000)).toBe(false);
    expect(noisyPostTerm("get", 9_000, 10_000)).toBe(false);
    expect(noisyPostTerm("media", 9_000, 10_000)).toBe(true);
    expect(noisyPostTerm("json", 9_000, 100)).toBe(false);
  });

  test("15k-class dumps stay below the posting persist floor", () => {
    expect(POST_PERSIST_MIN).toBeGreaterThan(15_000);
  });

  test("PS01 posting index round-trips without touching encode of the 15k fixture", () => {
    const post = new Map<string, number[]>([
      ["json", [0, 2, 5]],
      ["kenya", [1]],
    ]);
    const buf = encodePostIndex(post, 10);
    expect(decodePostIndex(buf).get("json")).toEqual([0, 2, 5]);
    expect(decodePostIndex(buf).get("kenya")).toEqual([1]);
    const small = encodePack(facts);
    expect(decodePack(small).post.size).toBe(0);
  });

  test("typed locate miss does not synth the inverted index", () => {
    const p = decodePack(encodePack(facts));
    expect(p.search("Kenya")[0]?.o).toBe("Nairobi");
    expect(p.post.size).toBe(0);
    expect(p.search("application/json")[0]?.s).toMatch(/application\/json/);
    expect(p.post.size).toBe(0);
    expect(p.search("application/vnd.zzzz-not-listed")).toEqual([]);
    expect(p.post.size).toBe(0);
  });

  test("token search still finds leftover intern rows", () => {
    const p = decodePack(encodePack(facts));
    const hit = p.search("leftover intern firm");
    expect(hit.some((f) => f.s === "Acme Widgets")).toBe(true);
    expect(p.post.size).toBeGreaterThan(0);
    expect(p.post.has("leftover")).toBe(true);
  });

  test("hot lanes stay on the catalog shard; prose is cold", () => {
    expect(needleLane("RFC 3986")).toBe("rfc");
    expect(needleLane("application/json")).toBe("media");
    expect(needleLane("capital of Kenya")).toBe("capital");
    expect(needleLane("GET")).toBe("method");
    expect(needleLane("leftover intern firm")).toBe("token");
    expect(shardForLane("media")).toBe("hot");
    expect(shardForQuery("leftover intern firm")).toBe("cold");
  });

  test("remote index returns hits and fail-opens; cards format locally", () => {
    const ok = remoteKnowSearch("https://know.example/query", () => ({
      hits: [{ s: leftover.s, p: leftover.p, o: leftover.o, e: leftover.e }],
    }));
    const card = knowQuery("Acme Widgets", ok);
    expect("fact" in card && card.fact).toMatch(/Acme Widgets/);
    const down = remoteKnowSearch("https://know.example/query", () => {
      throw new Error("timeout");
    });
    expect(down.search("Acme Widgets")).toEqual([]);
    const junk = remoteKnowSearch("https://know.example/query", () => ({ fact: "hallucinated card" }));
    expect(junk.search("Acme Widgets")).toEqual([]);
  });

  test("inject does not open the pack for token-lane prose", () => {
    let n = 0;
    const store = {
      search() {
        n++;
        return [leftover];
      },
    };
    expect(injectFromText("Please refactor the leftover intern firm and ship the crate.", store)).toBeUndefined();
    expect(n).toBe(0);
    expect(injectFromText("Send application/json please.", store)).toBeUndefined();
    expect(n).toBe(0);
  });
});
