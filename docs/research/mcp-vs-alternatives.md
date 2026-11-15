# Eden's MCP client against the alternatives (2026-11-14, D1860, D1870-D1875 and D1900-D1908: adopted)

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


## Reading long replies (D1900-D1907)

A third pass (2026-11-15) at the cells D1870 left above the SDK: JSON replies whose long strings hold escapes (tool
output, JSON written as text) and replies that are mostly numbers, which the benches had not measured. Both benches
now take the result's text shape (D1905): `plain` (the earlier default), `lines` (tool output: 80-character lines, so
an escaped newline and an escaped quote pair in each), `escapes` (JSON written as text, an escape every few bytes),
`unicode` (Latin, CJK and emoji: a two-byte string) and `numbers` (a `structuredContent` array of numbers).

**What changed.** A reply of 16 KiB or more takes a long-reply path (`scanText`, `readers.ts`), and every read is
bounded before any parse of the whole:

- A long string with escapes, crossed 4,096 characters quote by quote, has its end guessed by reading the reply
  backward from its end, and the guess is proven by reading that one string whole: `JSON.parse` of the literal (a
  literal cannot nest or hold values, so that parse is bounded by its length), or on Bun a byte unescaper when its
  escapes are a dozen bytes apart or closer. The value is spliced into the parse of the rest. When no end can be
  guessed or the guess is wrong, the rest is bounded by counting `[`, `{` and `,` (D1900, D1901).
- An array of plain numbers (at most 15 significant digits, a power of ten within 22) is read as the scan reaches it;
  one IEEE operation rounds each exactly as `JSON.parse` does (D1902).
- A reply that is mostly structure stops the scan after a step budget and is bounded by the same count (D1903).
- `parseJsonBytes` decodes a long body first, so Node, SSE and stdio take the same path (D1904).

`long-reply.test.ts` holds every answer to the plain path's (the vendored shape check, then `JSON.parse`) on 110,000
seeded bodies with the thresholds lowered and small bounds (0 differences; 50,000 more under Node 22.22, 0), checks
the readers against `JSON.parse`, and holds three hostile shapes to linear CPU; breaking the `[` bound, the 15-digit
limit or the surrogate check each fails it. Two quadratic first versions (numbers encoded up to the first `]`; a
backslash searched for again for every long string) were caught in self-review and are covered there. The no-model
eval is unchanged (precision 0.65, recall 0.52, falseFireRate 0, the `acting` block as on main) and the funnel against
main's `src/mcp/` reads hidden +0 −0, decoys +0 −0.

**Profile** (`MCP_PROFILE_TEXT=plain,lines,escapes,unicode,numbers mcp-profile.bench.ts 3 eden,base,sdk`, `base` =
main's `src/mcp/` before D1900; CPU µs a `tools/call`, medians of three interleaved rounds; load 6.9 falling to 1.6,
and a cold check overlapped part of the run):

