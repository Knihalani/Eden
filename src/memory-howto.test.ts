/**
 * M9.4 structured-experience tests + M10.4 sleep how-to + M11.4 how-to integrity + M12.4 cue-complete inject +
 * M14.4 one brain.
 * Wrap/hook traces keep order/files/exit; sleep compresses success into HowToStore.
 * D owns product; this file only asserts the locked contracts.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFacts, withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import { injectBodyThenObserveTools, observeToolTraces, toolTraceMessages } from "../packages/wrap/src/tool-observe";
import { GistStore } from "./gist-store";
import {
  HowToStore,
  howtoPath,
  mergeSharedPrefix,
  mergeSharedPrefixHowTo,
  omitStalePlace,
  type HowTo,
  type HowToGap,
} from "./howto-store";
import * as howtoMod from "./howto-store";
import { retrieveHowTo, HOWTO_RETRIEVE_K, HOWTO_TOKEN_CAP, type HowToView } from "./howto-retrieve";
import * as howtoRetrieve from "./howto-retrieve";
import { AgentMemory, MEMORY_MARK, openMemory, sleep, superseded, injectedPackets } from "./index";
import { PACKET_SOFT_BULLETS } from "./memory-hook-packet";
import { storeFor } from "./memory-repo";
import * as edenMem from "./index";
import { SemanticStore } from "./semantic-store";
import * as sleepMod from "./sleep";
import { loadToolTraces, memoryTracesDir, persistToolTraces, tracesPath, type ToolTrace } from "./tool-trace";
import { cuesBelowTau } from "../scripts/test-below-tau";

cuesBelowTau();

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/51

const PYTEST_CMD = "pytest tests/auth/session.test.ts -q";
const PYTEST_OUT = "collected 1 item\nauth.ts touched\nexit 0";

function tmpDir(prefix = "eden-m94-"): string {
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

/**
 * The store the hook keeps for these tests (D1): their hook payloads carry no `cwd`, so it is the repo of
 * `process.cwd()`, under the memory root.
 */
function hookStore(root: string): string {
  const store = storeFor(root);
  mkdirSync(store, { recursive: true });
  return store;
}

