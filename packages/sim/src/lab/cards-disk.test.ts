import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CARD_FORM_REQUESTS, cardKey, type Card, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { REALISTIC, simSources } from "../sources";
import { buildWorld, type World } from "../world";
import {
  DiskCardMaker,
  harnessCoverage,
  harnessIntent,
  INTENT_PATH,
  intentCoverage,
  intentLine,
  loadCards,
  loadRequests,
  samePath,
  SHIPPED_PATH,
  shippedUncovered,
} from "./cards-disk";
import { clearSlot, dress } from "./hidden-context";
import { INTENT_INERT } from "./reader-stub";
import { SUITES } from "./suites";

const item = (n: number): ContextItem => ({
  id: `i${n}`,
  sourceId: "gmail",
  ref: `r${n}`,
  title: `t${n}`,
  text: `x${n}`,
});
const card = (n: number): Card => ({ kind: "absence", actions: [], entities: [`P${n}`], statement: `s${n}` });

/** A live maker that cards every item it is given and counts what it was asked for. */
const liveMaker = () => {
  const asked: string[] = [];
  const maker: CardMaker = {
    async make(items) {
      asked.push(...items.map((i) => i.id));
      return { cards: items.map((i) => card(Number(i.id.slice(1)))), costUsd: 0.001 * items.length };
    },
  };
  return { maker, asked };
};

const signal = new AbortController().signal;
/** A batch's requests (present only when the call asked for them). */
const reqs = (got: Awaited<ReturnType<CardMaker["make"]>>) => ("requests" in got ? got.requests : undefined);

describe("DiskCardMaker", () => {
  test("a replay with an output file never writes the replay file (a run cannot mutate its own input)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    writeFileSync(replay, `${JSON.stringify({ h: cardKey(item(1)), c: card(1) })}\n`);
    const before = readFileSync(replay, "utf8");
    const out = join(dir, "new.jsonl");
    const { maker, asked } = liveMaker();
    const disk = new DiskCardMaker(replay, maker, { out });
    const got = await disk.make([item(1), item(2)], "2026-10-31", signal);
    expect(got.cards.map((c) => c?.statement)).toEqual(["s1", "s2"]);
    expect(asked).toEqual(["i2"]);
    expect(got.costUsd).toBeCloseTo(0.001);
    expect(readFileSync(replay, "utf8")).toBe(before);
    expect([...loadCards(out).keys()]).toEqual([cardKey(item(2))]);
    // A later run with both files replays both, and asks the live maker for nothing.
    const again = liveMaker();
    const next = new DiskCardMaker(replay, again.maker, { out });
    expect((await next.make([item(1), item(2)], "2026-10-31", signal)).cards.map((c) => c?.statement)).toEqual([
      "s1",
      "s2",
    ]);
    expect(again.asked).toEqual([]);
  });

  test("makers sharing one map read the file once and see each other's new cards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    const out = join(dir, "new.jsonl");
    const first = liveMaker();
    const a = new DiskCardMaker(replay, first.maker, { out });
    const second = liveMaker();
    const b = new DiskCardMaker(replay, second.maker, { out, shared: a });
    await a.make([item(3)], "2026-10-31", signal);
    await b.make([item(3)], "2026-10-31", signal);
    expect([first.asked, second.asked]).toEqual([["i3"], []]);
    expect(existsSync(replay)).toBe(false);
  });

  test("with no output file, new cards are appended to the cache itself (cards-enrich builds its file so)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const file = join(dir, "cards.jsonl");
    const { maker } = liveMaker();
    await new DiskCardMaker(file, maker).make([item(4)], "2026-10-31", signal);
    expect([...loadCards(file).keys()]).toEqual([cardKey(item(4))]);
  });

  test("makers sharing one map make a card once when they miss it at the same time (pi-ab's paired arms)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    const out = join(dir, "new.jsonl");
    // A slow live maker, so both streams miss the item before either has its card.
    const asked: string[] = [];
    const slow: CardMaker = {
      async make(items) {
        asked.push(...items.map((i) => i.id));
        await Bun.sleep(5);
        return { cards: items.map((i) => card(Number(i.id.slice(1)))), costUsd: 0.001 * items.length };
      },
    };
    const a = new DiskCardMaker(replay, slow, { out });
    const b = new DiskCardMaker(replay, slow, { out, shared: a });
    const [x, y] = await Promise.all([
      a.make([item(5)], "2026-10-31", signal),
      b.make([item(5), item(6), item(5)], "2026-10-31", signal),
    ]);
    // Asked once per item; the stream that waited on the other's card pays nothing for it, and both get the same card.
    expect(asked.sort()).toEqual(["i5", "i6"]);
    expect(x.cards.map((c) => c?.statement)).toEqual(["s5"]);
    expect(y.cards.map((c) => c?.statement)).toEqual(["s5", "s6", "s5"]);
    expect(x.costUsd + y.costUsd).toBeCloseTo(0.002);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a live maker that fails leaves the waiting streams uncovered, and a later call asks again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    let calls = 0;
    const flaky: CardMaker = {
      async make(items) {
        calls++;
        await Bun.sleep(2);
        if (calls === 1) throw new Error("down");
        return { cards: items.map((i) => card(Number(i.id.slice(1)))), costUsd: 0 };
      },
    };
    const a = new DiskCardMaker(join(dir, "c.jsonl"), flaky);
    const b = new DiskCardMaker(join(dir, "c.jsonl"), flaky, { shared: a });
    const [x, y] = await Promise.allSettled([
      a.make([item(7)], "2026-10-31", signal),
      b.make([item(7)], "2026-10-31", signal),
    ]);
    expect(x.status).toBe("rejected");
    expect(y.status === "fulfilled" && y.value.cards).toEqual([null]);
    expect((await b.make([item(7)], "2026-10-31", signal)).cards.map((c) => c?.statement)).toEqual(["s7"]);
    expect(calls).toBe(2);
  });
});

