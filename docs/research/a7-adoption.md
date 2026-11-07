# A7: what makes a team want Eden, built (2026-11-07)

Session A7 of the afternoon audit ([audit-1107-plan.md](audit-1107-plan.md)), following A4
([a4-adoption.md](a4-adoption.md)). Decisions D291–D295. Branch `claude/a7-adoption2` from
`claude/lucid-hypatia-v9wqk5` (a750f5f22). Spend: $0.629 on the ledger (Pi runs, regrades and two one-task checks, Anthropic Haiku 5.5)
plus at most $0.012 off the ledger (the demo's optional agent, Haiku 5.5 through Anthropic's OpenAI-compatible
endpoint: three demo runs, 7,992 input and 9,140 output tokens, $0.0054 at `pricing.ts`'s rates, plus about six
debugging calls whose usage was not all recorded, bounded at $0.006). Every figure below is from a command run in this session.

## In plain words

A4 removed the reasons a team would say no. This session built what makes a team say yes, in the order a team meets
them: a demo that shows the value in one command with no key; a check that the free (no-key) path is honest, on a
live agent; a report a team can put in front of its stakeholders from its own traffic; a threat model for its
security review; and presets so connecting a user's Gmail or Calendar is one line.

1. **The no-key server is a real product, measured live (D291).** On Pi with Haiku, a server with no model key
   raised the hidden fact on 55% of hidden tasks, against 76% for the keyed default and 12% for the agent with its
   own search tools alone. It did not raise more false concerns than the keyed default once a second grader
   reread them (5 and 5 of 288 control and neutral tasks; the agent alone 1). The 21 points between no-key and keyed
   are what the background cards and intent index buy.
2. **`bun run demo` (D292).** One command, no key, under a second: a simulated user, the real server and client, three
   requests whose deciding fact sits in another source, chatter, a question; for each, what Eden put in front of the
   agent, whether it was the fact needed, and why. With an agent key the agent answers with and without Eden.
3. **`bun run digest` (D293).** "Eden caught this" for stakeholders, from the server's own log: how often Eden added
   context, of what kind, from which connectors, how often the agent used it, why it was silent, what it cost. Built
   on a new content-free usage record.
4. **docs/THREAT-MODEL.md (D295).** Assets, actors, flows, eleven threats with mitigations and decisions, what the
   candidates default sends to the tenant's model, the unverified ZDR status, and the open items in order.
5. **Connector presets and an OAuth directory (D294).** `{"preset": "gmail", …}` names Gmail's read tools for you;
   the read-only check is unchanged. Building it found a real bug: a fetch from Gmail's `get_thread` always came back
   empty. Fixed and tested.

## 1. D276's owed check: the default with no model key, on Pi (D291)

**How "no key" is expressed.** pi-ab had no way to run Eden without its model roles: the card enricher and the reader
are built whenever the configuration has `cards` and `askReader` on, and turning those settings off would run a
different configuration (the push needs `askReader` on, D276). So pi-ab gained a harness flag, `+nokey`, like `+ask`:
the partner is built as `buildPartner` builds it with `NO_MODELS` (no `OPENROUTER_API_KEY`): `DEFAULT_CONFIG`
unchanged, no `CardEnricher` (so no cards and no intent requests) and no `AskReader`. It is refused on bases without
Eden and on `-judge` bases, and the report pairs `eden+nokey` with `eden` (`pi-conditions.test.ts`).

**Run.** `packages/sim/lab/a7/run.sh` (Pi 1.3.0, Haiku 5.5 on Anthropic direct as agent and grader, a lab transport,
D97; train1–6, first 12 templates, hidden, control and neutral; seeds 41 and 42 in two processes; `--push payload`;
direct source profile; time scale 1; cards and intent requests replayed for the keyed arm). 432 tasks per arm,
0 retries, 0 ungraded. Report: `packages/sim/lab/a7/short-report.txt`; regrade: `concerns.txt`.

