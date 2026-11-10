import { describe, expect, test } from "bun:test";
import { ContextPartner, CORE_CONFIG, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  buildFetchArgs,
  fetchUsable,
  listUsable,
  mapFetchArgs,
  mapListArgs,
  mapSearchArgs,
  usable,
  type ToolSchema,
} from "../../sources/src/schema-args";
import labTools from "../../sources/src/fixtures/mcp-tools.json";
import { expandPreset, PRESETS } from "./connector-presets";
import google from "./fixtures/google-tools.json";
import { checkSpecs, SourceConfigError, UserSources } from "./user-sources";

// D294: connector presets name a common MCP server's read tools; the read-only check (D7) is untouched.

/** Every schema a preset's tools were checked against: Google's as served (2026-11-07), the lab's captured ones. */
const SCHEMAS: Record<string, ToolSchema> = {
  ...(google as Record<string, ToolSchema>),
  caldav_search_events: (labTools as Record<string, { inputSchema: ToolSchema }>).caldav!.inputSchema,
  search_notes: (labTools as Record<string, { inputSchema: ToolSchema }>).mcpvault!.inputSchema,
};

describe("connector presets (D294)", () => {
  test("every preset's tools map to calls from their real schemas, with its fixed values", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      const at = (tool: string) => {
        const s = SCHEMAS[tool];
        if (!s) throw new Error(`${name}: no schema for ${tool}`);
        return s;
      };
      const m = mapSearchArgs(at(p.searchTool.name), p.searchTool.fixed);
      expect([name, usable(m), m.text?.name]).toEqual([name, true, "query"]);
      if (p.fetchTool)
        expect([name, fetchUsable(mapFetchArgs(at(p.fetchTool.name), p.fetchTool.fixed))]).toEqual([name, true]);
      if (p.listTool)
        expect([name, listUsable(mapListArgs(at(p.listTool.name), p.listTool.fixed))]).toEqual([name, true]);
      // A fixed value must be one the schema allows.
      for (const t of [p.searchTool, p.fetchTool, p.listTool]) {
        for (const [k, v] of Object.entries(t?.fixed ?? {})) {
          const prop = at(t!.name).properties?.[k] as { enum?: unknown[] } | undefined;
          expect([name, k, !!prop]).toEqual([name, k, true]);
          if (prop?.enum) expect(prop.enum).toContain(v);
        }
      }
    }
    expect(mapListArgs(SCHEMAS.search_threads!).cursor).toEqual({ name: "pageToken", kind: "token" });
  });

  test("every preset names a fetch tool or says why not (C1, D415)", () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      // Exactly one: a fetch tool, or the reason there is none (the daily sweep, D356; doubted copies held, D126).
      expect([name, p.fetchTool === undefined, (p.noFetch ?? "").length > 20]).toEqual([name, true, true]);
    }
  });

  test("Google's fetch-by-id tools map from their served schemas, the ref to the id argument (C1)", () => {
    // Not named by a preset (D415), but an operator who has checked both copies match adds one by hand: the connect
    // maps it with this code, and the ref must land on the record's id, never on calendarId.
    const thread = mapFetchArgs(SCHEMAS.get_thread!);
    expect([fetchUsable(thread), buildFetchArgs(thread, "t1")]).toEqual([true, { threadId: "t1" }]);
    const event = mapFetchArgs(SCHEMAS.get_event!);
    expect([fetchUsable(event), buildFetchArgs(event, "e1")]).toEqual([true, { eventId: "e1" }]);
  });

  test("expansion: explicit fields win, no write tool and no trustedReadTools are ever added", () => {
    const [spec] = checkSpecs([{ kind: "mcp", preset: "gmail", id: "mail", url: "https://mail.example/mcp" }], "t");
    expect(spec).toMatchObject({
      kind: "mcp",
      id: "mail",
      description: PRESETS.gmail!.description,
      searchTool: { name: "search_threads" },
      listTool: { name: "search_threads" },
    });
    expect("preset" in spec!).toBe(false);
    // No fetch for Gmail: a full thread would differ from the newest-message copy and read as a change.
    expect("fetchTool" in spec!).toBe(false);
    expect("trustedReadTools" in spec!).toBe(false);
    const own = expandPreset({ preset: "gmail", id: "m", description: "work mail", url: "https://x", notifies: true });
    expect([own.description, own.notifies]).toEqual(["work mail", true]);
    const tools = Object.values(PRESETS).flatMap((p) => [p.searchTool, p.fetchTool, p.listTool].filter(Boolean));
    for (const t of tools) expect(t!.name).not.toMatch(/send|create|delete|update|trash|draft|label|respond|forward/);
    // The operator still lists an unannotated tool by hand; the preset only says which.
    expect(expandPreset({ preset: "caldav", id: "c", url: "https://x" }).trustedReadTools).toBeUndefined();
  });

  test("an unknown preset, or one on a static entry, is a config error naming the entry", () => {
    expect(() => checkSpecs([{ preset: "hubspot", id: "crm", url: "https://x" }], "u1")).toThrow(
      /u1\[0\]: unknown preset "hubspot" \(presets: gmail, google-calendar, caldav, obsidian\)/,
    );
    expect(() => checkSpecs([{ kind: "static", preset: "gmail", id: "m", url: "https://x" }], "u1")).toThrow(
      SourceConfigError,
    );
    expect(() => checkSpecs([{ preset: "toString", id: "m", url: "https://x" }], "u1")).toThrow(/unknown preset/);
  });

  // A Gmail-shaped server with its real read schemas and two write tools: the preset reads through the first and
  // never touches the second; a server that drops the read-only annotation fails the connect (D7).
  function gmailServer(readOnly = true) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const transport = () => {
      const server = new Server({ name: "gmail", version: "1" }, { capabilities: { tools: {} } });
      const read = (name: string) => ({
        name,
        inputSchema: SCHEMAS[name] as { type: "object" },
        annotations: { readOnlyHint: readOnly },
      });
      const write = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: {} });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [read("search_threads"), read("get_thread"), write("send_message"), write("trash_thread")],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name: req.params.name, args });
        const thread = (id: string) => ({ id, messages: [{ subject: "heads up", snippet: `thread ${id}` }] });
        const body =
          req.params.name === "get_thread"
            ? thread(String(args.threadId))
            : args.pageToken
              ? { threads: [thread("t3")] }
              : { threads: [thread("t1"), thread("t2")], nextPageToken: "p2" };
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      });
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return client;
    };
    return { calls, transport };
  }

  test("end to end through UserSources: search and the sync's listing call only the preset's read tools", async () => {
    const g = gmailServer();
    const users = new UserSources({
      directory: () => [{ kind: "mcp", preset: "gmail", id: "mail", transport: g.transport }],
      log: () => {},
    });
    const scope = { tenantId: "t", userId: "u" };
    const [src] = await users.resolver(scope);
    const signal = AbortSignal.timeout(2_000);
    const found = await src!.search({ scope, text: "invoice bank details", entities: [], limit: 5 }, signal);
    expect(found.map((i) => i.ref)).toEqual(["t1", "t2"]);
    expect(src!.fetch ? await src!.fetch("t1", scope, signal) : null).toBeNull();
    const page = await src!.list!(scope, undefined, 50, signal);
    expect(page.next).toBe("p2");
    expect((await src!.list!(scope, "p2", 50, signal)).items.map((i) => i.ref)).toEqual(["t3"]);
    expect(g.calls.map((c) => c.name)).toEqual(["search_threads", "search_threads", "search_threads"]);
    expect(g.calls[0]!.args).toMatchObject({ query: expect.any(String), view: "THREAD_VIEW_SUMMARY" });
    expect(g.calls[2]!.args).toMatchObject({ pageToken: "p2", view: "THREAD_VIEW_SUMMARY" });
    await users.close();
  });

  test("the read-only check still runs: a server that does not annotate its tools read-only is refused", async () => {
    const g = gmailServer(false);
    const users = new UserSources({
      directory: () => [{ kind: "mcp", preset: "gmail", id: "mail", transport: g.transport }],
      log: () => {},
    });
    const scope = { tenantId: "t", userId: "u" };
    const [src] = await users.resolver(scope);
    await expect(src!.search({ scope, text: "x", entities: [], limit: 5 }, AbortSignal.timeout(2_000))).rejects.toThrow(
      /search_threads/,
    );
    expect(g.calls).toEqual([]);
    await users.close();
  });

  test("a preset with a fetch tool reads by id and goes on the weekly sweep; without one it stays daily (D356)", async () => {
    const MIN = 60_000;
    const DAY = 24 * 60 * MIN;
    const plain = gmailServer();
    const fetching = gmailServer();
    const users = new UserSources({
      directory: () => [
        { kind: "mcp", preset: "gmail", id: "mail", transport: plain.transport },
        // The operator's own fetch tool over the preset (explicit fields win): the mechanism, not a recommendation.
        { kind: "mcp", preset: "gmail", id: "mail2", transport: fetching.transport, fetchTool: { name: "get_thread" } },
      ],
      log: () => {},
    });
    const scope = { tenantId: "t", userId: "u" };
    const byId = Object.fromEntries((await users.resolver(scope)).map((s) => [s.id, s]));
    expect([byId.mail!.fetchesById, byId.mail2!.fetchesById]).toEqual([false, true]);
    expect((await byId.mail2!.fetch!("t1", scope, AbortSignal.timeout(2_000)))?.ref).toBe("t1");

    let clock = Date.UTC(2026, 10, 10, 9);
    const partner = new ContextPartner({
      sources: (s) => users.resolver(s),
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => clock,
      config: { ...CORE_CONFIG, sync: true, verifyDelivery: true, syncCallsPerMin: 6_000, syncUnusedSweepMs: 7 * DAY },
    });
    const sync = partner.sync!;
    sync.track(scope);
    for (let i = 0; i < 200 && !sync.warm(scope); i++) await sync.tick();
    expect(sync.warm(scope)).toBe(true);
    const listings = (g: ReturnType<typeof gmailServer>) => g.calls.filter((c) => c.name === "search_threads").length;
    const before = [listings(plain), listings(fetching)];
    // Three active days, the sync ticking every 10 minutes; neither source is used (no lookup routes to it).
    for (let k = 0; k < (3 * DAY) / (10 * MIN); k++) {
      clock += 10 * MIN;
      sync.track(scope, clock);
      await sync.tick();
    }
    expect(listings(plain) - before[0]!).toBeGreaterThanOrEqual(3);
    expect(listings(fetching) - before[1]!).toBe(0);
    await users.close();
  });
});