| Text | Reply | Size | In flight | D1900 | before | SDK 1.x | D1900 / SDK | before / SDK |
|---|---|---|---|---|---|---|---|---|
| plain | JSON | 64 KB | 1 | 136.3 | 156.7 | 152.0 | 0.90 | 1.03 |
| plain | JSON | 64 KB | 16 | 87.1 | 89.8 | 127.1 | 0.69 | 0.71 |
| plain | JSON | 64 KB | 256 | 123.1 | 113.7 | 118.4 | 1.04 | 0.96 |
| plain | JSON | 1 MB | 1 | 982.7 | 951.8 | 1184.2 | 0.83 | 0.80 |
| plain | JSON | 1 MB | 16 | 886.2 | 804.8 | 1126.7 | 0.79 | 0.71 |
| plain | JSON | 1 MB | 256 | 1259.9 | 1390.6 | 1467.0 | 0.86 | 0.95 |
| plain | SSE | 64 KB | 1 | 211.6 | 193.4 | 230.5 | 0.92 | 0.84 |
| plain | SSE | 64 KB | 16 | 180.9 | 203.9 | 250.1 | 0.72 | 0.82 |
| plain | SSE | 64 KB | 256 | 178.1 | 212.0 | 229.5 | 0.78 | 0.92 |
| plain | SSE | 1 MB | 1 | 1983.3 | 2406.4 | 2429.5 | 0.82 | 0.99 |
| plain | SSE | 1 MB | 16 | 1608.6 | 1864.1 | 2097.9 | 0.77 | 0.89 |
| plain | SSE | 1 MB | 256 | 2043.9 | 2192.4 | 2405.2 | 0.85 | 0.91 |
| lines | JSON | 64 KB | 1 | 198.4 | 211.3 | 190.1 | 1.04 | 1.11 |
| lines | JSON | 64 KB | 16 | 180.9 | 158.8 | 164.0 | 1.10 | 0.97 |
| lines | JSON | 64 KB | 256 | 178.8 | 175.7 | 149.0 | 1.20 | 1.18 |
| lines | JSON | 1 MB | 1 | 1958.4 | 2246.5 | 1699.9 | 1.15 | 1.32 |
| lines | JSON | 1 MB | 16 | 1983.2 | 2204.5 | 1714.6 | 1.16 | 1.29 |
| lines | JSON | 1 MB | 256 | 2561.4 | 2861.9 | 2381.5 | 1.08 | 1.20 |
| lines | SSE | 64 KB | 1 | 286.5 | 259.1 | 242.3 | 1.18 | 1.07 |
| lines | SSE | 64 KB | 16 | 240.2 | 222.1 | 299.5 | 0.80 | 0.74 |
| lines | SSE | 64 KB | 256 | 236.4 | 250.3 | 259.1 | 0.91 | 0.97 |
| lines | SSE | 1 MB | 1 | 2851.0 | 3644.9 | 3229.3 | 0.88 | 1.13 |
| lines | SSE | 1 MB | 16 | 2778.4 | 3084.6 | 2940.7 | 0.94 | 1.05 |
| lines | SSE | 1 MB | 256 | 3188.8 | 3782.0 | 3194.5 | 1.00 | 1.18 |
| escapes | JSON | 64 KB | 1 | 351.2 | 609.3 | 359.6 | 0.98 | 1.69 |
| escapes | JSON | 64 KB | 16 | 282.8 | 555.7 | 446.7 | 0.63 | 1.24 |
| escapes | JSON | 64 KB | 256 | 349.3 | 572.7 | 392.0 | 0.89 | 1.46 |
| escapes | JSON | 1 MB | 1 | 3830.9 | 7819.6 | 4890.9 | 0.78 | 1.60 |
| escapes | JSON | 1 MB | 16 | 3340.6 | 7969.0 | 5362.6 | 0.62 | 1.49 |
| escapes | JSON | 1 MB | 256 | 4538.1 | 8825.0 | 6002.7 | 0.76 | 1.47 |
| escapes | SSE | 64 KB | 1 | 430.9 | 740.4 | 641.2 | 0.67 | 1.15 |
| escapes | SSE | 64 KB | 16 | 429.2 | 660.9 | 587.5 | 0.73 | 1.12 |
| escapes | SSE | 64 KB | 256 | 391.3 | 639.7 | 584.9 | 0.67 | 1.09 |
| escapes | SSE | 1 MB | 1 | 4785.7 | 9508.6 | 7852.7 | 0.61 | 1.21 |
| escapes | SSE | 1 MB | 16 | 3974.4 | 8473.9 | 7085.9 | 0.56 | 1.20 |
| escapes | SSE | 1 MB | 256 | 5463.4 | 9822.9 | 8313.2 | 0.66 | 1.18 |
| unicode | JSON | 64 KB | 1 | 224.8 | 217.1 | 281.8 | 0.80 | 0.77 |
| unicode | JSON | 64 KB | 16 | 226.9 | 173.3 | 309.2 | 0.73 | 0.56 |
| unicode | JSON | 64 KB | 256 | 215.4 | 188.8 | 266.8 | 0.81 | 0.71 |
| unicode | JSON | 1 MB | 1 | 2499.4 | 2356.8 | 3468.0 | 0.72 | 0.68 |
| unicode | JSON | 1 MB | 16 | 2406.3 | 2449.3 | 3421.6 | 0.70 | 0.72 |
| unicode | JSON | 1 MB | 256 | 2963.0 | 3254.1 | 4125.9 | 0.72 | 0.79 |
| unicode | SSE | 64 KB | 1 | 292.9 | 253.7 | 369.3 | 0.79 | 0.69 |
| unicode | SSE | 64 KB | 16 | 268.4 | 253.6 | 378.1 | 0.71 | 0.67 |
| unicode | SSE | 64 KB | 256 | 238.7 | 247.5 | 286.6 | 0.83 | 0.86 |
| unicode | SSE | 1 MB | 1 | 3294.7 | 3107.3 | 4654.2 | 0.71 | 0.67 |
| unicode | SSE | 1 MB | 16 | 2740.4 | 2635.4 | 3966.9 | 0.69 | 0.66 |
| unicode | SSE | 1 MB | 256 | 3787.5 | 3465.4 | 4026.2 | 0.94 | 0.86 |
| numbers | JSON | 64 KB | 1 | 342.9 | 585.5 | 388.5 | 0.88 | 1.51 |
| numbers | JSON | 64 KB | 16 | 341.5 | 559.3 | 446.6 | 0.76 | 1.25 |
| numbers | JSON | 64 KB | 256 | 290.8 | 557.8 | 369.6 | 0.79 | 1.51 |
| numbers | JSON | 1 MB | 1 | 4049.9 | 7710.2 | 5462.8 | 0.74 | 1.41 |
| numbers | JSON | 1 MB | 16 | 4591.1 | 7666.9 | 4948.1 | 0.93 | 1.55 |
| numbers | JSON | 1 MB | 256 | 4875.0 | 8767.6 | 5543.4 | 0.88 | 1.58 |
| numbers | SSE | 64 KB | 1 | 449.8 | 625.7 | 562.5 | 0.80 | 1.11 |
| numbers | SSE | 64 KB | 16 | 409.2 | 550.9 | 581.4 | 0.70 | 0.95 |
| numbers | SSE | 64 KB | 256 | 425.1 | 623.2 | 493.3 | 0.86 | 1.26 |
| numbers | SSE | 1 MB | 1 | 5527.8 | 8654.1 | 6727.8 | 0.82 | 1.29 |
| numbers | SSE | 1 MB | 16 | 4869.5 | 7934.6 | 6762.2 | 0.72 | 1.17 |
| numbers | SSE | 1 MB | 256 | 5779.8 | 8812.5 | 6841.2 | 0.84 | 1.29 |

`tools/list` cells (not text-filled) read 0.54-1.00 of the SDK's. Across all 108 cells of the run, D1900 is below
the SDK in 93.

**Against the alternatives** (`MCP_COMPARE_TEXT=plain,lines,escapes,unicode,numbers mcp-compare.bench.ts perf 1`,
three separate one-round runs with the client order rotated, medians; CPU µs a `tools/call`, all threads; bold is the
lowest in the row; the last column is ours over the cheapest other client):

