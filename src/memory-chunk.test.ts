/**
 * M18.1 / M18.2 chunk store + narrative retrieve. M18.4 anti-GraphRAG.
 * Tests lock the agreed API so D can flip red → green. Not BrainMemory.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { CHUNK_TARGET_TOKENS, ChunkStore, chunkText, reconstruct } from "./chunk-store";
import { retrieveNarrativeChunks } from "./chunk-retrieve";
import { encodeLane, MEMORY_MARK, openMemory, queryHay, type AgentMemory, injectedPackets } from "./index";
import * as edenMem from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/40

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

const FILLER = [
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

type ChunkLike = string | { text?: string; body?: string; content?: string };

function wsNorm(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function wsTokens(s: string): string[] {
  return wsNorm(s).split(" ").filter(Boolean);
}

function chunkBody(c: ChunkLike): string {
  if (typeof c === "string") return c;
  return String(c.text ?? c.body ?? c.content ?? "");
}

/** chunkText returns strings; reconstruct joins `{ i, text }` (ChunkStore.all()). */
function toReconstruct(chunks: unknown): { i: number; text: string }[] {
  if (!Array.isArray(chunks)) return [];
  return chunks.map((c, i) => {
    if (typeof c === "string") return { i, text: c };
    const o = c && typeof c === "object" ? (c as { i?: number; text?: string }) : {};
    return { i: typeof o.i === "number" ? o.i : i, text: chunkBody(c as ChunkLike) };
  });
}

function maxSentenceTokens(s: string): number {
  const parts = s.split(/(?<=[.!?])\s+/).map((x) => wsTokens(x).length);
  return Math.max(1, ...parts);
}