| Arm | Hidden raised | Control concerns (regraded) | Neutral concerns (regraded) | Mix $/1k agent + Eden | Wall p50 / p90 mix, s |
| --- | --- | --- | --- | --- | --- |
| tools | 17/144 (0.118) | 0 (0) | 2 (1) | 0.375 + 0 | 4.59 / 6.99 |
| eden (keyed default) | 109/144 (0.757) | 4 (4) | 1 (1) | 0.426 + 0 (card backfill +0.019) | 3.22 / 4.62 |
| eden+nokey | 79/144 (0.549) | 6 (3) | 2 (2) | 0.416 + 0 | 3.39 / 5.06 |

Paired, bootstrap 95%: eden+nokey − eden hidden −0.208 (−0.292..−0.125), control +0.014 (−0.028..+0.056), neutral
+0.007 (−0.014..+0.028); $/1k over all tasks −0.020 (−0.032..−0.007) billed, −0.004 (−0.021..+0.010) cache-neutral;
neutral wall +0.32 s (+0.12..+0.52). eden − tools hidden +0.639 (+0.563..+0.715).

**Reading.** The no-key path does not raise false concerns materially: the run's grader called 8 of its 288 control
and neutral answers concerns against the keyed default's 5, but a second Haiku pass kept 5 against 5. Of the three
it dropped, two are the known look-alikes (`month-end-change-freeze`, `restricted-datastore-grant` on seed 41, the
same templates CL8 read) and one a hedge (`maya-dentist-already-booked`). The kept ones are templates the keyed
default also trips on in other runs (CL8). No fix was needed, so the engine is unchanged by this check. What a team
gives up without a key is recall: 21 points of hidden facts, which is what cards and the intent index find (an
item whose words do not match the request but whose card says it constrains it). The no-key arm is $0.010/1k
cheaper on the mix (billed; the cache-neutral difference is not significant) and its neutral tasks are 0.3 s slower
(the agent called `ask_context` a little more often: 1.24 tool calls a neutral task against 1.05).

**Connector calls and their price (the parent's ask).** Counted per task: the agent's own connector calls (its tool
calls less `ask_context`), Eden's at request time (the traces' `sourceCalls` in each task's timeline: 0 in both Eden
arms, since every lookup answered from the synced index and payload notices carry their items), and Eden's
background calls, which no timeline holds (no task is current during the backfill or the tick between tasks).
`packages/sim/lab/a7/connector-calls.ts` replays exactly that part of each stream at $0: 18 listing calls per
simulated user to backfill, 0 between tasks; `connectors.py` prices them on market.py's plans
(`packages/sim/lab/a7/connectors.txt`; the backfill is spread over this run's 12-task streams, an upper bound for a
real user whose backfill is spread over far more requests). The base's merged `pi-cost-report.ts` (8274294f0)
gives the same steady figures on these runs (`cost-report.txt`: Zapier mix 87.558, 0.426, 0.416) but no backfill,
since the runs predate its recording; a one-task live check after the merge (`a7-validate2-41`, $0.0015) recorded
18 backfill calls and 0 after it per no-key stream, as the replay counts. pi-ab used to book a stream's background
only when it had cards, so a no-key stream's connector calls were dropped: it now books them, marked `noModels`
so the card spend each seed spreads is unchanged (`ab-replay.test.ts`).

| Plan ($ per 1,000 calls) | tools: model + connectors, $/1k tasks | eden, steady / all-in | eden+nokey, steady / all-in |
| --- | --- | --- | --- |
| First-party APIs (0) | 0.375 | 0.426 / 0.426 | 0.416 / 0.416 |
| Composio (0.30) | 1.389 | 0.426 / 0.876 | 0.416 / 0.866 |
| Unified.to (0.75) | 2.910 | 0.426 / 1.551 | 0.416 / 1.541 |
| Arcade.dev (10) | 34.167 | 0.426 / 15.426 | 0.416 / 15.416 |
| Pipedream Connect (12) | 40.925 | 0.426 / 18.426 | 0.416 / 18.416 |
| Zapier MCP (25.8) | 87.558 | 0.426 / 39.126 | 0.416 / 39.116 |

