/**
 * M16.2 lane types. Import isolation: lanes are not BrainMemory as product.
 * M17 flipped M16.3: ICL/narrative store-all; chat still extractDurable.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_TARGET_TOKENS, estimateTokens } from "./chunk-store";
import { retrieveNarrativeChunks } from "./chunk-retrieve";
import { hopChain } from "./cls/complete";
import { encodeLane, MEMORY_MARK, openMemory } from "./index";
import {
  MEMORY_LANE_KINDS,
  type ArHopMechanism,
  type IclIndexForbiddenFrom,
  type IclIndexMechanism,
  type MemoryLaneKind,
} from "./memory-lanes";
import { isRecsysShot } from "./semantic-store";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/54

const LANES_SRC = readFileSync(join(import.meta.dir, "memory-lanes.ts"), "utf8");

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("M16.2 lane types", () => {
  test("memory-lanes.ts does not import brain-memory or BrainMemory", () => {
    const code = codeWithoutComments(LANES_SRC);
    expect(code).not.toMatch(/\bBrainMemory\b/);
    expect(code).not.toMatch(/brain-memory/);
    expect(code).not.toMatch(/\bfrom\s+['"][^'"]*brain-memory[^'"]*['"]/);
    expect(code).not.toMatch(/\bimport\s*\(\s*['"][^'"]*brain-memory[^'"]*['"]/);
    expect(code).not.toMatch(/\brequire\s*\(\s*['"][^'"]*brain-memory[^'"]*['"]/);
  });

  test("kinds are icl | narrative | fact | trajectory | chat", () => {
    const kinds: MemoryLaneKind[] = [...MEMORY_LANE_KINDS];
    expect(kinds).toEqual(["icl", "narrative", "fact", "trajectory", "chat"]);
    expect(new Set(kinds).size).toBe(5);
  });

  test("documents ICL index ⟂ AR hops ⟂ SF assemble ⟂ ExperienceStore", () => {
    expect(LANES_SRC).toMatch(/ICL index/);
    expect(LANES_SRC).toMatch(/AR hops/);
    expect(LANES_SRC).toMatch(/SF assemble/);
    expect(LANES_SRC).toMatch(/ExperienceStore/);
    expect(LANES_SRC).toMatch(/FC-MH 7/);
    expect(LANES_SRC).toMatch(/extractDurable/);
    expect(LANES_SRC).toMatch(/silent inject/i);
    expect(LANES_SRC).toMatch(/memory_search/);
    expect(LANES_SRC).toMatch(/Fail-open/);
    expect(LANES_SRC).toMatch(/k=10/);
    expect(LANES_SRC).toMatch(/label-strip/);
    expect(LANES_SRC).toMatch(/No BrainMemory column/);
  });

  test("types only: no retrieve functions", () => {
    const code = codeWithoutComments(LANES_SRC);
    expect(code).not.toMatch(/\bfunction\b/);
    expect(code).not.toMatch(/\bretrieve\s*\(/);
    expect(code).not.toMatch(/\bexport\s+(async\s+)?function\b/);
  });

  test("types only: no import/require (cannot pull BrainMemory as product)", () => {
    const code = codeWithoutComments(LANES_SRC);
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bexport\s+\*\s+from\b/);
  });

  test("narrative is chunks, not AR hops or GraphRAG EventQA", () => {
    expect(LANES_SRC).toMatch(/narrative:\s*"chunks"/);
    expect(LANES_SRC).toMatch(/EventQA/);
    expect(LANES_SRC).toMatch(/Not GraphRAG/);
    expect(LANES_SRC).toMatch(/type ArHopMechanism = "ar-hops"/);
    expect(codeWithoutComments(LANES_SRC)).not.toMatch(/narrative:\s*"ar-hops"/);
    expect([...MEMORY_LANE_KINDS]).not.toContain("retrieve");
  });
});

function withMem(fn: (mem: ReturnType<typeof openMemory>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m163-"));
  try {
    fn(openMemory({ dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stored(mem: ReturnType<typeof openMemory>): string[] {
  return mem.memories().map((r) => r.text);
}

/** Short ICL shot — store-all including `label:`. */
const ICL_SHORT = "The movie was great. label: 28";
/** >400 chars. M16 dropped this; M17 stores the whole exemplar. */
const ICL_LONG =
  "The movie review is glowing and mentions every scene in detail about the protagonist and the village festival that lasted three nights under lanterns while the orchestra played until dawn and the crowd wept. label: 28 extra filler words to exceed four hundred characters of extractDurable tax so we can see if the whole exemplar is dropped or chopped into pieces by the allow-list pipeline that is still the only encode path.";
