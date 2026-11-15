# Low-level round 4: the edge

A low-level pass over Eden's edge (the server's request path apart from the router's `userOf`, which D1925 did; the
proxy; the TypeScript client; `@eden/protocol`'s validation; `@eden/llm`'s request and response handling), from main
7bca42093, behaviour-preserving. Decisions D1940 (adopted) and D1941 (finding). Every number below comes from a
command run in this session on a shared 4-core machine whose load average ran from 3.5 to 16 while other agents
benchmarked; ranges are wide and each comparison carries a self-vs-self control arm as its noise floor.

**Method.** Main's code kept as the oracle beside the new (untracked copies of `packages/proxy/src`,
`packages/server/src` and `packages/protocol/src/validate.ts` at 7bca42093), imported into the same process.
Timings interleaved and slot-balanced (the arms' order rotates every repetition), with a second instance of the new
code as the control, with and without a forced GC before each batch; medians, and the paired median of the ratio.
Exactness by differential fuzzing against the oracle and by mutants that the fuzz must catch.

What the earlier rounds left: D1892 cut the handler's URL and header work; D1893 found nothing in a model call's own
CPU (120-145 µs against a 600-1,000 ms wait); D1918 found the client's per-call work (1.6-2.0 µs) is noise beside a
round trip, and did not look at the proxy's history work; D1740-D1742 found no output-invariant prompt cut of 10% or
more, and D1790, D1800 and D1810 settled the cache layout. So this round looked for work that grows with something:
a conversation's length, a body's size.

## The proxy read every request's whole history three or four times (D1940)

`bench/proxy.bench.ts` (new) replays a coding agent's tool-using turns through `createProxy` with a stub upstream
and a stub Eden that answer at once: each turn a user message, three tool rounds (a call with ~1 KB of arguments, a
~6 KB result) and a reply, every model call a request, so the 30th turn's requests carry 548 KB of history. A CPU
profile of main on it: `hashOf` 61% of the run (SHA-256's `update` alone 47%), `JSON.parse` 16%, `JSON.stringify`
12%. Each request hashed every message in the "what is new" loop, again for the retry check, and again in `userKeys`
(once more on a new turn, for the speculative request), and called `eventsOf` on every message only to learn tool
names, which parsed and re-serialized every tool call's arguments.

Changed, with the same answers:

- each message is hashed once a request, in the loop, and the retry check and `userKeys` read those hashes;
- the loop learns tool names by `toolNamesOf`, which does exactly what `eventsOf` did to the name map (and throws
  where it threw, on a null message) without building events;
- digests come from `Bun.SHA256` (the same digest as `createHash`, 4.3-4.9 against 7.0-8.9 µs a 6 KB message; Node
  keeps `node:crypto`) and are held as their 32 bytes in a Latin-1 string rather than 64 hex characters. They are
  map keys only, compared for equality, never shown or sent (the session id Eden sees still hashes as before). The
  retry check's key is built from the held value's length, the value and the fixed-length digests, so it is as
  injective as the hex join was.

| `proxy.bench.ts`, µs a request (median of 7)  | Main | This | Main / this | Control |
| --------------------------------------------- | ---: | ---: | ----------: | ------: |
| 30 turns, every request (no GC)               | 1,585 | 680 | 2.19x | 1.02 |
| 30 turns, the last turn's 4 requests (no GC)  | 3,191 | 1,404 | 2.21x | — |
| 30 turns, every request (forced GC)           | 1,703 | 823 | 2.02x | 1.04 |
| 30 turns, the last turn's 4 requests (forced GC) | 2,765 | 1,321 | 2.22x | — |
| 8 turns (148 KB), every request               | 554 | 259 | 2.17x | 1.31 |

After the change the profile is SHA-256 once (40%), the body's own `JSON.parse` (26%) and `JSON.stringify` of tool
calls inside `hashOf` (13%). Memory: 300 conversations of 241 messages, heap after a forced GC, 32.7 KB a
conversation on main against 24.9 KB here (−24%), all of it the shorter `seen` keys; at the proxy's caps (10,000
conversations, 2,000 digests each) the digests' worst case falls by about the same share.

**Exactness.** A differential (a scratch script, not committed): the old and new proxies side by side on random conversations (chat, Messages
and Responses routes; system and developer messages, null and odd-typed messages, tool calls with and without ids or
names, sliding windows, retries, `previous_response_id`, `keepPackets` and `speculate` on and off, a byte budget of
80 so placements are evicted) with a scripted Eden that gives packets on some events and pending calls; every Eden
request body (its `at` aside, which is the clock), every upstream body and every response compared. 6 seeds, 2,400
conversations, 15,613 requests: 0 differences. Two of three mutants were caught (skipping the tool-name map: 8
differing requests in 1,292; `userKeys` reading its neighbour's hash: 25); the third (the retry check counting
developer messages) was not, as the generator rarely changes a developer message between two requests. The
package's 88 tests pass.

## The server's shape check scanned every byte of every body (D1940)

`bodyShapeUnder` refuses a padded body before `JSON.parse` (D100: at most 1,010,000 values and 1,008 levels outside
strings). Its byte scan costs more than the parse it guards on many ordinary bodies (a 5.9 KB tool result 3.5 µs, a
63 KB one 57 µs). But a body of at most 1,010,000 bytes cannot hold more values (each is a byte), and one with at
most 1,008 opening brackets anywhere, in strings or not, cannot nest deeper outside them. `bodyShapeQuick` counts
`{` and `[` with the native `indexOf` and passes such a body; anything else is scanned as before, so a false from
the count decides nothing. A body dense in brackets stops counting after 64 if they come often enough to pass the
bound, so it costs at most 64 searches more than the scan. The scan itself (`bodyShapeWithin`, vendored in
`sources/src/mcp/shape.ts`) is unchanged; the router's `padded` check goes through
`bodyShapeUnder` too (stdio reads with `parseJsonBytes`, below).

| `bodyShapeUnder`, µs (median of 7 interleaved, no GC) | Main | This | This / main | Control |
| ----------------------------------------------------- | ---: | ---: | ----------: | ------: |
| a user message (0.2 KB)                               | 0.26 | 0.09 | 0.35 | 0.96 |
| a tool result (5.9 KB)                                | 3.54 | 0.61 | 0.15 | 1.02 |
| a tool result, pretty-printed (63 KB)                 | 56.7 | 6.0 | 0.10 | 1.03 |
| 100 pushed items (45 KB)                              | 18.7 | 3.3 | 0.17 | 1.04 |
| a tool result of 1,200 rows (631 KB; past the count)  | 561 | 562 | 1.01 | 1.03 |
| a tool call of 2,000 objects (950 KB; past the count) | 444 | 448 | 1.03 | 1.12 |
| 4 KB of brackets in a string (the worst case)         | 0.17 | 1.58 | 9.2 | 1.01 |

With a forced GC before each batch the same shape: 0.35, 0.17, 0.10, 0.16, 0.95, 1.06 and 10.3. The worst case adds
about 1.4 µs, once, to a body no integration sends.

**Exactness.** `validate.test.ts` now checks `bodyShapeQuick` against the plain byte loop on its 6,000 seeded bodies
at the existing bounds and at bounds where the count decides (passing on more than 1,000 of them), and at the count's
own edges (every bracket nested, bodies all structure, each at its bound, one under, one over); off-by-one mutants of
both bounds fail it. A scratch differential against main's `bodyShapeUnder` on 200,000 random bodies (4 seeds,
1,164-1,216 refused each): 0 differences.

