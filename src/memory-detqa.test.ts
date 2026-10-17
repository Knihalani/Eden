/**
 * M30.1 DetQA retrieve: gist then chunk lanes for book-length QA.
 * Product path is openMemory inject + sleep, not BrainMemory. No memory_search.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { CHUNK_TARGET_TOKENS, chunkText, estimateTokens } from "./chunk-store";
import * as completeMod from "./cls/complete";
import { GistStore } from "./gist-store";
import { isBookQaCue, retrieveGists } from "./gist-retrieve";
import {
  encodeLane,
  MEMORY_MARK,
  memoryInjectSwallows,
  openMemory,
  sleep,
  type AgentMemory,
  injectedPackets,
} from "./index";
import * as edenMem from "./index";
import { isIclExemplar } from "./semantic-store";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/44

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

const DETQA_LICHEM = `Based on the context you memorized, answer the question below. Keep the answer as short as \
possible.

Question: Lichem Rocchi's method of death was certainly not ( )
A. Murder
B. Sudden death
C. Suicide
D. Sudden illness`;

const DETQA_QUELL = `Based on the context you memorized, answer the question below. Keep the answer as short as \
possible.

Question: The lantern-keeper at Quellbridge mill signed the flood ledger in ( )
A. Murder
B. Sudden death
C. The Brandt couple
D. ochre ink`;

/** inject-agent retrieval_query strips the "Question:" wrapper. Official DetQA still has MC. */
const DETQA_EXTRACTED = `Lichem Rocchi's method of death was certainly not ( )
A. Murder
B. Sudden death
C. Suicide
D. Sudden illness`;

/**
 * Live detective_qa extract: first `_QUERY_PATTERNS` hit is `Now Answer the Question:` (not `Question:`).
 * Trailing `Output:` is the fill-in suffix — must not steal the ICL lane.
 */
const DETQA_LIVE_EXTRACT = `Which character is related to the death of the deceased?
A. Mrs. Hemm
B. Mr. and Mrs. MacNamara
C. The Brandt couple
D. Miss House
 Output:`;

const EVENTQA = "What happened to the miller by the river?";
const ICL_CUE = "The movie was great. label:";
const SUMMARIZE = "Please summarize the book.";
const INFBENCH_CUE = `You are given a book above and you are tasked to summarize it.

Write a summary of about 1000 to 1200 words. Only write about the plot and characters of the story.

Now summarize the book.`;
const SESSION = "s-m301-detqa";
const K = 10;

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
  throw new Error("m30.1 could not place Quellbridge as first sentence of a middle chunk");
}

