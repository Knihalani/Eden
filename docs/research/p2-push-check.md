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
`compare_rw.py`; 768 tasks a variant):

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
