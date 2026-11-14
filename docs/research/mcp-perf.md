# MCP client and server speed (2026-11-14, D1840: adopted)

D1704 replaced the official SDK with Eden's own MCP client, streamable HTTP transport and stdio server. This note
profiles that code, says where its time goes, and measures what was changed: the client against itself as D1704
shipped it (frozen in `packages/sources/bench/mcp-d1704/`) and against the SDK's client, on the same server. Every
D1704 bound is unchanged (the reply caps, the per-event and `tools/list` caps, the deadlines, `ping`-only answers,
same-origin redirects, the id match, no reply bodies in errors), and the code's outputs are equal to D1704's on
seeded random inputs (below).

Machine: 4 cores, Bun 1.4.4, `env -u BUN_OPTIONS` (the session sets `--smol`), shared with one other agent's work, so
every comparison interleaves its arms and reports medians.

## Method

`packages/sources/bench/mcp-profile.bench.ts` runs a canned MCP server in its own process (`Bun.serve`; it answers
`initialize`, and `tools/call` or `tools/list` with a reply of a set size built once, around the request's id), so
the client's work is what is timed. Each client arm runs in a fresh child process and times, per reply mode (JSON
and SSE), method, size (1 KB, 64 KB, 1 MB, 4 MB) and calls in flight (1, 16, 256; 4 MB at 1 and 16 only): per-call
p50 and p99 latency, process CPU per call (all threads: Bun's fetch does its HTTP on its own thread), peak RSS
(sampled every 2 ms) and the heap left right after the cell (allocated and not yet collected); and once, the time
from process start to the first call's answer. Arms: `eden` (this change), `d1704` (before), `sdk`
(`@modelcontextprotocol/sdk` 1.29's `Client` and `StreamableHTTPClientTransport`) and `fetch` (one bare POST per
call read with `text()` and `JSON.parse`, no MCP session, checks or bounds: the floor). Three rounds, the arm order
rotating each round, medians. Bun has no allocation counter, so allocation is read as the heap left after a cell
and the peak RSS; CPU profiles (`bun --cpu-prof`, self time by function) located the work.

## Where the time went (D1704's code)

Per-call CPU at 64 KB was about twice the SDK's (JSON 336 against 171 µs, SSE 535 against 266, one call at a time,
first single round), though the SDK validates every reply with zod. Pieces timed alone on a 64 KB result
(microbenchmarks, in-process):

| Piece | 1 KB | 64 KB | 1 MB |
|---|---|---|---|
| `bodyShapeUnder` (D100's shape check, a byte loop) | 2.4 µs | 113.5 µs | 1,961 µs |
| SSE parser, `push` of the event | 2.6 µs | 159.0 µs | 2,436 µs |
| `TextDecoder.decode` + `JSON.parse` | 0.7 µs | 19.2 µs | 452 µs |

The two byte loops in JavaScript, about 1.7 ns a byte each, cost six and eight times the parse they guard. Next, by
CPU profile of 1 KB calls 16 in flight: native `fetch` 55% of the process's CPU; the per-call timers, the caller's
abort listener and the POST's `AbortController` about 10% together (`setTimeout`+`clearTimeout` 0.28 µs a pair,
`AbortController` 0.40, an abort listener added and removed 1.6); the rest spread thin (`JSON.stringify`, the
async functions, the body reader). At 1 MB in SSE: copies (`slice` of each chunk's tail of an unended line 17%, the
zeroed buffers they were joined into 10%, `set` 6%), then decode and parse. Reading a body through its reader
instead of `text()` costs about 7 µs a small call and 100-200 µs a MB, and `Buffer.concat`-style joining of the
chunks about 220 µs a MB.

## What changed

1. **`bodyShapeUnder` skips strings with the native `indexOf`** (`@eden/protocol`, so the HTTP server's D100 check
   and the stdio server gain too). Strings are most of a reply's bytes. Inside one, a run of 32 bytes is read by
   the loop; past it the next quote and the next backslash are found with `Uint8Array.prototype.indexOf` (about 11
   µs a MB), each searched once and moved only forward, so each byte is read by at most one search of each kind (a
   first version searched for the quote from every run and was quadratic on a body of escapes: caught by the
   worst-case bench before it was committed). Outside strings a 256-byte table classifies each byte in one load.
