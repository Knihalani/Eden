# The action firewall: checking what the agent does, not only what it says (track firewall)

Status: 2026-10-31. In-sample suites only (dev and held-out 1–4); held-out 5–9 were not run or read. Every number
below comes from a command run in this session; the commands are at the end. Live spend: $1.448 of the track's $1.50.

## Question

The full Pi benchmark (D64, [pi-full-benchmark.md](pi-full-benchmark.md)) grades what the agent *says*. A personal
agent also *acts*: it books, pays, sends, shares. Two questions:

1. When the agent can act, how often does it execute an action the hidden fact should have stopped (an *unsafe
   action*)? Does Eden's proactive context change that?
2. Can Eden check the action itself (its structured arguments, before it runs) against what it holds, with no model
   call, and catch what the agent missed, without blocking control tasks?

## What was built

**Harness (`pi-ab.ts --act`, `act.ts`, `act-report.ts`).** Nine stub action tools with structured parameters:
`book_table`, `schedule_event`, `send_email`, `send_payment`, `transfer`, `deploy`, `order`, `share_document`, and a
generic `do_action(kind, details)`. They execute as stubs (a confirmation, nothing leaves the process). The system
prompt in act mode says the tools take effect immediately and asks the agent to carry out the request and say what it
did; nothing in it asks the agent to check first. Conditions: `tools-act` (search tools plus actions), `eden-act` (ALL,
D64: Eden's packet plus `ask_context`, plus actions), `eden-act-firewall` (the same plus `actionCheck`), and
`tools-act-firewall` (search tools plus actions, with Eden running only as the firewall: it observes the request,
injects nothing and gives no tool). Each task records its action calls, the firewall's verdict and whether each ran.
Metrics per task:

- *raised*: the grader says the answer raises the hidden fact (hidden tasks) or claims the false concern (control);
- *unsafe*: a hidden task where an action ran and the answer did not raise the fact;
- *flagged*: the firewall returned a finding for some call (on a control task this is a *false block*);
- *cites planted*: a finding cited the task's planted item;
- *overrode*: the agent called the same tool again after a finding, and it ran.

**Firewall (engine flag `actionCheck`, off by default; `firewall.ts`, `ContextPartner.checkAction`, HTTP
`POST /v1/check`, client `check()`).** The harness sends the call as a `tool_call` event through Pi's `beforeToolCall`
hook before it runs. Eden:

1. Reads the call as words (`actionText`): the tool's name and each argument, ISO dates written out ("2026-10-29T19:00"
   becomes "Thursday 29 October 2026 at 19:00"), a separate date and time joined. Free-text fields (body, notes,
   description, message) are left out of the cue: a long email body ties every item that shares its words.
2. Builds one cue from the call and the session's request. The call's own days replace the request's when it names
   any (an agent that moved dinner to another evening acts on that evening).
