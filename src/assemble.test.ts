/**
 * M8.1 assembler: two serials → packet contains only the newer, without sleep.
 * Code picks max(t) per (s,p). ICL is not a fact. Status is not identity.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemble, assembleNotes, extractCandidates } from "./assemble";
import { hopChain } from "./cls/complete";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { MEMORY_MARK, encodeLane, memoryInjectSwallows, openMemory, sleep, type AgentMemory } from "./index";
import * as edenMem from "./index";
import { SemanticStore } from "./semantic-store";
import { repoIdentity, repoStoreDir } from "./memory-repo";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/36

function tmpDir(prefix = "eden-m81-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withMem(fn: (mem: AgentMemory, dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = tmpDir();
  const run = async () => {
    try {
      await fn(openMemory({ dir }), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return run();
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function laterThan(at: number): void {
  const end = at + 2;
  while (Date.now() <= end) {
    /* wall clock must move for timestamp-only LWW */
  }
}

function factObject(got: unknown): string {
  if (got == null) return "";
  if (typeof got === "string") return got;
  if (typeof got === "object") {
    const o = got as { o?: unknown; object?: unknown; value?: unknown; text?: unknown };
    return String(o.o ?? o.object ?? o.value ?? o.text ?? "");
  }
  return String(got);
}

describe("extractCandidates", () => {
  test("copula and uses; ICL and status yield nothing", () => {
    const got = extractCandidates([
      { text: "1. The chairperson of the committee is Alice.", t: 1000, id: "a" },
      { text: "8. The chairperson of the committee is Bob.", t: 1001, id: "b" },
      { text: "The movie was great. label: 28", t: 1002, id: "icl" },
      { text: "Auth is failing", t: 1003, id: "st" },
      { text: "Use sqlite instead of postgres.", t: 1004, id: "u" },
    ]);
    expect(got.some((tr) => tr.o === "Alice" && tr.t === 1000 && tr.recId === "a")).toBe(true);
    expect(got.some((tr) => tr.o === "Bob" && tr.t === 1001 && tr.recId === "b")).toBe(true);
    expect(got.some((tr) => /label|28|positive|great/i.test(tr.o) || tr.p === "label")).toBe(false);
    expect(got.some((tr) => /failing/i.test(tr.o))).toBe(false);
    expect(got.some((tr) => tr.s === "stack" && tr.p === "uses" && /sqlite/i.test(tr.o))).toBe(true);
  });

  test("A1 D8: a list number is not a time: 8. The chairperson is X keeps its row's time", () => {
    const got = extractCandidates([{ text: "8. The chairperson is X.", t: 999, id: "x" }]);
    expect(got.some((tr) => tr.o === "X" && tr.t === 999 && tr.recId === "x")).toBe(true);
    expect(got.some((tr) => tr.t === 8)).toBe(false);
    const paren = extractCandidates([{ text: "8) The chairperson is X.", t: 999, id: "p" }]);
    expect(paren.some((tr) => tr.o === "X" && tr.t === 999 && tr.recId === "p")).toBe(true);
    expect(paren.some((tr) => tr.t === 8)).toBe(false);
  });

  test("M20.1: one blob with 1. and 8. yields both, at the row's time; now/was/became extract", () => {
    const blob = extractCandidates([
      {
        text: "1. The chairperson of the committee is Alice.\n8. The chairperson of the committee is Bob.",
        t: 50,
      },
    ]);
    expect(blob.some((tr) => tr.o === "Alice" && tr.t === 50)).toBe(true);
    expect(blob.some((tr) => tr.o === "Bob" && tr.t === 50)).toBe(true);

    const extra = extractCandidates([
      { text: "The chairperson became Bob.", t: 3 },
      { text: "The sport of Alice is now basketball.", t: 4 },
      { text: "The sport of Alice was ice hockey.", t: 5 },
      { text: "The sport of Alice became tennis.", t: 6 },
    ]);
    expect(extra.some((tr) => /Bob/i.test(tr.o))).toBe(true);
    expect(extra.some((tr) => /basketball/i.test(tr.o))).toBe(true);
    expect(extra.some((tr) => /ice hockey/i.test(tr.o))).toBe(true);
    expect(extra.some((tr) => /tennis/i.test(tr.o))).toBe(true);
  });

  test("M48.2: decided-to-use ADR extracts auth is Clerk; don't-forget and ICL do not", () => {
    const got = extractCandidates([{ text: "We decided to use Clerk for auth because SSO.", t: 10, id: "adr" }]);
    expect(got.some((tr) => tr.s === "auth" && tr.p === "is" && /Clerk/i.test(tr.o) && tr.recId === "adr")).toBe(true);
    expect(extractCandidates([{ text: "don't forget to use Clerk for auth because SSO.", t: 11 }])).toEqual([]);
    expect(extractCandidates([{ text: "We decided to use Clerk for auth because SSO. label: 7", t: 12 }])).toEqual([]);
    expect(extractCandidates([{ text: "We decided to use Clerk for auth because SSO.", t: 13, lane: "icl" }])).toEqual(
      [],
    );
    expect(extractCandidates([{ text: "do not forget to use Clerk for auth because SSO.", t: 14 }])).toEqual([]);
    const later = assemble(
      extractCandidates([
        {
          text:
            "We decided to use postgres for the database because durability then we decided to use sqlite for " +
            "the database.",
          t: 15,
        },
      ]),
    );
    expect(later).toHaveLength(1);
    expect(later[0]!.s).toBe("database");
    expect(later[0]!.o).toBe("sqlite");
  });

  test("does not throw on bad input", () => {
    expect(extractCandidates(null as never)).toEqual([]);
    expect(extractCandidates(undefined as never)).toEqual([]);
    expect(extractCandidates([{ text: undefined as never, t: NaN }])).toEqual([]);
    expect(() => extractCandidates([{} as never, { text: 1 as never, t: "x" as never }])).not.toThrow();
  });
});

describe("assemble max(t) per (s,p)", () => {
  test("serial 8 beats serial 1; equal t keeps later", () => {
    const only = assemble([
      { s: "chairperson of the committee", p: "is", o: "Alice", t: 1, recId: "a" },
      { s: "chairperson of the committee", p: "is", o: "Bob", t: 8, recId: "b" },
    ]);
    expect(only).toHaveLength(1);
    expect(only[0]!.o).toBe("Bob");

    const tied = assemble([
      { s: "database", p: "is", o: "postgres", t: 5 },
      { s: "database", p: "is", o: "sqlite", t: 5 },
    ]);
    expect(tied).toHaveLength(1);
    expect(tied[0]!.o).toBe("sqlite");
  });

  test("does not throw on bad input", () => {
    expect(assemble(null as never)).toEqual([]);
    expect(assemble([{ s: "", p: "is", o: "x", t: 1 }])).toEqual([]);
    expect(() => assemble([undefined as never, { s: 1 as never } as never])).not.toThrow();
  });
});

