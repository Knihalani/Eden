import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StretchProgram } from "@eden/ir";
import { codingRegistry } from "@eden/wrap";
import { Store } from "./store";
import { createHandler } from "./server";

// Same pin as cors.test.ts: a DATABASE_URL in .env would make this a managed
// install, which refuses the deliberate "eden_dev" handler.
const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
const workspaces: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(() => {
  if (PREV_DEV === undefined) delete process.env.EDEN_DEV;
  else process.env.EDEN_DEV = PREV_DEV;
  for (const s of servers) s.stop(true);
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

const AUTH = { authorization: "Bearer eden_dev", "content-type": "application/json" };

// Every state-changing route in server.ts and api.ts, plus a read.
const ROUTES: Array<[string, string]> = [
  ["POST", "/v1/chat/completions"],
  ["POST", "/v1/messages"],
  ["POST", "/v1/workspace/orgs"],
  ["POST", "/v1/traces"],
  ["POST", "/v1/compile"],
  ["POST", "/v1/candidates/c1/shadow"],
  ["POST", "/v1/wrap-run"],
  ["POST", "/v1/wrap"],
  ["POST", "/v1/play"],
  ["POST", "/v1/ingest"],
  ["POST", "/v1/dispatch"],
  ["POST", "/v1/tools/wf_bash/schedule"],
  ["DELETE", "/v1/tools/wf_bash/schedule"],
  ["POST", "/v1/schedule/tick"],
  ["POST", "/v1/tools/wf_bash/approve"],
  ["POST", "/v1/tools/wf_bash/promote"],
  ["POST", "/v1/tools/wf_bash/pause"],
  ["DELETE", "/v1/candidates/c1"],
  ["POST", "/v1/receipts"],
  ["GET", "/v1/stats"],
];

/** A live tool whose one step is Bash: what a rebinding page would drive through /v1/wrap-run. */
function bashTool(): StretchProgram {
  return {
    id: "wf_bash",
    version: "v1",
    name: "bash_tool",
    description: "touches a sentinel file",
    inputSchema: { type: "object" },
    steps: [{ id: "s0", kind: "tool", tool: "Bash", args: { command: { kind: "literal", value: "touch pwned.txt" } } }],
    returns: { kind: "from", step: "s0", path: "" },
    contract: { witnesses: 0, minLlmReduction: 2, allowExact: true },
    sequence: ["Bash"],
    manifest: null,
  } as never;
}

/** `eden wrap` as it runs by default: bound to 127.0.0.1, public dev key, coding registry. */
function serveLoopback() {
  const ws = mkdtempSync(join(tmpdir(), "eden-guard-"));
  workspaces.push(ws);
  const store = new Store(":memory:");
  const now = Date.now();
  store.putTool({
    id: "wf_bash",
    name: "bash_tool",
    version: "v1",
    program: bashTool(),
    state: "live",
    created_at: now,
    updated_at: now,
  });
  const handler = createHandler({ store, token: "eden_dev", registry: codingRegistry(ws) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...AUTH, ...headers },
      ...(method === "POST" ? { body: JSON.stringify({ toolId: "wf_bash", input: {} }) } : {}),
    });
  return { store, handler, port: server.port, call, pwned: () => existsSync(join(ws, "pwned.txt")) };
}

describe("a loopback wrap server refuses requests driven by a web page", () => {
  test("a rebound Host is refused on every state-changing route, before any routing", async () => {
    const s = serveLoopback();
    for (const [method, path] of ROUTES) {
      const res = await s.call(method, path, { host: `evil.example:${s.port}` });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      expect(((await res.json()) as { error: string }).error).toMatch(/^forbidden/);
    }
    // Nothing past the guard ran: every routed request stamps the heartbeat.
    expect(s.store.lastHeartbeat()).toBe(0);
    expect(s.store.tracesCount()).toBe(0);
    expect(s.pwned()).toBe(false);
  });

  test("/v1/wrap-run: a rebound page cannot run the live Bash tool; the local caller still can", async () => {
    const s = serveLoopback();
    // Rebinding makes the page same-origin with the port, so only Host gives it away.
    const rebound = await s.call("POST", "/v1/wrap-run", {
      host: `evil.example:${s.port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(rebound.status).toBe(403);
    expect(s.pwned()).toBe(false);
    const local = await s.call("POST", "/v1/wrap-run");
    expect(local.status).toBe(200);
    expect(s.pwned()).toBe(true);
  });

  test("a foreign Origin is refused even with a loopback Host", async () => {
    const s = serveLoopback();
    for (const origin of ["https://evil.example", "http://localhost.evil.com", "null"]) {
      expect((await s.call("POST", "/v1/wrap-run", { origin })).status).toBe(403);
    }
    expect((await s.call("POST", "/v1/wrap-run", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await s.call("OPTIONS", "/v1/wrap-run", { origin: "https://evil.example" })).status).toBe(403);
    expect(s.pwned()).toBe(false);
  });

  test("a page on localhost and non-browser clients are served", async () => {
    const s = serveLoopback();
    const page = await s.call("GET", "/v1/stats", { origin: "http://localhost:3000" });
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const preflight = await s.call("OPTIONS", "/v1/stats", { origin: "http://127.0.0.1:8787" });
    expect(preflight.status).toBe(204);
    // The CLI, the SDKs and curl send no Origin; a typed URL says Sec-Fetch-Site: none.
    expect((await s.call("GET", "/v1/stats")).status).toBe(200);
    expect((await s.call("GET", "/health", { "sec-fetch-site": "none" })).status).toBe(200);
    for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`, "127.0.0.1"]) {
      expect((await s.call("GET", "/v1/stats", { host })).status).toBe(200);
    }
  });

  test("a hosted or LAN bind, and in-process callers, skip the loopback check", async () => {
    const s = serveLoopback();
    const req = () =>
      new Request("http://useeden.example/v1/stats", { headers: { ...AUTH, host: "useeden.example" } });
    expect((await s.handler(req())).status).toBe(200);
    expect((await s.handler(req(), { hostname: "0.0.0.0" })).status).toBe(200);
    expect((await s.handler(req(), { hostname: "127.0.0.1" })).status).toBe(403);
  });
});
