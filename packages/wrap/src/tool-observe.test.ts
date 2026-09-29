import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openMemory } from "../../../src/index";
import { loadToolTraces, tracesPath } from "../../../src/tool-trace";
import { withKnowFactsAnthropic } from "./know-inject";
import {
  injectBodyThenObserveTools,
  observeToolTraces,
  toolTraceMessages,
  TOOL_TRACE_MAX,
} from "./tool-observe";

function tmpMem() {
  const dir = mkdtempSync(join(tmpdir(), "eden-tool-obs-"));
  return { dir, mem: openMemory({ dir }), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function stored(dir: string, mem: { memories(): { text: string }[] }): string {
  const live = mem.memories().map((m) => m.text).join("\n");
  let file = "";
  try {
    file = readFileSync(join(dir, "memories.jsonl"), "utf8");
  } catch {
    /* empty store */
  }
  return `${live}\n${file}`;
}

const FAIL = "FAIL src/auth.test.ts\nexit 1\nflake";

describe("toolTraceMessages", () => {
  test("OpenAI tool_calls + role:tool include tool name and truncated result", () => {
    const traces = toolTraceMessages([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_bash",
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify({ command: "bun test src/auth.test.ts" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_bash", content: FAIL },
    ]);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.content).toContain("Bash");
    expect(traces[0]!.content).toContain("FAIL src/auth.test.ts");
    expect(traces[0]!.content).toContain("exit 1");
  });

  test("Anthropic tool_use + tool_result content blocks store the same shape", () => {
    const traces = toolTraceMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "bun test" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: FAIL, is_error: true }],
      },
    ]);
    expect(traces[0]!.content).toContain("Bash");
    expect(traces[0]!.content).toContain("FAIL src/auth.test.ts");
  });

  test("redacts secrets and truncates huge payloads", () => {
    const huge = `${FAIL}\n${"x".repeat(20_000)}\nsk-abc123XYZ999\nghp_abc123XYZ999abcdefghij`;
    const traces = toolTraceMessages([
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: huge },
    ]);
    const text = traces[0]!.content;
    expect(text.length).toBeLessThanOrEqual(420);
    expect(text).not.toContain("sk-abc123XYZ999");
    expect(text).not.toContain("ghp_abc123XYZ999");
    expect(text).toContain("Bash");
    expect(text).toContain("FAIL src/auth.test.ts");
    expect(text.length).toBeLessThan(TOOL_TRACE_MAX);
  });

  test("junk input is empty, never throws", () => {
    expect(toolTraceMessages(null)).toEqual([]);
    expect(toolTraceMessages("nope")).toEqual([]);
    expect(toolTraceMessages([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

describe("observeToolTraces", () => {
  test("OpenAI wrap fixture writes an episode with tool name and failure snippet", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [
        { role: "user", content: "run the tests" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: JSON.stringify({ command: "bun test src/auth.test.ts" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: FAIL },
      ]);
      const blob = stored(dir, mem);
      expect(blob).toContain("Bash");
      expect(blob).toMatch(/FAIL src\/auth\.test\.ts/);
      expect(blob).toMatch(/exit 1|flake/);
    } finally {
      done();
    }
  });

  test("FAIL next to a short secret still writes an episode without the token", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: `${FAIL}\nghp_abc123XYZ999\nsk-abc123XYZ999` },
      ]);
      const blob = stored(dir, mem);
      expect(blob).toMatch(/FAIL src\/auth\.test\.ts/);
      expect(blob).toContain("Bash");
      expect(blob).not.toMatch(/\bghp_/);
      expect(blob).not.toMatch(/\bsk-/);
    } finally {
      done();
    }
  });

  test("Anthropic-shaped tool_use + tool_result also store", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "bun test" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              is_error: true,
              content: [{ type: "text", text: FAIL }],
            },
          ],
        },
      ]);
      const blob = stored(dir, mem);
      expect(blob).toContain("Bash");
      expect(blob).toMatch(/FAIL src\/auth\.test\.ts/);
    } finally {
      done();
    }
  });

  test("pytest fixture persists files, exit 0, and command beside prose", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_py",
              type: "function",
              function: { name: "Bash", arguments: JSON.stringify({ command: "pytest tests/auth/session.test.ts -q" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_py", content: "passed auth.ts\nexit 0" },
      ]);
      const blob = stored(dir, mem);
      expect(blob).toContain("Bash");
      expect(blob).toContain("exit 0");
      const traces = loadToolTraces(dir);
      expect(traces).toHaveLength(1);
      expect(traces[0]!.files).toContain("auth.ts");
      expect(traces[0]!.exit).toBe(0);
      expect(String(traces[0]!.args.command)).toContain("pytest");
      expect(traces[0]!.order).toBe(0);
    } finally {
      done();
    }
  });

  test("Anthropic tool_use pytest fixture reconstructs files/exit/command", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_py", name: "Bash", input: { command: "pytest tests/auth/session.test.ts -q" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_py", content: "passed auth.ts\nexit 0" }],
        },
      ]);
      const traces = loadToolTraces(dir);
      expect(traces).toHaveLength(1);
      expect(traces[0]!.files).toContain("auth.ts");
      expect(traces[0]!.exit).toBe(0);
      expect(String(traces[0]!.args.command)).toContain("pytest");
      expect(stored(dir, mem)).toContain("Bash");
    } finally {
      done();
    }
  });

  test("chat-only messages write nothing to traces.jsonl", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [{ role: "user", content: "hi" }]);
      expect(existsSync(tracesPath(dir))).toBe(false);
      expect(loadToolTraces(dir)).toEqual([]);
    } finally {
      done();
    }
  });

  test("order is preserved across tools in one window and continues on append", () => {
    const { dir, mem, done } = tmpMem();
    try {
      observeToolTraces(mem, [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c1",
              function: { name: "Read", arguments: JSON.stringify({ file: "src/auth.ts" }) },
            },
            {
              id: "c2",
              function: { name: "Bash", arguments: JSON.stringify({ command: "pytest tests/auth/session.test.ts -q" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "tool", tool_call_id: "c2", content: "auth.ts covered\nexit 0" },
      ]);
      const first = loadToolTraces(dir);
      expect(first.map((r) => r.name)).toEqual(["Read", "Bash"]);
      expect(first.map((r) => r.order)).toEqual([0, 1]);
      expect(first[1]!.files).toContain("auth.ts");
      expect(first[1]!.exit).toBe(0);

      observeToolTraces(mem, [
        {
          role: "assistant",
          tool_calls: [{ id: "c3", function: { name: "Bash", arguments: JSON.stringify({ command: "ls" }) } }],
        },
        { role: "tool", tool_call_id: "c3", content: "ok\nexit 0" },
      ]);
      const all = loadToolTraces(dir);
      expect(all.map((r) => r.order)).toEqual([0, 1, 2]);
      expect(all[2]!.name).toBe("Bash");
    } finally {
      done();
    }
  });

  test("fail-open: observe throw does not escape", () => {
    expect(() =>
      observeToolTraces(
        {
          observe() {
            throw new Error("boom");
          },
        },
        [
          {
            role: "assistant",
            tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "c1", content: FAIL },
        ],
      ),
    ).not.toThrow();
  });
});

