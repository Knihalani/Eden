# Integrating Eden into a tenant's agent

**Status: advice, mostly unmeasured.** This guide collects what the econ research (D65–D71,
[research/econ-research.md](research/econ-research.md) §2 and §8 R10) suggests a tenant do in its own agent loop to
spend less and answer sooner. Only the points marked **measured** come from a run, and those runs are in-sample
(simulated worlds, the Pi harness, one agent model); everything else is reasoning from vendors' documentation and
D64's timelines, not tested in a tenant's agent. Measure in your own agent before relying on any of it.

## The loop

```ts
import { EdenClient, withContext } from "@eden/client";

// Each sent user message's observe waits up to 3 s for its lookup by default (see "How long to wait" below).
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
  changes no state (`POST /v1/whoami`).
- **Report every event**: user messages, the agent's tool calls and results, arriving messages. Eden stays silent on
  most of them; the ones it reads are how it knows what the agent is about to do.
- **Inject before each model call, not only the first**: work Eden finishes after the first request (the slow path, a
  poll behind the lookup, D65) is delivered at the next one through `collect`/`pending`.
- **The SDK fails open.** A timeout or an error is "no context", never an exception in the agent's loop. Keep it that
  way in your wrapper.

## How long to wait on the user message (`waitMs`; D98, D105)

`observe` takes a `waitMs` option: how long the server may hold the user message's observe for a fresher answer
before it replies. The client sends 3,000 ms on each sent user message by default (`DEFAULT_WAIT_MS`, D112) and none on
other events; `defaultWaitMs` changes it and `defaultWaitMs: 0` opts out. The server treats a missing value as 0 and
caps it at 5,000 ms.
The client's own timeout for that request is 800 ms plus `waitMs`, so a long wait does not make the SDK give up early.
Work still running when the wait ends arrives later through `pending`/`collect`, as above.

- **Pass a wait on the user message: the client sends 3,000 ms by default (`DEFAULT_WAIT_MS`, D112).** With no `waitMs` the observe
  does not wait for its lookup: when the lookup is not already done it replies at once (`pending: true`) and the
  answer lands in `pending`, so it misses the agent's first model call and a one-turn answer never sees it
  (partner.ts `observe`: `waitMs <= 0` queues the slow path and returns). With `waitMs` the reply comes as soon as the
  lookup ends, so a fast lookup costs no extra latency; only a slow one costs up to the wait. **Measured** (simulated
  connectors at their profiles' assumed latency, `bun run funnel --preset none --suite train1,train2 --seeds 41 --
  --time 1`, production defaults): all 11 deliveries arrived 630 to 1,336 ms after the user message (the harness
  waits 3,000 ms). By those timings (inferred, not a run at each wait) no wait or 600 ms would have delivered 0 of
  the 11 before the first model call, 800 ms 5, and 1,500 ms all 11. Warm in-process sources (the README's static
  file) answer in milliseconds, so there the wait is rarely spent. The client's default (3,000 ms on every sent user
  message and nothing else, D105, D112) covers both this and the reader below; `defaultWaitMs: 0` opts out.
- **The reader (`readerPush` with `askReader`, on in the default with a model key, D98, D112) needs about 3,000 ms.**
  The reader reads the request on the critical path, and its call is paid for whatever wait you pass; with too short
  a wait its packet lands after the agent has answered. **Measured** in the lab (Haiku 5.5, simulated worlds), against
  the harnesses' 3,000 ms: a 1 s wait lost 7.6 points (Pi, Eden-only arm) and 18.1 points (Pi, tools-plus-Eden arm)
  of hidden facts raised, with wall time p50 within 0.15 s (D98); no wait lost 18.2 to 32.3 points on train (D99,
  [research/haiku-phase3.md](research/haiku-phase3.md)). The reader took 1,190 ms at p50 and 1,768 ms at p90 there
  (prompt v7), so a wait under about 2 s misses some readings; no wait between 1 s and 3 s was measured.

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

- The server needs `actionCheck` (a trial switch, off, D112's trials table) in its engine config; the grounds it
  reads are in the default.
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

## Connect each user's own sources (D108)

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

## Forward your sources' change notifications (`syncPush`, D125)

Eden keeps a synced copy of each user's listable sources. Without help it guesses when a source has changed (a busy
inbox goes stale in minutes) and polls it at the next lookup: 3.8 to 5.1 listing calls per agent task in the
market-latency runs (docs/research/cost-fixes.md). On a connector platform that bills per call, those polls are most
of Eden's connector bill. If you already receive the provider's change notifications, forward them:

- **The changed items themselves** (a Slack Events API message, a Graph notification with resource data, a connector
  platform's trigger payload): `POST /v1/sources/items {userId, sourceId, items}`, each item
  `{ref, title?, text, url?, updatedAt?, meta?}`, at most 100 per call, or `client.sourceItems(sourceId, items)`.
  They pass the secret gate and are held as synced, with no source call. Use the same `ref` the source's list tool
  returns, so a pushed item and the same item listed later are one item. This is what cuts Eden's polls (to 0.6 to
  0.8 calls per task in the lab: the daily sweep and a 24-hour safety poll).
- **Only that the source changed** (a Gmail `watch` push, a Calendar or Drive channel, a HubSpot webhook):
  `POST /v1/sources/changed {userId, sourceId}`, or `client.sourceChanged(sourceId)`. The source is polled once, at
  its next use, however many notifications came first. For a busy inbox this saves little: it changes about every
  hour, so it is polled about as often as before.

- **Items the source deleted** (a recalled or deleted message, a removed doc or event; Gmail history, Slack's
  `message_deleted`, Graph and HubSpot deletions all report them): `POST /v1/sources/removed {userId, sourceId,
  refs}`, at most 100 refs, or `client.sourceRemoved(sourceId, refs)`. Eden drops them at once (their cards and graph
  entries too); without this a deleted item is only noticed by the daily sweep, two sweeps in a row.

Declare the sources you forward: `"notifies": true` in the user's source spec (`EDEN_USER_SOURCES_FILE` or your
`SourceDirectory`), or `notifies: true` on a `Source` you build. A source that notifies is polled only when told it
changed, by the daily sweep (which also drops what the source deleted), and after `syncPushMaxStaleMs` (24 hours)
with no notification, so a lost notification is bounded. Sources you do not forward are polled as before. The routes
answer 200 with what was done: `synced` is false when the source is not synced for the user or not declared as
notifying (the notification is ignored), and `stored` counts the items held new or changed.

A signal that says only "this source changed" does not say what changed. Eden then treats every item it read from
that source before the signal as unconfirmed, and reads such an item again by its id before delivering it (D126: about
0.5 re-reads per agent turn in the simulation, each one connector call; a source without a fetch tool is delivered as
held). Notifications that carry their items or name their deletions need no re-reads, so prefer them where the
provider offers them.

If you know which items changed, send them: `sourceItems` for the new or changed items and `sourceRemoved` for the
deleted refs, not a bare `sourceChanged`. That path re-reads nothing (0 re-reads in D126's simulation, with no more
stale or deleted items delivered than the signal path), while a bare signal makes Eden doubt every earlier-read item
of the source (D131). For a Gmail push, turn the history id into items and deletions with `history.list` first.

Receiving notifications has its own cost, which Eden does not see: a platform may bill trigger runs, and a Gmail push
carries only a history id that your code turns into items with a `history.list` call.

## Configuration

There is one configuration, the default (D112): the best measured setup, NEWL (D99) with the speed and memory
switches measured to cost nothing (poll behind, small poll pages, no probe grace, the push's reader not waiting for
the poll, the slow-path queue, vocabulary release). Run it as shipped:

- **With `OPENROUTER_API_KEY` set**, the server also runs the default's model roles on `EDEN_MODEL` (default
  `anthropic/claude-haiku-5.5` through OpenRouter, no data collection, ZDR): cards and intent requests in the
  background, and the ask-time reader on an acting request or ask. Each role has its own per-session and per-user-day
  budget, and one cap per tenant per day spans them all (`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25). Cost per task
  and per user is in [COST-MODEL.md](COST-MODEL.md); disclose the model provider to your users
  ([PRIVACY.md](PRIVACY.md)).
- **Without a key**, the same default runs its no-model path: nothing to change.
- Pass the client's default wait (3,000 ms on a sent user message, `DEFAULT_WAIT_MS`); see the waitMs section above.
- `EDEN_ENGINE_CONFIG` takes a JSON file of settings over the default, usually one of `docs/profiles/minus-*.json`
  ("default minus a part") for a comparison. New behaviour arrives as a trial switch with an owner and an end date
  (DECISIONS.md, "Trial switches"); it becomes the default or is deleted.

[DECISIONS.md](DECISIONS.md) holds each part's evidence.