/** EventQA-class prose. M16 sentence-split; M17 stores the whole paragraph. */
const NOVEL_PARA =
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He remembered the flood of his childhood and the oak that had fallen across the millrace. The villagers said the oak still slept under the silt, waiting.";
const NOVEL_SPLIT = [
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley",
  "He remembered the flood of his childhood and the oak that had fallen across the millrace",
  "The villagers said the oak still slept under the silt, waiting",
] as const;
/** One sentence, no period, >400 chars. M16 dropped; M17 stores whole. */
const NOVEL_LONG =
  "It was the best of times it was the worst of times it was the age of wisdom it was the age of foolishness it was the epoch of belief it was the epoch of incredulity it was the season of light it was the season of darkness it was the spring of hope it was the winter of despair we had everything before us we had nothing before us we were all going direct to heaven we were all going direct the other way.";
/** Chat allow-list miss. Chat still extractDurable. */
const NOVEL_ALLOW_DROP = "Nobody mentioned the letter.";

describe("M17 encode lanes (flipped M16.3 extract tax)", () => {
  test("chat path still calls extractDurable", () => {
    const indexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(indexSrc).toMatch(/for \(const raw of extractDurable\(it\.text\)\)/);
    expect(indexSrc).toMatch(/function extractDurable/);
    expect(indexSrc).not.toMatch(/peelIdentitySentences/);
    expect(indexSrc).not.toMatch(/\blet\s+extractSrc\s*=\s*it\.text/);
    expect(indexSrc).toMatch(/lane === "icl" \|\| lane === "narrative"/);
  });

  test("ICL shot stored whole including label:", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: ICL_SHORT }]);
      expect(stored(mem)).toEqual([ICL_SHORT]);
      expect(stored(mem)[0]).toContain("label: 28");
      expect(mem.memories()[0]?.lane).toBe("icl");
    });
    withMem((mem) => {
      expect(ICL_LONG.length).toBeGreaterThan(400);
      mem.observe([{ role: "user", content: ICL_LONG }]);
      expect(stored(mem)).toEqual([ICL_LONG]);
      expect(mem.memories()[0]?.lane).toBe("icl");
    });
  });

  test("novel paragraph stored whole, not chopped to 400 / allow-list", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: NOVEL_PARA }]);
      expect(stored(mem)).toEqual([NOVEL_PARA]);
      expect(stored(mem)).not.toEqual([...NOVEL_SPLIT]);
      expect(mem.memories()[0]?.lane).toBe("narrative");
    });
    withMem((mem) => {
      expect(NOVEL_LONG.length).toBeGreaterThan(400);
      mem.observe([{ role: "user", content: NOVEL_LONG }]);
      expect(stored(mem)).toEqual([NOVEL_LONG]);
      expect(mem.memories()[0]?.lane).toBe("narrative");
    });
  });

  test("chat extractDurable still runs; allow-list miss is kept as episode so the user does not restate", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: NOVEL_ALLOW_DROP }]);
      expect(stored(mem).some((t) => /letter/i.test(t))).toBe(true);
      expect(mem.memories().some((r) => r.kind === "episode" && /letter/i.test(r.text))).toBe(true);
    });
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Please fix the flake in auth.test.ts" }]);
      expect(stored(mem).some((t) => /auth\.test\.ts/.test(t))).toBe(true);
      expect(mem.memories().every((r) => (r.lane || "chat") === "chat")).toBe(true);
    });
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      expect(stored(mem).some((t) => /^Auth is Clerk\.?$/.test(t))).toBe(true);
      expect(mem.memories().filter((r) => /Clerk/i.test(r.text)).length).toBe(1);
      expect(mem.memories().every((r) => (r.lane || "chat") === "chat")).toBe(true);
    });
    withMem((mem) => {
      mem.observe([{ role: "user", content: "The chairperson of the committee is Alice." }]);
      expect(stored(mem).some((t) => /Alice/.test(t))).toBe(true);
      expect(mem.memories().every((r) => (r.lane || "chat") === "chat")).toBe(true);
    });
  });

  test("copula buried in novel stays store-all; miller stays narrative", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: `${NOVEL_PARA} The chairperson of the committee is Alice.` }]);
      const recs = mem.memories();
      const novel = recs.find((r) => r.lane === "narrative");
      expect(novel?.text).toContain("miller of Blackford");
      expect(novel?.lane).toBe("narrative");
      // peelIdentitySentences is gone: narrative is not extractDurable'd into chat slices.
      expect(readFileSync(join(import.meta.dir, "index.ts"), "utf8")).not.toMatch(/peelIdentitySentences/);
    });
  });

  test.failing("M31.1 recsys is narrative store-all; ICL and chat stay isolated", () => {
    const movies = "1. Superbad (2007)\n2. Super Troopers (2001)\n3. Knocked Up (2007)";
    const redial =
      "You are a movie recommender. Here is the conversation:\nUser: I like Superbad (2007)\nSystem: Super Troopers (2001) is similar.";
    const miller = NOVEL_PARA;
    const detqa = `Lichem Rocchi's method of death was certainly not ( )
A. Murder
B. Sudden death
C. Suicide
D. Sudden illness`;
    expect(encodeLane("The movie was great. label: 28")).toBe("icl");
    expect(isRecsysShot("The movie was great. label: 28")).toBe(false);
    expect(encodeLane("Auth is Clerk")).toBe("chat");
    expect(encodeLane("Use postgres")).toBe("chat");
    expect(encodeLane("8. The chairperson is Bob")).toBe("chat");
    expect(isRecsysShot(miller)).toBe(false);
    expect(encodeLane(miller)).toBe("narrative");
    expect(isRecsysShot(detqa)).toBe(false);
    expect(isRecsysShot(movies)).toBe(true);
    expect(encodeLane(movies)).toBe("narrative");
    expect(isRecsysShot(redial)).toBe(true);
    expect(encodeLane(redial)).toBe("narrative");
    expect(encodeLane("recommend movies")).toBe("narrative");
    withMem((mem) => {
      mem.observe([{ role: "user", content: movies }]);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      const recs = mem.memories();
      const recsys = recs.find((r) => (r.tags ?? []).includes("recsys"));
      expect(recsys?.lane).toBe("narrative");
      expect(recsys?.text).toMatch(/Superbad \(2007\)/);
      expect(recsys?.text).toMatch(/Knocked Up \(2007\)/);
      expect(recs.some((r) => r.lane === "chat" && /Auth is Clerk/.test(r.text))).toBe(true);
      expect(recs.some((r) => r.lane === "chat" && /Superbad/.test(r.text))).toBe(false);
    });
  });

  test("secrets still redacted on ICL and narrative store-all", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "The movie was great. label: 28 token sk-abc123XYZ999" }]);
      mem.observe([{ role: "user", content: `${NOVEL_PARA} The github token is ghp_abc123XYZ999.` }]);
      const blob = stored(mem).join("\n");
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
      expect(stored(mem).some((t) => /label:\s*28/.test(t))).toBe(true);
      expect(stored(mem).some((t) => /miller of Blackford/.test(t))).toBe(true);
    });
  });
});

