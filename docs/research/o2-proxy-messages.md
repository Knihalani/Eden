# O2: the one-line proxy speaks Anthropic's Messages API

Status: built 2026-11-10 on branch `claude/o2-proxy-messages` (from `claude/lucid-hypatia-v9wqk5` at 3ee07ac65).
Decision D653. Paid spend: at most $0.0016 (four Haiku calls of 32-470 input tokens; an upper bound at $1 and $5 per
million tokens, Anthropic-direct lab figures). The live calls came from a scratch script and the session's own
ledger (`.local/o2/`, not in the repo): they cannot be reproduced from this branch.

## In plain words

- **The gap.** A23 ranked this first among the reasons a team would not adopt Eden: the proxy, the only integration
  that needs no code, spoke OpenAI chat completions only. An agent built on Anthropic's SDK had to be changed by
  hand: report every event, collect packets, place them, keep them in place across turns.
- **Now.** The same proxy serves `POST /v1/messages`. An Anthropic-SDK agent changes its base URL and adds one
  header. Setup is two lines: `EDEN_PROXY_UPSTREAM=https://api.anthropic.com/v1 bun run proxy`, and
  `Anthropic(base_url="http://127.0.0.1:8791", default_headers={"x-eden-user-id": user_id})`.
- **It is one implementation, not two.** The Anthropic conversation is read as chat messages, the existing code
  decides what is new, what to report and where packets stay, and the result is written back in Anthropic's shape.
  What the chat route was hardened for (retries, sliding windows, compaction, concurrent turns, the byte budget,
  shadow mode, fail open) runs through the same code; on this route the tests cover retries, `keepPackets` off,
  shadow and fail open, not the rest.
- **Checked against the real API** (one run each, not a measurement): asked "Where is my lunch with Priya Raman,
  and when?", the model said it has no access to the calendar; through the proxy it answered "at Dishoom on
  Thursday at 12:30, and it's confirmed" (700 ms against 741 ms direct, both one call). A request with `system`,
  `metadata.user_id` and a `cache_control` mark was accepted, and so was a message with a packet block between a
  tool result and text (the shape the no-user-turn case below still writes).

## Design (D653)

- **Reading** (`fromAnthropic`). Per Anthropic message: a user message's `tool_result` blocks become `tool`
  messages; any other user message is one `user` message of its text; an assistant message's text is its content
  and its `tool_use` blocks its tool calls. A user message with tool results is not a user turn, and text beside
  them is not reported (the review: harnesses append reminders there, and each tool call would otherwise start a
  turn and wait on a lookup of the harness's words). Thinking, images and documents
  are left out, as the chat route leaves non-text parts out.
- **Writing** (`toAnthropic`). The chat route inserts a packet as a system message before a user message. The
  Messages API has no system role inside `messages`, so the packet becomes a text block of that user message: ahead
  of its other blocks (an image too), after any leading `tool_result` blocks (the API requires those first). Content
  that is neither a string nor blocks is left alone. A string content becomes two
  text blocks. With no user turn after a packet it goes into the last message if that is the user's, and nowhere if
  the request ends with an assistant prefill.
- **The prompt cache.** A kept packet stays in the same message on later requests, so each request's messages start
  with the previous request's (tested: the first request's first message equals the second's). A caller's
  `cache_control` mark on its own block is untouched; the packet is inserted at the front, not after the last block.
  The exception, as on the chat route: when the window has slid past every user turn the packet goes into the
  last tool-result message, which is a different message on the next call.
- **Only `messages` is rewritten** (`withMessages`): `system`, `tools`, `metadata` and the rest go upstream byte for
  byte (tested with a 64-bit integer).
- **Identity.** `x-eden-user-id`, else the body's `metadata.user_id` (Anthropic's field for an end user), read on
  this route only; the chat route still reads only `user`.
- **The route** is `/v1/messages` (or `/messages`) exactly: another API's `…/threads/{id}/messages` is forwarded
  as bytes, as before.
- **Errors.** The proxy's own answers on this route (401, 403, 400, 499, 502) have Anthropic's error shape, which
  its SDKs parse.
- **Untouched.** `/v1/messages/count_tokens`, batches, and every other route are forwarded as they came.

Tests: `packages/proxy/src/proxy-anthropic.test.ts`, 15, with a fake upstream and the real Eden handler in process
(no model key): injection and byte-for-byte forwarding, `metadata.user_id`, a tool turn (the packet in place, each
event reported once, a retry reporting nothing), tool results with text, a later turn, isolation between users,
fail open (Eden down, no user, a body that is not JSON), streaming, token counting, error shape, and the two
translations alone.

## OpenAI's Responses API (D656)

Built after the Messages route, on branch `claude/o2-proxy-responses` (stacked on this one). `POST /v1/responses`
gets the same treatment through `fromResponses` and `toResponses`:

- `input`'s items map one to one onto chat messages: a message item is its role and text (`input_text`,
  `output_text`), a `function_call` an assistant message with that call, a `function_call_output` a tool message.
  A custom tool's call and output are read the same way. Other items (reasoning, references, built-in tools' calls)
  keep their place and are neither reported nor a turn. A packet goes directly before a user message, or at the end
  when the input has none, so it never lands between a reasoning item and its call or between a call and its
  output unless the caller put a user message there.
  A string input is one user message.
- The API takes system items inside `input`, so a packet goes back exactly where the chat route puts its system
  message; every other item is the caller's own object. Only `input` is rewritten (`withMessages` with a key).
- **History held by the provider.** With `conversation` or `previous_response_id` the input is only what is new,
  and what the proxy inserted on an earlier request is already in the provider's history. So nothing is kept in
  place, and each packet is inserted once: the first version put the turn's packet into every tool-output request
  of the turn, and the provider stored a copy each time (the review; tested for both fields). It also needs a
  session: `conversation` names it when no
  `x-eden-session-id` does. With `previous_response_id` alone and no header, each request is its own Eden session
  (keyed by its first message), so Eden may show an item again that it showed on an earlier turn: send the header.
- Tests: `packages/proxy/src/proxy-responses.test.ts`, 8 (injection with the rest byte for byte, a tool turn with a
  reasoning item, `user` and `conversation`, fail open, another `…/responses` route untouched, the translations).
- **Not checked against the real API**: this session's paid calls are limited to Anthropic. The shapes are from
  OpenAI's published reference; a first live call may show a field this misses.

## Not done

- **A measured effect on an Anthropic-SDK agent.** The lab's Pi harness already measures Eden's context in front of
  Haiku; this change is transport. A Pi run through the proxy's Messages route would show nothing the SDK runs do
  not, and was not paid for.
- **Images and documents** in a user message are not reported to Eden (text only, as on the chat route).
