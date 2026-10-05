/**
 * M7.4 sleep tests. Covers M7.2–M7.3 (LWW/tombstone, ICL skip, gists, Start briefing)
 * plus M7.1 fail-open: Stop runs sleep; throwing sleep must not live inside inject.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMemory, MEMORY_MARK, memoryInjectSwallows, openMemory, sleep } from "./index";
import { EXPERIENCE_DIRNAME, putExperience } from "./experience-store";
import { SemanticStore } from "./semantic-store";
import { GistStore } from "./gist-store";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import * as sleepMod from "./sleep";
import {
  flushIncrementalSleep,
  maybeIncrementalSleep,
  noteSleepActivity,
  parseSleepEvery,
  scheduleIncrementalSleep,
  sleepBudgetMs,
  sleepIdleMs,
} from "./sleep";

function tmpDir(prefix = "eden-m74-"): string {
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
  prefix: string,
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
  session?: string,
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
    try {
      const mem = openMemory({ dir, session });
      return await fn(mem, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
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

function importsClsSemantic(src: string): boolean {
  return (
    /(?:^|\n)\s*(?:import|export)\s+[^;\n]*from\s+["'][^"']*cls\/semantic["']/.test(src) ||
    /(?:^|\n)\s*import\s*\(\s*["'][^"']*cls\/semantic["']\s*\)/.test(src) ||
    /(?:^|\n)\s*require\s*\(\s*["'][^"']*cls\/semantic["']\s*\)/.test(src)
  );
}

const LONG_FACTS = [
  "CI is GitHub Actions",
  "Auth is Clerk",
  "The deploy region is us-east-1",
  "Kai timezone is Pacific",
  "The cache is Redis",
  "The queue is SQS",
  "The cluster is named aurora-prod",
  "Node version is 22",
  "The repo is KaiavN/Eden",
  "On-call rotation is PagerDuty",
  "Feature flag vendor is LaunchDarkly",
  "The primary database is postgres",
];

describe("M7.2 SemanticStore LWW put/get/tombstone", () => {
  test("put/get last-write-wins; tombstone hides the live row", () => {
    const dir = tmpDir("eden-m74-lww-");
    try {
      const store = new SemanticStore(dir);
      store.put("auth", "is", "Clerk", 1);
      expect(factObject(store.get("auth", "is"))).toMatch(/Clerk/i);
      store.put("auth", "is", "Auth0", 2);
      expect(factObject(store.get("auth", "is"))).toMatch(/Auth0/i);
      expect(factObject(store.get("auth", "is"))).not.toMatch(/Clerk/i);
      store.tombstone("auth", "is", 3);
      expect(store.get("auth", "is") == null).toBe(true);
      const reopened = new SemanticStore(dir);
      expect(reopened.get("auth", "is") == null).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M7.2 Clerk status is not a delete", () => {
  test("Auth is Clerk then Auth is failing then sleep: inject still has Clerk", async () => {
    await withMem("eden-m74-clerk-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(true);
      await sleep({ dir, mem });
      const out = mem.inject([{ role: "user", content: "what is auth" }]);
      const pkt = packetOf(out);
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Clerk/);
      const live = factObject(new SemanticStore(dir).get("auth", "is"));
      expect(live).toMatch(/Clerk/i);
      expect(live).not.toMatch(/failing/i);
    });
  });
});

describe("M7.2 chairperson serial-newer wins", () => {
  test("Alice then Bob + sleep: inject packet has Bob, Alice is gone (not ×0.45)", async () => {
    await withMem("eden-m74-chair-", async (mem, dir) => {
      mem.remember("The chairperson of the committee is Alice.");
      mem.remember("The chairperson of the committee is Bob.");
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(true);
      await sleep({ dir, mem });
      const out = mem.inject([{ role: "user", content: "who is the chairperson" }]);
      const pkt = packetOf(out);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
      expect(mem.memories().some((r) => /Alice/.test(r.text))).toBe(false);
      expect(factObject(new SemanticStore(dir).get("chairperson of the committee", "is"))).toMatch(/Bob/i);
    });
  });
});

describe("M7.2 postgres then sqlite instead", () => {
  test("old postgres is absent from the inject packet after sleep", async () => {
    await withMem("eden-m74-pg-", async (mem, dir) => {
      mem.remember("The database is postgres.");
      mem.remember("The database is sqlite instead.");
      await sleep({ dir, mem });
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
      expect(mem.memories().some((r) => /postgres/i.test(r.text))).toBe(false);
    });
  });

  test("sqlite instead of postgres: live object and packet drop the old name", async () => {
    await withMem("eden-m74-instead-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      const live = factObject(new SemanticStore(dir).get("database", "is"));
      expect(live).toMatch(/sqlite/i);
      expect(live).not.toMatch(/postgres/i);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
    });
  });

  test("Bob instead of Alice: inject packet has no Alice", async () => {
    await withMem("eden-m74-instead-chair-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The chairperson of the committee is Alice." }]);
      mem.observe([{ role: "user", content: "The chairperson of the committee is Bob instead of Alice." }]);
      await sleep({ dir, mem });
      const chairPkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(chairPkt).toMatch(/Bob/);
      expect(chairPkt).not.toMatch(/Alice/);
    });
  });
});

describe("M7.2 concurrent SemanticStore put", () => {
  test("two stores on the same file keep both triples", () => {
    const dir = tmpDir("eden-m74-sem-conc-");
    try {
      const a = new SemanticStore(dir);
      const b = new SemanticStore(dir);
      a.put("auth", "is", "Clerk", 1);
      b.put("ci", "is", "GitHub Actions", 2);
      const reopened = new SemanticStore(dir);
      expect(factObject(reopened.get("auth", "is"))).toMatch(/Clerk/i);
      expect(factObject(reopened.get("ci", "is"))).toMatch(/GitHub Actions/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("quiet observe batches semantic persist; reopen sees first and last", async () => {
    await withMem("eden-m15-sem-batch-", async (mem, dir) => {
      mem.quiet(() => {
        for (let i = 0; i < 80; i++) {
          mem.observe([{ role: "user", content: `Service${i} is backend-${i}` }]);
        }
      });
      const store = new SemanticStore(dir);
      expect(factObject(store.get("service0", "is"))).toMatch(/backend-0/i);
      expect(factObject(store.get("service79", "is"))).toMatch(/backend-79/i);
    });
  });
});

describe("M7.2 ICL exemplars skip SemanticStore", () => {
  test("label: / Input-Output lines are not compiled as facts", async () => {
    await withMem("eden-m74-icl-", async (mem, dir) => {
      const track = spyOn(SemanticStore.prototype, "put");
      try {
        mem.remember("The movie was great. label: positive");
        mem.remember("Input: The film is terrible. Output: negative");
        mem.remember("CI is GitHub Actions");
        await sleep({ dir, mem });
        const store = new SemanticStore(dir);
        expect(factObject(store.get("movie", "label"))).not.toMatch(/positive/i);
        expect(factObject(store.get("label", "is"))).not.toMatch(/positive/i);
        expect(factObject(store.get("the movie was great", "label"))).not.toMatch(/positive/i);
        for (const row of store.live()) {
          expect(row.o.toLowerCase()).not.toBe("positive");
          expect(row.o.toLowerCase()).not.toBe("negative");
          expect(row.p.toLowerCase()).not.toBe("label");
        }
        for (const call of track.mock.calls) {
          const o = String(call[2] ?? "");
          const p = String(call[1] ?? "");
          expect(o.toLowerCase()).not.toBe("positive");
          expect(o.toLowerCase()).not.toBe("negative");
          expect(p.toLowerCase()).not.toBe("label");
        }
      } finally {
        track.mockRestore();
      }
    });
  });

  test("split Input: / Output: turns are not compiled as facts", async () => {
    await withMem("eden-m74-icl-split-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Input: The film is terrible." }]);
      mem.observe([{ role: "user", content: "Output: negative" }]);
      await sleep({ dir, mem });
      const store = new SemanticStore(dir);
      expect(factObject(store.get("film", "is"))).not.toMatch(/terrible/i);
      for (const row of store.live()) {
        expect(row.o.toLowerCase()).not.toBe("negative");
        expect(row.o.toLowerCase()).not.toBe("terrible");
      }
    });
  });

  test("list-prefixed Input: lines are not compiled as facts", async () => {
    await withMem("eden-m74-icl-list-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "> Input: The film is terrible." }]);
      mem.observe([{ role: "user", content: "- Input: The movie was great. label: positive" }]);
      await sleep({ dir, mem });
      const store = new SemanticStore(dir);
      expect(factObject(store.get("film", "is"))).not.toMatch(/terrible/i);
      for (const row of store.live()) {
        expect(row.o.toLowerCase()).not.toBe("terrible");
        expect(row.o.toLowerCase()).not.toBe("positive");
      }
    });
  });

  test("list-prefixed identity + trailing label: is not compiled as a fact", async () => {
    await withMem("eden-m74-icl-split-label-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "- The movie was great. label: positive" }]);
      mem.observe([{ role: "user", content: "> The film is terrible. label: negative" }]);
      mem.observe([{ role: "user", content: "1. The movie was great. label: positive" }]);
      await sleep({ dir, mem });
      const store = new SemanticStore(dir);
      expect(factObject(store.get("movie", "is"))).not.toMatch(/great/i);
      expect(factObject(store.get("film", "is"))).not.toMatch(/terrible/i);
      for (const row of store.live()) {
        expect(row.o.toLowerCase()).not.toBe("great");
        expect(row.o.toLowerCase()).not.toBe("terrible");
        expect(row.o.toLowerCase()).not.toBe("positive");
        expect(row.o.toLowerCase()).not.toBe("negative");
      }
    });
  });
});

describe("M7.3 gists + SessionStart", () => {
  test("long session + sleep: a gist exists and SessionStart injects it", async () => {
    const session = "s-m74-long";
    await withMem(
      "eden-m74-gist-",
      async (mem, dir) => {
        mem.quiet(() => {
          for (const fact of LONG_FACTS) mem.remember(fact);
        });
        await sleep({ dir, mem, session });
        const gists = new GistStore(dir).latest(session, 5);
        expect(gists.length).toBeGreaterThan(0);
        const gistText = gists.map((g) => g.text).join("\n");
        expect(gistText.length).toBeGreaterThan(0);
        expect(existsSync(join(dir, "gists.jsonl"))).toBe(true);

        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const ctx = hookContext(start);
        expect(ctx).toContain(MEMORY_MARK);
        expect(ctx).toMatch(/\(from a summary of earlier work/);
        expect(ctx).toContain(gists[0]!.text);
      },
      session,
    );
  });

  test("SessionStart has pin+gist, not last-k unpinned junk", async () => {
    const session = "s-m74-junk";
    await withMem(
      "eden-m74-start-",
      async (mem, dir) => {
        mem.remember("Always run bun test before you push.", { kind: "constraint" });
        mem.quiet(() => {
          for (const fact of LONG_FACTS) mem.remember(fact);
        });
        mem.remember("Lunch menu chatter and random weather talk from the hallway.", { kind: "episode" });
        await sleep({ dir, mem, session });
        const gists = new GistStore(dir).latest(session, 5);
        expect(gists.length).toBeGreaterThan(0);

        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const ctx = hookContext(start);
        expect(ctx).toContain(MEMORY_MARK);
        expect(ctx).toMatch(/bun test/i);
        expect(ctx).toMatch(/\(from a summary of earlier work/);
        expect(ctx).toContain(gists[0]!.text);
        expect(ctx).not.toMatch(/lunch menu chatter/i);
        expect(ctx).not.toMatch(/weather talk from the hallway/i);
      },
      session,
    );
  });

  test("SessionStart after a later sleep does not brief a tombstoned gist name", async () => {
    const session = "s-m74-gist-lww";
    await withMem(
      "eden-m74-gist-lww-",
      async (mem, dir) => {
        mem.observe([{ role: "user", content: "The database is postgres." }]);
        await sleep({ dir, mem, session });
        mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
        await sleep({ dir, mem, session });
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const ctx = hookContext(start);
        expect(ctx).toContain(MEMORY_MARK);
        expect(ctx).toMatch(/sqlite/i);
        expect(ctx).not.toMatch(/postgres/i);
      },
      session,
    );
  });

  test("SessionStart transcript re-observe does not brief instead-of postgres", async () => {
    const session = "s-m74-start-trans";
    await withMem(
      "eden-m74-start-trans-",
      async (mem, dir) => {
        mem.observe([{ role: "user", content: "The database is postgres." }]);
        mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
        await sleep({ dir, mem, session });
        const trans = join(dir, "t.jsonl");
        writeFileSync(
          trans,
          ["The database is postgres.", "The database is sqlite instead of postgres."]
            .map((c) => JSON.stringify({ type: "user", message: { role: "user", content: c } }))
            .join("\n") + "\n",
        );
        const start = memoryHookResponse({
          hook_event_name: "SessionStart",
          session_id: session,
          transcript_path: trans,
        });
        const ctx = hookContext(start);
        expect(ctx).toContain(MEMORY_MARK);
        expect(ctx).toMatch(/sqlite/i);
        expect(ctx).not.toMatch(/postgres/i);
        const pkt = packetOf(
          openMemory({ dir, session }).inject([{ role: "user", content: "what database do we use" }]),
        );
        expect(pkt).toMatch(/sqlite/i);
        expect(pkt).not.toMatch(/postgres/i);
      },
      session,
    );
  });

  test("injectBody system postgres after sqlite sleep does not resurrect postgres", async () => {
    await withMem("eden-m74-sys-pg-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      mem.injectBody({
        system: "The database is postgres.",
        messages: [{ role: "user", content: "what database do we use" }],
      });
      await sleep({ dir, mem });
      const live = factObject(new SemanticStore(dir).get("database", "is"));
      expect(live).toMatch(/sqlite/i);
      expect(live).not.toMatch(/postgres/i);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
    });
  });

  test("later user identity postgres after sqlite sleep is LWW", async () => {
    await withMem("eden-m74-lww-user-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      await sleep({ dir, mem });
      const live = factObject(new SemanticStore(dir).get("database", "is"));
      expect(live).toMatch(/postgres/i);
      expect(live).not.toMatch(/sqlite/i);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/postgres/i);
      expect(pkt).not.toMatch(/sqlite/i);
    });
  });

  test("same-request wrap system postgres does not beat user sqlite", async () => {
    await withMem("eden-m74-sys-user-", async (mem, dir) => {
      mem.injectBody({
        system: "The database is postgres.",
        messages: [{ role: "user", content: "The database is sqlite instead of postgres." }],
      });
      await sleep({ dir, mem });
      const live = factObject(new SemanticStore(dir).get("database", "is"));
      expect(live).toMatch(/sqlite/i);
      expect(live).not.toMatch(/postgres/i);
    });
  });

  test("Stop/Start leftover system_prompt does not beat live sqlite", async () => {
    await withMem("eden-m74-hook-sys-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      const stop = memoryHookResponse({ hook_event_name: "Stop", system_prompt: "The database is postgres." });
      expect(stop).toBeNull();
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      const start = memoryHookResponse({ hook_event_name: "SessionStart", system_prompt: "The database is postgres." });
      const ctx = hookContext(start);
      expect(ctx).toMatch(/sqlite/i);
      expect(ctx).not.toMatch(/postgres/i);
    });
  });

  test("Stop/Start leftover content does not beat live sqlite", async () => {
    await withMem("eden-m74-hook-content-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      const stop = memoryHookResponse({ hook_event_name: "Stop", content: "The database is postgres." });
      expect(stop).toBeNull();
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      const start = memoryHookResponse({ hook_event_name: "SessionStart", content: "The database is postgres." });
      const ctx = hookContext(start);
      expect(ctx).toMatch(/sqlite/i);
      expect(ctx).not.toMatch(/postgres/i);
    });
  });

  test("UserPromptSubmit leftover system_prompt does not beat live sqlite", async () => {
    await withMem("eden-m74-ups-sys-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", system_prompt: "The database is postgres." });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      const pkt = packetOf(openMemory({ dir }).inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
    });
  });

  test("injectBody leftover Use postgres does not resurrect a tombstoned name", async () => {
    await withMem("eden-m74-use-pg-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(factObject(new SemanticStore(dir).get("database", "is"))).toMatch(/sqlite/i);
      mem.injectBody({ system: "Use postgres.", messages: [{ role: "user", content: "what database do we use" }] });
      await sleep({ dir, mem });
      const live = factObject(new SemanticStore(dir).get("database", "is"));
      expect(live).toMatch(/sqlite/i);
      expect(live).not.toMatch(/postgres/i);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
    });
  });
});

describe("M7.1 Stop/SessionEnd runs sleep", () => {
  test("after Stop, semantic.jsonl or gists.jsonl exists (or sleep/consolidate was called)", async () => {
    const dir = tmpDir("eden-m74-stop-");
    const trans = join(dir, "t.jsonl");
    await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
      try {
        writeFileSync(
          trans,
          `${JSON.stringify({ type: "user", message: { role: "user", content: "Auth is Clerk" } })}\n`,
        );
        const consSpy = spyOn(sleepMod, "consolidate");
        const sleepFnSpy = spyOn(sleepMod, "sleep");
        const memSleep = spyOn(AgentMemory.prototype, "sleep");
        try {
          const stop = memoryHookResponse({
            hook_event_name: "Stop",
            session_id: "s-m74-stop",
            transcript_path: trans,
          });
          expect(stop).toBeNull();
          const files = [join(dir, "semantic.jsonl"), join(dir, "gists.jsonl")];
          const wrote = files.some((p) => existsSync(p));
          const called = consSpy.mock.calls.length + sleepFnSpy.mock.calls.length + memSleep.mock.calls.length > 0;
          expect(wrote || called).toBe(true);
          expect(wrote).toBe(true);

          const endDir = tmpDir("eden-m74-end-");
          try {
            await withEnv({ EDEN_MEMORY_DIR: endDir, EDEN_HOME: undefined }, () => {
              const mem = openMemory({ dir: endDir });
              mem.remember("CI is GitHub Actions");
              mem.close();
              memoryHookResponse({ hook_event_name: "SessionEnd" });
              expect(existsSync(join(endDir, "semantic.jsonl")) || existsSync(join(endDir, "gists.jsonl"))).toBe(true);
            });
          } finally {
            rmSync(endDir, { recursive: true, force: true });
          }
        } finally {
          consSpy.mockRestore();
          sleepFnSpy.mockRestore();
          memSleep.mockRestore();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("M7.1 sleep throw does not break inject", () => {
  test("spy consolidate/sleep to throw: inject still returns messages; swallows unchanged", async () => {
    await withMem("eden-m74-failopen-", async (mem) => {
      mem.remember("Auth is Clerk");
      const list = [{ role: "user", content: "what is auth" }];
      const before = memoryInjectSwallows.n;
      const consSpy = spyOn(sleepMod, "consolidate").mockImplementation(() => {
        throw new Error("m74 consolidate boom");
      });
      const sleepSpy = spyOn(sleepMod, "sleep").mockImplementation(async () => {
        throw new Error("m74 sleep boom");
      });
      const memSleep = spyOn(AgentMemory.prototype, "sleep").mockImplementation(async () => {
        throw new Error("m74 AgentMemory.sleep boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        const pkt = packetOf(out as unknown[]);
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toMatch(/Clerk/);
        expect(memoryInjectSwallows.n).toBe(before);
        expect(consSpy).not.toHaveBeenCalled();
        expect(sleepSpy).not.toHaveBeenCalled();
        expect(memSleep).not.toHaveBeenCalled();
      } finally {
        consSpy.mockRestore();
        sleepSpy.mockRestore();
        memSleep.mockRestore();
      }
    });
  });
});

describe("M25.4 corrupt experience does not throw out of sleep", () => {
  test("torn experience/bad.jsonl: sleep() does not throw; inject still returns an array", async () => {
    await withMem("eden-m25-sleep-corrupt-", async (mem, dir) => {
      const marker = "UNIQUE_M25_SLEEP_CORRUPT_MARKER";
      putExperience(dir, {
        id: "traj-m25-sleep-good",
        states: [{ thought: `Goal: ${marker}`, action: `Outcome: ${marker} kept`, t: 1 }],
      });
      mkdirSync(join(dir, EXPERIENCE_DIRNAME), { recursive: true });
      writeFileSync(join(dir, EXPERIENCE_DIRNAME, "bad.jsonl"), "{{{not-json\n");
      let threw = false;
      try {
        await sleep({ dir, mem });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      const list = [{ role: "user", content: `cue ${marker}` }];
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
    });
  });
});

describe("M7.4 product inject/sleep path does not import copula compile", () => {
  test("sleep.ts, semantic-store.ts, and index.ts do not import cls/semantic", () => {
    const files = [
      join(import.meta.dir, "sleep.ts"),
      join(import.meta.dir, "semantic-store.ts"),
      join(import.meta.dir, "index.ts"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect({ file: f, cls: importsClsSemantic(src) }).toEqual({ file: f, cls: false });
      expect(src).not.toMatch(/from\s+["']\.\/cls\/semantic["']/);
      expect(src).not.toMatch(/from\s+["'][^"']*cls\/semantic["']/);
    }
  });
});

/** One product tick, then a second in case schedule queues the consolidate. */
async function flushSleep(): Promise<void> {
  await flushIncrementalSleep();
  await flushIncrementalSleep();
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[i] ?? 0;
}

