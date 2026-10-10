/**
 * M19.2 ICL lane retrieve. Chat fact cue must not pull ICL shots.
 * ICL cue reads the ICL index only (atomic exemplars; no graph; no extract).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import * as iclIndex from "./icl-index";
import { MEMORY_MARK, encodeLane, openMemory, queryHay, type AgentMemory, injectedPackets } from "./index";
import * as edenMem from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/52

function tmpDir(prefix = "eden-m192-"): string {
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
  return injectedPackets(messages).join("\n");
}

function openaiMemoryText(body: Record<string, unknown>): string {
  return injectedPackets(Array.isArray(body.messages) ? body.messages : []).join("\n");
}

/** The memory packets a wrapped body carries: since P0.7 at its turns' tails (D29), never in `system`. */
function anthropicMemoryText(body: { messages?: unknown[] }): string {
  return injectedPackets(body.messages ?? []).join("\n");
}

function hookCtx(out: Record<string, unknown> | null): string {
  return [
    out?.additional_context,
    (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext,
  ]
    .map((x) => String(x ?? ""))
    .join("\n");
}

function seedIclAndClerk(mem: AgentMemory): void {
  for (let i = 0; i < 20; i++) {
    mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
  }
  mem.observe([{ role: "user", content: "Auth is Clerk" }]);
}

const CHAT_CUES = ["What provider is Auth?", "Auth is failing"] as const;
const ICL_CUE = "The movie was great. label:";
const ICL_CUE_OFFICIAL = "Only output label:";

describe("M19.2 chat fact cue does not pull ICL shots", () => {
  test.failing("bare 'label this PR' is chat, not ICL-only", () => {
    withMem((mem) => {
      seedIclAndClerk(mem);
      const pkt = packetOf(mem.inject([{ role: "user", content: "please label this Auth ticket" }]));
      expect(pkt).toMatch(/Clerk/);
      expect(pkt).not.toMatch(/label:\s*28/);
    });
  });

  test("ICL-only store still retrieves shots when the cue has no label:", () => {
    withMem((mem) => {
      for (let i = 0; i < 8; i++) {
        mem.observe([{ role: "user", content: `The movie was great. Take ${i}. label: 28` }]);
      }
      const notes = mem
        .notesFor("The movie was great.")
        .map((r) => r.text)
        .join("\n");
      expect(notes).toMatch(/label:\s*28/);
      const pkt = packetOf(mem.inject([{ role: "user", content: "The movie was great." }]));
      expect(pkt).toMatch(/label:\s*28/);
    });
  });

  test.failing("Auth cues inject Clerk and never movie label: 28", () => {
    withMem((mem) => {
      seedIclAndClerk(mem);
      for (const cue of [...CHAT_CUES, "Auth is Clerk/failing"]) {
        const notes = mem
          .notesFor(cue)
          .map((r) => r.text)
          .join("\n");
        expect(notes).toMatch(/Clerk/);
        expect(notes).not.toMatch(/label:\s*28/);
        expect(notes).not.toMatch(/The movie was great/i);
        const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
        expect(pkt).toMatch(/Clerk/);
        expect(pkt).not.toMatch(/label:\s*28/);
        expect(pkt).not.toMatch(/The movie was great/i);
      }
      const mixedMovie = packetOf(mem.inject([{ role: "user", content: "The movie was great." }]));
      expect(mixedMovie).not.toMatch(/label:\s*28/);
    });
  });
});

describe("M39.3 ICL gold survives near-dup on the product path", () => {
  test("observe 100 near-dup label: 28 + gold label: 7; classify cue keeps label: 7; chat cue skips ICL", () => {
    withMem((mem) => {
      mem.quiet(() => {
        for (let i = 0; i < 100; i++) {
          mem.observe([
            {
              role: "user",
              content: `Classify this review. Excellent acting and a moving plot about family. take ${i}. label: 28`,
            },
          ]);
        }
        mem.observe([
          {
            role: "user",
            content: "Classify this review. Excellent acting and a moving plot about family. take gold. label: 7",
          },
        ]);
        mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      });
      const cue = "Classify this review. Excellent acting and a moving plot about family. label:";
      let notes = "";
      expect(() => {
        notes = mem
          .notesFor(cue)
          .map((r) => r.text)
          .join("\n");
      }).not.toThrow();
      expect(notes).toMatch(/label:\s*7/);
      let pkt = "";
      expect(() => {
        pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      }).not.toThrow();
      expect(pkt).toMatch(/label:\s*7/);
      const chatCue = "What provider is Auth?";
      const chatNotes = mem
        .notesFor(chatCue)
        .map((r) => r.text)
        .join("\n");
      expect(chatNotes).toMatch(/Clerk/);
      expect(chatNotes).not.toMatch(/label:\s*7/);
      expect(chatNotes).not.toMatch(/label:\s*28/);
      const chatPkt = packetOf(mem.inject([{ role: "user", content: chatCue }]));
      expect(chatPkt).toMatch(/Clerk/);
      expect(chatPkt).not.toMatch(/label:\s*7/);
      expect(chatPkt).not.toMatch(/label:\s*28/);
    });
  });
});

describe("M19.2 ICL cue is index-only", () => {
  test("ICL cue keeps label: and does not pull Auth is Clerk", () => {
    withMem((mem) => {
      seedIclAndClerk(mem);
      for (const cue of [ICL_CUE, ICL_CUE_OFFICIAL]) {
        const notes = mem
          .notesFor(cue)
          .map((r) => r.text)
          .join("\n");
        expect(notes).toMatch(/label:\s*28/);
        expect(notes).not.toMatch(/Auth is Clerk/);
        expect(notes).not.toMatch(/Clerk/);
      }
      for (const cue of [ICL_CUE, ICL_CUE_OFFICIAL]) {
        const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
        expect(pkt).toMatch(/label:\s*28/);
        expect(pkt).not.toMatch(/Auth is Clerk/);
        expect(pkt).not.toMatch(/Clerk/);
      }
    });
  });

  test("empty ICL index is [] not a chat dump", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      const notes = mem.notesFor(ICL_CUE);
      expect(notes.some((r) => /Clerk/.test(r.text))).toBe(false);
      expect(packetOf(mem.inject([{ role: "user", content: ICL_CUE }]))).not.toMatch(/Clerk/);
    });
  });

  test("empty cue / SessionStart do not dump ICL shots", () => {
    withMem((mem, dir) => {
      seedIclAndClerk(mem);
      const empty = mem
        .notesFor("")
        .map((r) => r.text)
        .join("\n");
      expect(empty).not.toMatch(/label:\s*28/);
      expect(packetOf(mem.inject([{ role: "user", content: "" }]))).not.toMatch(/label:\s*28/);
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const start = memoryHookResponse({ hook_event_name: "SessionStart" });
        expect(hookCtx(start)).not.toMatch(/label:\s*28/);
      });
    });
  });
});