function tmpDir(prefix = "eden-m301-"): string {
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

async function withSleptBook<T>(fn: (mem: AgentMemory, dir: string, story: string) => T | Promise<T>): Promise<T> {
  return withMem(async (mem, dir) => {
    const story = longBook(800);
    expect(encodeLane(story)).toBe("narrative");
    expect(tokCount(story)).toBeGreaterThanOrEqual(800);
    expect(story).toMatch(RARE_RE);
    mem.observe([{ role: "user", content: story }]);
    await sleep({ dir, mem, session: SESSION });
    return await fn(mem, dir, story);
  });
}

function packetOf(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function packetNotes(pkt: string): string[] {
  return pkt.split("\n").filter((l) => l.startsWith("- "));
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

function gistHitText(h: { text?: string } | string): string {
  if (typeof h === "string") return h;
  return String(h?.text ?? "");
}

describe("M30.1 isBookQaCue", () => {
  test("true on DetQA-shaped MC; false on miller / ICL / summarize / auth / chairperson / empty", () => {
    expect(isBookQaCue(DETQA_LICHEM)).toBe(true);
    expect(isBookQaCue(DETQA_QUELL)).toBe(true);
    expect(isBookQaCue(DETQA_EXTRACTED)).toBe(true);
    expect(isBookQaCue(DETQA_LIVE_EXTRACT)).toBe(true);
    expect(isBookQaCue(EVENTQA)).toBe(false);
    expect(isBookQaCue(ICL_CUE)).toBe(false);
    expect(isBookQaCue(SUMMARIZE)).toBe(false);
    expect(isBookQaCue(INFBENCH_CUE)).toBe(false);
    expect(isBookQaCue("Auth is failing")).toBe(false);
    expect(isBookQaCue("who is the chairperson")).toBe(false);
    expect(isBookQaCue("")).toBe(false);
  });

  test("live Now-Answer extract is book-QA, not ICL (lone Output: is the fill-in suffix)", () => {
    expect(isIclExemplar(DETQA_LIVE_EXTRACT)).toBe(false);
    expect(isIclExemplar(DETQA_EXTRACTED)).toBe(false);
    expect(encodeLane(DETQA_LIVE_EXTRACT)).not.toBe("icl");
    expect(encodeLane(DETQA_EXTRACTED)).not.toBe("icl");
    expect(isIclExemplar("The movie was great. label: 28")).toBe(true);
    expect(isIclExemplar("input: the movie was great\noutput: 28")).toBe(true);
    expect(encodeLane("The movie was great. label: 28")).toBe("icl");
  });
});

describe("M30.1 book QA gists then chunks", () => {
  test.failing("long miller book: DetQA cue has [gist] before leftover [episode] and gold phrase", async () => {
    await withSleptBook(async (mem, dir) => {
      const hits = retrieveGists(dir, DETQA_QUELL);
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(3);
      expect(hits.some((h) => RARE_RE.test(gistHitText(h)))).toBe(true);

      const list = [{ role: "user", content: DETQA_QUELL }];
      const liveList = [{ role: "user", content: DETQA_LIVE_EXTRACT }];
      const out = mem.inject(list);
      expect(Array.isArray(out)).toBe(true);
      const pkt = packetOf(out);
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(pkt).toMatch(/\[episode(?:\s*·[^\]]*)?\]/);
      expect(pkt).toMatch(RARE_RE);
      const notes = packetNotes(pkt);
      expect(notes.length).toBeLessThanOrEqual(K);
      const gi = notes.findIndex((l) => /\[gist(?:\s*·[^\]]*)?\]/.test(l));
      const ei = notes.findIndex((l) => /\[episode(?:\s*·[^\]]*)?\]/.test(l));
      expect(gi).toBeGreaterThanOrEqual(0);
      expect(ei).toBeGreaterThanOrEqual(0);
      expect(gi).toBeLessThan(ei);

      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const openai = mem.injectBody({ messages: list });
        const oaiPkt = packetOf((openai.messages as unknown[]) ?? []);
        expect(oaiPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(oaiPkt).toMatch(RARE_RE);
        const gistAt = oaiPkt.search(/\[gist(?:\s*·[^\]]*)?\]/);
        const epAt = oaiPkt.search(/\[episode(?:\s*·[^\]]*)?\]/);
        if (epAt >= 0) expect(gistAt).toBeLessThan(epAt);

        const wrap = withKnowFacts({ messages: list });
        const wrapPkt = packetOf((wrap.messages as unknown[]) ?? []);
        expect(wrapPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(wrapPkt).toMatch(RARE_RE);

        const anth = withKnowFactsAnthropic({ messages: list });
        const aPkt = anthMemoryText(anth);
        expect(aPkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(aPkt).toMatch(RARE_RE);

        const hook = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: DETQA_QUELL,
          session_id: SESSION,
        });
        const hk = hookMemoryText(hook);
        expect(hk).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(hk).toMatch(RARE_RE);

        const liveOut = mem.inject(liveList);
        const livePkt = packetOf(liveOut);
        expect(livePkt).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        expect(livePkt).toMatch(RARE_RE);
        const liveNotes = packetNotes(livePkt);
        const liveGi = liveNotes.findIndex((l) => /\[gist(?:\s*·[^\]]*)?\]/.test(l));
        const liveEi = liveNotes.findIndex((l) => /\[episode(?:\s*·[^\]]*)?\]/.test(l));
        expect(liveGi).toBeGreaterThanOrEqual(0);
        expect(liveEi).toBeGreaterThanOrEqual(0);
        expect(liveGi).toBeLessThan(liveEi);

        const liveWrap = withKnowFacts({ messages: liveList });
        expect(packetOf((liveWrap.messages as unknown[]) ?? [])).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        const liveAnth = withKnowFactsAnthropic({ messages: liveList });
        expect(anthMemoryText(liveAnth)).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
        const liveHook = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: DETQA_LIVE_EXTRACT,
          session_id: SESSION,
        });
        expect(hookMemoryText(liveHook)).toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      } finally {
        procSpy.mockRestore();
      }
    });
  });
});

