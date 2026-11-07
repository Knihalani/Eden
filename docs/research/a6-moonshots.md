# A6: moonshots, from first principles

Status: 2026-11-07, branch `claude/a6-moonshots` (from `claude/lucid-hypatia-v9wqk5` at `c7cfc8fc9`), session A6 of
the afternoon audit (docs/research/audit-1107-plan.md). Decisions D286–D288. Every paid call went to the Anthropic API
with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, cards, intent), through the lab provider (D97),
`OPENROUTER_API_KEY` unset, on one ledger (`.local/a6/ledger.jsonl`) with a hard cap of $3: **Anthropic-direct lab
figures**. Train only (seeds 41–42): no held-out suite was run. **Spent: $2.171** (`packages/sim/lab/a6/spend.txt`). Numbers marked **[EST]** are arithmetic or judgement,
not measured; every other number comes from a command in this note.

## In plain words

- **Where Eden stands.** Since D237 Eden makes no model call per request and spends about 10 ms on the agent's path
  with payload notices; its background cards cost about $0.02 per 1,000 tasks. What a task costs is now almost all
  the agent: in a 72-task pilot (Pi, train seed 41) **75% of the agent's dollars were its own output tokens**, and
  60% of tasks made an `ask_context` call, those taking 3.9 s against 2.5 s for tasks that did not (unpaired). There
  is no 2x left in Eden's own cost or time; a 2x has to come from what the agent does (turns, words, misses) or from
  recall.