describe("M19.2 fail-open", () => {
  test("retrieveIcl throw → inject returns original messages", () => {
    withMem((mem) => {
      seedIclAndClerk(mem);
      const boom = spyOn(iclIndex, "retrieveIcl").mockImplementation(() => {
        throw new Error("m19.2 retrieveIcl boom");
      });
      try {
        const list = [{ role: "user", content: ICL_CUE }];
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(out).toEqual([{ role: "user", content: ICL_CUE }]);
        expect(packetOf(out as unknown[])).not.toContain(MEMORY_MARK);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("retrieveIcl throw → wrap OpenAI/Anthropic and hook fail-open", () => {
    const dir = tmpDir("eden-m192-fo-");
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    const boom = spyOn(iclIndex, "retrieveIcl").mockImplementation(() => {
      throw new Error("m19.2 wrap retrieveIcl boom");
    });
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        seedIclAndClerk(mem);
        const openai = { messages: [{ role: "user", content: ICL_CUE }] };
        const anth = { messages: [{ role: "user", content: ICL_CUE }] };
        expect(withKnowFacts(openai)).toBe(openai);
        expect(withKnowFactsAnthropic(anth).messages).toEqual(anth.messages);
        expect(openaiMemoryText(withKnowFacts(openai))).not.toContain(MEMORY_MARK);
        const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: ICL_CUE });
        expect(hookCtx(hook)).not.toMatch(/label:\s*28/);
      });
    } finally {
      boom.mockRestore();
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inject throw still pass-through on wrap", () => {
    const openai = { messages: [{ role: "user", content: ICL_CUE }] };
    const anth = { messages: [{ role: "user", content: ICL_CUE }] };
    const boomBody = spyOn(edenMem.AgentMemory.prototype, "injectBody").mockImplementation(() => {
      throw new Error("m19.2 injectBody boom");
    });
    const boomInject = spyOn(edenMem.AgentMemory.prototype, "inject").mockImplementation(() => {
      throw new Error("m19.2 inject boom");
    });
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_KNOW: "0" }, () => {
        expect(withKnowFacts(openai)).toBe(openai);
        expect(withKnowFactsAnthropic(anth)).toBe(anth);
      });
    } finally {
      boomBody.mockRestore();
      boomInject.mockRestore();
    }
  });
});

