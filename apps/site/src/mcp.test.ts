import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpInstructions, MCP_INSTRUCTIONS_CHARS } from "@eden/core";
import { openDb, type EdenDb } from "./db";
import { handleMcp } from "./mcp";

type InitResult = {
  result: {
    protocolVersion: string;
    capabilities: unknown;
    serverInfo: unknown;
    instructions?: string;
  };
};

describe("mcpInstructions", () => {
  test("names every live tool and what it replaces", () => {
    const text = mcpInstructions([
      { name: "github_pr_bundle", when_to_use: "issues csv → JSON rows. One call for all PRs." },
      { name: "shop_orders", when_to_use: "ids csv → JSON rows from shop orders." },
    ]);
    expect(text).toContain("github_pr_bundle");
    expect(text).toContain("shop_orders");
    expect(text).toContain("One call for all PRs");
  });

  test("tells the model what to do about partial coverage", () => {
    // The recorded product benchmark lost because the compiled tool returned 3
    // of 5 required fields and the agent re-ran the whole per-PR loop anyway,
    // so the call cost a turn and displaced nothing.
    const text = mcpInstructions([{ name: "github_pr_bundle", when_to_use: "x" }]);
    expect(text).toMatch(/fetch only the remainder/);
    expect(text).toMatch(/do not re-run the whole loop/);
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

  async function addTool(name: string, whenToUse: string) {
    await db.run(
      `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, uses_count, published)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [name, "ws_local", name, whenToUse, "on", "[]", "[]", name, 0, 1],
    );
  }

  test("returns instructions naming the workspace's live tools", async () => {
    // MCP's InitializeResult carries an optional `instructions` string that
    // clients MAY put in the system prompt. Serving a hosted MCP with no hook
    // and no proxy, it is the only steering channel there is, and Eden left it
    // empty.
    await addTool("github_pr_bundle", "issues csv → JSON rows. One call for all PRs.");
    const res = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.instructions).toBeDefined();
    expect(res.result.instructions).toContain("github_pr_bundle");
  });

  test("does not leak another workspace's tools into the hint", async () => {
    await addTool("github_pr_bundle", "mine");
    await db.run(
      `INSERT OR IGNORE INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, uses_count, published)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ["other_secret_tool", "ws_other", "other_secret_tool", "not yours", "on", "[]", "[]", "f2", 0, 1],
    );
    const res = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    expect(res.result.instructions).toContain("github_pr_bundle");
    expect(res.result.instructions).not.toContain("other_secret_tool");
  });

  test("initialize still succeeds with no tools at all", async () => {
    const res = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    expect(res.result.serverInfo).toEqual({ name: "eden", version: "0.1.0" });
    expect(res.result.instructions).toContain("None are live");
  });

  test("the hint lists exactly what tools/list serves", async () => {
    // Naming a tool in the system prompt that the model cannot then call is
    // worse than saying nothing, so both paths go through the same selection.
    for (const n of ["alpha_rows", "beta_rows", "gamma_rows"]) await addTool(n, `ids csv → ${n}`);
    const init = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 1, method: "initialize" }, "http://x")) as InitResult;
    const list = (await handleMcp(db, "ws_local", { jsonrpc: "2.0", id: 2, method: "tools/list" }, "http://x")) as {
      result: { tools: Array<{ name: string }> };
    };
    for (const t of list.result.tools) expect(init.result.instructions).toContain(t.name);
  });
});

describe("DELETE /mcp terminates the session cleanly", () => {
  /**
   * Streamable HTTP lets a client end its session with DELETE. This server
   * keeps no per-session state, so it used to fall through to body parsing and
   * answer a non-JSON error — clients read that as a protocol failure instead
   * of a clean shutdown.
   */
  // Cache-busted import: a private server singleton (and db connection) that
  // outlives nothing, so afterEach's cleanup cannot pull the database out from
  // under an instance another test file shares.
  const SERVER_MOD = `./server?bust=mcp-delete`;
  let dir: string;
  let dbFile: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_SKIP_SEED"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-mcp-del-"));
    dbFile = join(dir, "mcp.db");
    process.env.EDEN_DB = dbFile;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("answers 202 accepted, not a non-JSON error", async () => {
    const { handleFetch } = await import(SERVER_MOD);
    const res = await handleFetch(new Request("http://127.0.0.1:8787/mcp", { method: "DELETE", headers: { host: "127.0.0.1:8787" } }));
    expect(res.status).toBe(202);
  });

  test("POST still reaches the JSON-RPC handler afterwards", async () => {
    const { handleFetch } = await import(SERVER_MOD);
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
