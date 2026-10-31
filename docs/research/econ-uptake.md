# Uptake: what the agent does with a delivered item (track uptake)

Status: 2026-10-31. **In-sample only** (dev and held-out 1–4, seeds 41–44). Held-out 5–9 were neither run nor read.
Every number comes from commands run in this session. Live spend: $0.893 of the track's $1.00 cap ($0.500 agent
runs with their grading, $0.394 regrading to measure the grader).

## As integrated (D68)

The track's flag was `packetVerdicts` (below). The econ synthesis kept only its dates and dropped its verdict tags, so
the engine has **`packetDates`** (off by default) and no `packetVerdicts`, `itemTag` or `verdictsOf`:

- compaction keeps the current year ("9 Oct 2026"), in proactive packets with `compactInjection`/`densePacket`;
- an event whose shown text never names its day starts with its `meta.start` ("Starts: Thu 29 Oct 2026 13:30. "), in
  proactive packets and `ask_context` answers;
- usage learning reads the packet without what the flag added (`withoutAddedDates`): "2026" is a long term with a
  digit, which alone counts as use, so with the year kept any reply naming the year would have marked the packet used
  and taught the source map so. The track's branch had that gap; a test reproduced it first.

Why the tags went: they measured neutral (0.91 against 0.91 on facts without a year), they could make a co-delivered
noise item look important, and their one planned second user, the oneturn "also found" section, was rejected by the econ
synthesis (its decision row comes with the oneturn notes). They were about 90 lines across `render.ts` and `partner.ts`, including a reordering of the ask
path; that is dead weight for no measured effect.