| Text | Reply | Size | In flight | eden | sdk | sdk2 | pi | aisdk | python | eden / best other |
|---|---|---|---|---|---|---|---|---|---|---|
| plain | JSON | 1 KB | 1 | **87** | 120 | 192 | 108 | 132 | 2,673 | 0.80 |
| plain | JSON | 1 KB | 16 | **46** | 58 | 93 | 79 | 67 | 2,975 | 0.79 |
| plain | JSON | 1 KB | 256 | 59 | 58 | 120 | **53** | 82 | 2,976 | 1.12 |
| plain | JSON | 64 KB | 1 | **137** | 158 | 259 | 212 | 187 | 4,213 | 0.87 |
| plain | JSON | 64 KB | 16 | **132** | 173 | 177 | 196 | 160 | 4,173 | 0.83 |
| plain | JSON | 64 KB | 256 | **115** | 142 | 166 | 187 | 132 | 4,150 | 0.87 |
| plain | JSON | 1 MB | 1 | 1,056 | **996** | 1,266 | 2,705 | 1,196 | 25,884 | 1.06 |
| plain | JSON | 1 MB | 16 | **827** | 1,188 | 1,284 | 1,857 | 1,132 | 26,988 | 0.73 |
| plain | JSON | 1 MB | 256 | **1,316** | 1,592 | 1,577 | 2,022 | 1,504 | 26,070 | 0.88 |
| plain | SSE | 1 KB | 1 | **98** | 110 | 163 | 127 | 148 | 4,241 | 0.89 |
| plain | SSE | 1 KB | 16 | **53** | 74 | 102 | 66 | 100 | 4,085 | 0.80 |
| plain | SSE | 1 KB | 256 | **52** | 73 | 134 | 62 | 133 | 4,225 | 0.85 |
| plain | SSE | 64 KB | 1 | **201** | 234 | 300 | 583 | 320 | 6,144 | 0.86 |
| plain | SSE | 64 KB | 16 | **173** | 303 | 320 | 561 | 351 | 6,128 | 0.57 |
| plain | SSE | 64 KB | 256 | **174** | 228 | 260 | 513 | 263 | 6,042 | 0.76 |
| plain | SSE | 1 MB | 1 | **2,148** | 2,936 | 3,135 | 18,424 | 3,305 | 37,174 | 0.73 |
| plain | SSE | 1 MB | 16 | **1,760** | 2,348 | 2,497 | 14,882 | 2,437 | 36,684 | 0.75 |
| plain | SSE | 1 MB | 256 | **1,820** | 2,406 | 2,463 | 14,105 | 2,424 | 39,039 | 0.76 |
| lines | JSON | 1 KB | 1 | 105 | **94** | 114 | 104 | 99 | 2,910 | 1.11 |
| lines | JSON | 1 KB | 16 | **43** | 48 | 81 | 52 | 62 | 3,425 | 0.90 |
| lines | JSON | 1 KB | 256 | **38** | 57 | 84 | 64 | 74 | 3,143 | 0.66 |
| lines | JSON | 64 KB | 1 | 200 | **176** | 236 | 276 | 186 | 4,217 | 1.14 |
| lines | JSON | 64 KB | 16 | 166 | **153** | 207 | 215 | 174 | 4,564 | 1.09 |
| lines | JSON | 64 KB | 256 | 188 | **143** | 177 | 238 | 181 | 4,392 | 1.31 |
| lines | JSON | 1 MB | 1 | 2,288 | **1,656** | 1,794 | 3,261 | 1,754 | 27,304 | 1.38 |
| lines | JSON | 1 MB | 16 | 2,069 | **1,890** | 1,911 | 2,786 | 1,967 | 28,101 | 1.09 |
| lines | JSON | 1 MB | 256 | 2,572 | **2,323** | 2,344 | 3,003 | 2,354 | 27,631 | 1.11 |
| lines | SSE | 1 KB | 1 | **103** | 110 | 160 | 103 | 145 | 4,210 | 1.00 |
| lines | SSE | 1 KB | 16 | **50** | 64 | 101 | 67 | 88 | 3,874 | 0.78 |
| lines | SSE | 1 KB | 256 | **50** | 92 | 101 | 63 | 86 | 4,109 | 0.80 |
| lines | SSE | 64 KB | 1 | **282** | 305 | 382 | 604 | 401 | 6,018 | 0.92 |
| lines | SSE | 64 KB | 16 | **257** | 313 | 353 | 590 | 430 | 6,516 | 0.82 |
| lines | SSE | 64 KB | 256 | **240** | 259 | 277 | 632 | 310 | 6,462 | 0.92 |
| lines | SSE | 1 MB | 1 | **3,250** | 3,878 | 3,881 | 19,963 | 4,572 | 40,346 | 0.84 |
| lines | SSE | 1 MB | 16 | **2,749** | 3,283 | 3,394 | 15,825 | 4,091 | 40,469 | 0.84 |
| lines | SSE | 1 MB | 256 | **3,008** | 3,137 | 3,119 | 15,214 | 3,821 | 40,926 | 0.96 |
| escapes | JSON | 1 KB | 1 | **96** | 102 | 127 | 109 | 109 | 2,678 | 0.95 |
| escapes | JSON | 1 KB | 16 | **54** | 63 | 94 | 64 | 76 | 2,909 | 0.86 |
| escapes | JSON | 1 KB | 256 | **51** | 61 | 93 | 73 | 66 | 2,934 | 0.83 |
| escapes | JSON | 64 KB | 1 | **326** | 467 | 556 | 566 | 481 | 4,653 | 0.70 |
| escapes | JSON | 64 KB | 16 | **328** | 450 | 483 | 511 | 460 | 4,775 | 0.73 |
| escapes | JSON | 64 KB | 256 | **294** | 406 | 415 | 469 | 444 | 4,898 | 0.72 |
| escapes | JSON | 1 MB | 1 | **3,345** | 5,382 | 5,258 | 7,193 | 5,464 | 30,912 | 0.64 |
| escapes | JSON | 1 MB | 16 | **3,420** | 5,432 | 5,584 | 6,505 | 5,174 | 30,391 | 0.66 |
| escapes | JSON | 1 MB | 256 | **4,532** | 6,349 | 6,284 | 7,508 | 6,214 | 32,390 | 0.73 |
| escapes | SSE | 1 KB | 1 | **106** | 118 | 169 | 120 | 164 | 4,090 | 0.90 |
| escapes | SSE | 1 KB | 16 | **53** | 91 | 106 | 99 | 120 | 4,397 | 0.58 |
| escapes | SSE | 1 KB | 256 | **59** | 79 | 123 | 90 | 122 | 4,253 | 0.75 |
| escapes | SSE | 64 KB | 1 | **442** | 595 | 650 | 1,023 | 950 | 6,475 | 0.74 |
| escapes | SSE | 64 KB | 16 | **395** | 565 | 664 | 937 | 1,000 | 6,603 | 0.70 |
| escapes | SSE | 64 KB | 256 | **371** | 464 | 580 | 980 | 811 | 6,742 | 0.80 |
| escapes | SSE | 1 MB | 1 | **4,969** | 8,481 | 8,404 | 36,802 | 11,906 | 50,087 | 0.59 |
| escapes | SSE | 1 MB | 16 | **4,758** | 6,934 | 7,864 | 24,714 | 11,126 | 46,729 | 0.69 |
| escapes | SSE | 1 MB | 256 | **5,232** | 7,480 | 7,613 | 25,469 | 11,524 | 45,704 | 0.70 |
| unicode | JSON | 1 KB | 1 | 89 | 92 | 120 | **87** | 97 | 2,746 | 1.03 |
| unicode | JSON | 1 KB | 16 | **37** | 48 | 84 | 56 | 58 | 3,042 | 0.78 |
| unicode | JSON | 1 KB | 256 | **43** | 56 | 99 | 56 | 70 | 3,297 | 0.77 |
| unicode | JSON | 64 KB | 1 | **191** | 318 | 335 | 289 | 361 | 4,521 | 0.66 |
| unicode | JSON | 64 KB | 16 | **206** | 302 | 345 | 299 | 311 | 4,634 | 0.69 |
| unicode | JSON | 64 KB | 256 | **199** | 299 | 308 | 260 | 300 | 4,785 | 0.76 |
| unicode | JSON | 1 MB | 1 | **2,363** | 3,421 | 3,457 | 6,493 | 3,300 | 29,277 | 0.72 |
| unicode | JSON | 1 MB | 16 | **2,509** | 3,683 | 3,480 | 5,489 | 3,462 | 29,305 | 0.72 |
| unicode | JSON | 1 MB | 256 | **3,157** | 4,072 | 4,400 | 6,131 | 4,313 | 31,693 | 0.78 |
| unicode | SSE | 1 KB | 1 | **88** | 101 | 153 | 128 | 148 | 4,289 | 0.87 |
| unicode | SSE | 1 KB | 16 | **45** | 60 | 117 | 99 | 111 | 4,051 | 0.75 |
| unicode | SSE | 1 KB | 256 | **48** | 73 | 149 | 86 | 106 | 4,159 | 0.66 |
| unicode | SSE | 64 KB | 1 | **302** | 305 | 386 | 1,483 | 460 | 6,625 | 0.99 |
| unicode | SSE | 64 KB | 16 | **327** | 337 | 419 | 1,336 | 480 | 7,010 | 0.97 |
| unicode | SSE | 64 KB | 256 | **276** | 282 | 334 | 1,311 | 374 | 6,796 | 0.98 |
| unicode | SSE | 1 MB | 1 | **3,448** | 3,795 | 4,957 | 63,050 | 4,968 | 57,547 | 0.91 |
| unicode | SSE | 1 MB | 16 | **3,205** | 3,443 | 4,050 | 43,864 | 4,467 | 58,478 | 0.93 |
| unicode | SSE | 1 MB | 256 | **3,679** | 3,842 | 4,130 | 42,228 | 5,037 | 62,659 | 0.96 |
| numbers | JSON | 1 KB | 1 | 103 | **90** | 154 | 104 | 107 | 2,756 | 1.15 |
| numbers | JSON | 1 KB | 16 | **53** | 56 | 97 | 63 | 81 | 2,880 | 0.94 |
| numbers | JSON | 1 KB | 256 | **51** | 54 | 109 | 73 | 80 | 3,034 | 0.95 |
| numbers | JSON | 64 KB | 1 | **376** | 421 | 532 | 528 | 466 | 4,997 | 0.89 |
| numbers | JSON | 64 KB | 16 | **347** | 413 | 450 | 461 | 369 | 5,241 | 0.94 |
| numbers | JSON | 64 KB | 256 | 348 | **314** | 452 | 450 | 344 | 5,471 | 1.11 |
| numbers | JSON | 1 MB | 1 | 4,862 | **4,414** | 4,972 | 6,747 | 5,173 | 50,023 | 1.10 |
| numbers | JSON | 1 MB | 16 | **4,206** | 4,672 | 4,971 | 5,794 | 4,893 | 44,348 | 0.90 |
| numbers | JSON | 1 MB | 256 | **4,796** | 5,381 | 5,701 | 6,419 | 5,493 | 50,643 | 0.89 |
| numbers | SSE | 1 KB | 1 | **98** | 113 | 182 | 126 | 132 | 4,291 | 0.87 |
| numbers | SSE | 1 KB | 16 | **44** | 85 | 129 | 89 | 112 | 4,276 | 0.52 |
| numbers | SSE | 1 KB | 256 | **50** | 101 | 135 | 82 | 113 | 4,294 | 0.61 |
| numbers | SSE | 64 KB | 1 | **498** | 616 | 575 | 1,190 | 555 | 8,528 | 0.90 |
| numbers | SSE | 64 KB | 16 | **387** | 620 | 676 | 1,135 | 619 | 8,985 | 0.63 |
| numbers | SSE | 64 KB | 256 | **371** | 570 | 511 | 1,180 | 575 | 8,942 | 0.73 |
| numbers | SSE | 1 MB | 1 | **5,503** | 7,483 | 7,307 | 23,866 | 6,965 | 86,021 | 0.79 |
| numbers | SSE | 1 MB | 16 | **4,962** | 6,689 | 6,726 | 18,825 | 6,232 | 82,887 | 0.80 |
| numbers | SSE | 1 MB | 256 | **5,442** | 6,904 | 6,522 | 17,985 | 6,456 | 84,515 | 0.84 |