## A tool call's check stringified its input to measure it (D1940)

`checkEvent` refuses a tool call whose input's JSON passes 1,000,000 characters by building that JSON, most of the
check's cost: 0.55 of 0.96 µs for a 206-character input, 3.0 of 3.6 at 1,466, 275 of 268 µs at 140,066 (the engine
builds the same JSON again later, `partner.ts`). `JSON.stringify` of a parsed value is never more than six times as
long as the text it was parsed from: a number written short grows most ("1e20" is 21 characters, 5.25x), a raw lone
surrogate becomes a 6-character escape (none survive the server's UTF-8 decode, but the bound holds without that),
white space and repeated keys go, and no escape in the text is shorter than what stringify writes. So `checkEvent`
takes the decoded body's length (`sourceChars`, default Infinity) and skips the stringify when six times it is at
most the bound; the depth and size walk still runs first. The server passes it.

`validate.test.ts` checks the growth bound on the worst cases by hand and on 20,000 seeded texts (the largest seen
above 4), that the answers match with and without the length, and that 230,000 characters of `1e20` (about
1,012,000 as JSON) are refused either way (a threshold raised to a quarter fails it). A scratch differential of the
whole handler (this tree's `createHandler` against main's, with main's protocol) on 140,000 fuzzed bodies (7 seeds:
events of every kind, tool calls with nested inputs of short numbers and escapes, some 150,000-300,000 characters of
`1e20` either side of the bound, bad ids, a foreign tenant, padded and non-JSON bodies; 200, 400 and 403 answers):
status and body bytes identical in every one.

**The handler, both changes** (in process: this tree's handler, main's and a second instance of this tree's, with
a stub partner, interleaved over 9 repetitions; four runs, two with no GC and two with a forced GC before each
batch, at load averages 7.8 and 16; paired medians of this / main, and of the control):

| Body                     | This / main, no GC | This / main, forced GC | Control, all four runs |
| ------------------------ | -----------------: | ---------------------: | ---------------------: |
| a tool call (140 KB)     |       0.514, 0.491 |           0.511, 0.580 |              0.98-1.14 |
| a tool result (63 KB)    |       0.764, 0.614 |           0.617, 0.705 |              0.82-1.05 |
| 100 pushed items (45 KB) |       0.720, 0.838 |           0.819, 0.810 |              0.93-1.01 |
| a tool call (1.5 KB)     |       1.047, 0.825 |           0.832, 0.885 |              0.88-1.07 |
| a tool result (5.9 KB)   |       0.908, 0.822 |           0.854, 0.972 |              0.88-1.12 |
| a user message           |       1.130, 0.878 |           1.148, 0.942 |              0.70-0.85 |

Small bodies sit inside the noise; the gain is on the large ones, where the handler's own work was the scan, the
parse and the stringify. Over HTTP a round trip is about
100 µs of Bun's own work (D1894), so the 1-5 KB bodies most integrations send gain about nothing end to end; a
140 KB tool call saves about 290 µs of the server's one thread.

## What is already as cheap as it gets (D1941)

- **The rest of the handler is Bun's.** Profiled after the change (`bench/http.bench.ts inproc`): Bun's `Request`
  18%, `Response.json` 14%, `JSON.parse` 11%, `bytes()` 6%, `arrayBuffer` 4.5%, `TextDecoder` 4%; the handler's own
  functions (routing, auth, the limiter, counters, stats) 1-5% each.
- **`req.json()` is not cheaper than bytes, decode and parse:** 21.6 against 8.9 µs a 7 KB body, 99 against 90 at
  64 KB (it does win at 645 KB, 778 against 1,222, but the shape check needs the bytes first, D100).
- **Latin-1 decoding is no win on ASCII bodies:** 275 against `TextDecoder`'s 258 µs at 645 KB (Bun's decoder
  already has an ASCII path; Latin-1 is wrong for UTF-8 anyway).
- **The tool call's shape walk stays.** The body's depth bound (1,008) is not the input's (1,000), so the walk is
  still needed after the byte check.
- **The client, the Python client and the model path were not changed.** D1918 (the client's 1.6-2.0 µs above a
  bare `Response`) and D1893 (a model call's own CPU 0.02% of its wait) stand; they were not re-measured here. D1742's
  token survey and D1790/D1800/D1810's cache layout were not reopened (no prompt byte moved in this round).
- **The proxy's per-message hash cannot be cached across requests without holding the text** (each request's
  strings are new; a key by content would hold every message), and a non-cryptographic hash (Bun's wyhash, about ten
  times faster) would make collisions possible to craft: a message an attacker's tool output collides with would go
  unreported. Not built.
- **The stdio transport** cuts lines from bytes with native `indexOf` and joins a split line once; its shape check
  is `parseJsonBytes` (D1904). Nothing to take.
