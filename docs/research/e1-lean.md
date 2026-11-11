# E1: a leaner packet with no model

Status: 2026-11-11, branch `claude/e1-lean` (from main), session E1, decisions D1030–D1032. **Both parts built failed
their pre-registered rule and are deleted; the engine is unchanged. The lab keeps `days-calls --packets`.** Paid calls
went to Anthropic directly through the lab (D97, `HAIKU_API_KEY`): **Anthropic-direct lab figures**. Every number
here comes from a command run in this session unless marked **[EST]**.

## 0. The question

P2 estimated Eden's packets at about a third of a Haiku agent's prompt tokens over a day; M6 found a typical packet
about 1,011 B, 282 B of it fixed envelope and lead. A learned trimmer did not transfer (D920). E1 tried four no-model
levers: a lean envelope, no repetition across a day, a compact item rendering, and prompt-cache-friendly ordering.
The untrusted-content fence, item ids and redaction were left untouched.

## 1. Where the bytes are (at $0)

`days-calls.ts --packets F` (new, D1030) writes every packet and ask answer a `--days` user was handed, one line a
request, with the ids each cites. Users 41–44, 8 days, `--ask` (an ask every request), cards and intent replayed, no
checker and no reader (the push check is inert without a model, so packets carry more items than live):

| | per request | fixed | items |
| --- | --- | --- | --- |
| candidates and other packets | 1,170 B | 397 B | 773 B |
| ask answers | 509 B | 77 B | 432 B |
| all | 1,679 B | 475 B (28%) | 1,204 B |

Per packet (asks apart): 921 B, 313 B fixed, 609 B items (3.4 items of 186 B). The lead is the single largest fixed
piece: 144 KB of the 806 KB the four users were handed, 18%. The header is 66 B on every packet and answer (9%).

**Repetition across a day is already handled.** Matched by item id within a day, an item first handed in a packet is
handed again almost only by an ask answer: 1,270 times as its title with "(shown above)" (47 B a line) and 427 times as
the parts it had not shown (`askDedup`, 112 B a line). Packets repeat an earlier packet's item 17 times in 4 users'
32 days, and the "updated:" packets that do (45) are the changed copies D205 sends on purpose. The not-twice ledger
(D13) and `askDedup` leave no repeated item text to cut; pointers to earlier items were tried twice and failed (D711,
D832). Each day is a new session and a new transcript (D343), so an item handed on an earlier day is not held.

**Prompt-cache ordering has nothing to move.** Under the shipped kept layout (D336) a packet enters the transcript
once: it is written to the agent's cache with the request it arrives in (1.25x) and read on later model calls (0.1x).
It is always in the request's uncached tail, after the last breakpoint, so the order of its bytes changes neither
what is written nor what is read. No lever was built.

## 2. The two parts built

- **`leadOnce`** (trial, D1031): the session's first candidates packet handed out says `CANDIDATES_LEAD` whole; later
  ones say "Eden: more unchecked candidates; the same check as above." (54 B for 252 B). `ASK_NUDGE` was never
  shortened: P5's shorter lead and nudge lost hidden facts through fewer asks (D859). The mark was set at hand-out
  (a packet withdrawn untaken showed the agent nothing), per session.
- **`leanItems`** (trial, D1032): with `densePacket`, compaction also dropped a lone sign-off name that is the sender's,
  disclaimers and regulatory footers at a part's start or run into it, notification footers ("Reply to this email
  directly", "To change which emails you receive"), more courtesies ("Happy to jump on a call if easier"), and said
  "From: Ana Date: Mon 2 Nov 09:00" as "From: Ana, Mon 2 Nov 09:00", that last after `pick` so the kept parts did not
  change. A first version merged the two header parts before `pick`, which changed what `pick` kept (8 planted lines
  lost their date): caught by diffing planted lines and moved after the pick. A unit test caught "registered office" at
  a sentence's start cutting a fact; the patterns were tightened to footer shapes only.