Ours is the cheapest client in 77 of the 90 cells (three rounds; loads 1.6-9.8 over the 35 minutes of each, the machine
shared with another agent). Every `escapes` and `unicode` cell from 64 KB up and every SSE cell is ours (tool output at
1 KB one at a time ties pi at 103 µs); JSON written as text costs 0.59-0.73x the cheapest other client at 1 MB, numbers
0.79-1.10x. The 13 losses: `lines` in JSON at 1 KB, 64 KB and 1 MB (1.09-1.38x the SDK 1.x; below), plain JSON at 1 MB
one at a time (1.06x) and at 1 KB with 256 in flight (1.12x pi), numbers in JSON one at a time at 1 KB and 1 MB (1.15x,
1.10x) and at 64 KB with 256 in flight (1.11x), and unicode at 1 KB one at a time (1.03x pi). Time to the first call
(spawn to answer, medians of three): eden 35 ms, pi 74, aisdk 119, sdk 120, sdk2 127, python 706.

**Where it still loses** (D1900's run; D1908's, below, supersedes these numbers).

- **Tool output in JSON** (`lines`): 1.04-1.20x the SDK's CPU at 64 KB and 1.08-1.16x at 1 MB in the profile run (before
  D1900, 1.18-1.32x at 1 MB), and 1.09-1.38x the SDK in the comparison run above. The scan now crosses the string in one
  guessed read and is about 1% of the call; the parse is 85% of it (`--cpu-prof-md`). Bun's `res.json()`, which the
  other clients use, parses the received bytes without making the string our `text()` makes. Taking `res.json()` and
  checking the depth and size after the parse would close it, and was refused (D1871): the bound is on what a hostile
  reply can make the parse cost, and 1 MB of nested arrays costs `json()` 108 ms. Reading bytes and decoding ourselves
  is slower than `text()` (D1906).
