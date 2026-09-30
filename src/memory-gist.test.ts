/**
 * M29.4 gist retrieve / empty-cue / packet-cap tests.
 * Product path is openMemory inject + sleep, not BrainMemory. No memory_search. No GraphRAG.
 *
 * M29.1 gist-retrieve contract (import when the module exists):
 *   retrieveGists(dir, cue)
 *   isSummaryCue(cue)
 *   GIST_CHAR_CAP (1200)
 *   promoteNarrativeGists (optional)
 */
import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { CHUNK_TARGET_TOKENS, ChunkStore, chunkText, estimateTokens } from "./chunk-store";
import * as completeMod from "./cls/complete";
import { GistStore } from "./gist-store";
import { encodeLane, MEMORY_MARK, openMemory, sleep, type AgentMemory } from "./index";
import * as edenMem from "./index";
import { isIclExemplar } from "./semantic-store";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/49

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

const RARE = "The lantern-keeper at Quellbridge mill signed the flood ledger in ochre ink.";
const RARE_RE = /Quellbridge|ochre|flood ledger/i;
const SUMMARIZE = "Please summarize the book.";
const SUMMARIZE_HOOK = "summarize the book";
const EVENTQA = "What happened to the miller by the river?";
const ICL_CUE = "The movie was great. label:";
const ICL_SHOT = "The movie was great. label: 28";
/** Official InfBench_sum cue: few-shot `Summary:` shots + "summarize the book". */
const INFBENCH_CUE = `You are given a book above and you are tasked to summarize it.

Write a summary of about 1000 to 1200 words. Only write about the plot and characters of the story.

For example:

[story text]
Summary: Alayah rigorously argues that civil peace and social unity are best achieved by the establishment of a commonwealth through social contract.

[story text]
Summary: Halley Darlene is born in a workhouse in 1830s England.

Now summarize the book.`;
const SESSION = "s-m294-gist";
const GIST_CAP = 1200;
const K = 10;

const GIST_RETRIEVE_PATH = join(import.meta.dir, "gist-retrieve.ts");
const gistRetrieveReady = existsSync(GIST_RETRIEVE_PATH);

type GistHit = { text?: string; id?: string; t?: number } | string;
type GistRetrieveApi = {
  retrieveGists?: (dir: string, cue: string, opts?: { k?: number }) => GistHit[];
  isSummaryCue?: (cue: string) => boolean;
  GIST_CHAR_CAP?: number;
  promoteNarrativeGists?: (dir: string, session?: string) => void;
};

const gistApi: GistRetrieveApi = gistRetrieveReady ? await import("./gist-retrieve") : {};
const { retrieveGists, isSummaryCue, GIST_CHAR_CAP, promoteNarrativeGists } = gistApi;

const m291 = describe.skipIf(!gistRetrieveReady);