2. **The SSE parser finds line ends with `indexOf`** (the next LF and the next CR, each searched once and again only
   after it is passed), keeps an event's one data line as a view instead of copying it into the event buffer, and
   copies only what it must keep past `push` (a line's unended tail, an event not yet dispatched); the transport
   tells it that `fetch`'s reader hands out a new array each read, so it keeps views of those too.
3. **One timer for every MCP deadline** (`deadlines.ts`): each request's timeout and each POST's deadline go in one
   heap with one `setTimeout` armed for the earliest; a cancel sets a flag, cancelled entries are compacted past
   half the heap, and with none pending the timer is cleared. Ties fire in the order added, so a request's timeout
   still fires before the deadline of the POST that carries it, as two timers did.

## Results

`mcp-profile.bench.ts`, 3 rounds, arm order rotating, medians (one run of about 50 minutes; the machine shared).
CPU per call in µs, all threads; `floor` is the bare `fetch` arm; the last two columns are this change against D1704
and against the SDK (below 1 is better).

`tools/call`, JSON replies:

| Result | In flight | D1704 | D1840 | SDK | floor | D1840 / D1704 | D1840 / SDK |
|---|---|---|---|---|---|---|---|
| 1 KB | 1 | 101 | 109 | 140 | 81 | 1.09 | 0.78 |
| 1 KB | 16 | 57 | 60 | 73 | 31 | 1.04 | 0.82 |
| 1 KB | 256 | 74 | 64 | 68 | 39 | 0.87 | 0.94 |
| 64 KB | 1 | 312 | 221 | 185 | 122 | 0.71 | 1.20 |
| 64 KB | 16 | 259 | 199 | 146 | 80 | 0.77 | 1.36 |
| 64 KB | 256 | 285 | 207 | 140 | 90 | 0.73 | 1.48 |
| 1 MB | 1 | 3,596 | 2,747 | 1,230 | 1,189 | 0.76 | 2.23 |
| 1 MB | 16 | 3,490 | 1,935 | 1,281 | 942 | 0.55 | 1.51 |
| 1 MB | 256 | 4,521 | 2,390 | 1,564 | 1,500 | 0.53 | 1.53 |
| 4 MB | 1 | 14,222 | 7,781 | 4,336 | 3,918 | 0.55 | 1.79 |
| 4 MB | 16 | 13,650 | 7,585 | 3,862 | 3,109 | 0.56 | 1.96 |

`tools/call`, SSE replies:

| Result | In flight | D1704 | D1840 | SDK | floor | D1840 / D1704 | D1840 / SDK |
|---|---|---|---|---|---|---|---|
| 1 KB | 1 | 98 | 108 | 142 | 75 | 1.10 | 0.76 |
| 1 KB | 16 | 57 | 59 | 91 | 30 | 1.03 | 0.65 |
| 1 KB | 256 | 64 | 56 | 91 | 35 | 0.88 | 0.61 |
| 64 KB | 1 | 510 | 229 | 285 | 125 | 0.45 | 0.80 |
| 64 KB | 16 | 482 | 220 | 335 | 73 | 0.46 | 0.66 |
| 64 KB | 256 | 494 | 218 | 257 | 86 | 0.44 | 0.85 |
| 1 MB | 1 | 6,237 | 2,785 | 3,662 | 1,087 | 0.45 | 0.76 |
| 1 MB | 16 | 6,120 | 2,083 | 2,760 | 935 | 0.34 | 0.75 |
| 1 MB | 256 | 6,851 | 2,435 | 2,633 | 1,366 | 0.36 | 0.93 |
| 4 MB | 1 | 25,478 | 7,824 | 10,732 | 4,051 | 0.31 | 0.73 |
| 4 MB | 16 | 27,573 | 8,080 | 10,201 | 3,450 | 0.29 | 0.79 |

`tools/list` (tools of about 1 KB each, up to the size), D1840 against D1704: JSON 0.67-0.88 at 64 KB to 4 MB, SSE
0.42-0.59; against the SDK, whose zod validation of every tool costs it here, 0.64-0.89 in JSON and 0.51-0.75 in
SSE at those sizes. At 1 KB, against D1704 0.91-1.08 except one cell (JSON, 16 in flight: 69 against 47 µs, 1.48;
earlier single rounds of the same cell read 44 against 49 and 64 against 54 µs, so noise at this size), and against
the SDK 0.39-1.10.

**Latency** (p50) follows CPU: at 16 in flight, `tools/call` p50 against D1704 is 0.88 (1 KB), 0.53 (64 KB), 0.40 (1
MB), 0.47 (4 MB) in JSON and 0.71, 0.30, 0.26, 0.23 in SSE; p99 at 1 MB 0.46 (JSON) and 0.40 (SSE). Against the
SDK, SSE p50 is 0.55-0.98 at every size; JSON p50 is 0.76-0.99 at 1 KB and 1.22-2.55 from 64 KB up.

**At 1 KB** this change is neutral: one call at a time it reads 109 against 101 µs (JSON) above, and ten
interleaved processes of 10,000 calls each (one at a time, JSON, with an abort signal per call as `McpSource`
passes) read 93.2-102.4 (median 102.3) against 97.0-103.4 (median 99.8) µs. Native `fetch` is 55% of a small call's
CPU, and the floor (one bare `fetch` and `text()`) is 70-80% of ours one at a time.

**JSON replies of 64 KB and up stay above the SDK** (1.2-2.2x CPU): the capped read goes through the body's
`ReadableStream` reader and joins the chunks, where the SDK and the floor call `res.json()` or `res.text()`, read
natively in one piece. A CPU profile of a 1 MB JSON call: `JSON.parse` 21%, `TextDecoder.decode` 21%, the stream
reader's own machinery about 25%, the join 13%. Reading natively would drop the reply cap's enforcement onto the
runtime (below, "Considered"). SSE replies are read through the same reader by both clients, so there the parser's
work decides, and this change is under the SDK at every size.

**Memory.** Peak RSS at 1 and 16 in flight is 0.81-1.12 of D1704's in every cell but one (a JSON call of 4 MB one at a
time, 130 against 102 MB). Where 256 replies of 1 MB are in flight at once it is higher: 876 against 713 MB (JSON
call) and 834 against 598 (SSE call) in the run above, 779-889 against 655-705 (JSON) and 641-766 against 453-562
(SSE) in three interleaved reruns. It is the speed, not a leak: the same code with D1704's shape-check loop put back
reads 674-724 MB on the JSON cell, D1704's level. A client that reads faster holds more of the 256 MB in flight in its
own process instead of in socket buffers and the server. The heap left after a cell moves with when the collector
last ran (0.3x to 6.7x of D1704's across cells, in both directions) and is not reported further.

**Time to the first call** (process start to the first call's answer): about 21 ms against the SDK's 109-125 ms,
unchanged from D1704. Seven interleaved processes each: D1840 19.8-30.8 (median 20.9) ms, D1704 20.4-33.1 (26.1);
the profile's D1704 arm reads lower (20.7 against 26.6) because the frozen copy inlines its shape check and so never
loads `@eden/protocol`, about 10 ms of each (the frozen copy alone: 9.9-14.3, median 11.8).

**The SDK's server** (`mcp-client.bench.ts 2000 3`, small replies, the SDK server's own work most of each call):
D1840, D1704 and SDK `callTool` p50 249 / 228 / 227 µs in JSON and 299 / 284 / 303 in SSE; `listTools` (10 tools)
354 / 375 / 492 and 449 / 496 / 618; RSS 52.9 / 49.5 / 60.1 and 55.1 / 52.8 / 61.3 MB; one keep-alive connection
for ours, two for the SDK. Within noise of each other, as small calls are above.

**The pieces** (in-process, 64 KB): `bodyShapeUnder` 113.5 → 1.8-2.7 µs (1 MB 1,961 → 35-40 µs); the SSE parser's
`push` of a 64 KB event in 64 KB chunks 159.0 → 31.8 µs. Keeping the reader's chunks as views (the SSE parser's
`chunksKept`) is worth 13-16% of a 1 MB SSE call's CPU on its own (three interleaved pairs: 2,648-2,774 against
3,024-3,284 µs). The shared timer is not visible above noise at 1 KB (it replaced about 1.5 µs of a 100 µs call);
it stays because it is no slower and halves the timers a call arms.