/** M27.3 SH retrieve isolation. openMemory inject only — not BrainMemory as product. */
const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const SH_RETRIEVE_FILES = [
  "chunk-retrieve.ts",
  "cls/controller.ts",
  "cls/episodic.ts",
  "assemble.ts",
  "cls/complete.ts",
] as const;
const MH_HOP_FILES = ["cls/complete.ts"] as const;
const ICL_GOLD = "The movie was great. label: 28";
const ICL_NEAR = [
  "The film was excellent. label: 7",
  "The cinema was wonderful. label: 14",
  "The picture was outstanding. label: 3",
  "The screening was superb. label: 11",
  "The acting was brilliant. label: 19",
  "The plot was gripping. label: 22",
  "The ending was perfect. label: 5",
  "The soundtrack was soaring. label: 9",
  "The cinematography was lush. label: 16",
] as const;
const ZEBRA_NEEDLE = "The special magic number of zebra-quark-17 is 48291.";
const ZEBRA_CUE = "What is the special magic number of zebra-quark-17?";
const NARRATIVE_FILLER = [
  "The miller walked beside the river that ran through the valley at dawn.",
  "Villagers said the oak still slept under the silt waiting for summer rain.",
  "Fog hung low over the marsh and the herons waited on one leg.",
  "Carts rattled over the stone bridge after the harvest wagons were loaded.",
  "Children skipped pebbles across the millpond until the geese protested.",
] as const;

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function mergeNarrativeLaneBody(src: string): string {
  const block = src.match(/function mergeNarrativeLane[\s\S]*?(?=\nfunction mergeIclLane)/)?.[0] ?? "";
  const brace = block.indexOf("{");
  return brace >= 0 ? block.slice(brace) : "";
}

