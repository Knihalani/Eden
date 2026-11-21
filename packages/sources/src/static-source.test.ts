/** StaticSource's index (D175) against the algorithm it replaced, kept here unchanged as the oracle. */
import { describe, expect, test } from "bun:test";
import { Xoshiro128 } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import type { SearchQuery } from "./source";
import { StaticSource, type StaticDoc } from "./static-source";

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}]*(?:[._-]+[\p{L}\p{N}]+)*/gu) ?? [];

/** StaticSource.search before D175: every document re-tokenized on every call. */
function oracleSearch(items: ContextItem[], query: SearchQuery): ContextItem[] {
  const terms = new Set([...words(query.text), ...query.entities.flatMap(words)]);
  const w = query.window;
  const inWindow = (item: ContextItem) => {
    const day = item.meta?.start?.slice(0, 10);
    return !!w && !!day && day >= w.start && day < w.end;
  };
  if (terms.size === 0 && !w) return [];
  return items
    .map((item) => {
      const hay = new Set(words(`${item.title} ${item.text}`));
      let hits = 0;
      for (const t of terms) if (hay.has(t)) hits++;
      return { item, hits, dated: inWindow(item) };
    })
    .filter((x) => x.hits > 0 || x.dated)
    .sort((a, b) => Number(b.dated) - Number(a.dated) || b.hits - a.hits)
    .slice(0, query.limit)
    .map((x) => x.item);
}

// Case variants, accents (not folded here), joiners, digits, a lone surrogate, CJK, punctuation-only noise.
const VOCAB = [
  ..."renewal acme invoice dana priya globex offsite budget contract pricing hotel flight agenda".split(" "),
  ..."Renewal ACME Zoë zoe ZOË Müller muller ÉCOLE école 東京 naïve OPS-142 ops-142 v2.1 a_b.c x-y 2026 007".split(" "),
  "\ud800",
  "lone\udc00tail",
  "--",
  "...",
  "İstanbul",
  "ǅemal",
];
const DAYS = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04T09:00:00Z", "2026-11-05", ""];

function pick(r: Xoshiro128, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(VOCAB[r.below(VOCAB.length)]!);
  return out.join(r.below(3) === 0 ? ", " : " ");
}

function genDocs(r: Xoshiro128, n: number): StaticDoc[] {
  const docs: StaticDoc[] = [];
  for (let i = 0; i < n; i++) {
    const doc: StaticDoc = { ref: `r${r.below(n)}`, title: pick(r, r.below(4)), text: pick(r, r.below(30)) };
    if (r.below(4) === 0) doc.meta = { start: DAYS[r.below(DAYS.length)]! };
    else if (r.below(8) === 0) doc.meta = { category: "inbox" };
    docs.push(doc);
  }
  return docs;
}

function genQuery(r: Xoshiro128): SearchQuery {
  const q: SearchQuery = {
    scope: { tenantId: "t", userId: "u" },
    text: pick(r, r.below(6)),
    entities: r.below(2) === 0 ? [pick(r, 1 + r.below(2))] : [],
    limit: [0, 1, 3, 10, 64, 1000][r.below(6)]!,
  };
  if (r.below(3) === 0) {
    const a = DAYS[r.below(4)]!.slice(0, 10);
    q.window = { start: a, end: DAYS[r.below(5)]!.slice(0, 10) };
  }
  return q;
}

const refs = (xs: ContextItem[]) => xs.map((x) => x.ref + "|" + x.id);