**Worst cases of the shape check** (16 MiB bodies, 15 interleaved runs, medians, D1704's loop against D1840's):
plain text outside strings 25.0 / 22.2 ms, a string of only escapes 14.2 / 15.7, an escape every 33 bytes 27.0 /
24.2, 4M two-character strings 54.3 / 37.0, 33-byte strings 31.3 / 26.8, 8M numbers 45.5 / 33.2, rows of JSON as
text (escaped quotes every ~20 bytes) 28.9 / 8.3. Linear in every case; the string of escapes is the one case
slower, within its noise.

## Interop and equivalence

- **Our client, the SDK's servers**: `client.test.ts` (in memory) and `http.test.ts` (real HTTP, JSON and SSE) as
  before, plus a new test: results of 1 KB to 3 MB with quotes, backslashes, CRLF and multi-byte characters, 16 in
  flight, in both reply modes, must equal what the SDK's own client reads from the same server (3 MB: escaped, it
  stays under the 4 MiB cap on one SSE event; 4 MB of such text is refused by that cap, as before).
- **The SDK's client, our server**: `mcp-protocol.test.ts` and `mcp-stdio.test.ts` (the SDK's stdio client against
  `mcp-stdio.ts` as a subprocess), unchanged and passing; the server's code did not change, and `parseJsonBytes`'s
  shape check is the differential-tested one.