describe("samePath", () => {
  test("two spellings of one file are the same path, whether or not it exists yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const file = join(dir, "a.cards.jsonl");
    writeFileSync(file, "");
    expect(samePath(file, join(dir, ".", "a.cards.jsonl"))).toBe(true);
    expect(samePath(file, join(dir, "sub", "..", "a.cards.jsonl"))).toBe(true);
    const link = join(dir, "link.jsonl");
    symlinkSync(file, link);
    expect(samePath(link, file)).toBe(true);
    mkdirSync(join(dir, "d"));
    symlinkSync(join(dir, "d"), join(dir, "dl"));
    expect(samePath(join(dir, "d", "new.jsonl"), join(dir, "dl", "new.jsonl"))).toBe(true);
    expect(samePath(file, join(dir, "b.cards.jsonl"))).toBe(false);
    // Relative to the working directory, as the command line gives them.
    expect(samePath("./x.jsonl", "x.jsonl")).toBe(true);
  });

  test("a live miss's requests go to the output file with its card ({h, c, r}) and replay from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    const out = join(dir, "new.jsonl");
    const asked: string[] = [];
    // Cards item 5, gives item 6 requests but no card (the model gave none back), item 7 neither.
    const live: CardMaker = {
      async make(items, _today, _signal, _retry, intent) {
        asked.push(...items.map((i) => i.id));
        return {
          cards: items.map((i) => (i.id === "i5" ? card(5) : null)),
          costUsd: 0,
          ...(intent
            ? { requests: items.map((i) => (i.id === "i7" ? null : [`ask about ${i.id}`, "ünïcode ✓"])) }
            : {}),
        };
      },
    };
    const first = await new DiskCardMaker(replay, live, { out }).make(
      [item(5), item(6), item(7)],
      "d",
      signal,
      false,
      true,
    );
    expect(reqs(first)).toEqual([["ask about i5", "ünïcode ✓"], ["ask about i6", "ünïcode ✓"], null]);
    const lines = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { h: cardKey(item(5)), c: card(5), r: ["ask about i5", "ünïcode ✓"] },
      { h: cardKey(item(6)), r: ["ask about i6", "ünïcode ✓"] },
    ]);
    // The requests-only line is no card: item 6 stays uncovered for the cards.
    expect([...loadCards(out).keys()]).toEqual([cardKey(item(5))]);
    // A later run replaying the output file gets the requests back with no live maker at all.
    const replayed = await new DiskCardMaker(replay, undefined, { out }).make(
      [item(5), item(6), item(7)],
      "d",
      signal,
      false,
      true,
    );
    expect(reqs(replayed)).toEqual(reqs(first));
    // Item 6 has requests and no card: covered with a none card, as a requests file's item is.
    expect(replayed.cards.map((c) => c?.kind ?? null)).toEqual(["absence", "none", null]);
    expect(asked).toEqual(["i5", "i6", "i7"]);
  });

  test("an item read for requests only, its requests replayed, is not sent live (its card would be thrown away)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const reqFile = join(dir, "intent.jsonl");
    const plain: ContextItem = { id: "p", sourceId: "gmail", ref: "p", title: "Lunch", text: "Lunch on Friday?" };
    const worded: ContextItem = {
      id: "w",
      sourceId: "gmail",
      ref: "w",
      title: "Policy",
      text: "Invoices must be approved by Dana before payment.",
    };
    const fresh: ContextItem = { id: "f", sourceId: "gmail", ref: "f", title: "Notes", text: "Notes from the call." };
    writeFileSync(
      reqFile,
      [plain, worded].map((it) => JSON.stringify({ h: cardKey(it), r: [`about ${it.id}`] })).join("\n") + "\n",
    );
    const { maker, asked } = liveMaker();
    const disk = new DiskCardMaker(join(dir, "cards.jsonl"), maker, {
      out: join(dir, "out.jsonl"),
      requests: [reqFile],
    });
    const got = await disk.make([plain, worded, fresh], "d", signal, false, true);
    // The plain item has replayed requests and no constraint wording: covered with no call. The worded one may get a
    // card; the third has no replayed requests: both live.
    expect(asked).toEqual(["w", "f"]);
    expect(disk.skipped).toBe(1);
    expect(got.cards[0]?.kind).toBe("none");
    expect(reqs(got)).toEqual([["about p"], ["about w"], null]);
    // Without intent nothing is skipped: the card itself is what the call is for.
    const { maker: m2, asked: a2 } = liveMaker();
    await new DiskCardMaker(join(dir, "c2.jsonl"), m2, { out: join(dir, "o2.jsonl"), requests: [reqFile] }).make(
      [plain],
      "d",
      signal,
      false,
      false,
    );
    expect(a2).toEqual(["p"]);
  });

  test("an explicit requests file wins over requests in the card files, and a .gz one is read as is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    writeFileSync(replay, `${JSON.stringify({ h: cardKey(item(8)), c: null, r: ["from cards"] })}\n`);
    const gz = join(dir, "intent.jsonl.gz");
    writeFileSync(gz, gzipSync(`${JSON.stringify({ h: cardKey(item(8)), r: ["from intent"], c: null })}\n`));
    expect(loadRequests(gz).get(cardKey(item(8)))).toEqual(["from intent"]);
    const disk = new DiskCardMaker(replay, undefined, { out: join(dir, "new.jsonl"), requests: [gz] });
    expect(reqs(await disk.make([item(8)], "d", signal, false, true))).toEqual([["from intent"]]);
    const plain = new DiskCardMaker(replay, undefined, { out: join(dir, "new2.jsonl") });
    expect(reqs(await plain.make([item(8)], "d", signal, false, true))).toEqual([["from cards"]]);
  });
});