- **1 KB replies with escapes**: 1.22-1.46x the SDK's CPU in the profile run, a difference of 10-30 µs a call. Short
  replies take the plain path (the long-reply path does not pay below 16 KiB), and these cells move that much between
  runs.

## The review's fixes (D1908)

An independent review of D1900-D1907 found no answer that differed from main's (230,000 fuzzed bodies) but six cost
findings: a reader call for every `[` before a digit (a `[[n,2,3],...]` matrix at 2.7-2.9x main's CPU, a refused 2-8
MB number flood at 11-12x), peak memory at 16 MiB over main's, rows of objects and plain text at 1 MB over main's, a
4 MiB scratch buffer that kept the last reply's text, and three long lines here. D1908 fixes each; the answers are
unchanged (five fresh seeds of the review's fuzz, 40,000 bodies each, and `long-reply.test.ts`: 0 differences).

**Method.** `parseJsonText` and `parseJsonBytes` timed in one process against main's `src/mcp/json.ts` and a copy of it
(the control): each cell a batch of about 8 ms of process CPU, the arms interleaved and their order alternating, a
forced GC before each batch, 15 rounds, the median of the per-round ratios; load 1.5-3 on the shared 4-core machine.
"Before" is D1900 as reviewed (189427c31), measured the same way in the same session. Peak RSS is VmHWM after
`clear_refs`, above the baseline, median of 5 processes per arm.

**Short number arrays** (CPU over main's, text path; the control read 0.95-1.06):

| Shape | Size | Before | After |
|---|---|---|---|
| `[[n,2,3],...]` | 64 KB | 2.76 | 0.95-1.06 |
| `[[n,2,3],...]` | 1 MB | 2.50 | 0.98-1.02 |
| `[[1],[1],...]` | 64 KB | 3.97 | 0.98-1.28 |
| `[[1],[1],...]` | 1 MB | 2.41 | 0.99-1.09 |
| refused `[1,1,...]` | 2-16 MB, bytes | 14.2-23.8 ms (main 3.1-3.6) | 3.2-3.5 ms |
| refused `[1,1,...]` | 2-16 MB, text | 12.3-16.6 ms (main 5.7-6.6) | 2.6-5.0 ms |

**Peak memory at 16 MiB** (MB above baseline; "before" from the review):

| Shape | Path | main | before | after |
|---|---|---|---|---|
| numbers, accepted | text | 28.8 | 41-46 | 21.3 |
| numbers, accepted | bytes | 28.1 | 41-46 | 28.0 |
| number flood, refused | text | 23.2 | 51-62 | 23.3 |
| number flood, refused | bytes | 6.7 | 51-62 | 6.3 |
| flood after a multi-byte string, refused | text / bytes | 40.2 / 6.9 | | 39.7 / 6.3 |
| plain text | text / bytes | 18.1 / 33.7 | | 17.5 / 17.6 |
| multi-byte text | text / bytes | 15.8 / 29.2 | | 15.2 / 15.3 |
| tool output with escapes | text / bytes | 66.2 / 65.8 | | 57.8 / 68.6 |
| multi-byte tool output with escapes | text / bytes | 72.5 / 72.8 | | 61.8 / 62.6 |
| depth bomb, refused | text / bytes | 17.3 / 1.2 | | 17.2 / 0.9 |

Single runs of the escaped shapes spread 59-70 MB for both main and the branch (the collector's timing); the bytes
cell's medians over 8 more runs each were 65.9 for main and 65.2 for the branch.

**Structured and plain replies** (CPU over main's; text path, then bytes):

| Shape | Size | Before | After (text) | After (bytes) |
|---|---|---|---|---|
| rows of objects | 64 KB | 1.12-1.26 | 1.00-1.06 | 1.02 |
| rows of objects | 1 MB | 1.08-1.34 | 0.98-1.02 | 0.98 |
| plain text | 64 KB | 1.33-1.60 | 1.00-1.16 (control 1.05) | 0.58 |
| plain text | 1 MB | 1.03-1.22 | 1.00-1.03 | 0.81 |
| multi-byte text | 786 KB | 1.12 | 1.00 | 1.03 (control 1.05) |
| tool output, JSON as text | 1.4 MB | 0.29-0.34 | 0.29-0.36 | 0.38 |
| numbers | 1 MB | 0.39-0.54 | 0.47-0.56 | 0.56-0.60 |
| replies under 16 KiB | 1 KB | 1.04-1.21 | 0.94-1.00 | 0.92-1.10 (control 0.96-1.05) |

What changed: a number array is a candidate the scan reads as usual, and `readNumbers` is asked only once it has run
1,022 characters with nothing but numbers' characters (one store a `[`, one compare a comma), with its commas counted
first (`commasIn`, 1 ns a character) where a flood could fit, which also sizes the array; regions stop at 32 KiB; a long
body on the bytes path is scanned as bytes first and decoded only when within, or when the byte scan stopped at what
the text path reads faster (`byteShapeOrStop`, only up to twice the value bound); past the step budget a reply with
nothing read is finished by main's scan (`plainScan`), and the bound is tried only where values were sparse; the
plain path for replies under 16 KiB is main's scan again (sharing the reading scan cost them 4-20%); the readers'
buffers are zeroed after each reply.

What is left over main: a refused depth bomb costs 0.7-1.1 µs more than main's 2-3 µs (the long path's set-up); a
hostile pair of strings whose guessed end is wrong (`["ab\"...", "\"\"..."]`, 2 MB) 0.84-1.30x across runs.

**Against the alternatives** (`MCP_ALT_DIR=<scratch> MCP_COMPARE_TEXT=plain,lines,escapes,unicode,numbers
MCP_COMPARE_SIZES=65536,1048576 mcp-compare.bench.ts perf 2 eden,sdk,sdk2,pi,aisdk`, then the 1 KB JSON cells of the
earlier losses, `perf 3`; CPU µs a `tools/call`, medians; load 2-4; the Python SDK was not rerun, as it cost 10-30x the
others in every cell before):

| Text | Reply | Size | In flight | eden | sdk | sdk2 | pi | aisdk | eden / best other |
|---|---|---|---|---|---|---|---|---|---|
| plain | JSON | 64 KB | 1 | **166** | 200 | 249 | 220 | 221 | 0.83 |
| plain | JSON | 64 KB | 16 | **122** | 165 | 194 | 218 | 166 | 0.74 |
| plain | JSON | 64 KB | 256 | 135 | **121** | 159 | 199 | 167 | 1.11 |
| plain | JSON | 1 MB | 1 | **1,054** | 1,232 | 1,232 | 2,950 | 1,155 | 0.91 |
| plain | JSON | 1 MB | 16 | **942** | 1,148 | 1,249 | 2,190 | 1,147 | 0.82 |
| plain | JSON | 1 MB | 256 | **1,207** | 1,508 | 1,551 | 2,162 | 1,449 | 0.83 |
| plain | SSE | 64 KB | 1 | **220** | 309 | 341 | 728 | 402 | 0.71 |
| plain | SSE | 64 KB | 16 | **211** | 276 | 344 | 636 | 364 | 0.76 |
| plain | SSE | 64 KB | 256 | **182** | 259 | 337 | 695 | 257 | 0.71 |
| plain | SSE | 1 MB | 1 | **2,351** | 3,340 | 3,488 | 21,840 | 3,530 | 0.70 |
| plain | SSE | 1 MB | 16 | **1,761** | 2,591 | 2,798 | 15,155 | 2,755 | 0.68 |
| plain | SSE | 1 MB | 256 | **1,910** | 2,394 | 2,327 | 15,103 | 2,601 | 0.82 |
| lines | JSON | 64 KB | 1 | **188** | 200 | 200 | 282 | 227 | 0.94 |
| lines | JSON | 64 KB | 16 | 211 | **166** | 264 | 274 | 212 | 1.27 |
| lines | JSON | 64 KB | 256 | 188 | 178 | 217 | 256 | **166** | 1.13 |
| lines | JSON | 1 MB | 1 | 2,516 | **1,731** | 1,829 | 3,738 | 1,899 | 1.45 |
| lines | JSON | 1 MB | 16 | 2,061 | **1,805** | 2,030 | 2,780 | 1,991 | 1.14 |
| lines | JSON | 1 MB | 256 | 2,642 | **2,338** | 2,516 | 3,053 | 2,367 | 1.13 |
| lines | SSE | 64 KB | 1 | 357 | **321** | 374 | 698 | 441 | 1.11 |
| lines | SSE | 64 KB | 16 | **266** | 353 | 383 | 743 | 469 | 0.76 |
| lines | SSE | 64 KB | 256 | **249** | 284 | 311 | 594 | 332 | 0.88 |
| lines | SSE | 1 MB | 1 | **3,254** | 4,156 | 3,954 | 21,194 | 4,844 | 0.82 |
| lines | SSE | 1 MB | 16 | **2,605** | 3,460 | 3,695 | 15,159 | 3,969 | 0.75 |
| lines | SSE | 1 MB | 256 | **3,204** | 3,409 | 3,678 | 15,278 | 3,922 | 0.94 |
| escapes | JSON | 64 KB | 1 | **341** | 462 | 494 | 612 | 505 | 0.74 |
| escapes | JSON | 64 KB | 16 | **304** | 468 | 573 | 536 | 486 | 0.65 |
| escapes | JSON | 64 KB | 256 | **283** | 388 | 553 | 469 | 454 | 0.73 |
| escapes | JSON | 1 MB | 1 | **3,868** | 5,311 | 5,556 | 7,926 | 5,578 | 0.73 |
| escapes | JSON | 1 MB | 16 | **3,556** | 5,722 | 5,836 | 6,869 | 5,164 | 0.69 |
| escapes | JSON | 1 MB | 256 | **4,542** | 6,162 | 6,758 | 7,390 | 6,809 | 0.74 |
| escapes | SSE | 64 KB | 1 | **520** | 673 | 621 | 1,099 | 920 | 0.84 |
| escapes | SSE | 64 KB | 16 | **452** | 660 | 685 | 999 | 1,047 | 0.68 |
| escapes | SSE | 64 KB | 256 | **362** | 629 | 546 | 882 | 832 | 0.66 |
| escapes | SSE | 1 MB | 1 | **5,508** | 7,884 | 7,986 | 35,414 | 12,302 | 0.70 |
| escapes | SSE | 1 MB | 16 | **4,876** | 7,273 | 8,497 | 24,808 | 11,482 | 0.67 |
| escapes | SSE | 1 MB | 256 | **5,252** | 7,480 | 7,518 | 24,073 | 11,089 | 0.70 |
| unicode | JSON | 64 KB | 1 | **245** | 345 | 387 | 340 | 345 | 0.72 |
| unicode | JSON | 64 KB | 16 | **253** | 350 | 393 | 312 | 415 | 0.81 |
| unicode | JSON | 64 KB | 256 | **207** | 298 | 330 | 298 | 327 | 0.69 |
| unicode | JSON | 1 MB | 1 | **2,477** | 3,494 | 3,366 | 7,598 | 4,122 | 0.74 |
| unicode | JSON | 1 MB | 16 | **2,384** | 3,617 | 3,518 | 5,746 | 4,243 | 0.68 |
| unicode | JSON | 1 MB | 256 | **3,047** | 4,448 | 4,400 | 6,002 | 4,627 | 0.69 |
| unicode | SSE | 64 KB | 1 | **334** | 371 | 446 | 1,630 | 500 | 0.90 |
| unicode | SSE | 64 KB | 16 | **340** | 390 | 475 | 1,664 | 482 | 0.87 |
| unicode | SSE | 64 KB | 256 | **272** | 308 | 364 | 1,300 | 380 | 0.88 |
| unicode | SSE | 1 MB | 1 | **3,675** | 4,643 | 5,050 | 63,386 | 5,115 | 0.79 |
| unicode | SSE | 1 MB | 16 | **3,131** | 3,825 | 4,463 | 46,329 | 4,882 | 0.82 |
| unicode | SSE | 1 MB | 256 | **3,824** | 3,965 | 4,317 | 40,636 | 4,613 | 0.96 |
| numbers | JSON | 64 KB | 1 | 440 | **439** | 632 | 554 | 526 | 1.00 |
| numbers | JSON | 64 KB | 16 | **454** | 516 | 530 | 458 | 491 | 0.99 |
| numbers | JSON | 64 KB | 256 | **350** | 432 | 562 | 434 | 446 | 0.81 |
| numbers | JSON | 1 MB | 1 | **4,476** | 4,920 | 5,060 | 6,420 | 5,128 | 0.91 |
| numbers | JSON | 1 MB | 16 | **4,795** | 5,263 | 4,875 | 5,794 | 4,808 | 1.00 |
| numbers | JSON | 1 MB | 256 | 5,379 | **5,334** | 6,171 | 6,130 | 5,838 | 1.01 |
| numbers | SSE | 64 KB | 1 | 562 | **549** | 669 | 1,368 | 647 | 1.02 |
| numbers | SSE | 64 KB | 16 | **547** | 584 | 675 | 1,077 | 749 | 0.94 |
| numbers | SSE | 64 KB | 256 | **466** | 478 | 600 | 1,292 | 568 | 0.97 |
| numbers | SSE | 1 MB | 1 | **5,914** | 6,904 | 8,542 | 35,718 | 8,263 | 0.86 |
| numbers | SSE | 1 MB | 16 | **5,612** | 7,015 | 6,631 | 17,018 | 7,550 | 0.85 |
| numbers | SSE | 1 MB | 256 | **6,274** | 6,533 | 6,750 | 18,369 | 6,942 | 0.96 |
| plain | JSON | 1 KB | 1 | **103** | 136 | 198 | 118 | 143 | 0.87 |
| plain | JSON | 1 KB | 16 | **52** | 70 | 107 | 90 | 70 | 0.74 |
| plain | JSON | 1 KB | 256 | 61 | 67 | 130 | **55** | 79 | 1.11 |
| lines | JSON | 1 KB | 1 | **92** | 109 | 169 | 123 | 113 | 0.85 |
| lines | JSON | 1 KB | 16 | **57** | 79 | 91 | 69 | 70 | 0.83 |
| lines | JSON | 1 KB | 256 | **45** | 61 | 95 | 72 | 76 | 0.75 |
| unicode | JSON | 1 KB | 1 | **90** | 126 | 122 | 111 | 127 | 0.81 |
| unicode | JSON | 1 KB | 16 | **44** | 52 | 84 | 63 | 86 | 0.85 |
| unicode | JSON | 1 KB | 256 | **41** | 54 | 88 | 70 | 95 | 0.76 |
| numbers | JSON | 1 KB | 1 | **96** | 104 | 126 | 103 | 104 | 0.93 |
| numbers | JSON | 1 KB | 16 | **46** | 66 | 86 | 70 | 87 | 0.69 |
| numbers | JSON | 1 KB | 256 | **54** | 60 | 101 | 58 | 87 | 0.95 |

Ours is the cheapest in 61 of these 72 cells. Of the 13 earlier losses, seven are now ours: plain JSON at 1 MB one at a
time (0.91), numbers in JSON at 1 KB and 1 MB one at a time (0.93, 0.91) and at 64 KB with 256 in flight (0.81),
unicode at 1 KB one at a time (0.81), and tool output in JSON at 1 KB (0.75-0.85) and at 64 KB one at a time (0.94).
Still lost: tool output in JSON at 64 KB with 16 and 256 in flight and at 1 MB (1.13-1.45, below), plain JSON at 1 KB
with 256 in flight (1.11 pi). New in this run: plain JSON at 64 KB with 256 in flight (1.11; 0.87 in D1900's run),
tool output in SSE at 64 KB one at a time (1.11; 0.92 before), and four numbers cells at 1.00-1.02. The parse path of
those cells did not get slower (numbers at 64 KB: 237-247 µs against D1900's 275-304 in one process); one or two
rounds on a loaded machine move a cell 10-20%. Time to the first call: eden 33-36 ms, pi 70-78, aisdk 119-126, sdk
122-123, sdk2 135-164.

**Where the remaining time goes, and what D1871 costs.** One JSON `tools/call` of 1 MB tool output, client process CPU
(`wire.ts`-style: a local server in another process, nine interleaved rounds):

| Read | µs |
|---|---|
| `res.bytes()` only | 809-929 |
| `res.text()` only | 893-953 |
| `res.text()`, then `JSON.parse` (no check) | 1,630-1,713 |
| `res.text()`, then `parseJsonText` (ours) | 1,757-1,883 |
| `res.json()` (what the SDK does) | 1,564-1,634 |
| `res.bytes()`, `latin1Slice` or `TextDecoder`, `JSON.parse` (no check) | 1,834-1,936 |
| `res.bytes()`, byte scan, `latin1Slice`, `JSON.parse` | 2,296 |
| `res.bytes()`, byte scan, `new Response(bytes).json()` | 2,285 |

Our check and the guessed read cost 3-10% over an unchecked `text()` and `JSON.parse`; in one process, on the string
alone, `parseJsonText` costs 963 µs against `JSON.parse`'s 899 (the scan is 1.3% of the profile, the parse 96%). The
rest of the gap to the SDK is `text()` against `json()`: 65-150 µs a MiB, the string `text()` makes. No read that
checks before parsing is cheaper: bytes and a decode (`latin1Slice` or `TextDecoder`) then `JSON.parse` cost more than
`text()`, and handing checked bytes to `json()` costs more again. The only way to that cell is `json()` first and the
check after, which D1871 refused, and the numbers still say keep it: `json()` of 1 MB of nested arrays costs 54-87 ms
of CPU and of a 16 MiB number flood 134-201 ms before anything can refuse them, where ours refuses the flood in 3.4-5.0
ms. The trade is 65-150 µs a MiB on tool output in JSON against 20-50x the CPU (and the parsed objects in memory) on
every hostile reply. At 1 KB, `fetch` is 66% of a call's CPU in ours and the check and parse about 15%; the client's
own JavaScript (deadlines, the abort controller, the message bookkeeping) is about 10%, 8 µs of the 82 that loop
measured.

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
MCP_ALT_DIR=<root> env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts perf 3     # ~75 min, plain text
# every text shape, one round (~35 min); D1900 ran it three times with the client order rotated
MCP_ALT_DIR=<root> MCP_COMPARE_TEXT=plain,lines,escapes,unicode,numbers env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts perf 1 eden,sdk,sdk2,pi,aisdk,python
MCP_ALT_DIR=<root> env -u BUN_OPTIONS bun packages/sources/bench/mcp-compare.bench.ts hostile   # ~3 min
MCP_PROFILE_BASE=<copy of another tree's src/mcp> MCP_PROFILE_TEXT=plain,lines,escapes,unicode,numbers env -u BUN_OPTIONS bun packages/sources/bench/mcp-profile.bench.ts 3 eden,base,sdk
```
