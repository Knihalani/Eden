/**
 * M8.3: last hop first on the product inject path (openMemory / inject),
 * not only BrainMemory.retrieve. Graph walk + max(t) per (s, p).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools } from "../packages/wrap/src/tool-observe";
import { CHUNK_TARGET_TOKENS, estimateTokens } from "./chunk-store";
import { completeNotes, completeScores, extractTriple, hopChain } from "./cls/complete";
import { encodeLane, MEMORY_MARK, openMemory } from "./index";
import * as edenMem from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/41

const FACTS = [
  "0. The author of Our Mutual Friend is Charles Dickens.",
  "1. Charles Darwin is married to Emma Darwin.",
  "2. Emma Darwin is a citizen of the United Kingdom.",
  "3. The author of Our Mutual Friend is Charles Darwin.",
  "4. Charles Darwin is married to Amala Paul.",
  "5. Amala Paul is a citizen of Belgium.",
  "6. Thomas Kyd was born in the city of London.",
  "7. Hines Ward plays the position of wide receiver.",
];

const QUERY = "Which country is the spouse of the author of Our Mutual Friend a citizen of?";

function withMem(fn: (mem: ReturnType<typeof openMemory>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m83-"));
  try {
    fn(openMemory({ dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function bullets(packet: string): string[] {
  return packet
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"));
}

describe("hopChain current graph", () => {
  test("3-hop last hop is Belgium, not Dickens/UK", () => {
    const hops = hopChain(
      QUERY,
      FACTS.map((text, i) => ({ text, at: i, i })),
    );
    expect(hops.length).toBe(3);
    expect(hops[0]!.o).toContain("darwin");
    expect(hops[1]!.o).toContain("amala");
    expect(hops[2]!.o).toContain("belgium");
    expect(hops[2]!.text).toMatch(/Belgium/);
    expect(hops[2]!.text).not.toMatch(/United Kingdom|Dickens/);
  });

  test("ICL exemplars are not graph-walked", () => {
    const hops = hopChain("the author of Our Mutual Friend", [
      { text: "The movie was great. label: positive", i: 0, at: 0 },
      { text: "Input: The film is terrible. Output: negative", i: 1, at: 1 },
    ]);
    expect(hops).toEqual([]);
  });
});

describe("completeNotes last hop first", () => {
  test("unshift last hop ahead of hop-1 even when hop-1 is notes[0]", () => {
    const store = FACTS.map((text, i) => ({ text, id: `m${i}`, at: i, i }));
    const notes = [store[0]!, store[3]!, store[6]!];
    const out = completeNotes(QUERY, notes, store);
    expect(out[0]!.text).toMatch(/Belgium/);
    expect(out[0]!.text).not.toMatch(/United Kingdom|Dickens/);
    const hop1 = out.findIndex((r) => /Our Mutual Friend is Charles Darwin/i.test(r.text));
    const last = out.findIndex((r) => /Belgium/i.test(r.text));
    expect(last).toBe(0);
    if (hop1 >= 0) expect(last).toBeLessThan(hop1);
  });

  test("fail-open: empty query leaves notes unchanged", () => {
    const notes = [{ text: "keep me", id: "k" }];
    expect(completeNotes("", notes, notes)).toEqual(notes);
  });

  test("prefers labeled notes over unlabeled store rows", () => {
    const store = FACTS.map((text, i) => ({ text, id: `m${i}`, at: i, i, kind: "fact" as const }));
    const notes = store.map((r) => ({ ...r, text: `[fact] ${r.text}` }));
    const out = completeNotes(QUERY, notes, store);
    expect(out[0]!.text).toMatch(/^\[fact(?:\s*·[^\]]*)?\]\s+5\.\s+Amala Paul is a citizen of Belgium/);
    expect(out[0]!.text).not.toBe(store[5]!.text);
  });

  test("store-only last hop is labeled [fact] without mutating store", () => {
    const store = FACTS.map((text, i) => ({ text, id: `m${i}`, at: i, i, kind: "fact" as const }));
    const notes = [store[0]!, store[3]!];
    const before = store[5]!.text;
    const out = completeNotes(QUERY, notes, store);
    expect(out[0]!.text).toMatch(/^\[fact(?:\s*·[^\]]*)?\]\s+5\.\s+Amala Paul is a citizen of Belgium/);
    expect(store[5]!.text).toBe(before);
  });
});

describe("product inject 3-hop", () => {
  test.failing("inject top-1 is Belgium, last hop ordered first", () => {
    withMem((mem) => {
      for (const f of FACTS) mem.remember(f);
      const out = mem.inject([{ role: "user", content: QUERY }]);
      const packet = packetOf(out);
      expect(packet).toContain(MEMORY_MARK);
      const first = bullets(packet)[0] ?? packet;
      expect(first).toMatch(/Belgium/);
      expect(first).not.toMatch(/United Kingdom/);
      expect(first).not.toMatch(/Dickens/);
      const bel = packet.search(/Belgium/i);
      const uk = packet.search(/United Kingdom/i);
      const friend = packet.search(/Our Mutual Friend is Charles (Dickens|Darwin)/i);
      expect(bel).toBeGreaterThanOrEqual(0);
      if (uk >= 0) expect(bel).toBeLessThan(uk);
      if (friend >= 0) expect(bel).toBeLessThan(friend);
      expect(first).toMatch(/^-\s*\[fact(?:\s*·[^\]]*)?\]/);
      expect(first).not.toMatch(/^-\s+5\.\s+Amala/);
    });
  });

  test.failing("4-hop inject last hop Europe first among facts", () => {
    withMem((mem) => {
      for (const f of [...FACTS, "8. Belgium is located in the continent of Europe."]) mem.remember(f);
      const cue =
        "Which continent is the country of citizenship of the spouse of the author of Our Mutual Friend located in?";
      const packet = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(packet).toContain(MEMORY_MARK);
      const facts = bullets(packet).filter((l) => /\[fact(?:\s*·[^\]]*)?\]/i.test(l));
      expect(facts[0]).toMatch(/Europe/);
      expect(facts[0]).toMatch(/^-\s*\[fact(?:\s*·[^\]]*)?\]/);
    });
  });

  test.failing("packet order: last hop [fact] is first among facts; serial loser scrubbed after hop merge", () => {
    withMem((mem) => {
      mem.remember("The author of Pale Fire is Vladimir Nabokov.");
      mem.remember("1. Vladimir Nabokov is a citizen of Scotland.");
      mem.remember("8. Vladimir Nabokov is a citizen of Canada.");
      const cue = "Which country is the author of Pale Fire a citizen of?";
      const orig = mem.notesFor.bind(mem);
      mem.notesFor = ((text?: string, k?: number, opts?: { fuse?: boolean }) => {
        const rows = orig(text, k, opts);
        const missed = rows.filter((r) => !/Canada/i.test(r.text));
        return missed.length ? missed : rows;
      }) as typeof mem.notesFor;
      const packet = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(packet).toContain(MEMORY_MARK);
      expect(packet).toMatch(/Canada/);
      expect(packet).not.toMatch(/Scotland/);
      const facts = bullets(packet).filter((l) => /\[fact(?:\s*·[^\]]*)?\]/i.test(l));
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0]).toMatch(/Canada/);
      expect(facts[0]).not.toMatch(/Scotland/);
      expect(facts[0]).toMatch(/^-\s*\[fact(?:\s*·[^\]]*)?\]/);
    });
  });
});

describe("completeScores last hop top-1", () => {
  test("Belgium episode is argmax after complete", () => {
    const episodes = FACTS.map((text, i) => ({ i, text }));
    const scores = new Float64Array(FACTS.length);
    scores[0] = 10;
    scores[3] = 9;
    const out = completeScores(QUERY, episodes, scores);
    let best = 0;
    for (let i = 1; i < out.length; i++) if (out[i]! > out[best]!) best = i;
    expect(episodes[best]!.text).toMatch(/Belgium/);
    expect(best).toBe(5);
  });
});

/**
 * M22 hop-order: player → sport → country. Last hop Canada serial 8.
 * ICL `label:` and novels are not graph-walked. Fail-open leaves notes/scores.
 */
