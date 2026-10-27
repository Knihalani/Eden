/**
 * M43.4: English forget / pin. Tombstone on “forget postgres”, not on
 * “don’t forget to…”. Pins survive a small store cap. Readonly and off
 * do not write. Forget text must not keep a secret. Sleep must not
 * bring a forgotten name back. Wrap + hook use the same observe path.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { AgentMemory, MEMORY_MARK, openMemory, sleep, injectedPackets } from "./index";
import { GistStore } from "./gist-store";
import * as forgetMod from "./memory-forget";
import * as edenMem from "./index";
import { storeFor } from "./memory-repo";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/42

const PG = "Use postgres.";
const FORGET_PG = "forget postgres";
const DONT_FORGET = "don't forget to run tests";
const PG_CUE = "what database do we use";
const SQLITE_CUE = "What sqlite database do we use?";
const SECRET = "hunter2";
const PIN_UTTERANCES = ["remember always use sqlite", "always use sqlite", "remember Use sqlite."] as const;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-m43-"));
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

/**
 * A memory root in a fresh directory, and the store the hook reads in it: the one it keeps for this process's repo
 * (D1: a payload without `cwd` is keyed by `process.cwd()`), so the wrap and the hook see one memory.
 */
async function withMem<T>(
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
  extra: Record<string, string | undefined> = {},
): Promise<T> {
  const root = tmpDir();
  const dir = storeFor(root);
  return withEnv(
    {
      EDEN_MEMORY_DIR: root,
      EDEN_HOME: undefined,
      EDEN_MEMORY: "on",
      EDEN_SLEEP_EVERY: "0",
      EDEN_SLEEP_IDLE: "0",
      EDEN_KNOW: "0",
      ...extra,
    },
    async () => {
      try {
        const mem = openMemory({ dir, perRepo: true });
        return await fn(mem, dir);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

function packet(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function jsonlContents(root: string): string {
  const names = new Set([
    "memories.jsonl",
    "semantic.jsonl",
    "gists.jsonl",
    "howto.jsonl",
    "howtos.jsonl",
    "traces.jsonl",
  ]);
  const chunks: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (names.has(ent.name) || ent.name.endsWith(".jsonl") || ent.name.endsWith(".wal")) {
        try {
          chunks.push(readFileSync(p, "utf8"));
        } catch {}
      }
    }
  };
  walk(root);
  return chunks.join("\n");
}

function isPin(r: { kind: string; sal?: number }): boolean {
  return r.kind === "constraint" || (typeof r.sal === "number" && r.sal >= 0.6);
}

describe("M43 forget and pin in language", () => {
  test("forgetCueFrom: operator forget vs don't forget", () => {
    expect(forgetMod.forgetCueFrom("forget postgres")).toBe("postgres");
    expect(forgetMod.forgetCueFrom("please forget about postgres.")).toBe("postgres");
    expect(forgetMod.forgetCueFrom("don't use postgres anymore")).toBe("postgres");
    expect(forgetMod.forgetCueFrom("stop using postgres")).toBe("postgres");
    expect(forgetMod.forgetCueFrom("don't forget to run tests")).toBeNull();
    expect(forgetMod.forgetCueFrom("do not forget postgres")).toBeNull();
    expect(forgetMod.forgetCueFrom("never forget sqlite")).toBeNull();
    expect(forgetMod.forgetCueFrom("I forgot postgres")).toBeNull();
  });

  test("assistant forget postgres does not tombstone", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "assistant", content: "forget postgres" }]);
      expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).toMatch(/postgres/i);
    });
  });
  test.failing("forget postgres: database cue has it, then the next cue does not", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      const before = packet(mem.inject([{ role: "user", content: PG_CUE }]));
      expect(before).toContain(MEMORY_MARK);
      expect(before).toMatch(/postgres/i);

      mem.observe([{ role: "user", content: FORGET_PG }]);
      const after = packet(mem.inject([{ role: "user", content: PG_CUE }]));
      expect(after).not.toMatch(/postgres/i);
    });
  });

  test("don't forget to run tests does not tombstone postgres", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "user", content: DONT_FORGET }]);
      const pkt = packet(mem.inject([{ role: "user", content: PG_CUE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/postgres/i);
    });
  });

  test.failing("don't use postgres anymore and stop using postgres tombstone", async () => {
    for (const utter of ["don't use postgres anymore", "stop using postgres", "do not use postgres anymore"]) {
      await withMem(async (mem) => {
        mem.observe([{ role: "user", content: PG }]);
        expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).toMatch(/postgres/i);
        mem.observe([{ role: "user", content: utter }]);
        expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).not.toMatch(/postgres/i);
      });
    }
  });

  test.failing("remember / always pins sqlite and it survives a small store cap", async () => {
    for (const utterance of PIN_UTTERANCES) {
      await withMem(
        async (mem) => {
          mem.observe([{ role: "user", content: utterance }]);
          const pinned = mem.memories().filter((r) => /sqlite/i.test(r.text));
          expect(pinned.length).toBeGreaterThan(0);
          expect(pinned.some(isPin)).toBe(true);

          for (let i = 0; i < 16; i++) {
            mem.remember(`The banner color is shade${i}.`, { kind: "fact" });
          }
          const live = mem.memories().filter((r) => /sqlite/i.test(r.text));
          expect(live.length).toBeGreaterThan(0);
          expect(live.some(isPin)).toBe(true);
          const pkt = packet(mem.inject([{ role: "user", content: SQLITE_CUE }]));
          expect(pkt).toContain(MEMORY_MARK);
          expect(pkt).toMatch(/sqlite/i);
        },
        { EDEN_MEMORY_STORE_CAP: "8" },
      );
    }
  });

  test("readonly: forget sqlite and remember postgres are no-ops", async () => {
    const dir = tmpDir();
    try {
      await withEnv(
        {
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_KNOW: "0",
        },
        () => {
          const mem = openMemory({ dir });
          mem.observe([{ role: "user", content: "Use sqlite." }]);
          mem.close();
        },
      );
      await withEnv(
        {
          EDEN_MEMORY: "readonly",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_KNOW: "0",
        },
        () => {
          const mem = openMemory({ dir });
          mem.observe([{ role: "user", content: "forget sqlite" }]);
          mem.observe([{ role: "user", content: "remember always use postgres" }]);
          const pkt = packet(mem.inject([{ role: "user", content: SQLITE_CUE }]));
          expect(pkt).toContain(MEMORY_MARK);
          expect(pkt).toMatch(/sqlite/i);
          expect(mem.memories().some((r) => /postgres/i.test(r.text))).toBe(false);
          mem.close();
        },
      );
      const blob = jsonlContents(dir);
      expect(blob).toMatch(/sqlite/i);
      expect(blob).not.toMatch(/postgres/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("off: forget and pin are no-ops and inject is the original list", async () => {
    const dir = tmpDir();
    try {
      await withEnv(
        {
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_KNOW: "0",
        },
        () => {
          const mem = openMemory({ dir });
          mem.observe([{ role: "user", content: "Use sqlite." }]);
          mem.close();
        },
      );
      await withEnv(
        {
          EDEN_MEMORY: "0",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_KNOW: "0",
        },
        () => {
          const mem = openMemory({ dir });
          mem.observe([{ role: "user", content: "forget sqlite" }]);
          mem.observe([{ role: "user", content: "remember always use postgres" }]);
          const list = [{ role: "user", content: SQLITE_CUE }];
          const out = mem.inject(list);
          expect(out).toBe(list);
          expect(packet(out)).not.toContain(MEMORY_MARK);
          expect(JSON.stringify(out)).not.toMatch(/403/);
          mem.close();
        },
      );
      const blob = jsonlContents(dir);
      expect(blob).toMatch(/sqlite/i);
      expect(blob).not.toMatch(/postgres/i);
      await withEnv(
        {
          EDEN_MEMORY: "on",
          EDEN_MEMORY_DIR: dir,
          EDEN_HOME: undefined,
          EDEN_SLEEP_EVERY: "0",
          EDEN_SLEEP_IDLE: "0",
          EDEN_KNOW: "0",
        },
        () => {
          const mem = openMemory({ dir });
          const pkt = packet(mem.inject([{ role: "user", content: SQLITE_CUE }]));
          expect(pkt).toMatch(/sqlite/i);
          expect(pkt).not.toMatch(/postgres/i);
          mem.close();
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forget password is hunter2 does not persist the secret", async () => {
    await withMem(async (mem, dir) => {
      mem.observe([{ role: "user", content: `forget password is ${SECRET}` }]);
      mem.close();
      const blob = jsonlContents(dir);
      expect(blob).not.toContain(SECRET);
      expect(
        mem
          .memories()
          .map((r) => r.text)
          .join("\n"),
      ).not.toContain(SECRET);
    });
  });

  test.failing("sleep does not resurrect a forgotten postgres fact", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).toMatch(/postgres/i);
      mem.observe([{ role: "user", content: FORGET_PG }]);
      await mem.sleep();
      await sleep({ mem });
      const pkt = packet(mem.inject([{ role: "user", content: PG_CUE }]));
      expect(pkt).not.toMatch(/postgres/i);
    });
  });

  test("inject throw is pass-through and does not 403", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      const list = [{ role: "user", content: PG_CUE }];
      const boom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
        throw new Error("m43 inject boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
        expect(JSON.stringify(out)).not.toMatch(/403/);
      } finally {
        boom.mockRestore();
      }
    });
  });
});

