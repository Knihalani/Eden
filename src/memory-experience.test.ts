/**
 * M23.4 ExperienceStore tests + M23.1–M23.3 wave-close contracts.
 * D owns product; this file only asserts the locked API.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools, observeToolTraces } from "../packages/wrap/src/tool-observe";
import {
  EXPERIENCE_BYTES_ENV,
  EXPERIENCE_DIRNAME,
  ExperienceStore,
  putExperience,
  putExperienceFromTool,
  readExperience,
} from "./experience-store";
import { AgentMemory, MEMORY_MARK, openMemory } from "./index";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/48

const SESSION = "sess-m23-very-long-session-id";
const EMAIL = "kai@example.com";
const FAKE_CWD = "/tmp/eden-m23-unique-cwd";
const AX_HOOK = `RootWebArea [landmark] heading Change-request UNIQUE_AX_MARKER_M23 button Submit contact ${EMAIL} session ${SESSION} cwd ${FAKE_CWD}`;
const AX_WRAP = "RootWebArea [landmark] heading Change-request UNIQUE_AX_WRAP_M23";
const AX_ANTH = "RootWebArea [landmark] heading Change-request UNIQUE_AX_ANTH_M23";
const AX_TOOL = "RootWebArea UNIQUE_AX_FROM_TOOL_M23";
const SQLITE_CHAT = "What's 2+2? Use sqlite in this project.";
const HOST_FILES = [
  join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
  join(import.meta.dir, "../packages/wrap/src/tool-observe.ts"),
  join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
  join(import.meta.dir, "../packages/cli/src/setup.ts"),
  join(import.meta.dir, "../packages/cli/src/doctor.ts"),
];

function tmpDir(prefix = "eden-m234-"): string {
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

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function fileHay(paths: string[]): string {
  const chunks: string[] = [];
  for (const p of paths) {
    try {
      chunks.push(readFileSync(p, "utf8"));
    } catch {}
  }
  return chunks.join("\n");
}

function experienceDir(root: string): string {
  return join(root, EXPERIENCE_DIRNAME);
}

function experienceFiles(root: string): string[] {
  return walkFiles(experienceDir(root)).filter((p) => !p.endsWith(".lock"));
}

function experienceHay(root: string): string {
  return fileHay(experienceFiles(root));
}

function memoriesHay(root: string): string {
  return fileHay(walkFiles(root).filter((p) => p.endsWith("memories.jsonl")));
}

function storeHayExceptExperience(root: string): string {
  return fileHay(walkFiles(root).filter((p) => {
    if (p.endsWith(".lock")) return false;
    const norm = p.replaceAll("\\", "/");
    if (norm.includes(`/${EXPERIENCE_DIRNAME}/`) || norm.endsWith(`/${EXPERIENCE_DIRNAME}`)) return false;
    return true;
  }));
}

function longAx(marker: string): string {
  let live = "";
  try {
    live = process.cwd();
  } catch {}
  return `RootWebArea [landmark] heading Change-request ${marker} button Submit contact ${EMAIL} session ${SESSION} cwd ${FAKE_CWD} live ${live} ` + "n".repeat(420);
}

function experienceEmpty(root: string): boolean {
  const d = experienceDir(root);
  if (!existsSync(d)) return true;
  return experienceFiles(root).length === 0;
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function openaiAxWindow(marker: string): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_ax_m23",
          type: "function",
          function: {
            name: "browser_snapshot",
            arguments: JSON.stringify({ url: "https://example.test/change-request" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_ax_m23",
      content: JSON.stringify({
        url: "https://example.test/change-request",
        accessibility_tree: marker,
      }),
    },
  ];
}

function anthropicAxWindow(marker: string): unknown[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu_ax_m23",
          name: "browser_snapshot",
          input: { url: "https://example.test/change-request" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_ax_m23",
          content: JSON.stringify({
            url: "https://example.test/change-request",
            accessibility_tree: marker,
          }),
        },
      ],
    },
  ];
}

function hookAxPayload(): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: SESSION,
    cwd: FAKE_CWD,
    tool_name: "browser_snapshot",
    tool_input: { url: "https://example.test/change-request" },
    tool_response: {
      url: "https://example.test/change-request",
      accessibility_tree: AX_HOOK,
    },
  };
}

function assertAxOnDiskNotJsonl(dir: string, marker: string): void {
  expect(experienceHay(dir)).toContain(marker);
  expect(memoriesHay(dir)).not.toContain(marker);
  expect(storeHayExceptExperience(dir)).not.toContain(marker);
}

function assertIdentifiersScrubbed(dir: string): void {
  const hay = experienceHay(dir);
  expect(hay).not.toContain(EMAIL);
  expect(hay).not.toContain(SESSION);
  expect(hay).not.toContain(FAKE_CWD);
  let cwd = "";
  try {
    cwd = process.cwd();
  } catch {}
  if (cwd) expect(hay).not.toContain(cwd);
}

function putHundred(store: ExperienceStore): void {
  for (let i = 0; i < 100; i++) {
    store.put({
      id: `traj-${i}`,
      states: [{ url: `https://t.test/${i}`, action: "click", thought: "go", tree: "RootWebArea x" }],
    });
  }
}

describe("M23.1 ExperienceStore put / ids / get", () => {
  test("100 traj ids written via ExperienceStore.put", () => {
    const dir = tmpDir("eden-m231-100-");
    try {
      const s = new ExperienceStore(dir);
      putHundred(s);
      expect(s.ids().length).toBe(100);
      expect(s.get("traj-42")?.states[0]?.url).toContain("42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("putExperience / readExperience round-trip", () => {
    const dir = tmpDir("eden-m231-round-");
    try {
      putExperience(dir, {
        id: "traj-round",
        states: [{ url: "https://t.test/round", action: "click", thought: "go", tree: "RootWebArea round" }],
      });
      const got = readExperience(dir, "traj-round");
      expect(got?.id).toBe("traj-round");
      expect(got?.states[0]?.url).toContain("t.test/round");
      expect(got?.states[0]?.tree).toContain("RootWebArea");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("putExperienceFromTool writes AX tree onto root experience files", () => {
    const dir = tmpDir("eden-m231-from-tool-");
    try {
      putExperienceFromTool(dir, {
        id: "call_from_tool",
        name: "browser_snapshot",
        args: { url: "https://example.test/from-tool" },
        result: {
          url: "https://example.test/from-tool",
          accessibility_tree: AX_TOOL,
        },
      });
      expect(experienceHay(dir)).toContain("UNIQUE_AX_FROM_TOOL_M23");
      const ids = new ExperienceStore(dir).ids();
      expect(ids.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat observe does not require ExperienceStore: no experience/ files", async () => {
    await withMem("eden-m231-chat-", (mem, dir) => {
      expect(() => {
        mem.observe([{ role: "user", content: SQLITE_CHAT }]);
      }).not.toThrow();
      expect(experienceEmpty(dir)).toBe(true);
      expect(new ExperienceStore(dir).ids()).toEqual([]);
      const jsonl = memoriesHay(dir);
      if (jsonl) expect(jsonl.toLowerCase()).toMatch(/sqlite/);
    });
  });
});

describe("M23.1 EDEN_EXPERIENCE_BYTES is not the JSONL cap", () => {
  test("EXPERIENCE_BYTES_ENV is EDEN_EXPERIENCE_BYTES, distinct from EDEN_MEMORY_STORE_CAP", () => {
    expect(EXPERIENCE_BYTES_ENV).toBe("EDEN_EXPERIENCE_BYTES");
    expect(EXPERIENCE_BYTES_ENV).not.toBe("EDEN_MEMORY_STORE_CAP");
    expect(EXPERIENCE_DIRNAME).toBe("experience");
    const src = readFileSync(join(import.meta.dir, "experience-store.ts"), "utf8");
    expect(src).toContain("EDEN_EXPERIENCE_BYTES");
    expect(src).not.toMatch(/process\.env\.EDEN_MEMORY_STORE_CAP/);
  });

  test("tiny JSONL cap does not evict 100 trajs; tiny experience byte cap does", async () => {
    const keep = tmpDir("eden-m231-jsonl-cap-");
    const evict = tmpDir("eden-m231-exp-cap-");
    try {
      await withEnv({ EDEN_MEMORY_STORE_CAP: "1", [EXPERIENCE_BYTES_ENV]: "1000000" }, () => {
        const s = new ExperienceStore(keep);
        putHundred(s);
        expect(s.ids().length).toBe(100);
        expect(s.get("traj-0")?.states[0]?.url).toContain("0");
        expect(s.get("traj-99")?.states[0]?.url).toContain("99");
      });
      await withEnv({ [EXPERIENCE_BYTES_ENV]: "2048", EDEN_MEMORY_STORE_CAP: "2000" }, () => {
        const s = new ExperienceStore(evict);
        putHundred(s);
        const ids = s.ids();
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThan(100);
        expect(s.get("traj-0")).toBeNull();
        expect(s.get("traj-99")?.states[0]?.url).toContain("99");
      });
    } finally {
      rmSync(keep, { recursive: true, force: true });
      rmSync(evict, { recursive: true, force: true });
    }
  });
});

describe("M23.2 wrap + hook write AX to files, not extractDurable JSONL", () => {
  test.failing("hook PostToolUse: AX on root experience jsonl, absent from memories.jsonl, identifiers scrubbed", async () => {
    await withMem("eden-m232-hook-", (_mem, dir) => {
      expect(() => {
        memoryHookResponse(hookAxPayload());
      }).not.toThrow();
      expect(experienceHay(dir)).toContain("UNIQUE_AX_MARKER_M23");
      assertIdentifiersScrubbed(dir);
      expect(memoriesHay(dir)).not.toContain("UNIQUE_AX_MARKER_M23");
      expect(existsSync(experienceDir(dir))).toBe(true);
    }, SESSION);
  });

  test("wrap observeToolTraces OpenAI tool window: AX on disk, absent from memories.jsonl", async () => {
    await withMem("eden-m232-wrap-", (mem, dir) => {
      observeToolTraces(mem, openaiAxWindow(AX_WRAP));
      assertAxOnDiskNotJsonl(dir, "UNIQUE_AX_WRAP_M23");
    });
  });

  test("wrap injectBodyThenObserveTools OpenAI-shaped tool window writes experience files", async () => {
    await withMem("eden-m232-inject-body-", (mem, dir) => {
      const body = { messages: openaiAxWindow(AX_WRAP) };
      const out = injectBodyThenObserveTools(mem, body);
      expect(out).toBeTruthy();
      assertAxOnDiskNotJsonl(dir, "UNIQUE_AX_WRAP_M23");
    });
  });

  test("wrap Anthropic tool_result: AX on disk, absent from memories.jsonl", async () => {
    await withMem("eden-m232-anth-", (mem, dir) => {
      observeToolTraces(mem, anthropicAxWindow(AX_ANTH));
      assertAxOnDiskNotJsonl(dir, "UNIQUE_AX_ANTH_M23");
    });
  });

  test("long AX via injectBody is on experience files, not memories.jsonl / traces.jsonl", async () => {
    await withMem("eden-m232-long-ax-", (mem, dir) => {
      const marker = "UNIQUE_AX_WRAP_M23";
      const tree = longAx(marker);
      expect(tree.length).toBeGreaterThan(400);
      injectBodyThenObserveTools(mem, { messages: openaiAxWindow(tree) });
      assertAxOnDiskNotJsonl(dir, marker);
      assertIdentifiersScrubbed(dir);
    }, SESSION, FAKE_CWD);
  });

  test("Anthropic inject observe of tool_result does not store-all AX into chat JSONL", async () => {
    await withMem("eden-m232-anth-inject-", (mem, dir) => {
      const tree = longAx("UNIQUE_AX_ANTH_M23");
      expect(() => {
        mem.inject(anthropicAxWindow(tree) as unknown[]);
      }).not.toThrow();
      expect(memoriesHay(dir)).not.toContain("UNIQUE_AX_ANTH_M23");
      observeToolTraces(mem, anthropicAxWindow(tree));
      assertAxOnDiskNotJsonl(dir, "UNIQUE_AX_ANTH_M23");
      assertIdentifiersScrubbed(dir);
    }, SESSION, FAKE_CWD);
  });

  test("withKnowFactsAnthropic calls observeToolTraces on the tool_result path", () => {
    const src = readFileSync(join(import.meta.dir, "../packages/wrap/src/know-inject.ts"), "utf8");
    expect(src).not.toMatch(/\bextractDurable\b/);
    const calls = src.match(/observeToolTraces\(\s*mem\s*,\s*body\.messages\s*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("M23.3 fail-open ENOENT + inject pass-through", () => {
  test("missing dir / ENOENT on get/ids does not throw", () => {
    const dir = tmpDir("eden-m233-enoent-");
    try {
      const missing = join(dir, "nope-missing");
      expect(() => new ExperienceStore(missing).ids()).not.toThrow();
      expect(new ExperienceStore(join(dir, "nope-missing")).get("z")).toBeNull();
      expect(readExperience(missing, "z")).toBeNull();
      expect(existsSync(join(missing, EXPERIENCE_DIRNAME))).toBe(false);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inject with no experience/ dir does not throw; sqlite chat still injects", async () => {
    await withMem("eden-m233-inject-", (mem, dir) => {
      mem.observe([{ role: "user", content: "Use sqlite in this project." }]);
      expect(experienceEmpty(dir)).toBe(true);
      const list = [{ role: "user", content: SQLITE_CHAT }];
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(Array.isArray(out)).toBe(true);
      expect(packetOf(out as unknown[])).toMatch(/sqlite/i);
    });
  });

  test("inject throw still pass-through if experience get/ids throw", async () => {
    await withMem("eden-m233-spy-", (mem) => {
      const getBoom = spyOn(ExperienceStore.prototype, "get").mockImplementation(() => {
        throw new Error("m23 experience get");
      });
      const idsBoom = spyOn(ExperienceStore.prototype, "ids").mockImplementation(() => {
        throw new Error("m23 experience ids");
      });
      try {
        const list = [{ role: "user", content: SQLITE_CHAT }];
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(out).toBe(list);
      } finally {
        getBoom.mockRestore();
        idsBoom.mockRestore();
      }
    });
  });

  test("wrap OpenAI tool window, hook PostToolUse, Anthropic tool_result do not throw on missing experience", async () => {
    const dir = tmpDir("eden-m233-hosts-");
    try {
      await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_MEMORY: "on" }, () => {
        const mem = openMemory({ dir });
        rmSync(dir, { recursive: true, force: true });
        const openai = { messages: openaiAxWindow(AX_WRAP) };
        let wrapOut: unknown;
        expect(() => {
          wrapOut = injectBodyThenObserveTools(mem, openai);
        }).not.toThrow();
        expect(wrapOut).toBeTruthy();

        expect(() => {
          observeToolTraces(mem, anthropicAxWindow(AX_ANTH));
        }).not.toThrow();

        const anthBody = { system: "be brief", messages: anthropicAxWindow(AX_ANTH) };
        let anthOut: unknown;
        expect(() => {
          anthOut = withKnowFactsAnthropic(anthBody);
        }).not.toThrow();
        expect(anthOut).toBeTruthy();

        expect(() => {
          memoryHookResponse(hookAxPayload());
        }).not.toThrow();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M23.4 chat-only zero files; hosts write; consent off; no memory_search", () => {
  test("chat-only observe writes zero traj files", async () => {
    await withMem("eden-m234-chat-only-", (mem, dir) => {
      mem.observe([{ role: "user", content: SQLITE_CHAT }]);
      expect(experienceEmpty(dir)).toBe(true);
      expect(new ExperienceStore(dir).ids()).toEqual([]);
    });
  });

  test.failing("coding/web host wrap+hook write experience files", async () => {
    await withMem("eden-m234-hosts-", (mem, dir) => {
      observeToolTraces(mem, openaiAxWindow(AX_WRAP));
      expect(experienceFiles(dir).length).toBeGreaterThan(0);
      expect(experienceHay(dir)).toContain("UNIQUE_AX_WRAP_M23");
    });
    await withMem("eden-m234-hook-write-", (_mem, dir) => {
      memoryHookResponse(hookAxPayload());
      expect(experienceFiles(dir).length).toBeGreaterThan(0);
      expect(experienceHay(dir)).toContain("UNIQUE_AX_MARKER_M23");
    });
  });

  test("EDEN_MEMORY=0 wrap/hook tool payload writes zero experience files", async () => {
    const dir = tmpDir("eden-m234-off-");
    try {
      await withEnv({ EDEN_MEMORY: "0", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const mem = openMemory({ dir });
        observeToolTraces(mem, openaiAxWindow(AX_WRAP));
        injectBodyThenObserveTools(mem, { messages: openaiAxWindow(AX_WRAP) });
        observeToolTraces(mem, anthropicAxWindow(AX_ANTH));
        memoryHookResponse(hookAxPayload());
        mem.observe([{ role: "user", content: SQLITE_CHAT }]);
        expect(experienceEmpty(dir)).toBe(true);
        expect(new ExperienceStore(dir).ids()).toEqual([]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrap/hook/setup/doctor have no memory_search", () => {
    for (const p of HOST_FILES) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bmemory_search\b/);
      expect(src, p).not.toMatch(/\bBrainMemory\b/);
    }
  });

  test("EDEN_MEMORY=readonly wrap/hook write zero experience files", async () => {
    const dir = tmpDir("eden-m234-ro-");
    try {
      await withEnv({ EDEN_MEMORY: "readonly", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, () => {
        const mem = openMemory({ dir, session: SESSION, cwd: FAKE_CWD });
        observeToolTraces(mem, openaiAxWindow(longAx(AX_WRAP)));
        injectBodyThenObserveTools(mem, { messages: openaiAxWindow(longAx(AX_WRAP)) });
        memoryHookResponse(hookAxPayload());
        putExperienceFromTool(dir, {
          name: "browser_snapshot",
          session: SESSION,
          cwd: FAKE_CWD,
          result: { accessibility_tree: longAx(AX_TOOL) },
        });
        expect(experienceEmpty(dir)).toBe(true);
        expect(new ExperienceStore(dir).ids()).toEqual([]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("identifiers in wrap experience files are scrubbed", async () => {
    await withMem("eden-m234-ids-wrap-", (mem, dir) => {
      observeToolTraces(mem, openaiAxWindow(longAx(AX_WRAP)));
      expect(experienceHay(dir)).toContain("UNIQUE_AX_WRAP_M23");
      assertIdentifiersScrubbed(dir);
    }, SESSION, FAKE_CWD);
  });

  test("empty cue inject does not dump traj files into the packet", async () => {
    await withMem("eden-m234-empty-cue-", (mem, dir) => {
      putExperienceFromTool(dir, {
        id: "traj-gold",
        name: "browser_snapshot",
        result: { url: "https://example.test/change-request", accessibility_tree: longAx("UNIQUE_AX_FROM_TOOL_M23") },
      });
      expect(experienceHay(dir)).toContain("UNIQUE_AX_FROM_TOOL_M23");
      const out = mem.inject([{ role: "user", content: "" }]) as unknown[];
      expect(packetOf(out)).not.toContain("UNIQUE_AX_FROM_TOOL_M23");
      expect(packetOf(out)).not.toMatch(/RootWebArea/);
    });
  });

  test("concurrent appends do not tear a traj jsonl file", async () => {
    const dir = tmpDir("eden-m234-conc-");
    try {
      const s = new ExperienceStore(dir);
      await Promise.all(Array.from({ length: 32 }, (_, i) =>
        Promise.resolve().then(() => {
          s.append("shared", { url: `https://t.test/${i}`, action: `a${i}`, t: i });
        }),
      ));
      const files = experienceFiles(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const p of files) {
        const raw = readFileSync(p, "utf8");
        for (const line of raw.split("\n").filter(Boolean)) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
      expect(s.get("shared")?.states.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M25 locks — chat observe still independent; wrap/hook/setup/doctor have 0 memory_search", () => {
  test("wrap/hook/setup/doctor still have 0 memory_search", () => {
    for (const p of HOST_FILES) {
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(/\bmemory_search\b/);
      expect(src, p).not.toMatch(/\bBrainMemory\b/);
    }
  });

  test("chat observe still does not require ExperienceStore: no experience/ files", async () => {
    await withMem("eden-m25-chat-lock-", (mem, dir) => {
      expect(() => {
        mem.observe([{ role: "user", content: SQLITE_CHAT }]);
      }).not.toThrow();
      expect(experienceEmpty(dir)).toBe(true);
      expect(new ExperienceStore(dir).ids()).toEqual([]);
    });
  });
});