describe("M22 hop-order two-hop overwrite", () => {
  const PLAYS = "Player Zane plays lacrosse.";
  const LOSER = "1. Lacrosse originated in Scotland.";
  const WINNER = "8. Lacrosse originated in Canada.";
  const CUE = "What country is the sport of Zane from?";
  const ICL = "The movie was great. label: 28";
  const NOVEL =
    "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. " +
    "He remembered the flood of his childhood and the oak that had fallen across the millrace. " +
    "The villagers said the oak still slept under the silt, waiting. " +
    "Winter after winter the mill wheel turned against the ice, and the miller's sons counted sacks of " +
    "grain until the loft beams creaked. " +
    "They spoke of the flood as if it were still coming, and of the oak as if it might rise from the " +
    "millrace after the thaw.";

  const sportRows = [
    { text: PLAYS, at: 1, i: 0, id: "p" },
    { text: LOSER, at: 2, i: 1, id: "lose" },
    { text: WINNER, at: 3, i: 2, id: "win", kind: "fact" as const },
  ];

  test("hopChain is 2 hops; last object canada serial 8 not Scotland", () => {
    const hops = hopChain(CUE, sportRows);
    expect(hops).toHaveLength(2);
    expect(hops[1]!.o).toMatch(/canada/i);
    expect(hops[1]!.t).toBe(8);
    expect(hops[1]!.text).toMatch(/Canada/);
    expect(hops[1]!.text).not.toMatch(/Scotland/);
    expect(hops.some((h) => /scotland/i.test(h.o) || /Scotland/.test(h.text))).toBe(false);
  });

  test("completeNotes: last hop Canada is first among facts; a [rule] may precede", () => {
    const notes = [
      { text: "[rule] Always name the country a sport originated from.", id: "r", kind: "constraint" as const },
      { text: "[fact] Player Zane plays lacrosse.", id: "p", kind: "fact" as const },
      { text: "[fact] 8. Lacrosse originated in Canada.", id: "win", kind: "fact" as const },
    ];
    const out = completeNotes(CUE, notes, sportRows);
    expect(out.some((n) => /\[rule(?:\s*·[^\]]*)?\]/i.test(n.text))).toBe(true);
    const facts = out.filter((n) => /^\[fact(?:\s*·[^\]]*)?\]/i.test(String(n.text).trim()));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]!.text).toMatch(/Canada/);
    expect(facts[0]!.text).not.toMatch(/Scotland/);
    expect(out.some((n) => /Scotland/.test(n.text))).toBe(false);
  });

  test("ICL label: and novel alone are not hop triples", () => {
    expect(ICL).toMatch(/label:\s*28/);
    expect(NOVEL.length).toBeGreaterThan(400);
    expect(
      hopChain(CUE, [
        { text: ICL, at: 0, i: 0, id: "icl" },
        { text: NOVEL, at: 1, i: 1, id: "nar" },
        { text: "Player Zane plays lacrosse. label: 28", at: 2, i: 2, id: "icl-sport" },
      ]),
    ).toEqual([]);
    const iclCue = "The movie was great. label:";
    expect(iclCue).toMatch(/label:/);
    expect(
      hopChain(iclCue, [{ text: ICL, at: 0, i: 0, id: "icl" }, { text: NOVEL, at: 1, i: 1, id: "nar" }, ...sportRows]),
    ).toEqual([]);
  });

  test.failing("hop cue on mixed ICL/novel/Zane world still returns Canada", () => {
    const mixed = [
      { text: ICL, at: 0, i: 0, id: "icl" },
      { text: NOVEL, at: 1, i: 1, id: "nar" },
      ...sportRows,
      { text: "Player Zane plays lacrosse. label: 28", at: 9, i: 9, id: "icl-sport" },
    ];
    const hops = hopChain(CUE, mixed);
    expect(hops).toHaveLength(2);
    expect(hops[1]!.o).toMatch(/canada/i);
    expect(hops[1]!.t).toBe(8);
    expect(hops.every((h) => !/\blabel\s*:/i.test(h.text))).toBe(true);
    expect(hops.every((h) => !/miller of Blackford/i.test(h.text))).toBe(true);

    withMem((mem) => {
      mem.observe([{ role: "user", content: ICL }]);
      mem.observe([{ role: "user", content: NOVEL }]);
      mem.remember(PLAYS);
      mem.remember(LOSER);
      mem.remember(WINNER);
      expect(mem.memories().some((r) => /label:\s*28/.test(r.text))).toBe(true);
      const hopPkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(hopPkt).toContain(MEMORY_MARK);
      expect(hopPkt).toMatch(/Canada/);
      expect(hopPkt).not.toMatch(/Scotland/);
    });
  });

  test("ICL cue does not pull sport hops; stored label: is kept", () => {
    expect(ICL).toMatch(/label:\s*28/);
    const iclCue = "The movie was great. label:";
    expect(iclCue).toMatch(/label:/);
    withMem((mem) => {
      mem.observe([{ role: "user", content: ICL }]);
      mem.observe([{ role: "user", content: NOVEL }]);
      mem.remember(PLAYS);
      mem.remember(LOSER);
      mem.remember(WINNER);
      expect(mem.memories().some((r) => /label:\s*28/.test(r.text))).toBe(true);
      const iclPkt = packetOf(mem.inject([{ role: "user", content: iclCue }]));
      expect(iclPkt).toContain(MEMORY_MARK);
      expect(iclPkt).toMatch(/label:\s*28/);
      expect(iclPkt).not.toMatch(/Canada/);
      expect(iclPkt).not.toMatch(/Scotland/);
      expect(iclPkt).not.toMatch(/Zane/);
      expect(iclPkt).not.toMatch(/lacrosse/i);
    });
  });

  test("official FC-MH frames extract without REL_ALIASES sport/plays/originated/lacrosse", () => {
    const frames: [string, string, string][] = [
      ["Dana Voss plays the position of keeper.", "position", "keeper"],
      ["keeper is associated with the sport of polo.", "sport", "polo"],
      ["polo was created in the country of Kenya.", "citizen", "kenya"],
      ["Amala Paul is a citizen of Belgium.", "citizen", "belgium"],
      ["Amala Paul is affiliated with the religion of Hinduism.", "religion", "hinduism"],
      ["The author of Our Mutual Friend is Charles Darwin.", "author", "charles darwin"],
      ["Charles Darwin is married to Amala Paul.", "spouse", "amala paul"],
      ["Belgium is located in the continent of Europe.", "continent", "europe"],
    ];
    for (const [text, p, o] of frames) {
      const t = extractTriple(text);
      expect(t, text).toBeTruthy();
      expect(t!.p, text).toBe(p);
      expect(t!.o, text).toBe(o);
    }
  });

  test("4-hop author→spouse→citizen→continent last hop Europe; citizen query still Belgium", () => {
    const rows = [
      { text: "0. The author of Our Mutual Friend is Charles Dickens.", i: 0, at: 0 },
      { text: "3. The author of Our Mutual Friend is Charles Darwin.", i: 3, at: 3 },
      { text: "1. Charles Darwin is married to Emma Darwin.", i: 1, at: 1 },
      { text: "4. Charles Darwin is married to Amala Paul.", i: 4, at: 4 },
      { text: "2. Emma Darwin is a citizen of the United Kingdom.", i: 2, at: 2 },
      { text: "5. Amala Paul is a citizen of Belgium.", i: 5, at: 5 },
      { text: "6. Belgium is located in the continent of Europe.", i: 6, at: 6 },
      { text: "7. The United Kingdom is located in the continent of Europe.", i: 7, at: 7 },
    ];
    const q3 = "Which country is the spouse of the author of Our Mutual Friend a citizen of?";
    const q4 =
      "Which continent is the country of citizenship of the spouse of the author of Our Mutual Friend located in?";
    const h3 = hopChain(q3, rows);
    const h4 = hopChain(q4, rows);
    expect(h3[h3.length - 1]!.o).toMatch(/belgium/i);
    expect(h3[h3.length - 1]!.text).not.toMatch(/continent of Europe/i);
    expect(h4.length).toBe(4);
    expect(h4[h4.length - 1]!.o).toMatch(/europe/i);
    expect(h4[h4.length - 1]!.p).toBe("continent");
    expect(h4[h4.length - 1]!.text).toMatch(/Belgium is located in the continent of Europe/);
  });

  test("fail-open: completeNotes/completeScores throw leaves notes and scores unchanged", () => {
    const notes = [{ text: "keep me", id: "k" }];
    const boom = {
      forEach() {
        throw new Error("m22 hopChain");
      },
      map() {
        throw new Error("m22 hopChain");
      },
      [Symbol.iterator]() {
        throw new Error("m22 hopChain");
      },
      length: 1,
    } as never;
    expect(completeNotes(CUE, notes, boom)).toEqual(notes);
    expect(completeNotes(CUE, notes, null as never)).toEqual(notes);

    const episodes = [{ i: 0, text: PLAYS }];
    const scores = new Float64Array([7]);
    const badEpisodes = {
      length: 1,
      map() {
        throw new Error("m22 completeScores");
      },
      [0]: episodes[0],
    } as never;
    const out = completeScores(CUE, badEpisodes, scores);
    expect(out).toBe(scores);
    expect(Array.from(out)).toEqual([7]);
  });
});

