import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withKnowFacts, withKnowFactsAnthropic } from "./know-inject";
import { injectBodyThenObserveTools, observeToolTraces, stripUpstreamPlaceFields, withOpenFileHeaders } from "./tool-observe";
import { handleChatCompletions } from "./proxy";
import { createState } from "./wrap-tools";
import { KNOW_INJECT_MARK } from "../../know/src/inject";
import { AgentMemory, cueFor, MEMORY_MARK, openMemory } from "../../../src/index";
import * as edenMem from "../../../src/index";
import { HowToStore, howtoPath } from "../../../src/howto-store";

function notes(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: string }[]) : [];
  return messages.filter((m) => m.role === "system" && String(m.content || "").startsWith(KNOW_INJECT_MARK)).map((m) => String(m.content));
}

describe("withKnowFacts", () => {
  test("EDEN_KNOW=0 and silent chat do not inject", () => {
    const prev = process.env.EDEN_KNOW;
    process.env.EDEN_KNOW = "0";
    try {
      const body = { messages: [{ role: "user", content: "Follow RFC 3986 and send application/json." }] };
      expect(withKnowFacts(body)).toBe(body);
    } finally {
      if (prev === undefined) delete process.env.EDEN_KNOW;
      else process.env.EDEN_KNOW = prev;
    }
    const quiet = { messages: [{ role: "user", content: "Please refactor the auth middleware and add a log line." }] };
    expect(withKnowFacts(quiet)).toEqual(quiet);
  });

  test("already injected stays one card; fail-open on junk body", () => {
    const marked = {
      messages: [
        { role: "system", content: `${KNOW_INJECT_MARK} RFC 3986 is Uniform Resource Identifier (URI): Generic Syntax.` },
        { role: "user", content: "Follow RFC 3986 and GET application/json." },
      ],
    };
    const out = withKnowFacts(marked);
    expect(notes(out)).toHaveLength(1);
    expect(withKnowFacts({ messages: "not-an-array" as unknown as unknown[] })).toEqual({
      messages: "not-an-array" as unknown as unknown[],
    });
  });

  test("at most one Eden Know system note; frozen RFC catalog does not inject", () => {
    const body = {
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Follow RFC 3986 and send application/json with GET." },
      ],
    };
    const out = withKnowFacts(body);
    const injected = notes(out);
    expect(injected.length).toBeLessThanOrEqual(1);
    expect(injected).toHaveLength(0);
    expect(out.messages).toHaveLength(2);
  });

  test("structured identifiers do not inject frozen catalogs; chat without needles stays quiet", () => {
    const utf = withKnowFacts({ messages: [{ role: "user", content: "charset=utf8" }] });
    expect(notes(utf)).toHaveLength(0);

    const rfc = withKnowFacts({ messages: [{ role: "user", content: "Follow RFC 3986 and send application/json with GET." }] });
    expect(notes(rfc)).toHaveLength(0);

    const quiet = { messages: [{ role: "user", content: "Please refactor the auth middleware and add a log line." }] };
    expect(withKnowFacts(quiet)).toEqual(quiet);
  });

  test("anthropic dialect prepends one block or stays put; tools/calls reach need detect", () => {
    const silent = withKnowFactsAnthropic({ messages: [{ role: "user", content: "refactor the middleware" }] });
    expect(silent.system).toBeUndefined();
    const prev = process.env.EDEN_KNOW;
    process.env.EDEN_KNOW = "0";
    try {
      const body = { system: "be brief", messages: [{ role: "user", content: "RFC 3986" }] };
      expect(withKnowFactsAnthropic(body).system).toBe("be brief");
    } finally {
      if (prev === undefined) delete process.env.EDEN_KNOW;
      else process.env.EDEN_KNOW = prev;
    }
    const catalog = withKnowFactsAnthropic({
      tools: [{ name: "grep", input_schema: {} }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "grep", input: { path: "src/auth.ts", pattern: "TODO" } }],
        },
        { role: "user", content: "Please refactor the auth middleware and add a log line." },
      ],
    });
    // Know catalog stays quiet. M2.3 tool traces encode after rank; M3.2 must not echo this-turn user text.
    const catalogSys = JSON.stringify(catalog.system ?? "");
    expect(catalogSys).not.toContain(KNOW_INJECT_MARK);
    expect(catalogSys).not.toContain("Tool grep");

    const header = withKnowFacts({
      tools: [{ name: "Grep" }, { name: "Read" }],
      messages: [{ role: "user", content: "Set Content-Type to application/json" }],
    });
    expect(notes(header)).toHaveLength(0);
  });
});

