# Eden's MCP client against the alternatives (2026-11-14, D1860, D1870-D1875 and D1900-D1909: adopted)

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
Every CPU number in this section was taken with that forced GC; D1909 (below) remeasures without it too.
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

Single runs of the escaped shapes spread 59-70 MB for both main and the branch (the collector's timing). The bytes
cell's "8 more runs" medians (65.9 for main, 65.2 for the branch) did not reproduce in D1909's review (63.3 against
70.1); D1909 fixed the cause and remeasured it (below).

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

What is left over main: superseded by D1909's measurement (below), which found nested number arrays at up to 12x,
an escaped string past 4 MiB on the bytes path at 1.2x, and, without the forced GC, multi-byte text on the bytes path at
1.2-1.4x; after D1909 a refused depth bomb costs 0.1-1.1 µs more than main's 1.2-3.3 µs and a hostile pair of strings
whose guessed end is wrong (`["ab\"...", "\"\"..."]`, 2 MB) 1.26-1.46x.

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

## The third review's fixes (D1909)

A third independent review (of D1908) found no answer that differed from main's and nothing retained, and three cost
findings. D1909 fixes them; no answer changed: 0 differences from main's real `json.ts` and `shape.ts` (text and bytes
paths, the review's two fuzzers with two new generators, nested candidates and multi-byte bodies) on 268,012 bodies over
eleven fresh seeds, 47,000 of them on the final tree, and `long-reply.test.ts`.

**Method.** As D1908's, with two changes. The review's A/B kept the branch in the middle of every round (main, branch,
control, then reversed); without a forced GC, whichever arm sat in that slot read 1.10-1.13x the first slot's (main
against itself, the control against main), so every arm now takes each of the three slots equally often (18-48
rounds). Each cell is measured both without a forced GC ("no GC") and with one before each batch ("GC"): allocation is
real cost, and only the first counts it. "Before" is D1908 as reviewed (aa64d4dea), measured alongside. Load 0.6-1.1.