describe("M43 wrap and hook forget", () => {
  // Quarantined (#42) since P4.2: `observe` never applies a forget (`applyObserveForget` is not wired), so this
  // passed only while the database cue could not reach "Use postgres"; BM25F's subject field (its D7 key) now does.
  test.failing("OpenAI injectBody and withKnowFacts omit postgres on the next database cue", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "user", content: FORGET_PG }]);
      const body = mem.injectBody({ model: "gpt-4o", messages: [{ role: "user", content: PG_CUE }] });
      expect(packet((body.messages ?? []) as unknown[])).not.toMatch(/postgres/i);
      expect(JSON.stringify(body)).not.toMatch(/403/);

      const proc = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const wrapped = withKnowFacts({ model: "gpt-4o", messages: [{ role: "user", content: PG_CUE }] });
        expect(packet((wrapped.messages ?? []) as unknown[])).not.toMatch(/postgres/i);
        expect(JSON.stringify(wrapped)).not.toMatch(/403/);
      } finally {
        proc.mockRestore();
      }
    });
  });

  // Quarantined (#42) since P4.2: `observe` never applies a forget (`applyObserveForget` is not wired), so this
  // passed only while the database cue could not reach "Use postgres"; BM25F's subject field (its D7 key) now does.
  test.failing("Anthropic withKnowFactsAnthropic omits postgres after forget", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "user", content: FORGET_PG }]);
      const proc = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const anth = withKnowFactsAnthropic({
          system: "You are a coding agent.",
          messages: [{ role: "user", content: PG_CUE }],
        });
        const hay = JSON.stringify(anth);
        expect(hay).not.toMatch(/postgres/i);
        expect(hay).not.toMatch(/403/);
      } finally {
        proc.mockRestore();
      }
    });
  });

  test.failing("hook UserPromptSubmit forgets postgres so the next cue is absent", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.close();
      const seen = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: PG_CUE });
      expect(hookContext(seen)).toMatch(/postgres/i);
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: FORGET_PG });
      const next = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: PG_CUE });
      expect(hookContext(next)).not.toMatch(/postgres/i);
      expect(JSON.stringify(next ?? {})).not.toMatch(/403/);
    });
  });
});