function anthropicMemoryText(body: { system?: unknown }): string {
  const sys = body.system;
  const parts = typeof sys === "string"
    ? [sys]
    : Array.isArray(sys)
      ? sys.map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? "")))
      : [];
  return parts.filter((p) => p.includes(MEMORY_MARK)).join("\n");
}

function markCount(body: { system?: unknown }): number {
  const raw = anthropicMemoryText(body) || (typeof body.system === "string" ? body.system : Array.isArray(body.system)
    ? body.system.map((b) => (typeof b === "string" ? b : String((b as { text?: string })?.text ?? ""))).join("\n")
    : "");
  if (!raw.includes(MEMORY_MARK)) return 0;
  return raw.split(MEMORY_MARK).length - 1;
}

describe("withKnowFactsAnthropic M3 order", () => {
  test("MEMORY_MARK block does not contain this-turn Clerk", () => {
    const out = withKnowFactsAnthropic({ messages: [{ role: "user", content: "Auth is Clerk" }] });
    expect(anthropicMemoryText(out)).not.toContain("Clerk");
  });

  test("skip-if-mark does not add a second card but still observes", () => {
    const observe = spyOn(AgentMemory.prototype, "observe");
    try {
      const body = {
        system: `${MEMORY_MARK}\n- CI is GitHub Actions`,
        messages: [{ role: "user", content: "Auth is Clerk" }],
      };
      const out = withKnowFactsAnthropic(body);
      expect(out).toBe(body);
      expect(out.system).toBe(body.system);
      expect(markCount(out)).toBe(1);
      expect(JSON.stringify(out.system ?? "")).not.toMatch(/Eden Memory:[\s\S]*Eden Memory:/);
      expect(observe).toHaveBeenCalled();
    } finally {
      observe.mockRestore();
    }
  });

  test("fail-open returns the original body", () => {
    const body = { system: 1 as unknown as string, messages: [{ role: "user", content: "Auth is Clerk" }] };
    expect(withKnowFactsAnthropic(body)).toBe(body);
  });

  test("empty cue does not dump last-k", () => {
    const notesFor = spyOn(AgentMemory.prototype, "notesFor");
    try {
      const out = withKnowFactsAnthropic({
        messages: [{ role: "assistant", content: "working" }],
      });
      expect(JSON.stringify(out.system ?? "")).not.toMatch(/Pacific/i);
      expect(notesFor).not.toHaveBeenCalled();
    } finally {
      notesFor.mockRestore();
    }
  });

  test("Anthropic content-block last user does not echo this-turn Clerk", () => {
    const out = withKnowFactsAnthropic({
      messages: [{ role: "user", content: [{ type: "text", text: "Auth is Clerk" }] }],
    });
    expect(anthropicMemoryText(out)).not.toContain("Clerk");
  });

  test("unicode last user is a cue, not a throw", () => {
    const body = { messages: [{ role: "user", content: "café 時區 日本語" }] };
    expect(() => withKnowFactsAnthropic(body)).not.toThrow();
    expect(anthropicMemoryText(withKnowFactsAnthropic(body))).not.toContain("café");
  });

  test("two serials: labeled Bob, not Alice; uses inject assemble", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m8-anth-serial-"));
    const mem = openMemory({ dir });
    mem.remember("1. The chairperson of the committee is Alice.");
    mem.remember("8. The chairperson of the committee is Bob.");
    const real = AgentMemory.prototype.inject;
    const inject = spyOn(AgentMemory.prototype, "inject").mockImplementation(function (this: AgentMemory, messages: unknown[]) {
      return real.call(mem, messages);
    });
    try {
      const out = withKnowFactsAnthropic({
        messages: [{ role: "user", content: "who is the chairperson of the committee" }],
      });
      const pkt = anthropicMemoryText(out);
      expect(inject).toHaveBeenCalled();
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
      expect(pkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
    } finally {
      inject.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const M13_SQLITE = "Use sqlite.";
const M13_SQLITE_Q = "What sqlite database do we use?";
const M13_CLERK = "Auth is Clerk";

function m13WithEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function openaiMemoryText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role?: string; content?: unknown }[]) : [];
  return messages
    .filter((m) => m.role === "system" && typeof m.content === "string" && String(m.content).includes(MEMORY_MARK))
    .map((m) => String(m.content))
    .join("\n");
}

function redirectMemory(mem: AgentMemory): () => void {
  const realInject = AgentMemory.prototype.inject;
  const realBody = AgentMemory.prototype.injectBody;
  const inject = spyOn(AgentMemory.prototype, "inject").mockImplementation(function (this: AgentMemory, messages: unknown[]) {
    return realInject.call(mem, messages);
  });
  const injectBody = spyOn(AgentMemory.prototype, "injectBody").mockImplementation(function (this: AgentMemory, body: Record<string, unknown>) {
    return realBody.call(mem, body);
  });
  return () => {
    inject.mockRestore();
    injectBody.mockRestore();
  };
}

describe("M13 honest off switch (wrap)", () => {
  test("off: inject/injectBody identity; withKnowFacts and Anthropic return original body", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-wrap-off-"));
    try {
      for (const value of ["0", "off"]) {
        m13WithEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
          const mem = openMemory({ dir });
          mem.remember(M13_SQLITE);
          const list = [{ role: "user", content: M13_SQLITE_Q }];
          expect(mem.inject(list)).toBe(list);
          expect(JSON.stringify(mem.inject(list))).not.toContain(MEMORY_MARK);

          const body = { messages: list };
          expect(mem.injectBody(body)).toBe(body);

          const openai = { messages: [{ role: "user", content: M13_SQLITE_Q }] };
          let openaiOut: Record<string, unknown> | undefined;
          expect(() => {
            openaiOut = withKnowFacts(openai);
          }).not.toThrow();
          expect(openaiOut).toBe(openai);
          expect(openaiMemoryText(openaiOut!)).not.toContain(MEMORY_MARK);
          expect(JSON.stringify(openaiOut)).not.toMatch(/403/);

          const anth = { system: "be brief", messages: [{ role: "user", content: M13_SQLITE_Q }] };
          let anthOut: ReturnType<typeof withKnowFactsAnthropic> | undefined;
          expect(() => {
            anthOut = withKnowFactsAnthropic(anth);
          }).not.toThrow();
          expect(anthOut).toBe(anth);
          expect(anthOut!.system).toBe("be brief");
          expect(anthropicMemoryText(anthOut!)).not.toContain(MEMORY_MARK);
          mem.close();
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readonly: existing sqlite [fact] injects on OpenAI and Anthropic; Auth is Clerk is not persisted", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-wrap-ro-"));
    const mem = openMemory({ dir });
    const restore = redirectMemory(mem);
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        mem.remember(M13_SQLITE);
      });
      for (const value of ["readonly", "read-only", "ro"]) {
        m13WithEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
          const openai = withKnowFacts({ messages: [{ role: "user", content: M13_SQLITE_Q }] });
          const openaiPkt = openaiMemoryText(openai);
          expect(openaiPkt).toContain(MEMORY_MARK);
          expect(openaiPkt).toMatch(/sqlite/i);
          expect(openaiPkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);

          const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: M13_SQLITE_Q }] });
          const anthPkt = anthropicMemoryText(anth);
          expect(anthPkt).toContain(MEMORY_MARK);
          expect(anthPkt).toMatch(/sqlite/i);
          expect(anthPkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);

          withKnowFacts({ messages: [{ role: "user", content: M13_CLERK }] });
          withKnowFactsAnthropic({ messages: [{ role: "user", content: M13_CLERK }] });
          mem.observe([{ role: "user", content: M13_CLERK }]);
          expect(mem.memories().some((r) => /Clerk/i.test(r.text))).toBe(false);
        });
      }
    } finally {
      restore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on: unset/1/on wrap OpenAI and Anthropic inject sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m13-wrap-on-"));
    const mem = openMemory({ dir });
    const restore = redirectMemory(mem);
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        mem.remember(M13_SQLITE);
      });
      for (const value of [undefined, "1", "on"] as const) {
        m13WithEnv({ EDEN_MEMORY: value, EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
          const openai = withKnowFacts({ messages: [{ role: "user", content: M13_SQLITE_Q }] });
          const openaiPkt = openaiMemoryText(openai);
          expect(openaiPkt).toContain(MEMORY_MARK);
          expect(openaiPkt).toMatch(/sqlite/i);
          expect(openaiPkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);

          const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: M13_SQLITE_Q }] });
          const anthPkt = anthropicMemoryText(anth);
          expect(anthPkt).toContain(MEMORY_MARK);
          expect(anthPkt).toMatch(/sqlite/i);
          expect(anthPkt).toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
        });
      }
    } finally {
      restore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fail-open: inject throw still original body; off is identity not 403", () => {
    const openai = { messages: [{ role: "user", content: M13_SQLITE_Q }] };
    const anth = { system: "be brief", messages: [{ role: "user", content: M13_SQLITE_Q }] };
    const boomBody = spyOn(AgentMemory.prototype, "injectBody").mockImplementation(() => {
      throw new Error("m13 wrap openai fail-open");
    });
    const boomInject = spyOn(AgentMemory.prototype, "inject").mockImplementation(() => {
      throw new Error("m13 wrap anthropic fail-open");
    });
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_KNOW: "0" }, () => {
        expect(withKnowFacts(openai)).toBe(openai);
        expect(withKnowFactsAnthropic(anth)).toBe(anth);
      });
    } finally {
      boomBody.mockRestore();
      boomInject.mockRestore();
    }
    m13WithEnv({ EDEN_MEMORY: "0", EDEN_KNOW: "0" }, () => {
      expect(withKnowFacts(openai)).toBe(openai);
      expect(withKnowFactsAnthropic(anth)).toBe(anth);
      expect(JSON.stringify(withKnowFacts(openai))).not.toMatch(/403/);
    });
  });
});

