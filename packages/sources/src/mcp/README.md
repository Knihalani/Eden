# A small, bounded MCP client

A Model Context Protocol client for TypeScript, on Bun or Node: JSON-RPC framing, `initialize`, tools, resources and
prompts, over streamable HTTP or stdio, in about 1,800 lines with no npm dependency. It is written for a program that
calls MCP servers it does not control, so every reply is treated as hostile input: sizes, deadlines and message counts
are bounded, and no failure escapes as anything but a rejected call.

It is part of [Eden](../../../../README.md) (D1704 in `docs/DECISIONS.md`; speed in D1840 and D1860,
`docs/research/mcp-perf.md`; how it compares with other clients in `docs/research/mcp-vs-alternatives.md`). This
directory imports nothing from outside itself, and its tests run on their own (below).

## Use

```ts
import { McpClient, StreamableHttpTransport } from "./mcp";

const client = new McpClient({ name: "my-app", version: "1.0.0" });
await client.connect(
  new StreamableHttpTransport(new URL("https://mcp.example.com/mcp"), {
    headers: { authorization: `Bearer ${token}` }, // sent on every POST, never to another origin
  }),
);
console.log(client.server?.serverInfo, client.server?.instructions); // what the server said of itself

const { tools, nextCursor } = await client.listTools(); // one page; pass { cursor } for the next
const result = await client.callTool(
  { name: "search", arguments: { query: "budget" } },
  { signal: AbortSignal.timeout(5_000) }, // or { timeoutMs }; the default is 60 s
);
if (result.isError) console.log("the tool failed:", result.content);
await client.close();
```

A server started as a process, over stdio:

```ts
import { McpClient } from "./mcp";
import { StdioClientTransport } from "./mcp/stdio";

const client = new McpClient({ name: "my-app", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    env: { API_TOKEN: token }, // the child gets these and HOME, PATH, SHELL, TERM, USER, LOGNAME: no other variable
  }),
);
```

Resources and prompts, and any other method:

```ts
import { getPrompt, listPrompts, listResources, readResource } from "./mcp/extras";

const { resources } = await listResources(client);
const { contents } = await readResource(client, { uri: resources[0].uri });
const { messages } = await getPrompt(client, { name: "summarize", arguments: { id: "7" } });

client.onnotification = (n) => console.log(n.method, n.params); // progress, logging, list changes: untrusted data
const raw = await client.request("completion/complete", { ref, argument }); // the result object, unchecked
```

`./stdio` and `./extras` are separate entry points that `index.ts` never imports: a program that calls tools over HTTP
does not load them, and a bundler leaves them out (a minified bundle of a tools-only program is 17.5 KB, 6.3 KB
gzipped, and holds neither).

`McpClient` takes any `Transport` (`start`, `send`, `close`, `onmessage`, `onclose`, `onerror`); the official SDK's
transports fit it unchanged. Errors match the SDK's client where a caller would read them: a JSON-RPC error rejects
with `McpError` (`MCP error <code>: <message>`, `.code`, `.data`); a timeout or an aborted signal rejects with
`McpError` code `-32001` and sends `notifications/cancelled`; a closed connection rejects every call in flight with code
`-32000` and calls `onclose`. An HTTP failure is a `StreamableHttpError` with `.status`.

## What it does

- **Protocol.** `initialize` with version negotiation (2025-11-25 down to 2024-10-07), then
  `notifications/initialized`; `tools/list` and `tools/call`, each result shape-checked (a tool needs a `name` and an
  object `inputSchema`; a call's `content` is an array of objects, `structuredContent` an object); in `extras`,
  `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list` and `prompts/get`, checked the same
  way; `request` and `notify` for anything else. A server's `ping` is answered, at most 16 at once. Every other server
  request (sampling, roots, elicitation) is dropped unanswered and never acted on. Notifications go to
  `onnotification` when it is set.
- **Streamable HTTP.** One POST per message. A reply is `application/json` (one message or an array) or
  `text/event-stream`, read until the response to that POST's request arrives; the rest of the stream is drained in
  the background so the connection goes back to the keep-alive pool. `Mcp-Session-Id` is kept and sent back (visible
  ASCII only), `Mcp-Protocol-Version` is sent after `initialize`, a 404 on a held session closes the transport, so the
  owner can connect again, and `terminateSession()` sends the DELETE that ends a session.
- **Stdio.** The server is spawned without a shell and gets only the environment it is given plus a few variables a
  program needs to start; one message per line each way; `close` ends its stdin, then sends SIGTERM after 2 s and
  SIGKILL 2 s later.

## Bounds

| Bound | Default | What happens past it |
|---|---|---|
| Request timeout (client) | 60 s, or `timeoutMs` / `signal` | rejected, `notifications/cancelled` sent, its POST cut |
| POST deadline (HTTP) | 60 s (`timeoutMs`), reply body included | the fetch and the body read are aborted |
| Reply size (HTTP) | 16 MiB (`maxResponseBytes`); 4 MiB for a listing | the read is cancelled, the call rejected |
| One SSE line or event | 4 MiB | the read is cancelled, the call rejected |
| One stdio line | 16 MiB (`maxLineBytes`) | the line is dropped whole, never held |
| JSON shape | ~1,000 levels, ~1,000,000 values, counted before `JSON.parse` | treated as not JSON |
| Bad messages on one HTTP reply | 100 (not JSON-RPC, or a response to another id) | the reply fails with one error |
| Server requests on one HTTP reply | 100 | the reply fails |
| Bad stdio lines reported | 100 | dropped unreported |
| `ping` answers in flight | 16 | further pings dropped until one is sent |
| Redirects | 5, same origin, 307/308 only | rejected; no header reaches another origin |

Only the response whose id is the POSTed request's is taken from a reply (a numeric id echoed as a string counts, as
the SDK accepts). Error messages name the HTTP status and `Retry-After`, never the reply's body or a header that was
sent; a 403 or 503 whose first 512 bytes say "rate limit" is marked `rate limited` in fixed words.

