# Eden's MCP client against the alternatives (2026-11-14, D1860: adopted)

D1704 replaced the official SDK with Eden's own MCP client; D1840 made it faster. The owner may release the module
(`packages/sources/src/mcp/`) on its own, so this note does three things: fixes the weak points D1840 left (JSON
replies of 64 KB and over cost more CPU than the SDK's; memory with 256 replies of 1 MB in flight), adds what a user of
an MCP client needs where it is cheap, and compares the client head to head with the common alternatives on the same
local servers, including where ours loses.

Machine: 4 cores, 16 GB, Bun 1.4.4 (`env -u BUN_OPTIONS`), Node 22.22, Python 3.13; shared with one other agent, so
every speed comparison interleaves its arms over three rounds and reports medians.

## The clients

| Client | Version | What it is | Install (npm or pip, own empty directory, scripts off) |
|---|---|---|---|
| Eden (`eden`) | this tree | this module | 0 packages; 1,760 lines of source (72 KB with comments); a minified tools-only bundle 17.5 KB (6.3 KB gzipped) |
| Official TypeScript SDK 1.x (`sdk`) | `@modelcontextprotocol/sdk` 1.32.2 | the reference implementation; Eden's devDependency | 95 packages (with its zod peer), 29 MB |
| Official TypeScript SDK 2.x (`sdk2`) | `@modelcontextprotocol/client` 2.4.0 | the SDK's split client package | 13 packages, 18 MB |
| pi-mcp (`pi`) | `@earendil-works/pi-mcp` 1.5.2 | the Pi harness's standalone client (no SDK dependency), ~13M downloads a month | 7 packages, 1.1 MB |
| AI SDK MCP (`aisdk`) | `@ai-sdk/mcp` 2.0.99 | Vercel AI SDK's client, ~31M downloads a month | 15 packages (with its zod peer), 14 MB |
| Python SDK (`python`) | `mcp` 2.3.0 | the official Python SDK | 28 packages, about 44 MB of `site-packages` (57 MB with pip's 13) |

Lightweight JavaScript clients were found by searching the npm registry for "mcp client" and "model context protocol
client": pi-mcp and the AI SDK's are the most used that do not wrap the official SDK (`mcp-client` 1.13 and
`@mastra/mcp` wrap it). Each was installed with `npm install --ignore-scripts` (pip into a venv for Python) in its own
new directory under the scratchpad, never run from inside it, and deleted afterwards; Python ran with `-I`. Sizes are
`du -sh node_modules` and npm's "added N packages".

## Method

`packages/sources/bench/mcp-compare.bench.ts` (with `mcp-compare-client.py` for the Python arm) runs each client in a
fresh process, against two local servers in their own processes:

- **Speed**: the canned server of `mcp-profile.bench.ts` (a `tools/call` result of a set size, built once, as
  `application/json` or as one SSE event). Per cell (reply mode, size 1 KB / 64 KB / 1 MB, 1 / 16 / 256 calls in
  flight): CPU per call (process CPU, all threads, over the timed calls), p50 and p99 latency, peak RSS sampled during
  the cell; and the time from spawning the process to its first call's answer (imports, `initialize`, one 1 KB call).
  Three rounds, arm order rotating, medians. Every JavaScript client runs under Bun. The Python client's per-event cap
  was raised from its default 1 MiB to 4 MiB (Eden's) so a 1 MB SSE reply is read.
- **Hostile replies**: one server process answering `initialize` normally and `tools/call` with each case of
  `src/mcp/adversarial.test.ts`; each client sends the canary headers `authorization` and `x-api-key`, calls the tool
  once with a 5 s timeout where it takes one, and is killed at 30 s. Recorded: the outcome, wall time and CPU of the
  process from just before loading the client (so 50-200 ms of each is the client's own start), peak RSS
  (`maxRSS`/`ru_maxrss`), the POSTs the server received (initialize, initialized, the call, and every answer to a
  server request) and which canary headers reached the other origin.

## Speed

CPU per call (µs, all threads; lower is better):

| Reply | In flight | eden | sdk | sdk2 | pi | aisdk | python |
|---|---|---|---|---|---|---|---|
| JSON 1 KB | 1 | **89** | 118 | 185 | 100 | 157 | 3,051 |
| JSON 1 KB | 16 | **46** | 66 | 101 | 90 | 66 | 3,073 |
| JSON 1 KB | 256 | **60** | 62 | 116 | 64 | 98 | 3,372 |
| JSON 64 KB | 1 | **155** | 197 | 253 | 225 | 265 | 4,490 |
| JSON 64 KB | 16 | **141** | 178 | 181 | 147 | 176 | 4,613 |
| JSON 64 KB | 256 | **119** | 146 | 164 | 163 | 149 | 4,832 |
| JSON 1 MB | 1 | 1,474 | 1,249 | **1,138** | 2,592 | 1,258 | 29,972 |
| JSON 1 MB | 16 | 1,304 | **1,174** | 1,213 | 1,805 | 1,269 | 26,978 |
| JSON 1 MB | 256 | 1,810 | 1,624 | **1,543** | 2,219 | 1,565 | 29,692 |
| SSE 1 KB | 1 | **95** | 131 | 145 | 130 | 167 | 4,532 |
| SSE 1 KB | 16 | **45** | 92 | 96 | 93 | 127 | 4,087 |
| SSE 1 KB | 256 | **42** | 78 | 120 | 82 | 106 | 4,609 |
| SSE 64 KB | 1 | **208** | 271 | 304 | 682 | 362 | 6,351 |
| SSE 64 KB | 16 | **171** | 358 | 303 | 661 | 353 | 6,613 |
| SSE 64 KB | 256 | **177** | 257 | 277 | 546 | 254 | 6,888 |
| SSE 1 MB | 1 | **2,602** | 3,439 | 3,270 | 20,586 | 3,527 | 42,192 |
| SSE 1 MB | 16 | **1,809** | 2,615 | 2,720 | 15,193 | 2,649 | 40,430 |
| SSE 1 MB | 256 | **2,106** | 2,581 | 2,528 | 15,036 | 2,746 | 37,520 |

p50 latency follows CPU: one call at a time, 98 / 103 / 143 / 109 / 138 / 2,982 µs at 1 KB JSON (eden, sdk, sdk2, pi,
aisdk, python), 1,619 / 1,360 / 1,247 / 2,371 / 1,432 / 31,180 µs at 1 MB JSON, 2,420 / 2,383 / 2,277 / 18,666 /
2,726 / 41,246 µs at 1 MB SSE. At 16 in flight, 1 KB: 335 / 489 / 911 / 542 / 553 µs (JSON) and 325 / 779 / 904 /
850 / 1,035 µs (SSE).

Peak RSS (MB): at 1 KB one call at a time 44 / 61 / 74 / 54 / 65 / 73 (JSON); 256 replies of 1 MB in flight 450 / 499 /
499 / 888 / 494 / 352 (JSON) and 733 / 763 / 828 / 560 / 858 / 358 (SSE). The Python figures are a high-water mark
that does not fall back between cells (its process keeps the memory it took), so its SSE column reads 280 MB from the
first SSE cell; it is still the lowest at 256 MB of replies in flight, since it reads them more slowly.

**Time to the first call** (spawn to answer, medians of 3): eden 26 ms, pi 56, aisdk 106, sdk 125, sdk2 173, python
710.

Where ours loses: **JSON replies of 1 MB**, 1.11-1.18x the CPU of the SDK 1.x and 1.07-1.30x of the SDK 2.x, and
1.0-1.3x their latency. Every other client reads a JSON reply with `res.json()` in one native step; ours reads it
natively as text (D1860, below) but must then run the shape check over it before `JSON.parse`, and the text is a
string the parse reads again. At 64 KB and below ours is the cheapest in every cell, and in SSE at every size.

## Hostile replies

| Case | eden | sdk | sdk2 | pi | aisdk | python |
|---|---|---|---|---|---|---|
| Oversized JSON (128 MiB, declared) | refused at 16 MiB, 26 MB RSS | read whole, answered, 305 MB | read whole, 314 MB | refused at 16 MiB, 65 MB | read whole, 306 MB | read whole, 712 MB |
| Oversized SSE (a line that never ends, up to 512 MiB) | refused at 4 MiB, 15 ms, 33 MB | grew to the 5 s timeout, 637 MB | same, 648 MB | refused at 16 MiB after 1.4 s of CPU, 153 MB | grew to the timeout (5.2 s CPU), 643 MB | refused at its 1 MiB event cap, 72 MB |
| Slow drip (an SSE comment every 250 ms, no answer) | timeout at 5.0 s | timeout at 5.1 s | timeout | timeout | timeout | timeout |
| SSE junk (2,000,000 junk events, then the answer) | failed after 100 bad events, 9 ms CPU | answered after 2.1 s CPU | answered, 1.9 s | answered, 2.6 s | aborted at the timeout after 7.0 s CPU | failed at the first bad event, 93 ms |
| Server-request flood (20,000 pings and sampling requests, then the answer) | failed after 100; 16 POSTs back | answered; 19,998 POSTs back | answered; 20,000 POSTs | answered; 18,033 POSTs | answered; 14,805 POSTs | timed out after 10.6 s of CPU; 3,763 POSTs |
| Redirect to another origin (307) | not followed | not followed | not followed | **followed; `x-api-key` sent to the other origin** | not followed | not followed |
| Malformed JSON | clean error | clean error | clean error | clean error | clean error | clean error |
| 1,000,000 nested arrays | refused before the parse, 10 ms CPU | parsed, then refused by zod, 354 ms, 134 MB | same, 377 ms | parsed, refused, 266 ms, 132 MB | parsed, refused, 297 ms | refused by its parser, 98 ms |

POSTs back are counted past the three of the handshake and the call. No client crashed or hung past its timeout. Bun's
`fetch` drops `authorization` on a cross-origin redirect but not other headers, so a client that follows redirects
(pi-mcp does, as `fetch` does by default) sends a key in any other header to the redirect's target; the SDKs, the AI SDK
and Python refuse cross-origin redirects, as ours does.

Where ours is stricter than the others, and a well-behaved server could notice: a reply carrying more than 100 server
requests, or more than 100 malformed or unasked messages, fails its call, where the SDKs answer every request and skip
junk. It also answers only `ping` among server requests (no sampling, roots or elicitation handlers).

## Features

| | eden | sdk / sdk2 | pi | aisdk | python |
|---|---|---|---|---|---|
| Streamable HTTP | yes | yes | yes | yes | yes |
| stdio (spawning a server) | yes (D1860) | yes | yes | yes | yes |
| Legacy HTTP+SSE transport | no | yes | no | yes | yes |
| Tools | yes | yes | yes | yes | yes |
| Resources | yes (`extras`, D1860) | yes | yes | yes | yes |
| Prompts | yes (`extras`, D1860) | yes | no | yes | yes |
| Completions | through `request` | yes | no | yes | yes |
| Server-request handlers (sampling, roots, elicitation) | no (dropped) | yes | roots; any through `setRequestHandler` | elicitation | yes |
| OAuth | no | yes | yes | yes | yes |
| SSE resumability (`Last-Event-ID`) | no | yes | yes | handles `Last-Event-ID` | yes |
| Output-schema validation | no | yes | no | not checked | yes |
| Reply size cap | 16 MiB (4 MiB a listing or event) | none | 16 MiB | none | 1 MiB a SSE event; JSON none |
| Shape check before the parse | yes | no | no | no | no |
| Server-request flood bound | 100 a reply, 16 answers at once | no | no | no | no |
| Cross-origin redirects | refused | refused | followed | refused | refused |
| npm dependencies | 0 | 94 / 12 | 6 | 14 | 27 (pip) |

The others' columns are from their published types, READMEs and these runs, not from reading all their code.

## What changed (D1860)

1. **The native JSON read.** A JSON reply is read with the runtime's own `res.text()` (Bun) or `res.arrayBuffer()`
   (Node) when the runtime's own `fetch` was used and the reply's only framing is one decimal `Content-Length` under
   the cap: no `Content-Encoding` (the runtime inflates a gzip body past its declared length, 8 KB declared and 8 MB
   read) and no `Transfer-Encoding` (Bun read a chunked body past a small `Content-Length` beside it, and to the
   deadline when it was short: D1840's two refusals). Under those headers the HTTP client reads exactly the declared
   length, which `framing.test.ts` checks from a raw TCP server on Bun (a body longer than declared is cut, one shorter
   ends at the POST's deadline) and the Node check below repeats on undici. Every other reply, and every reply through
   a caller's `fetch`, keeps the capped stream read. Removing the guard fails the gzip and chunked tests. On Bun the
   text is shape-checked as a string (`textShapeWithin`, the byte scan's twin: structure is ASCII and UTF-8 never puts
   a quote or backslash inside a multi-byte character); `shape.test.ts` checks it gives the byte scan's answer on
   20,000 seeded bodies with invalid UTF-8, byte-order marks and astral characters (0 differences). Node's `text()`
   drops two byte-order marks where `TextDecoder` drops one, so on Node the bytes are read and decoded as before.
2. **The shape check is vendored** (`shape.ts`, from `@eden/protocol`), so the directory imports nothing from outside
   it; `shape.test.ts` compares the two copies' source text and their answers at the bounds. Not loading
   `@eden/protocol` also takes about 10 ms off the time to the first call (D1840 measured that module's load).
3. **Opt-in pieces**, in entry points `index.ts` never imports: `stdio.ts` (`StdioClientTransport`: no shell; only
   the given environment plus HOME, PATH and four others; a 16 MiB line cap, a longer line dropped whole; at most 100
   bad lines reported; SIGTERM then SIGKILL at close) and `extras.ts` (resources, resource templates and prompts,
   shape-checked as `tools/list` is; their listings take its 4 MiB cap). On the client: `request` and `notify` for any
   method, `server` (the `initialize` answer: info, capabilities, instructions), `onnotification`; on the HTTP
   transport, `terminateSession` (the session DELETE). Eden's own path is unchanged: `McpSource` and the servers use
   only `index.ts`.

Skipped, in the README: OAuth (the largest piece of a client, and Eden holds operator-issued credentials; a token can
be passed as a header), SSE resumability and the GET stream (needs a server that keeps an event store, and would put
event-id tracking on every event of every reply), batches (removed from the spec), the legacy HTTP+SSE transport,
handlers for sampling, roots and elicitation (each answer is a POST with the caller's credentials), output-schema
validation.

## Before and after (D1840 against D1860)

`mcp-profile.bench.ts` with a `base` arm reading main's `src/mcp/` from a copy (`MCP_PROFILE_BASE`), three rounds,
arm order rotating, medians. CPU per `tools/call` in µs; the last two columns are D1860 against D1840 and against the
SDK 1.x (below 1 is better):

| JSON reply | In flight | D1840 | D1860 | SDK | D1860 / D1840 | D1860 / SDK |
|---|---|---|---|---|---|---|
| 1 KB | 1 | 70.6 | 58.7 | 138.6 | 0.83 | 0.42 |
| 1 KB | 16 | 58.2 | 45.8 | 68.4 | 0.79 | 0.67 |
| 1 KB | 256 | 60.3 | 59.4 | 65.7 | 0.99 | 0.90 |
| 64 KB | 1 | 210.4 | 162.5 | 210.8 | 0.77 | 0.77 |
| 64 KB | 16 | 186.4 | 83.2 | 131.6 | 0.45 | 0.63 |
| 64 KB | 256 | 181.3 | 113.6 | 118.9 | 0.63 | 0.96 |
| 1 MB | 1 | 2,231 | 1,289 | 1,204 | 0.58 | 1.07 |
| 1 MB | 16 | 1,875 | 1,094 | 1,193 | 0.58 | 0.92 |
| 1 MB | 256 | 2,284 | 1,574 | 1,598 | 0.69 | 0.99 |
| 4 MB | 1 | 7,935 | 3,530 | 4,385 | 0.44 | 0.81 |
| 4 MB | 16 | 7,680 | 3,587 | 4,032 | 0.47 | 0.89 |

`tools/list` in JSON: 0.64-0.95 of D1840's from 64 KB (one cell at 1 KB, 16 in flight, 1.05) and 0.44-0.70 of the
SDK's. Before, JSON `tools/call` was 1.20-2.23x the SDK's from 64 KB (D1840's run); now 0.77-1.07x. The other
benchmark's run above, on the same server, read 1.11-1.18x at 1 MB: the SDK's lead at 1 MB, where there is one, is
within these two runs' spread.

**Memory with 256 replies of 1 MB in flight** (peak RSS, MB): JSON 394 against D1840's 999 and the SDK's 457 (the
first, shorter run of this comparison: 405 / 996 / 284); SSE 662 / 798 / 802. The native read holds one string per
reply where the stream read held the chunks, their join, and the decoded string; D1704's level was 655-705 MB.

**SSE and the single call** were not changed and do not move past noise: SSE `tools/call` 0.74-1.03 of D1840's
(1.22 at 1 KB one at a time in that run; seven interleaved rounds of the 1 KB cells alone then read 0.75-1.00 for
every 1 KB cell, JSON and SSE, `tools/call` and `tools/list`). The time to the first call fell from 21.8-34.6 ms
(D1840) to 11.8-15.7 ms: the module no longer loads `@eden/protocol`.

## Packaging

- **On its own**: the directory copied alone to an empty directory with `@modelcontextprotocol/sdk` 1.32.2 and zod
  4.6.7 installed beside it: `bun test ./mcp/` 78 pass, 10 skipped (the Eden-only tests: the differential against
  D1704's frozen code, the `McpSource` tests, the copy check), 0 fail.
- **Node 22.22**: bundled with `bun build --target=node --splitting` (the source's imports carry no extension, which
  Node's ESM loader does not resolve, and its parameter properties are not erasable syntax, so it cannot run under
  Node's type stripping either). Against the SDK's server under Bun: tools, resources and prompts over JSON and SSE
  with a 1 MB multi-byte result, the stdio transport spawning the SDK's server and killing it at close, and on undici
  the framing cases: a gzip body inflating past the cap refused, a chunked body beside a small length not read whole,
  a short body ended at the deadline, a declared length over the cap refused. All passed.
- **Tree-shaking**: a minified bundle of a program that imports only `McpClient` and `StreamableHttpTransport` holds
  neither `child_process` nor the prompt and resource functions: 17.5 KB, 6.3 KB gzipped.

## Reproduce

```bash
# alternatives in their own directories under one root (see the bench's header), then
MCP_ALT_DIR=<root> env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts perf 3     # ~75 min
MCP_ALT_DIR=<root> env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts hostile   # ~3 min
MCP_PROFILE_BASE=<copy of another tree's src/mcp> env -u BUN_OPTIONS bun packages/sources/bench/mcp-profile.bench.ts 3 eden,base,sdk
```