const M14_PYTEST = "pytest tests/auth/session.test.ts -q";
const M14_FLAKE = "the flake is in auth.ts";

function m14PytestWindow(): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_pytest",
          type: "function",
          function: { name: "Bash", arguments: JSON.stringify({ command: M14_PYTEST }) },
        },
        {
          id: "call_read",
          type: "function",
          function: { name: "Read", arguments: JSON.stringify({ path: "src/login.ts" }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_pytest", content: "collected 1 item\nauth.ts touched\nexit 0" },
    { role: "tool", tool_call_id: "call_read", content: "ok\nexit 0" },
  ];
}

function m14AssertFlake(hay: string): void {
  expect(hay).toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
  expect(hay).toMatch(/auth\.ts/);
  expect(hay).toMatch(/pytest/i);
  expect(hay).toMatch(/tests\/auth\/session\.test\.ts/);
}

describe("M14.4 wrap OpenAI + Anthropic share howto.jsonl", () => {
  test("observe+sleep then injectBody / injectBodyThenObserveTools / withKnowFactsAnthropic see [procedure]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m14-wrap-"));
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        observeToolTraces(mem, m14PytestWindow());
      });
      await mem.sleep();
      expect(howtoPath(dir)).toBe(join(dir, "howto.jsonl"));
      expect(existsSync(join(dir, "howto.jsonl"))).toBe(true);
      expect(new HowToStore(dir).latest("auth pytest flake", 5).length).toBeGreaterThan(0);

      const openai = mem.injectBody({ messages: [{ role: "user", content: M14_FLAKE }] });
      m14AssertFlake(JSON.stringify(openai));

      const tools = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: M14_FLAKE }] });
      m14AssertFlake(JSON.stringify(tools));

      const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: M14_FLAKE }] });
      m14AssertFlake(JSON.stringify(anth));
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat-only wrap injects Clerk with no [procedure] and empty HowToStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m14-wrap-chat-"));
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      mem.observe([
        { role: "user", content: M13_CLERK },
        { role: "assistant", content: "Understood, we use Clerk for auth." },
      ]);
      await mem.sleep();
      expect(new HowToStore(dir).latest("anything", 5)).toEqual([]);

      const openai = mem.injectBody({ messages: [{ role: "user", content: "what is auth using?" }] });
      expect(JSON.stringify(openai)).toMatch(/Clerk/i);
      expect(JSON.stringify(openai)).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

      const tools = injectBodyThenObserveTools(mem, { messages: [{ role: "user", content: "what is auth using?" }] });
      expect(JSON.stringify(tools)).toMatch(/Clerk/i);
      expect(JSON.stringify(tools)).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);

      const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: "what is auth using?" }] });
      expect(JSON.stringify(anth)).toMatch(/Clerk/i);
      expect(JSON.stringify(anth)).not.toMatch(/\[procedure(?:\s*·[^\]]*)?\]/);
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const M17_ICL_LONG =
  "The movie review is glowing and mentions every scene in detail about the protagonist and the village festival that lasted three nights under lanterns while the orchestra played until dawn and the crowd wept. label: 28 extra filler words to exceed four hundred characters of extractDurable tax so we can see if the whole exemplar is dropped or chopped into pieces by the allow-list pipeline that is still the only encode path.";