**Nested candidates** (`("[" + "1234567890123," x 80) x 40`, then one long number array; ratio of main's CPU):

| Size | Path | Before, no GC / GC | After, no GC / GC | Control, no GC / GC |
|---|---|---|---|---|
| 2 MB | text | 1.15 / 0.99 | 0.88 / 0.87 | 0.94 / 0.93 |
| 6 MB | text | 6.09 / 5.82 | 0.87 / 0.87 (0.86-0.95 with a GC in D1919's sweeps) | 0.96 / 0.95 |
| 12.6 MB | text | 8.46 / 8.95 | 0.49 / 0.50 | 0.98 / 0.96 |
| 2 MB | bytes | 1.29 / 1.14 | 1.13 / 1.15 | 0.94 / 0.82 |
| 6 MB | bytes | 1.34 / 1.19 | 1.03 / 0.78 | 1.03 / 0.84 |
| 12.6 MB | bytes | 1.35 / 1.17 | 1.04 / 0.80 | 1.03 / 0.84 |
| 16 MiB, 200 levels (the review's `worst.ts`) | text | 900-1,048 ms | 41-51 ms | main 78-104 ms |

Every level shares the innermost `]`, and each level's span was more than twice the room left, so `commasIn` counted
from the level's bracket to that `]` (the rest of the reply), `readNumbers` made an array that long and gave up at the
next `[`, and this repeated at every level the step budget reached. `commasIn` now stops at a `[` or `{` (no number
array holds one), which `numberArrayAt` takes as not a number array, and counts in regions that double from 512
characters, so stopping early costs what was counted. The comment on `numberArrayAt` proves the bound: what either
reader reads from a candidate holds no bracket, brace or quote, the next candidate is a later `[`, so the spans of
successive calls do not overlap, calls are at least 1,022 characters apart, and each reader encodes at most twice what
it reads plus 512 characters. `long-reply.test.ts` holds a 4 MB nested reply under 1.5x the plain path (4.8x on
D1908's code, which fails it). On the bytes path at 2 MB the byte scan stops at the first level and the body takes the
text path, whose scan costs more than main's byte scan; in one process the two cost the same (4.45 against 4.34 ms at
1 MB).

**An escaped string past 4 MiB on the bytes path** (tool output with escapes; ratio of main's CPU):

| Size | Path | Before, no GC / GC | After, no GC / GC | Control, no GC / GC |
|---|---|---|---|---|
| 6.1 MB | bytes | 1.19 / 1.23 | 1.00 / 1.02 | 0.99 / 1.01 |
| 8.1 MB | bytes | 1.28 / 1.20 | 1.01 / 1.00 | 0.99 / 1.03 |
| 16.2 MB | bytes | 1.19 / 1.20 | 1.00 / 1.01 | 1.03 / 1.00 |
| 6.1-16.2 MB | text | 1.01-1.04 / 0.93-1.00 | 1.00-1.08 / 0.97-1.00 | 0.94-1.01 / 0.98-1.00 |

The body had already been byte-scanned and found within, but the text scan declined the string (past 4 MiB, read
apart it held a second copy), tried to bound the rest of the reply, and crossed the string again quote by quote. A
reply known within (`TextShape.known`) now ends the scan there and is parsed whole.

**Multi-byte text on the bytes path** (`"東京 tokyo "` repeated; ratio of main's CPU):

| Characters | Before, no GC / GC | After, no GC / GC | Control, no GC / GC |
|---|---|---|---|
| 590 K | 1.19 / 1.13 | 1.02-1.05 / 1.02 | 0.99-1.01 / 0.99 |
| 1.2 M | 1.18 / 0.99 | 1.02-1.03 / 1.03 | 0.97-1.02 / 1.00 |
| 2.4 M | 1.43 / 0.85 | 0.95-1.07 / 1.01 | 0.85-0.91 / 1.02 |

Reliably over 1.0 without a forced GC, so fixed rather than documented. Over two-byte characters the check that a long
string holds no backslash or control character, before it is sliced, costs 0.7 ms for 1.2 M characters, as much as the
copy `JSON.parse` would make (0.8), and the text scan's search for the string's end costs 0.2 ms more for 2.4 M. A body decoded from
multi-byte UTF-8 now slices no plain string, and a body the byte scan found within with no place where it would have
stopped and no string long enough to slice or guess (`byteSawRead`, `byteLongString`; past twice the value bound the
byte scan runs whole and notes them) is parsed as main parses it, with no text scan. The same rule takes a 64 KB reply
of short strings off the text scan (it cost about 10% there for nothing). The slice held no copy, so peak memory goes back
to main's (below): allocation traded for CPU.

**Peak memory at 16 MiB** (MB above baseline, median of 7 processes; "cold" is a fresh process, "warm" one that parsed a
6 MB reply of the same shape three times first, so the compiler's memory is not counted):

| Shape | Path | main | before | after |
|---|---|---|---|---|
| tool output with escapes, cold | bytes | 61.6 | 66.0 | 62.4 |
| tool output with escapes, warm | bytes | 59.3 | 59.3 | 58.8 |
| tool output with escapes, cold / warm | text | 61.4 / 59.2 | 62.9 / 59.2 | 63.8 / 59.2 |
| multi-byte tool output, cold / warm | bytes | 61.3 / 55.4 | 61.4 / 57.3 | 60.4 / 53.0 |
| multi-byte tool output, cold / warm | text | 61.3 / 54.7 | 61.4 / 56.7 | 61.2 / 55.8 |
| multi-byte text | bytes | 28.9 | 15.1 | 28.6 |
| multi-byte text | text | 15.4 | 14.9 | 15.0 |
| plain text | text / bytes | 17.6 / 33.5 | 17.2 / 17.3 | 17.2 / 17.4 |
| numbers, accepted | text / bytes | 32.7 / 32.1 | 21.2 / 32.0 | 21.3 / 26.1 |
| number flood, refused, cold | text / bytes | 23.0 / 6.5 | 23.1 / 6.0 | 23.2 / 6.9 |
| number flood, refused, warm | bytes | 0.1 | 0.1 | 0.1 |
| nested candidates, refused | text / bytes | 22.8 / 6.3 | 23.2 / 5.9 | 23.8 / 6.8 |
| rows of objects | text / bytes | 16.4 / 1.6 | 15.7 / 1.6 | 16.5 / 3.5 |
| depth bomb, refused | text / bytes | 17.0 / 0.9 | 17.0 / 0.7 | 17.0 / 0.7 |

Single cold runs of the escaped shapes still spread 52-75 MB for every arm (the collector's timing; 52.4-55.3 for main's
text path in one batch of seven, 61.4 in another), so only the medians are compared. The cold refused bodies past twice
the value bound peak 0.4-0.8 MB over main because they now run `byteShapeOrStop`, not `bodyShapeWithin`, and compiling
it costs memory once; warmed, all three read 0.1. Rows of objects on the bytes path read 2.6-3.9 MB cold against main's
0.4-1.7 for the same reason; warmed, 0.1 against 0.0 (median of 5).

**The other shapes**, after (no GC, every arm in every slot; ratio of main's CPU at 64 KB and 1 MB; the control's
ratios ran 0.84-1.28 in this sweep, so cells within about 10-20% of 1.0 at 64 KB are noise, and the in-process timing
of the 64 KB reply of 40 strings read 155.8 against main's 155.2 µs):

| Shape | text | bytes |
|---|---|---|
| tool output with escapes | 0.37-0.38 | 0.33-0.50 |
| numbers | 0.42-0.45 | 0.40-0.54 |
| plain text | 0.99-1.00 | 0.64-0.68 |
| multi-byte text | 0.99 | 0.99-1.12 |
| rows of objects | 0.88-1.22 | 0.86-1.17 |
| `[[n,2,3],...]` | 0.93-1.07 | 1.01-1.18 |
| `[[1],[1],...]` | 1.04-1.19 | 0.94-1.30 |
| 40 long plain strings | 1.08-1.18 | 1.08-1.28 |
| refused number flood | 0.64-0.70 | 0.73-0.75 |
| refused escaped quotes | 0.25-0.43 | 0.28-0.51 |
| refused depth bomb | +0.1 to +1.0 µs (main 2.3-3.3) | +0.8 to +1.1 µs (main 1.2-2.2) |
| hostile wrong guess | 1.26-1.37 | 1.32-1.46 |
| number array ending in a 17-digit number | 1.60-1.81 | 2.07-2.13 |

Left over, and not fixed: the depth bomb (the long path's set-up, about a microsecond); the wrong guess (a guessed end
proven wrong costs one parse of the string's literal; finding the string's end without the guess is the quote-by-quote
search the guess exists to avoid), 1.23-1.43 on D1908's code alongside; and a number array whose last element has more
than 15 digits, which `readNumbers` reads to the end before it meets the element it leaves to `JSON.parse` (1.87-1.88 on
D1908's code: not new, and linear, at most one read of the array more than main; an array of 17-digit floats stops at
its first element and costs nothing). Too narrow, the fourth review found: any element the reader leaves to
`JSON.parse` late in a long array cost the same (a `null` in a series 1.3-1.6x), and the 17-digit floats cost memory
before refusing; both fixed by D1919, below.

## The fourth review's fixes (D1919)

A fourth independent review (of D1909) found no answer that differed from main's (0 differences over 120,000 fuzz
checks, `known` never true out of bounds, linear) and two cost findings, both in the number reader, plus docs that
described D1909's leftover too narrowly. D1919 fixes them; no answer changed: 0 differences from main's real `json.ts`
and `shape.ts` and `JSON.parse` on 689,886 checks (344,943 bodies, each on the text and the bytes path) over eighteen
fresh seeds, about a quarter of them from a generator that puts `null`, `true`, `false`, 16-17-digit numbers and broken
elements at every position of number arrays (first, last, around the first region's and the reach's ends), 119,972
checks on the final tree.

**Method.** The review's 4×4 Latin square: main, D1909's code (680c818a9, "before"), the branch and a copy of the
branch (the control, a second module instance of identical code) each take every slot equally often, 24-32 rounds,
each cell without a forced GC and with one before every batch; the ratio is the arm's CPU over main's in the same round,
median and interquartile range. The two copies of the branch disagree by up to 30% on a few cells (`[1,...]` nested
candidates with a forced GC: 1.11-1.18 against 0.85-0.91, in three sweeps), so only differences larger than the
control's are read as real.

**A non-number late in a long number array.** The reader read up to the element, gave up, and the scan crossed the
whole array again from where it had asked, then the parse read it a third time; past 2 M characters `commasIn` had
also counted the whole array first. Four changes: `readNumbers` reads `null`, `true` and `false` as elements (a metrics
series with gaps is a number array, and `JSON.parse` makes the same array of it); the last element is read before
anything else (`lastElementReads`), so an array that ends in a number of more than 15 digits goes to the scan at once;
where the reader stops at any other element it reports where and how many commas came before (`numbersStop`), and the
scan goes on from there with them counted (everything before is numbers' characters, commas and spaces, of which the
scan counts only the commas, so its answer cannot change); `commasIn` stops at any character no number array holds. On
the bytes path the byte scan stops for a candidate only where the text path would read it (`readsAt`: the `]` far
enough, no quote before it, the last element read), so `[1,...,12345678901234567]` keeps main's byte scan.

*Corrected by the fifth review:* this fixed a late `null`, `true` or `false`, a refused last element and a byte outside
numbers' characters, not every late element. An element the reader refused but made only of numbers' characters (a
16-17-digit number, `1e400`, `1.2.3`, `nn`) anywhere past the first region still cost the reading before it, and past
2 M characters the count of the whole array and an array that long: 1.1-1.6x main (below).

| Shape (1 MB unless given) | Path | Before, no GC / GC | After, no GC / GC | Control, no GC / GC |
|---|---|---|---|---|
| series, one `null` third from last | text | 1.27 / 1.52 | 0.41 / 0.62 | 0.41 / 0.63 |
| same, 3 MB | text | 1.42 / 1.54 | 0.52 / 0.54 | 0.51 / 0.56 |
| same | bytes | 1.43-1.44 / 1.52-1.60 | 0.51-0.59 / 0.60-0.61 | 0.47-0.48 / 0.59-0.63 |
| same, 3 MB | bytes | 0.96 / 0.93 | 0.99 / 0.98 | 0.94 / 0.95 |
| ids, a 17-digit id last | text | 1.33 / 1.60 | 0.87 / 0.83 | 0.84 / 0.79 |
| same | bytes | 1.64-1.85 / 1.70-1.89 | 0.98-1.17 / 1.03-1.08 | 0.99-1.10 / 1.00-1.12 |
| `[1,...,12345678901234567]` | text | 1.70 / 1.56 | 1.04 / 0.92 | 0.89 / 0.99 |
| same | bytes | 1.88-1.89 / 1.99-2.03 | 1.01-1.02 / 1.06-1.07 | 1.00-1.04 / 1.03-1.08 |
| series, a `null` every 200, 3 MB | text | 1.25 / 1.15 | 0.54 / 0.50 | 0.61 / 0.48 |
| same | bytes | 0.99 / 0.98 | 1.04 / 1.00 | 1.02 / 1.02 |
| `[1,true,true,...]`, 4 MB | text | 1.27 / 1.24 | 0.61 / 0.59 | 0.73 / 0.58 |
| `[1 x600, null,...]`, 4 MB | text | 1.19 / 1.50 | 0.64 / 0.59 | 0.65 / 0.61 |
| `[true,...]`, 4 MB | text | 1.15 / 1.19 | 0.68 / 0.63 | 0.63 / 0.58 |
| ids, a 17-digit id in the middle | text | 1.16 / 1.31 | 0.88 / 1.06 | 0.90 / 1.14 |

Reading the literals is what moves the series from about main's cost to about half of it; the resume alone (the
review's prototype) brought the late `null` to 0.96-1.14. A series at 3 MB on the bytes path is past twice the value
bound, where the byte scan runs whole first (below), so reading it saves little there. `long-reply.test.ts` holds the
late-gap series under 0.85x the plain path (1.6x on D1909's code) and `[12,...,12345678901234567]` with the long number
last and third from last under 1.3x (1.8x and 1.4x on D1909's code).

**Memory for full-precision floats.** `JSON.stringify` writes computed doubles with 16-17 significant digits, which the
reader refuses at the first element; before refusing, `commasIn` had sliced the whole array region by region and
`readNumbers` had made an array of its length (about 930,000). Both now wait until the first region has read as
numbers. Peak RSS above baseline at 16 MiB, median of 7 processes [range]:

| Shape, harness | Path | main | before | after |
|---|---|---|---|---|
| computed doubles, one arm's code a process, cold | text | 24.0 | 38.1 | 29.7 |
| same, warmed (baseline before the warm-up) | text | 1.5 | 15.7 | 8.3 |
| flat 16-digit floats, one arm, cold / warmed | text | 23.4 / 1.6 | 38.3 / 16.0 | 30.0 / 8.6 |
| the 200-level nested reply (`worst.ts`), one arm, cold / warmed | text | 23.4 / 1.9 | 30.4 / 10.9 | 30.8 / 11.2 |
| computed doubles, every arm's code in every process, cold | text | 10.9 | 19.1 | 11.2 |
| same, warmed / baseline after the warm-up | text | 4.4 / 4.5 | 13.1 / 5.6 | 5.5 / 5.2 |
| flat 16-digit floats, every arm, cold / warmed | text | 10.1 / 4.3 | 19.5 / 13.5 | 11.2 / 5.9 |
| accepted numbers (6.5 MB), one arm, cold / warmed | text | 22.5 / 13.6 | 17.7 / 11.5 | 18.2 / 12.4 |
| accepted series with gaps (6.5 MB), one arm, cold / warmed | text | 22.7 / 20.1 | 31.0 / 28.0 | 18.7 / 12.6 |
| accepted numbers, series with gaps, one arm, cold | bytes | 34.0, 34.9 | 34.7, 35.6 | 34.9, 35.8 |
| computed doubles, one arm, cold / warmed | bytes | 38.2 / 38.4 | 45.8 / 45.4 | 46.0 / 45.3 |
| same, every arm, baseline after the warm-up | bytes | 10.7 [8.4-12.8] | 9.6 [7.5-12.6] | 13.0 [10.6-13.6] |
| flat 16-digit floats, one arm, cold / warmed | bytes | 38.0 / 45.1 | 38.7 / 45.4 | 39.0 / 45.8 |

The reply's own allocation is gone (the 14 MB D1909 added on the floats). What is left above main on the text path is
code: importing D1919's module into main's process without calling it moves main's warmed reading from 1.5 to 6.4-6.7
MB, the nested reply, whose path D1919 did not change, reads the same gap on D1909's code, and with every arm's code
loaded in every process the gap is 0.3-1.6 MB. A cold process on the bytes path past twice the value bound lands one
8 MB step over main for the floats (single runs 35-46 MB for every arm, so bimodal): it runs, and compiles, the text
scan after the byte scan; so did D1909's code.

**Docs.** D1909 described the leftover as "a number array whose last element has more than 15 digits"; any element the
reader leaves to `JSON.parse` late in a long array cost the same, and a `null` in a series is the common one. D1909's
nested candidates with a forced GC on the text path read 0.86-0.95 on D1909's code in this session's four sweeps (the
review read about 1.0), not 0.87 throughout.

**Tried and dropped.** Sizing an array on the bytes path from the byte scan's count of the reply's values, to skip
counting its commas (about 15% of a 3 MB series there): with nested candidates every level made an array that long
before giving up at the next `[` (6-12.6 MB, bytes, 1.05-1.19x against 0.92-0.97 counting).

**The other shapes**, after (ratio of main's CPU, no GC / GC, the before and control columns alongside in the same
runs; only differences beyond the control's spread are changes):

| Shape | Path | Before | After | Control |
|---|---|---|---|---|
| numbers, 64 KB and 1 MB | text | 0.41-0.54 | 0.41-0.50 | 0.38-0.50 |
| numbers, 1 MB | bytes | 0.46 / 0.50 | 0.41 / 0.53 | 0.49 / 0.51 |
| computed doubles, 16 MiB | text / bytes | 0.71-0.92 / 0.94-0.99 | 0.45-0.60 / 0.98-0.99 | 0.46-0.61 / 0.96-0.97 |
| flat 16-digit floats, 16 MiB | bytes | 1.11-1.24 | 1.07-1.25 | 0.99-1.25 |
| `[[n,2,3],...]`, 64 KB and 1 MB | text / bytes | 0.92-1.07 / 0.99-1.12 | 0.89-0.99 / 1.01-1.02 | 0.93-0.99 / 0.98-1.05 |
| `[[1],[1],...]` | text / bytes | 0.94-1.07 / 1.02-1.03 | 0.95-1.09 / 1.02-1.07 | 0.93-1.09 / 1.06-1.07 |
| nested candidates, 2-6 MB | text | 0.86-1.18 | 0.90-1.18 | 0.85-1.19 |
| nested candidates, 12.6 MB | text | 0.52-0.53 | 0.51 | 0.49-0.51 |
| nested candidates, 2-12.6 MB | bytes | 0.92-1.41 | 0.98-1.47 | 0.94-1.28 |
| the 200-level nested reply, 16 MiB | text / bytes | 0.44-0.51 / 1.12-1.27 | 0.47-0.50 / 0.95-1.26 | 0.46-0.51 / 0.89-1.28 |
| nested, a level just past the reach, 4-16 MB | text | 0.88-0.94 | 0.94-0.95 | 0.86-0.92 |
| siblings each broken by an object, 4-15 MB | text | 1.25-1.31 | 1.06-1.09 | 1.04-1.08 |
| refused number flood, 2 and 16 MB | text | 0.65-0.95 | 0.60-0.95 | 0.59-0.90 |
| same | bytes | 0.79-1.12 | 0.78-1.16 | 0.76-1.13 |
| tool output with escapes, 6.5-15.7 MB | bytes | 0.97-1.01 | 0.99-1.05 | 0.99-1.03 |
| tool output with escapes, 1 MB | text | 0.40 | 0.37-0.38 | 0.36-0.43 |
| multi-byte text, 0.4-1.8 M characters | bytes | 0.96-1.04 | 1.01-1.05 | 0.99-1.04 |
| plain text, 8 KB and 1 MB | text / bytes | 1.00-1.03 / 0.61-0.67 | 0.97-1.06 / 0.66 | 0.99-1.04 / 0.62-0.68 |
| rows of objects, 64 KB and 1 MB | text / bytes | 0.93-1.12 / 0.86-0.91 | 0.93-1.17 / 0.91-0.97 | 0.98-1.13 / 0.92-0.96 |
| 40 long plain strings, 64 KB | text | 1.05-1.08 | 1.00-1.03 | 1.03-1.11 |
| refused depth bomb (main 1-2 µs) | text / bytes | 1.17-1.71 / 1.37-1.86 | 1.23-1.73 / 1.71-1.76 | 1.15-1.67 / 1.42-1.76 |
| hostile wrong guess | text | 1.22-1.31 | 1.25-1.28 | 1.24-1.28 |

The bytes path past twice the value bound (2 MB with these bounds) is where D1919 leaves costs over main, as D1909
did: the byte scan runs whole there to find whether the text path has anything to read, `byteShapeOrStop` costs
1.5-2x main's `bodyShapeWithin` on 16 MiB of floats (27-36 against 15-25 ms in one process), and what the text path
then reads pays back little after it. Not changed here; the cells match D1909's code within the control. Linear:
`lin.ts`'s nested and hostile shapes (a level per reach, spaced levels, siblings broken by objects, a far object, a
series with a late gap, a long id in the middle, numbers among `true`s) cost the same per MB from 2 to 16 MB (the
medians of 6 runs, a forced GC before each, 0.4-1.9x main from size to size; rerun beside D1909's code, the
level-per-reach shape at 8 and 16 MB read 38-57 and 75-81 ms against its 39-40 and 76-77).

## The fifth review's fixes (D1919)

A fifth independent review (of the fourth review's fixes, 99758ce67) found no answer that differed from main's and
two cost findings in the number reader, plus docs that claimed more than the fixes did (above). Past the first region
(512 characters), any element the reader refused but made only of numbers' characters made it give up after reading
everything before it: an unrounded double such as 0.30000000000000004 early in a rounded series, a 17-digit id,
`1e400`, or a malformed element (`nn`, `--1`, `1.2.3`). Past 2 M characters `commasIn` had also counted the whole
array and `readNumbers` had made an array that long before giving up, and the scan then crossed it again.

**What changed.** Six changes, each measured alone before the sweep below.

- *A number past the fast path is read by `Number`* on its text (more than 15 digits, or a power of ten past 22):
  `Number` and `JSON.parse` both round correctly, so it is the same double, at about the parse's cost (43 against 56 ns
  for a 17-digit double, in one process). Two such numbers are read anywhere, and one in eight elements past that, so
  an array of computed doubles is still given up at its third element (it reads no faster than the parse), and a
  series with a few anywhere is read whole. A series that turns into computed doubles after 600 rounded values is given
  up about 90 elements later.
- *An element no JSON array holds* (a sign or a letter that starts no value, a number or literal followed by anything
  but a separator, a `]` after a comma) answers `NOT_JSON`, and the scan answers `NOT_JSON_REPLY`: `JSON.parse` would
  throw, so the reply is undefined either way and nothing is read or parsed after it.
- *After the count*, a reader that stops goes on from the `]` (everything up to it is numbers' characters, commas and
  spaces, and the count holds its commas), and the counted array is made only once a sixteenth of it has read, so an
  array given up early never holds one (the review's prototype resumed at the `]` but kept the array: 5 MB more at
  the peak).
- *An array with a `[` before its `]`*, or with fewer than 512 elements estimated from its commas so far, is neither
  read nor stopped at by the byte scan: nested levels were each read up to the next level, and arrays of 200 numbers
  were read and not kept. The `]` is searched for only up to the next `[`, and the quote only between the brackets, so
  a refused nested reply is no longer crossed to its innermost `]`. A search for `{` too was dropped: the reader stops
  at a `{` as at a `[`, and the search would cross a reply that holds none once more.
- *The byte scan reads the first region* of an array before it stops for the text path, so computed doubles, which
  end in one the reader reads, keep the byte scan.
- *The byte scan crosses digits, letters and spaces in a loop of their own*: with `continue` instead, JSC ran it at
  1.4-2 ns a byte of numbers against main's 0.95 (16 MB of 16-digit floats: 31 against 15 ms in one process), the
  bytes path's leftover in D1909 and the fourth review.

**Method.** 4×4 Latin square of main, D1919's earlier code (99758ce67, "before"), a copy of main (the control) and
this code, 24 rounds, each cell without and with a forced GC before every batch; ratios of main's CPU in the same
round, medians. Text path unless given.

| Shape | Before, no GC / GC | After, no GC / GC | Control |
|---|---|---|---|
| series, 0.30000000000000004 at element 200, 3 MB | 1.25 / 1.18 | 0.67 / 0.52 | 1.15 / 1.04 |
| same, 6 MB | 1.23 / 1.19 | 0.55 / 0.48 | 1.07 / 1.03 |
| ids, a 17-digit id at element 170, 3 MB | 1.19 / 1.19 | 0.64 / 0.63 | 1.05 / 0.89 |
| same, 6 MB | 1.10 / 1.18 | 0.59 / 0.59 | 1.02 / 0.91 |
| 13-digit ids, a 17-digit id at element 90, 6 MB | 1.33 / 1.25 | 0.62 / 0.56 | 1.19 / 0.96 |
| ids, `1e400` at element 170, 3 MB | 1.50 / 1.29 | 0.65 / 0.71 | 1.07 / 1.00 |
| ids, a 17-digit id in the middle, 3 MB | 1.18 / 1.38 | 0.70 / 0.61 | 1.00 / 1.08 |
| ids, `1e400` at 97%, 3 MB | 1.06 / 1.19 | 0.61 / 0.71 | 0.77 / 0.85 |
| same, 1 MB | 1.08 / 1.35 | 0.60 / 0.75 | 1.05 / 1.20 |
| same, 1 MB, bytes | 1.18 / 1.32 | 0.75 / 0.80 | 0.95 / 1.00 |
| ids, `nn` at element 170 (not JSON), 3 MB | 1.30 / 1.99 | 0.47 / 0.70 | 0.96 / 0.99 |
| ids, `nul` at 97% (not JSON), 3 MB | 1.40 / 1.36 | 0.90 / 0.80 | 1.01 / 1.27 |
| ids, `1.2.3` at 97% (not JSON), 3 MB | 1.26 / 1.08 | 0.86 / 0.66 | 1.16 / 0.99 |
| ids, `--1` in the middle (not JSON), 3 MB | 1.30 / 1.56 | 0.68 / 0.86 | 1.02 / 1.46 |
| siblings of 200 numbers with a 17-digit one second from last, 1 MB, bytes | 1.21 / 1.27 | 1.01 / 0.98 | 1.04 / 1.00 |
| same, text | 0.97 / 1.30 | 0.88 / 0.95 | 1.05 / 0.98 |
| series, an unrounded double every 50, 3 MB | 0.96 / 0.90 | 0.58 / 0.56 | 0.88 / 0.99 |
| same, bytes | 0.95 / 0.98 | 0.80 / 0.84 | 1.00 / 1.00 |
| series, rounded for 600 then computed doubles, 3 MB | 0.97 / 0.94 | 0.70 / 0.77 | 1.06 / 1.02 |

**The other shapes**, the same runs (before → after, both modes):

| Shape | Path | Before | After | Control |
|---|---|---|---|---|
| numbers, 64 KB and 1 MB | text | 0.35-0.56 | 0.36-0.51 | 0.94-1.07 |
| numbers, 1 MB | bytes | 0.42-0.54 | 0.45-0.58 | 0.99-1.06 |
| series with gaps, a late gap, 1-3 MB | text | 0.39-0.62 | 0.40-0.60 | 0.88-1.05 |
| same, 3 MB | bytes | 1.00-1.01 | 0.81-0.87 | 1.02-1.03 |
| `[true,...]`, `[null,...]`, `[1,true,...]`, 4 MB | text | 0.62-0.72 | 0.65-0.74 | 0.95-1.05 |
| computed doubles, 16 MiB | text / bytes | 0.47-0.54 / 0.96-1.00 | 0.48-0.55 / 0.77-0.81 | 0.98-0.99 |
| flat 16-digit floats, 16 MiB | text / bytes | 0.47-0.56 / 1.11-1.28 | 0.48-0.54 / 0.95-1.03 | 0.99-1.02 |
| the 200-level nested reply, 16 MiB | text / bytes | 0.48-0.57 / 1.00-1.17 | 0.48-0.58 / 0.89-0.97 | 0.97-1.05 |
| nested candidates, 6 and 12.6 MB | text | 0.50-0.92 | 0.55-0.89 | 1.00-1.07 |
| same | bytes | 1.08-1.23 | 0.92-1.04 | 0.91-1.08 |
| nested, a level just past the reach, 16 MB | text | 0.93-1.06 | 0.89-0.91 | 1.03-1.09 |
| siblings of 202 twelve-digit numbers, 1 MB | text / bytes | 0.99-1.05 / 1.18-1.66 | 0.94-0.97 / 0.94-1.10 | 0.95-1.08 |
| ids ending in a 17-digit id, 1 MB | text / bytes | 1.26-1.35 / 1.03-1.11 | 0.56-0.83 / 0.71-0.73 | 1.03-1.26 |
| `[1,...,12345678901234567]`, 1 MB | bytes | 1.01-1.02 | 0.87-1.00 | 1.00-1.02 |
| `[[n,2,3],...]`, 64 KB and 1 MB | text / bytes | 0.89-1.07 / 0.94-1.01 | 0.91-1.07 / 0.93-0.94 | 0.97-1.11 |
| `[[1],[1],...]`, 64 KB and 1 MB | text / bytes | 1.00-1.38 / 0.99-1.05 | 0.95-1.08 / 1.01-1.10 | 0.98-1.28 |
| refused number flood, 2 and 16 MB | text | 0.62-1.04 | 0.73-1.05 | 1.00-1.10 |
| same, 16 MB | bytes | 1.06-1.15 | 0.89-1.16 | 1.03-1.07 |
| tool output with escapes, 6.5-15.7 MB | bytes | 0.96-1.03 | 1.02-1.04 | 0.99-1.05 |
| tool output with escapes, 1 MB | text | 0.34-0.39 | 0.33-0.38 | 0.99 |
| multi-byte text, 1.1-1.8 MB | bytes | 0.97-1.05 | 1.00-1.07 | 0.99-1.06 |
| plain text, 1 MB | text / bytes | 1.02-1.09 / 0.70-0.84 | 1.00-1.07 / 0.70-0.86 | 0.96-1.11 |
| rows of objects, 1 MB | text / bytes | 1.05-1.38 / 0.95-1.01 | 0.99-1.18 / 0.87-1.03 | 0.84-1.13 |
| siblings each broken by an object, 15 MB | text | 1.08-1.30 | 1.15-1.24 | 1.08-1.21 |
| refused depth bomb (main 1-3 µs) | text / bytes | 1.27-1.49 / 1.33-1.69 | 1.17-1.34 / 1.28-1.80 | 0.81-1.21 |
| hostile wrong guess | text | 1.27-1.38 | 1.27 | 1.00-1.02 |

**Left over.** Siblings of number arrays long enough to read (600 elements, about 1.2 KB each) but too many for the
parse to be spared: the reader takes the first 16, the walk that would put them back costs more than it saves, and
the reply is parsed whole after all. On the bytes path at 1 MB: 1.22-1.28x main, as before (1.25-1.34); with `1e400`
in each, which the reader used to give up at and now reads like the rest, 1.30-1.42x (before 1.17-1.23). Refused
nested number arrays at 16 MiB (main refuses in 5-6 ms): a `1e400` before each next level 1.12-1.31x (before
1.30-1.56), a `nul` there 0.92-1.21 (before 1.65-1.74). A refused 16 MB number flood on the text path is still under
main's (0.73-0.82) but 1.12-1.19x D1919's earlier code: the search for the next `[` crosses it once more. A refused
depth bomb and the hostile wrong guess, as before.

**Memory.** Peak RSS above baseline, median of 7 processes, every arm's code loaded in every process, cold (the
reply is the first call) and warmed (three calls on a smaller reply of the shape first), text path unless given:

| Shape | main | before | after |
|---|---|---|---|
| ids, a 17-digit id at element 170, 6 MB, cold / warm | 25.9 / 21.0 | 28.0 / 23.5 | 18.5 / 7.8 |
| series, an unrounded double at 200, 6 MB, cold / warm | 19.2 / 19.8 | 27.4 / 22.3 | 18.3 / 7.3 |
| ids, `nn` at element 170 (not JSON), 6 MB, cold / warm | 4.8 / 0.1 | 13.3 / 6.6 | 5.2 / 0.1 |
| ids, `nul` at 97% (not JSON), 6 MB, cold / warm | 19.2 / 14.2 | 30.8 / 20.7 | 17.6 / 7.8 |
| rounded for 600 then computed doubles, 6 MB, cold / warm | 13.8 / 6.9 | 12.2 / 6.9 | 12.2 / 8.4 |
| numbers, 6.5 MB, cold / warm | 19.3 / 20.2 | 15.5 / 6.5 | 19.0 / 7.6 |
| series with gaps, 6.5 MB, cold / warm | 26.4 / 20.9 | 15.9 / 7.0 | 19.3 / 8.8 |
| computed doubles, 16 MiB, cold / warm | 19.6 / 14.2 | 26.4 / 14.7 | 26.8 / 14.7 |
| flat 16-digit floats, 16 MiB, cold / warm | 19.0 / 14.8 | 26.7 / 14.8 | 26.7 / 14.8 |
| the 200-level nested reply, 16 MiB, cold / warm | 19.4 / 15.2 | 28.1 / 21.8 | 27.1 / 21.8 |
| computed doubles, 16 MiB, bytes, cold / warm | 34.0 / 36.2 | 35.4 / 35.9 | 39.9 / 35.9 |
| ids, a 17-digit id at element 170, 6 MB, bytes, cold / warm | 30.7 / 26.4 | 25.7 / 26.8 | 33.0 / 26.8 |
| numbers, 6.5 MB, bytes, cold / warm | 30.8 / 26.4 | 32.2 / 26.4 | 33.0 / 26.9 |

The readings come in steps of 6-8 MB (single runs of one arm land on either side), so a median one step apart is a
difference of where most runs landed. The review's shapes now peak under main's. Not at or under main everywhere: a
cold process on 16 MiB of floats or the nested reply stays a step over main, as before (the reader gives up those
arrays in its first region now, as it did, so what is left is compiling, not the reply); a series that turns into
computed doubles 1.5 MB over main warmed; the bytes path cold 2-6 MB over.

**Answers.** No answer changed: 0 differences from main's real `json.ts` and `shape.ts` and `JSON.parse` on 31,960
checks (15,980 fuzzed bodies over four fresh seeds, each on the text and the bytes path, with unrounded doubles,
`1e400`, `1E-400`, 21-digit numbers and malformed elements added to the generator) and 51,480 checks of every edge
token (now with those too) at eleven positions of a 1,100-element array, five region sizes and three separators, on the
final tree, plus 17,974 checks over three more seeds on an earlier tree; the scratch buffers clear after every reply;
`long-reply.test.ts`. Linear: `lin.ts`'s shapes cost the same per MB or less from 2 to 16 MB.

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