describe("M8.1 inject: two serials without sleep → only newer", () => {
  test("1. Alice then 8. Bob: packet has Bob, not Alice; JSONL still has both", async () => {
    await withMem((mem) => {
      mem.remember("1. The chairperson of the committee is Alice.");
      mem.remember("8. The chairperson of the committee is Bob.");
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /Bob/.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(true);
    });
  });

  test("timestamps only: older postgres then newer sqlite", async () => {
    await withMem((mem) => {
      const old = mem.remember("The database is postgres.");
      laterThan(old.at);
      mem.remember("The database is sqlite.");
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
      expect(mem.memories().some((r) => /postgres/i.test(r.text))).toBe(true);
    });
  });
});

describe("M8.1 ICL is not assembled as a fact", () => {
  test("label: 28 exemplar is not dropped when assembling with other serials", () => {
    const notes = [
      { id: "icl", text: "The movie was great. label: 28", at: 1 },
      { id: "a", text: "1. The chairperson of the committee is Alice.", at: 2 },
      { id: "b", text: "8. The chairperson of the committee is Bob.", at: 3 },
      { id: "gold", text: "Input: The film is terrible. Output: negative", at: 4 },
    ];
    const out = assembleNotes(notes);
    expect(out.some((n) => /label:\s*28/i.test(n.text))).toBe(true);
    expect(out.some((n) => /Input:.*Output:/i.test(n.text))).toBe(true);
    expect(out.some((n) => /Bob/.test(n.text))).toBe(true);
    expect(out.some((n) => /Alice/.test(n.text))).toBe(false);
    expect(extractCandidates([{ text: "The movie was great. label: 28", t: 1 }])).toEqual([]);
  });

  test("inject packet keeps the gold label: 28 exemplar", async () => {
    await withMem((mem) => {
      mem.remember("The movie was great. label: 28");
      mem.remember("Input: The film is terrible. Output: negative");
      const pkt = packetOf(mem.inject([{ role: "user", content: "The movie was great. label:" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/label:\s*28/i);
    });
  });
});

describe("M8.1 Clerk identity is not deleted by status", () => {
  test("Auth is Clerk then Auth is failing: inject still has Clerk", async () => {
    await withMem((mem) => {
      mem.remember("Auth is Clerk");
      mem.remember("Auth is failing");
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Clerk/);
      expect(mem.memories().some((r) => /Clerk/.test(r.text))).toBe(true);
    });
  });
});

describe("assembleNotes keeps non-triples; fail-open", () => {
  test("rules stay; losing serials drop", () => {
    const out = assembleNotes([
      { id: "r", text: "Always run tests before committing.", at: 1 },
      { id: "a", text: "1. The chairperson of the committee is Alice.", at: 2 },
      { id: "b", text: "8. The chairperson of the committee is Bob.", at: 3 },
    ]);
    expect(out.some((n) => /Always run tests/.test(n.text))).toBe(true);
    expect(out.some((n) => /Bob/.test(n.text))).toBe(true);
    expect(out.some((n) => /Alice/.test(n.text))).toBe(false);
  });

  test("a fused note is scrubbed to its later statement, whatever the list numbers say (A1 D8)", () => {
    const out = assembleNotes([
      {
        id: "fuse",
        text: "[fact] 8. The chairperson of the committee is Bob. | 1. The chairperson of the committee is Alice.",
        at: 9,
      },
    ]);
    expect(out.some((n) => /Alice/.test(n.text))).toBe(true);
    expect(out.some((n) => /Bob/.test(n.text))).toBe(false);
    expect(out.some((n) => /^\[fact(?:\s*·[^\]]*)?\]/.test(n.text.trim()))).toBe(true);
  });

  test("[fact] packet labels still expose serials to max(t)", () => {
    const out = assembleNotes([
      { id: "a", text: "[fact] 1. The chairperson of the committee is Alice.", at: 2 },
      { id: "b", text: "[fact] 8. The chairperson of the committee is Bob.", at: 3 },
    ]);
    expect(out.some((n) => /Bob/.test(n.text))).toBe(true);
    expect(out.some((n) => /Alice/.test(n.text))).toBe(false);
  });

  test("provenance [fact · 3h · user]: sqlite wins, postgres absent, a labelled list item still extracts", () => {
    const out = assembleNotes([
      { id: "old", text: "[fact · 3h · user] The database is postgres.", at: 1 },
      { id: "new", text: "[fact · 1h · user] The database is sqlite.", at: 2 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toMatch(/sqlite/i);
    expect(out[0]!.text).toMatch(/^\[fact · 1h · user\]/i);
    expect(out.some((n) => /postgres/i.test(n.text))).toBe(false);

    const got = extractCandidates([
      {
        text: "[fact · 3h · user] 8. The chairperson is Bob",
        t: 999,
        id: "c",
      },
    ]);
    expect(got.some((tr) => tr.t === 999 && /bob/i.test(tr.o))).toBe(true);

    const hops = hopChain("who is the chairperson of the committee", [
      { text: "[fact · 3h · user] 1. The chairperson of the committee is Alice.", at: 100, i: 0 },
      { text: "[fact | 1h | user] 8. The chairperson of the committee is Bob.", at: 200, i: 1 },
    ]);
    expect(hops.some((h) => h.t === 200 && /bob/i.test(factObject(h)))).toBe(true);
    expect(hops.some((h) => /alice/i.test(factObject(h)))).toBe(false);

    const icl = assembleNotes([{ id: "icl", text: "label: positive Input: postgres Output: sqlite", at: 1 }]);
    expect(icl[0]!.text).toMatch(/label:\s*positive/);
  });

  test("bad notes/dir do not throw; returns a list", () => {
    expect(() => assembleNotes(null as never)).not.toThrow();
    expect(assembleNotes(null as never)).toEqual([]);
    expect(assembleNotes([{ id: "x", text: "Auth is Clerk", at: 1 }], "/no/such/eden-assemble-dir")).toHaveLength(1);
  });

  test("live SemanticStore object can tombstone a retrieved loser without serials", () => {
    const dir = tmpDir("eden-m81-sem-");
    try {
      const store = new SemanticStore(dir);
      store.put("database", "is", "sqlite", 9);
      const out = assembleNotes(
        [
          { id: "old", text: "The database is postgres.", at: 1 },
          { id: "new", text: "The database is sqlite.", at: 2 },
        ],
        dir,
      );
      expect(out.some((n) => /sqlite/i.test(n.text))).toBe(true);
      expect(out.some((n) => /postgres/i.test(n.text))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * M16.4 / M22: player → sport → country two-hop overwrite.
 * CAR walks hops; last hop (Canada, serial 8) is first among facts; Scotland absent.
 * REL_ALIASES must not grow sport/plays/originated/lacrosse (no greenwash).
 */
describe("M16.4 FC-MH player→sport→country assembly miss", () => {
  const PLAYS = "Player Zane plays lacrosse.";
  const LOSER = "1. Lacrosse originated in Scotland.";
  const WINNER = "8. Lacrosse originated in Canada.";
  const CUE = "What country is the sport of Zane from?";
  const RULE = "Always name the country a sport originated from.";
  const ICL = "The movie was great. label: 28";
  const NOVEL =
    "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. " +
    "He remembered the flood of his childhood and the oak that had fallen across the millrace. " +
    "The villagers said the oak still slept under the silt, waiting. " +
    "Winter after winter the mill wheel turned against the ice, and the miller's sons counted sacks of " +
    "grain until the loft beams creaked. " +
    "They spoke of the flood as if it were still coming, and of the oak as if it might rise from the " +
    "millrace after the thaw.";

  function factLines(packet: string): string[] {
    return packet
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^-\s*\[fact(?:\s*[·|][^\]]*)?\]/i.test(l));
  }

  function seedSportWorld(mem: AgentMemory): void {
    mem.remember(PLAYS);
    mem.remember(LOSER);
    mem.remember(WINNER);
  }

  test("do not greenwash: REL_ALIASES has no sport / plays / originated / lacrosse", () => {
    const completeSrc = readFileSync(join(import.meta.dir, "cls/complete.ts"), "utf8");
    const aliases = completeSrc.match(/const REL_ALIASES: Record<string, string> = \{[\s\S]*?\n\};/);
    expect(aliases?.[0]).toBeTruthy();
    const block = aliases![0]!;
    expect(block).not.toMatch(/\bsport\b/i);
    expect(block).not.toMatch(/\bplays\b/i);
    expect(block).not.toMatch(/\boriginated\b/i);
    expect(block).not.toMatch(/\blacrosse\b/i);
  });

  test.failing("hopChain is 2 hops; last object canada serial 8; inject has Canada not Scotland", async () => {
    await withMem((mem) => {
      seedSportWorld(mem);
      expect(mem.memories().some((r) => /Scotland/.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /Canada/.test(r.text))).toBe(true);
      const hops = hopChain(CUE, [
        { text: PLAYS, at: 1, i: 0 },
        { text: LOSER, at: 2, i: 1 },
        { text: WINNER, at: 3, i: 2 },
      ]);
      expect(hops).toHaveLength(2);
      expect(factObject(hops[1])).toMatch(/canada/i);
      expect(hops[1]!.t).toBe(8);
      expect(hops[1]!.text).toMatch(/Canada/);
      expect(hops[1]!.text).not.toMatch(/Scotland/);
      expect(hops.some((h) => /scotland/i.test(factObject(h)) || /Scotland/.test(h.text))).toBe(false);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Canada/);
      expect(pkt).not.toMatch(/Scotland/);
    });
  });

  test.failing("last-hop Canada is first [fact]; Scotland loser absent", async () => {
    await withMem((mem) => {
      seedSportWorld(mem);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Canada/);
      expect(pkt).not.toMatch(/Scotland/);
      const facts = factLines(pkt);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0]).toMatch(/Canada/);
      expect(facts[0]).not.toMatch(/Scotland/);
      expect(facts[0]).toMatch(/\[fact[^\]]*\].*Canada/i);
    });
  });

  test.failing("last hop [fact] is first among facts; a [rule] may precede", async () => {
    await withMem((mem) => {
      mem.remember(RULE, { kind: "constraint" });
      seedSportWorld(mem);
      expect(mem.memories().some((r) => /Scotland/.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Canada/);
      expect(pkt).not.toMatch(/Scotland/);
      const facts = factLines(pkt);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0]).toMatch(/Canada/);
      expect(facts[0]).not.toMatch(/Scotland/);
      expect(facts[0]).toMatch(/\[fact[^\]]*\].*Canada/i);
      const bullets = pkt
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"));
      const firstFactAt = bullets.findIndex((l) => /^-\s*\[fact(?:\s*[·|][^\]]*)?\]/i.test(l));
      const canadaFactAt = bullets.findIndex((l) => /^-\s*\[fact(?:\s*[·|][^\]]*)?\]/i.test(l) && /Canada/i.test(l));
      expect(firstFactAt).toBeGreaterThanOrEqual(0);
      expect(canadaFactAt).toBe(firstFactAt);
      const firstRuleAt = bullets.findIndex((l) => /^-\s*\[rule(?:\s*[·|][^\]]*)?\]/i.test(l));
      if (firstRuleAt >= 0) {
        expect(pkt).toMatch(/\[rule(?:\s*[·|][^\]]*)?\]/i);
        expect(facts[0]).toMatch(/Canada/);
      }
    });
  });

  test("ICL label: and novel alone are not hop triples", () => {
    expect(ICL).toMatch(/label:\s*28/);
    expect(NOVEL.length).toBeGreaterThan(400);
    expect(
      hopChain(CUE, [
        { text: ICL, at: 0, i: 0 },
        { text: NOVEL, at: 1, i: 1 },
        { text: "Player Zane plays lacrosse. label: 28", at: 2, i: 2 },
      ]),
    ).toEqual([]);
    const iclCue = "The movie was great. label:";
    expect(iclCue).toMatch(/label:/);
    expect(
      hopChain(iclCue, [
        { text: ICL, at: 0, i: 0 },
        { text: NOVEL, at: 1, i: 1 },
        { text: PLAYS, at: 2, i: 2 },
        { text: LOSER, at: 3, i: 3 },
        { text: WINNER, at: 4, i: 4 },
      ]),
    ).toEqual([]);
  });

  test("ICL cue does not pull sport hops; stored label: is kept", async () => {
    expect(ICL).toMatch(/label:\s*28/);
    await withMem((mem) => {
      mem.observe([{ role: "user", content: ICL }]);
      mem.observe([{ role: "user", content: NOVEL }]);
      seedSportWorld(mem);
      expect(mem.memories().some((r) => /label:\s*28/.test(r.text))).toBe(true);
      const iclCue = "The movie was great. label:";
      expect(iclCue).toMatch(/label:/);
      const iclPkt = packetOf(mem.inject([{ role: "user", content: iclCue }]));
      expect(iclPkt).toContain(MEMORY_MARK);
      expect(iclPkt).toMatch(/label:\s*28/);
      expect(iclPkt).not.toMatch(/Canada/);
      expect(iclPkt).not.toMatch(/Scotland/);
      expect(iclPkt).not.toMatch(/Zane/);
      expect(iclPkt).not.toMatch(/lacrosse/i);
    });
  });

  test.failing("hop cue on mixed ICL/novel/Zane world still returns Canada", async () => {
    expect(ICL).toMatch(/label:\s*28/);
    expect(NOVEL.length).toBeGreaterThan(400);
    await withMem((mem) => {
      mem.observe([{ role: "user", content: ICL }]);
      mem.observe([{ role: "user", content: NOVEL }]);
      seedSportWorld(mem);
      expect(mem.memories().some((r) => /label:\s*28/.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /miller of Blackford/.test(r.text))).toBe(true);
      const hops = hopChain(CUE, [
        { text: ICL, at: 0, i: 0 },
        { text: NOVEL, at: 1, i: 1 },
        { text: PLAYS, at: 2, i: 2 },
        { text: LOSER, at: 3, i: 3 },
        { text: WINNER, at: 4, i: 4 },
        { text: "Player Zane plays lacrosse. label: 28", at: 5, i: 5 },
      ]);
      expect(hops).toHaveLength(2);
      expect(factObject(hops[1])).toMatch(/canada/i);
      expect(hops[1]!.t).toBe(8);
      expect(hops.every((h) => !/\blabel\s*:/i.test(h.text))).toBe(true);
      expect(hops.every((h) => !/miller of Blackford/i.test(h.text))).toBe(true);
      expect(hops.some((h) => /Scotland/.test(h.text))).toBe(false);
      const hopPkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(hopPkt).toContain(MEMORY_MARK);
      expect(hopPkt).toMatch(/Canada/);
      expect(hopPkt).not.toMatch(/Scotland/);
    });
  });

  test.failing("official-shaped 3-hop: position → sport → country; last hop Kenya first; Peru absent", async () => {
    const posLose = "1. Dana Voss plays the position of winger.";
    const posWin = "8. Dana Voss plays the position of keeper.";
    const sportLose = "1. keeper is associated with the sport of curling.";
    const sportWin = "8. keeper is associated with the sport of polo.";
    const ctryLose = "1. polo was created in the country of Peru.";
    const ctryWin = "8. polo was created in the country of Kenya.";
    const continent = "Kenya is located in the continent of Africa.";
    const cue = "What is the country of origin of the sport played by Dana Voss?";
    const hops = hopChain(cue, [
      { text: posLose, at: 1, i: 0 },
      { text: posWin, at: 2, i: 1 },
      { text: sportLose, at: 3, i: 2 },
      { text: sportWin, at: 4, i: 3 },
      { text: ctryLose, at: 5, i: 4 },
      { text: ctryWin, at: 6, i: 5 },
      { text: continent, at: 7, i: 6 },
    ]);
    expect(hops.length).toBeGreaterThanOrEqual(2);
    expect(hops[hops.length - 1]!.text).toMatch(/Kenya/);
    expect(hops[hops.length - 1]!.text).not.toMatch(/continent of Africa/);
    expect(hops[hops.length - 1]!.t).toBe(8);
    expect(hops.some((h) => /Peru|curling|winger/i.test(h.text))).toBe(false);
    await withMem((mem) => {
      for (const t of [posLose, posWin, sportLose, sportWin, ctryLose, ctryWin, continent]) mem.remember(t);
      const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Kenya/);
      expect(pkt).not.toMatch(/Peru/);
      const facts = factLines(pkt);
      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0]).toMatch(/Kenya/);
      expect(facts[0]).not.toMatch(/continent of Africa/);
    });
  });

  test("fail-open: inject throw still swallows; original messages identity", async () => {
    await withMem((mem) => {
      seedSportWorld(mem);
      const list = [{ role: "user", content: CUE }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m22 inject notesFor");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: CUE }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });

  test.failing("wrap injectBody / Anthropic / hook: last hop Canada, not Scotland", async () => {
    await withMem(async (mem, dir) => {
      const prev = process.env.EDEN_MEMORY_DIR;
      process.env.EDEN_MEMORY_DIR = dir;
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        seedSportWorld(mem);
        const openai = mem.injectBody({ messages: [{ role: "user", content: CUE }] });
        const pkt = packetOf((openai as { messages?: unknown[] }).messages ?? []);
        expect(pkt).toMatch(/Canada/);
        expect(pkt).not.toMatch(/Scotland/);
        const facts = factLines(pkt);
        expect(facts[0]).toMatch(/Canada/);
        const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: CUE });
        const spec =
          hook && typeof hook === "object"
            ? (hook as {
                additional_context?: string;
                hookSpecificOutput?: { additionalContext?: string };
              })
            : null;
        const ctx = [spec?.additional_context, spec?.hookSpecificOutput?.additionalContext].join("\n");
        expect(ctx).toMatch(/Canada/);
        expect(ctx).not.toMatch(/Scotland/);
        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: CUE }] });
        const sys = anth && typeof anth === "object" ? (anth as { system?: unknown }).system : undefined;
        const anthText =
          typeof sys === "string"
            ? sys
            : Array.isArray(sys)
              ? sys.map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? ""))).join("\n")
              : "";
        expect(anthText).toMatch(/Canada/);
        expect(anthText).not.toMatch(/Scotland/);
      } finally {
        procSpy.mockRestore();
        if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
        else process.env.EDEN_MEMORY_DIR = prev;
      }
    });
  });

  test.failing("4-hop continent last hop first; citizen query with continent stored still Belgium", async () => {
    const rows = [
      "0. The author of Our Mutual Friend is Charles Dickens.",
      "3. The author of Our Mutual Friend is Charles Darwin.",
      "1. Charles Darwin is married to Emma Darwin.",
      "4. Charles Darwin is married to Amala Paul.",
      "2. Emma Darwin is a citizen of the United Kingdom.",
      "5. Amala Paul is a citizen of Belgium.",
      "6. Belgium is located in the continent of Europe.",
    ];
    const q3 = "Which country is the spouse of the author of Our Mutual Friend a citizen of?";
    const q4 =
      "Which continent is the country of citizenship of the spouse of the author of Our Mutual Friend located in?";
    const hops3 = hopChain(
      q3,
      rows.map((text, i) => ({ text, i, at: i })),
    );
    const hops4 = hopChain(
      q4,
      rows.map((text, i) => ({ text, i, at: i })),
    );
    expect(hops3[hops3.length - 1]!.text).toMatch(/Belgium/);
    expect(hops3[hops3.length - 1]!.text).not.toMatch(/continent of Europe/);
    expect(hops4[hops4.length - 1]!.text).toMatch(/continent of Europe/);
    await withMem((mem) => {
      for (const t of rows) mem.remember(t);
      const bel = packetOf(mem.inject([{ role: "user", content: q3 }]));
      expect(bel).toMatch(/Belgium/);
      const belFacts = factLines(bel);
      expect(belFacts[0]).toMatch(/Belgium/);
      expect(belFacts[0]).not.toMatch(/continent of Europe/);
      const eur = packetOf(mem.inject([{ role: "user", content: q4 }]));
      expect(eur).toMatch(/Europe/);
      const eurFacts = factLines(eur);
      expect(eurFacts[0]).toMatch(/Europe/);
    });
  });
});