describe("M17 wrap encode lanes", () => {
  test("injectBody and Anthropic retrieve whole ICL shot stored on observe", () => {
    expect(M17_ICL_LONG.length).toBeGreaterThan(400);
    const dir = mkdtempSync(join(tmpdir(), "eden-m17-wrap-"));
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0" }, () => {
        mem.observe([{ role: "user", content: M17_ICL_LONG }]);
        expect(mem.memories().some((r) => r.text === M17_ICL_LONG && r.lane === "icl")).toBe(true);
        const openai = mem.injectBody({ messages: [{ role: "user", content: "The movie review. label:" }] });
        expect(openaiMemoryText(openai)).toMatch(/label:\s*28/);
        const anth = withKnowFactsAnthropic({ messages: [{ role: "user", content: "The movie review. label:" }] });
        expect(JSON.stringify(anth)).toMatch(/label:\s*28/);
      });
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M38.2 wrap honors an omitted packet", () => {
  test("sqlite store + what's 2+2? adds no Eden Memory chrome; empty inject still logs", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m38-wrap-"));
    const mem = openMemory({ dir });
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    const log = join(dir, "inject.jsonl");
    try {
      m13WithEnv({
        EDEN_MEMORY: "on",
        EDEN_MEMORY_DIR: dir,
        EDEN_HOME: undefined,
        EDEN_KNOW: "0",
        EDEN_MEMORY_MIN: undefined,
        EDEN_MEMORY_INJECT_LOG: log,
      }, () => {
        mem.remember("Use sqlite.");
        const openaiBody = { messages: [{ role: "user", content: "what's 2+2?" }] };
        const openai = withKnowFacts(openaiBody);
        expect(openai).toBe(openaiBody);
        expect(JSON.stringify(openai)).not.toContain(MEMORY_MARK);
        expect(JSON.stringify(openai)).not.toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
        expect(JSON.stringify(openai)).not.toMatch(/sqlite/i);

        const anthBody = { system: "be brief", messages: [{ role: "user", content: "what's 2+2?" }] };
        const anth = withKnowFactsAnthropic(anthBody);
        expect(anth).toBe(anthBody);
        expect(anth.system).toBe("be brief");
        expect(JSON.stringify(anth)).not.toContain(MEMORY_MARK);
        expect(JSON.stringify(anth)).not.toMatch(/\[fact(?:\s*·[^\]]*)?\]/);
        expect(JSON.stringify(anth)).not.toMatch(/sqlite/i);

        const directBody = { messages: [{ role: "user", content: "what's 2+2?" }] };
        const direct = injectBodyThenObserveTools(mem, directBody);
        expect(direct).toBe(directBody);
        expect(JSON.stringify(direct)).not.toContain(MEMORY_MARK);

        expect(existsSync(log)).toBe(true);
        const rows = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { empty?: boolean });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.empty === true)).toBe(true);
      });
    } finally {
      procSpy.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CI_Q = "What GitHub Actions CI do we use?";
const AUTH_SOURCE = "export function login() {\n  return \"session-secret-body\";\n}\n";

function pacificTurns(): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  for (let i = 0; i < 20; i++) {
    out.push({ role: "user", content: `Kai timezone is Pacific note ${i}.` });
    out.push({ role: "assistant", content: `Noted Pacific timezone for slot ${i}.` });
  }
  return out;
}

