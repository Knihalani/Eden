import { describe, expect, test } from "bun:test";
import { respondToHook, applyFlushTruncate, hookTraceBody } from "./hook";
import { handleHookd, hookdTimeoutMs } from "./hookd";
import { handleMcp, McpAuthError } from "./mcp";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

describe("hook", () => {
  test("hook flush payload does not invent llmCalls from the event count", () => {
    const body = hookTraceBody([
      { name: "lookupTicket", args: { id: "T-100" }, ok: true, result: { id: "T-100" }, ts: 1 },
      { name: "notify", args: { id: "T-100" }, ok: true, result: { sent: true }, ts: 4 },
    ]);
    expect(body.llmCalls).toBe(0);
    expect(body.cost_cents).toBe(0);
    expect(body.output).toEqual({ sent: true });
  });

  test("PostToolUse records without throwing", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    const out = await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "lookupTicket",
      tool_input: { id: "T-100", api_key: "sk-secret" },
      tool_response: { ok: true },
    });
    expect(out.ok).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("session of 8 PostToolUse events flushes one stretch", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook3");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    for (let i = 0; i < 8; i++) {
      await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: "agg",
        tool_name: i === 7 ? "notify" : `step${i}`,
        tool_input: { id: "T-100" },
        tool_response: { ok: true },
      });
    }
    const raw = readFileSync(join(home, "runs", "agg.jsonl"), "utf8");
    expect(raw.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(8);
    rmSync(home, { recursive: true, force: true });
  });

  test("PostToolUse advances the flushed-cursor sidecar once per event", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-cursor");
    // A previous failed run leaves its temp home behind; counts would then
    // start from stale state instead of zero.
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    for (let i = 0; i < 3; i++) {
      await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: "cur",
        tool_name: `step${i}`,
        tool_input: {},
        tool_response: { ok: true },
      });
    }
    const cursorPath = join(home, "runs", "cur.jsonl.cursor.json");
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { lines: number };
    const actual = readFileSync(join(home, "runs", "cur.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(cursor.lines).toBe(actual);
    // The hot path must not have needed the session log: with a valid cursor
    // it only ever appends to it and rewrites the sidecar.

    // A lost (or corrupt) cursor is rebuilt from the real log, not restarted
    // at zero — otherwise stretch-end flushing would go quiet until two more
    // events happened by.
    rmSync(cursorPath);
    await respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "cur",
      tool_name: "step3",
      tool_input: {},
      tool_response: { ok: true },
    });
    const rebuilt = JSON.parse(readFileSync(cursorPath, "utf8")) as { lines: number };
    const afterRebuild = readFileSync(join(home, "runs", "cur.jsonl"), "utf8").split("\n").filter(Boolean).length;
    expect(rebuilt.lines).toBe(afterRebuild);
    expect(rebuilt.lines).toBe(4);

    // Truncation re-anchors the cursor: applyFlushTruncate drops two confirmed
    // ids and the sidecar follows the file down.
    const path = join(home, "runs", "cur.jsonl");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const ids = lines.slice(0, 2).map((l) => String((JSON.parse(l) as { id?: string }).id));
    applyFlushTruncate(path, ids);
    const truncated = JSON.parse(readFileSync(cursorPath, "utf8")) as { lines: number };
    expect(truncated.lines).toBe(readFileSync(path, "utf8").split("\n").filter(Boolean).length);
    expect(truncated.lines).toBe(2);
    rmSync(home, { recursive: true, force: true });
  });

  test("flush truncate keeps events that arrived after the snapshot", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-flush");
    mkdirSync(join(home, "runs"), { recursive: true });
    const path = join(home, "runs", "s.jsonl");
    writeFileSync(path, `${JSON.stringify({ id: "a", name: "a" })}\n${JSON.stringify({ id: "b", name: "b" })}\n${JSON.stringify({ id: "c", name: "c" })}\n`);
    applyFlushTruncate(path, ["a", "b"]);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).name).toBe("c");
    applyFlushTruncate(path, ["c"]);
    expect(readFileSync(path, "utf8")).toBe("");
    rmSync(home, { recursive: true, force: true });
  });

  test("PreToolUse steers toward compiled MCP tool only when opted in", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook2");
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"] }]));
    // Default is observe: a matching call is allowed through untouched.
    delete process.env.EDEN_STEER_HOOKS;
    const observe = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-100" } });
    expect((observe as { ok?: boolean }).ok).toBe(true);
    // Opt-in via env steers (denies the raw call in favour of the MCP tool).
    process.env.EDEN_STEER_HOOKS = "1";
    try {
      const out = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-100" } });
      expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
      writeFileSync(
        join(home, "live-tools.json"),
        JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"], envelope: { inputs: { id: ["T-100", "T-101", "T-102"] } } }]),
      );
      const ood = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-999" } });
      expect((ood as { ok?: boolean }).ok).toBe(true);
      const self = await respondToHook({ hook_event_name: "PreToolUse", tool_name: "resolve_ticket", tool_input: { id: "T-100" } });
      expect((self as { ok?: boolean }).ok).toBe(true);
    } finally {
      delete process.env.EDEN_STEER_HOOKS;
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("Stop writes stretch_end to outbox", async () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-stop");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    await respondToHook({ hook_event_name: "Stop", session_id: "s-stop" });
    const box = readFileSync(join(home, "outbox.jsonl"), "utf8");
    expect(box).toContain("stretch_end");
    expect(box).toContain("s-stop");
    rmSync(home, { recursive: true, force: true });
  });

  test("hookd health is json and timeout defaults to 8s", async () => {
    delete process.env.EDEN_HOOKD_TIMEOUT_MS;
    expect(hookdTimeoutMs()).toBe(8000);
    const r = await handleHookd(new Request("http://x/health"));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; service: string };
    expect(j.ok).toBe(true);
    expect(j.service).toBe("eden-hookd");
  });
});