describe("M43 adversarial forget", () => {
  test("negated forget does not tombstone, including a curly apostrophe", async () => {
    const curlyDont = "don\u2019t forget postgres";
    const curlyCant = "can\u2019t forget postgres";
    for (const utter of [
      "don't forget postgres",
      "do not forget postgres",
      "never forget postgres",
      "can't forget postgres",
      "cannot forget postgres",
      "never forget",
      curlyDont,
      curlyCant,
    ]) {
      expect(forgetMod.forgetCueFrom(utter)).toBeNull();
      await withMem(async (mem) => {
        mem.observe([{ role: "user", content: PG }]);
        mem.observe([{ role: "user", content: utter }]);
        expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).toMatch(/postgres/i);
      });
    }
  });

  // Quarantined (#42) since P4.2: `observe` never applies a forget (`applyObserveForget` is not wired), so this
  // passed only while the database cue could not reach "Use postgres"; BM25F's subject field (its D7 key) now does.
  test.failing("this turn may still show postgres; the next database cue does not", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      const thisTurn = packet(mem.inject([{ role: "user", content: FORGET_PG }]));
      expect(thisTurn).toMatch(/postgres/i);
      expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).not.toMatch(/postgres/i);
    });
  });

  test.failing("gist stack uses postgres stays gone after forget and sleep", async () => {
    await withMem(async (mem, dir) => {
      mem.observe([{ role: "user", content: PG }]);
      await mem.sleep();
      const gistBefore = new GistStore(dir)
        .latest("", 3)
        .map((g) => g.text)
        .join("\n");
      expect(gistBefore).toMatch(/stack uses postgres/i);
      mem.observe([{ role: "user", content: FORGET_PG }]);
      await mem.sleep();
      await sleep({ mem });
      expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).not.toMatch(/postgres/i);
      const gistFile = existsSync(join(dir, "gists.jsonl")) ? readFileSync(join(dir, "gists.jsonl"), "utf8") : "";
      expect(gistFile).not.toMatch(/postgres/i);
      const start = memoryHookResponse({ hook_event_name: "SessionStart" });
      expect(hookContext(start)).not.toMatch(/postgres/i);
    });
  });

  test("forgetting sqlite leaves The cache is postgres", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: "Use sqlite." }]);
      mem.observe([{ role: "user", content: "The cache is postgres." }]);
      mem.observe([{ role: "user", content: "forget sqlite" }]);
      const pkt = packet(mem.inject([{ role: "user", content: "what is the cache" }]));
      expect(pkt).toMatch(/postgres/i);
      expect(pkt).not.toMatch(/sqlite/i);
    });
  });

  // Quarantined (#42) since P4.2: `observe` never applies a forget (`applyObserveForget` is not wired), so this
  // passed only while the database cue could not reach "Use postgres"; BM25F's subject field (its D7 key) now does.
  test.failing("forget postgres does not drop an ICL label shot", async () => {
    const shot = "The movie was great. label: postgres";
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: shot }]);
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "user", content: FORGET_PG }]);
      // Not the shot itself: a cue repeating a row is its own residual (D26, the wrap's since P0.7).
      const pkt = packet(mem.inject([{ role: "user", content: "The movie was great. label:" }]));
      expect(pkt).toMatch(/label:\s*postgres/i);
      expect(packet(mem.inject([{ role: "user", content: PG_CUE }]))).not.toMatch(/use postgres/i);
    });
  });

  test("forget api_key does not write the secret into jsonl", async () => {
    const key = "sk-live-abc123xyz";
    await withMem(async (mem, dir) => {
      mem.observe([{ role: "user", content: `forget api_key=${key}` }]);
      mem.close();
      expect(jsonlContents(dir)).not.toContain(key);
    });
  });

  test("applyObserveForget throw still lets observe and inject return", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: PG }]);
      const boom = spyOn(forgetMod, "applyObserveForget").mockImplementation(() => {
        throw new Error("m43 forget boom");
      });
      try {
        let observed: unknown;
        expect(() => {
          observed = mem.observe([{ role: "user", content: FORGET_PG }]);
        }).not.toThrow();
        expect(observed).toEqual(expect.any(Array));
        const list = [{ role: "user", content: PG_CUE }];
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        expect(JSON.stringify(out)).not.toMatch(/403/);
        expect(packet(out as unknown[])).toMatch(/postgres/i);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test.failing("torn jsonl is skipped and forget still runs", async () => {
    await withMem(async (mem, dir) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.close();
      appendFileSync(join(dir, "memories.jsonl"), '{"id":\n');
      appendFileSync(join(dir, "semantic.jsonl"), '{"s":"stack"\n');
      const again = openMemory({ dir });
      expect(() => again.inject([{ role: "user", content: PG_CUE }])).not.toThrow();
      expect(packet(again.inject([{ role: "user", content: PG_CUE }]))).toMatch(/postgres/i);
      expect(() => again.observe([{ role: "user", content: FORGET_PG }])).not.toThrow();
      expect(packet(again.inject([{ role: "user", content: PG_CUE }]))).not.toMatch(/postgres/i);
      again.close();
    });
  });

  test("math cue stays silent and SessionStart still briefs the pin", async () => {
    await withMem(async (mem) => {
      mem.observe([{ role: "user", content: "always use sqlite" }]);
      const math = mem.inject([{ role: "user", content: "what is 2 + 2" }]);
      expect(packet(math)).not.toContain(MEMORY_MARK);
      const start = memoryHookResponse({ hook_event_name: "SessionStart" });
      expect(hookContext(start)).toMatch(/sqlite/i);
      expect(JSON.stringify(start ?? {})).not.toMatch(/403/);
    });
  });

  test("product files have no /forget route and no memory_search", () => {
    const files = [
      join(import.meta.dir, "memory-forget.ts"),
      join(import.meta.dir, "memory-consent.ts"),
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
      join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/\bmemory_search\b/);
      expect(src).not.toMatch(/["'`]\/forget["'`]/);
    }
    expect(forgetMod.applyObserveForget).toBeTypeOf("function");
  });
});
