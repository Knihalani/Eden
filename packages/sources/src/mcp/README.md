# A small, bounded MCP client

A Model Context Protocol client for TypeScript on Bun: the JSON-RPC framing, `initialize`, `tools/list` and
`tools/call` over the streamable HTTP transport, about 1,100 lines with no npm dependency. It is written for a
program that calls tools on MCP servers it does not control, so every reply is treated as hostile input: sizes,
deadlines and message counts are bounded, and no failure escapes as anything but a rejected call.

It is part of [Eden](../../../../README.md) (decision D1704 in `docs/DECISIONS.md`; speed work in D1840 and
`docs/research/mcp-perf.md`). This README describes the module on its own, for a later release as a package. Its
one import from outside this directory is `bodyShapeUnder` from `@eden/protocol` (a byte scan of JSON's depth and
value count), which a release would carry along.

## Use

```ts
import { McpClient, StreamableHttpTransport } from "./mcp";

const client = new McpClient({ name: "my-app", version: "1.0.0" });
await client.connect(
  new StreamableHttpTransport(new URL("https://mcp.example.com/mcp"), {
    headers: { authorization: `Bearer ${token}` }, // sent on every POST
  }),
);

const { tools, nextCursor } = await client.listTools(); // one page; pass { cursor } for the next
const result = await client.callTool(
  { name: "search", arguments: { query: "budget" } },
  { signal: AbortSignal.timeout(5_000) }, // or { timeoutMs }; the default is 60 s
);
if (result.isError) console.log("the tool failed:", result.content);
await client.close();
```

`McpClient` takes any `Transport` (`start`, `send`, `close`, `onmessage`, `onclose`, `onerror`): the official
SDK's transports (in-memory, stdio, streamable HTTP) fit it unchanged, so the client also runs over stdio with the
SDK's `StdioClientTransport`.

Errors match the official SDK's client where a caller would read them: a JSON-RPC error rejects with `McpError`
(`MCP error <code>: <message>`, `.code`, `.data`); a timeout or an aborted signal rejects with `McpError` code
`-32001` and sends `notifications/cancelled`; a closed connection rejects every call in flight with code `-32000`
and calls `onclose`. An HTTP failure is a `StreamableHttpError` with `.status`.

## What it does

- **Protocol.** `initialize` with version negotiation (2025-11-25 down to 2024-10-07), then
  `notifications/initialized`; `tools/list` (paged by cursor) and `tools/call`, each result shape-checked (a tool
  needs a `name` and an object `inputSchema`; a call's `content` is an array of objects, `structuredContent` an
  object). A server's `ping` is answered, at most 16 at once. Every other server request (sampling, roots,
  elicitation) is dropped unanswered and never acted on; notifications are ignored.
- **Streamable HTTP.** One POST per message. A reply is `application/json` (one message or an array) or
  `text/event-stream`, read until the response to that POST's request arrives; the rest of the stream is drained in
  the background so the connection goes back to the keep-alive pool. `Mcp-Session-Id` is kept and sent back (visible
  ASCII only), `Mcp-Protocol-Version` is sent after `initialize`, and a 404 on a held session closes the transport,
  so the owner can connect again.

## Bounds

| Bound | Default | What happens past it |
|---|---|---|
| Request timeout (client) | 60 s, or `timeoutMs` / `signal` | rejected, `notifications/cancelled` sent, its POST cut |
| POST deadline (transport) | 60 s (`timeoutMs`), reply body included | the fetch and the body read are aborted |
| Reply size | 16 MiB (`maxResponseBytes`); 4 MiB for `tools/list` | the read is cancelled, the call rejected |
| One SSE line or event | 4 MiB | the read is cancelled, the call rejected |
| JSON shape | ~1,000 levels, ~1,000,000 values, counted before `JSON.parse` | treated as not JSON |
| Bad messages on one reply | 100 (not JSON-RPC, or a response to another id) | the reply fails with one error |
| Server requests on one reply | 100 | the reply fails |
| `ping` answers in flight | 16 | further pings dropped until one is sent |
| Redirects | 5, same origin, 307/308 only | rejected; credentials never reach another origin |

Only the response whose id is the POSTed request's is taken from a reply (a numeric id echoed as a string counts, as
the SDK accepts). Error messages name the HTTP status and `Retry-After`, never the reply's body or a header that was
sent; a 403 or 503 whose first 512 bytes say "rate limit" is marked `rate limited` in fixed words.

## Not supported

Left out on purpose, as the program it was written for needs none of it:

- **OAuth.** Credentials are static headers you pass in; there is no authorization flow, token refresh or
  `WWW-Authenticate` handling.
- **Resumability.** No standalone GET stream for server-initiated messages, no `Last-Event-ID` reconnect of a broken
  stream: a stream that breaks fails its call.
- **JSON-RPC batches** on the sending side (removed from MCP in 2025-06-18). A JSON reply that is an array is read.
- **The session DELETE** on close (the SDK's `close` sends none either).
- **Anything but tools**: resources, prompts, completions, logging, progress, list-changed notifications, and the
  client capabilities (sampling, roots, elicitation), whose requests are dropped.
- **Output-schema validation** of `structuredContent`: it is returned as the server sent it.
- **A stdio client transport** (the SDK's fits `Transport`), and other runtimes than Bun: the code uses `fetch`,
  web streams, `TextDecoder` and `Buffer`, and is only tested on Bun.

## Speed

Measured on 4 cores against a canned server in its own process (`bench/mcp-profile.bench.ts`), with the official
SDK's client (1.29) on the same server:

- the time to the first call (process start, imports, `initialize`, one call) is about 21 ms against the SDK's
  110-125 ms;
- small calls (1 KB) cost 0.6-0.9x the SDK's CPU (`tools/list` 0.4-1.1x), and replies in server-sent events
  0.6-0.9x (`tools/list` 0.5-0.75x) at every size to 4 MB, at 1, 16 and 256 calls in flight;
- JSON replies of 64 KB and more cost 1.2-2.2x the SDK's CPU: the reply is read through its stream in capped
  chunks and joined, where the SDK reads it natively in one piece with no cap.

The numbers, and what was changed to get them, are in `docs/research/mcp-perf.md`.

## Tests

`client.test.ts` and `http.test.ts` run against the official SDK's servers (in memory and over real HTTP, both reply
modes); `adversarial.test.ts` against malformed, oversized, truncated, flooding and hanging servers, with seeded fuzz
of the SSE parser, `asMessage` and the client; `differential.test.ts` against the D1704 version of this code;
`deadlines.test.ts` the shared timer.

```bash
bun test ./packages/sources/src/mcp/
env -u BUN_OPTIONS bun packages/sources/bench/mcp-profile.bench.ts 3   # ~10 min; `quick` for 1 KB and 64 KB only
```

## Files

| File | Owns |
|---|---|
| `types.ts` | JSON-RPC and MCP types, `Transport`, `asMessage` (a parsed value as a message, or null), `McpError`, versions |
| `client.ts` | `McpClient` |
| `http.ts` | `StreamableHttpTransport`, `StreamableHttpError`, the caps |
| `sse.ts` | `SseParser`: one pass over bytes, bounded, never throws |
| `json.ts` | `parseJsonBytes`: the shape check, then `JSON.parse` (the check is `bodyShapeUnder` from `@eden/protocol`) |
| `deadlines.ts` | Every request's and POST's deadline on one timer |
