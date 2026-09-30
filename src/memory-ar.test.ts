/**
 * M27.1 AR multi-hit fusion. Product path is openMemory inject, not BrainMemory.
 * CombMNZ + 1-hop neighbor spread over BM25 chunk hits. No skipSemantic, no ICL index.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_TARGET_TOKENS, ChunkStore, chunkText, estimateTokens } from "./chunk-store";
import { bm25Rank, retrieveNarrativeChunks } from "./chunk-retrieve";
import { fuseArHits } from "./cls/controller";
import * as controller from "./cls/controller";
import { encodeLane, MEMORY_MARK, openMemory, type AgentMemory } from "./index";
import * as edenMem from "./index";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools } from "../packages/wrap/src/tool-observe";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/38

const NEEDLE = "The special magic number of zebra-quark-17 is 48291.";
const GOLD = "48291";
const QUERY = "What is the special magic number of zebra-quark-17?";
const ICL_SHOT = "The movie was great. label: 28";
const ENTITY = "zebra-quark-17 lives in the north wing.";
const VALUE = "The special magic number is 48291 for that occupant.";

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

function tmpDir(prefix = "eden-m271-"): string {
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

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function pad(seed: number, minToks: number): string {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < minToks) {
    const s = `${FILLER[i % FILLER.length]!.replace(/\.$/, "")} near marker ${seed}-${i}.`;
    parts.push(s);
    n += estimateTokens(s);
    i++;
  }
  return parts.join(" ");
}

function buriedStory(): string {
  return `${pad(1, CHUNK_TARGET_TOKENS * 2)} ${NEEDLE} ${pad(2, CHUNK_TARGET_TOKENS * 2)}`;
}

function splitStory(): string {
  const entityToks = estimateTokens(ENTITY);
  let prefixToks = Math.max(8, CHUNK_TARGET_TOKENS - entityToks - 6);
  for (let attempt = 0; attempt < 48; attempt++) {
    const story = `${pad(1, prefixToks)} ${ENTITY} ${VALUE} ${pad(2, CHUNK_TARGET_TOKENS + 64)}`;
    const chunks = chunkText(story);
    const ei = chunks.findIndex((c) => /zebra-quark-17/.test(c));
    const vi = chunks.findIndex((c) => /48291/.test(c));
    if (ei >= 0 && vi === ei + 1 && !/48291/.test(chunks[ei]!)) return story;
    prefixToks += 6;
  }
  throw new Error("m27.1 could not force an adjacent-chunk split needle");
}

describe("M27.1 buried needle in inject packet", () => {
  test.failing("rare needle buried in filler chunks is in the inject packet after retrieve", () => {
    withEnv({ EDEN_MEMORY_CAP: "10" }, () => {
      withMem((mem, dir) => {
        const story = buriedStory();
        expect(encodeLane(story)).toBe("narrative");
        expect(chunkText(story).length).toBeGreaterThan(1);
        mem.observe([{ role: "user", content: story }]);
        expect(new ChunkStore(dir).all().some((c) => c.text.includes(GOLD))).toBe(true);
        const hits = retrieveNarrativeChunks(dir, QUERY, { k: 10 });
        expect(hits.some((h) => h.text.includes(GOLD))).toBe(true);
        const pkt = packetOf(mem.inject([{ role: "user", content: QUERY }]));
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toContain(GOLD);
      });
    });
  });
});

describe("M27.1 adjacent-chunk split needle", () => {
  test.failing("entity in chunk i and value in chunk i+1 still injects 48291", () => {
    withEnv({ EDEN_MEMORY_CAP: "10" }, () => {
      withMem((mem, dir) => {
        const story = splitStory();
        expect(encodeLane(story)).toBe("narrative");
        const viaChunker = chunkText(story);
        const ei = viaChunker.findIndex((c) => /zebra-quark-17/.test(c));
        const vi = viaChunker.findIndex((c) => /48291/.test(c));
        expect(ei).toBeGreaterThanOrEqual(0);
        expect(vi).toBe(ei + 1);
        expect(viaChunker[ei]!).not.toMatch(/48291/);

        mem.observe([{ role: "user", content: story }]);
        const stored = new ChunkStore(dir).all();
        const sei = stored.findIndex((c) => /zebra-quark-17/.test(c.text));
        const svi = stored.findIndex((c) => /48291/.test(c.text));
        expect(sei).toBeGreaterThanOrEqual(0);
        expect(svi).toBe(sei + 1);
        expect(stored[sei]!.src).toBe(stored[svi]!.src);

        const hits = retrieveNarrativeChunks(dir, QUERY, { k: 10 });
        expect(hits.some((h) => h.text.includes(GOLD))).toBe(true);
        const pkt = packetOf(mem.inject([{ role: "user", content: QUERY }]));
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toContain(GOLD);
      });
    });
  });
});

describe("M27.1 ICL isolation on SH cue", () => {
  test.failing("ICL shots in the same store do not beat the SH needle", () => {
    withEnv({ EDEN_MEMORY_CAP: "10" }, () => {
      withMem((mem) => {
        for (let i = 0; i < 8; i++) {
          mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
        }
        mem.observe([{ role: "user", content: ICL_SHOT }]);
        mem.observe([{ role: "user", content: buriedStory() }]);
        const pkt = packetOf(mem.inject([{ role: "user", content: QUERY }]));
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toContain(GOLD);
        expect(pkt).not.toMatch(/label:\s*28/);
      });
    });
  });
});

describe("M27.1 fail-open fuseArHits", () => {
  test("if fuseArHits throws, retrieveNarrativeChunks still returns BM25", () => {
    withMem((_mem, dir) => {
      const story = buriedStory();
      new ChunkStore(dir).put(story, { src: "nar-1", t: 1 });
      const docs = new ChunkStore(dir).all().map((c) => c.text);
      expect(docs.length).toBeGreaterThan(1);
      const expected = bm25Rank(QUERY, docs, 10).map((r) => docs[r.i]!);
      const boom = spyOn(controller, "fuseArHits").mockImplementation(() => {
        throw new Error("m27.1 fuseArHits boom");
      });
      try {
        expect(() => retrieveNarrativeChunks(dir, QUERY, { k: 10 })).not.toThrow();
        const hits = retrieveNarrativeChunks(dir, QUERY, { k: 10 });
        expect(hits.map((h) => h.text)).toEqual(expected);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("empty cue still returns []", () => {
    expect(fuseArHits("", [{ text: NEEDLE, score: 1 }], 10)).toEqual([]);
    withMem((_mem, dir) => {
      new ChunkStore(dir).put(buriedStory(), { src: "nar-empty", t: 1 });
      expect(retrieveNarrativeChunks(dir, "", { k: 10 })).toEqual([]);
    });
  });
});

describe("M27.1 fuseLane G>B lock — no skipSemantic, no max-norm semantic", () => {
  test.failing("controller fuseLane stays a*(1+0.15*bRaw+0.2*cRaw) and fuseArHits does not require skipSemantic", () => {
    const ctrl = readFileSync(join(import.meta.dir, "cls/controller.ts"), "utf8");
    expect(ctrl).toContain("a * (1 + 0.15 * bRaw + 0.2 * cRaw)");
    expect(ctrl).toMatch(/export function fuseArHits/);
    const fuseAr = ctrl.slice(ctrl.indexOf("export function fuseArHits"));
    expect(fuseAr).not.toMatch(/skipSemantic/);
    expect(fuseAr).not.toMatch(/this\.norm\(/);
    const retrieveSrc = readFileSync(join(import.meta.dir, "chunk-retrieve.ts"), "utf8");
    expect(retrieveSrc).not.toMatch(/icl-index|retrieveIcl|\bIclIndex\b/);
    expect(retrieveSrc).not.toMatch(/\bBrainMemory\b/);

    const many = Array.from({ length: 12 }, (_, i) => ({
      text: `filler miller river valley chunk ${i}`,
      score: 1 / (1 + i),
      src: "s",
      id: `chunk:s:${i}`,
      i,
    }));
    many[3] = { text: NEEDLE, score: 0.2, src: "s", id: "chunk:s:3", i: 3 };
    const fused = fuseArHits(QUERY, many, 3);
    expect(fused.length).toBeLessThanOrEqual(3);
    expect(fused.some((h) => h.text.includes(GOLD))).toBe(true);
    expect(() => fuseArHits(QUERY, null as unknown as [], 10)).not.toThrow();
    expect(fuseArHits(QUERY, many, 0)).toEqual([]);
  });
});

function anthMemoryText(body: { system?: unknown }): string {
  const sys = body.system;
  const parts = typeof sys === "string"
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

describe("M27 wrap OpenAI / Anthropic / hook zebra-quark + fail-open", () => {
  test.failing("injectBody / withKnowFacts / Anthropic / hook still inject 48291; ICL shots stay out", () => {
    const dir = tmpDir("eden-m27-wrap-");
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0", EDEN_MEMORY_CAP: "10" }, () => {
        mem.observe([{ role: "user", content: ICL_SHOT }]);
        for (let i = 0; i < 8; i++) mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
        mem.observe([{ role: "user", content: buriedStory() }]);
        mem.observe([{ role: "user", content: "Auth is Clerk" }]);

        const openai = mem.injectBody({ messages: [{ role: "user", content: QUERY }] });
        const oaiPkt = packetOf((openai.messages as unknown[]) ?? []);
        expect(oaiPkt).toContain(MEMORY_MARK);
        expect(oaiPkt).toContain(GOLD);
        expect(oaiPkt).not.toMatch(/label:\s*28/);

        const helper = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: QUERY }] });
        expect(packetOf((helper.messages as unknown[]) ?? [])).toContain(GOLD);

        const wrap = withKnowFacts({ messages: [{ role: "user", content: QUERY }] });
        expect(packetOf((wrap.messages as unknown[]) ?? [])).toContain(GOLD);

        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: QUERY }] });
        const aPkt = anthMemoryText(anth);
        expect(aPkt).toContain(GOLD);
        expect(aPkt).not.toMatch(/label:\s*28/);

        const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: QUERY });
        const hk = hookMemoryText(hook);
        expect(hk).toContain(GOLD);
        expect(hk).not.toMatch(/label:\s*28/);

        const clerkPkt = packetOf(mem.inject([{ role: "user", content: "What auth provider do we use for Clerk?" }]));
        expect(clerkPkt).toMatch(/Clerk/);
        expect(clerkPkt).not.toMatch(/48291/);
        expect(clerkPkt).not.toMatch(/miller walked beside the river/);
      });
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retrieve throw → original messages on inject / injectBody / wrap / Anthropic / hook", () => {
    const dir = tmpDir("eden-m27-failopen-");
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    const boom = spyOn(edenMem.AgentMemory.prototype, "relevant").mockImplementation(() => {
      throw new Error("m27 relevant boom");
    });
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        const list = [{ role: "user", content: QUERY }];
        expect(mem.inject(list)).toBe(list);
        const body = { messages: list };
        expect(mem.injectBody(body)).toBe(body);
        expect(withKnowFacts(body)).toBe(body);
        const anth = { messages: [{ role: "user", content: QUERY }] };
        expect(withKnowFactsAnthropic(anth)).toBe(anth);
        expect(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: QUERY })).toBeNull();
      });
    } finally {
      boom.mockRestore();
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M27.1 fuseArHits cue-gate leftover miller", () => {
  test.failing("Clerk cue does not keep stopword-only miller BM25 hits; k default 10", () => {
    const miller = { text: "The miller walked beside the river that ran through the valley at dawn.", score: 0.9, src: "s", id: "chunk:s:0", i: 0 };
    const needle = { text: NEEDLE, score: 0.2, src: "s", id: "chunk:s:1", i: 1 };
    const clerkCue = "What auth provider do we use for Clerk?";
    expect(fuseArHits(clerkCue, [miller, needle], 10)).toEqual([]);
    const def = fuseArHits(QUERY, [miller, needle]);
    expect(def.length).toBeLessThanOrEqual(10);
    expect(def.length).toBeGreaterThan(0);
    expect(def.every((h) => h.text.includes(GOLD) || /zebra-quark/.test(h.text))).toBe(true);
    expect(def.some((h) => h.text.includes(GOLD))).toBe(true);
  });
});
