/**
 * The localhost surface `hermes-ab.ts` gives each Hermes worker: one stream (a world under one condition) per worker,
 * one task of it at a time.
 *
 *   /s/<stream>/v1/…               the model endpoint Hermes is pointed at (its `base_url`): the runner forwards
 *                                  chat completions to OpenRouter through the run's pacer and meter
 *   /s/<stream>/mcp/sources        MCP: a read-only `search_<source>` tool per sim source
 *   /s/<stream>/mcp/eden           MCP: Eden's own server (`createMcpServer`, `ask_context`), Eden conditions only
 *   /s/<stream>/eden/observe       the Eden plugin's `pre_llm_call`: the user's message → the packet to inject
 *   /s/<stream>/eden/tool          its `post_tool_call`: a tool's result, observed by Eden
 *   /s/<stream>/eden/pending       its `transform_tool_result`: packets queued since, appended to the tool result
 *
 * The Eden routes carry the task's token (the worker sets it per task): a call from another task, or one that lands
 * after its task ended, is refused with 409 and changes nothing. The plugin treats any refusal as "no context".
 * MCP and the model endpoint are per stream: Hermes connects to them once per worker, and the stream runs one task at a
 * time. Caller errors are 4xx with a message; a failure inside the runner is 503 (CLAUDE.md, fail open at the edge).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The task a stream is running now, and what its routes call. */
export interface TaskBinding {
  token: string;
  /** The user's message as Hermes sends it → Eden's context for the turn ("" for none). */
  observe(text: string): Promise<string>;
  /** A tool result Hermes received, for Eden to observe. */
  tool(tool: string, output: string): Promise<void>;
  /** Eden's packets queued since the last delivery, joined ("" for none). */
  pending(): string;
}

export interface StreamHost {
  /** The task running now; null between tasks. */
  current: TaskBinding | null;
  /** A fresh MCP server for one request (stateless transport), bound to the current task. */
  sourcesServer(): McpServer;
  /** Eden's MCP server for one request, or null in a condition without Eden. */
  edenServer(): McpServer | null;
  /** The model endpoint: `path` after `/v1/`. */
  model(path: string, req: Request): Promise<Response>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The body of an Eden route, or the 4xx that answers it. */
async function readBody(req: Request): Promise<Record<string, unknown> | Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  try {
    const body = (await req.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "body must be an object" });
    return body as Record<string, unknown>;
  } catch {
    return json(400, { error: "body must be JSON" });
  }
}

async function serveMcp(server: McpServer, req: Request): Promise<Response> {
  // Stateless, JSON responses: each request gets its own server and transport (the SDK's stateless pattern).
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // The response body is complete in JSON mode; closing frees the server's handlers.
    void server.close().catch(() => {});
  }
}

/** The request handler over every stream of a run. */
export function labRouter(streams: ReadonlyMap<string, StreamHost>): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const m = /^\/s\/([^/]+)\/(v1|mcp|eden)\/(.+)$/.exec(url.pathname);
    if (!m) return json(404, { error: "no such route" });
    const [, id, kind, rest] = m as unknown as [string, string, "v1" | "mcp" | "eden", string];
    const host = streams.get(id);
    if (!host) return json(404, { error: `no stream ${id}` });
    try {
      if (kind === "v1") return await host.model(rest, req);
      if (kind === "mcp") {
        const server = rest === "sources" ? host.sourcesServer() : rest === "eden" ? host.edenServer() : null;
        if (!server) return json(404, { error: `no MCP server ${rest} in this stream` });
        return await serveMcp(server, req);
      }
      const body = await readBody(req);
      if (body instanceof Response) return body;
      const task = host.current;
      if (!task || body.token !== task.token) return json(409, { error: "not the running task" });
      if (rest === "observe") {
        if (typeof body.text !== "string") return json(400, { error: "text must be a string" });
        return json(200, { context: await task.observe(body.text) });
      }
      if (rest === "tool") {
        if (typeof body.tool !== "string" || typeof body.output !== "string") {
          return json(400, { error: "tool and output must be strings" });
        }
        await task.tool(body.tool, body.output);
        return json(200, {});
      }
      if (rest === "pending") return json(200, { context: task.pending() });
      return json(404, { error: `no Eden route ${rest}` });
    } catch (e) {
      // The message only: a stack or a request body could quote user content.
      return json(503, { error: e instanceof Error ? e.message.slice(0, 200) : "internal error" });
    }
  };
}