function buriedZebraNarrative(): string {
  const head: string[] = [];
  const tail: string[] = [];
  for (let i = 0; i < 40; i++) {
    head.push(NARRATIVE_FILLER[i % NARRATIVE_FILLER.length]!);
    tail.push(NARRATIVE_FILLER[(i + 2) % NARRATIVE_FILLER.length]!);
  }
  return `${head.join(" ")} ${ZEBRA_NEEDLE} ${tail.join(" ")}`;
}

function withMemDir(fn: (mem: ReturnType<typeof openMemory>, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m273-"));
  try {
    fn(openMemory({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("M27.3 SH retrieve does not read icl-index", () => {
  test("M16.2 lane split: ICL index ⟂ AR hops", () => {
    expect(LANES_SRC).toMatch(/ICL index ⟂ AR hops/);
    expect(LANES_SRC).toMatch(/icl:\s*"icl-index"/);
    expect(LANES_SRC).toMatch(/type ArHopMechanism = "ar-hops"/);
    expect(LANES_SRC).toMatch(/IclIndexForbiddenFrom = ArHopMechanism/);
    const icl: IclIndexMechanism = "icl-index";
    const ar: ArHopMechanism = "ar-hops";
    const forbidden: IclIndexForbiddenFrom = "ar-hops";
    expect(icl).toBe("icl-index");
    expect(ar).toBe("ar-hops");
    expect(forbidden).toBe("ar-hops");
    expect(icl).not.toBe(ar);
  });

  test("source freeze: SH retrieve files do not contain icl-index / retrieveIcl / IclIndex", () => {
    for (const rel of SH_RETRIEVE_FILES) {
      const src = readFileSync(join(import.meta.dir, rel), "utf8");
      expect(src, rel).not.toMatch(/icl-index/);
      expect(src, rel).not.toMatch(/\bretrieveIcl\b/);
      expect(src, rel).not.toMatch(/\bIclIndex\b/);
    }
  });

  test("mergeNarrativeLane body does not call retrieveIcl", () => {
    const body = mergeNarrativeLaneBody(INDEX_SRC);
    expect(body).toMatch(/^\{/);
    expect(body).toMatch(/\bretrieveNarrativeChunks\b/);
    expect(body).not.toMatch(/\bretrieveIcl\b/);
    expect(body).not.toMatch(/\bIclIndex\b/);
    expect(body).not.toMatch(/icl-index/);
  });

  test.failing("SH inject of zebra-quark needle is not dominated by ICL label: shots", () => {
    withMemDir((mem, dir) => {
      mem.observe([{ role: "user", content: ICL_GOLD }]);
      for (const shot of ICL_NEAR) mem.observe([{ role: "user", content: shot }]);
      const story = buriedZebraNarrative();
      expect(encodeLane(story)).toBe("narrative");
      mem.observe([{ role: "user", content: story }]);

      const cue = ZEBRA_CUE;
      const chunkSrc = readFileSync(join(import.meta.dir, "chunk-retrieve.ts"), "utf8");
      expect(chunkSrc).toMatch(/\bretrieveNarrativeChunks\b/);
      expect(chunkSrc).not.toMatch(/icl-index/);
      expect(INDEX_SRC).toMatch(/from\s+["']\.\/chunk-retrieve["']/);

      const hits = retrieveNarrativeChunks(dir, cue, { k: 10 });
      expect(hits.some((h) => /48291|zebra-quark-17/.test(h.text))).toBe(true);

      const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      expect(pkt).toMatch(new RegExp(MEMORY_MARK));
      expect(pkt).toMatch(/48291|zebra-quark-17/);
      expect(pkt).not.toMatch(/label:\s*28/);
    });
  });

  test("chat fact cue Auth is Clerk does not pull ICL shots", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: ICL_GOLD }]);
      for (const shot of ICL_NEAR) mem.observe([{ role: "user", content: shot }]);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "Auth is Clerk" }]));
      expect(pkt).toMatch(/Clerk/);
      expect(pkt).not.toMatch(/label:\s*28/);
      expect(pkt).not.toMatch(/The movie was great/i);
    });
  });

  test.failing("fail-open: inject catch still pass-through (memoryInjectSwallows)", () => {
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/injectBody\(body[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{[\s\S]*pass-through/);
  });
});

const MH_DIRECTOR_NEEDLE = 'The romantic comedy "Big Stone Gap" was directed by Adriana Trigiani.';
const MH_BASED_NEEDLE = "Adriana Trigiani is based in Greenwich Village, New York City.";
const MH_CUE = 'The director of the romantic comedy "Big Stone Gap" is based in what New York city?';

function millerPad(seed: number, minToks: number): string {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < minToks) {
    const s = `${NARRATIVE_FILLER[i % NARRATIVE_FILLER.length]!.replace(/\.$/, "")} near marker ${seed}-${i}.`;
    parts.push(s);
    n += estimateTokens(s);
    i++;
  }
  return parts.join(" ");
}