function hasPostgresEpisode(mem: AgentMemory): boolean {
  return mem.memories().some((r) => /database is postgres/i.test(r.text) && !/sqlite/i.test(r.text));
}

/** Encode keeps the raw loser. observe() peels "instead of" before sleep, so the episode would already be gone. */
function plantSupersede(mem: AgentMemory): void {
  mem.remember("The database is postgres.");
  mem.remember("The database is sqlite instead of postgres.");
}

describe("M42.1 after N observes a gist may appear and the open fact survives", () => {
  test("EDEN_SLEEP_EVERY=3 writes a gist and the postgres packet still matches", async () => {
    const session = "s-m42-every";
    await withEnv({ EDEN_SLEEP_EVERY: "3", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem(
        "eden-m42-every-",
        async (mem, dir) => {
          mem.observe([{ role: "user", content: "The database is postgres." }]);
          mem.observe([{ role: "user", content: "Auth is Clerk." }]);
          mem.observe([{ role: "user", content: "CI is GitHub Actions." }]);
          await flushSleep();
          const gists = new GistStore(dir).latest(session, 5);
          const gistFile = existsSync(join(dir, "gists.jsonl"));
          expect(gistFile || gists.length > 0 || new GistStore(dir).latest("", 5).length > 0).toBe(true);
          const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
          expect(pkt).toMatch(/postgres/i);
          expect(hasPostgresEpisode(mem)).toBe(true);
        },
        session,
      ),
    );
  });
});

describe("M42.1 no mid-task tombstone", () => {
  test("incremental keeps the postgres episode; full sleep tombstones it out of the packet", async () => {
    const session = "s-m42-notomb";
    await withEnv({ EDEN_SLEEP_EVERY: "2", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem(
        "eden-m42-notomb-",
        async (mem, dir) => {
          const drop = spyOn(mem, "dropWhere");
          try {
            plantSupersede(mem);
            mem.observe([{ role: "user", content: "Auth is Clerk." }]);
            mem.observe([{ role: "user", content: "CI is GitHub Actions." }]);
            await flushSleep();
            expect(drop).not.toHaveBeenCalled();
            expect(hasPostgresEpisode(mem)).toBe(true);
            const live = mem
              .memories()
              .map((r) => r.text)
              .join("\n");
            expect(live).toMatch(/postgres/i);
            await sleep({ dir, mem, session });
            const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
            expect(pkt).toMatch(/sqlite/i);
            expect(pkt).not.toMatch(/postgres/i);
          } finally {
            drop.mockRestore();
          }
        },
        session,
      ),
    );
  });
});

describe("M42.2 inject never waits on sleep", () => {
  test("inject returns with consolidate still uncalled; p95 of 20 injects stays under 20ms", async () => {
    await withEnv({ EDEN_SLEEP_EVERY: "1", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem("eden-m42-nowait-", async (mem) => {
        mem.remember("Auth is Clerk");
        const cons = spyOn(sleepMod, "consolidate");
        const maybe = spyOn(sleepMod, "maybeIncrementalSleep");
        try {
          const samples: number[] = [];
          const list = [{ role: "user", content: "what is auth" }];
          for (let i = 0; i < 20; i++) {
            const consBefore = cons.mock.calls.length;
            const maybeBefore = maybe.mock.calls.length;
            const t0 = performance.now();
            const out = mem.inject(list);
            samples.push(performance.now() - t0);
            expect(Array.isArray(out)).toBe(true);
            expect(cons.mock.calls.length).toBe(consBefore);
            expect(maybe.mock.calls.length).toBe(maybeBefore);
          }
          expect(p95(samples)).toBeLessThan(20);
          await flushSleep();
        } finally {
          cons.mockRestore();
          maybe.mockRestore();
        }
      }),
    );
  });
});

describe("M42.3 Stop still full", () => {
  test("after incremental, Stop tombstones postgres out of the inject packet", async () => {
    const session = "s-m42-stop";
    await withEnv({ EDEN_SLEEP_EVERY: "2", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem(
        "eden-m42-stop-",
        async (mem, dir) => {
          plantSupersede(mem);
          mem.observe([{ role: "user", content: "Auth is Clerk." }]);
          mem.observe([{ role: "user", content: "CI is GitHub Actions." }]);
          await flushSleep();
          expect(hasPostgresEpisode(mem)).toBe(true);
          const stop = memoryHookResponse({ hook_event_name: "Stop", session_id: session });
          expect(stop).toBeNull();
          const pkt = packetOf(
            openMemory({ dir, session }).inject([{ role: "user", content: "what database do we use" }]),
          );
          expect(pkt).toMatch(/sqlite/i);
          expect(pkt).not.toMatch(/postgres/i);
        },
        session,
      ),
    );
  });

  test("SessionEnd after incremental also full-tombstones postgres", async () => {
    const session = "s-m42-end";
    await withEnv({ EDEN_SLEEP_EVERY: "2", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem(
        "eden-m42-end-",
        async (mem, dir) => {
          plantSupersede(mem);
          mem.observe([{ role: "user", content: "Auth is Clerk." }]);
          mem.observe([{ role: "user", content: "CI is GitHub Actions." }]);
          await flushSleep();
          expect(hasPostgresEpisode(mem)).toBe(true);
          memoryHookResponse({ hook_event_name: "SessionEnd", session_id: session });
          const pkt = packetOf(
            openMemory({ dir, session }).inject([{ role: "user", content: "what database do we use" }]),
          );
          expect(pkt).toMatch(/sqlite/i);
          expect(pkt).not.toMatch(/postgres/i);
        },
        session,
      ),
    );
  });
});

describe("M42.4 incremental throw leaves inject unchanged", () => {
  test("scheduled consolidate throw: inject stays an array, Clerk still injects, swallows unchanged", async () => {
    await withEnv({ EDEN_SLEEP_EVERY: "1", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem("eden-m42-throw-", async (mem) => {
        mem.remember("Auth is Clerk");
        const before = memoryInjectSwallows.n;
        const cons = spyOn(sleepMod, "consolidate").mockImplementation(() => {
          throw new Error("m42 consolidate boom");
        });
        try {
          mem.observe([{ role: "user", content: "The database is postgres." }]);
          const list = [{ role: "user", content: "what is auth" }];
          let out: unknown;
          expect(() => {
            out = mem.inject(list);
          }).not.toThrow();
          expect(Array.isArray(out)).toBe(true);
          const pkt = packetOf(out as unknown[]);
          expect(pkt).toContain(MEMORY_MARK);
          expect(pkt).toMatch(/Clerk/);
          let flushThrew = false;
          try {
            await flushSleep();
          } catch {
            flushThrew = true;
          }
          expect(flushThrew).toBe(false);
          expect(memoryInjectSwallows.n).toBe(before);
          const again = mem.inject(list);
          expect(Array.isArray(again)).toBe(true);
          expect(packetOf(again)).toMatch(/Clerk/);
          expect(memoryInjectSwallows.n).toBe(before);
        } finally {
          cons.mockRestore();
        }
      }),
    );
  });

  test("maybeIncrementalSleep throw does not escape inject", async () => {
    await withEnv({ EDEN_SLEEP_EVERY: "1", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem("eden-m42-maybe-throw-", async (mem) => {
        mem.remember("Auth is Clerk");
        const before = memoryInjectSwallows.n;
        const inc = spyOn(sleepMod, "maybeIncrementalSleep").mockImplementation(() => {
          throw new Error("m42 maybeIncrementalSleep boom");
        });
        try {
          const list = [{ role: "user", content: "what is auth" }];
          let out: unknown;
          expect(() => {
            out = mem.inject(list);
          }).not.toThrow();
          expect(Array.isArray(out)).toBe(true);
          expect(packetOf(out as unknown[])).toMatch(/Clerk/);
          expect(() => {
            mem.inject(list);
          }).not.toThrow();
          expect(memoryInjectSwallows.n).toBe(before);
        } finally {
          inc.mockRestore();
        }
      }),
    );
  });
});

describe("M42 defaults are conservative", () => {
  test("unset EVERY is 32 turns; unset IDLE is 300000; 3, 64k, and 0 parse", async () => {
    await withEnv({ EDEN_SLEEP_EVERY: undefined, EDEN_SLEEP_IDLE: undefined, EDEN_SLEEP_BUDGET: undefined }, () => {
      expect(parseSleepEvery()).toEqual({ turns: 32, bytes: 0 });
      expect(sleepIdleMs()).toBe(300000);
      expect(sleepBudgetMs()).toBe(25);
    });
    await withEnv({ EDEN_SLEEP_EVERY: "3" }, () => {
      expect(parseSleepEvery()).toEqual({ turns: 3, bytes: 0 });
    });
    await withEnv({ EDEN_SLEEP_EVERY: "64k" }, () => {
      expect(parseSleepEvery()).toEqual({ turns: 0, bytes: 64 * 1024 });
    });
    await withEnv({ EDEN_SLEEP_EVERY: "0" }, () => {
      expect(parseSleepEvery()).toEqual({ turns: 0, bytes: 0 });
    });
    await withEnv({ EDEN_SLEEP_IDLE: "0" }, () => {
      expect(sleepIdleMs()).toBe(0);
    });
  });
});

describe("M42.1 idle past EDEN_SLEEP_IDLE is full (tombstones allowed)", () => {
  test("stale lastAt + IDLE=50ms: maybeIncrementalSleep dropWhere-tombstones postgres", async () => {
    await withEnv({ EDEN_SLEEP_EVERY: "0", EDEN_SLEEP_IDLE: "50", EDEN_MEMORY: "on" }, () =>
      withMem("eden-m42-idle-", async (mem, dir) => {
        plantSupersede(mem);
        expect(hasPostgresEpisode(mem)).toBe(true);
        writeFileSync(join(dir, "sleep-clock.json"), JSON.stringify({ turns: 0, bytes: 0, lastAt: Date.now() - 200 }));
        maybeIncrementalSleep(mem, { session: "s-m42-idle" });
        const pkt = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
        expect(pkt).toMatch(/sqlite/i);
        expect(pkt).not.toMatch(/postgres/i);
      }),
    );
  });
});

describe("M42 sleep-clock.json omits identifiers", () => {
  test("observe + incremental persist does not write session, email, or cwd", async () => {
    const session = "sess-m42-clock-id";
    const cwd = "/tmp/eden-m42-clock-cwd";
    const email = "m42-clock@eden.dev";
    await withEnv({ EDEN_SLEEP_EVERY: "1", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, async () => {
      const dir = tmpDir("eden-m42-clock-");
      try {
        const mem = openMemory({ dir, session, cwd });
        mem.observe([
          {
            role: "user",
            content: `The database is sqlite. Contact ${email}. cwd ${cwd}. session ${session}. session_id ${session}.`,
          },
        ]);
        await flushSleep();
        const raw = existsSync(join(dir, "sleep-clock.json"))
          ? readFileSync(join(dir, "sleep-clock.json"), "utf8")
          : "";
        expect(raw.length).toBeGreaterThan(0);
        expect(raw).not.toContain(session);
        expect(raw).not.toContain(email);
        expect(raw).not.toContain(cwd);
        expect(raw).not.toMatch(/session_id/i);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        expect(parsed.session_id).toBeUndefined();
        expect(parsed.email).toBeUndefined();
        expect(parsed.cwd).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("M42 consent off does not write incremental gists", () => {
  test("EDEN_MEMORY=0: incremental sleep does not put a gist", async () => {
    await withEnv({ EDEN_SLEEP_EVERY: "0", EDEN_SLEEP_IDLE: "0", EDEN_MEMORY: "on" }, () =>
      withMem("eden-m42-consent-", async (mem, dir) => {
        mem.observe([{ role: "user", content: "The database is postgres." }]);
        mem.observe([{ role: "user", content: "Auth is Clerk." }]);
        await flushSleep();
        const gistBefore = existsSync(join(dir, "gists.jsonl"));
        const textBefore = new GistStore(dir)
          .latest("", 5)
          .map((g) => g.text)
          .join("\n");
        const put = spyOn(GistStore.prototype, "put");
        try {
          await withEnv({ EDEN_MEMORY: "0", EDEN_SLEEP_EVERY: "1", EDEN_SLEEP_IDLE: "0" }, async () => {
            noteSleepActivity(dir, { turns: 32 });
            maybeIncrementalSleep(mem);
            scheduleIncrementalSleep(mem);
            await flushSleep();
          });
          expect(put).not.toHaveBeenCalled();
          expect(existsSync(join(dir, "gists.jsonl"))).toBe(gistBefore);
          expect(
            new GistStore(dir)
              .latest("", 5)
              .map((g) => g.text)
              .join("\n"),
          ).toBe(textBefore);
        } finally {
          put.mockRestore();
        }
      }),
    );
  });
});
