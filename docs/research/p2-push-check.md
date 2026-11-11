# P2: the push check's cost, indirect requests, and the agent's packet bill

Status: 2026-11-11, branch `claude/p2-push-check` (from `claude/lucid-hypatia-v9wqk5` at d5d504f0: main #244 plus
docs/research/weak-points-1111.md). Session P2, weak points Q4/1, Q6/3 and C1/5 of that report. Decisions D820–D829.
Train suites only (there is no unread blind suite, D802). Every paid call goes to Anthropic directly with
`HAIKU_API_KEY` through the lab (D97): **Anthropic-direct lab figures**. Caps: Anthropic $30, Modal $40. Numbers
marked **[EST]** are arithmetic or judgement; every other number comes from a command in this note.

## 1. Weak point 3 (Q6): requests phrased indirectly start no push ($0)

### 1.1 A reworded train (`train-rw`, lab only)

`packages/sim/src/lab/reword.ts`: each train template's request reworded into one of ten indirect forms, chosen by a
hash of the template's name ("I need to …", "Should I …?", "We should …", "I want you to …", "I'd like to …",
"Let's …", "Can I …?", "I have to …", "Is it OK to …?", "We need to …"). The world, the planted item, the decoy and
every draw are the original's; only the request's words change, so cards and intent requests replay
(`INTENT_COVERS` names `train1rw`–`train6rw` for seeds 41–44) and each task pairs with its original
(`packages/sim/lab/p2/compare_rw.py`). 189 of 192 requests are reworded; three do not open with their verb ("When
you do Mum's order …", "Dan's last day was Friday, please remove …", "I can't make …") and stay as written.

### 1.2 The miss today, and the trial `pushIndirect` (D820)

The gate today (`isImperative` or `pushOpen`'s `isOpenRequest`), counted on seed 41's 192 requests:

| Requests | Start a push today | With `pushIndirect` |
| --- | --- | --- |
| train, as written | 190 of 192 (159 listed verb, 31 open shape) | 190 (the same) |
| train-rw | **33 of 192** (only "I'd like to", "Let's": their apostrophe stripped, they read as a verb) | **190** (159 listed, 31 open) |

`pushIndirect` (probes.ts `indirectRest`, `pushStart`): a lead-in (a need, an obligation, a plan, a wish, a question
about acting, a request to the assistant) is read as the imperative after it, and the push's lookup is given that
imperative; a lead-in followed by a verb that thinks, says or waits ("I need to think …", "Let's see how …") starts
nothing. The open shape runs strict: it refuses pasted log lines (a level word in capitals, a timestamp, an address,
a traceback, a file:line, "N failed, M passed", or a third of the words symbols and numbers) and chatter openers
("haha", "ugh", "morning!", "lmaooo", "jajaja").

**Funnel** (`bun run funnel --suite S --seeds 41,42,43,44 --jobs 4 [--set '{"pushIndirect":true}'] -- --neutral`;
`compare_rw.py`; 768 tasks a variant; run before main's merge at aecd952b. The final review re-ran it at HEAD:
every "handed" figure the same, "surfaced" one lower in each row (634 / 553, 609 / 540, 629 / 555), D842's calendar
change):

| Arm | Hidden surfaced | Decoys surfaced | Planted handed in the push | Decoy handed | Neutral given a packet |
| --- | --- | --- | --- | --- | --- |
| train, default | 635 | 554 | 582 | 502 | 738 |
| train, `pushIndirect` | 635 | 554 | 582 (+0 −0) | 502 | 738 |
| train-rw, default | 610 | 540 | **97** (+1 −486) | 80 | 132 |
| train-rw, `pushIndirect` | 630 | 556 | **580** (+0 −2) | 503 | 738 |

The funnel always asks, so "surfaced" barely moves (610 against 635); the push is what the agent gets without asking,
and on reworded requests it hands the planted fact 97 times instead of 582. On the original wording the trial changes
no task.

### 1.3 Two blind sets (written by a Haiku subagent that saw no code and no rule)

The rule was fitted on my own negatives (`gate-negatives.ts`: 36 log lines, chatter, statements and questions) and on
train-rw, so it was scored on sets written blind. Each set was scored once, with the rule frozen in a commit first
(v1 at 0a45a2b1, v2 at 2d438b62). Set 1 then served to revise the rule (v2), so only set 2 is a clean score of v2.
The rule after review (1927cc19) reads set 2 as logs 4 of 30 and statements 13 of 40 (§3.3), post hoc.

| Messages | Start a push today | v1 (set 1) | v2 (set 2, clean) |
| --- | --- | --- | --- |
| Indirect acting requests | set 1: 43 of 100; set 2: 56 of 120 | 73 of 100 | **76 of 120** |
| Log lines | 24 of 25; 29 of 30 | 6 of 25 | **3 of 30** |
| Chatter | 11 of 30; 15 of 40 | 6 of 30 | **6 of 40** |
| Statements (incl. "I need to sleep more") | 1 of 25; 4 of 40 | 6 of 25 | **14 of 40** |
| Questions for information | 0 of 25; 0 of 30 | 0 of 25 | **0 of 30** |
| All negatives | 43 of 125; 48 of 140 | 23 of 125 | **23 of 140** |

- **The gain:** +20 of 120 indirect requests start a push (v2, clean); negatives that start one halve (48 → 23 of
  140). The cost is statements of personal intent ("I need to stop eating biscuits", "We should go to Iceland one
  day"): 4 → 14 of 40. A push that starts still needs a constraint-like item in the pool to send a packet.
- **What v2 still misses** (44 of 120): a request in a second clause after a statement ("…, can you order the refill
  for her?"), hedges with no lead-in it knows ("Might be worth chasing …", "I'll need the hotel changed …", "Would be
  handy if you could …"), and passive needs ("We need the drawings signed off …"). Reading a second clause's polite
  ask is the next step; it needs a third blind set.

### 1.4 Other languages

Set 1's 60 non-English acting requests (French, German, Spanish, Portuguese, Italian; half imperative, half indirect):
52 of 60 start a push today and with either rule, all by the open shape (no verb list knows them): an imperative
in any language reads as "not a known opener". The 8 that do not are questions about acting ("¿Debería cancelar …?",
"Könnten wir …?", "Est-ce que je devrais …?"). v2 drops the 20 non-English chatter and info lines that start a push
from 7 to 0 (greetings and laughter in those languages). The lexical pool is English-worded items against
non-English requests, so a push that starts finds what names, numbers and amounts share; **not measured: the
funnel has no non-English suite**. Which languages Eden supports is the owner's decision (weak-points §6.8).

## 2. Weak point 1 (Q4): the push check, its cost, and silence

### 2.1 No-model narrowing first ($0): option (b) costs too many facts

`pushNarrow` (D821, rejected and deleted; code in 1feae213): with no check, the default's packet goes only when an item of the pool's head is
constraint-like and names one of the request's anchors (N5's `pushCheckAnchored` test, used to silence instead of to
call); at 2 the packet keeps only constraint-like or anchored items. Funnel, train 41–44, 768 a variant:

| Arm | Planted handed | Decoy handed | Neutral given a packet |
| --- | --- | --- | --- |
| default | 582 | 502 | 738 |
| `pushNarrow` 1 | 348 (+0 −234) | 295 | 216 |
| `pushNarrow` 2 | 334 (+1 −249) | 286 | 214 |

Silence returns to 71% of neutral requests, but 40% of the planted facts leave the push. `pushOpen`'s 132 tasks were
worth +4.1 points live; 234 tasks is a larger loss **[EST]**. No lexical rule tells a fact from its look-alike: only
the model check does. (b) is not run live; the work goes into the check's cost.

### 2.2 Pre-registration A: the compare-first reply made short (funnel, live check)

Written and committed before this session's first paid call.

**Why.** N5's check (form 2) costs $0.00025 and about 1.0 s a call at p50; about 140 of its tokens are output, which
is most of the wait **[EST: Haiku output at about 150–200 tokens a second]**. N (the anchored gate, never silent)
missed the wait bound by 0.01 s short and 0.11 s over days. A reply half as long would cut about 0.3–0.4 s a call
**[EST]**, and a tighter wait cuts the tail.

**Form 3** (`CHECK_SYSTEM_COMPACT`, `pushCheckForm` 3, D822): form 2's question, yes, no and data rule word for word;
each entry is `on` and `hits` of at most four words each, the verdict folded into the link (none for a look-alike and
for a go-ahead alike), at most four entries, output cap 240 tokens.

**Arms** (funnel, `--set` with `pushCheck`, `pushCheckWaitMs` 60000, no widening, `pushCheckSilent` true: N5's Kp
shape, every gated push checked), seeds 42 and 43, train, all templates, `-- --neutral --check live`, one process a
seed, `--check-log` kept:

- F2: `pushCheckForm` 2 (N5's frozen wording).
- F3: `pushCheckForm` 3.

**Read at $0 from the recorded replies** (`--check replay`): each form under N's switches (`pushCheckAnchored`,
`pushCheckSilent` false); and, from F2's log, the reply cut at its first `"hits":"none"` entry (the output a stop
sequence would save, and the yes entries it would lose).

**Reported per arm:** $ a call, input (cached) and output tokens, p50 and p90 seconds, unreadable replies; planted
handed, decoy handed, neutral packets (`compare.py`).

**Rule (which form goes live):** form 3 replaces form 2 in every live arm if, pooled over seeds 42–43 (384 hidden,
384 control, 384 neutral), its planted handed is at least form 2's − 10, its decoy handed at most form 2's + 10, and
its p50 a call at least 0.15 s lower. Otherwise form 2 goes live. Budget about $0.55 **[EST]** (N5: $0.13 a seed for
form 2).

### 2.3 Pre-registration B (live, Pi): written after A is read, committed before its first call

Committed while A's form 2 runs were under way and before any form 3 call; the arms' form F is fixed by A's rule.

**Arms** (Pi on Modal, `lab_fanout.py --preset bench-tools`, the F3/I3/N5 harness: `--tenant-prompt`, payload
notices, direct profile, Haiku 5.5 as agent, grader, cards and check, cards and intent replayed where covered,
the Modal Secret `HAIKU_API_KEY`), from the commit that holds this addendum or a later one with no engine change:

- `eden`: the default.
- `eden~N*` (**the cheap N**): `pushCheck`, `pushCheckForm` F, `pushCheckAnchored`, `pushCheckSilent` false,
  `pushCheckWaitMs` 1500. N5's arm N with the short reply (if F is 3) and a tighter wait (2,500 → 1,500 ms: a call
  past it leaves the default's packet, as before).
- `eden~S*` (**the silent check**): `pushCheck`, `pushCheckForm` F, `pushCheckSilent` true, no gate, no widening,
  `pushCheckWaitMs` 1500. N5's Kp with the short reply and the tighter wait: the arm that restores silence on most
  neutral requests (N5 at $0: neutral packets 461 → 135 of 576) and so cuts the agent's packet tokens most.

**Shapes.** Short: seeds 41–48, train, all templates, `--variants hidden,control,neutral`, two shards at a time
(`--max-streams 108`). Days: `--days 8`, users w41–w48, `--timeline`, two shards at a time (`--max-streams 6`).
Short first, then days.

**Measures.** Every hidden answer and every control or neutral concern regraded by Sonnet 5.5 (`i3-regrade.ts`).
Hidden raised: template-clustered bootstrap (`bench_report.py --sonnet`), days also by user (`days_hidden.py`).
Cost and wall, paired by task, 1:1:8 mix (short) or the days users (`n5/mix.py`). **Weak point 5:** the agent's
tokens per task by class (plain input, cache write, cache read, output; `n4/tokens.py` on the days timelines), packet
characters handed per task (`injectedChars`), and the paired difference of each against `eden`.

**What I will recommend (the parent decides; D112: promotion needs better or neutral at no extra paid cost, and
every arm here costs more):**

- (a) promote an arm if its hidden raised short is better (clustered interval above zero), Sonnet-confirmed
  concerns are not up on either shape, total $ per 1,000 tasks rises by at most $0.10 over days (steady state) and
  wall by at most 0.3 s a task on both shapes (N5's bounds). Between two that pass, the one with more hidden raised.
- else, if an arm's hidden short is better but a bound fails, keep the switches to their end date (2026-12-10) and
  report the trade (facts per dollar and per second) for the parent; recommend (c) if no arm's hidden short interval
  is above zero.

**Budget.** About $10 **[EST]**: short three arms about $5.5, days about $1.3, Sonnet regrades about $3 (N5: two
arms short $3.35, days $0.77, regrades $1.9). No arm, seed, bound or rule changes after the first call; anything later
is an addendum written before its own run.

### 2.4 Addendum C (before any call it covers): the check arms lose the open shape's pushes

Written after reading A's form 2 funnel rows (seeds 42–43) and before any form 3 row was read. Form 2 handed fewer
planted facts than the default (271 against 291 of 384), where N5's Kp handed more (403 against 370 of 576). The
cause is in the code, not the check: since D710 the default also pushes for requests whose verb is on no list
(`pushOpen`), and that path is off whenever `pushCheck` is on (D702 left the check's paid call off it). So every
check arm silently lost those pushes (31 of train's 192 templates).

- **Trial `pushCheckOpen` (D823, off):** with `pushCheck`, opened pushes start and are checked as listed ones.
- **A's screen, added:** once A's form 3 runs finish, each form is run again on seeds 42–43 with `pushCheckOpen`
  (its recorded replies replayed, the opened pushes' calls made live, about $0.05 **[EST]**), and those rows are
  reported beside A's. A's rule is applied to A's own rows, unchanged.
- **B's arms, amended:** `eden~N*` and `eden~S*` also set `pushCheckOpen` true. Nothing else in B changes.

### 1.5 Pre-registration D: `pushIndirect` live (Pi), committed before its first call

- **Arms:** `eden` and `eden~I` (`pushIndirect` true), the bench-tools harness of §2.3, `--suites train-rw`, seeds
  41–44 (the seeds the intent file covers), `--variants hidden,control,neutral`, two shards at a time.
- **Measures:** every hidden answer and every concern regraded by Sonnet 5.5; hidden raised with the
  template-clustered bootstrap; cost and wall paired on the 1:1:8 mix (`n5/mix.py`), agent tokens and packet
  characters a task.
- **Rule:** `pushIndirect` is recommended for promotion if hidden raised on train-rw is better (clustered interval
  above zero), Sonnet-confirmed concerns are not up, and the agent's $ per 1,000 tasks on the mix rises by at most
  the default's own packet cost on train (it adds no model call of Eden's; on train it changes no task at $0, §1.2).
  Otherwise the switch is deleted at its end date.
- **Budget:** about $4 **[EST]** (two arms, four seeds, regrades).

## 3. Results

### 3.1 A: the short reply fails its rule; form 2 goes live (D822)

Funnel, train seeds 42–43 (384 tasks a variant), live check, `pushCheckWaitMs` 60,000, every gated push checked
(`compare.py`, `calls.py` on `.local/p2/ledger.jsonl`):

| Arm | $ a call | in (cached) / out tokens | p50 / p90 s | Planted handed | Decoy handed | Neutral packets |
| --- | --- | --- | --- | --- | --- | --- |
| default | | | | 291 | 247 | 370 |
| F2 (form 2) | 0.000233 | 2,752 (1,182) / 127 | 1.03 / 1.52 | 271 | 69 | 81 |
| F3 (form 3) | 0.000202 | 2,627 (1,058) / 67 | 0.84 / 1.16 | 274 | **185** | 106 |

Form 3 halves the output and cuts 0.19 s at p50 and 0.36 s at p90, and keeps the facts (274 against 271), but lets
look-alikes back in (185 against 69: the rule allows 79). Form 2 goes live. Form 3 is deleted (code in ffe6285c).
The stop sequence at the first `"hits":"none"`: on F2's 471 seed-42 replies it keeps 83% of the characters and loses
31 yes entries; rejected with it.

### 3.2 Addendum C: opened pushes checked

Both F2 runs read lower than the default on planted handed. With `pushCheckOpen` (the same replies replayed, the
opened pushes' calls made live), seeds 42–43:

| Arm | Calls a seed | Planted handed | Decoy handed | Neutral packets |
| --- | --- | --- | --- | --- |
| default | 0 | 291 | 247 | 370 |
| F2 | 470–472 | 271 (+35 −55) | 69 | 81 |
| F2 + `pushCheckOpen` | 563–566 | **316 (+37 −12)** | **82** | **100** |

The check arms that go live set `pushCheckOpen`: +25 planted facts handed against the default, look-alikes −67%,
neutral packets −73%, for about 20% more calls than F2.

### 3.3 The review (before any Pi call)

The `reviewer` subagent ran on d5d504f0..8b84d745 (REQUEST_CHANGES; eval 0.65 / 0.52 / 0, funnel 315 / 276, the cold
gate red on one test). Fixed in 1927cc19 before the Pi runs: card distillation counted `train-rw` as held out (the
red test); `indirectRest` handed on a rejoined 400-character head (now the message itself from where the lead-in
ends, whole); the strict open shape refused requests with clock times or dates ("Bump Thursday's 09:00 call to
10:30") and any message opening with a greeting (now a greeting needs a listed verb after it); "eat", "chat", "stay"
read as acting. Rescored after the fixes (labelled post hoc: the sets were read): set 1 the same; set 2 indirect 76
of 120, logs 4 of 30, chatter 6 of 40, statements 13 of 40, questions 0 of 30. Left as known: a plan alert (D301)
for an indirect request quotes the imperative, not the user's words; with the reader's own push
(`pushCandidates` 0) an explicit ask in the same request does not reuse the push's reading of an indirect request.

### 3.4 Pre-registration E: does the silent check pay for itself with a dear agent? (committed before its first call)

Written after B's short and days runs were read. On B's days run the silent check (S) cut the packet characters the
Haiku agent re-reads by 57% and its prompt tokens by 1,731 a task; priced at Sonnet's rates those tokens would be
**[EST]** −$0.71 per 1,000 tasks against the check's +$0.22. The Haiku agent's tokens are not a Sonnet agent's, so
this is measured directly once.

- **Arms:** `eden` and `eden~S` (B's S: `pushCheck`, form 2, silent, `pushCheckWaitMs` 1500, `pushCheckOpen`), Pi on
  Modal with B's harness except `--model claude-sonnet-5-5` (the agent only; grader, cards and check Haiku 5.5),
  `--days 8`, users w41–w44, two shards at a time, cap $9.
- **Measures:** agent $, Eden $ and total $ per 1,000 tasks, wall, and the agent's tokens by class, paired, whole users
  resampled; hidden raised (Sonnet regrade), reported but not decided on (about 50 hidden tasks an arm).
- **Reading:** "S costs no more in total than the default with a Sonnet agent" holds if the total's paired
  difference has its interval's upper bound at or below zero; "S costs less" if the whole interval is below zero.
  Otherwise the [EST] above is wrong and is reported so.

### 3.5 B: the two check arms on Pi (short and days)

Pi on Modal at 1927cc19, the bench-tools harness, Haiku 5.5 as agent, grader, cards and check. Short: seeds 41–48,
all 192 templates, hidden, control and neutral, 4,608 task runs an arm (3.4% of the first wave's requests retried on
a 429, later waves 0). Days: `--days 8`, users w41–w48, 989 task runs an arm (101 hidden), no 429. Sonnet 5.5
regraded 4,673 short and 324 days answers (0 failed). Quality: template-clustered bootstrap (`bench_report.py
--sonnet`), days also by user (`days_hidden.py`); cost and wall paired, short on the 1:1:8 mix by template, days by
user (`n5/mix.py`). **Anthropic-direct lab figures.**

| Arm − `eden` | N (anchored gate, never silent) | S (every gated push, silent) |
| --- | --- | --- |
| Hidden raised, short (Sonnet) | **+3.6 points (+1.6..+5.8)**, 63.6 vs 60.0 | **+4.7 (+2.3..+7.0)**, 64.6 vs 59.9 |
| Hidden raised, days (Sonnet) | +1.0 (−3.8..+6.5 by user), 63.4 vs 62.4 | +2.0 (−5.0..+8.1), 64.4 vs 62.4 |
| Confirmed concerns, short; days | 2 vs 1 of 3,070; 0 vs 2 of 888 | 1 vs 1; 1 vs 2 |
| Total $ per 1,000 tasks, short (1:1:8); days | +0.050 (+0.035..+0.065); **+0.103 (+0.099..+0.106)** | +0.213 (+0.202..+0.224); +0.178 (+0.168..+0.186) |
| of it the agent, short; days | −0.033; −0.010 | +0.000; **−0.043** |
| Wall a task, short; days | **+0.32 s (+0.20..+0.45); +0.57 s (+0.55..+0.60)** | +1.09 s (+0.92..+1.26); +1.15 s |
| Check calls a task, short; days | 0.35; 0.48 | 0.96; 0.99 |
| `ask_context` calls a task, short | −0.02 | +0.21 (+0.16..+0.25) |

S against N, short: hidden +1.0 (−0.8..+2.9), $ +0.124, wall +0.57 s.

**Against B's bounds (+$0.10 over days, +0.3 s a task on both shapes): neither arm passes.** N raises hidden facts
(the interval above zero, better than N5's N: +3.6 against +2.7, from the opened pushes `pushCheckOpen` now checks)
but misses the wait on both shapes and the cost over days by $0.003; checking the opened pushes raised its call rate
over days from N5's 0.40 to 0.48, and the 1.5 s wait cut nothing (the check's p50 is about 1 s). S raises the most
and restores silence, at four times N's price and a second a task, most of it the agent asking where the push went
silent.

### 3.6 Weak point 5 (C1): the packet tokens the agent re-reads over a day

B's days run, D336's kept layout (the shipped one: a day's packets stay in the transcript and every later model request
reads them again). `p2/packet_reread.py` (packet characters handed, and handed-earlier-that-day plus own times the
task's model requests) and `n4/tokens.py` (the agent's tokens by class from the timelines):

| Per task over days | `eden` | N | S |
| --- | --- | --- | --- |
| Packet characters handed | 1,070 | 1,002 | 450 |
| Packet characters re-read (earlier that day + own, × model requests) | 9,797 | 9,119 | 4,246 |
| the same in tokens **[EST: 4 characters a token]** | 2,449 | 2,280 | 1,061 |
| Agent prompt tokens, measured | 7,265 | 6,922 (−343, −413..−277) | 5,534 (−1,731, −2,127..−1,435) |
| cache writes / cache reads, measured | 663 / 6,600 | 610 / 6,310 | 433 / 5,098 |
| Agent $ per 1,000 tasks, Haiku 5.5 | 0.242 | 0.232 | 0.198 |
| the same tokens at Sonnet 5.5's prices **[EST]** | 4.17 | 4.01 | 3.46 |
| the same tokens at Opus 5.5's prices **[EST]** | 8.34 | 8.02 | 6.91 |

- **About a third of what the agent reads on a day is Eden's packets** (2,449 of 7,265 prompt tokens [EST]): a
  packet of about 1,070 characters on 98% of requests, carried to the day's end. N4's +ephemeral layout (D336's
  measurement: dropping old packets costs more, +$0.057 per 1,000 tasks, because the history after them is written
  to the cache again) is why the saving has to come from fewer packets, not shorter transcripts.
- **The silent check halves it** (−57% re-read), the never-silent one barely moves it (−7%): N keeps the default's
  packet wherever it does not call, which is most neutral requests.
- **For a dear agent the silent check may pay for itself:** the Haiku agent's tokens priced at Sonnet's rates fall
  $0.71 per 1,000 tasks against the check's +$0.22 **[EST]**. Measured with a Sonnet agent in §3.7.

### 3.8 D: `pushIndirect` on Pi (the reworded train)

Pi on Modal at d8544d2e, the bench-tools harness, `--suites train-rw`, seeds 41–44, hidden, control and neutral,
2,304 task runs an arm (8.4% of the first wave's requests retried on a 429, then 3.2%, then 0); Sonnet 5.5 regraded
1,560 answers (0 failed).

| `eden~I` − `eden` on train-rw | |
| --- | --- |
| Hidden raised (Sonnet) | **+7.4 points (+3.1..+11.8)**, 69.1 vs 61.7, n 768 (Haiku's grade: 69.3 vs 62.8) |
| Confirmed concerns, control and neutral | **1 vs 0 of 1,534** (McNemar p 1.0) |
| Total $ per 1,000 tasks, 1:1:8 mix | **−0.026 (−0.036..−0.017)**: the agent's own, Eden makes no call |
| Wall a task | **−0.39 s (−0.60..−0.16)** |
| Agent tool calls a task; model turns | −0.56 (−0.64..−0.50); −0.21 |

- **When the push starts for an indirect request, the agent searches less and raises more.** Without it the agent
  on train-rw finds facts by asking (its tool calls 1.36 a task against about 0.6 on train's own wording); with it
  the packet arrives before the first model call.
- **Against D's rule it fails by one concern.** Hidden is better (interval above zero) and cost is lower, but D's rule
  asks that Sonnet-confirmed concerns are not up, and they read 1 against 0. The one (read by hand) is a real false
  concern: on a control task ("Let's cash in £3,000 of my Premium Bonds to pay for a new boiler") the agent stated a
  boiler claim accepted for another policyholder's address as covering the user's. So by the rule as written
  `pushIndirect` is not promoted, and the trade goes to the parent: +7.4 points of hidden facts and −$0.026 per 1,000
  tasks for one more false concern in 1,534 neutral and control answers.
- On train's own wording the switch changes no task (§1.2), so the default's measured figures stand there.
