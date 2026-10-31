# Integrating Eden into a tenant's agent

**Status: advice, mostly unmeasured.** This guide collects what the econ research (D65–D71,
[research/econ-research.md](research/econ-research.md) §2 and §8 R10) suggests a tenant do in its own agent loop to
spend less and answer sooner. Only the points marked **measured** come from a run, and those runs are in-sample
(simulated worlds, the Pi harness, one agent model); everything else is reasoning from vendors' documentation and
D64's timelines, not tested in a tenant's agent. Measure in your own agent before relying on any of it.

## The loop

```ts
import { EdenClient, withContext } from "@eden/client";

const eden = new EdenClient({ apiKey, userId, sessionId });
const { injection } = await eden.observe({ kind: "user_message", text }); // report each event
messages = withContext(messages, await eden.collect(injection)); // before each model call
```

- **One `userId` per end user, one `sessionId` per conversation.** Eden keys every piece of state by tenant, user and
  session (D9); a shared id would mix users' context.
- **Report every event**: user messages, the agent's tool calls and results, arriving messages. Eden stays silent on
  most of them; the ones it reads are how it knows what the agent is about to do.
- **Inject before each model call, not only the first**: work Eden finishes after the first request (the slow path, a
  poll behind the lookup, D65) is delivered at the next one through `collect`/`pending`.
- **The SDK fails open.** A timeout or an error is "no context", never an exception in the agent's loop. Keep it that
  way in your wrapper.

## Keep `ask_context` (measured, D70)

Give the agent `ask_context` as a tool (the MCP server's, or `eden.ask` behind a tool of your own) with **Eden's own
description**, even though Eden also injects context unasked.

In-sample, removing the tool so the agent answers in one turn cut agent cost 27% and wall time about 3 s, but the agent
raised the decisive fact 0.12 less often (−0.119, −0.196..−0.047), and less often even when the injected packet already
held it (0.837 against 0.913). Rewording the description to discourage asking lowered the ask rate (0.82 → 0.73) and
did not save money. The agent's own rephrased question reaches items the user's words did not; that is worth the round
trip. Eden answers an ask in about 5 ms at p50 (D64), so the cost of asking is the agent's extra model request.

## Keep the provider's prompt cache warm

- **Put Eden's packet after the stable prefix.** `withContext` inserts it as a system message just before the latest
  user message, so the system prompt, tool definitions and earlier *turns* stay byte-identical between requests. It
  does not keep the cache within a turn that calls tools: a packet injected before the turn's next model call lands
  before the user message, ahead of the assistant's tool call and the tool result, so the previous request is no
  longer a prefix and the cache misses from that point on. To keep it, append a mid-turn packet at the end of the
  messages (after the tool result) yourself, or accept the miss. Anything you place earlier than the end breaks the
  cache from that point on.
- **Keep the prefix byte-stable.** No timestamps, request ids or reordered tool lists in the system prompt; serialise
  tool definitions deterministically.
- **Pass a per-user cache key.** On OpenRouter, a `session_id` (or `x-session-id`) per end user starts sticky routing on
  the first request, so later requests reach the endpoint holding the cache. Make it an opaque id, such as a hash of
  your user id, never an email or a raw account id: it goes to OpenRouter and the endpoints it routes to. Eden's own
  model calls send a truncated SHA-256 of the user's scope (`eden-` and 24 hex), never the raw id.
- **What it is worth depends on the endpoint** (estimate): GLM 5.3 Flash's cheapest routed endpoints barely discount
  cached input, so at routed prices caching saves about nothing on short tasks; at Z.AI's list price the ceiling is
  about 17% of agent cost, more with a long tenant system prompt.

## Spend fewer output tokens

Output tokens are where the time goes: in D64 a request took about 743 ms plus 7.7 ms per output token, input size
made no measurable difference, and output was 85% of the agent's model time (**measured**, D64's timelines). The
levers are the agent's:

- **Ask for concise final answers.** The final answer was about 480 output tokens at p50; it is the largest single
  term in a task's wall time.
- **Use low reasoning effort on the call that decides whether to use a tool**, where the model and provider allow it.
  Eden's own judge does (D45). Unmeasured for a tenant's agent: check that facts found do not fall.

## Route the agent's model deliberately

OpenRouter's default load balancing spreads a model over endpoints up to 10× apart in price and in speed per token. If
you compare two versions of your agent, pin the endpoint (`provider.order` with no fallbacks) or re-price both at one
endpoint's prices, as Eden's lab does (D71); otherwise the comparison measures routing. In production, `provider.sort`
(`"price"`, `"latency"` or `"throughput"`) states which you want.

## Agents that act: the action firewall (opt-in, D69)

If your agent sends, books, pays or orders through its own tools, check each such call before it runs:

```ts
import { heldResult } from "@eden/client";

const check = await eden.check(toolName, args);
if (check.verdict === "finding" && check.finding) return heldResult(toolName, check.finding); // or ask the user
```

- The server needs `actionCheck` (off by default) and the grounds it reads (`probes`, `groundConflict`, `groundAway`,
  `graph`, `cards`) in its engine config.
- Eden returns context as data and never "do not"; whether to hold the call, ask the user or go ahead is your policy.
  `heldResult` is one choice: hold the call and let the agent call again to go ahead.
- The check makes no model call and no source call (4–5 ms p50 in the lab). It fails open: an error or a server without
  the flag returns `proceed`.
- Tool arguments are your user's data. Eden passes them through its secret gate first and leaves free-text fields out
  of the check. The redacted argument words join the session's term vocabulary, whatever the answer, and the session
  keeps a 24-hex digest of each call it answered with a finding; all of it is dropped with the session. The call is not
  added to the session's window and nothing is sent anywhere. See [PRIVACY.md](PRIVACY.md) (the action firewall row).
- **Measured** beside a tools-only agent in one in-sample seed (unsafe actions 0.269 → 0.134); beside Eden's full
  configuration its own effect was about one task in 134. Treat it as an option for tool-acting agents, not a default.

## Fresh sources without polling: push (opt-in, D66)

If your connector platform already holds change watches (Gmail watch, Calendar push channels, Graph subscriptions,
Slack Events), relay their notices to Eden so a synced source counts as current until a notice says otherwise and a
lookup never waits for a poll. Today this is an engine API (`ContextPartner.sourcePushes` and `sourceChanged`, with
`sync` and `syncPush`); there is no HTTP route for it yet. A notice carries no content: Eden reads the change through
the same read-only tools (D7). The connectors' push APIs cost about nothing in fees (research §5); the costs are your
relay endpoint and watch renewal (7 days for Gmail and Outlook).

## Configuration

Every experimental flag is off by default. D64's recommended experimental configuration is ALL; a successor with the
econ flags (`syncPollBehind`, `decideConflict`, `cardsEconomy`, `packetDates`, card maker routed by price) waits on the
blind run before it is recommended (D72, to come). [DECISIONS.md](DECISIONS.md) holds each flag's evidence.
