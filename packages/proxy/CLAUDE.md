# @eden/proxy

Eden as an OpenAI-compatible proxy in front of the agent's model (D280): the agent changes only its base URL. Each
`POST …/chat/completions` reports the conversation's new messages to Eden (through `@eden/client`, so it fails open
like the SDK), puts Eden's packets before the latest user message (`withContext`), keeps the turn's packets on every
model call of a tool-using turn, and streams the upstream's answer back unchanged. Other routes are forwarded as is.

## Files

| File | Owns |
|---|---|
| `src/proxy.ts` | `createProxy` (identity: `x-eden-user-id` or the body's `user`; conversation: `x-eden-session-id` or a hash of its first two messages), `eventsOf` (messages to events), `textOf` |
| `src/main.ts` | `bun run proxy` (`EDEN_PROXY_UPSTREAM`, `EDEN_URL`, `EDEN_API_KEY`, `PROXY_PORT`/`PROXY_HOST`, default 127.0.0.1:8791) |
| `src/proxy.test.ts` | A fake upstream and the real Eden handler in process: injection, once-only reporting, tool events, streaming, fail-open, 502 |

## Rules

- **Fail open (D14).** Eden down, slow, refusing, or a body that is not JSON: the request goes upstream as it came.
  Only an unreachable upstream is an error (502, OpenAI-shaped).
- **Secrets.** The upstream `Authorization` is forwarded, never logged; `x-eden-*` headers are not forwarded. `onError`
  gets the client's errors (route, status, reason), never message text or a body.
- **Untrusted text (D11, D19).** Packets are inserted as Eden's envelope, unchanged.
- **Isolation (D9).** Conversation state (what was reported, the turn's packets) is keyed by user and session, bounded
  (`maxSessions`, 10,000, least recent dropped). Two conversations with the same opening and no session header share
  a key: callers who can should send `x-eden-session-id`.
- **Shadow mode** (`shadow`, `EDEN_PROXY_SHADOW=1`): everything is reported and decided, nothing is injected;
  `onShadow` gets ids and counts only.
- No `ask_context` is added to the request's tools: an agent that wants it uses the MCP server.

## Test

```bash
bun run test:pkg proxy     # < 1 s
```
