# Integrating Eden into a tenant's agent

**Status: advice, mostly unmeasured.** This guide collects what the econ research (D65–D71,
[research/econ-research.md](research/econ-research.md) §2 and §8 R10) suggests a tenant do in its own agent loop to
spend less and answer sooner. Only the points marked **measured** come from a run, and those runs are in-sample
(simulated worlds, the Pi harness, one agent model); everything else is reasoning from vendors' documentation and
D64's timelines, not tested in a tenant's agent. Measure in your own agent before relying on any of it.

## The loop

```ts
import { EdenClient, guardTools, withContext } from "@eden/client";

// Each sent user message's observe waits up to 3 s for its lookup by default (see "How long to wait" below).
const eden = new EdenClient({ apiKey, userId, sessionId });
const { injection } = await eden.observe({ kind: "user_message", text }); // report each event
messages = withContext(messages, await eden.collect(injection)); // before each model call
// The agent's acting tools, each checked before it runs (see "Agents that act").
const tools = guardTools(eden, { send_email, book_meeting });
// From your sources' webhooks: forward the refs that changed (see "Forward your sources' change notifications").
await eden.sourceChanged(sourceId, { refs: changedIds, removed: deletedIds });
```

On Hermes Agent the plugin does all of this for you: see "Hermes Agent" below. On the Vercel AI SDK,
`examples/ai-sdk/eden-ai-sdk.ts` does (D854): `edenSession(eden)`, then `session.wrap(model)`, `session.tools` and
`session.guard(actingTools)` in `generateText`/`streamText` ([examples/ai-sdk](../examples/ai-sdk/README.md)).

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
- **Read what `onError` prints, then set your own.** The SDK swallows every error (it fails open). With no `onError`
  it uses `defaultOnError` (D850): in development each distinct problem is printed once with `console.warn` (Python:
  stderr) followed by its fix (`fix: start the server … and check baseUrl`); with `EDEN_ENV=production` (or
  `NODE_ENV=production`) only the first problem of each route and status is printed. Pass your logger to keep them
  all, or `onError: null` (`on_error=None`) to silence it. The error's message carries the
  server's reason (`eden /v1/events: 400 userId must be 1-128 characters of [A-Za-z0-9._:@-]`), capped at 300
  characters; it never includes the request or the key.
- **Check the setup with `health()`** at startup: `await eden.health()` resolves `{ ok: true }` when the server
  answers and accepts the key, the tenant and the ids, and `{ ok: false, error }` otherwise. It never throws and
  changes no state (`POST /v1/whoami`).
- **Report every event**: user messages, the agent's tool calls and results, arriving messages. Eden stays silent on
  most of them; the ones it reads are how it knows what the agent is about to do.
