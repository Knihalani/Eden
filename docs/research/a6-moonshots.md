# A6: moonshots, from first principles

Status: 2026-11-07, branch `claude/a6-moonshots` (from `claude/lucid-hypatia-v9wqk5` at `c7cfc8fc9`), session A6 of
the afternoon audit (docs/research/audit-1107-plan.md). Decisions D286–D287. Every paid call went to the Anthropic API
with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, cards, intent), through the lab provider (D97),
`OPENROUTER_API_KEY` unset, on one ledger (`.local/a6/ledger.jsonl`) with a hard cap of $3: **Anthropic-direct lab
figures**. Train only (seeds 41–42): no held-out suite was run. Numbers marked **[EST]** are arithmetic or judgement,
not measured; every other number comes from a command in this note.

## In plain words

- **Where Eden stands.** Since D237 Eden makes no model call per request and spends about 10 ms on the agent's path
  with payload notices; its background cards cost about $0.02 per 1,000 tasks. What a task costs is now almost all
  the agent: in a 72-task pilot (Pi, train seed 41) **75% of the agent's dollars were its own output tokens**, and
  60% of tasks made an `ask_context` call, those taking 3.9 s against 2.5 s for tasks that did not (unpaired). There
  is no 2x left in Eden's own cost or time; a 2x has to come from what the agent does (turns, words, misses) or from
  recall.
- **The biggest finding is about the benchmark, not the engine.** Most of the agent's questions are hunts for people
  and things the simulated user's sources do not hold: in the train worlds, **77% of nothing-to-add requests (295
  of 384) and 55% of hidden ones (211 of 384) name an entity no item of the world names**, and in the pilot **55% of
  `ask_context` questions (35 of 63) named one**. Real users ask about people they correspond with. The lab's cost and
  latency figures on the 1:1:8 mix, for both arms, are dominated by searches that cannot succeed; a lever that saves
  them (an "entity census", idea 4) would look like a large win here and be small in real use. The first moonshot is
  to give the worlds the records their requests assume (idea 1), before tuning anything on asks or turns.
- **Built and measured: card tags on the push's candidates (`pushCandidateCards`, D286).** Each candidate that the
  background card call read as a constraint is said with that reading first, in fixed words from the card's validated
  fields ("Eden's card: freeze on pay; until 2026-11-30 | …"): the paid reader's per-request bearing (D95), which was
  worth about 5 points of hidden facts (D237's −4.9), precomputed at ingest for $0 per request. Result: see
  [§3](#3-built-and-measured-card-tags-on-the-candidates-d286); outcome D287.
- **Rejected on paper with $0 evidence:** a per-user standing brief in the agent's cached prefix (the cards it would be
  built from cover 37% of the planted facts that reach a packet, and as many look-alikes), an entity census line
  (fires on 4 of the 6 hidden pilot tasks whose fact the agent's own ask found: D257's failure again), usage
  learning per item (relevance is per request; an item ignored on Monday is the fact on Thursday).

## 1. Where the time and money go now

| What | Figure | Source |
| --- | --- | --- |
| Eden's model calls per task | 0 (push and ask) | D237 |
| Eden on the critical path | ~10 ms short, ~420 ms long (payload) | RealUse-3 (realuse-3/pi-heldout16.md) |
| Eden background (cards, intent) | ~$0.021/1k tasks; cold start $0.0065–0.0088 a user | RealUse-3, D244 |
| Agent output share of its dollars | 75.4% | pilot below |
| Tasks with an `ask_context` call | 43 of 72 (60%); wall mean 3.93 s vs 2.45 s without (unpaired) | pilot below |
| Asks per task (pilot) | hidden 0.54, control 1.00, neutral 1.08 | pilot below |
| Questions naming an entity the world lacks | neutral 15/26, control 13/24, hidden 7/13 | `asks-absent.ts` |

Pilot: `packages/sim/lab/a6/run.sh a6-pilot-41 payload eden --seeds 41 --variants hidden,control,neutral --limit 4
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
| 1 | Worlds that hold what their requests assume ("dressed" worlds) | measurement validity | changes every cost/latency comparison on the mix | proposed (lab) |
| 2 | Answer-ahead: the push carries the records the agent would ask for first | latency, cost | −0.5 asks/task, −0.7 s/task, −10–15% agent $ | proposed; needs 1 |
| 3 | Precomputed bearings: card tags on candidates | hidden facts, false concerns | up to the reader's ~5 points | **built, measured (D286, D287)** |
| 4 | Entity census ("no item names X") | latency | large in the lab, small in real use | rejected at $0 |
| 5 | Event-driven proactivity against a plan | hidden facts after the request | new capability | proposed; cheap test below |
| 6 | Standing brief in the agent's cached prefix | turns, packets | negative short, ≤ neutral long | rejected on paper |
| 7 | Usage-learned ranking (D18) | precision | small | rejected on paper |
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
- **Payoff [EST].** Not a gain for Eden but a truer price for both arms: the tools agent searches 2–3 times for things
  it cannot find, Eden's agent asks about them, and both write longer, hedged answers. Today's "Eden is level or
  cheaper than the agent alone" (RealUse-3) rests on that traffic. Dressed worlds also let idea 2 be measured at all.
- **Risks.** A dressing that echoes the planted fact's words turns a control into a hidden task; dressing must keep
  the decoy and hidden items the only constraint-worded items about the named entity.
- **Cheap proof.** `census.ts` ($0) counts the requests naming an absent entity; after dressing it must read ~0. One
  short Pi pair (tools vs eden, one seed, ~$0.25) on dressed vs undressed train shows how much of the 1:1:8 mix's cost
  and wall the hunts were.

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
- **Cheap proof.** Only on dressed worlds (idea 1): at $0, the share of a pilot's ask citations already in the
  extended push (today 51 of 273); live, asks per task and hidden facts on one paired short run.

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

## 3. Built and measured: card tags on the candidates (D286)

(filled in below)