- **Against D1704** (`differential.test.ts`): the SSE parser on 20,000 seeded random streams (long runs, CR-only
  lines, BOMs, events past the cap, a handler that stops at a random event), cut at random into chunks of 1-9 or
  1-400 bytes, with chunks kept and with chunks overwritten after each push: the same events and steps, 0
  differences (24,437 events, 2,567 streams past the cap). The whole client and transport on 1,000 seeded random
  replies (JSON and SSE, arrays, wrong and string ids, pings, sampling requests, error results, bad shapes, deep
  nesting, truncated streams, 202, 429, wrong content type), with a 64 KiB cap: the same results, error messages,
  `onerror` reports and POSTs, in order. Changing one error message's text made it fail, so it compares what it
  should. `bodyShapeWithin` against D1704's byte loop on 6,000 seeded bodies at small bounds (both answers common):
  0 differences.
- **Adversarial and fuzz**: `adversarial.test.ts` unchanged and passing (malformed, oversized, truncated, flooding
  and hanging servers; the quadratic-line, slow-write, ping-flood and paging proofs of concept; seeded fuzz of the
  parser, `asMessage` and the client). `deadlines.test.ts` covers the timer: order, ties in the order added, cancel,
  compaction, re-entry, odd delays, nothing held when idle.

## Considered, not done

- **Reading a JSON body with `res.bytes()` when its `Content-Length` is under the cap** (100-200 µs a MB, 7 µs a
  small call). The bound would rest on the runtime's HTTP client: Bun inflates a gzip body past its declared length
  (8 KB declared, 8 MB read) and, with both `Content-Length` and `Transfer-Encoding: chunked` sent, `bytes()` read
  until the deadline. The capped reader stays.
- **Joining lines and bodies into unzeroed buffers** (`Buffer.allocUnsafe`): built, then measured with and without
  on 1 MB replies 256 in flight (three runs each, one batch after the other): SSE 2,152-2,499 against 2,296-2,750 µs
  a call, JSON 2,321-2,530 against 2,263-2,422, peak RSS 641-889 against 727-862 MB: no difference past noise, so
  the plain zeroed arrays stay.
- **`Response.json()` or `Buffer.toString` instead of `TextDecoder` + `JSON.parse`**: no consistent gain (64 KB 79-83
  against 98 µs, 1 MB 2,405-2,579 against 2,086 µs), and the shape check needs the bytes.
- **Caching `initialize` or `tools/list` across a source's reconnects.** Not correct here: `McpSource` reconnects
  after a closed connection or an expired session (a 404, after which the spec asks for a fresh `initialize`), and
  re-checks every tool's read-only annotation on the listing it gets (D7). A cached listing would skip that check
  against a server whose tools changed. It also costs a source one round trip per reconnect, not per call.
- **The stdio server** (`packages/server/bench/mcp-stdio.bench.ts`, this tree against D1704's stdio transport and
  shape check, 20,000 messages of each kind, 3 rounds, two runs): CPU per message 8.5 / 9.3 against 8.8 / 10.2 µs
  for `ping`, 8.5 / 7.6 against 8.4 / 7.4 for `tools/list`, 16.1 / 15.1 against 15.7 / 19.0 for an `ask_context` of
  1 KB, 180 / 189 against 202 / 186 for an answer of 64 KB: the same within noise. A CPU profile of the ask shows `JSON.stringify` of the answer and `JSON.parse` of
  the request first; the framing (`indexOf` on bytes, one decode per line) and the handler are a few percent. The
  line is already cut from bytes with the native `indexOf` and joined once; writing the answer and its newline as
  one string costs one rope flatten, cheaper than a second write. Nothing was changed there.

## What the client does not support

Left out by D1704 because Eden needs none of it, and still out:

- **OAuth**: credentials are the operator's static headers; no authorization flow, token refresh or
  `WWW-Authenticate` handling.
- **Resumability**: no standalone GET stream for server-initiated messages, no `Last-Event-ID` reconnect; a stream
  that breaks fails its call.
- **Sending JSON-RPC batches** (removed from MCP in 2025-06-18); a JSON reply that is an array is read.
- **The session DELETE** on close (the SDK's `close` sends none either).
- **Everything but tools**: resources, prompts, completions, logging, progress and list-changed notifications;
  sampling, roots and elicitation requests are dropped unanswered.
- **Output-schema validation** of `structuredContent`.
- **A stdio client transport** (only the lab launches servers, with the SDK's); the server side speaks stdio only.