function buryMhNeedle(needle: string, seed: number): string {
  const needleToks = estimateTokens(needle);
  const each = Math.max(32, Math.floor((CHUNK_TARGET_TOKENS - needleToks) / 2));
  return `${millerPad(seed, each)} ${needle} ${millerPad(seed + 100, each)}`;
}

describe("M28 MH hop ICL isolation", () => {
  test("source freeze: MH hop files do not contain icl-index / retrieveIcl / IclIndex", () => {
    for (const rel of [...SH_RETRIEVE_FILES, ...MH_HOP_FILES]) {
      const src = readFileSync(join(import.meta.dir, rel), "utf8");
      expect(src, rel).not.toMatch(/icl-index/);
      expect(src, rel).not.toMatch(/\bretrieveIcl\b/);
      expect(src, rel).not.toMatch(/\bIclIndex\b/);
    }
  });

  test("hopChain on ICL label: shots is empty", () => {
    const shots = [ICL_GOLD, ...ICL_NEAR.slice(0, 8)].map((text, i) => ({ text, at: i, i, id: `icl${i}` }));
    expect(hopChain(MH_CUE, shots)).toEqual([]);
    expect(hopChain("The movie was great. label:", shots)).toEqual([]);
    expect(hopChain(MH_CUE, [{ text: ICL_GOLD, at: 0, i: 0, id: "gold" }])).toEqual([]);
  });

  test.failing("MH cue with ICL gold + 8 near-dup + 2-hop narrative has Greenwich not label: 28", () => {
    withMemDir((mem) => {
      mem.observe([{ role: "user", content: ICL_GOLD }]);
      for (const shot of ICL_NEAR.slice(0, 8)) mem.observe([{ role: "user", content: shot }]);
      const directorStory = buryMhNeedle(MH_DIRECTOR_NEEDLE, 1);
      const basedStory = buryMhNeedle(MH_BASED_NEEDLE, 2);
      expect(encodeLane(directorStory)).toBe("narrative");
      expect(encodeLane(basedStory)).toBe("narrative");
      mem.observe([{ role: "user", content: directorStory }]);
      mem.observe([{ role: "user", content: basedStory }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: MH_CUE }]));
      expect(pkt).toMatch(new RegExp(MEMORY_MARK));
      expect(pkt).toMatch(/Greenwich Village/i);
      expect(pkt).not.toMatch(/label:\s*28/);
    });
  });

  test.failing("fail-open: inject catch still pass-through (memoryInjectSwallows)", () => {
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/injectBody\(body[\s\S]*catch \{\s*memoryInjectSwallows\.n\+\+/);
    expect(INDEX_SRC).toMatch(/inject\(messages[\s\S]*catch \{[\s\S]*pass-through/);
  });

  test.failing("hopStore includes ChunkStore chunks, excludes ICL; skipNarrativeComplete still skips ICL", () => {
    const hopBlock = INDEX_SRC.match(/const hopStore = \(\(\) => \{[\s\S]*?return out;\s*\}\)\(\);/)?.[0] ?? "";
    expect(hopBlock).toMatch(/new ChunkStore\(this\.howtoDir\)\.all\(\)/);
    expect(hopBlock).toMatch(/lane === "icl" \|\| isIclExemplar/);
    expect(hopBlock).not.toMatch(/\/\\\?\/\.test\(text\)/);
    expect(hopBlock).toMatch(/isNarrativeNote\(m\) && !\(m\.tags \?\? \[\]\)\.includes\("chunk"\)/);
    expect(INDEX_SRC).toMatch(/function skipNarrativeComplete[\s\S]*isIclCue\(cue\)\) return true/);
    expect(INDEX_SRC).toMatch(/function skipNarrativeComplete[\s\S]*lane === "icl" \|\| isIclExemplar/);
    const complete = readFileSync(join(import.meta.dir, "cls/complete.ts"), "utf8");
    expect(complete).not.toMatch(/icl-index/);
    expect(complete).toMatch(/if \(\/\\\?\/\.test\(String\(text/);
  });

  test("AR avg is mean of four named leaves or FAIL/missing, never missing-as-0", () => {
    const py = readFileSync(join(import.meta.dir, "../benchmarks/memoryagentbench/run-table3-inject.py"), "utf8");
    expect(py).toMatch(/ar_vals = \[v for v in \(sh, mh, lme, eventqa\) if isinstance\(v, \(int, float\)\)\]/);
    expect(py).toMatch(/ar = mean\(ar_vals\) if len\(ar_vals\) == 4 else None/);
    expect(py).toMatch(/if v is None:\s*\n\s*return "FAIL\/missing"/);
    expect(py).not.toMatch(/ar = mean\(ar_vals\) if ar_vals else 0/);
    expect(py).not.toMatch(/ar_vals or \[0\]/);
  });
});