The agent alone made 3.38 connector calls a task on the mix; with Eden (the `eden` arm has no search tools of its
own, only `ask_context`) it made none. That is the arm's shape, not a saving every integration will see: an agent that
keeps its own tools beside Eden (`both+ask`) still calls them. On a paid connector plan the calls dwarf the model:
on Zapier MCP the agent alone costs $87.56 per 1,000 tasks, of which $0.375 is the model.

## 2. `bun run demo` (D292)

`packages/sim/src/demo.ts`. It builds seed 41's world (1,517 items) with train1's planted items (personal finance),
wires the shipped default with no key (`buildPartner` with `NO_MODELS`, a new optional `now` so the world's own date
is "now"), backfills the sync as a server would before a user's first request, serves `createHandler` on a loopback
port and talks to it through `@eden/client` (`observe` with the 3 s wait, `collect`, `ask`, `explain`). Each block
shows the packet's lines as the agent reads them (deduplicated by item), marks the planted item, and prints explain's
sentences, Eden's time, model calls and cost.

- **Picks are picks.** The three requests (a payment to bank details changed by email, repaying a debt already
  settled, paying with a blocked card) were chosen. To say what a newcomer should expect elsewhere, the same path
  ran over every template of train1–6 on seeds 41 and 42 (`packages/sim/lab/a7/demo-sweep.ts`, output in
  `demo-sweep.txt`): the deciding item reached the agent for 208 of 384 requests, close to the no-key funnel A4
  measured (202 of 384, D276).
- **With an agent.** `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AGENT_MODEL` as in examples/personal-agent. Run with Haiku
  5.5 through Anthropic's OpenAI-compatible endpoint (`packages/sim/lab/a7/demo-agent.txt`, read by hand, not
  graded): without Eden none of the three answers named the deciding fact (the first advised confirming changed bank
  details by phone, generically; the others explained how to pay); with Eden all three did. One thing found on the
  way: at 400 output tokens Haiku through that endpoint returned empty content for the longer prompts
  (`finish_reason: length`), so the demo asks for 1,500 and prints an empty answer as such.
- 0.7 s wall without a key; `demo.test.ts` pins 3 of 3 caught, silent chatter, no model call and $0.

## 3. `bun run digest` (D293)

`trace-report` (D279) answers an SRE's questions. A buyer asks different ones: how often did it help, with what, and
did the agent use it? Traces could answer the first two, but not the third: the engine inferred usage (D18) and
accepted feedback (D13) only to teach the source map. So the engine gained an optional sink, `onUsage`, that reports
each injection's outcome once known: inferred used, expired, session ended unused, or explicit feedback (a
correction too), with the session id, injection id (random, `newId`) and connector ids. No text. The server logs it
beside the traces with `EDEN_TRACE=1`.