/**
 * M28.1 MH hops over narrative chunks (not ICL, not GraphRAG EventQA).
 * Two ~512-token miller/river stories bury a 2-hop needle. Last hop Greenwich Village.
 */
const MILLER_FILLER = [
  "The miller walked beside the river that ran through the valley at dawn.",
  "Villagers said the oak still slept under the silt waiting for summer rain.",
  "Fog hung low over the marsh and the herons waited on one leg.",
  "Carts rattled over the stone bridge after the harvest wagons were loaded.",
  "Children skipped pebbles across the millpond until the geese protested.",
  "Winter ice cracked along the millrace and the wheel stood still for weeks.",
  "Spring floods returned every year and filled the lower pasture with silt.",
  "The baker traded loaves for flour when the sacks were stacked in the loft.",
  "Night watchmen circled the granary with lanterns after the storm passed.",
  "Sheep moved down from the high meadow when the first frost arrived.",
] as const;

const DIRECTOR_NEEDLE = 'The romantic comedy "Big Stone Gap" was directed by Adriana Trigiani.';
const BASED_NEEDLE = "Adriana Trigiani is based in Greenwich Village, New York City.";
const MH_CUE = 'The director of the romantic comedy "Big Stone Gap" is based in what New York city?';
const EVENTQA_CUE = "What happened at Blackford mill?";
const MILLER_NOVEL =
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. " +
  "He remembered the flood of his childhood and the oak that had fallen across the millrace. " +
  "The villagers said the oak still slept under the silt, waiting. " +
  "Winter after winter the mill wheel turned against the ice, and the miller's sons counted sacks of " +
  "grain until the loft beams creaked. " +
  "They spoke of the flood as if it were still coming, and of the oak as if it might rise from the " +
  "millrace after the thaw.";