Re-measured at integration (this session, no model): the in-sample funnel (hidden and held-out 1–4, seeds 41–44, ALL
with cards-v2 replayed) delivers identically with `packetDates` on, task by task (218/268 hidden, 18/268 decoys; every
task's reasons and cited ids equal). 291 of 536 tasks' packet texts change; 14 gain a "Starts:". Packet bytes over the
268 hidden tasks 105,331 → 106,949 (+1.5%, about 6 bytes a task); over the 268 control tasks 41,560 → 42,483. The
track's +10% bytes were mostly its tags. The live A/B below measured tags and dates together; its gain sat entirely on
year-bearing facts and the calendar hold, which is what `packetDates` keeps. The blind effect is unmeasured.

## The question

In the full Pi benchmark (D64), when Eden (ALL) proactively delivered the planted item, the agent raised it 0.851 of
the time. The track's target was 0.95 or more, from the packet's form alone, with no rise in false concerns or tokens.

## What the 29 in-sample misses were

In-sample, ALL delivered the planted item in 218 of 268 hidden tasks and the agent was graded as raising it in 189
(0.867). I read all 29 delivered-but-not-raised answers beside the packets Eden sent. To get the packets I replayed the
same configuration through the no-model funnel (`hidden-funnel.ts --packets`, new; it delivers the same 218), and
asked the grader (deepseek-v4.1-flash, same prompt) to explain each verdict.

| Why | n | Examples |
|---|---|---|
| The grader wanted a detail the answer left out; the matter was raised correctly | 22 | "left on 9 Oct" without "2026" (6); "on leave" without "parental"; Tamsin without "Head of Procurement"; the 8% cap without "after Friday's pricing review"; the school without its name |
| The answer read a detail differently | 2 | "the 3pm call is today" (Mateo wrote "tomorrow" the day before); a flight's arrival 10:35 given instead of its departure 07:10 |
| Not raised | 4 | passport expiry (second item, after a weak one); a calendar hold whose text never said its day; a card's 10% CFO policy; the threshold policy (never reached the live agent) |
| Empty answer (the agent failed) | 1 | |

None was buried, looked like noise, or followed an `ask_context` that distracted the agent. A lenient second grading
asked whether the answer raised the core of the fact (the same matter, what it changes), ignoring omitted secondary
details and failing contradicted ones. It agreed with the strict grade on every raised answer and on every task where
nothing was delivered (0.42 both). By it, **uptake was already 0.982 (214/218)**. Over the 533 hidden answers of the
A/B below it never marked false what the strict majority marked true.

So the agent almost always uses what Eden delivers. The benchmark's 0.85 is mostly the strict grader asking for every
specific detail of the fact. Packet form can change only one thing there: whether the details are in front of the
agent, written as the fact states them.

One cause of that was Eden's own. With `compactInjection`, compaction drops the current year from dates ("left
Vandelay Industries effective 9 Oct 2026" becomes "… effective 9 Oct", `render.ts`). Six of the 22 misses were the
missing "2026", and the passport miss read "expires 2 Nov" against a trip on 21 Nov. The calendar hold was a second
gap: its time was only in `meta.start`, so the packet never said when it was.

## The form: `packetVerdicts` (off by default)

Data only; nothing in the packet asks the agent to do anything.

- **Verdict in the item's tag:** what Eden's no-model checks found the item to be to the request, inside its source tag:
  - `[calendar · overlaps the requested time]`
  - `[crm · conflicts with the request]`
  - `[slack · away on the requested day]`

  The verdict is the path that delivered the item: a clash, a conflict (`conflict.ts`, the graph's or a card's), or an
  absence. On any other path (the confident path, the fallback, an ask's answer), it is `conflict.ts`'s verdict on an
  item about the request, beyond a name. Tagged items go first. `shownText` drops the tag with the source, so usage
  tracking is unchanged. `itemTag(item, verdict)` is exported so every section that lists items labels them the same
  way.
- **Years kept:** compaction keeps the current year ("9 Oct 2026").
- **Start from metadata:** an event whose shown text never names its day starts with its `meta.start` ("Starts: Thu
  29 Oct 2026 13:30."), read from the timestamp as written.
- The same tags and starts apply to `ask_context`'s answers, which already kept years.

No model call, no new state (verdicts are computed at render time from the session's own items), no change to what is
delivered. The funnel's deliveries are identical with the flag on (218/268 hidden, 18/268 decoys, all 536 tasks the
same). Of the 218 delivered planted items, 202 carry a verdict tag; none of the 18 delivered decoys does. Packet bytes
grow by 10% (+40 bytes, about 10 tokens, per hidden task; 105,331 → 115,911 bytes over 268 tasks). With every flag
off, `bun run eval` equals main's except latency (checked: JSON identical with latency fields removed).

### Coordination with the oneturn track's "also found"

The "also found" section (`renderAlso` on that branch) lists held-back candidates under a section label. With both
flags on, its item lines should use `itemTag(item, verdict)` with the same `verdictsOf` map, so that "conflicts with the
request" means the same thing in both sections and the section label stays the only statement of certainty. It is not
wired here because `renderAlso` is not on this branch. The synthesis should pass `verdicts` to it when it merges both.

## Live A/B

Pi harness, `z-ai/glm-5.3-flash`, grader deepseek-v4.1-flash, `--time-scale 1`, ALL configuration with card replay
(`--cards-file`, new: cards from the checked-in cache, the rest made live). One seed per process. The conditions `eden`
and `eden+packetVerdicts` (new: a condition may add engine flags) ran concurrently in each process on the same tasks.
In-sample suites, seeds 41–44: 265 hidden and 262 control pairs. Paired bootstrap, 95% intervals.

| | eden (ALL) | eden+packetVerdicts | paired difference |
|---|---|---|---|
| Uptake, as pi-ab graded (n=214 delivered in both) | 0.874 | 0.902 | +0.028 (−0.023..+0.084) |
| Uptake, strict majority of 3 gradings | 0.879 | 0.916 | +0.037 (−0.009..+0.089) |
| Uptake, lenient (core raised) | 0.991 | 0.991 | +0.000 (−0.014..+0.014) |
| Hidden raised, strict majority of 3 | 0.785 | 0.823 | +0.038 (−0.011..+0.083) |
| False concerns (control) | 0.038 | 0.031 | −0.008 (−0.031..+0.015) |
| Agent input tokens | 2,430 | 2,417 | −13 (−136..+106) |
| Agent output tokens | 1,681 | 1,696 | +15 (−43..+75) |
| Model calls | 2.06 | 2.03 | −0.03 (−0.07..+0.02) |
| $ / 1k tasks (agent + Eden) | 0.278 | 0.283 | +0.005 (−0.010..+0.019) |
| Wall p50 (shared, noisy machine) | 14.67 s | 14.20 s | −0.09 s (−0.64..+0.46) |

The strict grader agreed with itself on 0.959 of the hidden answers when regraded. Taking the majority of three
gradings removes part of that noise, and the strict majority is the fairer strict number.

Where the gain comes from (strict majority, delivered in both arms):

| Planted fact | n | eden | +packetVerdicts |
|---|---|---|---|
| states a year ("9 Oct 2026") | 25 | 0.64 | 0.96 |
| does not | 189 | 0.91 | 0.91 |

Of the 19 tasks the flag turned to raised, 8 have a year in the fact and 2 are the calendar hold ("Starts:"). None of
the 11 it turned the other way has a year; those are the grader's and the agent's run-to-run noise. **The verdict tags
themselves show no measurable effect on uptake:** facts without a year are 0.91 in both arms. They also do no measurable
harm to false concerns or tokens.

## Conclusions

1. **The agent already uses what Eden delivers.** By a grader that asks whether the matter was raised, uptake is
   0.98–0.99. The remaining strict-grader gap is the agent paraphrasing away secondary details: a title, the reason for
   leave, the pricing review's day. Packet form cannot close that without telling the agent what to write, which the
   rules forbid. **95% strict uptake is not reachable from form alone on this grader.**
2. **Eden should not strip what the fact states.** Keeping the year (and an event's start when the text lacks it)
   raises strict uptake from 0.64 to 0.96 on year-bearing facts, at about 10 packet tokens a task. It is also simply
   more precise: "expires 2 Nov" is ambiguous where "expires 2 Nov 2026" is not.
3. **Verdict tags are neutral here.** They cost about 30 bytes per tagged item. They are kept in the flag because they
   are the shared vocabulary for the oneturn "also found" section, and because an agent with a weaker prior than this
   one may use them. They should be dropped if a larger run shows no effect.
4. The measurement matters more than the form. Every live result in this repo is graded by one strict, self-noisy
   grader (0.959 self-agreement). Uptake differences of a few points are within its noise unless graded by majority.

## Decision

The track proposed `packetVerdicts` (tags, years and starts) as its own D65 row. It was integrated as D68:
`packetDates` alone, the tags dropped (see "As integrated" above).

## Commands

```bash
# Packets as the agent reads them (no model); the integration's re-run adds "packetDates":true to ALL.cfg for the flag:
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds 41,42,43,44 \
  --config "$(cat ALL.cfg)" --cards packages/sim/lab/cards/cards-v2.jsonl --no-record --json f.json \
  --packets packets.jsonl
# Live A/B as the track ran it, one seed per process (41, 42, 43, 44), $0.12–0.13 each. Its flag and `--cards-file`
# are gone: today the condition is eden+packetDates and the replay flag `--cards`.
bun packages/sim/src/lab/pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds 41 \
  --variants hidden,control --conditions eden,eden+packetVerdicts --config "$(cat ALL.cfg)" --time-scale 1 \
  --grader deepseek/deepseek-v4.1-flash --budget 0.2 --cards-file cards-v2.jsonl --out pi-v1-41.json
bun run eval   # flags off: equal to main's except latency
```

The regrading scripts (strict ×2 and lenient over the 533 hidden answers; the grader's explanations of the 29 misses)
and their outputs are in the session scratchpad under `uptake/`. The lenient prompt is quoted in `lenient.ts` there.