`packages/server/src/digest.ts` reads such a log and prints Markdown: a headline (context added after N of M events;
the agent visibly used X of Y injections), kinds in words, connectors, silence with explain's sentences, time and
spend, and connector calls per 1,000 requests priced on the same six plans (the agent's reported tool calls, Eden's
lookups', and its background sync's from `{"sync": …}` counter lines the server now logs once a minute), with a
without-Eden column from a `--baseline` log (the proxy's shadow mode). It refuses to say 0% when use cannot be known: with no `agent_message` or `tool_call` events and no feedback in
the log, it says "not measured" and how to measure it. On the demo with an agent (`packages/sim/lab/a7/
digest-demo-agent.md`): 4 of 8 events added context; 6 of 6 injections used. That 100% shows the measure's limit,
written into the report: use is per injection, so a five-item candidates packet counts as used when any one item is.

## 4. docs/THREAT-MODEL.md (D295)

Written from docs/PRIVACY.md, the decisions and the code. Its plainest statements: prompt injection is reduced, not
solved (the envelope is a label; candidates put up to five unvetted items in front of the agent's model per acting
request, with or without a key); ZDR routing is requested but unverified; redaction removes credential-shaped
strings, not personal data. Its open items, in order: verify OpenRouter's ZDR routing; a live injection suite against
the candidates packet; a third-party review; key rotation and scopes; encryption at rest.

## 5. Connector presets and the OAuth directory (D294)

A preset fills in a server's read tools and fixed arguments in `checkSpecs`, before every other check, so an expanded
entry meets the same rules as one written by hand; explicit fields win; it never adds `trustedReadTools`.

| Preset | Tools | Checked against |
| --- | --- | --- |
| `gmail` | search `search_threads` (view: newest message of each thread), list `search_threads` paged by `pageToken` | Google's hosted Gmail server's input schema as served to this session |
| `google-calendar` | search `search_events`; no listing (`list_events` pages by start time) | Google's hosted Calendar server's input schema |
| `caldav` | `caldav_search_events` (unannotated) | the connector lab's pinned server and captured schema |
| `obsidian` | `search_notes` (unannotated) | the connector lab's pinned mcpvault |

No CRM preset: no CRM server's tools could be verified from here, and a guessed tool name is worse than none.

**A fetch gap, and why no preset fetches yet.** A thread fetch shaped as `get_thread` describes itself (`{id,
messages: [...]}`) always came back null: `McpSource.fetch` looked only among the rows (`messages`, each with a
message id) and never matched the thread id. `fetch` now takes the top-level record when its own id is the ref, and
still refuses another record's id; the new test fails without the fix. But the reviewer found the next problem: a
fetched thread holds every message where `search_threads` (summary view) holds the newest, so re-reading an unchanged
thread would look like a change and send the agent an update for nothing (D126, D205). With no captured reply of
Google's tools to show that any search and fetch copies match, the `gmail` and `google-calendar` presets name no fetch
tool; doubted copies are delivered as held, labelled by age, as for any source without one. Google's read-only
annotations were not captured either: if they are absent, the connect is refused (fails closed).

`examples/oauth-directory/directory.ts` is the `SourceDirectory` a team with per-user Google accounts would write:
refresh tokens stay in the app's vault, Eden is handed short-lived access tokens on preset entries, refreshed a minute
before expiry with one refresh shared by concurrent asks, dropped on expiry, a failed refresh or `forget`, and a
revoked grant becomes that user's configuration error only. It recommends read-only OAuth scopes so the provider refuses a write beneath Eden's own check.

## Checks

- `bun run eval`: identical to the base tree on every field but latency (precision 0.5909, recall 0.52,
  falseFireRate 0); the engine change is a sink that is off unless wired, and the fetch fix is not on the eval's path.
- `bun run check` green: 1,980 tests after the first review's fixes, 1,995 after merging the base tip 8274294f0 and
  the second review's fixes.
- Reviewer subagent on the diff: REQUEST_CHANGES with six findings, all fixed: (1) the Gmail preset's fetch would
  report unchanged threads as changed: no preset names a fetch tool now; (2) the 208 of 384 had no file behind it:
  `demo-sweep.ts` and its output are checked in; (3) Google's annotations were not captured: said so in the presets and
  docs; (4) the OAuth example kept tokens forever: dropped on expiry, a failed refresh or `forget`, and THREAT-MODEL T7
  says what it holds; (5) a correction's usage record named the feedback's session, not the delivery's: `Recorded`
  keeps it; (6) the demo's chatter comment. A second pass over the fixes found two digest counting bugs, fixed and
  tested: the sync counter was taken once per pid, so a container restart (pid 1 again) or two replicas lost counts
  (each server run now logs a random `run` id, and a counter drop starts a new segment); and the firewall's finding
  on a tool call counted as a second agent call. Unknown background calls print n/a, not zero.

## What is left (next steps, in order)

1. The live injection suite against the candidates packet (THREAT-MODEL open item 2), on Pi, beside `tools`.
2. OpenRouter ZDR verification (open item 1).
3. A CRM preset once a CRM MCP server's tools can be checked (HubSpot, Salesforce), and a Drive or Docs one.
4. Per-user digests: usage records and traces carry session ids only; a tenant- or user-keyed digest needs a
   decision on what an operator log may hold.
5. An MCP-only integration still gets no push (A4 blocker 11).