describe("opting out of replayed intent (cardRequests: false)", () => {
  test("a card file's `r` line with --intent none replays no requests, and the header says inert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cards-"));
    const replay = join(dir, "cards.jsonl");
    const out = join(dir, "earlier-run.cards.jsonl");
    writeFileSync(replay, `${JSON.stringify({ h: cardKey(item(9)), c: card(9), r: ["from cards"] })}\n`);
    // An earlier run's --cards-out, appended to by a live call: a card with requests and a requests-only line.
    writeFileSync(
      out,
      `${JSON.stringify({ h: cardKey(item(10)), c: card(10), r: ["from out"] })}\n` +
        `${JSON.stringify({ h: cardKey(item(11)), r: ["requests only"] })}\n`,
    );
    const run = { wanted: true, cardsReplayed: true, suites: ["heldout13"], seeds: [41] };
    const none = harnessIntent("none", run);
    const disk = new DiskCardMaker(replay, undefined, {
      out,
      requests: none.files,
      cardRequests: none.files.length > 0,
    });
    expect(disk.requests.size).toBe(0);
    const got = await disk.make([item(9), item(10), item(11)], "d", signal, false, true);
    expect(reqs(got)).toEqual([null, null, null]);
    // The cards still replay; the requests-only item stays uncovered.
    expect(got.cards.map((c) => c?.kind ?? null)).toEqual(["absence", "absence", null]);
    const count = intentCoverage([[item(9), item(10), item(11)]], disk.requests);
    expect(intentLine({ wanted: true, cardsReplayed: true, ...none, ...count })).toBe(
      `intent: replayed 0 of 3 items (--intent none)  ${INTENT_INERT}`,
    );
    // An uncovered default opts out the same way.
    const uncovered = harnessIntent("default", { ...run, seeds: [45] });
    expect(uncovered.files).toEqual([]);
    const disk2 = new DiskCardMaker(replay, undefined, { out, requests: [], cardRequests: false });
    expect(reqs(await disk2.make([item(9), item(10)], "d", signal, false, true))).toEqual([null, null]);
    // Without the opt-out the same files replay their `r` lines (the round trip a covered run relies on).
    const on = new DiskCardMaker(replay, undefined, { out });
    expect(reqs(await on.make([item(9), item(10), item(11)], "d", signal, false, true))).toEqual([
      ["from cards"],
      ["from out"],
      ["requests only"],
    ]);
  });
});

