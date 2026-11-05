import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_LIST_PAGE, McpSource, type McpSourceOptions } from "./mcp-source";

const scope = { tenantId: "t", userId: "u" };

/**
 * A list server over `n` rows, newest first. `paging` picks its cursor argument; `max` is the `maximum` its schema
 * declares on the page size (none when undefined); `cap` is what it really returns at most per page, silently.
 */
function server(o: { n: number; paging: "offset" | "token"; max?: number; cap?: number }) {
  const s = new McpServer({ name: "rows", version: "1" });
  const calls: Record<string, unknown>[] = [];
  const rows = Array.from({ length: o.n }, (_, i) => ({ id: `r${i}`, title: `Row ${i}`, text: `row ${i}` }));
  s.registerTool(
    "search_rows",
    { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  const limit = o.max === undefined ? z.number().optional() : z.number().max(o.max).optional();
  const input: z.ZodRawShape =
    o.paging === "offset" ? { offset: z.number().optional(), limit } : { cursor: z.string().optional(), limit };
  s.registerTool("list_rows", { inputSchema: input, annotations: { readOnlyHint: true } }, async (args) => {
    const a = args as Record<string, unknown>;
    calls.push(a);
    const asked = Number(a.limit ?? 50);
    const size = Math.min(asked, o.cap ?? Infinity);
    const at = o.paging === "offset" ? Number(a.offset ?? 0) : a.cursor ? Number(String(a.cursor).slice(1)) : 0;
    const page = rows.slice(at, at + size);
    const next = o.paging === "token" && at + size < rows.length ? `c${at + size}` : undefined;
    return { content: [{ type: "text", text: JSON.stringify({ rows: page, ...(next ? { nextCursor: next } : {}) }) }] };
  });
  return { server: s, calls };
}

function source(srv: McpServer, extra: Partial<McpSourceOptions> = {}) {
  return new McpSource({
    id: "rows",
    description: "rows",
    transport: () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      void srv.connect(serverSide);
      return client;
    },
    searchTool: { name: "search_rows" },
    listTool: { name: "list_rows" },
    ...extra,
  });
}

/** Lists the whole source from the start as a sweep does: until `next` is null or a page is empty. */
async function listAll(s: McpSource, limit: number) {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await s.list!(scope, cursor, limit, AbortSignal.timeout(2_000));
    ids.push(...page.items.map((it) => it.ref));
    if (page.next === null || page.items.length === 0) break;
    cursor = page.next;
  }
  return ids;
}

describe("McpSource.listPageMax (big sync pages, D142)", () => {
  test("a schema `maximum: 500` on the page size sets listPageMax 500, read at connect", async () => {
    const { server: srv } = server({ n: 3, paging: "offset", max: 500 });
    const s = source(srv);
    expect(s.listPageMax).toBeUndefined(); // Not connected: the schema is not read yet.
    await s.list!(scope, undefined, DEFAULT_LIST_PAGE, AbortSignal.timeout(2_000));
    expect(s.listPageMax).toBe(500);
    await s.close();
  });

  test("no declared maximum: undefined unless the operator says; with both, the smaller", async () => {
    for (const paging of ["offset", "token"] as const) {
      const none = source(server({ n: 3, paging }).server);
      await none.list!(scope, undefined, 100, AbortSignal.timeout(2_000));
      expect(none.listPageMax).toBeUndefined();
      await none.close();
      const operator = source(server({ n: 3, paging }).server, { listPageMax: 400 });
      expect(operator.listPageMax).toBe(400);
      await operator.close();
    }
    const both = source(server({ n: 3, paging: "offset", max: 200 }).server, { listPageMax: 400 });
    await both.list!(scope, undefined, 100, AbortSignal.timeout(2_000));
    expect(both.listPageMax).toBe(200);
    await both.close();
    // Past `MAX_LIST_ROWS` (1,000) a declared maximum is cut to it; nonsense is ignored.
    const huge = source(server({ n: 3, paging: "offset", max: 100_000 }).server);
    await huge.list!(scope, undefined, 100, AbortSignal.timeout(2_000));
    expect(huge.listPageMax).toBe(1_000);
    await huge.close();
    expect(source(server({ n: 3, paging: "offset" }).server, { listPageMax: 0 }).listPageMax).toBeUndefined();
    expect(source(server({ n: 3, paging: "offset" }).server, { listPageMax: Number.NaN }).listPageMax).toBeUndefined();
  });

  test("operator `args` (token-paged by the server's own cursor): only the operator's listPageMax", async () => {
    const { server: srv } = server({ n: 3, paging: "token", max: 500 });
    const s = source(srv, { listTool: { name: "list_rows", args: (cursor, limit) => ({ cursor, limit }) } });
    await s.list!(scope, undefined, 100, AbortSignal.timeout(2_000));
    expect(s.listPageMax).toBeUndefined();
    await s.close();
  });

  test("no list tool: no listPageMax", () => {
    const s = new McpSource({
      id: "x",
      description: "x",
      transport: () => InMemoryTransport.createLinkedPair()[0],
      searchTool: { name: "search_rows" },
      listPageMax: 500,
    });
    expect(s.listPageMax).toBeUndefined();
  });

  test("an offset server that silently caps at 100, asked 500, still lists all 350 rows (4 pages + 1 empty)", async () => {
    const { server: srv, calls } = server({ n: 350, paging: "offset", max: 500, cap: 100 });
    const s = source(srv);
    const ids = await listAll(s, 500);
    expect(ids.length).toBe(350);
    expect(new Set(ids).size).toBe(350);
    expect(calls).toEqual([
      { limit: 500 },
      { offset: 100, limit: 500 },
      { offset: 200, limit: 500 },
      { offset: 300, limit: 500 },
      { offset: 350, limit: 500 },
    ]);
    await s.close();
  });

  test("an offset server that honours 500 lists 350 rows in one page and one empty page", async () => {
    const { server: srv, calls } = server({ n: 350, paging: "offset", max: 500 });
    const s = source(srv);
    expect((await listAll(s, 500)).length).toBe(350);
    expect(calls).toEqual([{ limit: 500 }, { offset: 350, limit: 500 }]);
    await s.close();
  });

  test("offset at limit 100 makes the same calls as before: a short page ends the listing", async () => {
    const { server: srv, calls } = server({ n: 250, paging: "offset", max: 500 });
    const s = source(srv);
    expect((await listAll(s, 100)).length).toBe(250);
    expect(calls).toEqual([{ limit: 100 }, { offset: 100, limit: 100 }, { offset: 200, limit: 100 }]);
    await s.close();
  });

  test("a token server that caps silently keeps its own cursor: every row, no extra call", async () => {
    const { server: srv, calls } = server({ n: 350, paging: "token", max: 500, cap: 100 });
    const s = source(srv);
    expect((await listAll(s, 500)).length).toBe(350);
    expect(calls.length).toBe(4);
    await s.close();
  });
});