function millerPad(seed: number, minToks: number): string {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < minToks) {
    const s = `${MILLER_FILLER[i % MILLER_FILLER.length]!.replace(/\.$/, "")} near marker ${seed}-${i}.`;
    parts.push(s);
    n += estimateTokens(s);
    i++;
  }
  return parts.join(" ");
}

function buryInChunk(needle: string, seed: number): string {
  const needleToks = estimateTokens(needle);
  const each = Math.max(32, Math.floor((CHUNK_TARGET_TOKENS - needleToks) / 2));
  return `${millerPad(seed, each)} ${needle} ${millerPad(seed + 100, each)}`;
}

describe("M28.1 MH 2-hop needle over narrative chunks", () => {
  const directorStory = buryInChunk(DIRECTOR_NEEDLE, 1);
  const basedStory = buryInChunk(BASED_NEEDLE, 2);
  const chunkRows = [
    { text: directorStory, at: 1, i: 0, id: "dir" },
    { text: basedStory, at: 2, i: 1, id: "based" },
  ];

  test("buried stories are ~512-token narrative chunks, not miller-only", () => {
    expect(encodeLane(directorStory)).toBe("narrative");
    expect(encodeLane(basedStory)).toBe("narrative");
    expect(estimateTokens(directorStory)).toBeGreaterThanOrEqual(400);
    expect(estimateTokens(basedStory)).toBeGreaterThanOrEqual(400);
    expect(estimateTokens(directorStory)).toBeLessThan(CHUNK_TARGET_TOKENS + 80);
    expect(estimateTokens(basedStory)).toBeLessThan(CHUNK_TARGET_TOKENS + 80);
    expect(directorStory).toContain(DIRECTOR_NEEDLE);
    expect(basedStory).toContain(BASED_NEEDLE);
    expect(directorStory).toMatch(/miller|river/i);
    expect(basedStory).toMatch(/miller|river/i);
  });

  test("hopChain is 2 hops; last object Greenwich Village not miller", () => {
    const hops = hopChain(MH_CUE, chunkRows);
    expect(hops).toHaveLength(2);
    expect(hops[1]!.o).toMatch(/greenwich|village/i);
    expect(hops[1]!.o).not.toMatch(/miller/i);
    expect(hops.every((h) => !/miller/i.test(h.o))).toBe(true);
    expect(hops[1]!.text).toMatch(/greenwich|village/i);
    expect(hops.some((h) => /Big Stone Gap|Adriana Trigiani/i.test(h.text))).toBe(true);
  });

  test("completeNotes puts last-hop Greenwich text first among hop rows", () => {
    const notes = [chunkRows[0]!, chunkRows[1]!];
    const out = completeNotes(MH_CUE, notes, chunkRows);
    const hopRows = out.filter((r) => /Adriana Trigiani|Big Stone Gap|Greenwich Village/i.test(r.text));
    expect(hopRows.length).toBeGreaterThan(0);
    expect(hopRows[0]!.text).toMatch(/greenwich|village/i);
    const last = out.findIndex((r) => /greenwich|village/i.test(r.text));
    const dirOnly = out.findIndex(
      (r) => /directed by Adriana Trigiani/i.test(r.text) && !/greenwich|village/i.test(r.text),
    );
    expect(last).toBe(0);
    if (dirOnly >= 0) expect(last).toBeLessThan(dirOnly);
  });

  test("completeNotes pulls last-hop Greenwich from store when notes only has the director chunk", () => {
    const notes = [chunkRows[0]!];
    expect(notes[0]!.text).toContain(DIRECTOR_NEEDLE);
    expect(notes[0]!.text).not.toMatch(/Greenwich Village/i);
    const out = completeNotes(MH_CUE, notes, chunkRows);
    expect(out[0]!.text).toMatch(/greenwich|village/i);
    expect(out[0]!.text).toContain(BASED_NEEDLE);
    const last = out.findIndex((r) => /greenwich|village/i.test(r.text));
    const dirOnly = out.findIndex(
      (r) => /directed by Adriana Trigiani/i.test(r.text) && !/greenwich|village/i.test(r.text),
    );
    expect(last).toBe(0);
    if (dirOnly >= 0) expect(last).toBeLessThan(dirOnly);
  });

  test.failing("inject of two narratives: Greenwich Village + Memory mark; last hop before director-only", () => {
    withMem((mem) => {
      expect(encodeLane(directorStory)).toBe("narrative");
      expect(encodeLane(basedStory)).toBe("narrative");
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedStory }]);
      const packet = packetOf(mem.inject([{ role: "user", content: MH_CUE }]));
      expect(packet).toContain(MEMORY_MARK);
      expect(packet).toMatch(/Greenwich Village/i);
      expect(
        /miller|river|oak|silt/i.test(packet) && !/Greenwich Village|Adriana Trigiani|Big Stone Gap/i.test(packet),
      ).toBe(false);
      const village = packet.search(/Greenwich Village/i);
      const directed = packet.search(/directed by Adriana Trigiani/i);
      expect(village).toBeGreaterThanOrEqual(0);
      if (directed >= 0) expect(village).toBeLessThan(directed);
    });
  });

  test.failing("wiki-style ? inside a 512-token chunk does not drop the Greenwich hop", () => {
    const basedQ = `${basedStory} Who knows?`;
    expect(basedQ).toMatch(/\?/);
    expect(basedQ).toContain(BASED_NEEDLE);
    const rows = [
      { text: directorStory, at: 1, i: 0, id: "dir" },
      { text: basedQ, at: 2, i: 1, id: "based" },
    ];
    const hops = hopChain(MH_CUE, rows);
    expect(hops.length).toBeGreaterThanOrEqual(2);
    expect(hops[hops.length - 1]!.o).toMatch(/greenwich|village/i);
    const pulled = completeNotes(MH_CUE, [rows[0]!], rows);
    expect(pulled[0]!.text).toMatch(/greenwich|village/i);
    withMem((mem) => {
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedQ }]);
      const packet = packetOf(mem.inject([{ role: "user", content: MH_CUE }]));
      expect(packet).toMatch(/Greenwich Village/i);
      const village = packet.search(/Greenwich Village/i);
      const directed = packet.search(/directed by Adriana Trigiani/i);
      expect(village).toBeGreaterThanOrEqual(0);
      if (directed >= 0) expect(village).toBeLessThan(directed);
    });
  });
});

