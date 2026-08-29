import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpInstructions, MCP_INSTRUCTIONS_CHARS } from "@eden/core";
import { openDb, type EdenDb } from "./db";
import { handleMcp, toolRowToProgram } from "./mcp";
import { dispatchPrograms, selectSurfacePrograms } from "@eden/wrap";

type InitResult = {
  result: {
    protocolVersion: string;
    capabilities: unknown;
    serverInfo: unknown;
    instructions?: string;
  };
};

describe("mcpInstructions", () => {
  test("does not name live tools — that is a dump; points at dispatch", () => {
    const text = mcpInstructions([
      { name: "github_pr_bundle", when_to_use: "issues csv → JSON rows. One call for all PRs." },
      { name: "shop_orders", when_to_use: "ids csv → JSON rows from shop orders." },
    ]);
    expect(text).not.toContain("github_pr_bundle");
    expect(text).not.toContain("shop_orders");
    expect(text).toMatch(/tools\/dispatch/);
    expect(text).toMatch(/at most one schema/);
  });

  test("says something sensible when nothing is live", () => {
    const text = mcpInstructions([]);
    expect(text).toContain("None are live");
    expect(text.length).toBeLessThan(400);
  });

  test("stays within the budget however many tools are live", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_number_${i}`,
      when_to_use: "a fairly long description that would otherwise run away with the system prompt budget",
    }));
    expect(mcpInstructions(many).length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_CHARS);
    expect(mcpInstructions(many)).not.toContain("tool_number_0");
  });
});

describe("handleMcp initialize", () => {
  let dir: string;
  let db: EdenDb;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_LIST_MCP"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-mcp-"));
    db = await openDb(join(dir, "mcp.db"));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function addTool(name: string, whenToUse: string, steps: unknown = [], workspaceId = "ws_local") {
    await db.run(
      `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, uses_count, published)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [name, workspaceId, name, whenToUse, "on", JSON.stringify(steps), "[]", name, 0, 1],
    );
  }

  const GH_STEPS = [{ url: "https://api.github.com/repos/acme/app/pulls/{issue}" }];
  const GH_MESSAGE = [
    { role: "user", content: "Look at https://api.github.com/repos/acme/app/pulls/12 and summarize the reviews" },
  ];
  const MISS_MESSAGE = [{ role: "user", content: "write a sonnet about the sea" }];

  test("returns a dispatch hint, not a dump of live tool names", async () => {
    await addTool("github_pr_bundle", "issues csv → JSON rows. One call for all PRs.", GH_STEPS);
    const res = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.instructions).toBeDefined();
    expect(res.result.instructions).toMatch(/tools\/dispatch/);
    expect(res.result.instructions).not.toContain("github_pr_bundle");
  });

  test("does not leak another workspace's tools into the hint", async () => {
    await addTool("github_pr_bundle", "mine", GH_STEPS);
    await addTool("other_secret_tool", "not yours", GH_STEPS, "ws_other");
    const res = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    expect(res.result.instructions).not.toContain("other_secret_tool");
    expect(res.result.instructions).not.toContain("github_pr_bundle");
  });

  test("initialize still succeeds with no tools at all", async () => {
    const res = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    expect(res.result.serverInfo).toEqual({ name: "eden", version: "0.1.0" });
    expect(res.result.instructions).toContain("None are live");
  });

  test("echoes a supported protocolVersion (2025-03-26 and 2024-11-05)", async () => {
    const latest = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      "http://x",
    )) as InitResult;
    expect(latest.result.protocolVersion).toBe("2025-03-26");
    const older = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      "http://x",
    )) as InitResult;
    expect(older.result.protocolVersion).toBe("2024-11-05");
  });

  test("2024-11-05 initialize still serves tools/list + notifications/initialized", async () => {
    const init = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      "http://x",
    )) as InitResult;
    expect(init.result.protocolVersion).toBe("2024-11-05");
    const listed = await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 2, method: "tools/list" }, "http://x");
    expect(listed).toHaveProperty("result.tools");
    const note = await handleMcp(db, "ws_local", { jsonrpc: "2.0", method: "notifications/initialized" }, "http://x");
    expect(note).toBeNull();
  });

  test("missing / 1.0.0 / garbage / hostile protocolVersion degrade — never throw, never 500", async () => {
    const cases: unknown[] = [
      undefined,
      "1.0.0",
      "not-a-date",
      2025,
      { not: "a string" },
      ["2025-03-26"],
      "h".repeat(250_000),
    ];
    for (const protocolVersion of cases) {
      const params = protocolVersion === undefined ? {} : { protocolVersion };
      let res: unknown;
      try {
        res = await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize", params }, "http://x");
      } catch (err) {
        throw new Error(`initialize threw on ${typeof protocolVersion}: ${(err as Error).message}`);
      }
      const body = res as { jsonrpc?: string; result?: { protocolVersion?: string }; error?: unknown };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error).toBeUndefined();
      expect(body.result?.protocolVersion).toBe("2025-03-26");
    }
    const hostileParams = {
      get protocolVersion() {
        throw new Error("injected");
      },
    };
    const hostile = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 9, method: "initialize", params: hostileParams },
      "http://x",
    )) as InitResult;
    expect(hostile.result.protocolVersion).toBe("2025-03-26");
  });

  test("the catalog is empty; dispatch returns the one match", async () => {
    await addTool("alpha_rows", "ids csv → alpha_rows");
    await addTool("github_pr_bundle", "issues csv → JSON rows", GH_STEPS);
    const init = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    const list = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 2, method: "tools/list" }, "http://x")) as {
      result: { tools: Array<{ name: string; defer_loading?: boolean }> };
    };
    expect(list.result.tools).toEqual([]);
    expect(init.result.instructions).not.toContain("github_pr_bundle");
    expect(init.result.instructions).not.toContain("alpha_rows");
    const hit = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 3, method: "tools/dispatch", params: { messages: GH_MESSAGE } },
      "http://x",
    )) as { result: { tools: Array<{ name: string; defer_loading?: boolean }> } };
    expect(hit.result.tools).toHaveLength(1);
    expect(hit.result.tools[0]!.name).toBe("github_pr_bundle");
    expect(hit.result.tools[0]!.defer_loading).toBe(true);
  });

  test("tools/dispatch miss / missing messages / transcript alias", async () => {
    await addTool("github_pr_bundle", "issues csv → JSON rows", GH_STEPS);
    const miss = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 1, method: "tools/dispatch", params: { messages: MISS_MESSAGE } },
      "http://x",
    )) as { result: { tools: unknown[] } };
    expect(miss.result.tools).toEqual([]);
    const none = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 2, method: "tools/dispatch" }, "http://x")) as {
      result: { tools: unknown[] };
    };
    expect(none.result.tools).toEqual([]);
    const alias = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 3, method: "tools/dispatch", params: { transcript: GH_MESSAGE } },
      "http://x",
    )) as { result: { tools: Array<{ name: string }> } };
    expect(alias.result.tools.map((t) => t.name)).toEqual(["github_pr_bundle"]);
  });

  test("dispatch still matches a 7th live tool — the old list cap must not starve it", async () => {
    for (let i = 0; i < 6; i++) {
      await db.run(
        `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, uses_count, published)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [`hot_${i}`, "ws_local", `hot_${i}`, "noise", "on", "[]", "[]", `hot_${i}`, 99, 1],
      );
    }
    await addTool("github_pr_bundle", "issues csv → JSON rows", GH_STEPS);
    const hit = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 1, method: "tools/dispatch", params: { messages: GH_MESSAGE } },
      "http://x",
    )) as { result: { tools: Array<{ name: string }> } };
    expect(hit.result.tools.map((t) => t.name)).toEqual(["github_pr_bundle"]);
    expect(hit.result.tools).toHaveLength(1);
  });

  test("ws_other tools are absent from ws_local dispatch", async () => {
    await addTool("other_secret_tool", "not yours", GH_STEPS, "ws_other");
    const leaked = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 1, method: "tools/dispatch", params: { messages: GH_MESSAGE } },
      "http://x",
    )) as { result: { tools: Array<{ name: string }> } };
    expect(leaked.result.tools).toEqual([]);
    const own = (await handleMcp(
      db,
      "ws_other",
      { jsonrpc: "2.0", id: 2, method: "tools/dispatch", params: { messages: GH_MESSAGE } },
      "http://x",
    )) as { result: { tools: Array<{ name: string }> } };
    expect(own.result.tools.map((t) => t.name)).toEqual(["other_secret_tool"]);
  });

  test("dispatch never returns more than one schema", async () => {
    await addTool("github_pr_bundle", "a", GH_STEPS);
    await addTool("github_pr_files", "b", GH_STEPS);
    const hit = (await handleMcp(
      db,
      "ws_local",
      { jsonrpc: "2.0", id: 1, method: "tools/dispatch", params: { messages: GH_MESSAGE } },
      "http://x",
    )) as { result: { tools: unknown[] } };
    expect(hit.result.tools.length).toBeLessThanOrEqual(1);
  });

  test("converted rows pick the same name as local JIT on the same transcript", async () => {
    await addTool("github_pr_bundle", "issues csv → JSON rows", GH_STEPS);
    await addTool("shop_orders", "ids csv");
    const rows = [
      {
        id: "github_pr_bundle",
        name: "github_pr_bundle",
        when_to_use: "issues csv → JSON rows",
        steps: JSON.stringify(GH_STEPS),
        uses_count: 0,
      },
      { id: "shop_orders", name: "shop_orders", when_to_use: "ids csv", steps: "[]", uses_count: 0 },
    ];
    const programs = rows.map(toolRowToProgram);
    const viaDispatch = dispatchPrograms(GH_MESSAGE, programs).map((p) => p.name);
    const viaJit = selectSurfacePrograms({ mode: "jit", live: programs, messages: GH_MESSAGE }).surface.map((p) => p.name);
    expect(viaDispatch).toEqual(viaJit);
    expect(viaDispatch).toEqual(["github_pr_bundle"]);
  });

  test("scorer fault fail-opens to empty tools, never throws", async () => {
    await addTool("github_pr_bundle", "x", GH_STEPS);
    const hostile = {
      get messages() {
        throw new Error("injected");
      },
    };
    let res: unknown;
    try {
      res = await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "tools/dispatch", params: hostile }, "http://x");
    } catch (err) {
      throw new Error(`dispatch threw: ${(err as Error).message}`);
    }
    const body = res as { jsonrpc?: string; result?: { tools?: unknown[] }; error?: unknown };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error).toBeUndefined();
    expect(body.result?.tools).toEqual([]);
  });
});

describe("DELETE /mcp terminates the session cleanly", () => {
  /**
   * Streamable HTTP lets a client end its session with DELETE. This server
   * keeps no per-session state, so it used to fall through to body parsing and
   * answer a non-JSON error — clients read that as a protocol failure instead
   * of a clean shutdown.
   */
  // One bust + one sqlite for the describe. beforeEach used to mint a new
  // EDEN_DB while re-importing the same busted module — server.db() stays
  // memoized on the first path, then afterEach deleted that file under the
  // open handle (shuffle flake).
  const SERVER_MOD = `./server?bust=mcp-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let dir: string;
  let dbFile: string;
  let handleFetch: (req: Request) => Promise<Response>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED", "EDEN_DEV"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Force the anonymous local fallback. Other suites (signup/flow) pin
    // EDEN_DEV=0; under --randomize that would make /mcp 401 before DELETE
    // can return 202. Clearing DATABASE_URL/VERCEL alone is not enough when
    // a later restore or bun .env reload re-marks the process as managed.
    process.env.EDEN_DEV = "1";
    dir = mkdtempSync(join(tmpdir(), "eden-mcp-del-"));
    dbFile = join(dir, "mcp.db");
    process.env.EDEN_DB = dbFile;
    ({ handleFetch } = await import(SERVER_MOD));
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.EDEN_DEV = "1";
    process.env.EDEN_DB = dbFile;
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
  });

  test("answers 202 accepted, not a non-JSON error", async () => {
    const res = await handleFetch(new Request("http://127.0.0.1:8787/mcp", { method: "DELETE", headers: { host: "127.0.0.1:8787" } }));
    expect(res.status).toBe(202);
  });

  test("POST still reaches the JSON-RPC handler afterwards", async () => {
    await handleFetch(new Request("http://127.0.0.1:8787/mcp", { method: "DELETE", headers: { host: "127.0.0.1:8787" } }));
    const res = await handleFetch(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:8787" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result).toEqual({});
  });
});