function wsTokens(s: string): string[] {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function tokCount(s: string): number {
  return Math.max(wsTokens(s).length, estimateTokens(s));
}

function padFiller(minToks: number, seed = 0): string {
  const parts: string[] = [];
  let n = 0;
  let i = seed;
  while (n < minToks) {
    const s = FILLER[i % FILLER.length]!;
    parts.push(s);
    n += tokCount(s);
    i++;
  }
  return parts.join(" ");
}

function firstSent(chunk: string): string {
  return (
    String(chunk ?? "")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * ≥800 tokens. Rare marker is the first sentence of a middle chunk so hierarchical
 * extractive maps (first-sentence even-pick) keep it — BM25 on “summarize the book”
 * would not rank that sentence top-1.
 */
function longBook(minToks = 800): string {
  let prefixToks = CHUNK_TARGET_TOKENS;
  const suffix = padFiller(Math.max(minToks - CHUNK_TARGET_TOKENS, CHUNK_TARGET_TOKENS + 24), 3);
  for (let attempt = 0; attempt < 64; attempt++) {
    const prefix = padFiller(prefixToks, 1);
    const story = `${prefix} ${RARE} ${suffix}`;
    if (tokCount(story) < minToks) {
      prefixToks += 32;
      continue;
    }
    const chunks = chunkText(story);
    const idx = chunks.findIndex((c) => RARE_RE.test(firstSent(c)));
    if (chunks.length >= 3 && idx > 0 && idx < chunks.length - 1) return story;
    prefixToks += 16;
  }
  throw new Error("m29.4 could not place Quellbridge as first sentence of a middle chunk");
}

function tmpDir(prefix = "eden-m294-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withMem<T>(
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
  vars: Record<string, string | undefined> = {},
  session = SESSION,
): Promise<T> {
  const dir = tmpDir();
  return withEnv(
    {
      EDEN_MEMORY: "on",
      EDEN_MEMORY_DIR: dir,
      EDEN_HOME: undefined,
      EDEN_KNOW: "0",
      EDEN_MEMORY_CAP: String(K),
      ...vars,
    },
    async () => {
      try {
        const mem = openMemory({ dir, session });
        return await fn(mem, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

async function withSleptBook<T>(
  fn: (mem: AgentMemory, dir: string, story: string) => T | Promise<T>,
  vars: Record<string, string | undefined> = {},
): Promise<T> {
  return withMem(async (mem, dir) => {
    const story = longBook(800);
    expect(encodeLane(story)).toBe("narrative");
    expect(story.length).toBeGreaterThan(400);
    expect(tokCount(story)).toBeGreaterThanOrEqual(800);
    expect(story).toMatch(RARE_RE);
    mem.observe([{ role: "user", content: story }]);
    await sleep({ dir, mem, session: SESSION });
    if (typeof promoteNarrativeGists === "function") {
      expect(() => promoteNarrativeGists(dir)).not.toThrow();
    }
    return await fn(mem, dir, story);
  }, vars);
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function packetNotes(pkt: string): string[] {
  return pkt.split("\n").filter((l) => l.startsWith("- "));
}

function gistBodies(hay: string): string[] {
  const out: string[] = [];
  for (const line of String(hay ?? "").split("\n")) {
    const m = line.match(/\[gist(?:\s*·[^\]]*)?\]\s*(.*)$/);
    if (m) out.push(m[1] ?? "");
  }
  return out;
}

function gistHitText(h: GistHit): string {
  if (typeof h === "string") return h;
  if (h && typeof h === "object") return String(h.text ?? "");
  return "";
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

function millerFillerCount(s: string): number {
  return (String(s).match(/The miller walked beside the river that ran through the valley at dawn/g) || []).length;
}

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

m291("M29.1 long doc sleep → gist in packet on summarize", () => {
  test("isSummaryCue: summarize true, auth / EventQA miller / ICL label: false", () => {
    expect(typeof isSummaryCue).toBe("function");
    expect(isSummaryCue!(SUMMARIZE)).toBe(true);
    expect(isSummaryCue!(INFBENCH_CUE)).toBe(true);
    expect(isSummaryCue!("Auth is failing")).toBe(false);
    expect(isSummaryCue!(EVENTQA)).toBe(false);
    expect(isSummaryCue!(ICL_CUE)).toBe(false);
    expect(isSummaryCue!("")).toBe(false);
    expect(isIclExemplar(INFBENCH_CUE)).toBe(false);
    expect(isIclExemplar(ICL_CUE)).toBe(true);
    if (GIST_CHAR_CAP !== undefined) expect(GIST_CHAR_CAP).toBe(GIST_CAP);
  });

  test.failing("long narrative sleep: retrieveGists + inject packet have [gist] and Quellbridge", async () => {
    await withSleptBook(async (mem, dir, story) => {
      const chunks = chunkText(story);
      const rareChunk = chunks.findIndex((c) => RARE_RE.test(firstSent(c)));
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(rareChunk).toBeGreaterThan(0);
      expect(rareChunk).toBeLessThan(chunks.length - 1);
      const mid = story.indexOf("Quellbridge");
      expect(mid).toBeGreaterThan(story.length * 0.15);
      expect(mid).toBeLessThan(story.length * 0.85);

      expect(typeof retrieveGists).toBe("function");
      const hits = retrieveGists!(dir, SUMMARIZE);
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.some((h) => RARE_RE.test(gistHitText(h)))).toBe(true);

      const pkt = packetOf(mem.inject([{ role: "user", content: SUMMARIZE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(pkt).toMatch(RARE_RE);
    });
  });

  test.failing("wrap injectBody / withKnowFacts / Anthropic / UserPromptSubmit see [gist] + marker", async () => {
    await withSleptBook(async (mem, dir) => {
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const openai = mem.injectBody({ messages: [{ role: "user", content: SUMMARIZE }] });
        const oaiPkt = packetOf((openai.messages as unknown[]) ?? []);
        expect(oaiPkt).toContain(MEMORY_MARK);
        expect(oaiPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(oaiPkt).toMatch(RARE_RE);

        const wrap = withKnowFacts({ messages: [{ role: "user", content: SUMMARIZE }] });
        const wrapPkt = packetOf((wrap.messages as unknown[]) ?? []);
        expect(wrapPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(wrapPkt).toMatch(RARE_RE);

        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: SUMMARIZE }] });
        const aPkt = anthMemoryText(anth);
        expect(aPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(aPkt).toMatch(RARE_RE);

        const hook = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: SUMMARIZE_HOOK,
          session_id: SESSION,
        });
        const hk = hookMemoryText(hook);
        expect(hk).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(hk).toMatch(RARE_RE);
      } finally {
        procSpy.mockRestore();
      }
      expect(dir).toBeTruthy();
    });
  });
});

describe("M29.4 empty cue no gist dump (Start)", () => {
  test("after long-doc sleep, assistant-only inject has no MEMORY_MARK / [gist] / Quellbridge", async () => {
    await withSleptBook(async (mem) => {
      const empty = packetOf(mem.inject([{ role: "assistant", content: "working" }]));
      expect(empty).not.toContain(MEMORY_MARK);
      expect(empty).not.toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(empty).not.toMatch(RARE_RE);
      expect(empty).not.toMatch(/Quellbridge/);
    });
  });

  test("SessionStart briefing is pins+session gist, not a hierarchical miller dump", async () => {
    await withSleptBook(async (mem) => {
      mem.remember("Always run tests before committing", { kind: "constraint" });
      await sleep({ dir: mem.dir, mem, session: SESSION });
      const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
      const ctx = hookMemoryText(start);
      const gistMarks = ctx.match(/\[gist(?:\s*·[^\]]*)?\]/g) ?? [];
      expect(gistMarks.length).toBeLessThanOrEqual(5);
      expect(millerFillerCount(ctx)).toBeLessThanOrEqual(3);
      expect(ctx).not.toMatch(/(The miller walked beside the river that ran through the valley at dawn\.\s*){6,}/);
    });
  });
});

describe("M29.3 token / k cap", () => {
  test("after sleep, notesFor(summarize, 10) ≤ 10; [gist] bodies ≤ 1200; packet bullets ≤ k", async () => {
    await withSleptBook(async (mem) => {
      const notes = mem.notesFor(SUMMARIZE, K);
      expect(notes.length).toBeLessThanOrEqual(K);
      for (const n of notes) {
        const m = String(n.text ?? "").match(/^\[gist(?:\s*·[^\]]*)?\]\s*(.*)$/s);
        if (m) expect(m[1]!.length).toBeLessThanOrEqual(GIST_CAP);
      }
      const pkt = packetOf(mem.inject([{ role: "user", content: SUMMARIZE }]));
      const bullets = packetNotes(pkt);
      expect(bullets.length).toBeLessThanOrEqual(K);
      for (const body of gistBodies(pkt)) {
        expect(body.length).toBeLessThanOrEqual(GIST_CAP);
      }
    });
  });

  test("50k gist-kind remember formatNote-caps to 1200, else packet gist total ≤ 3*1200+labels", async () => {
    await withMem(async (mem, dir) => {
      const huge = `Hierarchical gist marker ${"z".repeat(50_000)}`;
      expect(huge.length).toBeGreaterThan(50_000);
      const rec = mem.remember(huge, { kind: "gist" });
      if (rec.text.length > GIST_CAP) {
        const notes = mem.notesFor("Hierarchical gist marker", K);
        const gistNotes = notes.filter(
          (r) => r.kind === "gist" || /^\[gist(?:\s*·[^\]]*)?\]/.test(r.text) || (r.tags ?? []).includes("gist"),
        );
        expect(gistNotes.length).toBeGreaterThan(0);
        for (const n of gistNotes) {
          const m = String(n.text).match(/^\[gist(?:\s*·[^\]]*)?\]\s*(.*)$/s);
          const body = m ? m[1]! : String(n.text);
          expect(body.length).toBeLessThanOrEqual(GIST_CAP);
        }
        return;
      }
      mem.observe([{ role: "user", content: longBook(800) }]);
      await sleep({ dir, mem, session: SESSION });
      const pkt = packetOf(mem.inject([{ role: "user", content: SUMMARIZE }]));
      const bodies = gistBodies(pkt);
      const total = bodies.reduce((n, b) => n + b.length, 0);
      const labels = bodies.length * "[gist] ".length;
      expect(total).toBeLessThanOrEqual(3 * GIST_CAP + labels);
    });
  }, 20_000);
});

describe("M29 isolation", () => {
  test("EventQA miller cue is not required to include [gist]; episode chunk is allowed", async () => {
    await withSleptBook(async (mem) => {
      if (typeof isSummaryCue === "function") {
        expect(isSummaryCue(EVENTQA)).toBe(false);
        expect(isSummaryCue(SUMMARIZE)).toBe(true);
      }
      const list = [{ role: "user", content: EVENTQA }];
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
      const pkt = packetOf(out as unknown[]);
      // Summary lane only — do not require [gist]. A leftover [episode] chunk is fine.
      if (/\[episode\b/.test(pkt)) expect(pkt).toMatch(/\[episode(?:\s*·[^\]]*)?\]/);
    });
  });

  test.failing("ICL cue does not pull narrative gists; summarize packet has no label: 28 shots", async () => {
    await withSleptBook(async (mem) => {
      mem.observe([{ role: "user", content: ICL_SHOT }]);
      for (let i = 0; i < 4; i++) {
        mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
      }
      const iclPkt = packetOf(mem.inject([{ role: "user", content: ICL_CUE }]));
      expect(iclPkt).not.toMatch(RARE_RE);
      expect(iclPkt).not.toMatch(/Quellbridge/);
      expect(iclPkt).not.toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      const sumPkt = packetOf(mem.inject([{ role: "user", content: SUMMARIZE }]));
      expect(sumPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(sumPkt).not.toMatch(/label:\s*28/);
    });
  });

  test("EDEN_MEMORY=0 inject is identity (no MEMORY_MARK)", async () => {
    await withSleptBook(async (mem, dir) => {
      await withEnv({ EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const list = [{ role: "user", content: SUMMARIZE }];
        const out = mem.inject(list);
        expect(out).toBe(list);
        expect(packetOf(out)).not.toContain(MEMORY_MARK);
        const body = { messages: list };
        expect(mem.injectBody(body)).toBe(body);
      });
    });
  });

  test("fail-open: retrieveGists or GistStore throw → inject still returns array", async () => {
    await withSleptBook(async (mem) => {
      const list = [{ role: "user", content: SUMMARIZE }];
      const booms: { mockRestore(): void }[] = [];
      try {
        if (gistRetrieveReady && retrieveGists) {
          const mod = await import("./gist-retrieve");
          booms.push(
            spyOn(mod, "retrieveGists").mockImplementation(() => {
              throw new Error("m29 retrieveGists boom");
            }),
          );
        }
        booms.push(
          spyOn(GistStore.prototype, "hier").mockImplementation(() => {
            throw new Error("m29 GistStore.hier boom");
          }),
        );
        booms.push(
          spyOn(GistStore.prototype, "latest").mockImplementation(() => {
            throw new Error("m29 GistStore.latest boom");
          }),
        );
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
      } finally {
        for (const b of booms) b.mockRestore();
      }
    });
  });
});

describe("M29 adversarial locks", () => {
  test("GistStore.latest never returns kind=hier; torn JSONL is skipped", () => {
    const dir = tmpDir("eden-m29-latest-");
    try {
      const gs = new GistStore(dir);
      gs.put("session pin Auth is Clerk", SESSION, 1);
      gs.replaceHier([
        {
          text: "HIERONLY-ZYX miller walked beside the river at dawn",
          session: SESSION,
          t: 2,
          kind: "hier",
          level: 2,
          i: 0,
        },
      ]);
      const latest = gs.latest(SESSION, 8);
      expect(latest.length).toBeGreaterThan(0);
      expect(latest.every((g) => (g.kind ?? "session") === "session")).toBe(true);
      expect(latest.some((g) => g.kind === "hier")).toBe(false);
      expect(latest.some((g) => /HIERONLY-ZYX/.test(g.text))).toBe(false);
      expect(gs.hier().some((g) => /HIERONLY-ZYX/.test(g.text))).toBe(true);
      appendFileSync(gs.path, '{"text":"torn-partial\n');
      const after = new GistStore(dir);
      expect(() => after.latest(SESSION, 8)).not.toThrow();
      expect(() => after.hier()).not.toThrow();
      expect(after.latest(SESSION, 8).every((g) => (g.kind ?? "session") === "session")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hier L2 follows ingestOrder, not UUID src sort", () => {
    if (!gistRetrieveReady || typeof promoteNarrativeGists !== "function" || typeof retrieveGists !== "function")
      return;
    const dir = tmpDir("eden-m29-ingest-");
    try {
      const cs = new ChunkStore(dir);
      cs.put(
        "Zebra pack opens the ledger at dusk. Villagers said the oak still slept under the silt waiting for summer rain.",
        { src: "zzz-uuid-bbbb", t: 10 },
      );
      cs.put(
        "Alpha pack closes the ochre flood at dawn. Fog hung low over the marsh and the herons waited on one leg.",
        { src: "aaa-uuid-aaaa", t: 11 },
      );
      expect(cs.ingestOrder()[0]?.src).toBe("zzz-uuid-bbbb");
      expect(cs.all()[0]?.src).toBe("aaa-uuid-aaaa");
      promoteNarrativeGists(dir);
      const hits = retrieveGists(dir, SUMMARIZE);
      expect(hits.length).toBeGreaterThan(0);
      const l2 = gistHitText(hits[0]!);
      expect(l2).toMatch(/^Zebra/);
      expect(l2).not.toMatch(/^Alpha/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Clerk survives Auth is failing after long-doc sleep (not a gist dump)", async () => {
    await withMem(async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      mem.observe([{ role: "user", content: longBook(800) }]);
      await sleep({ dir, mem, session: SESSION });
      const pkt = packetOf(mem.inject([{ role: "user", content: "Auth is failing" }]));
      expect(pkt).toMatch(/Clerk/);
      expect(pkt).not.toMatch(/(The miller walked beside the river that ran through the valley at dawn\.\s*){6,}/);
      if (typeof isSummaryCue === "function") expect(isSummaryCue("Auth is failing")).toBe(false);
    });
  });

  test.failing("InfBench-shaped summarize is not ICL; skipNarrativeComplete (no completeNotes hop)", async () => {
    await withSleptBook(async (mem) => {
      mem.observe([{ role: "user", content: ICL_SHOT }]);
      for (let i = 0; i < 4; i++) {
        mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
      }
      expect(isSummaryCue!(INFBENCH_CUE)).toBe(true);
      const spy = spyOn(completeMod, "completeNotes");
      try {
        const pkt = packetOf(mem.inject([{ role: "user", content: INFBENCH_CUE }]));
        expect(spy.mock.calls.length).toBe(0);
        expect(pkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(pkt).toMatch(RARE_RE);
        expect(pkt).not.toMatch(/label:\s*28/);
        expect(pkt).not.toMatch(/Alayah/);
        // Off-cue "quark" is remain-silent (M38) and must not force hops.
        // An on-cue two-hop overwrite still walks completeNotes.
        mem.remember("1. Zane plays lacrosse.");
        mem.remember("8. Lacrosse originated in Canada.");
        const hop = packetOf(mem.inject([{ role: "user", content: "which country did Zane's sport originate in" }]));
        expect(hop).toMatch(/Canada/i);
        expect(hop).not.toMatch(/Scotland/i);
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("M29 honesty", () => {
  test("product files are not BrainMemory / memory_search / GraphRAG", () => {
    const files = [
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "gist-store.ts"),
      join(import.meta.dir, "sleep.ts"),
      join(import.meta.dir, "..", "benchmarks", "memoryagentbench", "inject-bridge.ts"),
      ...(gistRetrieveReady ? [GIST_RETRIEVE_PATH] : []),
    ];
    for (const p of files) {
      const code = codeWithoutComments(readFileSync(p, "utf8"));
      expect(code, p).not.toMatch(/\bBrainMemory\b/);
      expect(code, p).not.toMatch(/\bmemory_search\b/);
      expect(code, p).not.toMatch(/\bgraphrag\b/i);
      expect(code, p).not.toMatch(/\braptor\b/i);
    }
    const self = readFileSync(join(import.meta.dir, "memory-gist.test.ts"), "utf8");
    expect(self).not.toMatch(/^import\s+.*\bBrainMemory\b/m);
    expect(self).not.toMatch(/from\s+['"][^'"]*brain-memory[^'"]*['"]/);
    expect(self).not.toMatch(/\bmemory_search\s*\(/);
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(index).toMatch(/"command", "cmd"/);
    const bridge = readFileSync(
      join(import.meta.dir, "..", "benchmarks", "memoryagentbench", "inject-bridge.ts"),
      "utf8",
    );
    expect(bridge).toMatch(/case "flush"/);
    expect(bridge).toMatch(/consolidate\(/);
    expect(codeWithoutComments(bridge)).not.toMatch(/\bBrainMemory\b/);
  });
});
