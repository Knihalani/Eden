# @eden/proxy

Eden as an OpenAI-compatible proxy in front of the agent's model (D280): the agent changes only its base URL. Each
`POST …/chat/completions` reports the conversation's new messages to Eden (through `@eden/client`, so it fails open
like the SDK), puts Eden's packets before the latest user message (`withContext`), keeps the turn's packets on every
model call of a tool-using turn and every earlier turn's packets where they were (`keepPackets`, D336), and streams
the upstream's answer back unchanged. `POST …/messages` (Anthropic's Messages API, D653) gets the same treatment
through one translation each way: `fromAnthropic` reads the conversation as chat messages (tool results as `tool`
messages, text as the user turn), the same code decides what is new and where packets go, and `toAnthropic` puts
each packet into its user message as a text block (after `tool_result` blocks, before other text). `POST …/responses`
(OpenAI's Responses API, D656): `fromResponses` reads `input`'s items one to one as chat messages and `toResponses`
puts each packet back as a system item; `conversation` names the session when no header does. Other routes are
forwarded as is.

## Files

| File                          | Owns                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/proxy.ts`                | `createProxy` (identity: `x-eden-user-id` or the body's `user`; conversation: `x-eden-session-id` or a hash of its first non-system message; new messages by content hash, `Conversation.seen`; one deadline per request; `proxyKey`), `eventsOf` (messages to events), `textOf`; D1940: each message hashed once a request (`hashOf`, `Bun.SHA256` held as 32 Latin-1 characters; the retry check and `userKeys` read those hashes), tool names by `toolNamesOf`, not every message's events                                                                                                                   |
| `src/ask.ts`                  | `askTool` (D851, opt-in, D857): `ask_context`'s definition per route, `withAskTool` (added to `tools`, every other byte kept; skipped when the caller has one), `readRound` (a JSON or buffered streamed answer read for its asks: chat `tool_calls`, Anthropic `tool_use` with thinking kept, Responses `function_call`; the round to append), `setKey`, `noToolChoice`                           |
| `src/with-messages.ts`        | `withMessages`: one top-level key of a JSON body's text replaced, every other byte kept (audit A5)                                                                                                                                                                                                                                                                                                 |
| `bench/proxy.bench.ts`        | D1940: the proxy's own µs a request on a growing tool-using conversation (stub upstream and Eden), `[turns] [reps] [srcB]`; with another copy of `src/` it runs both arms interleaved with a self-vs-self control |
| `src/proxy-ask.test.ts`       | `askTool` on the three routes, streamed and not: the tool added, the round appended, the agent's answer the final round's bytes; the caller's own calls left out of a round; the round cap and `tool_choice` none; Eden down; an upstream error on round 2; not offered off, in shadow, without a user, or beside the caller's own `ask_context`                                                   |
| `src/main.ts`                 | `bun run proxy` (`EDEN_PROXY_UPSTREAM`, `EDEN_URL`, `EDEN_API_KEY`, `PROXY_PORT`/`PROXY_HOST`, default 127.0.0.1:8791; `EDEN_PROXY_KEY` required off loopback; `EDEN_PROXY_SHADOW`; `EDEN_PROXY_MAX_BODY_BYTES`, default 64 MB, a chat body with images). At startup (D365): a warning for an upstream with no path, and one `/v1/whoami` probe saying whether Eden is reachable and takes the key |
| `src/proxy-anthropic.test.ts` | The Messages route (D653): injection as a text block with the rest byte for byte, `metadata.user_id` (this route only), a tool turn, text beside tool results not a turn, a later turn, isolation, fail open, `keepPackets` off, shadow, streaming, other `…/messages` routes untouched, error shape, `fromAnthropic`/`toAnthropic` alone                                                          |
| `src/proxy-responses.test.ts` | The Responses route (D656): a string and a list input, a tool turn with a reasoning item, `user` and `conversation`, history held by the provider (a packet sent once; the same short reply after a different `previous_response_id` a new turn), a custom tool's call and output, streaming, fail open, other `…/responses` routes untouched, `fromResponses`/`toResponses` alone                 |
| `src/proxy-a16.test.ts`       | `keepPackets` (D336): off and on, on by default, each request a prefix of the next, Eden down, isolation, shadow; with a scripted Eden: sliding windows, a repeated message in a new turn, an overtaken request, the byte budget, no user message                                                                                                                                                  |
| `src/proxy-speculate.test.ts` | `speculate` (F10, D1273, on by default): off runs Eden's wait and the model in a row; nothing new, one call made during the wait and the same answer; a packet, the speculative call aborted and the packet request's answer; never in shadow or with `askTool`                                                                                                                                       |
| `src/proxy.test.ts`           | A fake upstream and the real Eden handler in process: injection, once-only reporting, compaction and sliding windows, isolation, eviction, keying, the deadline under a slow Eden, `proxyKey`, hop-by-hop headers, tool events, streaming, fail-open, 502, shadow                                                                                                                                  |

## Rules

- **Fail open (D14).** Eden down, slow, refusing, or a body that is not JSON: the request goes upstream as it came.
  All of Eden's work in one request has one deadline (the observe's wait plus 800 ms); what lands later stays for the
  turn's next call. On first sight of a conversation only its latest user message on is reported (no replay of a
  long history). Only an unreachable upstream is an error (502), an unreadable body a 400, both OpenAI-shaped (on
  `/v1/chat/completions` and `/v1/responses`; Anthropic-shaped on `/v1/messages`).
  A caller that hangs up cancels the model call (the upstream fetch takes its signal), and one gone during Eden's
  wait gets a 499 with no model call (D312). Text past 1,000,000 characters is reported cut, not dropped (D312).
- **Auth (D9).** The proxy holds the tenant's Eden key and trusts the user a caller names: off loopback `main.ts`
  refuses to start without `EDEN_PROXY_KEY` (callers send `x-eden-proxy-key`).
- **New messages by content** (`Conversation.seen`: per message hash, copies seen), so compaction and sliding
  windows report what is new and never repeat the old. A turn counter keeps a concurrent older turn's packets out.
  A request ending with a user message already seen ("yes" again) is still a new turn unless its messages repeat the
  previous request's exactly (`Conversation.last`: a retry; a stateless agent saying the same thing twice in a row
  looks the same and is reported once, audit A5).
- **Only `messages` is rewritten** (`withMessages`; on `/responses` only `input`): the rest of the body goes upstream
  byte for byte (a 64-bit `seed` survives), audit A5. With `askTool` (D851) `tools` is rewritten too (the tool added
  first) and the conversation key on each round; every other byte is kept, and the fallback is the request as it
  was.
- **Secrets.** The upstream `Authorization` (or `x-api-key`) is forwarded, never logged; `x-eden-*` headers are not forwarded. `onError`
  gets the client's errors (route, status, reason), never message text or a body.
- **Untrusted text (D11, D19).** Packets are inserted as Eden's envelope, unchanged.
- **Isolation (D9).** Conversation state (what was reported, the turn's packets) is keyed by user and session, bounded
  (`maxSessions`, 10,000, least recent dropped). Two conversations with the same opening and no session header share
  a key (the hash skips system prompts, which may change per request): callers who can should send
  `x-eden-session-id`.
- **Shadow mode** (`shadow`, `EDEN_PROXY_SHADOW=1`): everything is reported and decided, nothing is injected;
  `onShadow` gets ids and counts only. The client sends `?shadow=1`, so the server learns nothing from packets no agent
  saw (D282).
- **Packets stay in place (D336, `keepPackets`, default on; `EDEN_PROXY_KEEP_PACKETS=0` turns it off).** Each turn's
  packet text is kept per conversation by its user message with the message before it (`userKeys`) and inserted before
  that message on every later request (a new turn never takes an older turn's placement; a request overtaken by a newer
  turn neither shows nor keeps that turn's packets), so each request starts with the one before it (Anthropic's cache
  entries end at breakpoints: dropping a packet rewrote the history, +$0.057/1k over days on Pi) and the agent keeps
  items Eden will not send twice in a session. Re-inserting needs no Eden call (Eden down: still in place). At most
  `maxKeptBytes` (64,000 UTF-8 bytes) a conversation: past it placements whose message left the request go first, then
  the oldest. With no user message the turn's packets go where `withContext` puts them. Shadow mode inserts nothing.
- **What is queued is taken on every chat request** (`eden.pending()`), a tool turn's later calls included. A wait
  there for Eden's work behind, and shortened earlier packets, were measured on Pi and not built here (D515, D517,
  docs/research/n3-long.md): the wait cost +746 ms a task for no fact, and shortened packets lost later requests' facts.
- **Onboarding (D365).** `GET /healthz` is answered by the proxy (`{"ok":true}`, before the key checks: it says
  nothing about a user). A chat request naming no user goes upstream untouched, and the first one is reported once to
  `onError` (no content). `examples/onboarding/python-proxy.test.ts` runs `main.ts` as a process under Python.
- **History held by the provider (D656: the Responses API's `previous_response_id` or `conversation`).** The input is
  only what is new and the provider keeps what was inserted, so `keepPackets` is bypassed: each packet is inserted
  once (`Conversation.sent`) and nothing is kept in place. The retry check (`Conversation.last`) also hashes the
  `previous_response_id` (else the `conversation`) the input follows, so "yes" after a different response is a new
  turn. The model's `function_call` items stay with the provider: no tool call is reported, and each output reaches
  Eden as the result of a tool named "tool" (replies are not read for calls).
- **`ask_context` (opt-in `askTool`, D851, D857; `EDEN_PROXY_ASK=1`; not measured through the proxy).** Off: no tool is added and
  an agent that wants it uses the MCP server. On, for a request whose user is named, not in shadow mode, and not a
  Responses request whose history the provider holds or does not store (`previous_response_id`, `conversation`,
  `store: false`): the tool is added (`withAskTool`); each upstream answer that calls it is read (`readRound`), up to
  `MAX_ASKS_PER_ROUND` (4) asks are answered by `eden.ask` within one `ASK_LOOP_MS` (8 s) deadline (others, and any
  after the caller hung up: `NO_CONTEXT`), the round is appended to a copy of the conversation and the model called
  again, at most `MAX_ASK_ROUNDS` (3) rounds. A streamed round is buffered whole (the first token waits); the answer
  that does not ask goes to the agent byte for byte. A first round refused for its shape (a 4xx other than 401, 403 and 429: a model
  with no tool support), a later round's upstream error, a round that cannot be read or rewritten, or an answer still
  asking after the last round: the agent's own request goes upstream instead, without the tool (D14: never an unknown tool call or a trial-made error); `tool_choice` is never touched.

- **`speculate` (F10, D1273, on by default since the integrator's promotion; `speculate: false` or
  `EDEN_PROXY_SPECULATE=0` turns it off).** At a new turn the request goes upstream before
  Eden's wait, shaped as it would be with no packet for the turn (`keptInPlace` with none); after the wait, a request
  byte for byte the same takes the held answer (unless it is a 429 or 5xx: then the request goes again), any other
  aborts it and goes as today. Chat and Anthropic routes only (not Responses); not with `askTool`, in shadow mode or
  with `store: true`. An aborted call is billed its input and any output written or billed after the abort.

- **One pass over the history a request (D1940).** Work over every message of a request grows with the
  conversation (548 KB by a coding agent's 30th turn): hash each message once in `withEden`'s loop and hand the
  hashes on (main hashed the history three or four times, 61% of the proxy's own time), and never build every
  message's events to learn one thing (`toolNamesOf`). The digests are keys only: keep them SHA-256 (a weaker hash
  lets a tool output be crafted to collide with a later message, which then goes unreported), and keep any key built
  from them injective (fixed-length digests, a length before free text). `bench/proxy.bench.ts` times it.

## Test

```bash
bun run test:pkg proxy     # < 1 s
bun packages/proxy/bench/proxy.bench.ts 30 7   # the history work on a growing conversation, ~20 s
```