function longStory(minToks: number, rare?: { name: string; atTok?: number }): string {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  let placed = !rare;
  const rareAt = rare?.atTok ?? Math.floor(minToks / 2);
  while (n < minToks || !placed) {
    if (rare && !placed && n >= rareAt) {
      const s = `The accident at ${rare.name} mill flooded the lower field that season.`;
      parts.push(s);
      n += wsTokens(s).length;
      placed = true;
      continue;
    }
    const s = FILLER[i % FILLER.length]!;
    parts.push(s);
    n += wsTokens(s).length;
    i++;
  }
  return parts.join(" ");
}

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function classMethodSrc(src: string, name: string, stop: string): string {
  const start = src.indexOf(`\n  ${name}(`);
  if (start < 0) return "";
  const end = src.indexOf(`\n  ${stop}(`, start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

function bannedRetrieveNames(src: string): string[] {
  const code = codeWithoutComments(src).replace(/['"`][^'"`]*not\s+graphrag[^'"`]*['"`]/gi, "");
  const hits: string[] = [];
  if (/\bcompleteNotes\b/.test(code)) hits.push("completeNotes");
  if (/\bhopChain\b/.test(code)) hits.push("hopChain");
  if (/cls\/complete/.test(code)) hits.push("complete.ts");
  if (/icl-index/.test(code)) hits.push("icl-index");
  if (/\bBrainMemory\b/.test(code)) hits.push("BrainMemory");
  if (/\bgraphrag\b/i.test(code)) hits.push("graphrag");
  if (/\braptor\b/i.test(code)) hits.push("raptor");
  if (/memory_search/.test(code)) hits.push("memory_search");
  return hits;
}

function packetOf(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function packetNotes(pkt: string): string[] {
  return pkt.split("\n").filter((l) => l.startsWith("- "));
}

function tmpDir(prefix = "eden-m184-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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

function withMem(fn: (mem: AgentMemory, dir: string) => void): void {
  const dir = tmpDir();
  try {
    fn(openMemory({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function chunksJsonl(dir: string): string {
  const p = join(dir, "chunks.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

const ICL_SHOT = "The movie was great. label: 28";
const FACT_LIST = [
  "1. The chairperson of the committee is Alice.",
  "2. The sport of Alice is ice hockey.",
  "3. Auth is Clerk for every login at the company.",
].join("\n");

describe("M18.1 chunkText reconstructible", () => {
  test("2k-token story → >1 chunk; reconstructible", () => {
    const story = longStory(2000);
    expect(wsTokens(story).length).toBeGreaterThanOrEqual(2000);
    expect(CHUNK_TARGET_TOKENS).toBe(512);
    const chunks = chunkText(story);
    expect(chunks.length).toBeGreaterThan(1);
    const slack = maxSentenceTokens(story);
    for (const c of chunks) {
      expect(wsTokens(chunkBody(c)).length).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS + slack);
    }
    expect(wsNorm(reconstruct(toReconstruct(chunks)))).toBe(wsNorm(story));
  });
});

describe("M18.1 ChunkStore persist", () => {
  test("ChunkStore persist reconstructible", () => {
    const dir = tmpDir("eden-m181-store-");
    try {
      const story = longStory(2000);
      const store = new ChunkStore(dir);
      store.put(story);
      expect(store.all().length).toBeGreaterThan(1);
      expect(wsNorm(reconstruct(store.all()))).toBe(wsNorm(story));
      expect(existsSync(join(dir, "chunks.jsonl"))).toBe(true);
      const again = new ChunkStore(dir);
      expect(again.all().length).toBeGreaterThan(1);
      expect(wsNorm(reconstruct(again.all()))).toBe(wsNorm(story));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M18.2 narrative retrieve", () => {
  test.failing("rare name cue returns the chunk that contains it", () => {
    withMem((mem, dir) => {
      const story = longStory(2500, { name: "Blackford", atTok: 700 });
      expect(encodeLane(story)).toBe("narrative");
      expect(wsTokens(story).filter((w) => w === "Blackford").length).toBe(1);
      mem.observe([{ role: "user", content: story }]);
      const cue = "What happened at Blackford mill?";
      const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(pkt).toMatch(new RegExp(MEMORY_MARK));
      expect(pkt).toMatch(/Blackford/);
      const hits = [...mem.relevant(cue, 10), ...mem.notesFor(cue, 10)];
      expect(hits.some((h) => /Blackford/.test(h.text))).toBe(true);
      const chunks = new ChunkStore(dir).all();
      expect(chunks.length).toBeGreaterThan(1);
      const named = chunks.filter((c) => /Blackford/.test(chunkBody(c)));
      const filler = chunks.filter((c) => !/Blackford/.test(chunkBody(c)));
      expect(named.length).toBeGreaterThan(0);
      expect(filler.length).toBeGreaterThan(0);
      expect(hits[0]?.text).toMatch(/Blackford/);
      const ranked = retrieveNarrativeChunks(dir, cue, { k: 10 });
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked.length).toBeLessThanOrEqual(10);
      expect(ranked[0]?.text).toMatch(/Blackford/);
      expect(named.every((c) => !FILLER.includes(chunkBody(c).trim() as (typeof FILLER)[number]))).toBe(true);
    });
  });

  test("k=10 bound on narrative retrieve/inject", () => {
    withEnv({ EDEN_MEMORY_CAP: "10" }, () => {
      withMem((mem, dir) => {
        const story = longStory(7000);
        expect(encodeLane(story)).toBe("narrative");
        mem.observe([{ role: "user", content: story }]);
        expect(new ChunkStore(dir).all().length).toBeGreaterThan(10);
        const cue = "the miller walked beside the river that ran through the valley";
        expect(mem.relevant(cue, 10).length).toBeLessThanOrEqual(10);
        expect(mem.notesFor(cue, 10).length).toBeLessThanOrEqual(10);
        const notes = packetNotes(packetOf(mem.inject([{ role: "user", content: cue }])));
        expect(notes.length).toBeLessThanOrEqual(10);
      });
    });
  });
});

describe("M18.1 encode firewall", () => {
  test("ICL and facts are not chunked", () => {
    withMem((mem, dir) => {
      expect(encodeLane(ICL_SHOT)).toBe("icl");
      expect(encodeLane("Auth is Clerk")).toBe("chat");
      mem.observe([{ role: "user", content: ICL_SHOT }]);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: FACT_LIST }]);
      const story = longStory(2000);
      expect(encodeLane(story)).toBe("narrative");
      mem.observe([{ role: "user", content: story }]);
      expect(existsSync(join(dir, "chunks.jsonl"))).toBe(true);
      const blob = chunksJsonl(dir);
      expect(blob.length).toBeGreaterThan(0);
      expect(blob).not.toMatch(/label:\s*28/);
      expect(blob).not.toMatch(/Auth is Clerk/);
      expect(blob).not.toMatch(/chairperson of the committee is Alice/);
      expect(blob).toMatch(/miller walked beside the river/);
      const texts = new ChunkStore(dir).all().map(chunkBody).join("\n");
      expect(texts).not.toMatch(/label:\s*28/);
      expect(texts).not.toMatch(/Auth is Clerk/);
    });
  });
});

describe("M18.4 narrative retrieve is not GraphRAG", () => {
  test.failing("narrative retrieve is not GraphRAG / not complete / not icl-index", () => {
    const relevantSrc = classMethodSrc(INDEX_SRC, "relevant", "notesFor");
    const mergeMatch = INDEX_SRC.match(
      /function mergeNarrativeLane[\s\S]*?(?=\n(?:export )?function |\nexport class |\n  [a-zA-Z])/,
    );
    const mergeSrc = mergeMatch?.[0] ?? "";
    // M33 dispatcher may name the `"icl-index"` route. EventQA miller is chat-jsonl:
    // mergeNarrativeLane still must not call the ICL index or GraphRAG.
    expect(bannedRetrieveNames(mergeSrc)).toEqual([]);
    expect(mergeSrc).not.toMatch(/retrieveIcl|mergeIclLane|icl-index/);
    const afterIclDispatch = relevantSrc.replace(/if \(route === "icl-index"\) \{[\s\S]*?\n    \}/, "");
    expect(afterIclDispatch).not.toMatch(/retrieveIcl|mergeIclLane/);
    expect(bannedRetrieveNames(afterIclDispatch.replace(/["']icl-index["']/g, '""'))).toEqual([]);
    expect(relevantSrc).not.toMatch(/\bcomplete\s*\(/);

    const injectSrc = classMethodSrc(INDEX_SRC, "inject", "injectBody");
    expect(injectSrc).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(injectSrc).toMatch(/completeNotes\s*\(/);
    expect(injectSrc).not.toMatch(/if\s*\(\s*cue\s*\)\s*packet\s*=\s*completeNotes/);
    expect(injectSrc).toMatch(/skipNarrativeComplete/);
    expect(injectSrc).toMatch(/hopStore/);
    expect(injectSrc).toMatch(/skipNarrativeComplete\(\s*retrieved/);
    expect(injectSrc).toMatch(/completeNotes[\s\S]*assembleNotes[\s\S]*completeNotes/);
    expect(INDEX_SRC).not.toMatch(/peelIdentitySentences/);
    expect(INDEX_SRC).toMatch(/for \(const raw of extractDurable\(it\.text\)\)/);

    for (const name of ["chunk-store.ts", "chunk-retrieve.ts"] as const) {
      const p = join(import.meta.dir, name);
      if (!existsSync(p)) continue;
      expect(bannedRetrieveNames(readFileSync(p, "utf8")), name).toEqual([]);
    }
  });
});

describe("M18.1 secrets + fail-open + chat", () => {
  test("secrets still redacted in stored chunks", () => {
    withMem((mem, dir) => {
      const story = `${longStory(800)} The deploy token is sk-abc123XYZ999. The github token is ghp_abc123XYZ999.`;
      expect(encodeLane(story)).toBe("narrative");
      mem.observe([{ role: "user", content: story }]);
      const store = new ChunkStore(dir);
      store.put(story);
      const blob = `${chunksJsonl(dir)}\n${store.all().map(chunkBody).join("\n")}`;
      expect(store.all().length).toBeGreaterThan(0);
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
      expect(blob).not.toContain("sk-abc123XYZ999");
      expect(blob).not.toContain("ghp_abc123XYZ999");
    });
  });

  test("fail-open: inject pass-through if retrieve or ChunkStore.all throws", () => {
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    withMem((mem) => {
      const list = [{ role: "user", content: "What happened at Blackford mill?" }];
      mem.relevant = (() => {
        throw new Error("m18.4 retrieve boom");
      }) as typeof mem.relevant;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "What happened at Blackford mill?" }]);
    });
    withMem((mem) => {
      mem.observe([{ role: "user", content: longStory(2200, { name: "Blackford" }) }]);
      const boom = spyOn(ChunkStore.prototype, "all").mockImplementation(() => {
        throw new Error("m18.4 ChunkStore.all boom");
      });
      try {
        const list = [{ role: "user", content: "What happened at Blackford mill?" }];
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("chat-only still works: Auth is Clerk inject still has Clerk", () => {
    withMem((mem) => {
      expect(() => {
        mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      }).not.toThrow();
      let out: unknown[] = [];
      expect(() => {
        // A cue naming Clerk would be its own residual (D26, the wrap's since P0.7).
        out = mem.inject([{ role: "user", content: "What auth provider do we use?" }]) as unknown[];
      }).not.toThrow();
      expect(packetOf(out)).toMatch(/Clerk/);
      expect(mem.memories().some((r) => /Clerk/.test(r.text))).toBe(true);
    });
  });
});

describe("M18 leftover identity + empty cue + torn JSONL", () => {
  const NOVEL =
    "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He " +
    "remembered the flood of his childhood and the oak that had fallen across the millrace. The " +
    "villagers said the oak still slept under the silt, waiting.";

  test("queryHay does not inject LoCoMo diet hay", () => {
    expect(queryHay("best restaurant").has("diet")).toBe(false);
    expect(queryHay("what diet am I on").has("diet")).toBe(true);
  });

  test("peelIdentitySentences is gone; extractDurable is not on the narrative branch", () => {
    expect(INDEX_SRC).not.toMatch(/peelIdentitySentences/);
    const observeSrc = classMethodSrc(INDEX_SRC, "observe", "flush");
    const nar = observeSrc.indexOf('lane === "icl" || lane === "narrative"');
    const extract = observeSrc.indexOf("extractDurable(");
    expect(nar).toBeGreaterThanOrEqual(0);
    expect(extract).toBeGreaterThan(nar);
    expect(observeSrc.slice(nar, extract)).toMatch(/\bcontinue;/);
    expect(observeSrc).toMatch(
      /lanes\[i\] === "icl" \|\| lanes\[i\] === "narrative" \? \[\] : this\.durables\(it\.text\)/,
    );
    expect(observeSrc).not.toMatch(/extractDurable\(extractSrc\)/);
  });

  test.failing("novel+Alice then Bob: miller cue packet has miller, not leftover Alice", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: `${NOVEL} The chairperson of the committee is Alice.` }]);
      mem.observe([{ role: "user", content: "The chairperson of the committee is Bob." }]);
      const miller = packetOf(mem.inject([{ role: "user", content: "What happened to the miller of Blackford?" }]));
      expect(miller).toMatch(/miller of Blackford/);
      expect(miller).not.toMatch(/Alice/);
      const chair = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(chair).toMatch(/Bob/);
      expect(chair).not.toMatch(/Alice/);
    });
  });

  test("a body's system novel+Alice is the host's text (D12): nothing of it is stored; live Bob still injects", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "The chairperson of the committee is Bob." }]);
      mem.injectBody({
        messages: [{ role: "user", content: "who is the chairperson" }],
        system: `${NOVEL} The chairperson of the committee is Alice.`,
      });
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(false);
      expect(mem.memories().some((r) => /miller of Blackford/.test(r.text))).toBe(false);
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
    });
  });

  test("empty cue / SessionStart do not dump narrative chunks", () => {
    withMem((mem, dir) => {
      const story = longStory(2200, { name: "Blackford" });
      mem.observe([{ role: "user", content: story }]);
      expect(new ChunkStore(dir).all().length).toBeGreaterThan(1);
      const empty = mem.notesFor("");
      expect(empty.some((r) => /Blackford|miller walked beside the river/i.test(r.text))).toBe(false);
      expect(packetOf(mem.inject([{ role: "user", content: "" }]))).not.toMatch(/Blackford/);
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const start = memoryHookResponse({ hook_event_name: "SessionStart" });
        const ctx = [
          start?.additional_context,
          (start?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext,
        ]
          .map((x) => String(x ?? ""))
          .join("\n");
        expect(ctx).not.toMatch(/Blackford/);
        expect(ctx).not.toMatch(/miller walked beside the river/);
      });
    });
  });

  test.failing("torn chunks.jsonl does not throw on inject; Blackford still hits", () => {
    withMem((mem, dir) => {
      const story = longStory(2500, { name: "Blackford", atTok: 700 });
      mem.observe([{ role: "user", content: story }]);
      const path = join(dir, "chunks.jsonl");
      expect(existsSync(path)).toBe(true);
      appendFileSync(path, '{not json\n{"id":"x","text":\n');
      const list = [{ role: "user", content: "What happened at Blackford mill?" }];
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
      expect(packetOf(out as unknown[])).toMatch(/Blackford/);
    });
  });

  test.failing("complete() does not hop novels: miller cue has miller, not Canada", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: longStory(2200, { name: "Blackford" }) }]);
      mem.observe([{ role: "user", content: "Player Zane plays lacrosse." }]);
      mem.observe([{ role: "user", content: "8. Lacrosse originated in Canada." }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "What happened at Blackford mill?" }]));
      expect(pkt).toMatch(/Blackford/);
      expect(pkt).not.toMatch(/Canada/);
    });
  });
});

