# O2: the one-line proxy speaks Anthropic's Messages API

Status: built 2026-11-10 on branch `claude/o2-proxy-messages` (from `claude/lucid-hypatia-v9wqk5` at 3ee07ac65).
Decision D653. Paid spend: at most $0.0016 (four Haiku calls of 32-470 input tokens; an upper bound at $1 and $5 per
million tokens, Anthropic-direct lab figures).

## In plain words

- **The gap.** A23 ranked this first among the reasons a team would not adopt Eden: the proxy, the only integration
  that needs no code, spoke OpenAI chat completions only. An agent built on Anthropic's SDK had to be changed by
  hand: report every event, collect packets, place them, keep them in place across turns.
- **Now.** The same proxy serves `POST /v1/messages`. An Anthropic-SDK agent changes its base URL and adds one
  header. Setup is two lines: `EDEN_PROXY_UPSTREAM=https://api.anthropic.com/v1 bun run proxy`, and
  `Anthropic(base_url="http://127.0.0.1:8791", default_headers={"x-eden-user-id": user_id})`.
- **It is one implementation, not two.** The Anthropic conversation is read as chat messages, the existing code
  decides what is new, what to report and where packets stay, and the result is written back in Anthropic's shape.
  Everything the chat route was hardened for (retries, sliding windows, compaction, concurrent turns, the byte
  budget, shadow mode, fail open) applies unchanged.
- **Checked against the real API** (one run each, not a measurement): asked "Where is my lunch with Priya Raman,
  and when?", the model said it has no access to the calendar; through the proxy it answered "at Dishoom on
  Thursday at 12:30, and it's confirmed" (700 ms against 741 ms direct, both one call). A user message holding a
  tool result and text, and a request with `system`, `metadata.user_id` and a `cache_control` mark, were accepted.

## Design (D653)

- **Reading** (`fromAnthropic`). Per Anthropic message: a user message's `tool_result` blocks become `tool`
  messages, then its text blocks one `user` message; an assistant message's text is its content and its `tool_use`
  blocks its tool calls. A user message of tool results alone is not a user turn. Thinking, images and documents
  are left out, as the chat route leaves non-text parts out.
- **Writing** (`toAnthropic`). The chat route inserts a packet as a system message before a user message. The
  Messages API has no system role inside `messages`, so the packet becomes a text block of that user message: ahead
  of its other text, after its `tool_result` blocks (the API requires those first). A string content becomes two
  text blocks. With no user turn after a packet it goes into the last message if that is the user's, and nowhere if
  the request ends with an assistant prefill.
- **The prompt cache.** A kept packet stays in the same message on later requests, so each request's messages start
  with the previous request's (tested: the first request's first message equals the second's). A caller's
  `cache_control` mark on its own block is untouched; the packet is inserted before the first text block, not after
  the last.
- **Only `messages` is rewritten** (`withMessages`): `system`, `tools`, `metadata` and the rest go upstream byte for
  byte (tested with a 64-bit integer).
- **Identity.** `x-eden-user-id`, else the body's `metadata.user_id` (Anthropic's field for an end user).
- **Errors.** The proxy's own answers on this route (401, 403, 400, 499, 502) have Anthropic's error shape, which
  its SDKs parse.
- **Untouched.** `/v1/messages/count_tokens`, batches, and every other route are forwarded as they came.

Tests: `packages/proxy/src/proxy-anthropic.test.ts`, 11, with a fake upstream and the real Eden handler in process
(no model key): injection and byte-for-byte forwarding, `metadata.user_id`, a tool turn (the packet in place, each
event reported once, a retry reporting nothing), tool results with text, a later turn, isolation between users,
fail open (Eden down, no user, a body that is not JSON), streaming, token counting, error shape, and the two
translations alone.

## Not done

- **OpenAI's Responses API** (`/v1/responses`). With `previous_response_id` the history lives at the provider and
  the proxy sees only the latest input, so "what is new" and "where packets stay" need a different design.
- **A measured effect on an Anthropic-SDK agent.** The lab's Pi harness already measures Eden's context in front of
  Haiku; this change is transport. A Pi run through the proxy's Messages route would show nothing the SDK runs do
  not, and was not paid for.
- **Images and documents** in a user message are not reported to Eden (text only, as on the chat route).