- **`collect` takes what it returns.** `pending` drains the session's queue, and an item is handed out once per
  session: if your model call then fails, retry it with the same messages (with the packet already in them), not
  with a fresh `collect`.
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
- **The push's candidates (D237, the default with a model key) need no reader time.** The push searches, then hands
  the agent the five best candidates, framed to be checked against the request (about 950 bytes a request on the
  lab's worlds), with no model call; on Pi with payload notices Eden's time on the agent's path was about 10 ms a
  request (docs/research/cl-cl6.md). The candidates are not vetted: up to five items that may not bear on the request
  reach your agent's model on nearly every request (in the lab, 98% of nothing-to-add requests got a packet over
  simulated users' days, D710; 87% with `pushOpen: false`), so the
  agent must be able to ignore a look-alike when told to check who, what and when. The default wait still covers the
  search and the on-demand sync poll. The reader below applies with `pushCandidates: 0` (`minus-candidates`).
- **The reader (`readerPush` with `askReader`, with `pushCandidates: 0`, D98, D112) needs about 3,000 ms.**
  The reader reads the request on the critical path, and its call is paid for whatever wait you pass; with too short
  a wait its packet lands after the agent has answered. **Measured** in the lab (Haiku 5.5, simulated worlds), against
  the harnesses' 3,000 ms: a 1 s wait lost 7.6 points (Pi, Eden-only arm) and 18.1 points (Pi, tools-plus-Eden arm)
  of hidden facts raised, with wall time p50 within 0.15 s (D98); no wait lost 18.2 to 32.3 points on train (D99,
  [research/haiku-phase3.md](research/haiku-phase3.md)). The reader took 1,190 ms at p50 and 1,768 ms at p90 there
  (prompt v7), so a wait under about 2 s misses some readings; no wait between 1 s and 3 s was measured.
- **Do not send the agent's first model request before the observe replies** (CL4, D248). Sending it at once and
  re-sending it when a packet lands cut no wall time on Pi (−0.14 s, −0.52..+0.28, assumed traffic mix) and cost
  +$0.058 per 1,000 tasks; re-sending only when the first reply was a final answer made the agent call `ask_context`
  first and cost more. The wait is a cap, not a delay: when no reading is coming the observe replied at p50 3–240 ms.

## Keep `ask_context` (measured, D70)

Give the agent `ask_context` as a tool (the MCP server's, or `eden.ask` behind a tool of your own) with **Eden's own
description**, even though Eden also injects context unasked.

In-sample, removing the tool so the agent answers in one turn cut agent cost 27% and wall time about 3 s, but the agent
raised the decisive fact 0.12 less often (−0.119, −0.196..−0.047), and less often even when the injected packet already
held it (0.837 against 0.913). Rewording the description to discourage asking lowered the ask rate (0.82 → 0.73) and
did not save money. The agent's own rephrased question reaches items the user's words did not; that is worth the round
trip. Eden answers an ask in about 5 ms at p50 (D64), so the cost of asking is the agent's extra model request.

## Keep the provider's prompt cache warm

- **Keep each packet in your transcript, where you inserted it (D336).** `withContext` inserts the packet as a system
  message just before the latest user message and returns a new list; it does not store anything. If you send the
  next turn from your own transcript without that system message, the packet disappears from the middle of the
  history, so the new request no longer starts with the previous one. On a provider whose cache entries end at its
  breakpoints (Anthropic, and Anthropic models through OpenRouter's cache markers) the history after the dropped
  packet is then written to the cache again on every turn: over a user's days on Pi that cost **+$0.057 per 1,000
  tasks** (+0.039..+0.075) against keeping the packets, which put Eden at +$0.095 against the agent alone instead of
  +$0.038 (**measured**, docs/research/a16-loop.md). It also loses facts: Eden does not send an item twice in a session,
  so an item first shown in an earlier turn's packet is only in that packet (5 of 23 hidden facts over a user's days;
  the agent raised 2 of the 5 with the packets kept, 0 without). So append the message `withContext` placed to your
  stored transcript, or keep Eden's packets beside it and place them again before the same user messages.
  `@eden/proxy` does this for you (`keepPackets`, on by default). Check how your framework treats plugin context
  before working around it. **Hermes Agent already keeps it** (read in its source at the lab's pin, 06433066, A27,
  D385): `agent/turn_context.py` appends the `pre_llm_call` context to the turn's user message, stores the exact
  bytes it sent on that message (the `api_content` sidecar) and sends those bytes again on every later call of the
  turn and every later turn (except in its MoA and `codex_app_server` modes, which skip that sidecar and so drop
  earlier turns' context). So a Hermes plugin returns only the new packet; returning earlier packets again would
  repeat them. The same holds for `transform_tool_result`: what it returns becomes the stored tool result. Measured on
  the lab's Hermes requests (`hermes-cache-probe.ts`): the second call of a turn reads the first call's whole prompt,
  packet included, from Anthropic's cache.
- **Within a turn that calls tools**, a packet that arrives between the turn's model calls lands before the user
  message, ahead of the assistant's tool call and the tool result, so the previous request is no longer a prefix and
  the cache misses from that point on. To keep it, append a mid-turn packet at the end of the messages (after the tool
  result) yourself, or accept the miss. Anything you place earlier than the end breaks the cache from that point on.
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

## Agents that act: check each call (D69, D376)

If your agent sends, books, pays, shares or orders through its own tools, wrap them so each call is checked before it
runs (**the recommended setup**, D420):

```ts
import { guardTools } from "@eden/client";

const tools = guardTools(eden, { send_email: sendEmail, book_meeting: bookMeeting });
// tools.send_email(args): check first; on a finding the email is not sent and the agent gets the finding as the
// tool's result (heldResult); calling again with the same arguments sends it (the server proceeds on the repeat).
```

```python
from eden_client import guard_tools

tools = guard_tools(eden, {"send_email": send_email, "book_meeting": book_meeting})  # async tools stay async
```

- `guardTool(eden, name, fn)` wraps one; `held: (tool, finding, input) => …` replaces the held result (ask the user
  instead, say); `timeoutMs` (Python `timeout_s`) bounds the check. **It fails open**: a check that errors, times out
  or throws, or a `held` that throws, runs the tool as if Eden were absent (D14); the tool's own errors are its own.
- Wrap the acting tools, not the read-only ones: a check makes no source or model call (4–5 ms p50), but it adds the
  call's redacted argument words to the session's vocabulary for nothing.
- By hand it is `const check = await eden.check(toolName, args)` and, on `check.verdict === "finding"`,
  `heldResult(toolName, check.finding)` as the tool's result.
- **The proxy cannot do this.** `@eden/proxy` sees a tool call only in the model's answer, which it streams back
  unchanged, and the agent runs the call before the next request reaches the proxy; holding it there would mean
  rewriting the model's answer. Behind the proxy, wrap the acting tools in your agent with the SDK (Python too).
  The Hermes plugin checks every call itself (`pre_tool_call`).

- **On in the default: the party check (`partyCheck`, D375, D376).** A call that adds a recipient, cc, guest,
  share or payee account (an email address, a sort code, an 8-digit account, an IBAN) that Eden's own packets or
  answers showed this session, that your user's request does not name, and that is not among their correspondents
  (on a From/To/Cc/Attendees line of their items, or at an organisation whose domain two of their items' headers
  carry) gets a finding: confirm with the user. Anyone can email your user, and the injections an agent followed in
  A10's suite were exactly this (an extra cc or guest asked for in a stranger's mail). In A25's live run (Pi on
  Haiku 5.5) it cut such attacks followed from 12 in 576 tasks to 0, with no finding on a legitimate call in 576
  control and neutral tasks (docs/research/a25-action-guard.md). It only works if you call `check` (`guardTools` does):
  Eden cannot see a call you do not send it.
- Eden returns context as data and never "do not"; whether to hold the call, ask the user or go ahead is your policy.
  `heldResult` is one choice: hold the call and let the agent call again to go ahead.
- The check makes no model call and no source call. It fails open: an error or a server with the check off returns
  `proceed`.
- Tool arguments are your user's data. The session keeps digests of the identifiers its packets showed, never the
  identifiers, and the call is not added to the session's window; nothing is sent anywhere. See
  [PRIVACY.md](PRIVACY.md) (the party check row). The fuller action firewall (`actionCheck`, D69) was deleted by
  D815: an engine config that still names it stops the server (`unknown key`).

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
  Since the 2026-11-05 audit the server checks this file at start and exits with code 2, naming the entry, where it
  once loaded silently: an entry with no `description`, an id outside `[A-Za-z0-9._:@-]` (such as "My Notes"), a
  duplicate id, a document missing `ref`, `title` or `text`, or a file that is not a list (`{}`). Fix the named entry;
  the HTTP API could not address such a source anyway.

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

**Tell Eden when a user connects (D755).** Eden starts reading a user's sources at their first event, of any kind,
and five sources are read in about ten seconds. Send one as soon as the user has connected their sources, before
their first request: `observe({ kind: "session_start" })` is enough (no text, no request). A user whose first event
is their first request gets that request answered from live searches alone: on the lab's new users Eden surfaced
48% of hidden facts at second 0 and 78% ten seconds later (docs/research/o4-new-user.md).

### Connector presets (D294)

For common servers you can name a preset instead of working out which tools read and how their arguments map:

```json
{ "kind": "mcp", "preset": "gmail", "id": "mail", "url": "https://…/mcp",
  "headers": { "Authorization": { "env": "U1_GOOGLE_TOKEN" } } }
```

| Preset            | Area     | Read tools it names                                                                                                                            | Checked against                                                |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `gmail`           | mail     | `search_threads` (newest message of each thread), and as the sync's listing                                                                    | Google's hosted Gmail MCP server's input schema, 2026-11-07    |
| `google-calendar` | calendar | `search_events` (no listing: `list_events` pages by start time, not by change)                                                                 | Google's hosted Calendar MCP server's input schema, 2026-11-07 |
| `caldav`          | calendar | `caldav_search_events`, and `caldav_get_event_by_uid` when you trust it too (both unannotated: list them in `trustedReadTools` after checking) | madbonez/caldav-mcp at 6db4975 (connector lab)                 |
| `obsidian`        | notes    | `search_notes` (unannotated: list it in `trustedReadTools`; run the server `--read-only`)                                                      | bitbonsai/mcpvault at adda860 (connector lab)                  |

A preset fills in only read tools and their fixed arguments; anything you write in the entry wins. It never adds
`trustedReadTools`, so the read-only check (D7) runs as for a hand-written entry: a server that does not annotate a
tool `readOnlyHint: true` is refused until you have checked the tool and listed it. Ask for read-only OAuth scopes
(`gmail.readonly`, `calendar.readonly`) as well, so the provider refuses a write beneath Eden's check. Only `caldav`
names a fetch tool, `caldav_get_event_by_uid` (D842: the connector lab ran the server over Radicale and the fetched
copy equals the searched one). The server annotates neither tool, so the fetch tool joins the entry only when its
`trustedReadTools` lists it beside the search tool; an entry that trusts only the search tool connects as before,
with no fetch. The others say why not in `PRESETS[name].noFetch` (D415, [c1-preset-fetch](research/c1-preset-fetch.md)).
A fetched Gmail thread holds every message, while the summary search holds only the newest, so an unchanged thread
would look changed. No reply of Google Calendar's `get_event` was captured to show that it matches `search_events'`
copy. mcpvault's search row is an excerpt keyed by a uri its `read_note` does not take. So those preset sources
cannot find an item by id (`fetchesById` false): a listing keeps the daily sweep (D356) and doubted copies are
delivered as held (D126). If you have checked that your server's fetch returns the same copy as its
search, add the tool by hand (for example `"fetchTool": {"name": "get_thread"}`; the id argument is mapped from the
schema, here `threadId`). An unused source with a listing then moves to the weekly sweep. On `google-calendar`
(`get_event`, mapped to `eventId`) a fetch tool only adds re-reads, since that preset has no listing to sweep.
Google's read-only annotations were not captured: if the server does not set them, the connect is refused until you
list the tool. There is no CRM preset yet: no CRM server's tools could be verified, so write a CRM entry by hand
(`searchTool` with its name, Eden maps the query from its schema). A worked per-user OAuth directory, which keeps
refresh tokens in your app and hands Eden short-lived access tokens on preset entries, is
[examples/oauth-directory](../examples/oauth-directory/directory.ts).

## Forward your sources' change notifications, with the refs or items they name (`syncPush`, D125, D210, D347, D421)

Eden keeps a synced copy of each user's listable sources. Without help it guesses when a source has changed (a busy
inbox goes stale in minutes) and polls it at the next lookup: 3.8 to 5.1 listing calls per agent task in the
market-latency runs (docs/research/cost-fixes.md). On a connector platform that bills per call, those polls are most
of Eden's connector bill (RealUse-1: agent + Eden $113–133 per 1,000 tasks on a $12/1k-calls plan, against $39–41 for
the agent alone). If you receive the provider's change notifications, forward them, **with what they name**: the refs
that changed (the default wherever the connector reports changed ids: a Gmail `history.list`, a Graph or HubSpot
webhook, a Drive changes list, a connector platform's trigger), or the items themselves when the notice already
carries them. **Never send a bare "changed" signal where you have ids**: it is the slow fallback below.

```ts
// The default: the ids the notice names. Eden reads them itself and doubts nothing else of the source.
await eden.sourceChanged("gmail", { refs: changedIds, removed: deletedIds });
// When the notice already carries the content (a Slack event, a Graph notification with resource data): the items.
await eden.sourceChanged("slack", { items: [{ ref: msg.ts, title: msg.channel, text: msg.text }] });
```

```python
eden.source_changed("gmail", refs=changed_ids, removed=deleted_ids)
```

Decision rule: items if the notice has them (no fetch at all), else refs (one fetch per ref, in the background),
else the bare signal. Refs and items mix in one call.

- **The changed items themselves (D210).** A Slack Events API message, a Graph notification with
  resource data, a connector platform's trigger payload, a Gmail push turned into messages with `history.list`:
  `client.sourceChanged(sourceId, { items, removed })`. Each item is `{ref, title?, text, url?, updatedAt?, meta?}`
  with the same `ref` the source's list tool returns, so a pushed item and the same item listed later are one item.
  They pass the secret gate and are held as synced, deletions are dropped at once (their cards
  too), and **nothing is polled or re-read**: RealUse-1 part D measured 0.22 connector calls a lookup with payloads
  against 0.91 with bare signals, with no more stale or deleted items delivered (1 of 38 updated items stale, 0
  deleted). The client splits batches past 100 and never throws; if Eden does not take a part (unreachable, a refused
  item), it also sends the bare signal, so the source is polled rather than the change missed, and resolves false.
  The routes underneath are `POST /v1/sources/items {userId, sourceId, items}` and `POST /v1/sources/removed {userId,
sourceId, refs}` (at most 100 each), also exposed as `client.sourceItems` and `client.sourceRemoved`.
- **The refs that changed, without their content (D347; the default for a notice that names ids, D421).** A Gmail `history.list` gives message ids, a Graph or
  HubSpot webhook a resource id, a Drive changes list file ids: `client.sourceChanged(sourceId, { refs, removed })`
  (Python `source_changed(source_id, refs=…, removed=…)`, route `POST /v1/sources/refs {userId, sourceId, refs}`, at
  most 100). Eden reads those refs itself in the background through the source's fetch tool and holds them as synced;
  **nothing else of the source is put in doubt**, so the agent's next request waits on no re-read and no poll. A named
  item is held as unconfirmed only until its read lands (a delivery that needs it waits on that read, at most
  `verifyTimeoutMs`); a ref Eden cannot read (no fetch tool, an error after retries, a timeout) turns the notice into
  the bare signal below. The route answers 200 at once with `{synced, reason?}` as `/v1/sources/changed` does. In the
  lab (A18, train1–6 seed 41, direct market profile, time scale 1, the same notices as signals): the agent's wait on a
  request p50 1,013 → 6 ms and p90 1,507 → 17 ms, an `ask_context` p50 588 → 2.3 ms and p99 2,782 → 1,050 ms, connector
  calls 7.4 → 2.0 a task; the freshness simulation delivered no more stale or deleted items than payload notices
  (docs/research/a18-latency.md). Each ref is one fetch: prefer the items when you already have them.
- **Only that the source changed: the slow fallback** (a provider that gives no ids at all, such as a Calendar
  channel's bare ping): `client.sourceChanged(sourceId)`, or `POST /v1/sources/changed {userId, sourceId}`. The source is polled
  once, at its next use, however many notifications came first, and every item Eden read from it before the signal is
  re-read by its id before it is delivered or cited (D126, D131, D211). For a busy inbox this saves little: it changes
  about every hour, so it is polled about as often as before. Use it only where the provider gives no items.
  **It is the slow path** (measured, lab): against the same notices sent as refs, the agent's wait on a request
  p50 1,013 ms against 6 ms, an `ask_context` p50 588 ms against 2.3 ms and 7.4 connector calls a task against 2.0
  (A18, above). **It also makes `ask_context` slow** (CL4, D249): on Pi with signals, an ask took 1.35–1.59 s, almost all of it
  re-reading 4–5 doubted copies it cites; with the items pushed it took 0.19 s (heldout14 neutral tasks, one seed,
  Anthropic-direct lab figures, docs/research/cl-cl4.md). When the source can re-read items by ref, the answer adds
  `advice: "refs"` and the clients report it once per source through `onError`/`n` (D2008): send the changed refs or
  items instead.

Declare the sources you forward: `"notifies": true` in the user's source spec (`EDEN_USER_SOURCES_FILE` or your
`SourceDirectory`), or `notifies: true` on a `Source` you build. A source that notifies is polled only when told it
changed, by the daily sweep (which also drops what the source deleted), and after `syncPushMaxStaleMs` (24 hours)
with no notification, so a lost notification is bounded. Sources you do not forward are polled as before. The routes
answer 200 with what was done: `synced` is false when the source is not synced for the user or not declared as
notifying (no poll follows), and `reason` then says which: `"push-off"` (the server runs without `syncPush`),
`"not-synced"` (no lookup has synced that source for that user: a typo'd `sourceId` or `userId`, a source with no list
tool, or one not read yet; Eden tells these apart only by reading your source config, which this route does not do) or
`"not-notifying"` (synced, but not declared `"notifies": true`). The client's `sourceNotice(sourceId)` returns
`{synced, reason?}` (null when unreachable). Either way, any search result Eden holds for that source is dropped, so
the next lookup asks the source again. `stored` counts the items held new or changed, and `removed` (from
`/v1/sources/removed`) the cached items dropped: 0 is still a success, since the refs are held as gone whether or not
they were cached.

A signal that says only "this source changed" does not say what changed. Eden then treats every item it read from
that source before the signal as unconfirmed, and reads such an item again by its id before delivering it (D126: about
0.5 re-reads per agent turn in the simulation, each one connector call; a source without a fetch tool is delivered as
held). Notifications that carry their items, name the refs that changed, or name their deletions need no re-reads, so prefer
them where the provider offers them; for a Gmail push, turn the history id into message ids (and deletions) with
`history.list` first.

Receiving notifications has its own cost, which Eden does not see: a platform may bill trigger runs, and a Gmail push
carries only a history id that your code turns into items with a `history.list` call.

**A source you cannot forward notices for** is polled on Eden's own schedule: before a lookup when its learned rate
of new items says it has probably gained one, at most `syncMaxStaleMs` (6 hours) apart, and, while its user is active,
in the background at least every 2 hours (the freshness floor, `syncActivePollMs`, D1131, D1132; a source whose polls
find nothing waits up to 8 hours). Past 40 sources the user has not used, those share 40 floor polls every 2 hours
(`syncActivePollCap`, D1747): one with no complete poll for 24 hours first, then the likeliest to have changed. So
such a source is polled about a day after its last poll while that fits the allowance, and at worst by its weekly
sweep (D356). The floor stores a silent edit before the request that needs it, and no request waits for it. Its price is connector calls: about 800 a heavy user-month **[EST]** (docs/COST-MODEL.md §Hosting). The floor
polls only a source marked first-party (quota only) or flat-rate: `"callPriced": false` in its spec (or `callPriced:
false` on a `Source` you build); the connector presets (`gmail`, `google-calendar`, `caldav`, `obsidian`) are marked so.
A source billed per call (Composio, Unified.to, Arcade.dev, Pipedream Connect, Zapier MCP, any per-call transport,
`"callPriced": true`) and a source with no mark are left to their learned rate (D1133: unknown counts as priced),
unless your engine config turns `syncActivePollPriced` on. An edit to an item the
agent was already handed (a moved meeting, a changed document) reaches the agent at the next poll that lists it. In
the simulation, with no notices, about 93% of such updates arrive before the session ends when the change lands
mid-session, but a quiet calendar is seldom polled within a session (6–7 of 15 calendar updates arrived; with notices
every update did, D841, D842). Re-reading each held item by its id at every request was measured and rejected: it
costs more connector calls per update found than the poll (D840). So, by source:

| Your connector                                                                                         | What the agent gets after an edit                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notifies (items, refs or a signal), declared `"notifies": true`                                        | The update before the next request (D205)                                                                                                                                                                                                      |
| No notices, a listing that shows the most recently changed first (mail, most chat)                     | The update at the next poll; a busy source is polled at nearly every request                                                                                                                                                                   |
| No notices, a listing by start time or no listing (a calendar, `google-calendar` and `caldav` presets) | A synced calendar: at its next poll, often not within the session. A preset with no listing is never synced: the new copy reaches the agent only if a later lookup's search finds it and delivers it. Forward notices for calendars if you can |
| No get-by-id tool (`fetchesById` false)                                                                | Copies a signal put in doubt are delivered as held (D126)                                                                                                                                                                                      |

## The one-line integration: Eden in front of your model (`bun run proxy`, D280)

If your agent calls an OpenAI-compatible chat API or Anthropic's Messages API, you can add Eden without touching its
loop:

```bash
EDEN_PROXY_UPSTREAM=https://api.openai.com/v1 EDEN_URL=http://127.0.0.1:8790 EDEN_API_KEY=… bun run proxy
# the agent: base_url="http://127.0.0.1:8791/v1", plus a header x-eden-user-id: <your user's id>

# Anthropic's Messages API (D653): the same proxy, the SDK's base URL without /v1
EDEN_PROXY_UPSTREAM=https://api.anthropic.com/v1 bun run proxy
# the agent: Anthropic(base_url="http://127.0.0.1:8791", default_headers={"x-eden-user-id": user_id})

# The same request by hand (proxy on PROXY_PORT=8791, Eden on EDEN_URL; keep max_tokens above the model's thinking)
curl -s http://127.0.0.1:8791/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" -H "x-eden-user-id: u1" -H "x-eden-session-id: chat-1" \
  -d '{"model":"claude-haiku-5-5","max_tokens":1024,"messages":[{"role":"user","content":"Can you move my lunch with Priya Raman to 11:30 on Thursday?"}]}'
```

The packet is not in the answer: it went to the model. To see what Eden added, ask the server
(`POST $EDEN_URL/v1/explain {"userId":"u1","sessionId":"chat-1"}` lists the item ids it handed out and why).

`EDEN_PROXY_UPSTREAM` keeps the provider's version path (`/v1`, `/api/v1`; the proxy warns at startup when it has no
path). `EDEN_URL` defaults to `http://127.0.0.1:8790`; `EDEN_API_KEY` is one of the server's `EDEN_API_KEYS` keys
(omit it against `EDEN_DEV=1`). `PROXY_PORT` and `PROXY_HOST` move the proxy (default `127.0.0.1:8791`), and
`GET /healthz` answers `{"ok":true}` from the proxy itself, for a container check. At startup the proxy asks Eden once
and prints whether it is reachable and accepts the key (D365), so a server that is down or a refused key shows there,
not as a line per request.

- On each `POST /v1/chat/completions` the proxy reports the conversation's new messages (user text, the assistant's
  text and tool calls, tool results) to Eden once each, waits for the user message's lookup as the SDK does (up to
  3 s), inserts Eden's packets as a system message just before the latest user message, keeps the turn's packets on
  the turn's later model calls (tool loops), and streams the upstream's answer back unchanged. Other routes
  (`/v1/models`, embeddings) pass through.