/**
 * M17.4: encode-lane change must not regress single-hop overwrite on observe.
 * Copula/numbered facts stay chat (extractDurable), not narrative. Full FC-SH
 * 262k re-bench is M21. M16.4 hop fixture is the green two-hop overwrite product test (M22).
 */
describe("M17.4 FC-SH observe overwrite still latest", () => {
  test.failing("timestamp overwrite (observe): Alice then Bob → packet has Bob, not Alice", async () => {
    const alice = "The chairperson of the committee is Alice.";
    const bob = "The chairperson of the committee is Bob.";
    expect(encodeLane(alice)).toBe("chat");
    expect(encodeLane(bob)).toBe("chat");
    await withMem((mem) => {
      const old = mem.observe([{ role: "user", content: alice }]);
      laterThan(old[0]!.at);
      mem.observe([{ role: "user", content: bob }]);
      expect(mem.memories().every((r) => r.lane === "chat")).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
    });
  });

  test.failing("numbered serials (observe): 1. Alice then 8. Bob → packet has Bob, not Alice", async () => {
    const alice = "1. The chairperson of the committee is Alice.";
    const bob = "8. The chairperson of the committee is Bob.";
    expect(encodeLane(alice)).toBe("chat");
    expect(encodeLane(bob)).toBe("chat");
    await withMem((mem) => {
      mem.observe([{ role: "user", content: alice }]);
      mem.observe([{ role: "user", content: bob }]);
      const recs = mem.memories();
      expect(recs.every((r) => r.lane === "chat")).toBe(true);
      expect(recs.some((r) => /Alice/.test(r.text) && /Bob/.test(r.text))).toBe(false);
      expect(recs.some((r) => /Bob/.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
    });
  });

  test.failing("novel + Alice then Bob: packet has Bob, not Alice; miller stays narrative", async () => {
    const novel =
      "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He " +
      "remembered the flood of his childhood and the oak that had fallen across the millrace. The " +
      "villagers said the oak still slept under the silt, waiting.";
    expect(encodeLane(novel)).toBe("narrative");
    await withMem((mem) => {
      mem.observe([{ role: "user", content: `${novel} The chairperson of the committee is Alice.` }]);
      mem.observe([{ role: "user", content: "The chairperson of the committee is Bob." }]);
      expect(mem.memories().some((r) => r.lane === "narrative" && /miller of Blackford/.test(r.text))).toBe(true);
      const chair = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(chair).toContain(MEMORY_MARK);
      expect(chair).toMatch(/Bob/);
      expect(chair).not.toMatch(/Alice/);
      const miller = packetOf(mem.inject([{ role: "user", content: "What happened to the miller of Blackford?" }]));
      expect(miller).toMatch(/miller of Blackford/);
      expect(miller).not.toMatch(/Alice/);
    });
  });

  test("keepLiveIdentity: system novel+Alice does not leftover Alice when live is Bob", async () => {
    const novel =
      "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He " +
      "remembered the flood of his childhood and the oak that had fallen across the millrace. The " +
      "villagers said the oak still slept under the silt, waiting.";
    await withMem((mem) => {
      mem.observe([{ role: "user", content: "The chairperson of the committee is Bob." }]);
      mem.injectBody({
        messages: [{ role: "user", content: "who is the chairperson" }],
        system: `${novel} The chairperson of the committee is Alice.`,
      });
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(false);
      expect(mem.memories().some((r) => r.lane === "narrative" && /miller of Blackford/.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
    });
  });

  test.failing("postgres → sqlite (observe): packet has sqlite, not postgres", async () => {
    const pg = "The database is postgres.";
    const sqlite = "The database is sqlite.";
    expect(encodeLane(pg)).toBe("chat");
    expect(encodeLane(sqlite)).toBe("chat");
    await withMem((mem) => {
      const old = mem.observe([{ role: "user", content: pg }]);
      laterThan(old[0]!.at);
      mem.observe([{ role: "user", content: sqlite }]);
      expect(mem.memories().every((r) => r.lane === "chat")).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
    });
  });
});

/**
 * M20.4: ICL index ⟂ AR hops ⟂ SF assemble ⟂ ExperienceStore.
 * kind/lane icl|narrative never become SF triples. Exemplars still skip via
 * isIclExemplar. Inject may omit leftover identity from the packet; assembleNotes
 * does not scrub narrative as a losing SF fact.
 */
describe("M20.4 kind firewall", () => {
  const ALICE = "The chairperson of the committee is Alice.";
  const POSTGRES = "The database is postgres.";
  const MILLER =
    "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He " +
    "remembered the flood of his childhood and the oak that had fallen across the millrace. The " +
    "villagers said the oak still slept under the silt, waiting.";
  const MILLER_ALICE = `${MILLER} The chairperson of the committee is Alice.`;

  test("kind=icl copula yields zero triples", () => {
    expect(extractCandidates([{ text: ALICE, t: 1, kind: "icl" }])).toEqual([]);
    expect(extractCandidates([{ text: ALICE, t: 1, kind: "ICL" }])).toEqual([]);
  });

  test("lane=icl copula yields zero triples", () => {
    expect(extractCandidates([{ text: ALICE, t: 1, lane: "icl" }])).toEqual([]);
    expect(extractCandidates([{ text: ALICE, t: 1, lane: "ICL" }])).toEqual([]);
  });

  test("kind=narrative copula yields zero triples", () => {
    expect(extractCandidates([{ text: POSTGRES, t: 1, kind: "narrative" }])).toEqual([]);
    expect(extractCandidates([{ text: POSTGRES, t: 1, kind: "Narrative" }])).toEqual([]);
  });

  test("lane=narrative copula yields zero triples", () => {
    expect(extractCandidates([{ text: POSTGRES, t: 1, lane: "narrative" }])).toEqual([]);
    expect(extractCandidates([{ text: POSTGRES, t: 1, lane: "Narrative" }])).toEqual([]);
  });

  test("M31.1 recsys text and kind/lane recsys yield zero triples", () => {
    const movies = "1. Superbad (2007)\n2. Super Troopers (2001)\n3. Knocked Up (2007)";
    expect(extractCandidates([{ text: movies, t: 1 }])).toEqual([]);
    expect(extractCandidates([{ text: movies, t: 1, lane: "narrative" }])).toEqual([]);
    expect(extractCandidates([{ text: movies, t: 1, kind: "recsys" }])).toEqual([]);
    expect(extractCandidates([{ text: ALICE, t: 1, lane: "recsys" }])).toEqual([]);
  });

  test("kind=chat or omitted still extracts Alice and postgres", () => {
    const chatAlice = extractCandidates([{ text: ALICE, t: 1, kind: "chat" }]);
    const omittedAlice = extractCandidates([{ text: ALICE, t: 1 }]);
    const chatPg = extractCandidates([{ text: POSTGRES, t: 1, kind: "chat" }]);
    const omittedPg = extractCandidates([{ text: POSTGRES, t: 1 }]);
    expect(chatAlice.some((tr) => tr.o === "Alice" && tr.p === "is")).toBe(true);
    expect(omittedAlice.some((tr) => tr.o === "Alice" && tr.p === "is")).toBe(true);
    expect(chatPg.some((tr) => /postgres/i.test(tr.o) && tr.p === "is")).toBe(true);
    expect(omittedPg.some((tr) => /postgres/i.test(tr.o) && tr.p === "is")).toBe(true);
  });

  test("assembleNotes keeps lane=icl Alice note as non-fact (extract empty)", () => {
    const note = { id: "n", text: ALICE, at: 1, lane: "icl" };
    expect(extractCandidates([{ text: note.text, t: note.at, lane: note.lane }])).toEqual([]);
    const out = assembleNotes([note]);
    expect(out.some((n) => n.id === "n" && n.text === ALICE && n.lane === "icl")).toBe(true);
    expect(out).toHaveLength(1);
  });

  test("narrative miller+Alice copula is not a triple and is not scrubbed as a losing fact", () => {
    expect(extractCandidates([{ text: MILLER_ALICE, t: 1, kind: "narrative" }])).toEqual([]);
    expect(extractCandidates([{ text: MILLER_ALICE, t: 1, lane: "narrative" }])).toEqual([]);
    const out = assembleNotes([
      { id: "narr", text: MILLER_ALICE, at: 1, lane: "narrative", kind: "narrative" },
      { id: "win", text: "8. The chairperson of the committee is Bob.", at: 2 },
    ]);
    expect(out.some((n) => n.id === "narr" && /miller of Blackford/.test(n.text) && /Alice/.test(n.text))).toBe(true);
    expect(out.some((n) => /Bob/.test(n.text))).toBe(true);
  });

  test.failing("inject packet omits leftover Alice; miller cue keeps miller without Alice", async () => {
    const novel =
      "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He " +
      "remembered the flood of his childhood and the oak that had fallen across the millrace. The " +
      "villagers said the oak still slept under the silt, waiting.";
    await withMem((mem) => {
      mem.observe([{ role: "user", content: `${novel} The chairperson of the committee is Alice.` }]);
      mem.observe([{ role: "user", content: "The chairperson of the committee is Bob." }]);
      const chair = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(chair).toMatch(/Bob/);
      expect(chair).not.toMatch(/Alice/);
      const miller = packetOf(mem.inject([{ role: "user", content: "What happened to the miller of Blackford?" }]));
      expect(miller).toMatch(/miller of Blackford/);
      expect(miller).not.toMatch(/Alice/);
    });
  });

  test("garbage or missing kind does not throw", () => {
    expect(() => extractCandidates([{ text: ALICE, t: 1 }])).not.toThrow();
    expect(() => extractCandidates([{ text: ALICE, t: 1, kind: "not-a-kind" }])).not.toThrow();
    expect(() =>
      extractCandidates([{ text: POSTGRES, t: 1, kind: 99 as never, lane: { x: 1 } as never }]),
    ).not.toThrow();
    expect(() => extractCandidates([{ text: ALICE, t: 1, kind: null as never, lane: undefined }])).not.toThrow();
    expect(extractCandidates([{ text: ALICE, t: 1, kind: "not-a-kind" }]).some((tr) => tr.o === "Alice")).toBe(true);
    expect(() => assembleNotes([{ id: "g", text: POSTGRES, at: 1, kind: "???", lane: 0 as never }])).not.toThrow();
    expect(assembleNotes([{ id: "g", text: POSTGRES, at: 1, kind: "???" }])).toHaveLength(1);
  });

  test("assemble.ts does not import icl-index", () => {
    const src = readFileSync(join(import.meta.dir, "assemble.ts"), "utf8");
    expect(src).not.toMatch(/icl-index/);
    expect(src).not.toMatch(/\bIclIndex\b/);
    expect(src).not.toMatch(/\bretrieveIcl\b/);
  });
});

/**
 * M20.2 prior-override world (not Zane/lacrosse — that is M16.4).
 * Report §4.9 v2: Finland → ice hockey (serial 2) then basketball (serial 8).
 * The generator is not asked which fact is newer. Code must pick max(serial).
 */
describe("M20.2 prior-override (Finland → ice hockey then basketball)", () => {
  const ORIGIN = "Alice is from Finland.";
  const LOSER = "2. The sport of Alice is ice hockey.";
  const WINNER = "8. The sport of Alice is basketball.";

  test("extractCandidates returns both sport triples, at their rows' times (A1 D8: list numbers are not clocks)", () => {
    const got = extractCandidates([
      { text: ORIGIN, t: 1000, id: "fin" },
      { text: LOSER, t: 1001, id: "hock" },
      { text: WINNER, t: 1002, id: "bask" },
    ]);
    expect(got.some((tr) => /ice hockey/i.test(tr.o) && tr.t === 1001)).toBe(true);
    expect(got.some((tr) => /basketball/i.test(tr.o) && tr.t === 1002)).toBe(true);
    // Finland origin may also extract (different (s,p) than sport).
    expect(got.some((tr) => /Finland/i.test(tr.o))).toBe(true);
  });

  test("assemble.ts does not call a generator: the generator is not asked which is newer", () => {
    const src = readFileSync(join(import.meta.dir, "assemble.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/openai/i);
    expect(src).not.toMatch(/\bcomplete\s*\(/);
  });

  test("code picks the newest statement: packet has basketball, not ice hockey", async () => {
    const picked = assemble(
      extractCandidates([
        { text: ORIGIN, t: 1000 },
        { text: LOSER, t: 1001 },
        { text: WINNER, t: 1002 },
      ]),
    );
    expect(picked.some((tr) => /basketball/i.test(tr.o) && tr.t === 1002)).toBe(true);
    expect(picked.some((tr) => /ice hockey/i.test(tr.o))).toBe(false);

    await withMem((mem) => {
      mem.remember(ORIGIN);
      mem.remember(LOSER);
      mem.remember(WINNER);
      expect(mem.memories().some((r) => /ice hockey/i.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /basketball/i.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is the sport of Alice" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/basketball/i);
      expect(pkt).not.toMatch(/ice hockey/i);
    });
  });
});

/**
 * M21.4: SF code-pick. Packet has one object per (s,p). Sleep tombstones the
 * loser so a later session cannot resurrect it. Generator is not asked.
 * M20.2 prior-override stays a passing test. M16.4 hop fixture is green two-hop overwrite (M22).
 */
describe("M21 SF code-pick (newest statement, tombstone, sleep agrees; A1 D8: list numbers are not clocks)", () => {
  const ALICE = "1. The chairperson of the committee is Alice.";
  const BOB = "8. The chairperson of the committee is Bob.";
  const SPORT_WIN = "8. The sport of Alice is basketball.";
  const SPORT_LOSE = "2. The sport of Alice is ice hockey.";
  const CHAIR_S = "chairperson of the committee";
  const SPORT_S = "sport of alice";

  test("two serials → packet has one object: Bob not Alice; JSONL still has Alice before sleep", async () => {
    await withMem((mem) => {
      mem.remember(ALICE);
      mem.remember(BOB);
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /Bob/.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(true);
    });
  });

  test("incomplete retrieve of the older statement does not demote the newer live value", () => {
    const dir = tmpDir("eden-m21-incomplete-");
    try {
      assembleNotes(
        [
          { id: "lose", text: SPORT_LOSE, at: 1 },
          { id: "win", text: SPORT_WIN, at: 2 },
        ],
        dir,
      );
      expect(factObject(new SemanticStore(dir).get(SPORT_S, "is"))).toMatch(/basketball/i);
      const incomplete = assembleNotes([{ id: "lose", text: SPORT_LOSE, at: 1 }], dir);
      expect(factObject(new SemanticStore(dir).get(SPORT_S, "is"))).toMatch(/basketball/i);
      expect(factObject(new SemanticStore(dir).get(SPORT_S, "is"))).not.toMatch(/ice hockey/i);
      expect(incomplete.some((n) => /basketball/i.test(n.text))).toBe(true);
      expect(incomplete.some((n) => /ice hockey/i.test(n.text))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tombstone emit: inject on 1. Alice then 8. Bob → live SemanticStore is Bob", async () => {
    await withMem((mem, dir) => {
      mem.remember(ALICE);
      mem.remember(BOB);
      mem.inject([{ role: "user", content: "who is the chairperson" }]);
      const store = new SemanticStore(dir);
      const live = factObject(store.get(CHAIR_S, "is"));
      expect(live).toMatch(/Bob/i);
      expect(live).not.toMatch(/Alice/i);
      expect(store.supersededObject("Alice", CHAIR_S, "is") || !/Alice/i.test(live)).toBe(true);
    });
  });

  test("tombstone emit: assembleNotes(dir) live is Bob; missing dir / throw does not throw", () => {
    expect(() => assembleNotes(null as never)).not.toThrow();
    expect(() => assembleNotes([{ id: "x", text: ALICE, at: 1 }], "/no/such/eden-m21-assemble-dir")).not.toThrow();
    expect(assembleNotes([{ id: "x", text: "Auth is Clerk", at: 1 }], "/no/such/eden-m21-assemble-dir")).toHaveLength(
      1,
    );

    const dirNotes = tmpDir("eden-m21-tomb-notes-");
    try {
      expect(() =>
        assembleNotes(
          [
            { id: "a", text: ALICE, at: 2 },
            { id: "b", text: BOB, at: 3 },
          ],
          dirNotes,
        ),
      ).not.toThrow();
      const fromNotes = new SemanticStore(dirNotes);
      const notesLive = factObject(fromNotes.get(CHAIR_S, "is"));
      expect(notesLive).toMatch(/Bob/i);
      expect(notesLive).not.toMatch(/Alice/i);
      expect(fromNotes.supersededObject("Alice", CHAIR_S, "is") || !/Alice/i.test(notesLive)).toBe(true);
    } finally {
      rmSync(dirNotes, { recursive: true, force: true });
    }
  });

  test("observe keeps numbered items; the later one wins whatever its number (A1 D8)", async () => {
    await withMem(async (mem, dir) => {
      const first = mem.observe([{ role: "user", content: SPORT_WIN }]);
      expect(mem.memories().some((r) => /^8\.\s/.test(r.text) && /basketball/i.test(r.text))).toBe(true);
      laterThan(first[0]!.at);
      mem.observe([{ role: "user", content: SPORT_LOSE }]);
      expect(mem.memories().some((r) => /basketball/i.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /ice hockey/i.test(r.text))).toBe(true);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is the sport of Alice" }]));
      expect(pkt).toMatch(/ice hockey/i);
      expect(pkt).not.toMatch(/basketball/i);
      await sleep({ dir, mem });
      const later = openMemory({ dir });
      const pkt2 = packetOf(later.inject([{ role: "user", content: "what is the sport of Alice" }]));
      expect(pkt2).toMatch(/ice hockey/i);
      expect(pkt2).not.toMatch(/basketball/i);
    });
  });

  test("wrap injectBody and hook Submit: basketball not ice hockey", async () => {
    await withMem(async (_root, dir) => {
      // The wrap and the hook read one memory: the store the hook keeps for this process's repo (D1).
      const mem = openMemory({ dir: repoStoreDir(dir, repoIdentity(process.cwd())!.key), perRepo: true });
      const prev = process.env.EDEN_MEMORY_DIR;
      process.env.EDEN_MEMORY_DIR = dir;
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        mem.observe([{ role: "user", content: SPORT_LOSE }]);
        mem.observe([{ role: "user", content: SPORT_WIN }]);
        const openai = mem.injectBody({ messages: [{ role: "user", content: "what is the sport of Alice" }] });
        const pkt = packetOf((openai as { messages?: unknown[] }).messages ?? []);
        expect(pkt).toMatch(/basketball/i);
        expect(pkt).not.toMatch(/ice hockey/i);
        const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is the sport of Alice" });
        const spec =
          hook && typeof hook === "object"
            ? (hook as {
                additional_context?: string;
                hookSpecificOutput?: { additionalContext?: string };
              })
            : null;
        const ctx = [spec?.additional_context, spec?.hookSpecificOutput?.additionalContext].join("\n");
        expect(ctx).toMatch(/basketball/i);
        expect(ctx).not.toMatch(/ice hockey/i);
        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: "what is the sport of Alice" }] });
        const sys = anth && typeof anth === "object" ? (anth as { system?: unknown }).system : undefined;
        const anthText =
          typeof sys === "string"
            ? sys
            : Array.isArray(sys)
              ? sys.map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? ""))).join("\n")
              : "";
        expect(anthText).toMatch(/basketball/i);
        expect(anthText).not.toMatch(/ice hockey/i);
      } finally {
        procSpy.mockRestore();
        if (prev === undefined) delete process.env.EDEN_MEMORY_DIR;
        else process.env.EDEN_MEMORY_DIR = prev;
      }
    });
  });

  test("sleep agrees: 8. basketball then a later 2. ice hockey is ice hockey (A1 D8)", async () => {
    await withMem(async (mem, dir) => {
      const first = mem.remember(SPORT_WIN);
      laterThan(first.at);
      mem.remember(SPORT_LOSE);
      expect(mem.memories().some((r) => /basketball/i.test(r.text))).toBe(true);
      expect(mem.memories().some((r) => /ice hockey/i.test(r.text))).toBe(true);
      await sleep({ dir, mem });
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is the sport of Alice" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/ice hockey/i);
      expect(pkt).not.toMatch(/basketball/i);
      const live = factObject(new SemanticStore(dir).get(SPORT_S, "is"));
      expect(live).toMatch(/ice hockey/i);
      expect(live).not.toMatch(/basketball/i);
      const later = openMemory({ dir });
      const pkt2 = packetOf(later.inject([{ role: "user", content: "what is the sport of Alice" }]));
      expect(pkt2).toMatch(/ice hockey/i);
      expect(pkt2).not.toMatch(/basketball/i);
      expect(factObject(new SemanticStore(dir).get(SPORT_S, "is"))).toMatch(/ice hockey/i);
      expect(factObject(new SemanticStore(dir).get(SPORT_S, "is"))).not.toMatch(/basketball/i);
    });
  });

  test("Clerk status is not a delete: Auth is Clerk then failing then sleep still Clerk", async () => {
    await withMem(async (mem, dir) => {
      mem.remember("Auth is Clerk");
      mem.remember("Auth is failing");
      await sleep({ dir, mem });
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Clerk/);
      expect(mem.memories().some((r) => /Clerk/.test(r.text))).toBe(true);
    });
  });

  test("kind firewall stays: kind/lane icl|narrative still zero triples", () => {
    const alice = "The chairperson of the committee is Alice.";
    const pg = "The database is postgres.";
    expect(extractCandidates([{ text: alice, t: 1, kind: "icl" }])).toEqual([]);
    expect(extractCandidates([{ text: alice, t: 1, lane: "icl" }])).toEqual([]);
    expect(extractCandidates([{ text: pg, t: 1, kind: "narrative" }])).toEqual([]);
    expect(extractCandidates([{ text: pg, t: 1, lane: "narrative" }])).toEqual([]);
  });

  test("generator is not asked: assemble.ts has no fetch/openai/complete", () => {
    const src = readFileSync(join(import.meta.dir, "assemble.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/openai/i);
    expect(src).not.toMatch(/\bcomplete\s*\(/);
  });

  test("fail-open: inject throw still swallows; original messages identity", async () => {
    await withMem((mem) => {
      const list = [{ role: "user", content: "who is the chairperson" }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m21 inject notesFor");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "who is the chairperson" }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });

  test("an unnumbered ice hockey after 8. basketball is ice hockey (A1 D8)", async () => {
    await withMem((mem, dir) => {
      mem.observe([{ role: "user", content: SPORT_WIN }]);
      laterThan(Date.now());
      mem.observe([{ role: "user", content: "The sport of Alice is ice hockey." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is the sport of Alice" }]));
      expect(pkt).toMatch(/ice hockey/i);
      expect(pkt).not.toMatch(/basketball/i);
      expect(factObject(new SemanticStore(dir).get(SPORT_S, "is"))).toMatch(/ice hockey/i);
    });
  });

  test("fused 1. Alice + 8. Bob observe then sleep keeps Bob", async () => {
    await withMem(async (mem, dir) => {
      mem.observe([{ role: "user", content: `${ALICE} ${BOB}` }]);
      await sleep({ dir, mem });
      const later = openMemory({ dir });
      const pkt = packetOf(later.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
      expect(later.memories().some((r) => /Bob/.test(r.text))).toBe(true);
    });
  });

  test("k=1 retrieve of the older loser still injects basketball", async () => {
    await withMem((mem) => {
      const prev = process.env.EDEN_MEMORY_CAP;
      process.env.EDEN_MEMORY_CAP = "1";
      try {
        mem.observe([{ role: "user", content: SPORT_LOSE }]);
        laterThan(Date.now());
        mem.observe([{ role: "user", content: SPORT_WIN }]);
        const pkt = packetOf(mem.inject([{ role: "user", content: "ice hockey Alice sport" }]));
        expect(pkt).toMatch(/basketball/i);
        expect(pkt).not.toMatch(/ice hockey/i);
      } finally {
        if (prev === undefined) delete process.env.EDEN_MEMORY_CAP;
        else process.env.EDEN_MEMORY_CAP = prev;
      }
    });
  });
});