describe("the harnesses' intent replay (D158)", () => {
  const run = { wanted: true, cardsReplayed: true, suites: ["heldout13"], seeds: [41, 42, 43, 44] };

  test("default replays the checked-in file only where it covers every suite and seed", () => {
    expect(harnessIntent("default", run)).toEqual({
      files: [INTENT_PATH],
      note: "intent-v2.jsonl.gz by default, D158; coverage full: every item, D714",
    });
    expect(harnessIntent("default", { ...run, suites: ["train1", "heldout10"], seeds: ["41", "42"] }).files).toEqual([
      INTENT_PATH,
    ]);
    const out = harnessIntent("default", { ...run, suites: ["heldout13", "heldout12"], seeds: [41, 45] });
    expect(out.files).toEqual([]);
    expect(out.note).toContain("heldout13 seed 45");
    expect(out.note).toContain("heldout12 seed 41");
    expect(harnessIntent("none", run)).toEqual({ files: [], note: "--intent none" });
    expect(harnessIntent("a.jsonl,b.jsonl", run).files).toEqual(["a.jsonl", "b.jsonl"]);
    // Intent off, or cards made live (the card model writes the requests): nothing to replay.
    expect(harnessIntent("default", { ...run, wanted: false }).files).toEqual([]);
    expect(harnessIntent("default", { ...run, cardsReplayed: false }).files).toEqual([]);
  });

  test("the header labels a run with no covering file inert", () => {
    const base = { wanted: true, cardsReplayed: true, note: "x", found: 3, of: 4 };
    expect(intentLine({ ...base, files: ["f"] })).toBe("intent: replayed 3 of 4 items (x)");
    // Inert is what the replay holds: nothing found is inert, whatever was named.
    expect(intentLine({ ...base, files: [], note: "--intent none", found: 0 })).toBe(
      `intent: replayed 0 of 4 items (--intent none)  ${INTENT_INERT}`,
    );
    expect(intentLine({ ...base, files: ["f"], found: 0 })).toBe(`intent: replayed 0 of 4 items (x)  ${INTENT_INERT}`);
    // Requests from the card files alone (no requests file) are a partial replay, never labelled inert.
    expect(intentLine({ ...base, files: [], note: "" })).toBe(
      "intent: replayed 3 of 4 items (no --intent)  [intent partial: from the card files only]",
    );
    expect(intentLine({ ...base, files: [], wanted: false })).toBe("intent: off");
  });

  // Own timeout: four worlds built and listed take about 5 s under `bun run check`'s parallel run, past bun's default
  // 5 s (one of three timed checks failed on it, 5,410 ms; RealUse-1 part E).
  test("the checked-in file covers held-out 13 to 18 items (the shards INTENT_COVERS claims)", () => {
    const requests = loadRequests(INTENT_PATH);
    // One base world per seed, shared by its twelve suite-variant worlds (D819): each gets its own lists and maps
    // over the same item objects, so the sources' per-item analysis (memoised on the object) is done once a seed, not
    // twelve times. The worlds are the ones a fresh build gives: a suite plants new items and `clearSlot` filters the
    // list, and neither may change a base item, which the fingerprint check after each seed's worlds asserts.
    const fingerprint = (w: World) => JSON.stringify([w.items, [...w.facts], w.arcs, w.people, w.user, w.sources]);
    const bases = new Map([41, 44].map((s) => [s, buildWorld({ seed: s * 1_000 })] as const));
    const printed = new Map([...bases].map(([s, w]) => [s, fingerprint(w)] as const));
    for (const [suite, seed] of [41, 44].flatMap((s) =>
      (["heldout13", "heldout14", "heldout15", "heldout16", "heldout17", "heldout18"] as const).map(
        (x) => [x, s] as const,
      ),
    )) {
      for (const variant of ["hidden", "control"] as const) {
        // As hidden-funnel.ts and ab-common's worldOf build each world, over the seed's shared base items.
        const base = bases.get(seed)!;
        const world: World = {
          ...base,
          people: [...base.people],
          arcs: [...base.arcs],
          facts: new Map(base.facts),
          items: [...base.items],
          sources: { ...base.sources },
        };
        const before = world.items.length;
        const tasks = SUITES[suite]!(world, seed, variant);
        const planted = world.items.slice(before);
        for (const it of planted) dress(world, it);
        const keep = new Set(planted.map((it) => it.id));
        for (const task of tasks) clearSlot(world, task.text, keep);
        const sources = simSources(world, REALISTIC, 0, seed);
        const { found, of } = intentCoverage([sources.flatMap((s) => s.listAll())], requests);
        expect(of).toBeGreaterThan(1000);
        expect(found / of).toBeGreaterThanOrEqual(0.99);
        // Every planted item has a line with requests (the finding: a quarter of planted items had none).
        const mine = intentCoverage([sources.flatMap((s) => s.listAll()).filter((it) => keep.has(it.id))], requests);
        expect(mine.of).toBeGreaterThan(0);
        expect(mine.found).toBe(mine.of);
      }
    }
    for (const [seed, base] of bases) expect(fingerprint(base)).toBe(printed.get(seed)!);
  }, 180_000); // Twenty-four worlds now (held-out 13 to 18), six times the earlier four.
});