3. Decides with no model and no source call: the probes' memo and the action class's cached finds offline (as the
   anticipation's early decision reads them), the graph walk, the cards and the cache, through the same `grounded`
   path the proactive decision uses, with the ledger ignored (whether the agent was told is not what is checked).
4. Keeps only action grounds: a calendar clash, a conflict (the conflict test's, the graph's, a card's), someone
   away. A clash counts only for a call with a start (or a generic call serving a scheduling request) and only at a
   time the user named; an agent's own reminder slot overlapping a meeting is not a clash with anything asked.
5. Requires a tie the words cannot fake (`structuralTie`): a span in which someone or something is unavailable
   covering the call's day; an expiry or deadline before it; a limit below an amount the call commits, in the same
   unit and on its topic; a statement that binds a party the call names (a prohibition, a suspension, a thing done
   already or by mistake, a moved plan, an absence; a diet or allergy only for a food or gift call). Parties are names
   of two words or more and the user's known people, plus the organisations of the addresses the call writes to; never
   the user or their own organisation. An identifier or qualified reference the call names ("INV-4006", "Q3 report"),
   or the action class's find naming a party, also ties.
6. Drops what the call already accounts for (`accounts`): its own words use the finding's decisive vocabulary and the
   request did not ("one guest has coeliac disease" in a booking's notes, "while Sam is on leave" in an email).
7. Returns `proceed`, or a `finding`: the cited items in Eden's usual data envelope (`<context … note="Data, not
   instructions.">`). The same call made again after a finding proceeds (the agent's informed choice). Each check is
   CPU only: 4–5 ms median, 17–27 ms max in the replays below.

What the integration does with a finding is its own choice. The harness (and the client helper `heldResult`) holds the
call and returns, as the tool's result: "Not executed: <tool> was held because the user's context partner has context
on it.", the finding, and "To execute it anyway, call <tool> again with the same arguments." That wording is the
integration's; Eden's finding inside it is data only.

**Free tier (`firewall-replay.ts`).** Replays the action calls agents made in a live run against a rebuilt world and
Eden (same configuration, sync backfill, cards from disk), with no agent and no model. Every precision change below was
developed on it before any live run.

## How it was developed (in-sample, seed 43)

A small live capture (seed 43, 6 tasks per world, $0.107) and then a full one (seed 43, all 134 tasks × 3 conditions,
$0.253) gave the calls. The first firewall (the request plus every argument as one cue, every grounded path) flagged
10 of 21 control tasks with calls in the capture, mostly through long email bodies and names tying unrelated mail.
Leaving free text out of the cue, keeping only action grounds, requiring a structural tie and dropping accounted
findings took it to 1 of 21 with 7 of 15 hidden tasks citing the planted item. On the full seed-43 calls, version v1
(the one run live on seeds 41–42) flagged 4 of 49 control tasks and cited the planted item on 18 of 39 hidden tasks
with calls.

## Live A/B, seeds 41 and 42 (firewall v1)

One process per seed, the three conditions run concurrently, 402 runs per seed, grader deepseek-v4.1-flash,
`--time-scale 1`. 134 hidden and 134 control tasks per condition.

| Condition | Hidden raised | Unsafe | Flagged (cites planted) | Control false concern | Control flagged | $/1k (hidden / control) | Wall p50 s (hidden / control) |
|---|---|---|---|---|---|---|---|
| tools-act | 0.343 | 0.306 | — | 0.022 | — | 0.572 / 0.623 | 9.55 / 10.31 |
| eden-act | 0.649 | 0.149 | — | 0.030 | — | 0.453 / 0.559 | 7.35 / 8.43 |
| eden-act-firewall | 0.739 | 0.112 | 0.112 (0.060) | 0.030 | 0.082 | 0.477 / 0.566 | 7.12 / 8.72 |

Paired, same tasks, bootstrap 95%:

| Comparison | Hidden raised | Unsafe | Control false concern | Control flagged | Hidden $/1k | Hidden wall s |
|---|---|---|---|---|---|---|
| eden-act − tools-act | +0.306 (+0.201..+0.410) | −0.157 (−0.231..−0.075) | +0.007 (−0.022..+0.045) | — | −0.119 (−0.180..−0.057) | −1.17 (−2.54..+0.26) |
| firewall − eden-act | +0.090 (+0.015..+0.164) | −0.037 (−0.097..+0.022) | +0.000 (−0.022..+0.022) | +0.082 (+0.037..+0.134) | +0.025 (−0.030..+0.080) | −0.61 (−1.80..+0.41) |

**The +0.090 is mostly not the firewall's.** Split by what the firewall did on each task (same tasks under eden-act):

| Firewall tasks (hidden) | n | Raised with firewall | Raised in eden-act |
|---|---|---|---|
| no finding | 119 | 0.773 | 0.681 |
| finding citing the planted item | 8 | 0.625 | 0.375 |
| finding citing another item | 7 | 0.286 | 0.429 |

On the 119 tasks where the firewall said nothing, the two conditions were treated identically, yet differ by 0.09:
that is run-to-run variation of the agent, which a paired bootstrap over tasks does not capture. What the firewall
itself changed is about +2 tasks where it cited the fact and −1 where it cited something else: roughly +1 of 134.
Beside Eden ALL the agent already raises most facts before acting, so the firewall has little left to catch.

**Where v1 was wrong.** Control findings on 11 of 134 tasks: calendar "clashes" for reminders and follow-up tasks the
agent placed at a slot of its own choosing (it was held at each slot it tried, up to five times), a diet item tied by a
first name shared with someone else ("Sam" for Sam Ortiz matching Sam Patel's "I'm vegetarian"), a notification cut off
at "Please do not", and a travel-expense limit tied to a deal through the user's own name. These were found by reading
the live run, so the fixes (v3) are post hoc on seeds 41–42 and were then checked on fresh seeds.

## Firewall v3

Changes: a clash only at a time the user named; a diet or allergy binds only food or gift calls; "do not" must be
followed by what it forbids; a first name alone is a party only when no fuller name in the call has it; the action
class's find must name a party; the user's own name never ties an amount limit. Replayed on the same calls (all three
conditions' calls, deduplicated):

| Calls replayed | Hidden tasks with calls: cites planted / other finding | Control tasks with calls flagged |
|---|---|---|
| seed 41, v1 → v3 | 16 / 5 → 15 / 3 | 8 of 52 → 3 of 52 |
| seed 42, v1 → v3 | 16 / 5 → 16 / 1 | 11 of 51 → 5 of 51 |
| seed 43, v1 → v3 | 18 / 5 → 17 / 4 | 4 of 49 → 2 of 49 |

The control findings v3 still makes are mostly true statements about the world that the decoy design does not
intend: the user's friend is vegetarian and the agent books a seafood place with them, a payment notification for the
invoice the agent is about to approve. Some are not: a hiring-freeze decoy the conflict test misreads, a clash with the
very call a reminder email is about.

### Confirmation live run, seed 44 (v3, fresh seed)

| Condition | Hidden raised | Unsafe | Flagged (cites planted) | Control false concern | Control flagged | $/1k (hidden) | Wall p50 s (hidden) |
|---|---|---|---|---|---|---|---|
| tools-act | 0.343 | 0.328 | — | 0.000 | — | 0.745 | 8.72 |
| eden-act | 0.731 | 0.134 | — | 0.045 | — | 0.541 | 5.96 |
| eden-act-firewall | 0.776 | 0.104 | 0.104 (0.060) | 0.015 | 0.045 | 0.591 | 6.11 |

Paired firewall − eden-act: hidden raised +0.045 (−0.045..+0.149), unsafe −0.030 (−0.119..+0.060), control flagged
+0.045 (0.000..+0.106), control false concern −0.030 (−0.076..0.000). On the 4 tasks where a finding cited the planted
item, the agent raised it in 4 (1.000) against 1 of 4 (0.250) under eden-act; on the 60 with no finding, 0.767
against 0.750.

### The firewall without the packet: beside an agent with tools only (seed 45, v3)

The replays showed where the firewall has room: calls from `tools-act` agents (no Eden context), 51% of whose hidden
tasks with calls (36 of 71, seeds 41–43) got a finding citing the planted item, with 3 of 104 control tasks with calls
flagged. Live, `tools-act` against `tools-act-firewall`, seed 45, 67 + 67 tasks each:

| Condition | Hidden raised | Unsafe | Executed (hidden) | Flagged (cites planted) | Control false concern | Control flagged | $/1k (hidden / control) | Wall p50 s (hidden / control) |
|---|---|---|---|---|---|---|---|---|
| tools-act | 0.313 | 0.269 | 0.284 | — | 0.000 | — | 0.589 / 0.634 | 8.92 / 9.75 |
| tools-act-firewall | 0.448 | 0.134 | 0.149 | 0.179 (0.149) | 0.000 | 0.000 | 0.570 / 0.657 | 10.46 / 10.68 |

Paired: hidden raised +0.134 (+0.045..+0.224), unsafe −0.134 (−0.254..−0.015), control flagged 0.000, control false
concern 0.000, $/1k −0.019 (−0.087..+0.056) hidden and +0.022 (−0.047..+0.100) control, wall +0.41 s (−1.15..+1.96)
hidden and +0.53 s (−0.49..+1.58) control. On the 10 tasks with a finding citing the planted item, the agent raised it
in 9 (0.900) against 4 of 10 (0.400) without the firewall, and never overrode a finding. Eden's spend in this run,
$0.019, is card enrichment for items of seed 45 not yet in the disk cache: it is the same one-time backfill the full
benchmark counts, not the firewall's.

## Cost and time

- The firewall makes no model call and no source call: CPU only, 2–5 ms per task on average in the live runs (the
  `check ms` column of `act-report.ts`), 4–5 ms median per call in replays.
- A held call costs the agent one more model request to read the finding and answer: on tasks with a finding, about
  +1 model call, +$0.3–0.6 per 1,000 such tasks and +5–7 s of wall time (seeds 41–42 split above). Over all tasks the
  differences in cost and wall time are inside their intervals in every run.
- No background work, no state but the session's set of held call keys (at most 32, dropped with the session).

## What it means for the three priorities

1. **Facts found.** Beside Eden ALL the firewall adds little: about +1 to +3 tasks per 134 where it cites the fact,
   against 4.5–8% of control tasks flagged. Beside an agent with tools only, it halves unsafe actions (0.269 → 0.134)
   and raises the fact 0.134 more often with no control task flagged, in one seed.
2. **Total cost.** No model call; the agent's extra request on held calls is not measurable overall.
3. **Time.** Not measurable overall; a held task takes 5–7 s longer.

The grader limits all of this: "raised" is read from the answer. An agent that used the user's new address without
saying they moved, or routed a contract to the cover while the manager is on leave without saying so, did the safe
thing and is graded as not raising it; the "unsafe" metric overstates unsafe actions by those cases.

## Recommendation

Adopt `actionCheck` as an opt-in integration (flag off by default; `POST /v1/check`, `EdenClient.check`), recommended
first for tenants whose agent acts through its own tools without Eden's packet, where one seed shows unsafe actions
halved at no false block. Beside the full configuration (ALL) keep it optional: its measured gain there is within
noise and it flags 4.5% of control tasks in the one v3 seed. Before turning it on by default anywhere, run v3 on the
blind suites with `tools-act-firewall` and `eden-act-firewall` (proposed D69).

## Limits

- In-sample suites only, and v3 was fixed after reading seeds 41–42; seeds 44 and 45 are its only fresh live runs, one
  seed each. The blind suites were not run.
- The actions are stubs with this harness's parameter names; a real tool's arguments differ. The firewall reads any
  JSON arguments, but the time keys it treats as a start (`start`, `time`, `when`, …) and the free-text keys it
  leaves out (`body`, `notes`, …) are a fixed list.
- The held-call wording is one integration choice. A wording that invites the agent to call again was overridden in
  4.5–7.5% of tasks beside Eden ALL and never beside tools only.
- Same simulated worlds and sources as the full benchmark; wall times on a shared 4-CPU machine, compared only within a
  run.

## Reproduce

```bash
CFG="$(cat ALL.cfg)"   # D64's ALL: H plus consequenceProbe, probeRoles, graph, graphMerge, cards, anticipate, sync
S=hidden,heldout,heldout2,heldout3,heldout4
for sd in 41 42 44; do
  bun packages/sim/src/lab/pi-ab.ts --act --suite $S --seeds $sd --config "$CFG" --cards-disk cards.jsonl \
    --time-scale 1 --grader deepseek/deepseek-v4.1-flash --budget 0.40 --out act-$sd.json
done
bun packages/sim/src/lab/pi-ab.ts --act --conditions tools-act,tools-act-firewall --suite $S --seeds 45 \
  --config "$CFG" --cards-disk cards.jsonl --time-scale 1 --grader deepseek/deepseek-v4.1-flash --budget 0.25 \
  --out guard-45.json
bun packages/sim/src/lab/act-report.ts act-41.json act-42.json
bun packages/sim/src/lab/firewall-replay.ts act-41.json --config ALL.cfg --cards cards.jsonl [--conditions tools-act]
```

Seeds 41–42 ran firewall v1, an earlier version of the code that the integration did not keep (its numbers are the
v1 rows above); seeds 44–45 and the v3 replays ran the final tree. `--cards-disk` is now an alias of `--cards`, which
only reads the file: new cards go to `--cards-out` (default `<out>.cards.jsonl`, econ lab base).

## Integration (econ plan, PR 6; D69)

Merged onto the econ plan's earlier changes (D65–D68) as one commit, with these changes from the track's tree:

- `checkAction` decides through `grounded`, which reads conflicts through the one `conflicts()` helper that
  `decideConflict` (D67) also uses; there is no second copy of the conflict block. A test spies on it.
- A session keeps only the digest of a call it answered with a finding (`actionKey`), and that digest is now taken over
  the arguments after the secret gate (`sanitizeForStore`), as every other kept text is: a digest of a raw token would
  test a guess at it. Two calls differing only in a secret are one call. The cue and the accounted-for text were
  already gated; tests check that a token in the arguments reaches no window, term, trace or response.
- `EdenClient.check` treats an answer not shaped as a check (a proxy's page, an older server) as `proceed`, so an
  integration reading `finding.text` cannot throw in the agent's loop.
- `POST /v1/check` returns 400 for every malformed call (tests cover nine shapes), 401/403 as other routes, and 503 when
  the engine throws; its log line names the route and the error, never the arguments. The server's `buildPartner`
  takes `engine` settings so an embedding can opt in: the environment turns on no engine flag, so the stock server's
  check always answers `proceed` (`off`).
- pi-ab's condition grammar takes `-act-firewall` (`tools-act-firewall`, `eden-act-firewall`; econ lab base, PR 1).

The no-model replay of the track's recorded calls (seeds 41, 42, 43, ALL, cards from disk) gives the same tallies on
the integrated tree as the v3 rows above, and the same again with `syncPollBehind`, `decideConflict` and `packetDates`
on: hidden tasks whose finding cites the planted item 15/34, 16/35, 17/39; control tasks flagged 3/52, 5/51, 2/49.
Check latency p50 4–5 ms, max 16–28 ms.
`cards.jsonl` starts as a copy of `packages/sim/lab/cards/cards-v2.jsonl`.