describe("injectBodyThenObserveTools", () => {
  test("encodes tools without injecting this-turn notes", () => {
    const { dir, mem, done } = tmpMem();
    try {
      const body = {
        messages: [
          { role: "user", content: "Please refactor the auth middleware and add a log line." },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "Bash", arguments: JSON.stringify({ command: "bun test" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: FAIL },
        ],
      };
      const out = injectBodyThenObserveTools(mem, body);
      const msgs = out.messages as Array<{ role?: string; content?: string }>;
      expect(msgs.every((m) => m.role !== "system")).toBe(true);
      const blob = stored(dir, mem);
      expect(blob).toContain("Bash");
      expect(blob).toMatch(/FAIL src\/auth\.test\.ts/);
    } finally {
      done();
    }
  });

  test("injectBody throw returns original body (fail-open)", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: FAIL },
      ],
    };
    const out = injectBodyThenObserveTools(
      {
        injectBody() {
          throw new Error("inject boom");
        },
        observe() {
          throw new Error("observe boom");
        },
      },
      body,
    );
    expect(out).toBe(body);
    expect(out.messages).toEqual(body.messages);
  });

  test("EDEN_MEMORY_INJECT_LOG is measure-only: packet still returned; write throw fail-open", () => {
    const { dir, mem, done } = tmpMem();
    const log = join(dir, "inject.jsonl");
    const prev = process.env.EDEN_MEMORY_INJECT_LOG;
    try {
      process.env.EDEN_MEMORY_INJECT_LOG = log;
      mem.observe([{ role: "user", content: "Postgres is the session store." }]);
      const body = { messages: [{ role: "user", content: "What store is postgres?" }] };
      const out = injectBodyThenObserveTools(mem, structuredClone(body));
      expect(JSON.stringify(out)).toMatch(/Eden Memory:/);
      expect(JSON.stringify(out)).toMatch(/postgres/i);
      expect(existsSync(log)).toBe(true);
      const row = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
      expect(row.empty).toBe(false);
      expect(typeof row.t).toBe("number");

      process.env.EDEN_MEMORY_INJECT_LOG = join(dir, "no-such", "\0", "inject.jsonl");
      expect(() => injectBodyThenObserveTools(mem, structuredClone(body))).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.EDEN_MEMORY_INJECT_LOG;
      else process.env.EDEN_MEMORY_INJECT_LOG = prev;
      done();
    }
  });
});

describe("withKnowFactsAnthropic tool encode", () => {
  test("tool-trace observe is after notesFor so synthetic Tool lines are not this-turn notes", () => {
    const out = withKnowFactsAnthropic({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "bun test" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: FAIL, is_error: true },
            { type: "text", text: "Please refactor the auth middleware and add a log line." },
          ],
        },
      ],
    });
    expect(JSON.stringify(out.system ?? "")).not.toContain("Tool Bash result is");
  });
});
