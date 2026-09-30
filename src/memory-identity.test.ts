/**
 * M35.3 leftover identity. Tombstoned objects stay out of the inject packet,
 * gists, and experience slices. Experience traj files stay on disk (M25 store-all).
 * cwd / email / session_id are never stored. Wrap + hook share the same pin.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools } from "../packages/wrap/src/tool-observe";
import { EXPERIENCE_DIRNAME, putExperience } from "./experience-store";
import { retrieveExperience } from "./experience-retrieve";
import { GistStore, scrubTombstonedIdentity } from "./gist-store";
import { AgentMemory, MEMORY_MARK, openMemory, sleep } from "./index";
import * as edenMem from "./index";
import { SemanticStore } from "./semantic-store";

const SESSION = "sess-m35-unique-session";
const EMAIL = "kai-m35@example.com";
const CWD = "/tmp/eden-m35-unique-cwd";
const CUE = "what database do we use";

function tmpDir(prefix = "eden-m35-"): string {
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
  cwd?: string,
): Promise<T> {
  const dir = tmpDir(prefix);
  return withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_MEMORY: "on" }, async () => {
    try {
      const mem = openMemory({ dir, session, cwd });
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

function readNamed(root: string): string {
  const names = new Set(["memories.jsonl", "semantic.jsonl", "gists.jsonl", "howto.jsonl", "howtos.jsonl"]);
  const chunks: string[] = [];
  const walk = (dir: string, underExperience: boolean) => {
    if (!existsSync(dir)) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p, underExperience || ent.name === EXPERIENCE_DIRNAME);
        continue;
      }
      const expFile = underExperience && ent.name.endsWith(".jsonl");
      if (!names.has(ent.name) && !expFile) continue;
      try {
        chunks.push(readFileSync(p, "utf8"));
      } catch {}
    }
  };
  walk(root, false);
  return chunks.join("\n");
}

function gistText(dir: string): string {
  const p = join(dir, "gists.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function experienceFiles(dir: string): string[] {
  const exp = join(dir, EXPERIENCE_DIRNAME);
  if (!existsSync(exp)) return [];
  return readdirSync(exp)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(exp, n));
}

/** Postgres then sqlite, plus traj files that still mention the loser. Files stay. */
async function seedSwitch(mem: AgentMemory, dir: string): Promise<string[]> {
  mem.observe([{ role: "user", content: "The database is postgres." }]);
  mem.observe([{ role: "user", content: "The database is sqlite instead." }]);
  putExperience(dir, {
    id: "traj-m35-pg-only",
    states: [{ thought: "The database is postgres.", t: 1 }],
  });
  putExperience(dir, {
    id: "traj-m35-db-switch",
    states: [
      { thought: "The database is postgres.", t: 2 },
      {
        thought: "The database is sqlite instead of postgres.",
        goal: "The database is postgres.",
        outcome: "The database is sqlite.",
        t: 3,
      },
    ],
  });
  const files = experienceFiles(dir);
  expect(files.length).toBeGreaterThanOrEqual(2);
  await sleep({ dir, mem });
  return files;
}

function expectLiveSqlite(hay: string): void {
  expect(hay).toMatch(/sqlite/i);
  expect(hay).not.toMatch(/postgres/i);
}

describe("M35.3 leftover identity — packet, gists, experience", () => {
  test("postgres then sqlite: packet and gists drop the tombstone; traj files stay", async () => {
    await withMem("eden-m35-pg-", async (mem, dir) => {
      const before = await seedSwitch(mem, dir);
      for (const p of before) {
        expect(existsSync(p)).toBe(true);
        const raw = readFileSync(p, "utf8");
        expect(raw.length).toBeGreaterThan(0);
        expect(raw).toMatch(/postgres/i);
      }
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).toContain(MEMORY_MARK);
      expectLiveSqlite(pkt);
      expectLiveSqlite(gistText(dir));
      const slices = retrieveExperience(dir, CUE)
        .map((s) => s.text)
        .join("\n");
      expect(slices).not.toMatch(/postgres/i);
      if (slices.trim()) expect(slices).toMatch(/sqlite/i);
      const live = new SemanticStore(dir).get("database", "is");
      expect(String(live?.o ?? "")).toMatch(/sqlite/i);
      expect(String(live?.o ?? "")).not.toMatch(/postgres/i);
    });
  });

  test("chat-only fact still injects; no [procedure] required", async () => {
    await withMem("eden-m35-chat-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      await sleep({ dir, mem });
      const pkt = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Clerk/);
      expect(pkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
      expect(pkt).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      expect(existsSync(join(dir, EXPERIENCE_DIRNAME))).toBe(false);
    });
  });

  test("inject stays fail-open when tombstone scrub throws", async () => {
    await withMem("eden-m35-fail-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk." }]);
      await sleep({ dir, mem });
      const boom = spyOn(SemanticStore.prototype, "deadValues").mockImplementation(() => {
        throw new Error("m35 deadValues boom");
      });
      try {
        const list = [{ role: "user", content: "what is auth" }];
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        expect(packetOf(out as unknown[])).toMatch(/Clerk/);
      } finally {
        boom.mockRestore();
      }
    });
  });
});