At $0: funnel train seeds 41–42 with neutral, 281/384 hidden and 264/384 decoys in every arm (main's numbers). Of 508
planted lines `leanItems` changed 328; 13 lost a word, every one boilerplate (the courtesy 9 times, a disclaimer, a
signature). M3r's 52 short constraints and M7's 21 fixture items, each wrapped in four styles of boilerplate, kept every
word of their plain line (`lean-fixtures.test.ts`, in commit b3cc3f12). Over days:

| arm | bytes a packet | fixed | items | a request with asks |
| --- | --- | --- | --- | --- |
| main | 921 | 313 | 609 | 1,679 |
| `leadOnce` | 774 (−16%) | 166 | 609 | 1,492 (−11%) |
| both | 757 (−18%) | 166 | 591 (−3%) | 1,471 (−12%) |
| `leanItems` | | | (−3.4% item bytes) | 1,628 (−3%) |

So the −30% byte bar could not be met by these levers before any paid call; the parent was told and asked for the
Pi pair to decide the parts on quality (a part that holds quality and saves tokens is promoted under D112).

## 3. The bar (pre-registered in commit b3cc3f12, before any paid call)

Arms `eden` (main) against `eden~L` (both parts) one request a session (train seeds 41–44 hidden, control and neutral;
train5r, train6r and longtail hidden and control), and `eden`, `eden~O` (`leadOnce`) and `eden~L` on `pi-ab --days 8`,
users 105–112; Haiku 5.5 agent and grader, Sonnet 5.5 regrade, the bench recipe (`--tenant-prompt`, payload
notices). A part is promoted only if the funnel and eval are unchanged; hidden raised (Sonnet) has its clustered lower
bound above −1.5 points against main, short and over days, and train5–6, 5r–6r and longtail each are not below −1.5
points; Sonnet-confirmed concerns are not up; prompt tokens a task −10% and packet bytes −30% are reported (a part
missing only those is decided under D112). One extension, pre-registered in commit 9ba0cc2d after the first days run
and before its call: users 113–120, `eden` against `eden~O`, pooled with 105–112.

## 4. Results

**One request a session** (`bench_report.py --pair eden~L:eden --sonnet`; `leadOnce` is inert here, so this is
`leanItems`). The shards hit their caps: 687 of 4,608 runs were refused near each shard's end (265 tasks in both arms,
157 in one); the report pairs the tasks both arms finished.

| | `eden~L` − `eden` |
| --- | --- |
| hidden raised, train 41–44 | +0.9 points (−2.4..+4.1, clustered by template; 648 pairs); 71.3% against 70.4% |
| false concerns, control and neutral | +0.0 (0 against 0) |
| $ a 1,000 tasks (agent and Eden) | +0.001 (−0.005..+0.007) |
| `ask_context` a task | +0.028 (−0.008..+0.063) |
| hidden, train5r, train6r, longtail | +0.3 points (−3.1..+3.7; 352 pairs) |
| confirmed concerns there | 3 against 0 (+0.9 points, +0.0..+2.3) |

By family (paired tasks, Sonnet): train5 +3.8, train6 −0.9, train5r −2.3, train6r +3.1, longtail 0.0. The three
new concerns on the reworded and long-tail suites came with packets byte-identical in both arms (two
`lt-self-assessment-agent-files` controls) or no packet at all (`support-cover-clash`): the agent's own variance, not
the rules. **`leanItems` fails** (lower bound −2.4; train5r −2.3) and is deleted (commit 9ba0cc2d).

**Over days** (`n5/days_hidden.py`, whole users resampled; Sonnet):

| | users 105–112 | users 113–120 | pooled, 16 users |
| --- | --- | --- | --- |
| `leadOnce` hidden | +1.9 (−3.1..+6.8; 57.3 vs 55.3%) | −7.5 (−16.4..+1.0) | **−2.9 (−8.8..+2.8)** |
| both, hidden | +3.9 (+1.0..+6.8) | | |
| confirmed concerns (main / `leadOnce` / both) | 3 / 1 / 2 | 1 / 0 | |

