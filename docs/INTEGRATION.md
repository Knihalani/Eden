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
- **Ids are 1-128 characters of `[A-Za-z0-9._:@-]`** (`isId` in `@eden/protocol`) for `tenantId`, `userId` and
  `sessionId`. The server refuses anything else with a 400, so `alice+work@x.com`, `chat/123` or an id with a space
  get no context at all. Map ids you do not control with `edenId(raw)` from `@eden/client`: it keeps a valid id as it
  is and maps any other string injectively (a reversible escape of its UTF-16 code units, `e:alice_2bwork@x.com`, or
  `h:` + SHA-256 when that would pass 128 characters), so two users never share an id, even when an id holds a lone
  surrogate from cutting a string mid-character. Use the same mapping everywhere; the id is how Eden
  finds the user's state next time. Never fold a bad id by replacing characters (`+` to `-` would merge
  `alice+work@x.com` with `alice-work@x.com`). The client reports a bad id once through `onError` when it is
  constructed.
- **Set `onError`.** A refused key or id, a wrong port and a down server all look like Eden's normal silence
  otherwise: the SDK swallows every error (it fails open) and has no default logger. The error's message carries the
  server's reason (`eden /v1/events: 400 userId must be 1-128 characters of [A-Za-z0-9._:@-]`), capped at 300
  characters; it never includes the request or the key.
- **Check the setup with `health()`** at startup: `await eden.health()` resolves `{ ok: true }` when the server
  answers and accepts the key, the tenant and the ids, and `{ ok: false, error }` otherwise. It never throws and
  changes no state (it reads the digest).
- **Report every event**: user messages, the agent's tool calls and results, arriving messages. Eden stays silent on
  most of them; the ones it reads are how it knows what the agent is about to do.
- **Inject before each model call, not only the first**: work Eden finishes after the first request (the slow path, a
  poll behind the lookup, D65) is delivered at the next one through `collect`/`pending`.
- **The SDK fails open.** A timeout or an error is "no context", never an exception in the agent's loop. Keep it that
  way in your wrapper.

## How long to wait on the user message (`waitMs`; NEW only, D98)

`observe` takes a `waitMs` option: how long the server may hold the user message's observe for a fresher answer
before it replies. The client sends none by default; the server treats a missing value as 0 and caps it at 5,000 ms.
The client's own timeout for that request is 800 ms plus `waitMs`, so a long wait does not make the SDK give up early.
Work still running when the wait ends arrives later through `pending`/`collect`, as above.

- **Default configuration: no long wait needed.** Without the experimental reader, the observe returns as soon as its
  lookup is done, so `waitMs` only bounds a slow lookup.
- **Running NEW (`readerPush` with `askReader`, D98): pass about `waitMs: 3000` on the user message's observe.** The
  reader then reads the request on the critical path, and its call is paid for whatever wait you pass; with too short
  a wait its packet lands after the agent has answered. **Measured** in the lab (Haiku 5.5, simulated worlds), against
  the harnesses' 3,000 ms: a 1 s wait lost 7.6 points (Pi, Eden-only arm) and 18.1 points (Pi, tools-plus-Eden arm)
  of hidden facts raised, with wall time p50 within 0.15 s (D98); no wait lost 18.2 to 32.3 points on train (D99,
  [research/haiku-phase3.md](research/haiku-phase3.md)). The reader took 1,190 ms at p50 and 1,768 ms at p90 there
  (prompt v7), so a wait under about 2 s misses some readings; no wait between 1 s and 3 s was measured.
- The production server does not wire a reader yet (turning NEW on needs a provider decision first, D98), so the
  second point applies to lab or self-built deployments.

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

## Connect each user's own sources (D104)

The server reads the end user's accounts with that user's credentials, never another's. Two ways to say which:

- **A file**, for a small deployment: `EDEN_USER_SOURCES_FILE=users.json`, one entry per `"<tenantId>/<userId>"`.
  Header values can name an environment variable, so the file holds no token:

  ```json
  {
    "users": {
      "acme/u1": [
        {
          "kind": "mcp",
          "id": "notes",
          "description": "The user's notes",
          "url": "https://notes.example.com/mcp",
          "headers": { "Authorization": { "env": "U1_NOTES_TOKEN" } },
          "searchTool": { "name": "search_notes" }
        },
        { "kind": "static", "id": "faq", "description": "Team FAQ", "docs": [] }
      ]
    }
  }
  ```

  The file is checked at startup (a bad entry or an unset env header stops the server with a message naming it) and
  re-read when it changes, entry by entry (a broken entry is that user's error; the rest apply). `EDEN_SOURCES_FILE` stays for static documents every user shares; its entries need `docs`.
- **Your own directory**, when you embed the server: `new UserSources({ directory: async (scope) => specs })` reads
  the user's connected accounts and tokens from your vault, then pass `userSources.resolver` to `buildPartner` and
  `userSources` to `createHandler`. Return specs with `url` and `headers` (or the same `transport` function while a
  connection is unchanged: a new function is read as a new credential and reconnects). Put credentials in `headers`
  or `transport`, never in a `searchTool.args` closure: `args` is compared by its text, so a rotated token there is
  not noticed.

What Eden does with them: an MCP source must pass the read-only check (D7: `readOnlyHint: true`, or the tool named in
`trustedReadTools` after you checked it by hand). Connections open on the first lookup and are kept per (tenant, user,
source). The directory is asked again at most every 60 s: a rotated token reconnects, a removed source closes, and a
directory error (or no answer within 5 s) closes the user's connections and serves them only the shared sources until
it is fixed. `POST /v1/sources
{userId}` lists what a user has, or answers 422 naming their configuration error. `POST /v1/forget` closes the
user's connections as well as dropping what Eden holds; a user idle 15 minutes is closed too
(unless background sync keeps reading them), and each tenant holds at most 10,000 users' connections. Forget does not edit
your configuration: to revoke a connection, remove it from the directory (and forget, to drop what was read).

## Configuration

Every experimental flag is off by default. D64's recommended experimental configuration is ALL; a successor with the
econ flags (`syncPollBehind`, `decideConflict`, `cardsEconomy`, `packetDates`, card maker routed by price) waits on the
blind run before it is recommended (D72, to come). [DECISIONS.md](DECISIONS.md) holds each flag's evidence.
