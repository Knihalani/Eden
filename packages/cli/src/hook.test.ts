import { describe, expect, test } from "bun:test";
import { respondToHook, applyFlushTruncate } from "./hook";
import { handleHookd, hookdTimeoutMs } from "./hookd";
import { handleMcp, McpAuthError } from "./mcp";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

describe("hook", () => {
  test("PostToolUse records without throwing", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    const out = respondToHook({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "lookupTicket",
      tool_input: { id: "T-100", api_key: "sk-secret" },
      tool_response: { ok: true },
    });
    expect(out.ok).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("session of 8 PostToolUse events flushes one stretch", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook3");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:9" }));
    for (let i = 0; i < 8; i++) {
      respondToHook({
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

  test("PreToolUse steers toward compiled MCP tool when live", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook2");
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    writeFileSync(join(home, "live-tools.json"), JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"] }]));
    const out = respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-100" } });
    expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
    writeFileSync(
      join(home, "live-tools.json"),
      JSON.stringify([{ name: "resolve_ticket", sequence: ["lookupTicket"], envelope: { inputs: { id: ["T-100", "T-101", "T-102"] } } }]),
    );
    const ood = respondToHook({ hook_event_name: "PreToolUse", tool_name: "lookupTicket", tool_input: { id: "T-999" } });
    expect((ood as { ok?: boolean }).ok).toBe(true);
    const self = respondToHook({ hook_event_name: "PreToolUse", tool_name: "resolve_ticket", tool_input: { id: "T-100" } });
    expect((self as { ok?: boolean }).ok).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("Stop writes stretch_end to outbox", () => {
    const home = join(import.meta.dir, "../../.tmp-eden-hook-stop");
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    respondToHook({ hook_event_name: "Stop", session_id: "s-stop" });
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
});
