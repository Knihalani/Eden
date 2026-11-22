import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { aliasExpand, anchorsOf, namesEntity, settles } from "./settle";

// D2009: a per-user alias table, built at ingest from the items' parties (no model). A request naming a person by
// full name anchors to items naming them by surname, and one naming them by surname anchors to items listing the
// person as a participant.

/** Tuesday 27 October 2026, 09:00 UTC. */
const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const SCOPE = { tenantId: "t", userId: "u1" };

const item = (id: string, title: string, text: string, ageH = 24, people?: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
  ...(people ? { meta: { people } } : {}),
});

const table = (names: string[]): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  for (const full of names) {
    const lower = full.toLowerCase();
    for (const w of lower.match(/\p{L}+/gu) ?? []) {
      let set = out.get(w);
      if (!set) out.set(w, (set = new Set()));
      set.add(lower);
    }
  }
  return out;
};

describe("aliasExpand (D2009): name forms the user's alias table knows", () => {
  const aliases = table(["Marcus Webb", "Sara Webb", "Anish Patel"]);

  test("a full name gains its surname part, so a surname-only item anchors it", () => {
    const webbOnly = item("w", "Contract renewal", "The Webb contract needs a countersign.");
    const bare = anchorsOf(["Marcus Webb"], null, "the Marcus Webb contract", 0);
    expect(namesEntity(webbOnly, bare)).toBe(false);
    const grown = anchorsOf(aliasExpand(aliases, ["Marcus Webb"]), null, "the Marcus Webb contract", 0);
    expect(grown.entities).toContain("webb");
    expect(namesEntity(webbOnly, grown)).toBe(true);
    expect(settles([webbOnly], grown)).toBe(true);
  });

  test("a lone part gains each full name holding it, so a participant-only item anchors it", () => {
    const listed = item("l", "Stand-up", "Minutes attached.", 1, "Marcus Webb <m.webb@webb.example>");
    const bare = anchorsOf(["webb"], null, "the webb stand-up", 0);
    expect(namesEntity(listed, bare)).toBe(false);
    const grown = anchorsOf(aliasExpand(aliases, ["webb"]), null, "the webb stand-up", 0);
    expect(grown.entities).toContain("marcus webb");
    expect(grown.entities).toContain("sara webb");
    expect(namesEntity(listed, grown)).toBe(true);
  });

  test("a non-person entity gains nothing; originals stay first and are not duplicated", () => {
    expect(aliasExpand(aliases, ["plan sl-0381442"])).toEqual(["plan sl-0381442"]);
    expect(aliasExpand(aliases, ["Marcus Webb", "webb"])).toEqual(["Marcus Webb", "webb", "sara webb"]);
    expect(aliasExpand(new Map(), ["Marcus Webb"])).toEqual(["Marcus Webb"]);
  });

  test("expansion is capped", () => {
    const many = table(["Webb A", "Webb B", "Webb C", "Webb D", "Webb E", "Webb F", "Webb G", "Webb H", "Webb I"]);
    const grown = aliasExpand(many, ["webb"], 3);
    expect(grown.length).toBe(1 + 3);
  });

  test("two requested people sharing a surname do not collapse into it", () => {
    // "webb" here would anchor both people's records to one entity and `staleSibling` would drop the older.
    expect(aliasExpand(aliases, ["Marcus Webb", "Sara Webb"])).toEqual(["Marcus Webb", "Sara Webb"]);
  });

  test("an identifier's letters are not expanded into people", () => {
    const lee = table(["Marcus Lee"]);
    expect(aliasExpand(lee, ["LEE-123"])).toEqual(["LEE-123"]);
  });
});

describe("ItemCache.aliasTable (D2009): the per-user table, kept as items come and go", () => {
  test("a party's name parts map to their full names", () => {
    const cache = new ItemCache();
    cache.put(SCOPE, [item("s1", "Notes", "Minutes.", 1, "Marcus Webb <m.webb@webb.example>; Anish Patel")]);
    const t = cache.aliasTable(SCOPE);
    expect(t.get("webb")).toEqual(new Set(["marcus webb"]));
    expect(t.get("marcus")).toEqual(new Set(["marcus webb"]));
    expect(t.get("patel")).toEqual(new Set(["anish patel"]));
    expect(t.get("nope")).toBeUndefined();
    // A scope with no items: an empty table, not a thrown user.
    expect(cache.aliasTable({ tenantId: "t", userId: "u2" }).size).toBe(0);
  });

  test("the table follows the tally when the naming item goes", () => {
    const cache = new ItemCache();
    const seed = item("s1", "Notes", "Minutes.", 1, "Marcus Webb");
    cache.put(SCOPE, [seed]);
    expect(cache.aliasTable(SCOPE).get("webb")).toEqual(new Set(["marcus webb"]));
    cache.put(SCOPE, [{ ...seed, meta: {} }]);
    expect(cache.aliasTable(SCOPE).get("webb")).toBeUndefined();
  });

  test("a multi-word party's contraction joins it (D2094)", () => {
    const cache = new ItemCache();
    cache.put(SCOPE, [
      item("s1", "Notice", "Card update.", 1, "American Express <notifications@americanexpress.example>"),
      item("s2", "Notes", "Minutes.", 1, "Amenity Express; HM Passport Office"),
    ]);
    const t = cache.aliasTable(SCOPE);
    // Two-letter heads of a two-word name; two names sharing a contraction both expand it.
    expect(t.get("amex")).toEqual(new Set(["american express", "amenity express"]));
    // A three-word name's initials join too — "HM Passport Office" answering to "HPO" (D2095).
    expect(t.get("hpo")).toEqual(new Set(["hm passport office"]));
    // A lone part is unchanged.
    expect(t.get("american")).toEqual(new Set(["american express"]));
  });

  test("a contraction spelling a real part keeps the part's meaning", () => {
    const cache = new ItemCache();
    cache.put(SCOPE, [item("s1", "Notes", "x", 1, "Ana Saco; Sam Conner")]);
    // "sam conner" contracts to "saco", which is already Ana Saco's surname — the part wins.
    expect(cache.aliasTable(SCOPE).get("saco")).toEqual(new Set(["ana saco"]));
  });
});

