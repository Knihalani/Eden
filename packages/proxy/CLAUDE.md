# @eden/proxy

Eden as an OpenAI-compatible proxy in front of the agent's model (D280): the agent changes only its base URL. Each
`POST …/chat/completions` reports the conversation's new messages to Eden (through `@eden/client`, so it fails open
like the SDK), puts Eden's packets before the latest user message (`withContext`), keeps the turn's packets on every
model call of a tool-using turn and every earlier turn's packets where they were (`keepPackets`, D336), and streams
the upstream's answer back unchanged. Other routes are forwarded as is.

## Files

| File | Owns |
|---|---|
| `src/proxy.ts` | `createProxy` (identity: `x-eden-user-id` or the body's `user`; conversation: `x-eden-session-id` or a hash of its first non-system message; new messages by content hash, `Conversation.seen`; one deadline per request; `proxyKey`), `eventsOf` (messages to events), `textOf` |
| `src/main.ts` | `bun run proxy` (`EDEN_PROXY_UPSTREAM`, `EDEN_URL`, `EDEN_API_KEY`, `PROXY_PORT`/`PROXY_HOST`, default 127.0.0.1:8791; `EDEN_PROXY_KEY` required off loopback; `EDEN_PROXY_SHADOW`) |
| `src/proxy-a16.test.ts` | `keepPackets` (D336): off and on, on by default, each request a prefix of the next, Eden down, isolation, shadow; with a scripted Eden: sliding windows, a repeated message in a new turn, an overtaken request, the byte budget, no user message |
| `src/proxy.test.ts` | A fake upstream and the real Eden handler in process: injection, once-only reporting, compaction and sliding windows, isolation, eviction, keying, the deadline under a slow Eden, `proxyKey`, hop-by-hop headers, tool events, streaming, fail-open, 502, shadow |

## Rules

- **Fail open (D14).** Eden down, slow, refusing, or a body that is not JSON: the request goes upstream as it came.
  All of Eden's work in one request has one deadline (the observe's wait plus 800 ms); what lands later stays for the
  turn's next call. On first sight of a conversation only its latest user message on is reported (no replay of a
  long history). Only an unreachable upstream is an error (502), an unreadable body a 400, both OpenAI-shaped.
- **Auth (D9).** The proxy holds the tenant's Eden key and trusts the user a caller names: off loopback `main.ts`
  refuses to start without `EDEN_PROXY_KEY` (callers send `x-eden-proxy-key`).
- **New messages by content** (`Conversation.seen`: per message hash, copies seen), so compaction and sliding
  windows report what is new and never repeat the old. A turn counter keeps a concurrent older turn's packets out.
  A request ending with a user message already seen ("yes" again) is still a new turn unless its messages repeat the
  previous request's exactly (`Conversation.last`: a retry; a stateless agent saying the same thing twice in a row
  looks the same and is reported once, audit A5).
- **Only `messages` is rewritten** (`withMessages`): the rest of the body goes upstream byte for byte (a 64-bit
  `seed` survives), audit A5.
- **Secrets.** The upstream `Authorization` is forwarded, never logged; `x-eden-*` headers are not forwarded. `onError`
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
- No `ask_context` is added to the request's tools: an agent that wants it uses the MCP server.

## Test

```bash
bun run test:pkg proxy     # < 1 s
```