describe("M41 wrap place cues", () => {
  test("40 Pacific turns plus the CI question stay this-turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m41-id-"));
    const mem = openMemory({ dir });
    const cues: string[] = [];
    const real = AgentMemory.prototype.notesFor;
    const notesFor = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(function (this: AgentMemory, text?: string, k?: number, opts?: { fuse?: boolean }) {
      cues.push(String(text ?? ""));
      return real.call(this, text, k);
    });
    try {
      mem.remember("Kai timezone is Pacific");
      for (let i = 0; i < 8; i++) mem.remember(`Kai timezone is Pacific office slot ${i} for standup hours.`);
      mem.remember("CI is GitHub Actions");
      const messages = [...pacificTurns(), { role: "user", content: CI_Q }];
      const body = { model: "gpt-4o", messages };
      const out = injectBodyThenObserveTools(mem, body);
      expect(cueFor(messages)).toBe(CI_Q);
      expect(cues.at(-1)).toBe(CI_Q);
      expect(cues.at(-1)).not.toMatch(/Pacific/i);
      const packet = openaiMemoryText(out);
      expect(packet).toMatch(/GitHub Actions/);
      expect(packet).not.toMatch(/Pacific/i);
      expect(out).not.toHaveProperty("open_files");
    } finally {
      notesFor.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("path header and last-user files are place names, not file source or the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m41-place-"));
    const mem = openMemory({ dir });
    const cues: string[] = [];
    const real = AgentMemory.prototype.notesFor;
    const notesFor = spyOn(AgentMemory.prototype, "notesFor").mockImplementation(function (this: AgentMemory, text?: string, k?: number, opts?: { fuse?: boolean }) {
      cues.push(String(text ?? ""));
      return real.call(this, text, k);
    });
    const proc = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    try {
      m13WithEnv({ EDEN_MEMORY: "on", EDEN_KNOW: "0", EDEN_MEMORY_MIN: undefined }, () => {
        mem.remember("Kai timezone is Pacific");
        mem.remember("Session checks live in auth.ts.");
        const last = { role: "user", content: CI_Q, files: ["src/lib/auth.ts"] };
        const messages = [...pacificTurns(), last];
        const prepared = withOpenFileHeaders(
          { model: "gpt-4o", messages, file_paths: ["src/lib/session.ts"] },
          `src/lib/auth.ts, ${AUTH_SOURCE}`,
        );
        expect(prepared.open_files).toEqual(expect.arrayContaining(["auth.ts"]));
        expect(JSON.stringify(prepared.open_files)).not.toContain("session-secret-body");
        expect(last.files).toEqual(["src/lib/auth.ts"]);
        expect(last.content).toBe(CI_Q);

        const out = injectBodyThenObserveTools(mem, prepared);
        expect(cueFor(messages)).toBe(CI_Q);
        expect(cueFor(messages)).not.toContain("session-secret-body");
        expect(cues.at(-1)).toMatch(/auth\.ts/);
        expect(cues.at(-1)).not.toMatch(/Pacific/i);
        expect(cues.at(-1)).not.toContain("session-secret-body");
        expect(openaiMemoryText(out)).not.toContain("session-secret-body");
        expect(openaiMemoryText(out)).toMatch(/auth\.ts/);
        expect(out).not.toHaveProperty("open_files");
        expect(out).not.toHaveProperty("file_paths");

        const anthLast = { role: "user", content: CI_Q };
        const anthMessages = [anthLast];
        const anth = withKnowFactsAnthropic({ messages: anthMessages, open_files: ["src/lib/auth.ts"] } as { messages: unknown[] });
        expect(anthLast).toEqual({ role: "user", content: CI_Q });
        expect(anth).not.toHaveProperty("open_files");
        expect(cues.at(-1)).toMatch(/auth\.ts/);
        expect(JSON.stringify(anth)).not.toContain("session-secret-body");
        expect(JSON.stringify(anth)).not.toMatch(/Pacific/i);
      });
    } finally {
      proc.mockRestore();
      notesFor.mockRestore();
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chat completions copy path headers for inject and omit them upstream", async () => {
    let upstream = "";
    let seen: Record<string, unknown> | undefined;
    const injectBody = spyOn(AgentMemory.prototype, "injectBody").mockImplementation((body: Record<string, unknown>) => {
      seen = body;
      return body;
    });
    try {
      const state = createState({
        fetch: (async (_url: unknown, init?: { body?: string }) => {
          upstream = String(init?.body ?? "");
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        }) as unknown as typeof fetch,
      });
      const res = await handleChatCompletions(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { "x-eden-open-files": "src/lib/auth.ts", "x-open-files": "src/lib/session.ts" },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: CI_Q, files: ["src/lib/auth.ts"] }],
            open_files: ["README.md"],
          }),
        }),
        { state },
      );
      expect(res.status).toBe(200);
      expect(seen?.open_files).toEqual(expect.arrayContaining(["auth.ts", "session.ts", "README.md"]));
      expect(JSON.stringify(seen?.open_files)).not.toContain("session-secret-body");
      const forwarded = JSON.parse(upstream) as Record<string, unknown>;
      expect(forwarded).not.toHaveProperty("open_files");
      expect(forwarded).not.toHaveProperty("openFiles");
      expect(forwarded).not.toHaveProperty("file_paths");
      const msgs = forwarded.messages as { content?: string; files?: string[] }[];
      expect(msgs[0]?.content).toBe(CI_Q);
      expect(msgs[0]?.files).toEqual(["src/lib/auth.ts"]);
    } finally {
      injectBody.mockRestore();
    }
  });

  test("header parse failure leaves the original inject body", () => {
    const body = { messages: [{ role: "user", content: CI_Q }] };
    expect(withOpenFileHeaders(body, "   ")).toBe(body);
    expect(withOpenFileHeaders(body, AUTH_SOURCE)).toBe(body);
    expect(() => withOpenFileHeaders(body, "src/lib/auth.ts src/lib/session.ts")).not.toThrow();
    const named = withOpenFileHeaders(body, "src/lib/auth.ts src/lib/session.ts");
    expect(named).not.toBe(body);
    expect(named.open_files).toEqual(expect.arrayContaining(["auth.ts", "session.ts"]));
    expect(body).not.toHaveProperty("open_files");
  });

  test("upstream strip drops file bodies and keeps path names on the message", () => {
    const body = {
      messages: [{
        role: "user",
        content: CI_Q,
        files: ["src/lib/auth.ts", "function foo() { return bar/baz; }", { path: "src/lib/session.ts", content: AUTH_SOURCE }],
      }],
      recently_viewed_files: [AUTH_SOURCE],
    };
    const out = stripUpstreamPlaceFields(body);
    expect(out).not.toHaveProperty("recently_viewed_files");
    const msgs = out.messages as { content?: string; files?: unknown[] }[];
    expect(msgs[0]?.content).toBe(CI_Q);
    expect(msgs[0]?.files).toEqual(["src/lib/auth.ts", "session.ts", "src/lib/session.ts"]);
    expect(JSON.stringify(out)).not.toContain("session-secret-body");
    expect(JSON.stringify(out)).not.toContain("function foo");
  });
});
