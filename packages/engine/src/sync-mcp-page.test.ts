import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type Scope } from "@eden/protocol";
import { McpSource, type McpSourceOptions } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 3, 9);
const scope: Scope = { tenantId: "t1", userId: "u1" };

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

/**
 * A mail connector spoken to over MCP's JSON-RPC, in process: a read-only `list_mail` that takes only a page token
 * (no page-size argument) and returns the server's own page of 4 rows, newest first. The engine package does not
 * depend on the MCP SDK's server side, so the server is this small fake transport; `McpSource` is the real one.
 */
function mailConnector(rows: { id: string; subject: string; body: string }[]) {
  const listCalls: Record<string, unknown>[] = [];
  const tools = [
    {
      name: "search_mail",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true },
    },
    {
      name: "list_mail",
      inputSchema: { type: "object", properties: { pageToken: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
  ];
  const answer = (m: Message): unknown => {
    if (m.method === "initialize") {
      return {
        protocolVersion: m.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mail", version: "1" },
      };
    }
    if (m.method === "tools/list") return { tools };
    if (m.method === "tools/call") {
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      if (m.params?.name === "search_mail") return { content: [{ type: "text", text: "[]" }] };
      listCalls.push(args);
      const at = typeof args.pageToken === "string" ? Number(args.pageToken.slice(1)) : 0;
      const next = at + 4 < rows.length ? `p${at + 4}` : undefined;
      const body = { messages: rows.slice(at, at + 4), ...(next ? { nextPageToken: next } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    }
    return {};
  };
  const transport = () => {
    const t = {
      onmessage: undefined as ((m: unknown) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((e: Error) => void) | undefined,
      async start() {},
      async close() {
        t.onclose?.();
      },
      async send(raw: unknown) {
        const m = raw as Message;
        if (m.id === undefined) return; // a notification
        const result = answer(m);
        queueMicrotask(() => t.onmessage?.({ jsonrpc: "2.0", id: m.id, result }));
      },
    };
    return t as unknown as ReturnType<McpSourceOptions["transport"]>;
  };
  const source = new McpSource({
    id: "mail",
    description: "the user's mail",
    transport,
    searchTool: { name: "search_mail" },
    listTool: { name: "list_mail" },
  });
  return { source, listCalls };
}

const mail = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, subject: `Mail ${prefix}${i}`, body: `note ${i}` }));

describe("sync over a token-paged MCP list tool with no page-size argument", () => {
  // Small pages (a page size of 2, or polls sized to what changed) are smaller than the server's own page of 4: rows
  // cut from a page used to be skipped by the server's cursor, and the poll marked the source current without them.
  for (const config of [{ syncPageSize: 2 }, { syncPageSize: 100, syncPollPageSize: 2 }]) {
    test(`a poll stores every new item (${JSON.stringify(config)})`, async () => {
      const rows = mail("old", 6);
      const { source, listCalls } = mailConnector(rows);
      let clock = T0;
      const cache = new ItemCache();
      const partner = new ContextPartner({
        sources: async () => [source],
        sourceMap: new SourceMap(":memory:", { seed: 1 }),
        cache,
        budget: new Budget(),
        model: null,
        now: () => clock,
        config: { sync: true, syncCallsPerMin: 600, syncMaxStaleMs: 4 * HOUR, ...config },
      });
      partner.sync!.track(scope);
      for (let i = 0; i < 20 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
      expect(partner.sync!.warm(scope)).toBe(true);
      for (const r of rows) expect(cache.isSynced(scope, itemId("mail", r.id))).toBe(true);

      rows.unshift(...mail("new", 6));
      clock += 5 * HOUR;
      const calls = listCalls.length;
      const event = {
        ...scope,
        sessionId: "s1",
        at: clock,
        kind: "user_message",
        text: "Any new mail about the plan?",
      };
      await partner.observe(event as AgentEvent, { waitMs: 2_000 });
      // A poll cut short by its page cap goes on in the background.
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
      expect(listCalls.length).toBeGreaterThan(calls);
      const held = mail("new", 6).map((r) => cache.isSynced(scope, itemId("mail", r.id)));
      expect(held).toEqual([true, true, true, true, true, true]);
      expect(partner.sync!.current(scope, "mail")).toBe(true);
      await source.close();
    });
  }
});