// P7 (D872): the shipped-coverage file covers every suite its decisions name, so `--coverage shipped` never refuses
// the end-of-wave heldout19 read, and the checked-in file is there.
describe("shipped coverage (D872)", () => {
  test("covers train, reworded, longtail and heldout19 on seeds 41-44, and nothing else", () => {
    expect(shippedUncovered(["train1", "train6r", "longtail", "heldout19"], [41, 42, 43, 44])).toEqual([]);
    expect(shippedUncovered(["dev20a", "dev20d"], [41, 42, 43, 44], CARD_FORM_REQUESTS)).toEqual([]);
    expect(shippedUncovered(["heldout18"], [41])).toEqual(["heldout18 seed 41"]);
    expect(shippedUncovered(["train1"], [45])).toEqual(["train1 seed 45"]);
    expect(existsSync(SHIPPED_PATH)).toBe(true);
  });
});

// D878: the live harnesses' coverage, resolved as the funnel's (D877).
describe("harnessCoverage (D878)", () => {
  const run = { suites: ["train1"], seeds: [41, 42] };
  test("shipped by default where covered, replayed as cards and intent", () => {
    const c = harnessCoverage({ coverage: "", cards: "", intent: "default", ...run });
    expect(c.coverage).toBe("shipped");
    expect(c.cards).toBe(c.intent);
    expect(existsSync(c.cards)).toBe(true);
  });
  test("an uncovered run keeps its files; own files need --coverage full; a bad value throws", () => {
    const off = harnessCoverage({
      coverage: "",
      cards: "x.jsonl",
      intent: "default",
      suites: ["heldout18"],
      seeds: [41],
    });
    expect([off.coverage, off.cards, off.intent]).toEqual(["full", "x.jsonl", "default"]);
    expect(() => harnessCoverage({ coverage: "", cards: "x.jsonl", intent: "default", ...run })).toThrow(
      /--coverage full/,
    );
    const pinned = harnessCoverage({ coverage: "full", cards: "x.jsonl", intent: "none", ...run });
    expect([pinned.coverage, pinned.cards, pinned.intent]).toEqual(["full", "x.jsonl", "none"]);
    expect(() =>
      harnessCoverage({ coverage: "shipped", cards: "", intent: "default", suites: ["heldout18"], seeds: [41] }),
    ).toThrow(/does not cover/);
    expect(() => harnessCoverage({ coverage: "most", cards: "", intent: "default", ...run })).toThrow(
      /shipped or full/,
    );
  });
});