- On each `POST /v1/messages` (Anthropic, D653) it does the same work on the same conversation state: `tool_use`
  and `tool_result` blocks are reported as tool calls and results, and Eden's packet is inserted as a text block of
  the latest user turn's message, ahead of its other blocks (the API has no system role inside `messages`). Text
  beside tool results in one message (a harness's reminder) is not a user turn and is not reported. The top-level `system`, `cache_control` marks and every other field go upstream as they
  came; `x-api-key` and `anthropic-version` are forwarded; the proxy's own errors on this route have Anthropic's
  shape. `/v1/messages/count_tokens` and batches pass through untouched. Checked live (2026-11-10, one run each,
  `claude-haiku-5-5`): asked where and when lunch is, the model answered that it has no calendar access directly
  and "at Dishoom on Thursday at 12:30" through the proxy; a body with
  `system`, `metadata.user_id` and `cache_control` was accepted (a scratch script, not in the repo).
- On each `POST /v1/responses` (OpenAI's Responses API, D656) likewise: `input`'s items are read as the
  conversation, and the packet goes back as a system item before the latest user message. With the history held
  by the provider, `conversation` names the session; with `previous_response_id` alone send `x-eden-session-id`,
  or each request is its own session. With the history held by the provider the model's `function_call` items
  stay with the provider: Eden is told of no tool call, and each `function_call_output` reaches it as the result of
  a tool named "tool" (the proxy does not read the replies for calls). Send the whole input instead of
  `previous_response_id` if Eden should see tool calls. Not yet checked against the real API.
- **Identity.** `x-eden-user-id` (else the body's `user`; on Anthropic's route `metadata.user_id` instead) names the end
  user; without either, Eden is skipped (the
  proxy says so once on stderr, D365).
  `x-eden-session-id` names the conversation; without it the proxy keys it by a hash of its first non-system
  message (system prompts may change per request), so send it if many conversations open identically. Ids pass
  through `edenId`. New messages are found by content, so compacted or sliding histories work; on first sight of a
  conversation (or after a restart) only its latest user message on is reported.
- **Fails open.** Eden down, slow or refusing: the request goes upstream unchanged, after at most the wait plus
  800 ms of Eden's work. Only an unreachable upstream is an
  error (502). The upstream key is forwarded and never logged; only message text goes to Eden, as with the SDK.
- **Speculate (on by default, D1273; `EDEN_PROXY_SPECULATE=0` turns it off).** At a new turn the proxy sends the
  request upstream at once, as it would go with no packet, while Eden decides; when Eden adds nothing, that answer goes
  to the agent and Eden's wait is saved. When Eden adds a packet, the early call is aborted and the packet's request
  goes as usual, so the agent sees exactly what it would without the option. The price is on your upstream key: a
  packet turn sends two requests, both billed their input, and the aborted one may be billed output too (always for a
  non-streamed request); both count against your rate limit, and a 429 on the packet's request reaches the agent.
  Never early with `store: true`, on the Responses route, with `EDEN_PROXY_ASK=1`, in shadow mode, or when the request
  asks the provider to run tools itself (`mcp_servers`, `web_search_options`, a code-execution `container`, or any
  non-client tool type), since those tools would run twice.
- **Off this machine, set `EDEN_PROXY_KEY`.** The proxy holds your tenant's Eden key and serves whichever user a
  caller names, so with `PROXY_HOST` beyond loopback it refuses to start without its own key, which callers send as
  `x-eden-proxy-key`.
- **Shadow mode, a trial with no risk** (`EDEN_PROXY_SHADOW=1`): the proxy reports every conversation to Eden and
  lets it decide, but forwards each request unchanged and prints one JSON line (user, session, packet count, item ids;
  no text) per request Eden would have changed. Run it on real traffic for a week, then read `bun run trace-report`
  on the Eden server's `EDEN_TRACE=1` log and `/v1/explain` on the sessions that matter, before letting it inject.
- **`ask_context` in the proxy (opt-in, `EDEN_PROXY_ASK=1`, D851, D857).** The proxy adds Eden's `ask_context` to the
  request's tools, with Eden's own description, on all three routes, and answers the model's calls to it itself: it
  asks Eden, appends the call and the answer to a copy of the conversation and calls the model again, at most three
  rounds a request (the request after the third forbids tool calls). The agent sees one model answer, never the tool.
  Costs: each ask is one more model call on your bill, and a streamed answer that asks is buffered, so the agent's
  first token waits for the asking rounds to finish. A request that already has a tool called `ask_context` (Eden's
  MCP server) is left alone. Off unless you set it: D70's −11.9 points without the tool were measured on the SDK, and
  nothing has measured it through the proxy.
- **What it does not do.** Without `EDEN_PROXY_ASK=1` it adds no `ask_context` tool (give the agent the MCP server
  for that, D70 says keep it), it cannot report events that never reach the model (a webhook's new mail: forward those with `sourceChanged`, with
  their refs), and it cannot check a tool call before it runs (the agent runs it between two requests): wrap the
  acting tools with `guardTools`/`guard_tools` in the agent ("Agents that act").
- **Checked live** (2026-11-07): a plain Python `urllib` call to Anthropic's OpenAI-compatible endpoint
  (`claude-haiku-5-5`) through the proxy and a no-key Eden on the example sources, asking "Can you move my lunch with
  Priya Raman to 11:30 on Thursday?", got back "Priya emailed that she can't do anything before 12:15, so 11:30 may
  not work for her": the candidate packet carried the mail the agent had no tool to read. One run, not a measurement.

## Check your integration (`eden doctor`, D852)

Each step of the loop above has a measured cost when it is skipped, and Eden's answer to a skipped step is silence,
which is also its normal answer. `eden doctor` names the ones your integration skips:

```bash
EDEN_API_KEY=… bun run doctor --url http://127.0.0.1:8790    # no key against a dev server; or: bun run eden doctor
docker exec <container> bun packages/server/src/cli.ts doctor --env   # in the image, with the server's own config
```

It reads the server's content-free counters for the key's tenant (`/v1/usage`'s `integration`: event kinds, the wait
sent on each user message, `pending` replies and takes, asks, checks of acting tools, change notices by form, refused
requests; since the server started), an `EDEN_TRACE=1` log when given, and with `--env` the environment it runs in
(variable names and the user-sources file's flags, never a value; so run that where the server runs). For each
obligation it prints `ok`, `FIX` or `?` (no evidence either way yet, normal on a first run with a few requests) and
what it saw in counts; for each `FIX` the measured cost of missing it, with its source, and the fix (`--verbose` adds
them for `?`). It exits 1 when something needs fixing, so it can run in your CI against a staging server. It cannot
see whether you keep packets in your transcript (D336): that one is always `?`.

## Why did Eden say this, or stay silent? (`explain`, D277)

Every decision Eden makes is traced with no content (D56): its kind, fixed reason words or a cue id (a hash), its
time, its source and model calls, its cost, and the ids of the items it delivered or cited. The server keeps a
session's last 32 in memory, and `POST /v1/explain {userId, sessionId}` (the clients' `explain()`) returns them, oldest
first, each with a plain sentence:

```json
{ "decisions": [
  { "turn": 1, "event": "user_message", "decision": "sources", "reason": "cue:5f1bf447b6",
    "why": "Spoke after a source search: 2 items passed the no-model confidence bar.", "latencyMs": 41,
    "sourceCalls": 4, "modelCalls": 0, "costUsd": 0, "itemIds": ["calendar:evt-priya", "gmail:m-priya"] },
  { "turn": 3, "event": "user_message", "decision": "silent", "reason": "no candidates",
    "why": "Silent: looked in the sources and found nothing that matched.", "...": "..." } ] }
```

- It reads only, changes nothing and is scoped like every route (the key's tenant, the body's user and session). A
  session that ended (`session_end`, idle) or a user forgotten (`/v1/forget`) has none.
- The common silent reasons: `no candidates` (nothing matched: check the user's sources with `/v1/sources` and that
  the item is there), `no model` (candidates matched but none passed the no-model bar; Eden stays quiet rather than
  guess, D3), `slow path busy` (an earlier lookup was still running), a `skipped` event (chatter, an agent message).
  A request that acts shows a `reader-push` decision: the candidates it handed out, or why there were none.
- Item ids are the source's own refs (`gmail:<message id>`); they are ids, not text, but they name the user's items:
  treat the output as you treat your agent's logs.
- On the server, `EDEN_TRACE=1` logs the same records for every session as JSON lines.

## Measure Eden on your own traffic (`bun run trace-report`, D279)

The lab's numbers are simulated; yours are not. Run the server with `EDEN_TRACE=1`, keep its output, and run
`bun run trace-report server.log` (or pipe the log in; `--json` for a machine-readable summary). It prints how often
Eden spoke or stayed silent and why, its time to a decision per kind (p50, p95, p99), source and model calls per
event, and the request-time model spend per 1,000 events. Not in it: the background card and intent calls (no trace;
their spend is under `EDEN_MODEL_USD_PER_TENANT_DAY` and on the provider's bill), and the network and client wait
(time `observe` in your own loop for that). To compare with the lab, the same report on `bun run eval`'s traffic is
in the eval's `latencyP50Ms`/`decisions`.

## Show what Eden caught (`bun run digest`, D293)

`bun run digest server.log` turns the same `EDEN_TRACE=1` log into a Markdown page for stakeholders: how often Eden
added context and of what kind (a clash with the request, items to check before an action, answers to the agent's
questions), from which connectors, how often the agent then used it, why it stayed silent, and its time and
request-time spend. With `EDEN_TRACE=1` the server also logs one `{"usage": …}` line per injection once its outcome
is known (inferred from the agent's next messages and tool calls, D18, or your `feedback`, D13). So report the agent's
own `agent_message` and `tool_call` events, or send feedback: without either the digest says "not measured" rather
than 0%. "Used" is coarse: it is per injection, and a packet of candidates counts as used when any one of them is.
The log and the digest hold counts, ids and connector names only, never request or item text (D56). Traces carry no
user and no clock: pass one deployment's log for the period you want.

Its last section prices connector calls per 1,000 user requests on six market plans (first-party APIs, Composio,
Unified.to, Arcade.dev, Pipedream Connect, Zapier MCP): the agent's reported tool calls, Eden's calls inside lookups,
and the background sync's listings (the server logs the sync's counters once a minute with `EDEN_TRACE=1`). For the
without-Eden column, pass a log of the agent without Eden's context: `--baseline shadow.log`, from the proxy in shadow
mode (it reports events but injects nothing) or from before Eden. On the lab's train worlds (D291) the agent alone
made 3.38 connector calls a request; with Eden 0 at request time, plus a one-time backfill of 18 listings a user.

## Hermes Agent: install Eden locally (D1966)

[Hermes Agent](https://github.com/NousResearch/hermes-agent) starts Eden automatically when the plugin first needs it.
You do not need an Eden account, API key, Bun install, or a separate terminal running an Eden server.
Every release archive also ships a short `GETTING-STARTED.md` covering the same steps.

Hermes itself installs from its release tag, not pip (PyPI tops out at 0.19.x), into a Python 3.12 or
3.13 environment (it rejects 3.14):
`git clone --branch v2026.9.24 https://github.com/NousResearch/hermes-agent`, then `UV_PYTHON=3.12 uv sync`.

1. Download the archive for your OS and CPU from [Eden Releases](https://github.com/Knihalani/Eden/releases). Compare
   its SHA-256 with `SHA256SUMS` (`sha256sum FILE` on Linux, `shasum -a 256 FILE` on macOS, or
   `Get-FileHash FILE -Algorithm SHA256` in PowerShell). Extract the verified archive.
2. Inside the extracted directory, run `python3 install.py` on Linux/macOS or `py -3 install.py` on Windows
   (Python 3.10+). The installer uses your active profile; use `--profile NAME` to select another.
   Use `--hermes-home PATH` to select an exact home for a custom Hermes build.
   After copying files it starts the installed sidecar once to prove it runs on this machine and to
   surface a malformed `sources.json` at install time (`--no-check` skips that).
   Run the enable command it prints. For an upgrade, stop Hermes first and rerun the installer.
3. Open a new Hermes session (or restart your Hermes gateway). If you restrict toolsets, include `eden` in
   `hermes tools` or in your existing list passed via `--toolsets`. On Hermes with Tool Search, `ask_context`
   is discoverable through the tool catalog instead of always showing as an eager tool.

If you previously used a hosted deployment, remove `EDEN_URL` from Hermes' environment to switch to local mode.
An explicit `EDEN_URL` still selects the hosted setup, where `EDEN_USER_ID` is required and
`EDEN_API_KEY`/`EDEN_TENANT_ID` are set as before.

### Connect sources explicitly

With no sources configured, Eden stays quiet. For a first answer in one step, run `install.py --example`: it writes
a small demo static source to `eden/sources.json` under your Hermes profile (never overwriting an existing file);
ask Hermes "when does my gym membership renew?" and replace the file with your own.
To try it with local documents, give the Hermes process an absolute
`EDEN_SOURCES_FILE` path to a static JSON file like [the synthetic example](../examples/personal-agent/sources.json).
For live connectors, set `EDEN_USER_SOURCES_FILE` or put the file at `eden/sources.json` under your Hermes profile.
Use the [per-user source format](#connect-each-users-own-sources-d108), with the entry `local/local` by default.
`EDEN_USER_ID` changes the user portion (mapped through `eden_id`); local mode always uses tenant `local`.
Keep connector tokens out of the JSON: use `{"env": "YOUR_CONNECTOR_TOKEN"}` in header values and make that token
available only to the Hermes profile process that needs it.
Eden uses read-only tools from explicitly configured HTTP MCP connectors and does not import Hermes'
`mcp_servers` or their credentials. Use `ask_context` instead of duplicate source search tools unless Hermes needs
them for browsing or for acting (sending, booking, writing). Restart Hermes after changing environment variables.
Use a dedicated Hermes process for a non-default profile. Eden skips routed profiles in a shared Hermes process
rather than reading another profile's process-wide source settings.

### What stays local

The plugin owns a private sidecar for its lifetime. The sidecar listens only on IPv4 loopback on an OS-assigned
port and uses a fresh bearer token never entered into Hermes' config. Eden does not use remote model roles or
persist its cache or source map in this mode; a restart reads sources again. Eden contacts only the connectors
you configure. Hermes still sends its prompt, including any injected context, to the model provider **you**
configured; use a local Hermes model and local sources if that data must not leave the machine.

If the binary is missing, cannot start, or stops responding, Hermes continues without Eden context or checks.
Startup is lazy; local HTTP calls bypass proxies. The sidecar closes on plugin unload or Hermes exit.
Startup diagnostics go to `eden/logs/eden-local.log` under your Hermes profile.
The check is advisory, not an authorization layer. To stop using Eden, run
`hermes plugins disable eden` for the installed profile and restart Hermes.

### Hooks (D422)

The plugin (`eden_client.hermes`) registers, through Hermes' own plugin surfaces:

- **`ask_context`** in the `eden` toolset, with Eden's own description (D70), answered by the same server and session
  as the hooks.
- **`pre_llm_call`**: the user's message goes to Eden (waiting up to 3 s, as the SDK does) and the turn's packet is
  returned as context. Only the new packet: Hermes keeps each turn's context and sends it again on later calls (A27,
  D385), so the plugin never re-sends earlier packets. A question-shaped message that got no packet gets a one-line
  nudge naming `ask_context` instead (D1985): under deferred tools the agent rarely discovers it on its own.
  `EDEN_ASK_HINT=0` turns the nudge off.
- **`pre_tool_call`**: an acting tool's call goes to `check` first; a finding blocks the call and becomes its result
  (calling again proceeds). By default the acting tools are those whose name carries an acting verb as a word,
  camelCase split (send, reply, forward, share, invite, book, schedule, pay, transfer, grant, post, purchase, order,
  create, update, add, respond, deploy: `send_email`, `sendEmail`, `create_event`, `mcp_gmail_send_message`, not
  `list_messages` or `read_file`). A tool that acts under another name is not checked: name your acting tools with
  `EDEN_CHECK_TOOLS=send_email,book_room` (exactly those), or `*` (every tool but Eden's own); empty checks none.
- **`post_tool_call`, `transform_tool_result`**: tool results are reported, and packets Eden queued since are appended
  to the result, so context found mid-turn reaches the next model call.
- **`on_session_finalize`, `on_session_reset`**: each Hermes session is its own Eden session (its id through
  `eden_id`; a hook with no session id uses its task id, and with neither Eden is skipped), ended when Hermes tears
  the identity down. Not `on_session_end`, which Hermes fires after every turn: ending Eden's session there would
  drop its queued packets, what it knows the agent read and its per-session budget each turn.

Every Eden hook fails open. The lab's `hermes-eden` arm compared replacing duplicate source tools with keeping them
alongside Eden; see [the lab write-up](research/a16-loop.md) for that retrieval study, not a local-runtime benchmark.
See the [Python client README](../packages/client-python/README.md#hermes-plugin) for custom binaries and
advanced runtime configuration.

To build the release ZIPs and `SHA256SUMS` from a checkout, use the repo's pinned Bun and run
`python3 scripts/hermes-local/build.py --version vX.Y.Z --out-dir dist/hermes-local`.
Repeat `--target` to build a subset; omit it for Linux, macOS and Windows, each on x64 and arm64.
Before publishing, run `HERMES_RELEASE_SMOKE=1 bun test scripts/hermes-local.test.ts` on Linux and record which
platforms were run natively.

## Other local agents

Each personal-agent product gets the same contract through its own extension surface — reporting,
packet injection, `ask_context`, the party check, an installer that drops the plugin and `eden-local`
beside the agent's home:

| Agent                                                         | Package                       | Surface                                                                                   | Deny seam                        | Install                                                                    |
| ------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent)  | `eden_client.hermes` (Python) | plugin hooks                                                                              | held result as the tool's output | `hermes-local` release (`install.py`)                                      |
| Pi                                                            | `examples/pi`                 | `eden.ts` extension (`context`, `tool_call`/`tool_result`, `turn_end`)                    | `block` with the held result     | `install.py`                                                               |
| OpenClaw                                                      | `examples/openclaw`           | `eden.ts` plugin (`before_prompt_build`, `before/after_tool_call`, `agent_end`)           | `block`/`blockReason`            | `install.py` → `<openclaw-home>/extensions/eden`                           |
| [gptme](https://gptme.org)                                    | `examples/gptme`              | Python plugin (`GENERATION_PRE`, `TOOL_EXECUTE_PRE`/`POST`, `TOOL_CONFIRM`, `TURN_POST`)  | `ConfirmationResult.skip`        | `install.py` → `~/.config/gptme/plugins/eden`                              |
| [opencode](https://opencode.ai)                               | `examples/opencode`           | bundled `index.js` (`messages.transform`, `tool.execute.before/after`, `session.idle`)    | thrown `Error`                   | `install.py` → `~/.config/opencode/plugins/eden.js`                        |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `examples/claude-code`        | hook commands + `eden-mcp.py` (`UserPromptSubmit`, `Pre/PostToolUse`, `Stop`, `Session*`) | `permissionDecision: "deny"`     | `install.py` → `~/.claude/eden/` + `settings.json`/`~/.claude.json` merges |
| [Qwen Code](https://github.com/QwenLM/qwen-code)              | `examples/qwen-code`          | hook commands + `eden-mcp.py` (`UserPromptSubmit`, `Pre/PostToolUse(⁺Failure)`, `Stop`, `PreCompact`, `Session*`) | `permissionDecision: "deny"`     | `install.py` → `~/.qwen/eden/` + `settings.json` merges                    |
| [Devin CLI / Desktop](https://docs.devin.ai/cli)              | `examples/devin-cli`          | hook commands + `eden-mcp.py` (`UserPromptSubmit`, `Pre/PostToolUse`, `PostCompaction`, `Session*`) | `decision: "block"`              | `install.py` → `~/.config/devin/eden/` + `config.json`/`mcp_config.json` merges |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli)     | `examples/gemini-cli`         | hook commands + `eden-mcp.py` (`BeforeAgent`, `Before/AfterTool`, `AfterAgent`, `PreCompress`, `Session*`) | `decision: "deny"`  | `install.py` → `~/.gemini/eden/` + `settings.json` merge |
| [Cursor](https://cursor.com)                                  | `examples/cursor`             | hook commands + `eden-mcp.py` (`beforeSubmitPrompt`, `pre/postToolUse`, `afterAgentResponse`, `preCompact`, `session*`) | `permission: "deny"` | `install.py` → `~/.cursor/eden/` + `hooks.json`/`mcp.json` merges |
| [LangChain](https://docs.langchain.com)                       | `examples/langchain`          | `createAgent` middleware                                                                  | guarded tool wrapper             | copy `eden-langchain.ts`                                                   |
| [Windsurf Cascade](https://docs.windsurf.com/windsurf/cascade/hooks) (legacy in Devin Desktop) | `examples/windsurf` | hook commands + `eden-mcp.py` (`pre/post_user_prompt`, `pre/post_run_command`/`write_code`/`read_code`/`mcp_tool_use`, `post_cascade_response`) | exit 2 + stderr | `install.py` -> `~/.codeium/windsurf/eden/` + `hooks.json`/`mcp_config.json` merges |

Local mode is shared: `EDEN_LOCAL_BINARY`, then the install's own `bin/eden-local`, with
`<agent-home>/eden/sources.json` read automatically (the same file every agent reads). `EDEN_URL`
selects a hosted Eden instead, and every integration fails open (D14). Each example's README covers
its hooks and flags.

One installer covers every agent whose home exists on the machine: `python3 examples/install.py`
detects the homes, runs each agent's own `install.py`, and reports per agent (`--list` shows what
was detected, `--agents a,b` and `--<agent>-home PATH` override, `--dry-run` prints without
running — D2000).

## Other languages

- **TypeScript or JavaScript outside this repository:** the workspace package exports TypeScript and depends on
  `@eden/protocol` through `workspace:*`, which `npm install` cannot resolve. `bun run pack:client` writes a
  standalone package to `dist/eden-client` (one ESM file, the protocol inlined, with declarations); install it with
  `npm install /path/to/Eden/dist/eden-client` (or `bun add`). Node 18+, Bun and Deno load it (D365).
- **Python:** `packages/client-python` (`pip install /path/to/Eden/packages/client-python`, import `eden_client`), the same calls
  as `@eden/client` (`observe`, `pending`, `collect`, `ask`, `check`, `feedback`, `health`, `explain`,
  `source_changed` with `refs=`) with `with_context` and `guard_tools`/`guard_tool`, and the Hermes plugin
  (`eden_client.hermes`), standard library only, fail-open (D278). `eden_id` maps ids exactly as the
  TypeScript `edenId` does, so a mixed stack finds one user's state. Synchronous: from asyncio, call it through
  `asyncio.to_thread`.
- **Anything else:** the HTTP API is a handful of JSON POSTs (`packages/server/src/http.ts` lists them). Keep the
  client's contract: short timeouts (800 ms, plus the observe's `waitMs`), and every error is "no context", never an
  exception in the agent's loop.
- **MCP:** `bun packages/server/src/mcp-stdio.ts` serves `ask_context` for one user over stdio; `createMcpServer`
  attaches it to any MCP transport (Eden's own `Transport` shape, which the official SDK's transports fit, D1704), and
  its `handle(message)` answers one JSON-RPC message without a transport. Eden's push (observe) is not an MCP tool: an MCP-only agent gets answers, not the
  unasked packet.

## Hosting

`docker build -t eden .` from the repo root builds the server image (D280); its header lists the flags. It listens on
`PORT` (8790) on all interfaces, keeps the source map (entity names and counts, never content, D8) in the `/data`
volume, and reports health on `/healthz`. Item text, sessions and the explain traces live in memory: a restart starts
idle users are read back from disk, encrypted, and polled for what is new (D991, below: "Restarts without a full
re-sync"); the server needs `EDEN_PERSIST_KEY` for that and refuses to start without it unless `EDEN_PERSIST=off`. Set `EDEN_PROCESSES` to the
container's CPU quota and read "Processes and per-tenant caps" below. Never run `EDEN_DEV=1` on a reachable port (the
server warns when it listens beyond loopback). Generate each tenant's key with `openssl rand -hex 24`; requests send
it as `Authorization: Bearer <key>` (no other header is read). A configuration mistake (a short key, a missing
sources file, a busy port, an unwritable `EDEN_HOME`) stops the server with an `eden:` line naming it and exit code 2
(D365); with several processes a child's own line and the router's retry note come first. Per-user connectors: mount the file and name its path inside the container
(`-v ./sources:/sources:ro -e EDEN_USER_SOURCES_FILE=/sources/users.json`), plus `-e` for each token variable the file
names; the file is re-read when it changes, so adding a user needs no restart.

**Running it for real:** docs/DEPLOY.md is the operator's guide (one box with Caddy, a free Oracle A1 box, backups,
monitoring, upgrades with no failed requests, and more than one machine behind the cluster router, D992-D994), with
the kit in `deploy/`. Beside `/healthz` every process answers `/readyz` (503 while it drains) and `/metrics`
(Prometheus text, counts only); a stop drains within `EDEN_SHUTDOWN_GRACE_MS`.

## Configuration

There is one configuration, the default (D112): the best measured setup, NEWL (D99) with the speed and memory
switches measured to cost nothing (poll behind, small poll pages, no probe grace, the push's reader not waiting for
the poll, the slow-path queue, vocabulary release). Run it as shipped:

- **With `OPENROUTER_API_KEY` set**, the server also runs the default's model roles on `EDEN_MODEL` (default
  `anthropic/claude-haiku-5.5` through OpenRouter, no data collection, ZDR): cards and intent requests in the
  background; the ask-time reader is built but called only with `pushCandidates: 0` (D237: by default the push hands
  the agent its candidates with no model call). Each role has its own per-session and per-user-day
  budget, and one cap per tenant per day spans them all (`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25). Cost per task
  and per user is in [COST-MODEL.md](COST-MODEL.md); disclose the model provider to your users
  ([PRIVACY.md](PRIVACY.md)).
- **Without a key**, the same default runs its no-model path: nothing to change. The push's candidates make no model
  call and run there too (D276): a request that acts or opens like an instruction gets up to five items to check, at $0.
- Pass the client's default wait (3,000 ms on a sent user message, `DEFAULT_WAIT_MS`); see the waitMs section above.
- `EDEN_ENGINE_CONFIG` takes a JSON file of settings over the default, usually one of `docs/profiles/minus-*.json`
  ("default minus a part") for a comparison. New behaviour arrives as a trial switch
  (DECISIONS.md, "Trial switches") and is decided by the session that opened it (D814); it becomes the default or is
  deleted. A deleted setting stops a server whose
  file still names it (`unknown key`): drop it from the file. D225–D228 deleted `graph`, `graphMerge` and the other
  `graph*` keys, `askVerdicts`, `anticipate*` and `slowPathQueue`.

### Processes and per-tenant caps (`EDEN_PROCESSES`, D163, D178)

The HTTP server runs `EDEN_PROCESSES` processes: unset, the core count (`os.availableParallelism()`, capped at 64),
which is a router in front of N child processes; 1, and any one-core machine, is one process with no router. Each
user is pinned to one child (`hash(tenant/userId) mod N`), so a user's state lives in one process. On 4 cores the
router over 4 children served 3.26x the events per second of one process (D178, `packages/server/CLAUDE.md`).

- **Every child holds 1/N of each per-tenant cap**, so the caps stay totals across the deploy when a tenant's users
  spread over the children: the model spend cap (`EDEN_MODEL_USD_PER_TENANT_DAY`, default $25), the rate
  (`EDEN_TENANT_RPS`, default 200) and the burst (`EDEN_TENANT_BURST`, default 400). A tenant whose traffic comes
  from one user, or from a few users that hash to the same child, only ever reaches that child's share. With the
  defaults that is $6.25 a day, 50 rps and a burst of 100 on 4 cores, and $0.39 a day, 3.1 rps and a burst of 6 on
  64 (the arithmetic: each default divided by N). Past the spend share the reader and cards fall back to the no-model
  path; past the rate share callers get 429. For such tenants raise the caps (by up to N) or set
  `EDEN_PROCESSES=1`.
- **Memory.** Each process costs about 67 MB idle: measured with `ps -o rss` 3 s after `listening` (`EDEN_DEV=1`,
  no sources, 4 cores, two runs each), one process was 67.0-67.5 MB, and `EDEN_PROCESSES=4` was 325 MB in all (the
  router 55 MB and each child 66.6-68.1 MB; shared pages counted in each). Budget N x 67 MB plus the router before
  any user state.
- **Containers with a CPU quota.** Bun's core count honours CPU affinity and a cgroup v1 CPU quota (measured: 1 under
  `taskset -c 0` and under a 1-CPU v1 quota on 4 cores), and `loadConfig` also reads a cgroup v2 `cpu.max` quota and
  takes the lower count. Other limits (a v2 quota in a cgroup not visible from the container, an orchestrator's
  CPU request without a limit, a memory limit) are not seen: set `EDEN_PROCESSES` explicitly in any container, to
  the CPUs it may use and no more than its memory limit allows at ~67 MB each.

### Restarts without a full re-sync (persistence, on by default since D991; D425-D427)

**Upgrading across D603** (persist format 3): files written by an earlier version are discarded at startup or first
read, so each persisted user syncs from the start once. An `EDEN_ENGINE_CONFIG` file that still sets
`sourceYieldFloor` or `sourceYieldWords` stops the server at startup with "unknown key" (D103): remove the two keys.

Idle users are kept across a restart by default (D991; until then D8 kept content in memory only, and D425 made this
an opt-in). The server needs one secret for it and refuses to start without it:

```bash
EDEN_PERSIST_KEY=...                          # 32 random bytes, hex or base64 (openssl rand -hex 32), made ONCE and
                                              # kept in your secret store, never in the image or a committed file
EDEN_PERSIST_FROZEN_DIR=/data/frozen          # optional; default $EDEN_HOME/frozen; one subdirectory per process
EDEN_PERSIST_MAX_MB=12288                     # optional; the directory's cap across processes (default: the
                                              # machine's memory, at least 4,096; a cgroup memory limit lowers it)
EDEN_PERSIST=off                              # instead of the three above: nothing written, every restart re-reads
                                              # every user's sources (about 2 minutes and 30 listings a user, D863)
```

Dev mode (`EDEN_DEV=1`) is off unless one of these is set. The listening line says which: "frozen users persisted,
encrypted (N on disk, cap M MB, D991)" or "frozen users NOT persisted". The default cap holds a file for every user
a box can serve: users are bound by memory (2-4.4 MB of RSS a user at the 3,000-item cap) and a user's file is
smaller than that (compact 0.8-1.2 MB, warm 1.8-2.7 MB). Without persistence a restart re-reads every active user's
sources from the start: on a full 4-core box about 3.6 minutes of all four cores (A14), and every connector lists
everything again.

A user idle 30 minutes (frozen compact; the two-minute warm freeze, D862, writes nothing) is then also written to
that directory, encrypted (AES-256-GCM, a file per user under a
keyed-hash name, bound to its tenant and user), with the sync's position for them. After a restart each user is read
back the first time they are used and their sources are polled for what is new. Measured (200 users, the bench in
docs/research/c3-persist-frozen.md): synced again in 14.1-14.2 s instead of 42.9-44.0 s at 1,000 items a user,
and 32.4 s instead of 121.8 s at the 3,000-item cap; listing calls 2,400 → 600 and 6,000 → 600. Live users are
written at SIGTERM (within 1.5 s), warm users with them; a crash loses users used within the last 30 minutes (they
re-sync), as before D862.

What you take on: redacted item content of idle users is on disk until the user returns, is forgotten (`/v1/forget`
deletes the file too) or the file is 7 days old; the key in the environment opens every file, so put the directory
on an encrypted volume, keep the key out of images and logs, and disclose the store to your users (docs/PRIVACY.md,
docs/THREAT-MODEL.md T12). A new key, a new Eden format, or a damaged file costs that user a re-sync, logged as a
count, never an id. Changing `EDEN_PROCESSES` deletes the other count's directories (those users re-sync).

[DECISIONS.md](DECISIONS.md) holds each part's evidence.