describe("M35.3 identifiers never stored", () => {
  test("session_id, email, and cwd are absent after observe + sleep", async () => {
    await withMem(
      "eden-m35-ids-",
      async (mem, dir) => {
        mem.observe([
          {
            role: "user",
            content: `The database is sqlite. Contact ${EMAIL}. cwd ${CWD}. session ${SESSION}.`,
          },
        ]);
        putExperience(dir, {
          id: "traj-m35-ids",
          session: SESSION,
          cwd: CWD,
          states: [
            {
              thought: `goal for ${EMAIL} session ${SESSION} cwd ${CWD} the database is sqlite`,
              t: 4,
            },
          ],
        });
        await sleep({ dir, mem, session: SESSION });
        const blob = readNamed(dir);
        expect(blob).not.toContain(SESSION);
        expect(blob).not.toContain(EMAIL);
        expect(blob).not.toContain(CWD);
        expect(blob).toMatch(/sqlite/i);
        expect(experienceFiles(dir).length).toBeGreaterThan(0);
      },
      SESSION,
      CWD,
    );
  });
});

describe("M35.3 wrap + hook leftover identity", () => {
  test("OpenAI injectBody, withKnowFacts, and injectBodyThenObserveTools omit postgres", async () => {
    await withMem("eden-m35-oa-", async (mem, dir) => {
      await seedSwitch(mem, dir);
      const list = [{ role: "user", content: CUE }];
      expectLiveSqlite(packetOf(mem.injectBody({ model: "gpt-4o", messages: list }).messages as unknown[]));
      const traced = injectBodyThenObserveTools(mem, { model: "gpt-4o", messages: [{ role: "user", content: CUE }] });
      expectLiveSqlite(packetOf((traced.messages ?? []) as unknown[]));
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const wrapped = withKnowFacts({ model: "gpt-4o", messages: [{ role: "user", content: CUE }] });
        expectLiveSqlite(packetOf((wrapped.messages ?? []) as unknown[]));
        expect(JSON.stringify(wrapped)).not.toMatch(/\bmemory_search\b/);
      } finally {
        procSpy.mockRestore();
      }
    });
  });

  test("Anthropic withKnowFactsAnthropic omits postgres", async () => {
    await withMem("eden-m35-anth-", async (mem, dir) => {
      await seedSwitch(mem, dir);
      const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
      try {
        const anth = withKnowFactsAnthropic({
          system: "You are a coding agent.",
          messages: [{ role: "user", content: CUE }],
        });
        const hay = JSON.stringify(anth);
        expect(hay).toMatch(/sqlite/i);
        expect(hay).not.toMatch(/postgres/i);
        expect(hay).not.toMatch(/\bmemory_search\b/);
      } finally {
        procSpy.mockRestore();
      }
    });
  });

  test("hook UserPromptSubmit after Stop omits postgres", async () => {
    await withMem(
      "eden-m35-hook-",
      async (mem, dir) => {
        await seedSwitch(mem, dir);
        expect(memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION })).toBeNull();
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
        expect(`${hookContext(start)}\n${JSON.stringify(start ?? {})}`).not.toMatch(/postgres/i);
        const submit = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: SESSION,
          prompt: CUE,
        });
        const ctx = hookContext(submit);
        expectLiveSqlite(ctx);
        expect(JSON.stringify(submit ?? {})).not.toMatch(/\bmemory_search\b/);
        for (const p of experienceFiles(dir)) expect(existsSync(p)).toBe(true);
      },
      SESSION,
    );
  });

  test("SessionStart does not brief an Always-use-postgres pin after sqlite sleep", async () => {
    await withMem(
      "eden-m35-pin-",
      async (mem, dir) => {
        mem.observe([{ role: "user", content: "Always use postgres." }]);
        mem.observe([{ role: "user", content: "The database is postgres." }]);
        mem.observe([{ role: "user", content: "Use sqlite instead of postgres." }]);
        mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
        await sleep({ dir, mem, session: SESSION });
        const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
        expect(pkt).toMatch(/sqlite/i);
        expect(pkt).not.toMatch(/always use postgres/i);
        expect(pkt).not.toMatch(/database is postgres/i);
        expect(gistText(dir)).toMatch(/sqlite/i);
        expect(gistText(dir)).not.toMatch(/postgres/i);
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
        const ctx = hookContext(start);
        expect(ctx).toMatch(/sqlite/i);
        expect(ctx).not.toMatch(/postgres/i);
        expect(ctx).not.toMatch(/always use postgres/i);
      },
      SESSION,
    );
  });
});