describe("mcp", () => {
  test("initialize returns server info", async () => {
    let sent: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [],
        send: (_id, result) => {
          sent = result;
        },
      },
    );
    expect((sent as { serverInfo: { name: string } }).serverInfo.name).toBe("eden");
  });

  test("ping returns an empty result", async () => {
    let sent: unknown = "unset";
    await handleMcp(
      { jsonrpc: "2.0", id: 3, method: "ping" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [],
        send: (_id, result) => {
          sent = result;
        },
      },
    );
    expect(sent).toEqual({});
  });

  test("resources/list and prompts/list are empty catalogs", async () => {
    const seen: Record<string, unknown> = {};
    for (const method of ["resources/list", "prompts/list"]) {
      await handleMcp(
        { jsonrpc: "2.0", id: method, method },
        {
          base: "http://x",
          key: "k",
          programs: async () => [],
          send: (_id, result) => {
            seen[method] = result;
          },
        },
      );
    }
    expect(seen["resources/list"]).toEqual({ resources: [] });
    expect(seen["prompts/list"]).toEqual({ prompts: [] });
  });

  test("resources/list and resources/read expose live programs", async () => {
    const program = {
      id: "p_abc",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 5, allowExact: false },
      manifest: null,
    };
    let listed: unknown;
    let read: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: "list", method: "resources/list" },
      {
        base: "http://x",
        key: "k",
        programs: async () => [program],
        send: (_id, result) => {
          listed = result;
        },
      },
    );
    await handleMcp(
      { jsonrpc: "2.0", id: "read", method: "resources/read", params: { uri: "eden://program/p_abc" } },
      {
        base: "http://x",
        key: "k",
        programs: async () => [program],
        send: (_id, result) => {
          read = result;
        },
      },
    );
    expect(listed).toEqual({
      resources: [
        {
          uri: "eden://program/p_abc",
          name: "ticket_stretch",
          mimeType: "application/json",
          description: "compiled stretch",
        },
      ],
    });
    expect((read as { contents: Array<{ text: string }> }).contents[0]!.text).toContain("ticket_stretch");
  });

  test("tools/list 401 is a JSON-RPC error not an empty catalog", async () => {
    let err: { code?: number; message?: string } | undefined;
    let result: unknown;
    await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        base: "http://x",
        key: "k",
        programs: async () => {
          throw new McpAuthError();
        },
        send: (_id, r) => {
          result = r;
        },
        error: (_id, code, message) => {
          err = { code, message };
        },
      },
    );
    expect(result).toBeUndefined();
    expect(err).toEqual({ code: -32001, message: "unauthorized" });
  });

  test("tools/call surfaces wrap-run deopt reason", async () => {
    const program = {
      id: "p_live",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
    const prev = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: "deopt", reason: "island draft needs an island caller" }), {
          status: 409,
        }),
      { preconnect: prev.preconnect },
    );
    let sent: { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    try {
      await handleMcp(
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ticket_stretch", arguments: { id: "T-100" } } },
        {
          base: "http://127.0.0.1:8788",
          key: "k",
          programs: async () => [program],
          send: (_id, result) => {
            sent = result as typeof sent;
          },
        },
      );
    } finally {
      globalThis.fetch = prev;
    }
    expect(sent?.isError).toBe(true);
    expect(sent?.content?.[0]?.text).toContain("island caller");
  });

  test("a stalled wrap endpoint answers with an error instead of wedging the chain", async () => {
    // The wrap-run fetch used to carry no AbortSignal, so an endpoint that
    // accepted the connection and never answered parked the serialized stdio
    // chain — every later request waited forever behind it. With a tiny
    // EDEN_TIMEOUT_MS the abort must surface as the normal isError reply,
    // well before the default horizon.
    const prevTimeout = process.env.EDEN_TIMEOUT_MS;
    const prev = globalThis.fetch;
    process.env.EDEN_TIMEOUT_MS = "50";
    globalThis.fetch = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }) as never,
      { preconnect: prev.preconnect },
    );
    const program = {
      id: "p_stall",
      version: "v",
      name: "ticket_stretch",
      description: "compiled stretch",
      inputSchema: { type: "object" },
      steps: [],
      returns: { kind: "literal" as const, value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
      manifest: null,
    };
    let sent: { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
    try {
      // Bound is EDEN_TIMEOUT_MS=50 on a real AbortSignal — assert the error
      // path, not a wall-clock delta (flake-audit may skew Date.now).
      await handleMcp(
        { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "ticket_stretch", arguments: { id: "T-100" } } },
        {
          base: "http://127.0.0.1:8788",
          key: "k",
          programs: async () => [program],
          send: (_id, result) => {
            sent = result as typeof sent;
          },
        },
      );
    } finally {
      globalThis.fetch = prev;
      if (prevTimeout === undefined) delete process.env.EDEN_TIMEOUT_MS;
      else process.env.EDEN_TIMEOUT_MS = prevTimeout;
    }
    expect(sent?.isError).toBe(true);
    expect(sent?.content?.[0]?.text).toBeTruthy();
  });
});