describe("M19.2 wrap isolation", () => {
  test("withKnowFacts / Anthropic: chat cue has Clerk not ICL; ICL cue keeps label:", () => {
    const dir = tmpDir("eden-m192-wrap-");
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        seedIclAndClerk(mem);
        for (const cue of CHAT_CUES) {
          const openai = withKnowFacts({ messages: [{ role: "user", content: cue }] });
          const openaiPkt = openaiMemoryText(openai);
          expect(openaiPkt).toMatch(/Clerk/);
          expect(openaiPkt).not.toMatch(/label:\s*28/);
          const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: cue }] });
          const anthPkt = anthropicMemoryText(anth);
          expect(anthPkt).toMatch(/Clerk/);
          expect(anthPkt).not.toMatch(/label:\s*28/);
        }
        const openaiIcl = withKnowFacts({ messages: [{ role: "user", content: ICL_CUE }] });
        expect(openaiMemoryText(openaiIcl)).toMatch(/label:\s*28/);
        expect(openaiMemoryText(openaiIcl)).not.toMatch(/Auth is Clerk/);
        const anthIcl = withKnowFactsAnthropic({ messages: [{ role: "user", content: ICL_CUE_OFFICIAL }] });
        expect(anthropicMemoryText(anthIcl)).toMatch(/label:\s*28/);
        expect(anthropicMemoryText(anthIcl)).not.toMatch(/Auth is Clerk/);
      });
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M19.2 hook isolation", () => {
  test("UserPromptSubmit: chat cue has Clerk not ICL; ICL cue keeps label:", () => {
    const dir = tmpDir("eden-m192-hook-");
    try {
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        for (let i = 0; i < 20; i++) {
          memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            prompt: `The movie was great. Take ${i}. label: 28`,
            session_id: "s-m192",
          });
        }
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: "Auth is Clerk",
          session_id: "s-m192",
        });
        for (const cue of CHAT_CUES) {
          // Each cue in a fresh epoch: the window ledger (A4 §4) delivers a bullet once per epoch.
          memoryHookResponse({ hook_event_name: "SessionStart", source: "compact", session_id: "s-m192" });
          const later = memoryHookResponse({
            hook_event_name: "UserPromptSubmit",
            prompt: cue,
            session_id: "s-m192",
          });
          const ctx = hookCtx(later);
          expect(ctx).toMatch(/Clerk/);
          expect(ctx).not.toMatch(/label:\s*28/);
        }
        const icl = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: ICL_CUE,
          session_id: "s-m192",
        });
        const iclCtx = hookCtx(icl);
        expect(iclCtx).toMatch(/label:\s*28/);
        expect(iclCtx).not.toMatch(/Auth is Clerk/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const NOVEL_PARA =
  "In the year 1847 the miller of Blackford walked beside the river that ran through the valley. He " +
  "remembered the flood of his childhood and the oak that had fallen across the millrace. The " +
  "villagers said the oak still slept under the silt, waiting.";

describe("M19 locks: novel vs ICL, identity, hay, search, order", () => {
  test.failing("ICL cue does not pull novel chunks; novel cue does not pull ICL", () => {
    withMem((mem) => {
      expect(encodeLane(NOVEL_PARA)).toBe("narrative");
      seedIclAndClerk(mem);
      mem.observe([{ role: "user", content: NOVEL_PARA }]);
      const iclPkt = packetOf(mem.inject([{ role: "user", content: ICL_CUE }]));
      expect(iclPkt).toMatch(/label:\s*28/);
      expect(iclPkt).not.toMatch(/Blackford|miller/i);
      const narPkt = packetOf(mem.inject([{ role: "user", content: "What happened at Blackford mill?" }]));
      expect(narPkt).toMatch(/Blackford/);
      expect(narPkt).not.toMatch(/label:\s*28/);
    });
  });

  test("EDEN_MEMORY=0 is identity for inject, wrap, and hook", () => {
    withMem((mem, dir) => {
      seedIclAndClerk(mem);
      withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
        try {
          withEnv({ EDEN_MEMORY: "0" }, () => {
            const list = [{ role: "user", content: ICL_CUE }];
            expect(mem.inject(list)).toBe(list);
            expect(packetOf(mem.inject(list))).not.toContain(MEMORY_MARK);
            const openai = { messages: [{ role: "user", content: "Auth is failing" }] };
            expect(withKnowFacts(openai)).toBe(openai);
            const anth = { messages: [{ role: "user", content: ICL_CUE }] };
            expect(withKnowFactsAnthropic(anth)).toBe(anth);
            expect(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: ICL_CUE })).toBeNull();
          });
        } finally {
          procSpy.mockRestore();
        }
      });
    });
  });

  test("queryHay best restaurant has no diet hay", () => {
    expect(queryHay("best restaurant").has("diet")).toBe(false);
    expect(queryHay("what diet am I on").has("diet")).toBe(true);
  });

  test("wrap/hook/setup/doctor have no memory_search or BrainMemory product API", () => {
    const files = [
      join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
      join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
      join(import.meta.dir, "../packages/cli/src/setup.ts"),
      join(import.meta.dir, "../packages/cli/src/doctor.ts"),
    ];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bmemory_search\b/);
      expect(src, p).not.toMatch(/\bBrainMemory\b/);
    }
    const wrapTest = readFileSync(join(import.meta.dir, "../packages/wrap/src/know-inject.test.ts"), "utf8");
    const laneTest = readFileSync(join(import.meta.dir, "memory-icl-lane.test.ts"), "utf8");
    expect(wrapTest).toMatch(/\bopenMemory\b/);
    expect(wrapTest).toMatch(/\binject\b/);
    expect(wrapTest).not.toMatch(/\bBrainMemory\s*\./);
    expect(laneTest).toMatch(/\bopenMemory\b/);
    expect(laneTest).not.toMatch(/\bBrainMemory\s*\./);
  });

  test("assemble/complete/narrative retrieve do not call ICL index", () => {
    const files = [
      join(import.meta.dir, "assemble.ts"),
      join(import.meta.dir, "cls/complete.ts"),
      join(import.meta.dir, "chunk-retrieve.ts"),
    ];
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bretrieveIcl\b/);
      expect(src, p).not.toMatch(/\bIclIndex\b/);
      expect(src, p).not.toMatch(/icl-index/);
    }
    const indexSrc = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const mergeNar = indexSrc.match(/function mergeNarrativeLane[\s\S]*?(?=\nfunction mergeIclLane)/)?.[0] ?? "";
    expect(mergeNar).toMatch(/function mergeNarrativeLane/);
    expect(mergeNar).not.toMatch(/\bretrieveIcl\b/);
    expect(mergeNar).not.toMatch(/\bIclIndex\b/);
    // `recall` retrieves for `inject` and for the hook; it observes (`observeCue`) only after retrieving.
    const injectSrc = indexSrc.slice(indexSrc.indexOf("recall(messages"), indexSrc.indexOf("injectBody("));
    expect(injectSrc.indexOf("notesFor")).toBeGreaterThan(-1);
    expect(injectSrc.indexOf("this.observeCue(list")).toBeGreaterThan(injectSrc.indexOf("notesFor"));
    expect(injectSrc).toMatch(/this\.observe\(encode,\s*\{\s*deferSleep:\s*true\s*\}\)/);
  });

  test("deferSleep still retrieves before observe: this-turn text is absent, prior fact is present", () => {
    withMem((mem) => {
      const marker = "Use m50-turn-only-zz9.";
      expect(mem.memories().some((r) => /m50-turn-only-zz9/.test(r.text))).toBe(false);
      const first = packetOf(mem.inject([{ role: "user", content: marker }]));
      expect(first).not.toMatch(/m50-turn-only-zz9/);
      expect(mem.memories().some((r) => /m50-turn-only-zz9/.test(r.text))).toBe(true);
    });
  });
});