describe("M35.3 scrub does not destroy gold that merely contains postgres", () => {
  test("live cache, miller prose, and an ICL shot survive; tombstone sentence does not", async () => {
    await withMem("eden-m35-gold-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      mem.observe([{ role: "user", content: "The cache is postgres." }]);
      mem.observe([{ role: "user", content: "Always use postgres." }]);
      mem.observe([{ role: "user", content: "Use sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      expect(String(new SemanticStore(dir).get("cache", "is")?.o ?? "")).toMatch(/postgres/i);
      expect(String(new SemanticStore(dir).get("stack", "uses")?.o ?? "")).toMatch(/sqlite/i);
      const prose = "The database is sqlite. Miller mentioned postgres in the novel.";
      const cleaned = scrubTombstonedIdentity(prose, dir);
      expect(cleaned).toBe("The database is sqlite. Miller mentioned postgres in the novel.");
      expect(cleaned).not.toMatch(/\.\./);
      expect(scrubTombstonedIdentity("The database is postgres.", dir)).not.toMatch(/postgres/i);
      expect(scrubTombstonedIdentity("The cache is postgres.", dir)).toMatch(/cache is postgres/i);
      expect(scrubTombstonedIdentity("Always use postgres.", dir)).not.toMatch(/postgres/i);
      const icl = "label: positive Input: the film mentions postgres Output: negative";
      expect(scrubTombstonedIdentity(icl, dir)).toMatch(/postgres/);
      expect(scrubTombstonedIdentity(icl, dir)).toMatch(/negative/);
      const pkt = packetOf(mem.inject([{ role: "user", content: "what cache do we use" }]));
      expect(pkt).toMatch(/cache is postgres/i);
      expect(pkt).not.toMatch(/database is postgres/i);
      expect(pkt).not.toMatch(/always use postgres/i);
      expect(
        mem
          .memories()
          .map((r) => r.text)
          .join("\n"),
      ).not.toMatch(/always use postgres/i);
      expect(gistText(dir)).toMatch(/cache is postgres/i);
      expect(gistText(dir)).not.toMatch(/always use postgres/i);
    });
  });

  test("SessionStart keeps a sqlite gist that mentions postgres as prose", async () => {
    await withMem(
      "eden-m35-gist-prose-",
      async (mem, dir) => {
        mem.observe([{ role: "user", content: "The database is postgres." }]);
        mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
        await sleep({ dir, mem, session: SESSION });
        const gold = "The database is sqlite. Miller mentioned postgres in the novel.";
        new GistStore(dir).put(gold, SESSION, Date.now());
        expect(gistText(dir)).toMatch(/Miller mentioned postgres/);
        expect(gistText(dir)).toMatch(/sqlite/i);
        await withEnv({ EDEN_MEMORY: "readonly" }, async () => {
          const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION });
          const ctx = hookContext(start);
          expect(ctx).toMatch(/sqlite/i);
          expect(ctx).toMatch(/Miller mentioned postgres/);
          expect(ctx).not.toMatch(/database is postgres/i);
        });
      },
      SESSION,
    );
  });

  test("scrub fail-open returns the original text when deadValues throws", async () => {
    await withMem("eden-m35-scrub-fo-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is sqlite." }]);
      await sleep({ dir, mem });
      const prose = "The database is sqlite. Miller mentioned postgres in the novel.";
      const boom = spyOn(SemanticStore.prototype, "deadValues").mockImplementation(() => {
        throw new Error("m35 deadValues boom");
      });
      try {
        let out = "";
        expect(() => {
          out = scrubTombstonedIdentity(prose, dir);
        }).not.toThrow();
        expect(out).toBe(prose);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("torn semantic.jsonl tail does not resurrect postgres", async () => {
    await withMem("eden-m35-torn-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "The database is postgres." }]);
      mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);
      await sleep({ dir, mem });
      appendFileSync(join(dir, "semantic.jsonl"), '{"torn\n');
      const live = new SemanticStore(dir).get("database", "is");
      expect(String(live?.o ?? "")).toMatch(/sqlite/i);
      expect(String(live?.o ?? "")).not.toMatch(/postgres/i);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
    });
  });
});