describe("M30.1 empty cue / SessionStart", () => {
  test("empty cue and SessionStart do not dump last-k hier gists", async () => {
    await withSleptBook(async (mem) => {
      mem.remember("Always run tests before committing", { kind: "constraint" });
      await sleep({ dir: mem.dir, mem, session: SESSION });

      const empty = packetOf(mem.inject([{ role: "assistant", content: "working" }]));
      expect(empty).not.toContain(MEMORY_MARK);
      expect(empty).not.toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(empty).not.toMatch(RARE_RE);

      expect(retrieveGists(mem.dir, "")).toEqual([]);

      const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
      const ctx = hookMemoryText(start);
      // The hook words a gist "… (earlier session notes, …)" (D14).
      const gistMarks = ctx.match(/\(earlier session notes\b/g) ?? [];
      expect(gistMarks.length).toBeLessThanOrEqual(5);
      expect(millerFillerCount(ctx)).toBeLessThanOrEqual(3);
      expect(ctx).not.toMatch(/(The miller walked beside the river that ran through the valley at dawn\.\s*){6,}/);
    });
  });
});

describe("M30.1 isolation EventQA + SF", () => {
  test("EventQA miller does not require [gist]; Auth is Clerk still surfaces", async () => {
    await withSleptBook(async (mem) => {
      expect(isBookQaCue(EVENTQA)).toBe(false);
      const miller = packetOf(mem.inject([{ role: "user", content: EVENTQA }]));
      // EventQA miller must not get the DetQA gist dump.
      expect(miller).not.toMatch(/\[gist(?:\s*·[^\]]*)?\]/);
      expect(retrieveGists(mem.dir, EVENTQA)).toEqual([]);

      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: "Auth is failing" }]));
      expect(pkt).toMatch(/Clerk/);
      expect(isBookQaCue("Auth is failing")).toBe(false);

      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      const dbPkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(dbPkt).toMatch(/sqlite/i);
      expect(dbPkt).not.toMatch(/postgres/i);
    });
  });
});

describe("M30.1 skipNarrativeComplete", () => {
  test.failing("book-QA cue skips completeNotes; hop-shaped cue may still call it", async () => {
    await withSleptBook(async (mem) => {
      const spy = spyOn(completeMod, "completeNotes");
      try {
        packetOf(mem.inject([{ role: "user", content: DETQA_QUELL }]));
        expect(spy.mock.calls.length).toBe(0);
        packetOf(mem.inject([{ role: "user", content: DETQA_LIVE_EXTRACT }]));
        expect(spy.mock.calls.length).toBe(0);
        packetOf(mem.inject([{ role: "user", content: DETQA_EXTRACTED }]));
        expect(spy.mock.calls.length).toBe(0);
        mem.inject([{ role: "user", content: "Where does the quark live?" }]);
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("M30.1 fail-open", () => {
  test("inject notesFor throw → original messages unchanged", async () => {
    await withSleptBook(async (mem) => {
      const list = [{ role: "user", content: DETQA_LIVE_EXTRACT }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m30 inject notesFor");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: DETQA_LIVE_EXTRACT }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);

      const body = { messages: [{ role: "user", content: DETQA_LIVE_EXTRACT }] };
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const openai = withKnowFacts(body);
        expect(openai).toBe(body);
        expect(openai.messages).toBe(body.messages);
        const anthBody = { messages: [{ role: "user", content: DETQA_LIVE_EXTRACT }] };
        const anth = withKnowFactsAnthropic(anthBody);
        expect(anth).toBe(anthBody);
      } finally {
        procSpy.mockRestore();
      }
    });
  });

  test("retrieveGists throw → inject still returns array", async () => {
    await withSleptBook(async (mem) => {
      const list = [{ role: "user", content: DETQA_QUELL }];
      const booms: { mockRestore(): void }[] = [];
      try {
        const mod = await import("./gist-retrieve");
        booms.push(
          spyOn(mod, "retrieveGists").mockImplementation(() => {
            throw new Error("m30 retrieveGists boom");
          }),
        );
        booms.push(
          spyOn(GistStore.prototype, "hier").mockImplementation(() => {
            throw new Error("m30 GistStore.hier boom");
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

describe("M30.1 honesty", () => {
  test("owner files are not BrainMemory / memory_search", () => {
    const files = [join(import.meta.dir, "gist-retrieve.ts"), join(import.meta.dir, "index.ts")];
    for (const p of files) {
      expect(existsSync(p)).toBe(true);
      const code = codeWithoutComments(readFileSync(p, "utf8"));
      expect(code, p).not.toMatch(/\bmemory_search\b/);
      expect(code, p).not.toMatch(/\bBrainMemory\b/);
    }
    const self = readFileSync(join(import.meta.dir, "memory-detqa.test.ts"), "utf8");
    expect(self).not.toMatch(/^import\b[^;]*\bBrainMemory\b/m);
    expect(self).not.toMatch(/from\s+['"][^'"]*brain-memory[^'"]*['"]/);
    expect(self).not.toMatch(/\bmemory_search\s*\(/);
  });
});