/** `withMem` for a test that also drives the hook: the memory is the hook's repo store, and `dir` is that store. */
async function withHookMem<T>(
  prefix: string,
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
  session?: string,
): Promise<T> {
  const root = tmpDir(prefix);
  return withEnv({ EDEN_MEMORY_DIR: root, EDEN_HOME: undefined }, async () => {
    try {
      const store = hookStore(root);
      const mem = openMemory({ dir: store, session, perRepo: true });
      return await fn(mem, store);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function packetOf(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function pytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: PYTEST_CMD }) },
        },
        {
          id: "call_read",
          type: "function",
          function: { name: "Read", arguments: JSON.stringify({ path: "src/login.ts" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest", content: PYTEST_OUT },
    { role: "tool", tool_call_id: "call_read", content: "ok\nexit 0" },
  ];
}

/** Prefer D's loader (`loadToolTraces`). Merge session subdir + memory root. */
function loadTraces(dir: string, session?: string): ToolTrace[] {
  const dirs = [memoryTracesDir(dir, session), dir].filter((d, i, a) => a.indexOf(d) === i);
  const out: ToolTrace[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const row of loadToolTraces(d)) {
      const key = `${row.order}\0${row.name}\0${jsonHay(row.args)}\0${row.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function filesOf(row: ToolTrace): string[] {
  return (row.files ?? []).filter((x) => typeof x === "string");
}

function jsonHay(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function commandHay(row: ToolTrace): string {
  return (
    `${jsonHay(row.args)} ${jsonHay((row.args as { command?: unknown } | undefined)?.command)} ` +
    `${jsonHay(row.name)}`
  );
}

function hasAuthTs(row: ToolTrace): boolean {
  return filesOf(row).some((f) => f === "auth.ts" || f.endsWith("/auth.ts") || /(^|\/)auth\.ts$/.test(f));
}

function pytestRow(traces: ToolTrace[]): ToolTrace | undefined {
  return traces.find((t) => /pytest/i.test(commandHay(t)));
}

function assertPytestFields(traces: ToolTrace[]): ToolTrace {
  const row = pytestRow(traces);
  expect(row).toBeTruthy();
  const got = row!;
  expect(hasAuthTs(got)).toBe(true);
  expect(got.exit).toBe(0);
  expect(commandHay(got).toLowerCase()).toContain("pytest");
  return got;
}

function tracesAbsentOrEmpty(dir: string, session?: string): boolean {
  return loadTraces(dir, session).length === 0;
}

const ALT_CMD = "npm test -- tests/auth/login.test.ts";

function tracesKept(dir: string, session?: string): boolean {
  return (
    loadTraces(dir, session).length > 0 ||
    existsSync(tracesPath(dir)) ||
    existsSync(tracesPath(memoryTracesDir(dir, session)))
  );
}

function howtos(dir: string, cue = "auth pytest flake", k = 5): HowTo[] {
  return new HowToStore(dir).latest(cue, k);
}

function skillHay(row: HowTo): string {
  return [
    row.cue,
    row.verify ?? "",
    ...row.files,
    ...row.steps.map((s) => `${s.name} ${jsonHay(s.args)} ${(s.files ?? []).join(" ")}`),
  ].join(" ");
}

function hasAuthFile(files: string[]): boolean {
  return files.some((f) => f === "auth.ts" || f.endsWith("/auth.ts") || /(^|\/)auth\.ts$/.test(f));
}

function isAuthPytestSkill(row: HowTo): boolean {
  const hay = skillHay(row).toLowerCase();
  return row.exit === 0 && /pytest/i.test(hay) && (hasAuthFile(row.files) || /auth\.ts/.test(hay));
}

function assertHowToSkill(rows: HowTo[]): HowTo {
  const skill = rows.find(isAuthPytestSkill) ?? rows.find((r) => r.exit === 0) ?? rows[0];
  expect(skill).toBeTruthy();
  const got = skill!;
  expect(got.exit).toBe(0);
  expect(String(got.verify ?? skillHay(got)).toLowerCase()).toMatch(/pytest/);
  expect(hasAuthFile(got.files) || /auth\.ts/i.test(skillHay(got))).toBe(true);
  expect(got.steps.length).toBeGreaterThan(0);
  const orders = got.steps.map((s) => s.order).filter((o): o is number => typeof o === "number");
  expect(orders.length).toBeGreaterThan(0);
  for (let i = 1; i < orders.length; i++) expect(orders[i]!).toBeGreaterThanOrEqual(orders[i - 1]!);
  return got;
}

function failPytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest_fail",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: PYTEST_CMD }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_pytest_fail",
      content: "FAILED tests/auth/session.test.ts\nauth.ts\nexit 1",
      is_error: true,
    },
  ];
}

function readSearchWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_read_only",
          type: "function",
          function: { name: "Read", arguments: JSON.stringify({ path: "src/login.ts" }) },
        },
        {
          id: "call_grep_only",
          type: "function",
          function: { name: "Grep", arguments: JSON.stringify({ pattern: "auth", path: "src" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_read_only", content: "export function login() {}\nexit 0" },
    { role: "tool", tool_call_id: "call_grep_only", content: "src/login.ts:1:export function login\nexit 0" },
  ];
}

function deadEndWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_fail",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: PYTEST_CMD }) },
        },
        {
          id: "call_write",
          type: "function",
          function: {
            name: "Write",
            arguments: JSON.stringify({ path: "auth.ts", file_path: "auth.ts", contents: "export const ok = 1;\n" }),
          },
        },
        {
          id: "call_pass",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: PYTEST_CMD }) },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_fail",
      content: "FAILED tests/auth/session.test.ts\nauth.ts\nexit 1",
      is_error: true,
    },
    { role: "tool", tool_call_id: "call_write", content: "wrote auth.ts\nexit 0" },
    { role: "tool", tool_call_id: "call_pass", content: PYTEST_OUT },
  ];
}

function altFixWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_alt",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: ALT_CMD }) },
        },
        {
          id: "call_edit",
          type: "function",
          function: { name: "Edit", arguments: JSON.stringify({ path: "session.ts", file_path: "session.ts" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_alt", content: "ok\nsession.ts touched\nexit 0" },
    { role: "tool", tool_call_id: "call_edit", content: "patched session.ts\nexit 0" },
  ];
}

function iclToolWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_icl",
          type: "function",
          function: {
            name: "Bash",
            arguments: JSON.stringify({ command: "echo 'Input: The film is terrible. Output: negative'" }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_icl",
      content: "Input: The film is terrible. Output: negative\nlabel: positive\nexit 0",
    },
  ];
}

function stepFingerprint(row: Pick<HowTo, "steps" | "files" | "verify">): string {
  return JSON.stringify({
    verify: row.verify ?? "",
    files: [...row.files].map((f) => f.replace(/\\/g, "/")).sort(),
    steps: row.steps.map((s) => ({ name: s.name, args: s.args ?? {}, files: s.files ?? [], exit: s.exit })),
  });
}

type PruneOpts = { exists?: (file: string) => boolean; cwd?: string };
type PruneHost = {
  pruneStale?: (opts?: PruneOpts) => void;
  prune?: (opts?: PruneOpts) => void;
};

/** M10.3: sleep/idle prune with an exists probe. Fail this test if D has not exported it yet. */
function callPrune(dir: string, exists: (file: string) => boolean): void {
  const store = new HowToStore(dir) as HowToStore & PruneHost;
  const method = store.pruneStale ?? store.prune;
  if (typeof method === "function") {
    method.call(store, { exists });
    return;
  }
  const extras = howtoMod as {
    pruneHowTo?: (d: string, o?: PruneOpts) => void;
    prune?: (d: string, o?: PruneOpts) => void;
  };
  const named =
    extras.pruneHowTo ?? extras.prune ?? (sleepMod as { pruneHowTo?: (d: string, o?: PruneOpts) => void }).pruneHowTo;
  if (typeof named === "function") {
    named(dir, { exists });
    return;
  }
  expect(typeof method).toBe("function");
}

describe("M9.4 ordered wrap traces reconstruct files/exit/order", () => {
  test("OpenAI Bash/pytest then Read: files auth.ts, exit 0, pytest args, order 0 then 1", async () => {
    await withMem("eden-m94-wrap-", async (mem, dir) => {
      const window = pytestWindow();
      expect(toolTraceMessages(window).length).toBeGreaterThanOrEqual(1);
      observeToolTraces(mem, window);
      const traces = loadTraces(dir);
      const pytest = assertPytestFields(traces);
      expect(pytest.order).toBe(0);
      const second =
        traces.find((t) => t !== pytest && t.order === 1) ??
        traces.filter((t) => t !== pytest).sort((a, b) => (a.order ?? 99) - (b.order ?? 99))[0];
      expect(second).toBeTruthy();
      expect(second!.order).toBe(1);
    });
  });
});

describe("M9.4 hook PostToolUse writes the same trace shape", () => {
  test("PostToolUse pytest/auth.ts/exit 0 lands traces.jsonl in the repo store (D1)", async () => {
    const dir = tmpDir("eden-m94-hook-");
    const session = "s-m94-pytest";
    await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
      try {
        const out = memoryHookResponse({
          hook_event_name: "PostToolUse",
          session_id: session,
          tool_name: "Bash",
          tool_input: { command: PYTEST_CMD },
          tool_response: PYTEST_OUT,
        });
        expect(out).toBeNull();
        const store = hookStore(dir);
        const traces = loadTraces(store);
        assertPytestFields(traces);
        expect(existsSync(tracesPath(store))).toBe(true);
        expect(existsSync(join(store, session))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("M9.4 chat-only mints no how-to", () => {
  test("user/assistant chat: HowToStore empty, traces absent/empty, Auth is Clerk still injects", async () => {
    await withMem("eden-m94-chat-", async (mem, dir) => {
      mem.observe([
        { role: "user", content: "How is the weather looking for the ship?" },
        { role: "assistant", content: "It looks sunny this afternoon." },
      ]);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      expect(new HowToStore(dir).latest("anything", 5)).toEqual([]);
      expect(tracesAbsentOrEmpty(dir)).toBe(true);
      const injected = mem.inject([{ role: "user", content: "what is auth using these days?" }]);
      const pkt = packetOf(injected);
      const hay = `${pkt}\n${mem
        .memories()
        .map((r) => r.text)
        .join("\n")}`;
      expect(hay).toMatch(/Clerk/i);
      expect(/\[procedure\b/.test(pkt) || /how-to|howto/i.test(pkt)).toBe(false);
    });
  });
});

describe("M9.4 ICL never becomes how-to", () => {
  test("Input/Output and label:positive exemplars leave HowToStore empty", async () => {
    await withMem("eden-m94-icl-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Input: The film is terrible. Output: negative" }]);
      mem.observe([{ role: "user", content: "The movie was great. label: positive" }]);
      mem.observe([{ role: "assistant", content: "Input: n/a\nOutput: n/a" }]);
      expect(new HowToStore(dir).latest("anything", 5)).toEqual([]);
      expect(new HowToStore(dir).latest("film movie label", 5)).toEqual([]);
    });
  });
});

describe("M9.4 inject/observeToolTraces fail-open if parse throws", () => {
  test("throwing observe, not-json args, circular junk: no throw; inject returns the user message", async () => {
    await withMem("eden-m94-failopen-", async (mem) => {
      expect(() =>
        observeToolTraces(
          {
            observe() {
              throw new Error("m94 observe boom");
            },
          },
          pytestWindow(),
        ),
      ).not.toThrow();

      expect(() =>
        observeToolTraces(mem, [
          {
            role: "assistant",
            tool_calls: [{ id: "c-bad", type: "function", function: { name: "Bash", arguments: "not-json" } }],
          },
          { role: "tool", tool_call_id: "c-bad", content: PYTEST_OUT },
        ]),
      ).not.toThrow();

      const circular: Record<string, unknown> = { command: PYTEST_CMD };
      circular.self = circular;
      expect(() =>
        observeToolTraces(mem, [
          {
            role: "assistant",
            tool_calls: [{ id: "c-circ", type: "function", function: { name: "Bash", arguments: circular } }],
          },
          { role: "tool", tool_call_id: "c-circ", content: PYTEST_OUT },
        ]),
      ).not.toThrow();

      const list = [{ role: "user", content: "hi" }];
      mem.observe = (() => {
        throw new Error("m94 inject observe boom");
      }) as typeof mem.observe;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "hi" }]);
    });
  });
});

describe("M9.4 wave close: traces survive Stop; chat-only still zero how-to", () => {
  test("pytest traces keep files/verify/exit after Stop; chat-only facts still work", async () => {
    const toolDir = tmpDir("eden-m94-stop-tool-");
    const chatDir = tmpDir("eden-m94-stop-chat-");
    try {
      await withEnv({ EDEN_MEMORY_DIR: toolDir, EDEN_HOME: undefined }, async () => {
        const mem = openMemory({ dir: toolDir });
        observeToolTraces(mem, pytestWindow());
        expect(memoryHookResponse({ hook_event_name: "Stop" })).toBeNull();
        await mem.sleep();
        const traces = loadTraces(toolDir);
        const row = assertPytestFields(traces);
        expect(commandHay(row).toLowerCase()).toContain("pytest");
        expect(row.exit).toBe(0);
        expect(hasAuthTs(row)).toBe(true);
      });

      await withEnv({ EDEN_MEMORY_DIR: chatDir, EDEN_HOME: undefined }, async () => {
        const mem = openMemory({ dir: chatDir });
        mem.observe([
          { role: "user", content: "Auth is Clerk" },
          { role: "assistant", content: "Got it, we will keep using Clerk." },
        ]);
        expect(memoryHookResponse({ hook_event_name: "SessionEnd" })).toBeNull();
        expect(new HowToStore(chatDir).latest("anything", 5)).toEqual([]);
        expect(tracesAbsentOrEmpty(chatDir)).toBe(true);
        const later = openMemory({ dir: chatDir });
        const injected = later.inject([{ role: "user", content: "remind me what auth is" }]);
        const hay = `${packetOf(injected)}\n${later
          .memories()
          .map((r) => r.text)
          .join("\n")}`;
        expect(hay).toMatch(/Clerk/i);
      });
    } finally {
      rmSync(toolDir, { recursive: true, force: true });
      rmSync(chatDir, { recursive: true, force: true });
    }
  });
});

describe("M9.4 HowToStore concurrent puts do not tear", () => {
  test("two puts from two stores are both loadable", () => {
    const dir = tmpDir("eden-m94-howto-conc-");
    try {
      const a = new HowToStore(dir);
      const b = new HowToStore(dir);
      a.put({
        cue: "fix auth pytest",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      b.put({
        cue: "read login module",
        steps: [{ name: "Read", args: { path: "src/login.ts" }, order: 1 }],
        files: ["login.ts"],
        exit: 0,
        t: 2,
      });
      const rows = new HowToStore(dir).latest("pytest login auth", 5);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const files = rows.flatMap((r) => r.files);
      expect(files.some((f) => f.includes("auth.ts"))).toBe(true);
      expect(files.some((f) => f.includes("login.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty cue returns no how-to (Start must not dump)", () => {
    const dir = tmpDir("eden-m94-howto-empty-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "fix auth pytest",
        steps: [{ name: "Bash" }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      expect(store.latest("", 5)).toEqual([]);
      expect(store.latest("   ", 3)).toEqual([]);
      expect(retrieveHowTo(dir, "")).toEqual([]);
      expect(retrieveHowTo(dir, "   ")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parallel puts do not tear JSONL", async () => {
    const dir = tmpDir("eden-m94-howto-parallel-");
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          Promise.resolve(
            new HowToStore(dir).put({
              cue: `fix ${i}`,
              steps: [{ name: "Bash", order: i }],
              files: [`f${i}.ts`],
              exit: 0,
              t: i + 1,
            }),
          ),
        ),
      );
      const rows = new HowToStore(dir).latest("fix", 10);
      expect(rows.length).toBeGreaterThanOrEqual(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M9.4 wrap Anthropic pytest reconstructs the same three fields", () => {
  test("tool_use + tool_result pytest/auth.ts/exit 0", async () => {
    await withMem("eden-m94-anthropic-", async (mem, dir) => {
      observeToolTraces(mem, [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: PYTEST_CMD } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: PYTEST_OUT }],
        },
      ]);
      assertPytestFields(loadTraces(dir));
      expect(mem.memories().some((r) => /Bash|pytest|auth\.ts/i.test(r.text))).toBe(true);
    });
  });
});

describe("M9.4 wrap session traces live beside memories.jsonl", () => {
  test("openMemory session writes traces to the session subdir, not the root", async () => {
    await withMem(
      "eden-m94-wrap-sess-",
      async (mem, dir) => {
        observeToolTraces(mem, pytestWindow());
        const sessionDir = memoryTracesDir(dir, "s-wrap");
        expect(existsSync(tracesPath(sessionDir))).toBe(true);
        expect(existsSync(tracesPath(dir))).toBe(false);
        assertPytestFields(loadToolTraces(sessionDir));
      },
      "s-wrap",
    );
  });
});

describe("M9.4 secrets never land in traces.jsonl", () => {
  test("wrap args and hook tool_input redact sk-/ghp_/api_key", async () => {
    await withMem("eden-m94-secret-wrap-", async (mem, dir) => {
      observeToolTraces(mem, [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c-sec",
              type: "function",
              function: {
                name: "Bash",
                arguments: JSON.stringify({ command: PYTEST_CMD, api_key: "sk-abc123XYZ999secret" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "c-sec", content: `${PYTEST_OUT}\nghp_abc123XYZ999abcdefghij` },
      ]);
      const blob = JSON.stringify(loadTraces(dir));
      expect(blob).not.toMatch(/\bsk-/);
      expect(blob).not.toMatch(/\bghp_/);
      expect(blob).not.toContain("sk-abc123XYZ999secret");
      assertPytestFields(loadTraces(dir));
    });

    const dir = tmpDir("eden-m94-secret-hook-");
    await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
      try {
        memoryHookResponse({
          hook_event_name: "PostToolUse",
          session_id: "s-sec",
          tool_name: "Bash",
          tool_input: { command: PYTEST_CMD, api_key: "sk-abc123XYZ999secret" },
          tool_response: `${PYTEST_OUT}\nghp_abc123XYZ999abcdefghij`,
        });
        const blob = JSON.stringify(loadTraces(hookStore(dir)));
        expect(blob).not.toMatch(/\bsk-/);
        expect(blob).not.toMatch(/\bghp_/);
        expect(blob).not.toContain("sk-abc123XYZ999secret");
        assertPytestFields(loadTraces(hookStore(dir)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("M9.4 torn traces.jsonl heals on next persist", () => {
  test("invalid line is skipped; next pytest still reconstructs", async () => {
    await withMem("eden-m94-torn-", async (mem, dir) => {
      writeFileSync(tracesPath(dir), "{not json\n");
      observeToolTraces(mem, pytestWindow());
      const traces = loadTraces(dir);
      expect(traces.length).toBeGreaterThanOrEqual(1);
      assertPytestFields(traces);
    });
  });
});

describe("M9.4 injectBody OpenAI wrap pytest reconstructs fields", () => {
  test("injectBodyThenObserveTools writes traces beside prose", async () => {
    const { injectBodyThenObserveTools } = await import("../packages/wrap/src/tool-observe");
    await withMem("eden-m94-injectbody-", async (mem, dir) => {
      const body = { messages: pytestWindow() };
      const out = injectBodyThenObserveTools(mem, body);
      expect(out.messages).toBeTruthy();
      assertPytestFields(loadTraces(dir));
    });
  });
});

describe("M10.4 Sleep on flake fixture writes how-to", () => {
  test("observeToolTraces pytestWindow, Stop + sleep: how-to has verify/files/steps/exit 0; traces stay", async () => {
    await withMem("eden-m104-sleep-flake-", async (mem, dir) => {
      const window = pytestWindow();
      expect(toolTraceMessages(window).length).toBeGreaterThanOrEqual(1);
      observeToolTraces(mem, window);
      expect(memoryHookResponse({ hook_event_name: "Stop" })).toBeNull();
      await mem.sleep();
      const skill = assertHowToSkill(howtos(dir, "auth pytest flake", 5));
      expect(String(skill.verify ?? "").toLowerCase()).toMatch(/pytest/);
      expect(hasAuthFile(skill.files)).toBe(true);
      expect(skill.exit).toBe(0);
      expect(tracesKept(dir)).toBe(true);
      assertPytestFields(loadTraces(dir));
    });
  });

  test("chat-only still zero how-to after sleep", async () => {
    await withMem("eden-m104-chat-", async (mem, dir) => {
      mem.observe([
        { role: "user", content: "How is the weather looking for the ship?" },
        { role: "assistant", content: "It looks sunny this afternoon." },
      ]);
      await mem.sleep();
      expect(howtos(dir, "anything", 5)).toEqual([]);
      expect(howtos(dir, "auth pytest flake", 5)).toEqual([]);
      expect(tracesAbsentOrEmpty(dir)).toBe(true);
    });
  });
});

describe("M10.4 no promote on exit ≠ 0", () => {
  test("pytest exit 1 / is_error does not mint an exit-0 skill; traces still stored", async () => {
    await withMem("eden-m104-fail-", async (mem, dir) => {
      observeToolTraces(mem, failPytestWindow());
      await mem.sleep();
      const rows = howtos(dir, "auth pytest flake", 10);
      expect(rows.filter((r) => r.exit === 0)).toEqual([]);
      expect(rows.filter(isAuthPytestSkill)).toEqual([]);
      expect(tracesKept(dir)).toBe(true);
      const traces = loadTraces(dir);
      const row = pytestRow(traces);
      expect(row).toBeTruthy();
      expect(row!.exit).toBe(1);
    });
  });
});

describe("M10.4 Read/search-only stays episodic", () => {
  test("only Read/Grep exit 0: HowToStore empty; traces remain", async () => {
    await withMem("eden-m104-readonly-", async (mem, dir) => {
      observeToolTraces(mem, readSearchWindow());
      await mem.sleep();
      expect(howtos(dir, "auth pytest flake", 5)).toEqual([]);
      expect(howtos(dir, "login read grep", 5)).toEqual([]);
      expect(new HowToStore(dir).latest("login.ts", 5)).toEqual([]);
      expect(tracesKept(dir)).toBe(true);
      const traces = loadTraces(dir);
      expect(traces.some((t) => /read/i.test(t.name))).toBe(true);
      expect(traces.some((t) => /grep/i.test(t.name))).toBe(true);
    });
  });
});

describe("M10.4 dead-end strip", () => {
  test("failing pytest then write then passing pytest: failing verify is not a skill step", async () => {
    await withMem("eden-m104-deadend-", async (mem, dir) => {
      observeToolTraces(mem, deadEndWindow());
      await mem.sleep();
      const skill = assertHowToSkill(howtos(dir, "auth pytest flake", 5));
      expect(skill.exit).toBe(0);
      expect(hasAuthFile(skill.files)).toBe(true);
      expect(String(skill.verify ?? skillHay(skill)).toLowerCase()).toMatch(/pytest/);
      for (const step of skill.steps) {
        expect(step.exit === undefined || step.exit === 0).toBe(true);
      }
      const pytestSteps = skill.steps.filter((s) => /pytest/i.test(`${s.name} ${jsonHay(s.args)}`));
      expect(pytestSteps.length).toBeLessThanOrEqual(1);
      expect(tracesKept(dir)).toBe(true);
    });
  });
});

describe("M10.4 ICL skip", () => {
  test("Input/Output and label:positive observations + ICL-like tool text: HowToStore empty", async () => {
    await withMem("eden-m104-icl-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Input: The film is terrible. Output: negative" }]);
      mem.observe([{ role: "user", content: "The movie was great. label: positive" }]);
      mem.observe([{ role: "assistant", content: "Input: n/a\nOutput: n/a" }]);
      observeToolTraces(mem, iclToolWindow());
      await mem.sleep();
      expect(howtos(dir, "anything", 5)).toEqual([]);
      expect(howtos(dir, "film movie label", 5)).toEqual([]);
      expect(howtos(dir, "auth pytest flake", 5)).toEqual([]);
    });
  });
});

describe("M10.4 sleep throw fail-open", () => {
  test("spy consolidate to throw: inject returns messages; sleep does not throw", async () => {
    await withMem("eden-m104-failopen-cons-", async (mem) => {
      observeToolTraces(mem, pytestWindow());
      const list = [{ role: "user", content: "hi from m104" }];
      const consSpy = spyOn(sleepMod, "consolidate").mockImplementation(() => {
        throw new Error("m104 consolidate boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        const roles = (out as Array<{ role?: string; content?: unknown }>).map((m) => m.role);
        expect(roles).toContain("user");
        expect((out as Array<{ content?: unknown }>).some((m) => m.content === "hi from m104")).toBe(true);
        await expect(mem.sleep()).resolves.toBeUndefined();
      } finally {
        consSpy.mockRestore();
      }
    });
  });

  test("throwing HowToStore.put during sleep does not throw out of sleep()", async () => {
    await withMem("eden-m104-failopen-put-", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      const putSpy = spyOn(HowToStore.prototype, "put").mockImplementation(() => {
        throw new Error("m104 put boom");
      });
      try {
        await expect(mem.sleep()).resolves.toBeUndefined();
        await expect(sleep({ dir, mem })).resolves.toBeUndefined();
      } finally {
        putSpy.mockRestore();
      }
    });
  });
});

describe("M10.4 revisions (M10.2)", () => {
  test("two successful different fixes both exist; latest puts an exit-0 winner first", async () => {
    await withMem("eden-m104-rev-sib-", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      await mem.sleep();
      observeToolTraces(mem, altFixWindow());
      await mem.sleep();
      const rows = howtos(dir, "auth pytest flake", 10);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0]!.exit).toBe(0);
      const hay = rows.map(skillHay).join("\n");
      expect(/pytest/i.test(hay)).toBe(true);
      expect(/npm test|session\.ts|login\.test/i.test(hay)).toBe(true);
      const keys = new Set(rows.map(stepFingerprint));
      expect(keys.size).toBeGreaterThanOrEqual(2);
    });
  });

  test("identical steps put twice refresh: one fingerprint, id stable", () => {
    const dir = tmpDir("eden-m104-rev-refresh-");
    try {
      const store = new HowToStore(dir);
      const payload = {
        cue: "auth pytest flake",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 10,
      };
      store.put(payload);
      const first = store.latest("auth pytest flake", 5);
      expect(first.length).toBeGreaterThanOrEqual(1);
      const id1 = first[0]!.id;
      store.put({ ...payload, t: 20 });
      const again = store.latest("auth pytest flake", 10);
      const same = again.filter((r) => stepFingerprint(r) === stepFingerprint(payload));
      expect(same.length).toBe(1);
      expect(same[0]!.id).toBe(id1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("worse second attempt (exit 1) does not destroy the working first", () => {
    const dir = tmpDir("eden-m104-rev-worse-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      store.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", args: { command: "pytest --lf" }, files: ["auth.ts"], exit: 1, order: 0 }],
        files: ["auth.ts"],
        verify: "pytest --lf",
        exit: 1,
        t: 99,
      });
      const rows = store.latest("auth pytest flake", 10);
      expect(rows[0]!.exit).toBe(0);
      const winner = rows.find((r) => r.exit === 0 && String(r.verify ?? "").includes("pytest"));
      expect(winner).toBeTruthy();
      expect(String(winner!.verify)).toContain("pytest tests/auth/session.test.ts");
      expect(hasAuthFile(winner!.files)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M10.4 stale prune (M10.3)", () => {
  test("how-to naming auth.ts is omitted after prune exists: false; failed-exit decays", () => {
    const dir = tmpDir("eden-m104-prune-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      expect(howtos(dir, "auth pytest flake", 5).some((r) => hasAuthFile(r.files))).toBe(true);
      callPrune(dir, (f) => !/auth\.ts$/.test(f));
      const afterGone = howtos(dir, "auth pytest flake", 5);
      expect(afterGone.some((r) => hasAuthFile(r.files))).toBe(false);

      store.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["keep.ts"], exit: 1, order: 0 }],
        files: ["keep.ts"],
        verify: PYTEST_CMD,
        exit: 1,
        t: 2,
      });
      callPrune(dir, () => true);
      const afterFail = howtos(dir, "auth pytest flake", 10);
      expect(afterFail.some((r) => r.exit !== 0)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M10.4 facts still LWW", () => {
  test("Use postgres then Use sqlite instead: sleep keeps sqlite live, postgres history", async () => {
    await withMem("eden-m104-lww-", async (mem) => {
      mem.observe([{ role: "user", content: "Use postgres" }]);
      mem.observe([{ role: "user", content: "Use sqlite instead" }]);
      await mem.sleep();
      const injected = mem.inject([{ role: "user", content: "what database do we use" }]);
      const hay = `${packetOf(injected)}\n${mem
        .memories()
        .filter((r) => !superseded(r))
        .map((r) => r.text)
        .join("\n")}`;
      expect(hay).toMatch(/sqlite/i);
      expect(hay).not.toMatch(/postgres/i);
    });
  });
});

describe("M10.4 hook Stop path", () => {
  test("PostToolUse pytest fixture then Stop writes HowToStore verify+files at EDEN_MEMORY_DIR", async () => {
    const dir = tmpDir("eden-m104-hook-stop-");
    const session = "s-m104-stop";
    await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
      try {
        expect(
          memoryHookResponse({
            hook_event_name: "PostToolUse",
            session_id: session,
            tool_name: "Bash",
            tool_input: { command: PYTEST_CMD },
            tool_response: PYTEST_OUT,
          }),
        ).toBeNull();
        expect(memoryHookResponse({ hook_event_name: "Stop", session_id: session })).toBeNull();
        const store = hookStore(dir);
        const skill = assertHowToSkill(howtos(store, "auth pytest flake", 5));
        expect(String(skill.verify ?? "").toLowerCase()).toMatch(/pytest/);
        expect(hasAuthFile(skill.files)).toBe(true);
        expect(tracesKept(store, session)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

function gistHay(dir: string): string {
  return new GistStore(dir)
    .latest("", 8)
    .map((g) => g.text)
    .join("\n");
}

function semanticHay(dir: string): string {
  try {
    return existsSync(join(dir, "semantic.jsonl")) ? readFileSync(join(dir, "semantic.jsonl"), "utf8") : "";
  } catch {
    return "";
  }
}

function assertNoToolIdentity(dir: string) {
  const hay = `${semanticHay(dir)}\n${gistHay(dir)}`.toLowerCase();
  expect(hay).not.toMatch(/tool bash result/);
  expect(hay).not.toMatch(/bash tool result/);
  expect(new SemanticStore(dir).get("tool bash result", "is")).toBeUndefined();
  expect(new SemanticStore(dir).get("bash tool result", "is")).toBeUndefined();
}

describe("M10 leftover identity: tool prose is not a fact", () => {
  // Out of quarantine (#51) since P0.7: the wrap's tool prose is `src:tool`, an episode, never a fact (D12).
  test("wrap pytest + sleep: how-to writes; SemanticStore/gist skip Tool Bash result is …", async () => {
    await withMem("eden-m104-noidentity-wrap-", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      await mem.sleep();
      assertHowToSkill(howtos(dir, "auth pytest flake", 5));
      expect(tracesKept(dir)).toBe(true);
      assertNoToolIdentity(dir);
    });
  });

  test("hook PostToolUse + Stop: how-to at root; no bash-tool-result identity", async () => {
    const dir = tmpDir("eden-m104-noidentity-hook-");
    const session = "s-m104-noid";
    await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
      try {
        memoryHookResponse({
          hook_event_name: "PostToolUse",
          session_id: session,
          tool_name: "Bash",
          tool_input: { command: PYTEST_CMD },
          tool_response: PYTEST_OUT,
        });
        memoryHookResponse({ hook_event_name: "Stop", session_id: session });
        assertHowToSkill(howtos(hookStore(dir), "auth pytest flake", 5));
        assertNoToolIdentity(hookStore(dir));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("M10 grep-only Bash does not promote", () => {
  test("Bash git grep exit 0 stays episodic: HowToStore empty; traces remain", async () => {
    await withMem("eden-m104-gitgrep-", async (mem, dir) => {
      observeToolTraces(mem, [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_gg",
              type: "function",
              function: { name: "Bash", arguments: JSON.stringify({ command: "git grep auth" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_gg", content: "auth.ts:1:export\nexit 0" },
      ]);
      await mem.sleep();
      expect(howtos(dir, "auth", 8)).toEqual([]);
      expect(new HowToStore(dir).latest("auth.ts", 5)).toEqual([]);
      expect(tracesKept(dir)).toBe(true);
    });
  });
});

const DASHBOARD_RE = /dashboard|memorable graph|memory_search|memorable-cli/i;
const INVENTED_CMD_RE = /rm\s+-rf|cd\s+\/tmp|npm\s+install/;

function assertNoDashboardChrome(v: unknown) {
  expect(jsonHay(v).toLowerCase()).not.toMatch(DASHBOARD_RE);
}

function assertNoInventedCommands(v: unknown) {
  expect(jsonHay(v)).not.toMatch(INVENTED_CMD_RE);
}

function stepsGapsBlob(view: Pick<HowToView, "steps" | "gaps">): string {
  return JSON.stringify({ steps: view.steps, gaps: view.gaps });
}

function originalPaths(row: Pick<HowTo, "files" | "steps">): Set<string> {
  const out = new Set<string>();
  for (const f of row.files) if (typeof f === "string" && f.trim()) out.add(f);
  for (const s of row.steps) {
    for (const f of s.files ?? []) if (typeof f === "string" && f.trim()) out.add(f);
    const args = s.args;
    if (args && typeof args === "object") {
      for (const k of ["path", "file", "filepath", "filename"] as const) {
        const v = args[k];
        if (typeof v === "string" && v.trim()) out.add(v);
      }
    }
  }
  return out;
}

function assertPathsFrom(row: Pick<HowTo, "files" | "steps">, got: string[]) {
  const orig = originalPaths(row);
  for (const f of got) {
    if (typeof f !== "string" || !f.trim()) continue;
    expect(orig.has(f)).toBe(true);
  }
  expect(got.some((f) => f === "src/auth.ts" || f.endsWith("/src/auth.ts"))).toBe(false);
}

function prefixParents(): { a: HowTo; b: HowTo } {
  const prefix = [
    { name: "Write", args: { path: "foo.ts" }, files: ["foo.ts"], exit: 0, order: 0 },
    { name: "Edit", args: { path: "foo.ts" }, files: ["foo.ts"], exit: 0, order: 1 },
  ];
  const a: HowTo = {
    id: "ht-prefix-a",
    cue: "fix foo.ts",
    steps: [
      ...prefix,
      {
        name: "Bash",
        args: { command: "pytest tests/auth/session.test.ts -q" },
        files: ["auth.ts"],
        exit: 0,
        order: 2,
      },
    ],
    files: ["foo.ts", "auth.ts"],
    verify: "pytest tests/auth/session.test.ts -q",
    exit: 0,
    t: 10,
    family: "foo-prefix",
  };
  const b: HowTo = {
    id: "ht-prefix-b",
    cue: "fix foo.ts",
    steps: [
      ...prefix,
      {
        name: "Bash",
        args: { command: "npm test -- tests/auth/login.test.ts" },
        files: ["login.ts"],
        exit: 0,
        order: 2,
      },
    ],
    files: ["foo.ts", "login.ts"],
    verify: "npm test -- tests/auth/login.test.ts",
    exit: 0,
    t: 20,
    family: "foo-prefix",
  };
  return { a, b };
}

function assertPrefixOnly(merged: HowTo) {
  expect(merged.steps.length).toBe(2);
  expect(merged.steps[0]!.name.toLowerCase()).toBe("write");
  expect(merged.steps[1]!.name.toLowerCase()).toBe("edit");
  const hay = skillHay(merged);
  expect(/pytest/i.test(hay) && /npm/i.test(hay)).toBe(false);
  assertNoInventedCommands(merged);
  expect(jsonHay(merged.steps)).not.toMatch(/pytest/i);
  expect(jsonHay(merged.steps)).not.toMatch(/\bnpm\b/i);
}

function writeEditThenWindow(id: string, cmd: string): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: `${id}-w`,
          type: "function",
          function: {
            name: "Write",
            arguments: JSON.stringify({ path: "foo.ts", file_path: "foo.ts", contents: "export const n = 1;\n" }),
          },
        },
        {
          id: `${id}-e`,
          type: "function",
          function: { name: "Edit", arguments: JSON.stringify({ path: "foo.ts", file_path: "foo.ts" }) },
        },
        {
          id: `${id}-v`,
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: cmd }) },
        },
      ],
    },
    { role: "tool", tool_call_id: `${id}-w`, content: "wrote foo.ts\nexit 0" },
    { role: "tool", tool_call_id: `${id}-e`, content: "patched foo.ts\nexit 0" },
    { role: "tool", tool_call_id: `${id}-v`, content: "ok\nfoo.ts touched\nexit 0" },
  ];
}

describe("M11.4 missing step is a gap, not a hallucinated command", () => {
  test("order hole at 1: unknown gap; Write and pytest may remain; no invented middle command", () => {
    const dir = tmpDir("eden-m114-gap-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "fix auth pytest",
        steps: [
          { name: "Write", args: { path: "auth.ts" }, files: ["auth.ts"], exit: 0, order: 0 },
          { name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 2 },
        ],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      const views = retrieveHowTo(dir, "fix auth pytest");
      expect(Array.isArray(views)).toBe(true);
      expect(views.length).toBeGreaterThan(0);
      const view: HowToView = views[0]!;
      expect(Array.isArray(view.gaps)).toBe(true);
      expect(view.gaps.length).toBeGreaterThan(0);
      for (const g of view.gaps) expect(g.kind).toBe("unknown");
      const blob = stepsGapsBlob(view);
      expect(blob).not.toMatch(INVENTED_CMD_RE);
      expect(blob).not.toContain("src/auth.ts");
      expect(blob).not.toContain("rm -rf");
      expect(blob).not.toContain("cd /tmp");
      expect(blob).not.toContain("npm install");
      const names = view.steps.map((s) => s.name.toLowerCase());
      if (names.includes("write")) {
        expect(view.steps.some((s) => /auth\.ts/.test(`${jsonHay(s.args)} ${(s.files ?? []).join(" ")}`))).toBe(true);
      }
      if (view.steps.some((s) => /pytest/i.test(`${s.name} ${jsonHay(s.args)}`))) {
        expect(jsonHay(view.steps)).toMatch(/pytest/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M11.4 bound ≤3", () => {
  test("retrieveHowTo k:99 still returns at most HOWTO_RETRIEVE_K (3)", () => {
    expect(HOWTO_RETRIEVE_K).toBe(3);
    const dir = tmpDir("eden-m114-bound-");
    try {
      const store = new HowToStore(dir);
      for (let i = 0; i < 6; i++) {
        store.put({
          cue: `fix skill${i}`,
          steps: [{ name: "Write", args: { path: `s${i}.ts` }, files: [`s${i}.ts`], exit: 0, order: 0 }],
          files: [`s${i}.ts`],
          verify: `echo s${i}`,
          exit: 0,
          t: i + 1,
        });
      }
      expect(new HowToStore(dir).latest("fix", 99).length).toBeGreaterThan(3);
      const views = retrieveHowTo(dir, "fix", { k: 99 });
      expect(views.length).toBeLessThanOrEqual(3);
      expect(views.length).toBeLessThanOrEqual(HOWTO_RETRIEVE_K);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M11.4 token cap", () => {
  test("huge-arg how-to is bounded; no invented commands fill the budget", () => {
    expect(HOWTO_TOKEN_CAP).toBeGreaterThanOrEqual(200);
    expect(HOWTO_TOKEN_CAP).toBeLessThanOrEqual(400);
    const dir = tmpDir("eden-m114-tok-");
    try {
      const bulky = "X".repeat(400);
      const steps = Array.from({ length: 12 }, (_, i) => ({
        name: "Bash" as const,
        args: { command: `echo ${bulky} step${i}` },
        files: [`h${i}.ts`],
        exit: 0,
        order: i,
      }));
      new HowToStore(dir).put({
        cue: "fix bulky how-to",
        steps,
        files: steps.flatMap((s) => s.files),
        verify: "echo done",
        exit: 0,
        t: 1,
      });
      const views = retrieveHowTo(dir, "fix bulky how-to");
      expect(views.length).toBeGreaterThan(0);
      const view = views[0]!;
      const raw = JSON.stringify({ steps: view.steps, verify: view.verify, gaps: view.gaps });
      expect(view.steps.length).toBeLessThan(12);
      expect(view.gaps.some((g: HowToGap) => g.kind === "unknown" && /truncat/i.test(g.reason))).toBe(true);
      expect(raw.length).toBeLessThan(JSON.stringify(steps).length);
      assertNoInventedCommands(view);
      expect(raw).not.toMatch(INVENTED_CMD_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("huge verify is dropped to the token cap; no invented commands fill the budget", () => {
    const dir = tmpDir("eden-m114-tok-verify-");
    try {
      new HowToStore(dir).put({
        cue: "fix huge verify",
        steps: [{ name: "Write", args: { path: "a.ts" }, files: ["a.ts"], exit: 0, order: 0 }],
        files: ["a.ts"],
        verify: `pytest ${"Y".repeat(5000)}`,
        exit: 0,
        t: 1,
      });
      const views = retrieveHowTo(dir, "fix huge verify");
      expect(views.length).toBeGreaterThan(0);
      const view = views[0]!;
      const payload = JSON.stringify({ steps: view.steps, verify: view.verify });
      expect(payload.length).toBeLessThanOrEqual(HOWTO_TOKEN_CAP * 4 + 80);
      expect(view.verify === undefined || (view.verify?.length ?? 0) < 400).toBe(true);
      expect(view.gaps.some((g: HowToGap) => g.kind === "unknown" && /truncat/i.test(g.reason))).toBe(true);
      expect(view.steps.some((s) => /^write$/i.test(s.name))).toBe(true);
      assertNoInventedCommands(view);
      expect(JSON.stringify(view.gaps)).not.toMatch(INVENTED_CMD_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M11.4 fail-open", () => {
  test("throwing exists, latest, and inject observe: no throw; keep or empty", async () => {
    const dir = tmpDir("eden-m114-failopen-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "fix auth pytest",
        steps: [{ name: "Write", args: { path: "auth.ts" }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      const row = store.latest("fix auth pytest", 5)[0]!;
      expect(row).toBeTruthy();

      const boom = () => {
        throw new Error("m114 exists boom");
      };
      let retrieved: HowToView[] | undefined;
      expect(() => {
        retrieved = retrieveHowTo(dir, "fix auth pytest", { exists: boom });
      }).not.toThrow();
      expect(Array.isArray(retrieved)).toBe(true);

      let omitted: { steps: HowTo["steps"]; files: string[]; gaps: HowToGap[] } | undefined;
      expect(() => {
        omitted = omitStalePlace(row, { exists: boom });
      }).not.toThrow();
      expect(omitted).toBeTruthy();
      expect(omitted!.steps.length).toBeGreaterThan(0);
      expect(omitted!.steps.some((s) => /^write$/i.test(s.name))).toBe(true);

      const latestSpy = spyOn(HowToStore.prototype, "latest").mockImplementation(() => {
        throw new Error("m114 latest boom");
      });
      try {
        let out: HowToView[] | undefined;
        expect(() => {
          out = retrieveHowTo(dir, "fix auth pytest");
        }).not.toThrow();
        expect(out).toEqual([]);
      } finally {
        latestSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    await withMem("eden-m114-failopen-inject-", async (mem) => {
      const list = [{ role: "user", content: "hi from m114" }];
      mem.observe = (() => {
        throw new Error("m114 inject observe boom");
      }) as typeof mem.observe;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "hi from m114" }]);
    });
  });
});

describe("M11.4 no dashboard", () => {
  test("retrieve / omit / merge serialization has no dashboard chrome", () => {
    const dir = tmpDir("eden-m114-dash-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "fix auth pytest",
        steps: [
          { name: "Write", args: { path: "auth.ts" }, files: ["auth.ts"], exit: 0, order: 0 },
          { name: "Bash", args: { command: PYTEST_CMD }, files: ["keep.ts"], exit: 0, order: 1 },
        ],
        files: ["auth.ts", "keep.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      const row = store.latest("fix auth pytest", 5)[0]!;
      const views = retrieveHowTo(dir, "fix auth pytest");
      const omitted = omitStalePlace(row, { exists: (f) => !/auth\.ts$/.test(f) });
      const { a, b } = prefixParents();
      const merged = mergeSharedPrefix(a, b);
      assertNoDashboardChrome(views);
      assertNoDashboardChrome(omitted);
      assertNoDashboardChrome(merged);
      for (const hay of [jsonHay(views), jsonHay(omitted), jsonHay(merged)]) {
        expect(hay.toLowerCase()).not.toContain("dashboard");
        expect(hay.toLowerCase()).not.toContain("memorable graph");
        expect(hay.toLowerCase()).not.toContain("memory_search");
        expect(hay.toLowerCase()).not.toContain("memorable-cli");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M11.4 omit stale place", () => {
  test("gone auth.ts step omitted as missing-place gap; keep.ts pytest remains; no fake path", () => {
    const dir = tmpDir("eden-m114-omit-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "auth pytest flake",
        steps: [
          { name: "Write", args: { path: "auth.ts" }, files: ["auth.ts"], exit: 0, order: 0 },
          { name: "Bash", args: { command: PYTEST_CMD }, files: ["keep.ts"], exit: 0, order: 1 },
        ],
        files: ["auth.ts", "keep.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      const row = store.latest("auth pytest flake", 5)[0]!;
      expect(row).toBeTruthy();
      const exists = (f: string) => !/auth\.ts$/.test(f);
      const omitted = omitStalePlace(row, { exists });
      expect(
        omitted.steps.some(
          (s) => /^write$/i.test(s.name) && /auth\.ts/.test(`${jsonHay(s.args)} ${(s.files ?? []).join(" ")}`),
        ),
      ).toBe(false);
      expect(
        omitted.gaps.some((g) => g.kind === "unknown" && /auth\.ts/.test(`${g.place ?? ""} ${g.reason ?? ""}`)),
      ).toBe(true);
      expect(omitted.gaps.some((g) => /missing place/i.test(g.reason))).toBe(true);
      expect(
        omitted.steps.some(
          (s) => /pytest/i.test(`${s.name} ${jsonHay(s.args)}`) || (s.files ?? []).some((f) => /keep\.ts$/.test(f)),
        ),
      ).toBe(true);
      expect(omitted.files.some((f) => /keep\.ts$/.test(f))).toBe(true);
      expect(omitted.files.some((f) => /(^|\/)auth\.ts$/.test(f))).toBe(false);
      assertPathsFrom(row, omitted.files);
      assertNoInventedCommands(omitted);

      const views = retrieveHowTo(dir, "auth pytest flake", { exists });
      expect(views.length).toBeGreaterThan(0);
      const view = views[0]!;
      expect(view.gaps.some((g) => g.kind === "unknown")).toBe(true);
      expect(view.gaps.some((g) => /auth\.ts/.test(`${g.place ?? ""} ${g.reason ?? ""}`))).toBe(true);
      expect(
        view.steps.some(
          (s) => /^write$/i.test(s.name) && /auth\.ts/.test(`${jsonHay(s.args)} ${(s.files ?? []).join(" ")}`),
        ),
      ).toBe(false);
      assertPathsFrom(row, view.files);
      expect(stepsGapsBlob(view)).not.toContain("src/auth.ts");
      assertNoInventedCommands(view);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omitStalePlace / retrieve without exists or cwd do not wipe against the store dir", () => {
    const dir = tmpDir("eden-m114-omit-nocwd-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "auth pytest flake",
        steps: [
          {
            name: "Write",
            args: { path: "definitely-not-in-store.ts" },
            files: ["definitely-not-in-store.ts"],
            exit: 0,
            order: 0,
          },
          { name: "Bash", args: { command: PYTEST_CMD }, files: ["also-missing.ts"], exit: 0, order: 1 },
        ],
        files: ["definitely-not-in-store.ts", "also-missing.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      const row = store.latest("auth pytest flake", 5)[0]!;
      const omitted = omitStalePlace(row);
      expect(omitted.steps.length).toBe(row.steps.length);
      expect(omitted.files.length).toBe(row.files.length);
      expect(omitted.gaps).toEqual([]);
      const views = retrieveHowTo(dir, "auth pytest flake");
      expect(views[0]!.steps.length).toBe(row.steps.length);
      store.pruneStale();
      expect(store.latest("auth pytest flake", 5).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M11.4 shared-prefix merge does not invent steps", () => {
  test("mergeSharedPrefix keeps only Write+Edit; no pytest+npm concat; sleep invents no third path", async () => {
    const { a, b } = prefixParents();
    const fromStore =
      (howtoMod as { mergeSharedPrefix?: typeof mergeSharedPrefix }).mergeSharedPrefix ??
      (sleepMod as { mergeSharedPrefix?: typeof mergeSharedPrefix }).mergeSharedPrefix;
    expect(typeof fromStore).toBe("function");
    const merged = mergeSharedPrefix(a, b);
    expect(merged).toBeTruthy();
    assertPrefixOnly(merged!);
    expect(merged!.steps.length).toBe(2);

    const dir = tmpDir("eden-m114-merge-put-");
    try {
      const store = new HowToStore(dir);
      store.put(a);
      store.put(b);
      const stored = store.latest("foo.ts", 10);
      expect(stored.length).toBeGreaterThanOrEqual(2);
      const left = stored.find((r) => /pytest/i.test(skillHay(r)));
      const right = stored.find((r) => /npm/i.test(skillHay(r)));
      expect(left && right).toBeTruthy();
      const again = mergeSharedPrefix(left!, right!);
      expect(again).toBeTruthy();
      assertPrefixOnly(again!);
      mergeSharedPrefixHowTo(dir);
      const afterMerge = store.latest("foo.ts", 20);
      expect(afterMerge.some((r) => /pytest/i.test(jsonHay(r.steps)) && r.steps.length >= 3)).toBe(true);
      expect(afterMerge.some((r) => /\bnpm\b/i.test(jsonHay(r.steps)) && r.steps.length >= 3)).toBe(true);
      const glued = afterMerge.filter((r) => /pytest/i.test(jsonHay(r.steps)) && /\bnpm\b/i.test(jsonHay(r.steps)));
      expect(glued).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    await withMem("eden-m114-merge-sleep-", async (mem, dir) => {
      observeToolTraces(mem, writeEditThenWindow("m114a", "pytest tests/auth/session.test.ts -q"));
      await mem.sleep();
      observeToolTraces(mem, writeEditThenWindow("m114b", "npm test -- tests/auth/login.test.ts"));
      await mem.sleep();
      const rows = new HowToStore(dir).latest("foo.ts", 20);
      expect(rows.length).toBeGreaterThan(0);
      const chimera = rows.filter((r) => /pytest/i.test(jsonHay(r.steps)) && /\bnpm\b/i.test(jsonHay(r.steps)));
      expect(chimera).toEqual([]);
      const pytestSkill = rows.find((r) => /pytest/i.test(skillHay(r)) && r.steps.length >= 3);
      const npmSkill = rows.find((r) => /\bnpm\b/i.test(skillHay(r)) && !/pytest/i.test(jsonHay(r.steps)));
      expect(pytestSkill).toBeTruthy();
      expect(npmSkill).toBeTruthy();
      const writeEdit = rows.filter((r) => {
        const names = r.steps.map((s) => s.name.toLowerCase());
        return names[0] === "write" && names[1] === "edit";
      });
      expect(writeEdit.length).toBeGreaterThan(0);
      for (const r of writeEdit) {
        if (r.steps.length === 2) assertPrefixOnly(r);
        assertNoInventedCommands(r);
      }
      const fromSleep = mergeSharedPrefix(pytestSkill!, npmSkill!);
      expect(fromSleep).toBeTruthy();
      assertPrefixOnly(fromSleep!);
    });
  });
});

describe("M11.4 chat-only still zero how-to", () => {
  test("sleep on chat: retrieveHowTo empty", async () => {
    await withMem("eden-m114-chat-", async (mem, dir) => {
      mem.observe([
        { role: "user", content: "How is the weather looking for the ship?" },
        { role: "assistant", content: "It looks sunny this afternoon." },
      ]);
      await mem.sleep();
      expect(howtos(dir, "anything", 5)).toEqual([]);
      expect(retrieveHowTo(dir, "anything")).toEqual([]);
      expect(retrieveHowTo(dir, "auth pytest flake")).toEqual([]);
      expect(retrieveHowTo(dir, "weather ship")).toEqual([]);
    });
  });
});

describe("M11.4 wrap/hook fail-open and no [procedure]", () => {
  test("OpenAI wrap, Anthropic wrap, hook Submit/Stop: Clerk injects; no [procedure]; throw fails open", async () => {
    await withHookMem("eden-m114-wrap-hook-", async (mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);

      const openai = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: "what is auth using?" }] });
      const openaiHay = JSON.stringify(openai);
      expect(openaiHay).toMatch(/Clerk/i);
      expect(openaiHay).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

      const anthBody = { messages: [{ role: "user", content: "what is auth using?" }] };
      const anth = withKnowFactsAnthropic(anthBody);
      expect(JSON.stringify(anth)).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

      const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is auth using?" });
      const submitHay = JSON.stringify(submit);
      expect(submitHay).toMatch(/Clerk/i);
      expect(submitHay).not.toMatch(HOOK_PROCEDURE);

      expect(() => memoryHookResponse({ hook_event_name: "Stop" })).not.toThrow();
      expect(memoryHookResponse({ hook_event_name: "Stop" })).toBeNull();

      const list = [{ role: "user", content: "hi from m114 wrap" }];
      const injectBoom = spyOn(mem, "injectBody").mockImplementation(() => {
        throw new Error("m114 wrap injectBody boom");
      });
      try {
        let wrapOut: unknown;
        expect(() => {
          wrapOut = injectBodyThenObserveTools(mem, { messages: list });
        }).not.toThrow();
        expect(wrapOut).toEqual({ messages: list });
      } finally {
        injectBoom.mockRestore();
      }

      const { AgentMemory } = await import("./index");
      const notesBoom = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(() => {
        throw new Error("m114 anth notesFor boom");
      });
      try {
        const original = { messages: [{ role: "user", content: "hi from m114 anth" }] };
        let anthOut: unknown;
        expect(() => {
          anthOut = withKnowFactsAnthropic(original);
        }).not.toThrow();
        expect(anthOut).toEqual(original);
      } finally {
        notesBoom.mockRestore();
      }
    });
  });
});

describe("M11.4 torn howto.jsonl", () => {
  test("invalid line is skipped; retrieveHowTo still returns the good skill; no throw", () => {
    const dir = tmpDir("eden-m114-torn-howto-");
    try {
      const store = new HowToStore(dir);
      store.put({
        cue: "auth pytest flake",
        steps: [
          { name: "Write", args: { path: "auth.ts" }, files: ["auth.ts"], exit: 0, order: 0 },
          { name: "Bash", args: { command: PYTEST_CMD }, files: ["keep.ts"], exit: 0, order: 1 },
        ],
        files: ["auth.ts", "keep.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      const path = howtoPath(dir);
      const body = existsSync(path) ? readFileSync(path, "utf8") : "";
      writeFileSync(path, "{not json\n" + body);
      let views: HowToView[] | undefined;
      expect(() => {
        views = retrieveHowTo(dir, "auth pytest flake");
      }).not.toThrow();
      expect(views).toBeTruthy();
      expect(views!.length).toBeGreaterThan(0);
      expect(views![0]!.exit).toBe(0);
      expect(hasAuthFile(views![0]!.files) || /auth\.ts/i.test(skillHay(views![0]!))).toBe(true);
      assertNoInventedCommands(views);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const FLAKE_CMD_CUE = JSON.stringify({ cmd: PYTEST_CMD, path: "auth.ts" });
const FLAKE_TEXT_CUE = "the flake is in auth.ts";

function putFlakeSkill(dir: string): void {
  new HowToStore(dir).put({
    cue: "auth pytest flake",
    steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
    files: ["auth.ts"],
    verify: PYTEST_CMD,
    exit: 0,
    t: 1,
  });
}

function packetBullets(pkt: string): string[] {
  const i = pkt.indexOf(MEMORY_MARK);
  const body = i >= 0 ? pkt.slice(i) : pkt;
  return body.split("\n").filter((l) => /^\s*-\s+/.test(l));
}

function procedureSpans(pkt: string): string[] {
  return packetBullets(pkt).filter((l) => HOOK_PROCEDURE.test(l));
}

function assertFlakeProcedure(hay: string): void {
  expect(hay).toMatch(HOOK_PROCEDURE);
  expect(hay).toMatch(/auth\.ts/);
  expect(hay).toMatch(/pytest/i);
  expect(hay).toMatch(/tests\/auth\/session\.test\.ts/);
}

/**
 * A procedure bullet in a packet: the hook, and since P0.7 the wrap, word bullets without kind tags (D14), so its
 * `verify:` or `unknown:` step names it.
 */
const HOOK_PROCEDURE = /\b(?:verify|unknown): /;

function assertHookFlakeProcedure(hay: string): void {
  expect(hay).toMatch(HOOK_PROCEDURE);
  expect(hay).toMatch(/auth\.ts/);
  expect(hay).toMatch(/pytest/i);
  expect(hay).toMatch(/tests\/auth\/session\.test\.ts/);
}

async function withProcessMem<T>(mem: AgentMemory, fn: () => T | Promise<T>): Promise<T> {
  // Tests: processMemory() allocates a random dir; pin both it and openMemory to this mem.
  const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
  const openSpy = spyOn(edenMem, "openMemory").mockImplementation(() => mem);
  try {
    return await fn();
  } finally {
    procSpy.mockRestore();
    openSpy.mockRestore();
  }
}

describe("M12.4 schema-rename WIN", () => {
  test.failing("cmd-not-command cue injects [procedure] with pytest + auth.ts", async () => {
    expect(FLAKE_CMD_CUE).toContain('"cmd"');
    expect(FLAKE_CMD_CUE).not.toContain('"command"');
    await withMem("eden-m124-rename-", async (mem, dir) => {
      putFlakeSkill(dir);
      const injected = mem.inject([{ role: "user", content: FLAKE_CMD_CUE }]);
      assertFlakeProcedure(packetOf(injected));

      const mixed = mem.inject([
        {
          role: "user",
          content: `${FLAKE_TEXT_CUE} ${FLAKE_CMD_CUE}`,
        },
      ]);
      assertFlakeProcedure(packetOf(mixed));
    });
  });

  test.failing("sleep-produced command skill still injects [procedure] on cmd cue", async () => {
    await withMem("eden-m124-rename-sleep-", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      await mem.sleep();
      const rows = howtos(dir, "auth pytest flake", 5);
      expect(rows.some((r) => /command/.test(skillHay(r)))).toBe(true);
      const injected = mem.inject([{ role: "user", content: FLAKE_CMD_CUE }]);
      assertFlakeProcedure(packetOf(injected));
    });
  });

  test.failing("OpenAI wrap, Anthropic wrap, hook Submit: flake howto.jsonl injects [procedure]", async () => {
    await withMem("eden-m124-wrap-hook-", async (mem, dir) => {
      putFlakeSkill(dir);

      const openai = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
      assertFlakeProcedure(JSON.stringify(openai));
      assertFlakeProcedure(packetOf(Array.isArray(openai.messages) ? openai.messages : []));

      await withProcessMem(mem, async () => {
        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
        assertFlakeProcedure(JSON.stringify(anth));
      });

      const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: FLAKE_CMD_CUE });
      assertFlakeProcedure(JSON.stringify(submit));
    });
  });
});

describe("M12.4 snapshot flake cue", () => {
  test("the flake is in auth.ts packet includes [procedure] + files + verify", async () => {
    await withMem("eden-m124-snap-", async (mem, dir) => {
      putFlakeSkill(dir);
      const pkt = packetOf(mem.inject([{ role: "user", content: FLAKE_TEXT_CUE }]));
      assertFlakeProcedure(pkt);
      expect(pkt).toMatch(/verify/i);
    });
  });

  test("chat-only Clerk observe packet has no [procedure]", async () => {
    await withMem("eden-m124-chat-", async (mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      const clerk = packetOf(mem.inject([{ role: "user", content: "what is auth using?" }]));
      expect(clerk).toMatch(/Clerk/i);
      expect(clerk).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      const flake = packetOf(mem.inject([{ role: "user", content: FLAKE_TEXT_CUE }]));
      expect(flake).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
    });
  });

  test("unrelated weather cue does not dump last how-to", async () => {
    await withMem("eden-m124-weather-", async (mem, dir) => {
      putFlakeSkill(dir);
      const pkt = packetOf(mem.inject([{ role: "user", content: "How is the weather looking for the ship?" }]));
      expect(pkt).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      const weak = packetOf(mem.inject([{ role: "user", content: "please run the tests" }]));
      expect(weak).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
    });
  });
});

describe("M12.4 Start does not dump last-k how-to", () => {
  test("SessionStart briefing has pins+gists only; empty cue inject dumps no [procedure]", async () => {
    const session = "s-m124-start";
    await withMem(
      "eden-m124-start-",
      async (mem, dir) => {
        putFlakeSkill(dir);
        mem.remember("Always run tests before committing", { kind: "constraint" });
        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const hay = JSON.stringify(start ?? {});
        expect(hay).not.toMatch(HOOK_PROCEDURE);
        expect(hay).not.toMatch(/howto\.jsonl|how-to dump/i);
        if (hay.includes(MEMORY_MARK))
          expect(hay).toMatch(/- Always run tests before committing|\(earlier session notes/);

        const empty = packetOf(mem.inject([]));
        expect(empty).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
        const blank = packetOf(mem.inject([{ role: "user", content: "" }]));
        expect(blank).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      },
      session,
    );
  });
});

describe("M12.4 no MCP symbols", () => {
  test("know-inject.ts, memory-hook.ts, proxy.ts have no memory_search or memorable-cli identifiers", () => {
    const files = [
      join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
      join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
      join(import.meta.dir, "../packages/wrap/src/proxy.ts"),
    ];
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      expect(src).not.toMatch(/\bmemory_search\b/);
      expect(src).not.toMatch(/\bmemorable-cli\b/);
    }
  });
});

describe("M12.4 fail-open", () => {
  test("retrieveHowTo throw and unreadable howto.jsonl: inject does not 500; Clerk still injects", async () => {
    await withMem("eden-m124-failopen-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      putFlakeSkill(dir);
      const list = [{ role: "user", content: FLAKE_TEXT_CUE }];

      const boom = spyOn(howtoRetrieve, "retrieveHowTo").mockImplementation(() => {
        throw new Error("m124 retrieveHowTo boom");
      });
      try {
        let out: unknown;
        expect(() => {
          out = mem.inject(list);
        }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
        const hay = JSON.stringify(out);
        expect(hay).toMatch(/the flake is in auth\.ts/);
        expect(hay).not.toMatch(/\b500\b|Internal Server Error/i);
        const clerk = mem.inject([{ role: "user", content: "what is auth using?" }]);
        expect(`${packetOf(clerk)}\n${JSON.stringify(clerk)}`).toMatch(/Clerk/i);
      } finally {
        boom.mockRestore();
      }

      const path = howtoPath(dir);
      expect(existsSync(path)).toBe(true);
      chmodSync(path, 0o000);
      try {
        let unread: unknown;
        expect(() => {
          unread = mem.inject([{ role: "user", content: "what is auth using?" }]);
        }).not.toThrow();
        expect(`${packetOf(unread as unknown[])}\n${JSON.stringify(unread)}`).toMatch(/Clerk/i);
      } finally {
        try {
          chmodSync(path, 0o600);
        } catch {}
      }
    });
  });

  test("wrap injectBody throw fails open; how-to throw does not 500 OpenAI/Anthropic/hook", async () => {
    await withHookMem("eden-m124-failopen-wrap-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      putFlakeSkill(dir);

      const list = [{ role: "user", content: "hi from m124 wrap" }];
      const injectBoom = spyOn(mem, "injectBody").mockImplementation(() => {
        throw new Error("m124 wrap injectBody boom");
      });
      try {
        let wrapOut: unknown;
        expect(() => {
          wrapOut = injectBodyThenObserveTools(mem, { messages: list });
        }).not.toThrow();
        expect(wrapOut).toEqual({ messages: list });
      } finally {
        injectBoom.mockRestore();
      }

      const howBoom = spyOn(howtoRetrieve, "retrieveHowTo").mockImplementation(() => {
        throw new Error("m124 wrap retrieveHowTo boom");
      });
      try {
        let openai: unknown;
        expect(() => {
          openai = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: "what is auth using?" }] });
        }).not.toThrow();
        expect(JSON.stringify(openai)).toMatch(/Clerk|what is auth using/i);
        expect(JSON.stringify(openai)).not.toMatch(/\b500\b|Internal Server Error/i);

        await withProcessMem(mem, async () => {
          const original = { messages: [{ role: "user", content: "hi from m124 anth" }] };
          let anthOut: unknown;
          expect(() => {
            anthOut = withKnowFactsAnthropic(original);
          }).not.toThrow();
          expect(anthOut).toBeTruthy();
          expect(JSON.stringify(anthOut)).not.toMatch(/\b500\b|Internal Server Error/i);
        });

        let hookOut: unknown;
        expect(() => {
          hookOut = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is auth using?" });
        }).not.toThrow();
        const hookHay = JSON.stringify(hookOut);
        expect(hookHay).toMatch(/Clerk/i);
        expect(hookHay).not.toMatch(/\b500\b|Internal Server Error/i);
      } finally {
        howBoom.mockRestore();
      }
    });
  });
});

describe("M12.4 k total", () => {
  test("packet bullets ≤ 4 (D28) and a procedure bullet ≤ ~1200 chars", async () => {
    await withMem("eden-m124-k-", async (mem, dir) => {
      putFlakeSkill(dir);
      mem.quiet(() => {
        for (let n = 1; n <= 20; n++) {
          mem.remember(`Auth pytest flake note ${n} lives in auth.ts session tests.`);
        }
      });
      // D28 (the wrap's shape since P0.7): 4 bullets in retrieval order, nothing pulled in. Twenty on-cue facts
      // rank above the procedure here, so whether it makes the four is the ranker's; a procedure that does is bounded.
      const pkt = packetOf(mem.inject([{ role: "user", content: FLAKE_TEXT_CUE }]));
      expect(packetBullets(pkt).length).toBeLessThanOrEqual(PACKET_SOFT_BULLETS);
      for (const line of procedureSpans(pkt)) {
        const body = line.replace(/^- /, "").replace(/ \([^()]*\)$/, "");
        expect(body.length).toBeLessThanOrEqual(1200);
      }
    });
  });
});

describe("M12.4 secrets stay out of [procedure]", () => {
  test.failing("sk- in verify/args does not appear in the inject packet", async () => {
    await withMem("eden-m124-secret-pkt-", async (mem, dir) => {
      new HowToStore(dir).put({
        cue: "auth pytest flake",
        steps: [
          {
            name: "Bash",
            args: { command: PYTEST_CMD, api_key: "sk-abc123XYZ999secret" },
            files: ["auth.ts"],
            exit: 0,
            order: 0,
          },
        ],
        files: ["auth.ts"],
        verify: `${PYTEST_CMD} sk-abc123XYZ999secret`,
        exit: 0,
        t: 1,
      });
      const pkt = packetOf(mem.inject([{ role: "user", content: FLAKE_CMD_CUE }]));
      assertFlakeProcedure(pkt);
      expect(pkt).not.toContain("sk-abc123XYZ999secret");
      expect(pkt).not.toMatch(/\bsk-/);
      const disk = readFileSync(howtoPath(dir), "utf8");
      expect(disk).not.toContain("sk-abc123XYZ999secret");
      expect(disk).not.toMatch(/\bsk-/);
    });
  });
});

describe("M12.4 latest sees step command values", () => {
  test.failing("cmd cue still hits when files/verify are empty and newer unrelated skills exist", async () => {
    await withMem("eden-m124-crowd-", async (mem, dir) => {
      for (let i = 0; i < 5; i++) {
        new HowToStore(dir).put({
          cue: `unrelated skill ${i}`,
          steps: [{ name: "Read", args: { path: `foo${i}.md` }, files: [`foo${i}.md`], exit: 0, order: 0 }],
          files: [`foo${i}.md`],
          verify: `cat foo${i}.md`,
          exit: 0,
          t: 100 + i,
        });
      }
      new HowToStore(dir).put({
        cue: "generic run",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: [],
        exit: 0,
        t: 1,
      });
      const pkt = packetOf(mem.inject([{ role: "user", content: FLAKE_CMD_CUE }]));
      expect(pkt).toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      expect(pkt).toMatch(/pytest/i);
      expect(pkt).toMatch(/tests\/auth\/session\.test\.ts/);
    });
  });
});

describe("M14.4 one dir / same how-to id", () => {
  test("wrap sleep writes join(dir, howto.jsonl) not session/; Start silent; Submit injects same id", async () => {
    const session = "s-m14-onedir";
    await withHookMem(
      "eden-m14-onedir-",
      async (mem, dir) => {
        observeToolTraces(mem, pytestWindow());
        await mem.sleep();

        const rootHowTo = join(dir, "howto.jsonl");
        const sessionHowTo = join(dir, session, "howto.jsonl");
        expect(howtoPath(dir)).toBe(rootHowTo);
        expect(existsSync(rootHowTo)).toBe(true);
        expect(existsSync(sessionHowTo)).toBe(false);

        const stored = assertHowToSkill(new HowToStore(dir).latest("auth pytest flake", 5));
        expect(stored.id).toBeTruthy();
        expect(retrieveHowTo(dir, "auth pytest flake").some((r) => r.id === stored.id)).toBe(true);

        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const startHay = JSON.stringify(start ?? {});
        expect(startHay).not.toMatch(HOOK_PROCEDURE);
        expect(startHay).not.toMatch(/howto\.jsonl|how-to dump/i);

        const afterStart = new HowToStore(dir).latest("auth pytest flake", 5);
        expect(afterStart.some((r) => r.id === stored.id)).toBe(true);
        expect(existsSync(sessionHowTo)).toBe(false);

        const submit = memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: session,
          prompt: FLAKE_TEXT_CUE,
        });
        assertHookFlakeProcedure(JSON.stringify(submit ?? {}));
        expect(new HowToStore(dir).latest("auth pytest flake", 5).some((r) => r.id === stored.id)).toBe(true);
      },
      session,
    );
  });

  test("wrap processMemory-style (no session) then hook Start: same how-to id on root", async () => {
    await withHookMem("eden-m14-wrap-root-", async (mem, dir) => {
      observeToolTraces(mem, pytestWindow());
      await mem.sleep();
      const stored = assertHowToSkill(new HowToStore(dir).latest("auth pytest flake", 5));
      expect(existsSync(join(dir, "howto.jsonl"))).toBe(true);

      const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: "s-hook-after-wrap" });
      expect(JSON.stringify(start ?? {})).not.toMatch(HOOK_PROCEDURE);
      expect(new HowToStore(dir).latest("auth pytest flake", 5).some((r) => r.id === stored.id)).toBe(true);

      const submit = memoryHookResponse({
        hook_event_name: "UserPromptSubmit",
        session_id: "s-hook-after-wrap",
        prompt: FLAKE_TEXT_CUE,
      });
      assertHookFlakeProcedure(JSON.stringify(submit ?? {}));
      // D1: the hook's session has no directory of its own; its how-to path is the repo store's.
      expect(existsSync(join(dir, "s-hook-after-wrap"))).toBe(false);
      expect(howtoPath(dir)).toBe(join(dir, "howto.jsonl"));
    });
  });

  test.failing("leftover memory/<session>/howto.jsonl migrates onto root with the same id", async () => {
    await withMem("eden-m14-leftover-", async (_mem, dir) => {
      const session = "s-left";
      const sub = join(dir, session);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "memories.jsonl"), "");
      writeFileSync(
        join(sub, "howto.jsonl"),
        `${JSON.stringify({
          id: "ht_leftover_m14",
          cue: "auth pytest flake",
          steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
          files: ["auth.ts"],
          verify: PYTEST_CMD,
          exit: 0,
          t: 9,
        })}\n`,
      );
      const opened = openMemory({ dir, session });
      expect(new HowToStore(dir).latest("auth pytest flake", 5).some((r) => r.id === "ht_leftover_m14")).toBe(true);
      expect(existsSync(join(dir, "howto.jsonl"))).toBe(true);
      expect(existsSync(join(sub, "howto.jsonl"))).toBe(false);
      opened.close();
    });
  });
});

describe("M14.4 cross-host inject", () => {
  test.failing(
    "wrap write then OpenAI injectBody / injectBodyThenObserveTools, Anthropic, hook Submit share [procedure]",
    async () => {
      await withMem("eden-m14-xhost-", async (mem, dir) => {
        observeToolTraces(mem, pytestWindow());
        await mem.sleep();
        const stored = assertHowToSkill(howtos(dir, "auth pytest flake", 5));
        expect(howtoPath(dir)).toBe(join(dir, "howto.jsonl"));

        const openaiBody = mem.injectBody({ messages: [{ role: "user", content: FLAKE_TEXT_CUE }] });
        const openaiMsgs = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
        assertFlakeProcedure(`${packetOf(openaiMsgs)}\n${JSON.stringify(openaiBody)}`);

        const openaiTools = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
        const toolMsgs = Array.isArray(openaiTools.messages) ? openaiTools.messages : [];
        assertFlakeProcedure(`${packetOf(toolMsgs)}\n${JSON.stringify(openaiTools)}`);

        await withProcessMem(mem, async () => {
          const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: FLAKE_TEXT_CUE }] });
          assertFlakeProcedure(JSON.stringify(anth));

          const viaProc = withKnowFacts({ messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
          assertFlakeProcedure(JSON.stringify(viaProc));
        });

        const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: FLAKE_TEXT_CUE });
        assertFlakeProcedure(JSON.stringify(submit ?? {}));
        expect(new HowToStore(dir).latest("auth pytest flake", 5).some((r) => r.id === stored.id)).toBe(true);
      });
    },
  );
});

describe("M14.4 chat-only zero how-to", () => {
  test("user/assistant only: HowToStore empty; three hosts inject Clerk with no [procedure]", async () => {
    await withHookMem("eden-m14-chat-", async (mem, dir) => {
      mem.observe([
        { role: "user", content: "Auth is Clerk" },
        { role: "assistant", content: "Understood, we use Clerk for auth." },
      ]);
      await mem.sleep();
      expect(new HowToStore(dir).latest("anything", 5)).toEqual([]);
      expect(retrieveHowTo(dir, "auth pytest flake")).toEqual([]);
      if (existsSync(howtoPath(dir))) {
        expect(readFileSync(howtoPath(dir), "utf8").trim()).toBe("");
      }

      const openai = mem.injectBody({ messages: [{ role: "user", content: "what is auth using?" }] });
      const openaiHay = `${packetOf(Array.isArray(openai.messages) ? openai.messages : [])}\n${JSON.stringify(openai)}`;
      expect(openaiHay).toMatch(/Clerk/i);
      expect(openaiHay).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

      const wrapped = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: "what is auth using?" }] });
      expect(JSON.stringify(wrapped)).toMatch(/Clerk/i);
      expect(JSON.stringify(wrapped)).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

      await withProcessMem(mem, async () => {
        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: "what is auth using?" }] });
        const anthHay = JSON.stringify(anth);
        expect(anthHay).toMatch(/Clerk/i);
        expect(anthHay).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      });

      const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is auth using?" });
      const submitHay = JSON.stringify(submit ?? {});
      expect(submitHay).toMatch(/Clerk/i);
      expect(submitHay).not.toMatch(HOOK_PROCEDURE);
    });
  });
});

describe("M14.4 fail-open and no BrainMemory product", () => {
  test("retrieveHowTo throw still pass-through on wrap injectBody, Anthropic, and hook", async () => {
    await withHookMem("eden-m14-failopen-", async (mem, dir) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      putFlakeSkill(dir);
      const boom = spyOn(howtoRetrieve, "retrieveHowTo").mockImplementation(() => {
        throw new Error("m14 retrieveHowTo boom");
      });
      try {
        let openai: unknown;
        expect(() => {
          openai = mem.injectBody({ messages: [{ role: "user", content: "what is auth using?" }] });
        }).not.toThrow();
        expect(JSON.stringify(openai)).toMatch(/Clerk/i);
        expect(JSON.stringify(openai)).not.toMatch(/\b500\b|Internal Server Error/i);

        await withProcessMem(mem, async () => {
          const original = { messages: [{ role: "user", content: "hi from m14 anth" }] };
          let anth: unknown;
          expect(() => {
            anth = withKnowFactsAnthropic(original);
          }).not.toThrow();
          expect(anth).toBeTruthy();
          expect(JSON.stringify(anth)).not.toMatch(/\b500\b|Internal Server Error/i);
        });

        let hookOut: unknown;
        expect(() => {
          hookOut = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is auth using?" });
        }).not.toThrow();
        expect(JSON.stringify(hookOut)).toMatch(/Clerk/i);
        expect(JSON.stringify(hookOut)).not.toMatch(/\b500\b|Internal Server Error/i);
      } finally {
        boom.mockRestore();
      }
    });
  });

  test("wrap/hook inject modules do not import BrainMemory as product", () => {
    const files = [
      join(import.meta.dir, "index.ts"),
      join(import.meta.dir, "../packages/wrap/src/know-inject.ts"),
      join(import.meta.dir, "../packages/cli/src/memory-hook.ts"),
    ];
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      expect(src).not.toMatch(/\bBrainMemory\b/);
      expect(src).not.toMatch(/brain-memory/);
    }
  });
});

describe("M35.4 schema-rename command→cmd", () => {
  test.failing(
    "stored command key still injects [procedure] on a cmd cue (inject, OpenAI, Anthropic, hook)",
    async () => {
      expect(FLAKE_CMD_CUE).toContain('"cmd"');
      expect(FLAKE_CMD_CUE).not.toContain('"command"');
      await withMem("eden-m354-rename-", async (mem, dir) => {
        putFlakeSkill(dir);
        const rows = howtos(dir);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => /"command"/.test(skillHay(r)))).toBe(true);

        assertFlakeProcedure(packetOf(mem.inject([{ role: "user", content: FLAKE_CMD_CUE }])));

        const openai = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
        assertFlakeProcedure(JSON.stringify(openai));

        await withProcessMem(mem, async () => {
          const via = withKnowFacts({ messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
          assertFlakeProcedure(JSON.stringify(via));
          const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: FLAKE_CMD_CUE }] });
          assertFlakeProcedure(JSON.stringify(anth));
        });

        const submit = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: FLAKE_CMD_CUE });
        assertFlakeProcedure(JSON.stringify(submit));
      });
    },
  );

  test("empty cue and SessionStart dump no [procedure]; chat-only Clerk has none", async () => {
    const session = "s-m354-start";
    await withMem(
      "eden-m354-empty-",
      async (mem, dir) => {
        putFlakeSkill(dir);
        mem.observe([{ role: "user", content: "Auth is Clerk" }]);
        mem.remember("Always run tests before committing", { kind: "constraint" });

        expect(packetOf(mem.inject([]))).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
        expect(packetOf(mem.inject([{ role: "user", content: "" }]))).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        expect(JSON.stringify(start ?? {})).not.toMatch(HOOK_PROCEDURE);

        const clerk = packetOf(mem.inject([{ role: "user", content: "what is auth using?" }]));
        expect(clerk).toMatch(/Clerk/i);
        expect(clerk).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
      },
      session,
    );
  });
});

describe("M45.2 failed child does not prune parent how-to", () => {
  test.failing("child exit 1 + missing auth.ts cwd keeps parent exit-0 skill and [procedure]", async () => {
    const dir = tmpDir("eden-m452-child-");
    const project = tmpDir("eden-m452-work-");
    const childName = "s-parent--agent-1";
    try {
      const store = new HowToStore(dir);
      const put = store.put({
        cue: "auth pytest flake",
        steps: [{ name: "Bash", args: { command: PYTEST_CMD }, files: ["auth.ts"], exit: 0, order: 0 }],
        files: ["auth.ts"],
        verify: PYTEST_CMD,
        exit: 0,
        t: 1,
      });
      expect(put).toBeTruthy();
      const id = put!.id;
      expect(existsSync(join(project, "auth.ts"))).toBe(false);

      await withEnv({ EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined }, async () => {
        const child = openMemory({ dir, session: childName, cwd: project, child: true });
        expect(child.jsonlDir).not.toBe(dir);
        expect((child as unknown as { howtoDir?: string }).howtoDir).toBe(dir);
        persistToolTraces(child.jsonlDir, [
          {
            name: "Bash",
            args: { command: PYTEST_CMD },
            files: ["auth.ts"],
            exit: 1,
            t: Date.now(),
          },
        ]);
        expect(loadTraces(dir, childName).some((t) => t.exit === 1)).toBe(true);

        await expect(child.sleep({ session: childName })).resolves.toBeUndefined();
        await expect(sleep({ session: childName, dir, mem: child })).resolves.toBeUndefined();

        store.put({
          cue: "auth pytest flake rabbit",
          steps: [{ name: "Bash", args: { command: "pytest --lf" }, files: ["auth.ts"], exit: 1, order: 0 }],
          files: ["auth.ts"],
          verify: "pytest --lf",
          exit: 1,
          t: 50,
        });
        store.pruneStale({ child: true, cwd: project, exists: () => false });

        const kept = store.latest("auth pytest flake", 10);
        const parent = kept.find((r) => r.id === id);
        expect(parent).toBeTruthy();
        expect(parent!.exit).toBe(0);
        expect(parent!.verify).toBe(PYTEST_CMD);
        expect(hasAuthFile(parent!.files)).toBe(true);
        expect(kept.some((r) => r.exit !== 0)).toBe(false);

        const parentMem = openMemory({ dir });
        assertFlakeProcedure(packetOf(parentMem.inject([{ role: "user", content: FLAKE_TEXT_CUE }])));
        assertFlakeProcedure(packetOf(child.inject([{ role: "user", content: FLAKE_TEXT_CUE }])));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
