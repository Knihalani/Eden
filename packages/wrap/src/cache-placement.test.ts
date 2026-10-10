/**
 * P0.7's gate (D29, A4 §5.9): the wrap and the OpenAI-shaped `inject` put a turn's packet at the tail of its human
 * user message and keep it there, so each request repeats the previous request's cacheable prefix byte for byte.
 * The scenario is `benchmarks/wrap-cache/prefix.ts`'s, which measured main's breaks for the pre-registration.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as edenMem from "../../../src/index";
import { MEMORY_PACKET_MARKS } from "../../../src/memory-sota";
import { measure, packetsOf, requests, SEED, type Body } from "../../../benchmarks/wrap-cache/prefix";
import { withKnowFacts, withKnowFactsAnthropic } from "./know-inject";

const ENV = ["EDEN_HOME", "EDEN_MEMORY_DIR", "EDEN_MEMORY", "EDEN_SLEEP_EVERY", "EDEN_SLEEP_IDLE", "EDEN_KNOW"];
let saved: Record<string, string | undefined> = {};
let home = "";
let mem: edenMem.AgentMemory;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), "eden-cache-placement-"));
  Object.assign(process.env, {
    EDEN_HOME: home,
    EDEN_MEMORY_DIR: join(home, "memory"),
    EDEN_MEMORY: "on",
    EDEN_SLEEP_EVERY: "0",
    EDEN_SLEEP_IDLE: "0",
    EDEN_KNOW: "0",
  });
  mem = edenMem.openMemory({ dir: join(home, "store") });
  mem.observe(SEED.map((content) => ({ role: "user", content })));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Runs `fn` with the wrap's process memory pinned to this test's store. */
function viaWrap<T>(fn: () => T): T {
  const proc = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
  try {
    return fn();
  } finally {
    proc.mockRestore();
  }
}

const anthropic = (body: Body) => viaWrap(() => withKnowFactsAnthropic(body) as Body);
const openai = (body: Body) => viaWrap(() => withKnowFacts(body) as Body);
const library = (body: Body) => ({ ...body, messages: mem.inject(body.messages) as Body["messages"] });

describe("P0.7 cache-safe placement (D29)", () => {
  for (const [name, send, style] of [
    ["the Anthropic wrap", anthropic, "anthropic"],
    ["the OpenAI wrap", openai, "openai"],
    ["AgentMemory.inject", library, "openai"],
  ] as const)
    test(`${name}: every request keeps the previous request's prefix, and every turn gets its fact`, () => {
      const result = measure(send, style, MEMORY_PACKET_MARKS);
      expect(result.pairs).toBe(11);
      expect(result.break_at).toEqual([]);
      expect(result.prefix_breaks).toBe(0);
      expect(result.need_hits).toBe(4);
    });

  test("the packet ends the turn's human message, the same at each step; system is untouched", () => {
    let opening: unknown;
    let turn = -1;
    for (const { turn: at, messages } of requests("anthropic")) {
      const human = messages.findLastIndex((m) => typeof m.content === "string");
      const sent = anthropic({ system: "You are a coding agent.", messages: structuredClone(messages) });
      expect(sent.system).toBe("You are a coding agent.");
      // One packet per turn so far, each on its own turn's human message.
      expect(packetsOf(sent, MEMORY_PACKET_MARKS)).toHaveLength(at + 1);
      const carried = sent.messages[human]!;
      if (at === turn) {
        expect(carried).toEqual(opening as Record<string, unknown>);
        continue;
      }
      opening = carried;
      turn = at;
      const typed = messages[human]!.content as string;
      const text = carried.content as string;
      expect(text.startsWith(`${typed}\n\n`)).toBe(true);
      expect(MEMORY_PACKET_MARKS.some((mark) => text.slice(typed.length + 2).startsWith(mark))).toBe(true);
    }
  });

  test("a tool result message never carries a packet", () => {
    for (const { messages } of requests("anthropic")) {
      const sent = anthropic({ messages: structuredClone(messages) });
      for (const message of sent.messages) {
        const blocks = Array.isArray(message.content) ? (message.content as { type?: string }[]) : [];
        if (blocks.some((b) => b.type === "tool_result"))
          expect(packetsOf({ messages: [message] }, MEMORY_PACKET_MARKS)).toEqual([]);
      }
    }
  });

  test("a client that keeps what inject returns gets one packet per turn, not a second one", () => {
    let history: Record<string, unknown>[] = [];
    for (const [i, content] of ["Fix the login page auth check.", "Now add a database index."].entries()) {
      history = mem.inject([...history, { role: "user", content }]) as Record<string, unknown>[];
      history = mem.inject(history) as Record<string, unknown>[];
      history.push({ role: "assistant", content: `Done ${i}.` });
    }
    const humans = history.filter((m) => m.role === "user");
    for (const message of humans)
      expect(packetsOf({ messages: [message] }, MEMORY_PACKET_MARKS).length).toBeLessThanOrEqual(1);
    expect(packetsOf({ messages: humans }, MEMORY_PACKET_MARKS).join("\n")).toMatch(/Clerk|Postgres/);
  });
});