describe("M28 EventQA miller is not GraphRAG", () => {
  test("hopChain on miller/Blackford novel-only rows stays empty", () => {
    expect(MILLER_NOVEL.length).toBeGreaterThan(400);
    const millerRows = [{ text: MILLER_NOVEL, at: 0, i: 0, id: "nar" }];
    expect(hopChain(EVENTQA_CUE, millerRows)).toEqual([]);
    expect(hopChain(MH_CUE, millerRows)).toEqual([]);
  });

  test("EventQA cue after miller-only observe: Blackford ok, no invented director/based triples", () => {
    const millerRows = [{ text: MILLER_NOVEL, at: 0, i: 0, id: "nar" }];
    expect(hopChain(EVENTQA_CUE, millerRows)).toEqual([]);
    withMem((mem) => {
      mem.observe([{ role: "user", content: MILLER_NOVEL }]);
      const stored = mem.memories().map((r, i) => ({ text: r.text, at: r.at, i, id: r.id }));
      expect(hopChain(EVENTQA_CUE, stored)).toEqual([]);
      const packet = packetOf(mem.inject([{ role: "user", content: EVENTQA_CUE }]));
      expect(packet).not.toMatch(/Adriana Trigiani/);
      expect(packet).not.toMatch(/Big Stone Gap/);
      expect(packet).not.toMatch(/Greenwich Village/);
      expect(packet).not.toMatch(/directed by/i);
      expect(packet).not.toMatch(/based in Greenwich/i);
    });
  });
});

