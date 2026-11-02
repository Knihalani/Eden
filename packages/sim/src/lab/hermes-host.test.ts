import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { labRouter, type StreamHost, type TaskBinding } from "./hermes-host";

/** A stream whose task records what its Eden routes received. */
function stream(token: string, log: string[]): StreamHost {
  const binding: TaskBinding = {
    token,
    observe: async (text) => {
      log.push(`observe:${text}`);
      return `packet for ${text}`;
    },
    tool: async (tool, output) => {
      log.push(`tool:${tool}:${output}`);
    },
    pending: () => "",
  };
  return {
    current: binding,
    sourcesServer: () => new McpServer({ name: "sources", version: "0" }),
    edenServer: () => null,
    model: async () => new Response("{}", { status: 200 }),
  };
}

const post = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("hermes-ab's localhost routes", () => {
  test("an Eden route reaches only its own stream's running task, by token", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const streams = new Map([
      ["a", stream("tok-a", a)],
      ["b", stream("tok-b", b)],
    ]);
    const route = labRouter(streams);
    const ok = await route(post("/s/a/eden/observe", { token: "tok-a", text: "book it" }));
    expect(await ok.json()).toEqual({ context: "packet for book it" });
    // Stream b's token on stream a, a stale token, and an unknown stream change nothing.
    expect((await route(post("/s/a/eden/observe", { token: "tok-b", text: "x" }))).status).toBe(409);
    expect((await route(post("/s/a/eden/tool", { token: "old", tool: "t", output: "o" }))).status).toBe(409);
    expect((await route(post("/s/c/eden/observe", { token: "tok-a", text: "x" }))).status).toBe(404);
    expect(a).toEqual(["observe:book it"]);
    expect(b).toEqual([]);
  });

  test("between tasks every Eden route is refused", async () => {
    const s = stream("tok", []);
    s.current = null;
    const route = labRouter(new Map([["a", s]]));
    expect((await route(post("/s/a/eden/pending", { token: "tok" }))).status).toBe(409);
  });

  test("caller errors are 4xx with a message; a failure inside is 503, never 500", async () => {
    const s = stream("tok", []);
    s.current!.tool = async () => {
      throw new Error("partner down");
    };
    const route = labRouter(new Map([["a", s]]));
    expect((await route(post("/s/a/eden/observe", "{not json"))).status).toBe(400);
    expect((await route(post("/s/a/eden/observe", { token: "tok", text: 3 }))).status).toBe(400);
    expect((await route(new Request("http://127.0.0.1/s/a/eden/observe"))).status).toBe(405);
    expect((await route(new Request("http://127.0.0.1/nope"))).status).toBe(404);
    expect((await route(post("/s/a/mcp/eden", {}))).status).toBe(404);
    const failed = await route(post("/s/a/eden/tool", { token: "tok", tool: "t", output: "o" }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "partner down" });
  });

  test("the sources MCP server answers a stateless initialize", async () => {
    const s = stream("tok", []);
    const route = labRouter(new Map([["a", s]]));
    const res = await route(
      new Request("http://127.0.0.1/s/a/mcp/sources", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("sources");
  });

  // The Hermes plugin is plain stdlib Python: its fail-open test runs wherever a python3 is on the PATH.
  const python = spawnSync("python3", ["--version"]).status === 0;
  test.if(python)("the Eden plugin fails open: no Eden, a refusal or an error is no context, never a raise", () => {
    const dir = join(import.meta.dir, "../../lab/hermes");
    expect(existsSync(join(dir, "test_plugin.py"))).toBe(true);
    const run = spawnSync("python3", ["-I", join(dir, "test_plugin.py")], { encoding: "utf8" });
    expect(run.stderr + run.stdout).toContain("OK");
    expect(run.status).toBe(0);
  });
});