A JSON reply whose length is one declared `Content-Length` under the cap, with no `Content-Encoding` and no
`Transfer-Encoding`, is read natively by the runtime's own `fetch` (which reads exactly that length); every other reply
(compressed, chunked, or through a `fetch` you pass in) is read through a capped stream reader. `framing.test.ts`
holds the cases that would break a native read: a gzip body inflated far past its declared length, a chunked body
beside a small `Content-Length`, a body shorter or longer than declared.

## Not supported

- **OAuth.** Credentials are static headers you pass in; there is no authorization flow, token refresh or
  `WWW-Authenticate` handling. To rotate a token, connect again with new headers. A flow written outside the client
  can hand it a token this way; the official SDK, `@ai-sdk/mcp` and `@earendil-works/pi-mcp` ship one. Left out
  because it is the largest piece of a client (discovery, dynamic registration, PKCE, refresh, a callback server) and
  the program this was written for holds operator-issued credentials.
- **Resumability.** No standalone GET stream for server-initiated messages, no `Last-Event-ID` reconnect of a broken
  stream: a stream that breaks fails its call, and the caller retries. A resumed stream needs a server that keeps an
  event store, and tracking event ids would put work on every event of every reply.
- **JSON-RPC batches** on the sending side (removed from MCP in 2025-06-18). A JSON reply that is an array is read.
- **The client's own capabilities**: sampling, roots and elicitation requests are dropped, never answered (each
  answer would be a POST with the caller's credentials, and acting on them is the host's decision, not a client's).
  Completions, logging levels and subscriptions are reachable through `request` only.
- **The legacy HTTP+SSE transport** (2024-11-05's separate GET stream and POST endpoint).
- **Output-schema validation** of `structuredContent`: it is returned as the server sent it.

## Speed

Measured against a canned server in its own process (`bench/mcp-profile.bench.ts`, `bench/mcp-compare.bench.ts`, 4
cores, Bun 1.4.4): the numbers, and where this client loses, are in `docs/research/mcp-vs-alternatives.md`. In short:
the time to the first call (26 ms from spawn) is the lowest of the six clients measured; up to 64 KB, and in SSE at
every size to 1 MB, a call costs the least CPU of them all (at 4 MB, measured against the SDK only, 0.73-0.77x its); JSON replies of 1 MB cost about what the official SDK's
do, 0.92-1.18x across two runs (they were 1.2-2.2x before D1860's native read), and of 4 MB 0.81-0.89x. With 256
replies of 1 MB in flight it peaks at 394-450 MB (JSON), the SDK at 457-499.

## Tests

`client.test.ts` and `http.test.ts` run against the official SDK's servers (in memory and over real HTTP, both reply
modes), `stdio.test.ts` against the SDK's server as a child process (tools, resources, prompts) and against hostile
children; `adversarial.test.ts` against malformed, oversized, truncated, flooding and hanging servers, with seeded
fuzz of the SSE parser, `asMessage` and the client; `framing.test.ts` the native read's hostile framings;
`shape.test.ts` the shape check; `deadlines.test.ts` the shared timer. Three parts need Eden and are skipped when this
directory is used on its own: `differential.test.ts` (against D1704's code, frozen in Eden's bench), the `McpSource`
tests in `adversarial.test.ts` and `http.test.ts`, and the test that keeps `shape.ts` equal to Eden's copy.

```bash
bun test ./packages/sources/src/mcp/      # in Eden
# On its own: copy the directory to an empty one as mcp/, add @modelcontextprotocol/sdk and zod as
# devDependencies there, and run `bun test ./mcp/` (78 pass, 10 skipped, D1860).
```

On Node (checked on 22.22), use a bundle: `bun build mcp/index.ts mcp/stdio.ts mcp/extras.ts --target=node
--splitting --outdir=dist`. The source's imports carry no file extension, which Node's ESM loader does not resolve.

## Files

| File | Owns |
|---|---|
| `index.ts` | The core's exports: the client, the HTTP transport, the types |
| `types.ts` | JSON-RPC and MCP types, `Transport`, `asMessage` (a parsed value as a message, or null), `McpError`, versions |
| `client.ts` | `McpClient` |
| `http.ts` | `StreamableHttpTransport`, `StreamableHttpError`, the caps |
| `sse.ts` | `SseParser`: one pass over bytes, bounded, never throws |
| `json.ts` | `parseJsonBytes`, `parseJsonText`: the shape check, then `JSON.parse` |
| `shape.ts` | The shape check (vendored from Eden's `@eden/protocol`, kept equal by `shape.test.ts`), and its string form |
| `deadlines.ts` | Every request's and POST's deadline on one timer |
| `stdio.ts` | `StdioClientTransport` (opt-in entry point) |
| `extras.ts` | Resources and prompts (opt-in entry point) |