describe("M28 fail-open", () => {
  test("completeNotes/completeScores throw on MH cue leaves notes and scores unchanged", () => {
    const notes = [{ text: "keep me", id: "k" }];
    const boom = {
      forEach() {
        throw new Error("m28 hopChain");
      },
      map() {
        throw new Error("m28 hopChain");
      },
      [Symbol.iterator]() {
        throw new Error("m28 hopChain");
      },
      length: 1,
    } as never;
    expect(completeNotes(MH_CUE, notes, boom)).toEqual(notes);
    expect(completeNotes(MH_CUE, notes, null as never)).toEqual(notes);

    const episodes = [{ i: 0, text: DIRECTOR_NEEDLE }];
    const scores = new Float64Array([7]);
    const badEpisodes = {
      length: 1,
      map() {
        throw new Error("m28 completeScores");
      },
      [0]: episodes[0],
    } as never;
    const out = completeScores(MH_CUE, badEpisodes, scores);
    expect(out).toBe(scores);
    expect(Array.from(out)).toEqual([7]);
  });
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function anthMemoryText(body: { system?: unknown }): string {
  const sys = body.system;
  const parts =
    typeof sys === "string"
      ? [sys]
      : Array.isArray(sys)
        ? sys.map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? "")))
        : [];
  return parts.filter((p) => p.includes(MEMORY_MARK)).join("\n");
}

