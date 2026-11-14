# Eden's MCP client against the alternatives (2026-11-14, D1860 and D1870-D1875: adopted)

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

Where ours lost (D1860's run): **JSON replies of 1 MB**, 1.11-1.18x the CPU of the SDK 1.x and 1.07-1.30x of the
SDK 2.x, and 1.0-1.3x their latency. Every other client reads a JSON reply with `res.json()` in one native step; ours
read it natively as text (D1860, below) but then ran the shape check over it before `JSON.parse`, and the text is a
string the parse reads again. At 64 KB and below ours was the cheapest in every cell, and in SSE at every size.
D1870 closes it (below, "Closing the losses"): JSON at 1 MB is now 0.73-0.77x the SDK 1.x's CPU at 1 and 16 in flight
in `mcp-profile.bench.ts`, and with text written as tool output is (an escape every line) it went from 1.4-1.5x the
SDK's to 0.94-1.30x, from 1.12-1.72x: a loss that is smaller, not gone.

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

Where ours was stricter than the others, and a well-behaved server could notice (D1860): a reply carrying more than
100 server requests, or more than 100 malformed or unasked messages, failed its call, where the SDKs answer every
request and skip junk; and it answered only `ping` among server requests. D1872 makes both counts budgets (100 server
requests plus 10 a second the reply stays open, 100 bad messages plus one per KiB of messages), settable per transport,
and D1875 lets a caller answer sampling, roots and elicitation (below).

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
| Server-request handlers (sampling, roots, elicitation) | opt-in: `setRequestHandler` (D1875); dropped without one | yes | roots; any through `setRequestHandler` | elicitation | yes |
| OAuth | opt-in: `oauth.ts` (D1874) | yes | yes | yes | yes |
| SSE resumability (`Last-Event-ID`) | opt-in: `resume`, and the GET stream (D1873) | yes | yes | handles `Last-Event-ID` | yes |
| Output-schema validation | no | yes | no | not checked | yes |
| Reply size cap | 16 MiB (4 MiB a listing or event) | none | 16 MiB | none | 1 MiB a SSE event; JSON none |
| Shape check before the parse | yes | no | no | no | no |
| Server-request flood bound | 100 a reply plus 10 a second, settable; 16 answers at once (D1872) | no | no | no | no |
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

## Fixes from the independent review

An independent review of the first version (head f58325186) asked for seven changes; all are in.

- **An open line's reads are coalesced** (`pieces.ts`, used by the SSE parser and the stdio transport). Holding each
  read of an unended line as its own array, as D1840's parser did with Bun's reads, cost about 150 bytes of object a
  read: a raw TCP server dripping a `data:` line a byte per write (`setNoDelay`) took the client's RSS up 166 MB for 3
  MB sent (the review measured 172), about 230 MB a request at the 4 MiB event cap, on Eden's own path; a stdio child
  dripping 400 KB held 151,264 arrays. Now the first eight reads of a line are held as before (one array a read, so a
  large event across a few of Bun's reads costs what it did) and every later read under 16 KB is copied into one
  buffer that doubles as it fills: the same SSE probe peaks at +24 MB, and the stdio child's 400 KB is held in 9
  arrays (+14.7 MB RSS, against +29.6 MB before; most of what is left is the pipe's reads awaiting collection).
  `adversarial.test.ts` holds 3,000,000 1-byte reads in at most 9 arrays (chunks kept and copied) and alternating
  1-byte and 16 KB reads within two arrays per 16 KB; `stdio.test.ts` the dripping child. A first version copied from
  the first small read and cost 7-23% more CPU on 64 KB SSE replies (`mcp-profile.bench.ts`, three rounds:
  1.23 / 1.07 / 1.23 of the previous head's at 1 / 16 / 256 in flight); with the first eight reads held as they come,
  SSE `tools/call` and `tools/list` read 0.77-0.98 of the previous head's CPU at 64 KB to 4 MB in every cell but one
  (`tools/list` 4 MB, 16 in flight, 1.05), and the JSON and 1 KB cells 0.84-1.04 (all noise or better). Peak RSS with
  256 SSE replies of 1 MB in flight moves with the run (808 against 685 MB in one, 729 against 819 in the other).
- **An async `onnotification` that rejects** no longer ends the process with an unhandled rejection (Bun exits 1 on
  one): a returned promise is caught; `client.test.ts` fails without it.
- **Only the runtime's own `fetch` gets the native read**: the global as this module found it, and on Bun the native
  one (its source reads `[native code]`), so a global replaced by an APM agent, a mock or a polyfill gets the capped
  stream read. On Node the runtime's `fetch` is JavaScript, so only a replacement made after the module loaded can be
  told apart. `framing.test.ts` replaces the global with one that hands back 5,000 bytes under `content-length: 10`.
- **`terminateSession` is a flight**: cut at the POST deadline and by `close`.
- **The stdio server's stderr is discarded by default** (`stderr: "inherit"` shows it): it is the server's untrusted
  text and would otherwise reach the host's logs unasked. The SDK's default is to inherit it.
- **Subpath exports**: `@eden/sources/mcp`, `@eden/sources/mcp/stdio` and `@eden/sources/mcp/extras` in the package's
  `exports`.

## Closing the losses (D1870-D1875)

A second pass, the same day, at the list above: JSON at 1 MB, no OAuth, no resumability or GET stream, the flood
caps, and the server requests ours would not answer. Machine and method as above; the other agent on the machine was
running benches throughout, so every comparison is interleaved and the medians of three rounds are reported.

### Where the time went at 1 MB (D1870)

Profiled down from the whole call (`--cpu-prof-md`, and A/B variants of the read in a copy of the transport, each in
its own process against the canned server, 1,200 calls at 1 and 16 in flight, three rounds):

| Read of a 1 MiB JSON reply | CPU per call (µs), 1 in flight | 16 in flight |
|---|---|---|
| D1860: `text()`, shape check, `JSON.parse` | 1,010-1,170 | 870-1,030 |
| the same without the shape check | 1,040-1,070 | 900-930 |
| `res.json()`, no shape check (the floor ours cannot take: it parses before any check) | 790-910 | 670-810 |
| `bytes()`, byte shape check, `TextDecoder`, `JSON.parse` (Node's path) | 1,370-1,460 | 1,130-1,220 |
| `bytes()` or `blob()`, the check, then `new Response(bytes).json()` / `Blob.json()` | 1,160-1,480 | 1,135-1,245 |
| SDK 1.x (`res.json()`, then zod) | 1,050-1,170 | 990-1,080 |

So the shape check itself cost 30-90 µs a MiB; the loss was `text()`'s string plus `JSON.parse` reading and copying
it again (in-process: `JSON.parse` of a fetched 1 MiB string 172-306 µs, `text()` 100-120 µs over `bytes()`, and the
second 1 MiB string doubling what the collector sees). Bun's `res.json()` parses the received bytes without making
that string, which no public API offers after a check: `Bun.JSONL.parse(bytes)` costs the same as decode and parse
(and accepts `{"a":1}{"b":2}` as one value), and a `clone()` before `json()` costs 1,740-2,300 µs. Skipping the check
was measured too and refused: a 1 MB body of nested arrays costs `json()` 108 ms of CPU against 46 ms for the worst
body the check lets through, and at 16 MiB 1,284 ms and 775 MB RSS, so D1704's depth bound before the parse stays.

Two changes, both keeping the check before any parse:

1. **A string's end is found by its next quote** (`stringEnd` here and in `@eden/protocol`): search for the next
   quote with `indexOf` and count the backslashes right before it, where D1840 searched for the next backslash too and
   went back to the byte loop at each one. Escaped quotes closer than 4 bytes apart (JSON written as text, a run of
   `\"`) are read byte by byte in a window that doubles while they stay that close. On 1 MiB strings (µs, three
   rounds): plain text 16 against 30 before, text with an escaped newline and quote every line (tool output) 350-430
   against 850-1,000, JSON written as text 1,190-1,360 against 1,460, a run of `\"` 690-710 against 970, Latin and
   emoji text 73-88 against 1,445. The protocol's oracle test (6,000 seeded bodies against the plain loop), its 8 MiB
   linear-time test and `shape.test.ts`'s 20,000 bodies (text against bytes) all pass.
2. **Long plain strings are spliced out of the parse** (`parseJsonText`): the shape scan records strings of 32 KiB or
   more; one with no backslash and no control character (one regex test, 61 µs a MiB) is exactly its characters, so
   when such strings are at least half the reply and it holds at most 4,096 values, each is replaced by a placeholder,
   the rest is parsed, and the placeholders are put back as slices of the reply (JSC and V8 share the buffer: no copy).
   The placeholder carries a per-process random mark; one found twice or missing (a duplicate key drops one) falls
   back to the plain parse. `json.test.ts` compares it with `JSON.parse` on 6,000 seeded replies (keys, `__proto__`,
   duplicates, escapes, control characters, truncation): 0 differences; and checks the value is a slice.

`mcp-profile.bench.ts 3 eden,base,sdk` (`base` = main's `src/mcp/` at 60712533a, D1860), CPU per call in µs,
medians of three interleaved rounds; plain text (the bench's default):

| JSON reply | In flight | D1860 | D1870 | SDK 1.x | D1870 / D1860 | D1870 / SDK |
|---|---|---|---|---|---|---|
| `tools/call` 1 KB | 1 | 67.0 | 94.3 | 132.4 | 1.41 | 0.71 |
| | 16 | 47.8 | 45.0 | 55.0 | 0.94 | 0.82 |
| | 256 | 56.0 | 59.4 | 55.0 | 1.06 | 1.08 |
| `tools/call` 64 KB | 1 | 136.6 | 124.0 | 176.0 | 0.91 | 0.70 |
| | 16 | 106.6 | 75.5 | 134.2 | 0.71 | 0.56 |
| | 256 | 118.7 | 109.3 | 108.1 | 0.92 | 1.01 |
| `tools/call` 1 MB | 1 | 1,212 | 983 | 1,280 | 0.81 | **0.77** |
| | 16 | 1,120 | 817 | 1,120 | 0.73 | **0.73** |
| | 256 | 1,778 | 1,331 | 1,428 | 0.75 | 0.93 |
| `tools/call` 4 MB | 1 | 3,888 | 2,918 | 4,520 | 0.75 | 0.65 |
| | 16 | 3,601 | 3,192 | 4,210 | 0.89 | 0.76 |
| `tools/list` 1 KB-4 MB | 1, 16 | | | | 0.76-1.07 | 0.53-0.87 |
| `tools/list` | 256 | | | | 0.88-1.00 | 0.62-0.68 |

Every JSON cell at 1 and 16 in flight is now under the SDK's, the target; at 256 in flight `tools/call` reads 0.93 at
1 MB and 1.01-1.08 at 1 KB and 64 KB, where D1860 read 0.90-0.99 (one run each: at 256 in flight the cells are
scheduler-bound and move 10-20% between runs). The 1 KB one-at-a-time cell reads 1.41 of D1860's in this run (94
against 67 µs) and 0.71 of the SDK's; D1860's own run had it at 58.7, so it is that cell's spread, and nothing on the
1 KB path changed but one `performance.now()` per reply. SSE cells, whose path changed only in bookkeeping, read
0.81-1.15 of D1860's; five further interleaved rounds of the SSE cells alone (1 KB, 64 KB, 1 MB at 1 in flight; 1 MB
at 16) put the medians at 1.04, 0.98 (eight rounds: 198 against 203), 0.99 and 1.06, so no change past noise. Time to
the first call: 15.1-38.9 ms against 37.1-86.2 (D1860) and 98.9-125.2 (SDK); the machine was loaded.

With text written as tool output is (`MCP_PROFILE_TEXT=lines`: lines of 80 characters, so an escaped newline in each
and an escaped quote pair, which the splice does not take), the same bench at 64 KB and 1 MB:

| JSON `tools/call` | In flight | D1860 | D1870 | SDK 1.x | D1870 / D1860 | D1870 / SDK |
|---|---|---|---|---|---|---|
| 64 KB | 1 | 252.8 | 210.4 | 203.0 | 0.83 | 1.04 |
| | 16 | 212.9 | 179.2 | 190.7 | 0.84 | 0.94 |
| | 256 | 217.4 | 192.0 | 152.7 | 0.88 | 1.26 |
| 1 MB | 1 | 3,011 | 2,280 | 1,747 | 0.76 | **1.30** |
| | 16 | 3,381 | 2,259 | 1,995 | 0.67 | **1.13** |
| | 256 | 3,905 | 2,801 | 2,477 | 0.72 | 1.13 |

So with text as tool output writes it, ours was 1.12-1.72x the SDK's CPU on a JSON `tools/call` (worse than the
plain-text bench showed, since D1840's scan went back to the byte loop at every escape), and is now 0.94-1.30x: better
by a quarter to a third, and still a loss at 1 MB. What is left is the scan's search per escaped quote (about 13 ns
each; two a line here) and the string `text()` makes, which `res.json()` never does. SSE `tools/call` on the same
text: 0.82-0.95 of D1860's, 0.87-1.16 of the SDK's. (`tools/list` replies are not text-filled, so they repeat the cells
above: 0.82-1.13 of D1860's, 0.41-0.78 of the SDK's.)

### What else was lost, and what was added

- **Flood caps** (D1872). Real servers: the SDK's example servers ask 0-2 requests a tool call (an elicitation, a
  sampling), each awaited, and send notifications freely (50 a call in one example, unbounded in another), which were
  never counted; the captured connector results (`src/fixtures/mcp-results.json`) hold none of either. No
  well-behaved server sends a malformed message. So the caps became budgets: server requests 100 plus 10 for each
  second the reply has been open (a long agentic tool may ask once a second as long as it runs), bad messages 100
  plus one per KiB of messages (a junk reply's CPU stays proportional to its bytes); `limits` on the transport sets
  them. The hostile cases still fail at once: 20,000 pings sent together fail after 100 with at most 16 answers, and
  2,000,000 one-byte junk events after 100 (`adversarial.test.ts`, unchanged); paced pings (40, 5 ms apart, with a
  burst of 10 and 200 a second) pass where the same 40 at once fail (`server-messages.test.ts`).
- **OAuth** (D1874, `oauth.ts`, opt-in, not imported by `index.ts`: a test walks the imports). The flow and its
  checks are in the README; it is tested against the SDK's own authorization server (`mcpAuthRouter` with its demo
  provider under express, which verifies PKCE and the resource): discovery from the 401, registration, the
  authorization URL with S256 and `resource`, the callback, the code exchange, and a tool call with the token.
  Adversarial cases against fakes, each failing when its check is removed: a mismatched issuer, metadata over 64 KiB
  (declared, or streamed: refused within 1 MiB of a 64 MiB stream), a redirect to another origin (nothing reaches it;
  a token POST follows no redirect at all), plain HTTP outside loopback for the server, the issuer and each endpoint,
  metadata for another resource, no S256, a forged, reused or erroring state and a mismatched `iss`, a token offered
  to another origin's transport (no `Authorization` sent) or quoted back in an error (the error is fixed words), and
  20 callers with an expired token causing one refresh.
- **Resumability and the GET stream** (D1873, opt-in, off on Eden's path). Against the SDK's polling pattern (a tool
  whose stream the server closes midway, replayed from its event store), ours with `resume` answers after one GET
  with `Last-Event-ID` and gets every notification in order; without it the call fails as before and no GET is sent.
  The GET stream receives the SDK server's notifications and reopens from the last event when the server closes it.
  Bounds, each tested: reconnects of a reply (3 by default) within its deadline and its cap counted across
  connections, `retry:` capped by `maxDelayMs`, an event id that is not short visible ASCII never sent back, a GET
  stream flood failed by the budget and not reopened, a response on it counted as unasked, an oversized event ending
  the connection, reopening bounded by `maxRetries` misses in a row (junk is not a delivery) and never sooner than
  500 ms whatever `retry:` says (a first version counted junk as a delivery and honoured `retry: 0`, which reopened
  as fast as the server closed: caught in self-review, now a test).
- **Server-request handlers** (D1875). `setRequestHandler` answers sampling, roots and elicitation against the SDK's
  server (each a real `sendRequest` from a tool), an `McpError` reaches the server with its code and message, any
  other throw as a bare "Internal error" (a secret in its text is not sent), and the server's cancellation aborts the
  handler; at most 16 answers at once with the pings, and the budget above.

**After the independent review** (approved at a4a5e2487, with findings fixed on the branch): a 401's `resource_metadata` could make the client GET any URL, a loopback `http:` one included (a remote server's blind GET to a local admin URL): the hint must now be on the server's origin unless the caller lists others, and every URL a server's metadata names must be HTTPS and no more local than the server (loopback, private, link-local and unique-local addresses refused for a remote server, IPv4-mapped forms included). The GET stream's server-request budget no longer restarts at each reconnect, and each connection must open within `timeoutMs`. A shared refresh no longer fails all its callers when the first gives up. A POST's reply takes at most 200 server requests (the time allowance alone allowed 700 at the 60 s deadline). The splice's mark is new for each reply. A callback without `iss` is refused when the issuer says it sends one.

Still lost, and why: the **legacy HTTP+SSE transport** (2024-11-05; servers still on it are rare and the SDKs keep it
for compatibility only); **output-schema validation** of `structuredContent` (it needs a JSON Schema validator, the
SDKs' largest dependency, and a caller that wants it can run its own on the result); a **callback listener** for OAuth
and the client ID metadata documents of 2025-11-25 (left to the caller and not implemented); on Node, the JSON read
still decodes bytes and parses (`text()` there drops two byte-order marks where `TextDecoder` drops one, D1860), so
the splice is Bun's only (the scan itself is not: Node's `Uint8Array.prototype.indexOf` reads a byte at a time, 627 µs a MiB against 16 for `Buffer`'s, so off Bun the scan calls `Buffer.prototype.indexOf`, which takes the shape check of a 1 MiB reply on Node 22.22 from 805-926 µs to 21-26 for plain text, 1,969-2,537 to 396-585 for tool output, and 3,497-4,332 to 20-24 for Latin and emoji text); and against `res.json()` itself, a reply whose long strings all hold escapes still costs
ours the extra string `text()` makes (1.13-1.30x the SDK's CPU at 1 MB, 0.94-1.26x at 64 KB, above: a search per escaped quote, and the string `text()` makes).


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