describe("partner wiring (D2009): requests anchor through the table", () => {
  let ITEMS: ContextItem[] = [];
  let CACHE = new ItemCache();
  function setup(config: Record<string, unknown>, onPushPool?: (r: PushPoolReport) => void) {
    CACHE = new ItemCache();
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
    return new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache: CACHE,
      budget: new Budget(),
      model: null,
      now: () => NOW,
      config: {
        ...CORE_CONFIG,
        askReader: true,
        readerPush: true,
        readerGate: true,
        confidentScore: 99,
        fallbackMatchedTerms: 99,
        askNudge: true,
        pushCandidates: 1,
        ...config,
      },
      ...(onPushPool ? { onPushPool } : {}),
    });
  }
  const ref = () => ({ ...SCOPE, sessionId: "s1" });
  const say = (p: ContextPartner, text: string) =>
    p.observe({ ...ref(), at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });

  test("an item naming the person by surname settles the full-name request", async () => {
    const pools: PushPoolReport[] = [];
    ITEMS = [
      // The freshest item names only the surname: without the table it does not anchor "Marcus Webb".
      item("webb", "Contract renewal", "Payments to Webb are on hold until the contract countersigns.", 1),
      // An older item lists the person: it builds the table and stays past the single candidate seat.
      item("seed", "Project notes", "Notes on the venue deposit work.", 400, "Marcus Webb <m.webb@webb.example>"),
    ];
    const p = setup({}, (r) => pools.push(r));
    await say(p, "Sign the Marcus Webb contract.");
    expect(pools.at(-1)!.unsettled).toBe(false);
  });

  test("a name nobody's items know is not expanded (no false settle)", async () => {
    const pools: PushPoolReport[] = [];
    // Same items as the positive test; the request names someone the table does not join to Webb.
    ITEMS = [
      item("webb", "Contract renewal", "Payments to Webb are on hold until the contract countersigns.", 1),
      item("seed", "Project notes", "Notes on the venue deposit work.", 400, "Marcus Webb <m.webb@webb.example>"),
    ];
    const p = setup({}, (r) => pools.push(r));
    // The table joins "webb" to "marcus webb" only, so "Sara Webb" gains no alias and the item stays unsettled.
    await say(p, "Sign the Sara Webb contract.");
    expect(pools.at(-1)!.unsettled).toBe(true);
  });

  test("a request naming a party by contraction settles it (D2094)", async () => {
    const pools: PushPoolReport[] = [];
    ITEMS = [
      item(
        "amex",
        "Card security",
        "Your American Express card ending 7731 was cancelled after a reported security issue; payments on it will be declined.",
        1,
        "American Express <notifications@americanexpress.example>",
      ),
      item("seed", "Project notes", "Notes on the venue deposit work.", 400),
    ];
    const p = setup({}, (r) => pools.push(r));
    await say(p, "Put the kitchen fitter's deposit on the Amex.");
    const r = pools.at(-1)!;
    // The item shares no term with the request as written — "Amex" only means the mail's "American Express"
    // through the table — so without D2094's expansion it never reaches the pool at all.
    expect(r.pool).toContain("mail:amex");
    expect(r.handed).toContain("mail:amex");
    expect(r.unsettled).toBe(false);
  });

  test("routing and rarity read the request's expanded entities too (D2096)", async () => {
    ITEMS = [
      item(
        "amex",
        "Card security",
        "Your American Express card ending 7731 was cancelled.",
        1,
        "American Express <notifications@americanexpress.example>",
      ),
    ];
    const p = setup({});
    CACHE.put(SCOPE, ITEMS);
    await say(p, "Notes for the day.");
    const s = (p as never as { sessions: Map<string, object> }).sessions.get("t/u1#s1")!;
    const cue = {
      text: "pay amex",
      entities: ["Amex"],
      key: "",
      id: "cue:t",
      time: null,
      at: NOW,
      raw: "Pay Amex.",
      offset: 0,
    };
    // "amex" is the mail's "american express" only through the table: without expansion the local index finds
    // nothing of the request in the mail source, and neither expanded word counts rare.
    const hits = (
      p as never as { localRouteHits: (a: object, b: object) => Map<string, number> | undefined }
    ).localRouteHits(s, cue);
    expect(hits?.get("mail")).toBeGreaterThan(0);
    const rare = (p as never as { rareTerms: (a: object, b: object) => number[] }).rareTerms(s, cue);
    const vocab = CACHE.peekVocab(SCOPE)!;
    expect(rare.map((id) => vocab.term(id))).toContain("american");
  });
});