describe("M18 wrap + hook miller/Blackford + Clerk + fail-open", () => {
  test.failing("injectBody / Anthropic / hook still inject Clerk and Blackford; fail-open on retrieve throw", () => {
    const dir = tmpDir("eden-m18-wrap-");
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        mem.observe([{ role: "user", content: "Auth is Clerk" }]);
        mem.observe([{ role: "user", content: longStory(2500, { name: "Blackford", atTok: 700 }) }]);

        const openaiClerk = mem.injectBody({
          messages: [{ role: "user", content: "What auth provider do we use for Clerk?" }],
        });
        expect(packetOf((openaiClerk.messages as unknown[]) ?? [])).toMatch(/Clerk/);
        const openaiNar = mem.injectBody({ messages: [{ role: "user", content: "What happened at Blackford mill?" }] });
        expect(packetOf((openaiNar.messages as unknown[]) ?? [])).toMatch(/Blackford/);

        const anthClerk = withKnowFactsAnthropic({
          messages: [{ role: "user", content: "What auth provider do we use for Clerk?" }],
        });
        expect(JSON.stringify(anthClerk)).toMatch(/Clerk/);
        const anthNar = withKnowFactsAnthropic({
          messages: [{ role: "user", content: "What happened at Blackford mill?" }],
        });
        expect(JSON.stringify(anthNar)).toMatch(/Blackford/);

        const hookClerk = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: "What auth provider do we use for Clerk?",
        });
        const hookNar = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: "What happened at Blackford mill?",
        });
        const hookHay = `${JSON.stringify(hookClerk ?? {})}\n${JSON.stringify(hookNar ?? {})}`;
        expect(hookHay).toMatch(/Clerk/);
        expect(hookHay).toMatch(/Blackford/);

        const wrapBody = { messages: [{ role: "user", content: "What happened at Blackford mill?" }] };
        const wrapOut = withKnowFacts(wrapBody);
        expect(packetOf((wrapOut.messages as unknown[]) ?? [])).toMatch(/Blackford/);

        mem.relevant = (() => {
          throw new Error("m18 wrap retrieve boom");
        }) as typeof mem.relevant;
        const boomList = [{ role: "user", content: "What happened at Blackford mill?" }];
        const boomBody = { messages: boomList };
        expect(mem.inject(boomList)).toBe(boomList);
        expect(mem.injectBody(boomBody)).toBe(boomBody);
        expect(withKnowFacts(boomBody)).toBe(boomBody);
        expect(withKnowFactsAnthropic({ messages: boomList }).messages).toEqual(boomList);
      });
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrap/hook product files are not BrainMemory dual-API", () => {
    for (const rel of ["../packages/wrap/src/know-inject.ts", "../packages/cli/src/memory-hook.ts"] as const) {
      const src = readFileSync(join(import.meta.dir, rel), "utf8");
      expect(src).not.toMatch(/\bBrainMemory\b/);
      expect(src).not.toMatch(/\bmemory_search\b/);
    }
  });
});