function hookMemoryText(r: Record<string, unknown> | null): string {
  if (!r) return "";
  const spec = r.hookSpecificOutput as { additionalContext?: string } | undefined;
  return `${String(r.additional_context ?? "")}\n${spec?.additionalContext ?? ""}`;
}

describe("M28 wrap OpenAI / Anthropic / hook 2-hop + fail-open", () => {
  test.failing("injectBody / Anthropic / hook last hop Greenwich; ICL shots stay out", () => {
    const directorStory = buryInChunk(DIRECTOR_NEEDLE, 1);
    const basedStory = buryInChunk(BASED_NEEDLE, 2);
    const seed = (mem: ReturnType<typeof openMemory>) => {
      mem.observe([{ role: "user", content: "The movie was great. label: 28" }]);
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedStory }]);
    };
    const primed = (fn: (mem: ReturnType<typeof openMemory>) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "eden-m28-wrap-"));
      const mem = openMemory({ dir });
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        withEnv(
          { EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0", EDEN_MEMORY_CAP: "10" },
          () => {
            seed(mem);
            fn(mem);
          },
        );
      } finally {
        procSpy.mockRestore();
        mem.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    primed((mem) => {
      const openai = mem.injectBody({ messages: [{ role: "user", content: MH_CUE }] });
      const oaiPkt = packetOf((openai.messages as unknown[]) ?? []);
      expect(oaiPkt).toContain(MEMORY_MARK);
      expect(oaiPkt).toMatch(/Greenwich Village/i);
      expect(oaiPkt).not.toMatch(/label:\s*28/);
    });

    primed((mem) => {
      const helper = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: MH_CUE }] });
      expect(packetOf((helper.messages as unknown[]) ?? [])).toMatch(/Greenwich Village/i);
    });

    primed((mem) => {
      const wrap = withKnowFacts({ messages: [{ role: "user", content: MH_CUE }] });
      expect(packetOf((wrap.messages as unknown[]) ?? [])).toMatch(/Greenwich Village/i);
    });

    primed(() => {
      const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: MH_CUE }] });
      expect(anthMemoryText(anth)).toMatch(/Greenwich Village/i);
      expect(anthMemoryText(anth)).not.toMatch(/label:\s*28/);
    });

    primed(() => {
      const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: MH_CUE });
      expect(hookMemoryText(hook)).toMatch(/Greenwich Village/i);
      expect(hookMemoryText(hook)).not.toMatch(/label:\s*28/);
    });
  });

  test("retrieve throw → original messages on inject / injectBody / wrap / Anthropic / hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m28-failopen-"));
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    const boom = spyOn(edenMem.AgentMemory.prototype, "relevant").mockImplementation(() => {
      throw new Error("m28 relevant boom");
    });
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        const list = [{ role: "user", content: MH_CUE }];
        expect(mem.inject(list)).toBe(list);
        const body = { messages: list };
        expect(mem.injectBody(body)).toBe(body);
        expect(withKnowFacts(body)).toBe(body);
        const anth = { messages: [{ role: "user", content: MH_CUE }] };
        expect(withKnowFactsAnthropic(anth)).toBe(anth);
        expect(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: MH_CUE })).toBeNull();
      });
    } finally {
      boom.mockRestore();
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M28 interrogative chat must not steal Greenwich", () => {
  const FAKE_Q = "The director of Big Stone Gap is based in Brooklyn?";
  const FAKE_BASED = "The director of Big Stone Gap is based in Brooklyn.";

  test("extractTriple does not mint a director hop from a question or director-of + based-in", () => {
    expect(extractTriple(MH_CUE)).toBeUndefined();
    expect(extractTriple(FAKE_Q)).toBeUndefined();
    expect(extractTriple("Adriana Trigiani is based in which neighborhood?")).toBeUndefined();
    const stmt = extractTriple(FAKE_BASED);
    expect(stmt?.p).not.toBe("director");
    expect(stmt?.o ?? "").not.toMatch(/based in brooklyn/i);
  });

  test.failing("stored Brooklyn? chat cue does not knock Greenwich out of inject", () => {
    const directorStory = buryInChunk(DIRECTOR_NEEDLE, 1);
    const basedStory = buryInChunk(BASED_NEEDLE, 2);
    withMem((mem) => {
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedStory }]);
      mem.observe([{ role: "user", content: FAKE_Q }]);
      expect(mem.memories().some((r) => r.lane === "chat" && /\?/.test(r.text))).toBe(true);
      const packet = packetOf(mem.inject([{ role: "user", content: MH_CUE }]));
      expect(packet).toContain(MEMORY_MARK);
      expect(packet).toMatch(/Greenwich Village/i);
      const village = packet.search(/Greenwich Village/i);
      const brooklyn = packet.search(/Brooklyn/i);
      expect(village).toBeGreaterThanOrEqual(0);
      if (brooklyn >= 0) expect(village).toBeLessThan(brooklyn);
      const hops = hopChain(
        MH_CUE,
        mem.memories().map((r, i) => ({ text: r.text, at: r.at, i, id: r.id })),
      );
      expect(hops.some((h) => /greenwich|village/i.test(h.o))).toBe(true);
      expect(hops.every((h) => !/brooklyn/i.test(h.o))).toBe(true);
    });
  });

  test.failing("later miller chunk ending Brooklyn? does not steal Greenwich", () => {
    const directorStory = buryInChunk(DIRECTOR_NEEDLE, 1);
    const basedStory = buryInChunk(BASED_NEEDLE, 2);
    const brooklynQ = buryInChunk("Adriana Trigiani is based in Brooklyn?", 7);
    expect(brooklynQ).toMatch(/\?/);
    expect(extractTriple("Adriana Trigiani is based in Brooklyn?")).toBeUndefined();
    const hops = hopChain(MH_CUE, [
      { text: directorStory, at: 1, i: 0, id: "dir" },
      { text: basedStory, at: 2, i: 1, id: "based" },
      { text: brooklynQ, at: 3, i: 2, id: "later" },
    ]);
    expect(hops.length).toBeGreaterThanOrEqual(2);
    expect(hops[hops.length - 1]!.o).toMatch(/greenwich|village/i);
    expect(hops.every((h) => !/brooklyn/i.test(h.o))).toBe(true);
    withMem((mem) => {
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedStory }]);
      mem.observe([{ role: "user", content: brooklynQ }]);
      const packet = packetOf(mem.inject([{ role: "user", content: MH_CUE }]));
      expect(packet).toMatch(/Greenwich Village/i);
      const village = packet.search(/Greenwich Village/i);
      const brooklyn = packet.search(/Brooklyn/i);
      expect(village).toBeGreaterThanOrEqual(0);
      if (brooklyn >= 0) expect(village).toBeLessThan(brooklyn);
    });
  });

  test.failing("diet / CircleCI hay is not a hop and does not steal Greenwich", () => {
    const directorStory = buryInChunk(DIRECTOR_NEEDLE, 1);
    const basedStory = buryInChunk(BASED_NEEDLE, 2);
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Kai is vegetarian and skip dairy." }]);
      mem.observe([{ role: "user", content: "CI is CircleCI." }]);
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedStory }]);
      const hops = hopChain(
        MH_CUE,
        mem.memories().map((r, i) => ({ text: r.text, at: r.at, i, id: r.id })),
      );
      expect(hops.every((h) => !/vegetarian|dairy|circleci/i.test(h.o + h.text))).toBe(true);
      const packet = packetOf(mem.inject([{ role: "user", content: MH_CUE }]));
      expect(packet).toMatch(/Greenwich Village/i);
      expect(packet).not.toMatch(/vegetarian|skip dairy/i);
      expect(packet).not.toMatch(/CircleCI/i);
      const village = packet.search(/Greenwich Village/i);
      const first = bullets(packet)[0] ?? packet;
      expect(village).toBeGreaterThanOrEqual(0);
      expect(first).not.toMatch(/CircleCI|vegetarian/i);
    });
  });
});