describe("StaticSource index (D175)", () => {
  test("returns the same items in the same order as the old search over random queries", async () => {
    const r = new Xoshiro128(175);
    let compared = 0;
    let nonEmpty = 0;
    for (const n of [0, 1, 7, 60, 300]) {
      const docs = genDocs(r, n);
      const source = new StaticSource("docs", "generated", docs);
      const items = docs.map((d) => ({ ...d, id: `docs:${d.ref}`, sourceId: "docs" }));
      for (let q = 0; q < 120; q++) {
        const query = genQuery(r);
        const got = await source.search(query);
        const want = oracleSearch(items, query);
        expect(refs(got)).toEqual(refs(want));
        // Same documents, so the same objects come back as before for every hit.
        for (let i = 0; i < got.length; i++) expect(got[i]).toEqual(want[i]!);
        compared++;
        if (want.length > 0) nonEmpty++;
      }
    }
    expect(compared).toBe(600);
    // The generator has to exercise matches, not just agree on empty results.
    expect(nonEmpty).toBeGreaterThan(300);
  });

  test("ties keep document order, repeated terms count once, and a window lists dated documents first", async () => {
    const s = new StaticSource("cal", "calendar", [
      { ref: "a", title: "budget", text: "budget budget budget" },
      { ref: "b", title: "Budget review", text: "agenda" },
      { ref: "c", title: "standup", text: "nothing shared", meta: { start: "2026-11-03T09:00:00Z" } },
      { ref: "d", title: "budget", text: "agenda", meta: { start: "2026-12-01" } },
      { ref: "e", title: "budget", text: "x" },
    ]);
    const q = { scope: { tenantId: "t", userId: "u" }, entities: [], limit: 10 };
    expect((await s.search({ ...q, text: "budget agenda" })).map((i) => i.ref)).toEqual(["b", "d", "a", "e"]);
    const win = { start: "2026-11-03", end: "2026-11-04" };
    expect((await s.search({ ...q, text: "budget agenda", window: win })).map((i) => i.ref)).toEqual([
      "c",
      "b",
      "d",
      "a",
      "e",
    ]);
    expect((await s.search({ ...q, text: "", window: win })).map((i) => i.ref)).toEqual(["c"]);
    expect(await s.search({ ...q, text: " -- " })).toEqual([]);
    // The per-search scratch is cleared: the same query twice gives the same answer.
    expect((await s.search({ ...q, text: "budget agenda" })).map((i) => i.ref)).toEqual(["b", "d", "a", "e"]);
  });

  test("a term ending a sentence is the bare word: trailing joiners are not part of it (D2059)", async () => {
    const s = new StaticSource("mail", "mail", [
      { ref: "a", title: "note", text: "See the booking." },
      { ref: "b", title: "v2.1 spec", text: "Ops-142 applies." },
    ]);
    const q = { scope: { tenantId: "t", userId: "u" }, entities: [], limit: 10 };
    // "booking." at a sentence's end answers "booking"; a trailing joiner is not the term.
    expect((await s.search({ ...q, text: "booking" })).map((i) => i.ref)).toEqual(["a"]);
    // What a joiner joins stays whole.
    expect((await s.search({ ...q, text: "v2.1 ops-142" })).map((i) => i.ref)).toEqual(["b"]);
    // A query written with the mark on it still finds the bare term.
    expect((await s.search({ ...q, text: "booking." })).map((i) => i.ref)).toEqual(["a"]);
  });

  test("construction tokenizes nothing; the first search builds the index once and later searches reuse it", async () => {
    const marker = "zqxmarker";
    const docs = Array.from({ length: 50 }, (_, i) => ({ ref: `r${i}`, title: `t${i}`, text: `${marker} doc ${i}` }));
    const real = String.prototype.match;
    let calls = 0;
    // Counts tokenizations of a document's text (the query never contains the marker).
    String.prototype.match = function (this: string, re: unknown) {
      if (typeof this === "string" && this.includes(marker)) calls++;
      return real.call(this, re as RegExp);
    } as typeof String.prototype.match;
    try {
      const s = new StaticSource("docs", "generated", docs);
      expect(calls).toBe(0);
      await s.search({ scope: { tenantId: "t", userId: "u" }, text: "doc", entities: [], limit: 5 });
      expect(calls).toBe(50);
      await s.search({ scope: { tenantId: "t", userId: "u" }, text: "doc 3", entities: [], limit: 5 });
      await s.fetch("r1");
      expect(calls).toBe(50);
    } finally {
      String.prototype.match = real;
    }
  });

  test("fetch finds a ref, the first of duplicates, and reports a missing one as null", async () => {
    const s = new StaticSource("docs", "d", [
      { ref: "a", title: "first", text: "one" },
      { ref: "b", title: "b", text: "two" },
      { ref: "a", title: "second", text: "three" },
    ]);
    expect((await s.fetch("a"))?.title).toBe("first");
    expect((await s.fetch("b"))?.id).toBe("docs:b");
    expect(await s.fetch("missing")).toBeNull();
    expect(await s.fetch("__proto__")).toBeNull();
    expect(await new StaticSource("e", "empty", []).fetch("a")).toBeNull();
  });

  test("instances share no state: two sources over different docs answer independently", async () => {
    const a = new StaticSource("docs", "user a", [{ ref: "x", title: "renewal", text: "acme" }]);
    const b = new StaticSource("docs", "user b", [{ ref: "y", title: "renewal", text: "globex" }]);
    const q = { scope: { tenantId: "t", userId: "u" }, text: "renewal acme globex", entities: [], limit: 5 };
    expect((await a.search(q)).map((i) => i.ref)).toEqual(["x"]);
    expect((await b.search(q)).map((i) => i.ref)).toEqual(["y"]);
    expect(await a.fetch("y")).toBeNull();
  });
});
