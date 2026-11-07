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
// From your sources' webhooks: forward what changed, with the items (see "Forward your sources' change notifications").
await eden.sourceChanged(sourceId, { items, removed });
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
- **The push's candidates (D237, the default with a model key) need no reader time.** The push searches, then hands
  the agent the five best candidates, framed to be checked against the request (about 950 bytes a request on the
  lab's worlds), with no model call; on Pi with payload notices Eden's time on the agent's path was about 10 ms a
  request (docs/research/cl-cl6.md). The candidates are not vetted: up to five items that may not bear on the request
  reach your agent's model on most acting requests (in the lab, 86% of nothing-to-add requests got a packet), so the
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

- **Put Eden's packet after the stable prefix.** `withContext` inserts it as a system message just before the latest
  user message, so the system prompt, tool definitions and earlier _turns_ stay byte-identical between requests. It
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

## Forward your sources' change notifications, with their items (`syncPush`, D125, D210)

Eden keeps a synced copy of each user's listable sources. Without help it guesses when a source has changed (a busy
inbox goes stale in minutes) and polls it at the next lookup: 3.8 to 5.1 listing calls per agent task in the
market-latency runs (docs/research/cost-fixes.md). On a connector platform that bills per call, those polls are most
of Eden's connector bill (RealUse-1: agent + Eden $113–133 per 1,000 tasks on a $12/1k-calls plan, against $39–41 for
the agent alone). If you receive the provider's change notifications, forward them, **with the changed items**:

```ts
// The default integration: what changed, in full. Eden holds it with no call to the source.
await eden.sourceChanged("gmail", {
  items: [{ ref: msg.id, title: msg.subject, text: msg.body, updatedAt: msg.internalDate }],
  removed: deletedIds, // refs the source no longer has (deleted, recalled)
});
```

- **The changed items themselves (the default; D210).** A Slack Events API message, a Graph notification with
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
- **Only that the source changed** (a Gmail `watch` push you do not expand, a Calendar or Drive channel, a HubSpot
  webhook): `client.sourceChanged(sourceId)`, or `POST /v1/sources/changed {userId, sourceId}`. The source is polled
  once, at its next use, however many notifications came first, and every item Eden read from it before the signal is
  re-read by its id before it is delivered or cited (D126, D131, D211). For a busy inbox this saves little: it changes
  about every hour, so it is polled about as often as before. Use it only where the provider gives no items.
  **It also makes `ask_context` slow** (CL4, D249): on Pi with signals, an ask took 1.35–1.59 s, almost all of it
  re-reading 4–5 doubted copies it cites; with the items pushed it took 0.19 s (heldout14 neutral tasks, one seed,
  Anthropic-direct lab figures, docs/research/cl-cl4.md).

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
held). Notifications that carry their items or name their deletions need no re-reads, so prefer them where the
provider offers them; for a Gmail push, turn the history id into items and deletions with `history.list` first.

Receiving notifications has its own cost, which Eden does not see: a platform may bill trigger runs, and a Gmail push
carries only a history id that your code turns into items with a `history.list` call.

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
- **Without a key**, the same default runs its no-model path: nothing to change.
- Pass the client's default wait (3,000 ms on a sent user message, `DEFAULT_WAIT_MS`); see the waitMs section above.
- `EDEN_ENGINE_CONFIG` takes a JSON file of settings over the default, usually one of `docs/profiles/minus-*.json`
  ("default minus a part") for a comparison. New behaviour arrives as a trial switch with an owner and an end date
  (DECISIONS.md, "Trial switches"); it becomes the default or is deleted. A deleted setting stops a server whose
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

[DECISIONS.md](DECISIONS.md) holds each part's evidence.