Live packets over days (pi-ab timelines): main 516 B a packet (206 fixed, 310 items), `leadOnce` 451 B (141, 310),
both 442 B (141, 301): −13% to −14% a packet, −32% of the fixed text. The day's re-read packet characters fell 3,806 →
3,385 a task; **agent prompt tokens a task −93 (−350..+187) pooled, about −1.7%** (`p2/packet_reread.py`), far
from −10%: with the push check in the default a day's packets are about 360–410 characters a task in a ~5,500-token
prompt. Agent and Eden $ per 1,000 tasks on the 1:1:8 mix: 0.426 → 0.422 (105–112), 0.422 → 0.420 (113–120).

**`leadOnce` fails** its extension's rule (pooled lower bound −8.8) and is deleted with its constant and test. Two
readings of the same switch on 8 users each disagreed by 9 points: a days run on 8 users cannot see a 1.5-point
change, and the fresh users' −7.5 is no reason to keep the short line.

## 5. What it leaves

- Eden's packet bill over days is now mostly items, and the items are what recall costs (D258, D273, D920). With the
  push check in the default, the day's packets an agent re-reads are about 950 of its 5,600 prompt tokens a task
  (17%; `packet_reread.py`, 4 characters a token **[EST]**), not a third; cutting a third of the fixed text took
  about 105 of them, and −93 was measured.
- The fixed text is the lever that remains. It is wording the agent's behaviour rests on (D237's check, D317's
  nudge, D859): any change to it needs a powered run (16 users was not enough to see −1.5 points).
- **Not built:** a shorter header (66 B on every packet and answer; it is the fence, left as it is), and a one-line
  form of ask answers' "(shown above)" titles (about 3% of a day's bytes with an ask on every request; asks are about
  0.4–0.7 a task live).

## 6. Spend and reproduce

Anthropic **$7.27** of the $8 Pi cap (Modal runs $5.81: days $1.70, short $2.15, reworded and longtail $0.77,
extension $1.19; Sonnet regrades $1.46 by Message Batches). No OpenRouter call. Modal compute not counted.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/days-calls.ts --seeds 41,42,43,44 --days 8 --ask \
  --cards .local/cards-all.jsonl --packets .local/e1/days-base.jsonl          # $0; add --set '{…}' for an arm
V='{"L":{"leadOnce":true,"leanItems":true},"O":{"leadOnce":true}}'           # switches as of commit b3cc3f12
modal run packages/sim/modal/lab_fanout.py --preset bench-tools --seeds 41,42,43,44 --cap 2.4 --run e1-short \
  --args "--conditions eden,eden~L --variant-config '$V' --variants hidden,control,neutral"
modal run packages/sim/modal/lab_fanout.py --preset bench-tools --suites train5r,train6r,longtail \
  --seeds 41,42,43,44 --cap 1.2 --run e1-rw --args "--conditions eden,eden~L --variant-config '$V'"
modal run packages/sim/modal/lab_fanout.py --preset bench-tools --seeds 105,…,112 --cap 2.0 --run e1-days \
  --args "--conditions eden,eden~O,eden~L --variant-config '$V' --days 8"     # and 113,…,120 with eden,eden~O
bun packages/sim/src/lab/i3-regrade.ts --results … --spend-ledger .local/e1/ledger.jsonl --spend-cap 2.2
python3 -I packages/sim/modal/bench_report.py --pair 'eden~L:eden' --group short=.local/modal/e1-short --sonnet
python3 -I packages/sim/lab/n5/days_hidden.py --base eden --arms 'eden~O,eden~L' .local/modal/e1-days/s*/
python3 -I packages/sim/lab/p2/packet_reread.py --base eden .local/modal/e1-days*/s*/out.json
```

The short run's caps were too tight for the default with the push check ($0.54 a shard spent of $0.60): size a train
shard of two arms with neutral at about $0.75.
