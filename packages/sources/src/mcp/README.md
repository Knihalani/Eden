# A small, bounded MCP client

A Model Context Protocol client for TypeScript, on Bun or Node: JSON-RPC framing, `initialize`, tools, resources and
prompts, over streamable HTTP or stdio, with OAuth, resumable streams and handlers for the server's requests as opt-in
pieces, in about 3,000 lines with no npm dependency (2,050 for the core a tools-over-HTTP program loads). It is written
for a program that calls MCP servers it does not control, so every reply is treated as hostile input: sizes,
deadlines and message budgets are bounded, and no failure escapes as anything but a rejected call.

It is part of [Eden](../../../../README.md) (D1704 in `docs/DECISIONS.md`; speed in D1840, D1860 and D1870,
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

client.onnotification = (n) => console.log(n.method, n.params); // untrusted data; may be async, a throw is dropped
const raw = await client.request("completion/complete", { ref, argument }); // the result object, unchecked
```

A server behind OAuth (the MCP authorization spec's client side, D1874):

```ts
import { OAuthClientProvider } from "./mcp/oauth";

const oauth = new OAuthClientProvider("https://mcp.example.com/mcp", {
  redirectUrl: "http://127.0.0.1:8765/callback", // https:, or http: on a loopback host
  onRedirect: (url) => openBrowser(url), // send the user to the authorization server
  store: myTokenStore, // get/set/delete of JSON values; default: memory
});
const transport = new StreamableHttpTransport(new URL("https://mcp.example.com/mcp"), { auth: oauth });
try {
  await client.connect(transport);
} catch (e) {
  // A 401: discovery, registration and the authorization URL have run, and onRedirect was called.
  await oauth.finishAuth(await waitForCallback()); // the URL the user came back to: state checked, code exchanged
  await client.connect(new StreamableHttpTransport(url, { auth: oauth })); // the token is sent, and refreshed
}
```

Resumable streams, the GET stream, and answering the server's requests (each off unless asked for):

```ts
const transport = new StreamableHttpTransport(url, {
  resume: true, // a broken SSE reply is resumed by a GET with Last-Event-ID (3 tries, 1 s doubling, retry: honoured)
  limits: { serverRequests: 100, serverRequestsPerSecond: 10 }, // the defaults (D1872)
});
const client = new McpClient({ name: "my-app", version: "1.0.0" }, { capabilities: { sampling: {} } });
client.setRequestHandler("sampling/createMessage", async (params, { signal }) => callMyModel(params, signal));
await client.connect(transport);
await transport.openServerStream(); // false when the server offers none (405)
```

`./stdio`, `./extras` and `./oauth` are separate files that `index.ts` never imports (in Eden, the package exports
`@eden/sources/mcp`, `@eden/sources/mcp/stdio`, `@eden/sources/mcp/extras` and `@eden/sources/mcp/oauth`;
`oauth.test.ts` walks the core's imports to check): a program that calls tools over HTTP does not load them, and a
bundler leaves them out.

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
  way; `request` and `notify` for anything else. A server's `ping` is answered, at most 16 at once. Another server
  request (sampling, roots, elicitation) is answered by the handler the caller set for its method
  (`setRequestHandler`, with the capability declared in the constructor; at most 16 answers at once with the pings,
  a cancelled one not sent), and dropped unanswered when none is set. Notifications go to `onnotification` when it is
  set.
- **Streamable HTTP.** One POST per message. A reply is `application/json` (one message or an array) or
  `text/event-stream`, read until the response to that POST's request arrives; the rest of the stream is drained in
  the background so the connection goes back to the keep-alive pool. `Mcp-Session-Id` is kept and sent back (visible
  ASCII only), `Mcp-Protocol-Version` is sent after `initialize`, a 404 on a held session closes the transport, so the
  owner can connect again, and `terminateSession()` sends the DELETE that ends a session. Opt-in: `resume` resumes a
  reply whose SSE stream ends or breaks before its response, by a GET carrying the last event's `Last-Event-ID`
  (the SDK server's polling pattern: it closes a tool's stream and replays it from its event store), honouring
  `retry:`, with bounded tries and backoff, within the POST's deadline and cap; `openServerStream()` opens the GET
  stream for the server's messages outside any request, reopened from its last event when it ends; `auth` takes a
  bearer token from an `AuthHook` (`oauth.ts`'s provider, or your own) and asks it once on a 401.
- **OAuth** (`oauth.ts`, opt-in). Protected-resource metadata (RFC 9728) from the 401's `resource_metadata` or the
  well-known URLs, its `resource` checked against the server's; authorization-server metadata (RFC 8414, then OpenID
  Connect discovery), its `issuer` checked to be exactly the one named and PKCE S256 required; the given client, one
  registered before, or dynamic registration (RFC 7591); the authorization URL with PKCE S256, `state` and the RFC
  8707 `resource`, handed to `onRedirect`; `finishAuth` checks the state (once) and an `iss` if present, exchanges
  the code; tokens in a pluggable store, bound to their issuer, token endpoint and resource; an expired token
  refreshed before use, one refresh at a time.
- **Stdio.** The server is spawned without a shell and gets only the environment it is given plus a few variables a
  program needs to start; one message per line each way; `close` ends its stdin, then sends SIGTERM after 2 s and
  SIGKILL 2 s later. Its stderr is discarded by default (`stderr: "inherit"` shows it): it is the server's untrusted
  text, and would otherwise reach the host's logs unasked.

## Bounds

| Bound | Default | What happens past it |
|---|---|---|
| Request timeout (client) | 60 s, or `timeoutMs` / `signal` | rejected, `notifications/cancelled` sent, its POST cut |
| POST deadline (HTTP) | 60 s (`timeoutMs`), reply body included | the fetch and the body read are aborted |
| Reply size (HTTP) | 16 MiB (`maxResponseBytes`); 4 MiB for a listing | the read is cancelled, the call rejected |
| One SSE line or event | 4 MiB | the read is cancelled, the call rejected |
| One stdio line | 16 MiB (`maxLineBytes`) | the line is dropped whole, never held past the cap |
| An open line's reads (SSE, stdio) | coalesced: reads under 16 KB copied into one doubling buffer | about 2 arrays held, however small the reads |
| JSON shape | ~1,000 levels, ~1,000,000 values, counted before `JSON.parse` | treated as not JSON |
| Bad messages on one HTTP reply (or GET connection) | 100, and 1 more per KiB of messages (`limits`) | the reply fails with one error |
| Server requests on one HTTP reply | 100, and 10 more a second it stays open, at most 200 (`limits`) | the reply fails |
| Server requests on the GET stream | 100, and 10 more a second it has been open, across its reconnects | the stream stops |
| Resuming a reply (`resume`) | 3 tries, 1 s doubling to 30 s (`retry:` honoured, capped) | the call fails; deadline and cap span every try |
| GET stream connections (`openServerStream`) | the event and reply caps each; reopened until 3 in a row deliver nothing | stops; a budget failure stops it at once |
| OAuth responses (`oauth.ts`) | 64 KiB, 10 s each; HTTPS (loopback `http:` only) | the step fails with an `OAuthError` in fixed words |
| Bad stdio lines reported | 100 | dropped unreported |
| `ping` answers in flight | 16 | further pings dropped until one is sent |
| Redirects | 5, same origin, 307/308 only | rejected; no header reaches another origin |
| OAuth redirects | a metadata GET: 3, same origin; a token or registration POST: none | the step fails |
| OAuth URLs from a server | the `resource_metadata` hint on the server's origin (or `metadataOrigins`); every URL HTTPS and no more local than the server (no loopback, private, link-local or unique-local address for a remote one) | the step fails before any request |
| Opening the GET stream | each connection's headers within `timeoutMs` | the open fails |

Only the response whose id is the POSTed request's is taken from a reply (a numeric id echoed as a string counts, as
the SDK accepts); a response on the GET stream is unasked, so dropped and counted. Error messages name the HTTP status
and `Retry-After`, never the reply's body or a header that was sent; a 403 or 503 whose first 512 bytes say "rate
limit" is marked `rate limited` in fixed words. An access token is given only for the URL it was issued for (a
transport to any other gets none), and a refresh token is sent only to the token endpoint that issued it; no token,
code, verifier or server text appears in an `OAuthError`.

A JSON reply whose length is one declared `Content-Length` under the cap, with no `Content-Encoding` and no
`Transfer-Encoding`, is read natively by the runtime's own `fetch` (which reads exactly that length); every other reply
(compressed, chunked, through a `fetch` you pass in, or through a global `fetch` replaced after this module loaded, or
on Bun one that is not native) is read through a capped stream reader. `framing.test.ts`
holds the cases that would break a native read: a gzip body inflated far past its declared length, a chunked body
beside a small `Content-Length`, a body shorter or longer than declared.

## Not supported

- **A callback server for OAuth.** `onRedirect` and `finishAuth` leave the browser and the redirect listener to
  the caller (a CLI runs a loopback listener, a web app has a route). Client ID metadata documents (2025-11-25's
  alternative to registration), token revocation and the client-credentials grant are not implemented.
- **JSON-RPC batches** on the sending side (removed from MCP in 2025-06-18). A JSON reply that is an array is read.
- **Built-in handlers**: sampling, roots and elicitation are answered only by handlers the caller writes (each
  answer is a POST with the caller's credentials, and acting on them is the host's decision, not a client's).
  Completions, logging levels and subscriptions are reachable through `request` only.
- **The legacy HTTP+SSE transport** (2024-11-05's separate GET stream and POST endpoint).
- **Output-schema validation** of `structuredContent`: it is returned as the server sent it.

## Speed

Measured against a canned server in its own process (`bench/mcp-profile.bench.ts`, `bench/mcp-compare.bench.ts`, 4
cores, Bun 1.4.4): the numbers are in `docs/research/mcp-vs-alternatives.md`. In short: the time to the first call
(26 ms from spawn) is the lowest of the six clients measured; up to 64 KB, and in SSE at every size to 1 MB, a call
costs the least CPU of them all (D1860's run); since D1870, a JSON `tools/call` of 1 MB costs 0.73-0.77x the official
SDK's CPU at 1 and 16 in flight and 0.93x at 256 (it was 1.03-1.30x), and of 4 MB 0.65-0.76x, on the bench's replies
(one long plain string). With 256 replies of 1 MB in flight it peaks at 391 MB (JSON), the SDK at 475.

## Where it loses

- **Tool output in JSON** (a long string with an escaped newline and quotes every line): 1.13-1.45x the SDK 1.x's
  CPU at 64 KB with 16 and 256 in flight and at 1 MB, in D1908's run of the comparison
  (`docs/research/mcp-vs-alternatives.md`; ours is the cheapest in 61 of its 72 cells). Our check and read cost 3-10%
  over an unchecked `text()` and `JSON.parse`; the rest is Bun's `text()` against the `res.json()` the others use,
  65-150 µs a MiB. Taking `json()` and checking after would close it and was refused (D1871): `json()` of 1 MB of
  nested arrays costs 54-87 ms before anything can refuse it, and of a 16 MiB number flood 134-201 ms, which this
  refuses in 3-5 ms. Also lost in that run: plain JSON at 1 KB and at 64 KB with 256 in flight (1.11x) and tool output
  in SSE at 64 KB one at a time (1.11x); four numbers cells tie (1.00-1.02x). Against main's own parser (D1909,
  measured with and without a forced GC): tool output, numbers, plain text and refused floods cost 0.25-0.75x its CPU,
  structured replies and multi-byte text about the same (within the control's 10-20% at 64 KB), and peak memory at
  16 MiB is at or under main's once the process has warmed; still over it: a hostile pair of strings whose guessed end
  is wrong (1.26-1.46x), a number array whose last element has more than 15 digits (1.6-2.1x, read to its end before
  that element is met), and a refused depth bomb (about 1 µs).
- **On Node** a long body is decoded once and takes the same long-reply path (D1904); V8 parses dense escapes faster
  than the byte unescaper, so there the literal is parsed (D1901).
- **Features others have**: the legacy HTTP+SSE transport, output-schema validation of `structuredContent`, a
  callback listener for OAuth and client ID metadata documents (below).

## Tests

`client.test.ts` and `http.test.ts` run against the official SDK's servers (in memory and over real HTTP, both reply
modes), `stdio.test.ts` against the SDK's server as a child process (tools, resources, prompts) and against hostile
children; `adversarial.test.ts` against malformed, oversized, truncated, flooding and hanging servers, with seeded
fuzz of the SSE parser, `asMessage` and the client; `framing.test.ts` the native read's hostile framings;
`shape.test.ts` the shape check; `json.test.ts` the spliced parse against `JSON.parse` (D1870); `long-reply.test.ts` the
long-reply path (D1900-D1904, D1908, D1909) against the plain shape check and `JSON.parse` on 110,000 seeded bodies (escapes,
surrogates, byte-order marks, broken UTF-8, number edge cases, small bounds so refusals are common), the readers
against `JSON.parse`, and hostile shapes kept linear; `deadlines.test.ts`
the shared timer; `server-messages.test.ts` resumption and the GET stream against the SDK's resumable server (its
polling pattern) and hostile fakes, request handlers against the SDK's sampling, roots and elicitation, and the
budgets; `oauth.test.ts` the OAuth flow against the SDK's own authorization server (`mcpAuthRouter` and its demo
provider, which checks PKCE and the resource) and against fakes: a mismatched issuer, oversized metadata, a redirect
to another origin, plain HTTP, metadata for another resource, a forged or reused state, a token offered to another
origin or quoted by a server, refresh run once for twenty callers. Three parts need Eden and are skipped when this
directory is used on its own: `differential.test.ts` (against D1704's code, frozen in Eden's bench), the `McpSource`
tests in `adversarial.test.ts` and `http.test.ts`, and the test that keeps `shape.ts` equal to Eden's copy.

```bash
bun test ./packages/sources/src/mcp/      # in Eden
# On its own: copy the directory to an empty one as mcp/, add @modelcontextprotocol/sdk and zod as
# devDependencies there, and run `bun test ./mcp/` (124 pass, 10 skipped, D1870).
```

On Node (checked on 22.22), use a bundle: `bun build mcp/index.ts mcp/stdio.ts mcp/extras.ts --target=node
--splitting --outdir=dist`. The source's imports carry no file extension, which Node's ESM loader does not resolve.

## Files

| File | Owns |
|---|---|
| `index.ts` | The core's exports: the client, the HTTP transport, the types |
| `types.ts` | JSON-RPC and MCP types, `Transport`, `asMessage` (a parsed value as a message, or null), `McpError`, versions |
| `client.ts` | `McpClient`, `setRequestHandler` |
| `http.ts` | `StreamableHttpTransport`, `StreamableHttpError`, the caps and budgets, `resume`, `openServerStream`, the `AuthHook` |
| `sse.ts` | `SseParser`: one pass over bytes, bounded, never throws |
| `pieces.ts` | `Pieces`: an open line's bytes between reads, coalesced so tiny reads do not each hold an array |
| `json.ts` | `parseJsonBytes`, `parseJsonText`: the shape check, then `JSON.parse`; on a long reply, what the scan read spliced into the parse of the rest (D1870, D1900-D1904) |
| `readers.ts` | What the scan reads instead of `JSON.parse`: a long string with dense escapes, an array of plain numbers; ranges decoded as `TextDecoder` does (D1900-D1904) |
| `shape.ts` | The shape check (vendored from Eden's `@eden/protocol`, kept equal by `shape.test.ts`), its string form, and the long-reply scan (`scanText`: guessed string ends, the rest bound, the step budget) |
| `deadlines.ts` | Every request's and POST's deadline on one timer |
| `stdio.ts` | `StdioClientTransport` (opt-in entry point) |
| `extras.ts` | Resources and prompts (opt-in entry point) |
| `oauth.ts` | `OAuthClientProvider`, `MemoryTokenStore`, `parseChallenge`: the authorization flow (opt-in entry point, D1874) |