- **Built, measured, deleted: card tags on the push's candidates (trial `pushCandidateCards`, D286).** Each
  candidate the background card call read as a constraint was said with that reading first, in fixed words from the
  card's validated fields ("Eden's card: freeze on pay; until 2026-11-30 | …"): the paid reader's per-request bearing
  (D95, worth about 5 points, D237's −4.9) precomputed at ingest for $0 a request. Pooled over the short and long runs,
  **hidden facts +1.2 points (−4.8..+7.2), regraded concerns +0.0 (−1.2..+1.2), and dearer on both horizons** (+$0.036
  per 1,000 tasks on the short 1:1:8 mix, +0.016..+0.056; +$0.015 over a user's days, +0.005..+0.025, all-in as `arms.py` counts it; steady +0.011): not better on
  its axis, so deleted (D112). Only 37% of the planted facts that reach a packet carry a constraint card, which caps it.
- **Built and kept as a lab instrument: dressed worlds (`pi-ab --dress`, D287).** Requests often name someone the
  generated world holds no record of (by a broad count, 77% of train's nothing-to-add requests and 55% of hidden ones);
  dressing gives each person or firm so named one ordinary message (68 names on seed 41). Measured on the merged tree
  against the same tasks undressed, run side by side: **neither arm changes significantly** (Eden's agent: asks
  −0.07 a task, −0.17..+0.03; mix wall −0.07 s, −0.32..+0.16; the tools agent: wall −0.05 s, searches +0.06), and
  eden − tools on the mix is −1.44 s undressed against −1.46 s dressed. **The published comparisons are not an artefact
  of the missing records.** (A first, broader dresser, which also dressed ids, acronyms, places and holidays, read
  −0.16 asks; the review caught it, and it is superseded.)
- **Rejected on paper with $0 evidence (D288):** a per-user standing brief in the agent's cached prefix (the cards it
  would be built from cover 37% of the planted facts that reach a packet, and 29% of look-alikes), an entity census
  line (fires on 4 of the 6 hidden pilot tasks whose fact the agent's own ask found: D257's failure again), usage
  learning per item (relevance is per request; an item ignored on Monday is the fact on Thursday).
- **What is left for a 2x.** Not Eden's own spend or time. The agent's turns (Eden's agent still asks 0.92 times a
  nothing-to-add task with the named people and firms present: idea 2, answer-ahead, is the lever and is now measurable), its misses
  (pool misses are A2's; agent inattention to a candidate it was given is the rest), and event-driven speech after the
  agent acted (idea 5), which no suite measures yet.

## 1. Where the time and money go now

| What | Figure | Source |
| --- | --- | --- |
| Eden's model calls per task | 0 (push and ask) | D237 |
| Eden on the critical path | ~10 ms short, ~420 ms long (payload) | RealUse-3 (realuse-3/pi-heldout16.md) |
| Eden background (cards, intent) | ~$0.021/1k tasks; cold start $0.0065–0.0088 a user | RealUse-3, D244 |
| Agent output share of its dollars | 75.4% | pilot below |
| Tasks with an `ask_context` call | 43 of 72 (60%); wall mean 3.93 s vs 2.45 s without (unpaired) | pilot below |
| Asks per task (pilot) | hidden 0.54, control 1.00, neutral 1.08 | pilot below |
| Questions naming an entity the world lacks | neutral 15/26, control 13/24, hidden 7/13 (approximate: entity extraction) | `asks-absent.ts` |

Pilot (`pilot.txt`, `asks-absent-pilot.txt`): `packages/sim/lab/a6/run.sh a6-pilot-41 payload eden --seeds 41 --variants hidden,control,neutral --limit 4
--budget 0.1` ($0.0339, 72 tasks). The ask questions (timeline `eden.ask` points) read like a person's first lookups:
"Who is Ilse Marchetti? Find the current quote…", "Leon Ashby: email address…", "Is 16:00 free?". Only 51 of the 273
items the asks cited were already in the push's packet: the asks are not re-checks of the candidates.

Where hidden facts are lost (pilot, 24 hidden tasks, 18 raised): 4 misses had the planted item in no packet and no
answer (pool or ranking); 2 had it first in the candidates' packet and the agent wrote about other candidates instead
(`isa-allowance-used`: the answer lists a joint-account mandate, a mortgage note and a phishing warning, each another
template's planted item, and not the ISA allowance). Of the 18 raised, 2 came only from the agent's own ask.

## 2. The ideas, ranked

Ranked by expected payoff on their axis times the chance the lab can show it honestly.

| # | Idea | Axis | Payoff [EST] | Status |
| --- | --- | --- | --- | --- |
| 1 | Worlds that hold what their requests assume ("dressed" worlds) | measurement validity | measured: no significant change in either arm | **built (lab, D287)** |
| 2 | Answer-ahead: the push carries the records the agent would ask for first | latency, cost | −0.5 asks/task, −0.7 s/task, −10–15% agent $ | proposed; needs 1 |
| 3 | Precomputed bearings: card tags on candidates | hidden facts, false concerns | up to the reader's ~5 points | **built, measured, deleted (D286)** |
| 4 | Entity census ("no item names X") | latency | large in the lab, small in real use | rejected at $0 (D288) |
| 5 | Event-driven proactivity against a plan | hidden facts after the request | new capability | proposed; cheap test below |
| 6 | Standing brief in the agent's cached prefix | turns, packets | negative short, ≤ neutral long | rejected on paper (D288) |
| 7 | Usage-learned ranking (D18) | precision | small | rejected on paper (D288) |
| 8 | Entity/time graph retrieval | recall | the pool's misses | owned by A2; graph part deleted (D225–D229) |
| 9 | Card-derived fact lines instead of excerpts | bytes | small; facts lost | rejected (D258's evidence) |
| 10 | Eden replaces the agent's source tools | cost, latency | already measured | it is the `eden` arm |
| 11 | Agent-side caching of packets | cost | lab artefact on Pi (D260) | integration guidance |

### Idea 1: worlds that hold what their requests assume

- **Mechanism.** `worldOf` plants each template's item (or decoy) into a generated world, but the people, firms and
  things the request names often exist only in that planted item, or nowhere ("Pay Ethan Brooks's first invoice":
  no item names Ethan Brooks, even in the hidden world). The `neutral` variant removes the planted item, so 77% of its
  requests name something that does not exist. Dressing a world means adding, per request, the ordinary records a
  real user would have about what it names: a contact or signature line, a recent thread, an invoice, a calendar entry
  for the named day, none of them bearing on the request (written by a template author, checked by the same
  "no planted fact" rule the neutral variant uses).
- **Payoff (measured, §4).** A check on the benchmark rather than a gain. The expectation that the hunts dominate
  either arm's cost was wrong: with the people and firms present, neither arm's searches, asks or wall time moved
  significantly, and Eden's lead over the agent alone is the same.
- **Risks.** A dressing that echoes the planted fact's words turns a control into a hidden task; dressing must keep
  the decoy and hidden items the only constraint-worded items about the named entity.
- **Proof run.** `census.ts` counts absent names broadly (every capitalised run and id): 272, 267 and 421 of 626 in
  hidden, control and neutral undressed; 166, 171 and 283 dressed, the rest being places, acronyms, ids and lone
  words that dressing leaves alone by design. The Pi pair is §4.

### Idea 2: answer-ahead (the push carries the first lookups)

- **Mechanism.** The agent's first questions are predictable from the request's shape: who the named person is and
  how to reach them, the named thing's latest record, the named day's calendar. Eden already finds these items
  (grounding by people and days, D44, leads the pool); the push could add, beside the constraint candidates, the
  newest item per named entity and the named day's events, as one more framed block ("records about what the request
  names"). No model call.
- **Payoff [EST].** The pilot's asks add a model turn to 60% of tasks; if the push pre-answers half of them, −0.3
  asks/task, ~−0.5 s mean wall, and −$0.02–0.04/1k (an ask's turn costs its tool-call output and a re-read of the
  prefix, not the answer's bytes, D260).
- **Risks.** More bytes on every request (CL8: bytes are cheap, turns are not); the D257 trap (anything that makes the
  agent ask less loses the hidden facts the ask finds: 2 of 18 in the pilot came only from asks).
- **Cheap proof.** On dressed worlds (`--dress`, where Eden's agent still asks 0.83 times a control and 0.92 times a
  nothing-to-add task): at $0, the share of a run's ask citations already in the extended push (undressed pilot: 51
  of 273); live, asks a task and hidden facts on one paired short run (~$0.15 for two arms, one seed).

### Idea 3: precomputed bearings (card tags), built and measured

See §3.

### Idea 4: an entity census line — rejected at $0

- **Mechanism.** For a fully synced user, Eden can say exactly how many items name a request's person or firm. A line
  "no item in the connected sources names Ilse Marchetti" would end the hunt without an ask.
- **Why rejected.** It is D257's "nothing found" in a narrower form, and it fires where it hurts: of the 6 hidden
  pilot tasks whose ask cited the planted item (2 of them raised only through it), 4 name an entity no item of the
  hidden world names by that string (`Kwik Lane Garage` and `Golf`, `FreshCart`, `Priyanka Shah`, `Brightwater`;
  checked with `census.ts`'s entity logic), one of them an ask-only rescue (`mum-no-ibuprofen`): the line would tell
  the agent there is nothing about the request whose fact the ask then finds under other words. In the lab it would also fire on 77% of neutral requests, which is the benchmark's artefact (idea 1),
  not real traffic. A census is safe only as a positive count ("12 items name X; newest …"), which is idea 2.

### Idea 5: event-driven proactivity against a known plan

- **Mechanism.** Eden already sends an "updated:" packet when an item it handed out changes (D205). The general form:
  keep, per session, the requests the agent acted on (the request text, its pool's terms and named days), and when a
  new item arrives (sync, payload notice) run the request-time lookup for those requests against it alone; if it
  would have entered that request's candidates and is constraint-like (`readerGate`'s test), queue it as a "new since
  you acted:" packet. No model; bounded by the session's acting requests (a dozen) times new items.
- **Payoff [EST].** A capability the benchmark does not test: facts that arrive after the agent acted (a cancellation
  after a booking). Today such a fact reaches the agent only if a later request happens to retrieve it.
- **Risks.** Unasked packets late in a session (D3); a decoy arriving late is shown with no request to check it
  against.
- **Cheap test.** `pi-ab --day K` already moves planted items before the recap; a variant that plants a day's hidden
  fact after its request (and before the recap) measures recaps naming it, with and without the switch, on one
  seed (~$0.10).

### Idea 6: a standing brief in the agent's cached prefix — rejected on paper

- **Mechanism.** Maintain per user the active standing constraints (cards of a standing kind whose span covers the
  next days) and put them in the agent's system prompt, cached, so most requests need no packet.
- **Why rejected.** (a) Coverage: in the $0 screen below only 93 of the 253 planted facts that reach a candidates'
  packet carry a constraint card (37%), and 63 of 217 look-alike decoys do (29%): a brief built from cards misses
  most facts and carries the decoys with nothing to check them against. (b) Size: D241 counted 32–92 carded items per
  train world, 7,000–12,000 tokens rendered; one request at a time that is a cache write of the whole brief per
  session at 1.25x against today's ~400-token packet, **about 15x the packet's input dollars [EST]**; over a user's
  day it is read at 0.1x on every turn, still above the packets it replaces [EST]. (c) NEW2's standing block (D99)
  made the reader flag more look-alikes. A short brief (the top few by nearness) is idea 3's tags without the
  request: the fact the agent needs is the one about this request, which the push already finds 66% of the time.

### Idea 7: usage-learned ranking (D18) — rejected on paper

Learning per item from what the agent used assumes an item's usefulness is stable; in this domain it is per request
(the ISA allowance is noise for a rail booking and the whole answer for an ISA top-up), and in a user's days the
planted fact of Thursday is pushed as noise on Monday. Learning per kind (bulk mail, notifications) is what the
existing rules already do (bulk mail is never a candidate). Payoff small; the risk is losing the long-horizon facts.

### Ideas 8–11

- **Graph retrieval** (entities and time windows instead of lexical pools): the graph part was measured and deleted
  (D225–D229, fix-w2a-parts.md); 4 of the pilot's 6 misses are pool misses, which A2 owns this afternoon.
- **Fact lines from cards:** shorter excerpts lose the fact (D258: −12.8 points at 200 bytes; 70% of the fact's words
  kept at 200 bytes); a card line covers 37% of the planted items in packets. Idea 3 is the additive form.
- **Eden instead of the agent's tools:** this is the `eden` arm, measured on every run (RealUse-3: 79.7% vs 10.9%
  hidden facts, 2.0 s faster short).
- **Agent-side caching:** on Pi the Eden agent's short fixed prefix was not served from cache (D260); a real agent's
  prompt is far longer. Integration guidance (INTEGRATION.md): packets after the cached prefix, never inside it.

## 3. Built and measured: card tags on the candidates (D286, deleted)

**Mechanism (commit `7d254437`).** Trial switch `pushCandidateCards` (off): with `pushCandidates` and `cards`, each
candidate whose card (`CardEnricher.cardsOf`, already read by `candidatesOf` for `readerGate`'s test) has a constraint
kind is rendered `- [src] Eden's card: <kind> on <actions>; <start> to <end>; at most <unit><limit> | <title>: <excerpt>`,
built only from the card's validated fields (`cardTag`: the kind and action vocabularies, ISO dates, a unit in
`£$€%`; never the model's `statement` or `entities`), and `CANDIDATES_LEAD` gains one fixed sentence saying what the
tag is ("as read when the item arrived; it is not a check against this request"). `shownText` drops the tag; the
packet's byte cap grows by 110 bytes a candidate so a tag never cuts its excerpt. Seven tests (the tag's words, a
hostile card's fields dropped, off by default, isolation, the config check).

**$0 screen** (`bun run funnel … -- --neutral --packets`, train1–6 seeds 41–42, `tags.py`): the same items in every
packet (empty task diff, as designed); per candidates' packet, tags 1.75 (hidden), 1.62 (control), 0.92 (neutral);
bytes 1,509 → 1,761, 1,439 → 1,696, 1,084 → 1,282; **the planted fact tagged in 93 of the 253 hidden packets that
hold it (37%), the look-alike in 63 of 217 (29%).**

**Live** (Pi, `tools,eden,eden~cards`, payload notices, direct profile, time scale 1; short: `--variants
hidden,control,neutral --limit 12`, 144 tasks a kind and arm over seeds 41–42; long: `--days 8`, users 41–42, 232
tasks an arm; `short-pay-arms.txt`, `long-pay-arms.txt`, `long-pay-cost.txt`, `pooled.txt`, `concerns.txt`):

| | eden | eden~cards | paired (cards − eden) |
| --- | --- | --- | --- |
| Short: hidden raised | 72.2% | 72.9% | +0.7 points (−6.2..+7.6) |
| Short: mix $/1k (`arms.py` all-in) | 0.404 | 0.440 | **+0.036 (+0.016..+0.056)** |
| Short: mix wall mean | 3.15 s | 3.23 s | +0.09 s (−0.05..+0.23) |
| Short: asks a task (hidden / control / neutral) | 0.53 / 0.89 / 0.99 | 0.46 / 0.84 / 1.07 | |
| Long: hidden raised | 14/23 | 15/23 | +4.3 points (−13.0..+21.7) |
| Long: mix $/1k (`arms.py` all-in) | 0.332 | 0.346 | **+0.015 (+0.005..+0.025)**; `pi-cost-report` steady 0.332 → 0.343 |
| Pooled, 4 runs: hidden raised | | | +1.2 points (−4.8..+7.2), n 167 |
| Pooled: concerns on control + neutral, regraded | | | +0.0 points (−1.2..+1.2), n 497 |

Where the extra dollars went (`short-pay-cache.txt`): the tagged first prompt is about 80 tokens longer (hidden: 1,337
read + written against 1,256), carried into each later turn, and it was read from the cache less often (first-request
hit 14–24% against 35%: arms whose prompts match another arm's read them whole, D260's lab artefact, which here favours
`eden`). Output tokens did not change (hidden 472 vs 466 a task). **Verdict:** no gain on its axis within ±6 points,
dearer on both horizons: deleted with its code and tests (D112). The tag's ceiling is the card's coverage: 63% of the
planted facts in packets carry no constraint card under lean carding (D244), and the agent already reads the
excerpt.

## 4. Dressed worlds (D287, kept as a lab flag)

`worldOf(…, { dress: true })` (`dress-entities.ts`): for every person or firm a suite's requests name that no item of
the base world (before planting) names, one message from it ("Thanks for your message … You can reach <name> on 020
7946 0xxx or at this address"), 10–40 days old, with no constraint wording (`mayConstrain` false, tested on train2, 4
and 6, the last two with slots `clearSlot` empties), the same in every variant, appended after the planted items and
after `clearSlot`. `requestNames` keeps only the extractor's `name` entities, a leading imperative verb and a
possessive taken off, and of those two-word names that are not a place, season, event or product word, firm names
(a firm word last), and one-word names with an inner capital ("FreshCart"); ids, acronyms, places, holidays, products
and lone words are left out (tested). Telling a person from a firm by name failed on the suites' invented firms, so
one template serves both. 68 names on seed 41's six worlds. `pi-ab --dress` (short horizon only; refused with `--days`
and `--reuse-arms`; results carry `dress: true`).

**The review's catch.** The first dresser took every capitalised run and id: invoice ids (`CP-2210`, which then
headed a message repeating the request's strongest key), acronyms, places, holidays, a laptop that sent a "good to
catch up" note. Its run (`dress-pairs.txt`, before the A4 merge) read Eden's asks −0.16 a task (−0.26..−0.06) and wall
−0.18 s: an effect of the junk records, not of the missing ones. Superseded by the runs below.

Pi, `tools,eden`, on the merged tree (A4 in), payload notices, train seeds 41–42 (`--limit 12`, 144 tasks a kind),
undressed and dressed run side by side (`m-plain-arms.txt`, `m-dress-arms.txt`, `m-dress-pairs.txt`, paired by task):

| Mix 1:1:8 (dressed − undressed) | tools | eden |
| --- | --- | --- |
| Wall mean | −0.05 s (−0.34..+0.22) | −0.07 s (−0.32..+0.16) |
| $/1k (`arms.py` all-in per task) | +0.015 (−0.001..+0.030) | +0.010 (−0.010..+0.030) |
| Model turns | +0.00 (−0.08..+0.08) | −0.04 (−0.10..+0.03) |
| Searches (tools) / asks (eden) | +0.06 (−0.18..+0.29) | −0.07 (−0.17..+0.03) |
| Hidden raised (hidden tasks) | +2.8 points (−2.8..+8.3) | −3.5 points (−9.7..+2.8) |

Within each run, eden − tools on the mix: undressed hidden +6.5 points of mix (+5.6..+7.3), wall −1.44 s
(−1.77..−1.12), $/1k +0.015 (−0.008..+0.037); dressed +5.8 (+5.0..+6.7), −1.46 s (−1.79..−1.14), +0.011
(−0.010..+0.033). Regraded concerns (Haiku, `m-concerns.txt`): eden control 2 → 3, neutral 2 → 4 of 144; tools
control 0 → 1, neutral 0 → 2. Read by hand, the four dressed eden neutral concerns are generic hedges ("which Dana?",
"I couldn't confirm the migration is approved"); none cites a dressing message. **Reading:** missing records do not
drive either arm's cost or time in this lab, and Eden's measured lead does not depend on them. Kept as a lab flag (no
engine code) because idea 2 (answer-ahead) needs worlds where the first lookups can succeed.

## 5. Decisions

- **D286**: trial `pushCandidateCards` opened and closed the same day: measured not better (§3), deleted with its
  code and tests (code in `7d254437`).
- **D287**: lab only, `pi-ab --dress` (`dress-entities.ts`), kept: the absent-record artefact measured (§4) and not
  material; Eden's published lead over the agent alone stands; work on what the agent looks up first uses it.
- **D288**: not built, on $0 evidence: the entity census line (idea 4), the standing brief in the agent's prefix (idea
  6), usage-learned ranking per item (idea 7).

## Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a6/cards-all.jsonl
bun packages/sim/lab/a6/census.ts [--dress]                                   # absent names per kind, $0
R=packages/sim/lab/a6/run.sh
$R a6-pilot-41 payload eden --seeds 41 --variants hidden,control,neutral --limit 4 --budget 0.1
bun packages/sim/lab/a6/asks-absent.ts .local/a6/runs/a6-pilot-41.tl/tasks.jsonl
# Card tags (code in 7d254437):
bun run funnel --json .local/a6/f-base.json -- --neutral --packets .local/a6/f-base.packets.jsonl
bun run funnel --set '{"pushCandidateCards":true}' --baseline .local/a6/f-base.json --json .local/a6/f-cards.json \
  -- --neutral --packets .local/a6/f-cards.packets.jsonl
python3 -I packages/sim/lab/a6/tags.py .local/a6/f-base.packets.jsonl .local/a6/f-cards.packets.jsonl
export A6_VC='{"cards":{"pushCandidateCards":true}}'; A=tools,eden,eden~cards
$R a6-short-pay-41 payload $A --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.45   # and 42
$R a6-long-pay-41 payload $A --seeds 41 --days 8 --budget 0.3                  # 42: --budget 0.35
# Dressed worlds, on the merged tree, undressed and dressed side by side:
$R a6-m-plain-41 payload tools,eden --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.3    # and 42
$R a6-m-dress-41 payload tools,eden --seeds 41 --variants hidden,control,neutral --limit 12 --dress --budget 0.3
S=.local/a6/runs; O=packages/sim/lab/a6
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden~cards $S/a6-short-pay-4{1,2}   # long, dressed alike
bun packages/sim/src/lab/pi-cost-report.ts $S/a6-long-pay-4{1,2}.json
python3 -I packages/sim/lab/cl8/cache.py $S/a6-short-pay-4{1,2}
python3 -I packages/sim/lab/cl8/pooled.py eden~cards eden $S/a6-short-pay-4{1,2} $S/a6-long-pay-4{1,2}
python3 -I $O/dress-pairs.py eden $S/a6-m-plain-4{1,2} -- $S/a6-m-dress-4{1,2}       # and tools
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $S/a6-short-pay-41.json \
  --graders claude-haiku-5-5 --only-concerns --spend-ledger .local/a6/ledger.jsonl --spend-cap 3 \
  --spend-headroom 0.1 --run-label a6-regrade-short-pay-41 --out $S/regrade-short-pay-41.json   # each run
python3 -I packages/sim/lab/cl8/concerns.py $S/regrade-*.json
```

## Spend (`packages/sim/lab/a6/spend.txt`, ledger `.local/a6/ledger.jsonl`, cap $3)

| What | $ |
| --- | --- |
| pilot (eden, seed 41, 72 tasks) | 0.034 |
| card tags, short, three arms, seeds 41–42 | 0.626 |
| card tags, long, three arms, users 41–42 | 0.303 |
| dressed, first dresser (superseded), two arms, seeds 41–42 | 0.422 |
| undressed and dressed on the merged tree, two arms each, seeds 41–42 | 0.783 |
| concern regrades (Haiku) | 0.003 |
| **Total** | **2.171** |
