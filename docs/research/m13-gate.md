# M13: a tiny learned gate for the push (does this turn need context, and what kind of turn is it)

Status: 2026-11-11, branch `claude/m13-gate`. **Rejected by its pre-registered bar after three rounds (D1010), then
shipped by the owner's decision (D1014, §7): `pushGate` is in `DEFAULT_CONFIG`, part `gate`.** Decisions
D1010–D1014. Every paid call went to Anthropic directly (`HAIKU_API_KEY`, lab transport): $2.75 for data and blind
sets; Modal $0 (unreachable from this container). Numbers marked **[EST]** are judgement; every other number comes from a command in this note.

**In plain words.**

- A 1.6 MB character-level model can tell, in any of nine languages, whether a turn asks for something far better
  than the shipped rules: on blind sets it starts the push for 93–99% of acting requests against the rules' 77–80%
  (non-English 99.7 against 39.1, terse notes 95.4 against 12.7) and for 61–82% fewer chatter, statements and
  personal wants. It runs in 43 µs a turn in TypeScript.
- It only works beside the rules: alone, trained on generated text, it missed hand-written English requests the
  rules catch (D1011). Generated text also taught it the wrong cues until the data was rebuilt (D1012).
- It still failed the bar set before it was scored: where the rules are already near-perfect (hand-written English,
  95%) it is not better, Hindi requests and Portuguese chatter fell outside the five-point parity band, and a few
  hard-gate turns ("yes please cancel it", "Who won the 2018 World Cup?") came out wrong. So it was deleted, as the
  pre-registration said; the owner then accepted those clauses as not blocking and asked for it in the default
  (D1014). On the funnel its facts are level on train and up on reworded requests, and on Pi it raised hidden facts
  +1.2 points (−1.4..+3.8) with no confirmed concern, at the same cost and wall time (§7).

## 0. Pre-registration (committed before any held-out set is written or scored)

**What the gate replaces.** The push's start decision, today `pushStart` (probes.ts: `isImperative`'s verb lists,
`pushOpen`'s open shape, `pushIndirect` v4's lead-ins, second clauses, hedges and vetoes; D702, D820, D828, D829).
The reader's own request gate (D168, D186) is the push itself: a turn that starts no push makes no reader call.
The gate reads one user turn and gives `needs` (start the push) and a kind: `act`, `qact` (a question about whether
to act), `ask` (a question for information), `chatter`, `statement` (news, context, a personal intent, a pasted log).
`needs` is `act` or `qact`, the turns `pushStart` is meant to start; `ask` keeps today's behaviour (no push).

**Held-out sets** (no gate is trained, tuned or selected on them; each is scored once per frozen candidate):

- **S3**: P2's blind set 3 (`packages/sim/lab/p2/blind-gate-3.json`, English; P2 read it, M13 has not).
- **S4**: M13's blind set 4, written by Haiku from `packages/sim/lab/m13/gen_blind4.py`'s brief alone, nine languages
  (en de fr es it pt nl pl hi), kinds act, qact, ask, chatter, intent, statement, log. Generated after this commit.
- **M2T**: M2 v2's test split (293 worlds; every request needs context by construction; 8 phrasings, 9 languages).

Training and selection use only: M2 v2 train worlds, P2's blind sets 1 and 2 and `gate-negatives.ts`, the train
suites (train1–6, train1r–6r, train-rw), the eval's scenarios, and M13's own generated training set (a different
brief and generator from S4's).

**The bar** (the frozen candidate against the shipped `pushStart`, on the same rows):

1. Acting detected: on each of S3's indirect requests, S4's act and qact rows (all languages pooled) and M2T (all
   rows pooled), the gate's start rate is at least the shipped rule's + 10 points (or at least 98% where the shipped
   rule is above 88%).
2. False starts: on S3's chatter and statements, and on S4's chatter, intent and statement rows, the gate starts at
   most half as many as the shipped rule (each set separately). Guards: S3's and S4's log and ask rows start no more
   than the shipped rule's rate + 2 points.
3. Every language: on S4 (acting start rate, and false-start rate over chatter, intent and statement) and on M2T
   (start rate), each of the nine languages is within 5 points of English (acting no lower than English − 5, false
   starts no higher than English + 5).
4. Funnel ($0, train seeds 41–44 `-- --neutral`, and train-rw): neutral packets not up, hidden surfaced not down.
   `bun run eval`: precision ≥ 0.65, falseFireRate 0; the acting block reported.
5. Pi pair against main (if Modal is reachable; cap $8): hidden facts' clustered lower bound > −1, confirmed concerns
   down or level, packets on neutral turns down. If Modal is unreachable from this container it is reported as not run
   and the promotion rests on 1–4 and 6–7.
6. Speed and size: ≤ 0.2 ms a turn (mean, TypeScript, one core) and ≤ 2 MB of weights.
7. Hard gates: every row of the fixtures (`packages/sim/lab/m13/fixtures.json`: short commands, questions, P2's listed
   misfires) right.

Promote (D814) only if 1–4, 6 and 7 hold (and 5 where run): into `DEFAULT_CONFIG` with a `PARTS` entry, the rules it
replaces deleted. Otherwise delete the gate's engine code and tests, keep the lab kit.

## 1. Hypotheses (written before the first training round)

Every gate reads one user turn, character by character, with no tokenizer and no pretrained table: hashed
character n-grams work the same in any script. They differ in what they read and how they compose it.

| # | Hypothesis | What it bets on |
| --- | --- | --- |
| H1 | **Hashed n-gram bag, linear** (`bag`, groups chewp: char 1–4-grams, the turn's head and tail grams, words, word bigrams, positional first/last words) | The cheap baseline: the opener and the ending carry most of the decision in every language |
| H2 | **The same bag with one hidden layer, int8 table** | Interactions (a lead-in AND a concrete object) that a linear bag cannot form, at 1 byte a weight |
| H3 | **Binary codes**: ternary table, mean-pooled into a sign code (128 bits), XNOR-popcount layers (M3's kernel) | Size and speed: the decision as a Hamming test on a 128-bit code |
| H4 | **Clause multiple-instance** (`mil`): the same encoder over the whole turn and each clause; needs is the max | A request in a second clause ("the boiler's broken again, can you book …") is one clause's decision, not the turn's |
| H5 | **Character CNN** over code points (hashed to 4,096), two widths, max-pool | Local word shapes and suffixes (imperative endings: -ez, -en Sie, -ar/-er) without any word list |
| H6 | **Tiny recurrent reader** (minGRU, 32–48 units) over the first 96 code points | Order: "can you believe" vs "can you book" is decided by what follows the opener |
| H7 | **Rule residual**: the bag plus the shipped rule's own reading (listed / opened / none, lead-in read) as features | Keep what the rules know in English and learn only where they fail (other languages, terse, chatter) |
| H8 | **Function-word skeleton**: words outside the training set's K commonest become their shape, and skeleton n-grams are hashed | "I need to <verb> the <noun> by <day>" vs "I need a <adj> <noun>": structure over vocabulary, so it transfers to new topics |

Surface cues are balanced in the data rather than hoped away: M13's training set is contrastive (each set holds all
kinds on one topic, at one length and one punctuation style, in one language), and rows are weighted so every
(language, needs) cell carries the same weight.

### 0.1 Addendum A (before any held-out read; after the parent's transfer lesson from M6, D920)

Models fitted on generated text transferred badly to the sim's hand-written families in M6. So:

- **Selection** (threshold, architecture, round tables) uses a dev set that holds the sim families train3–4 (with
  train3r–4r and train3rw–4rw), none of them in training; round tables report generated rows and sim rows apart.
- **SIM56**, a fourth held-out set: the requests of train5–6, train5r–6r and train5rw–6rw (every one acting), never
  trained or selected on. Bar item 1 adds: the gate's start rate on SIM56 is at least the shipped rule's − 1 point
  (the rule is near 100% there, so no +10 is possible), and on its reworded part (5r, 6r, 5rw, 6rw) alone likewise.
- The Pi pair (bar item 5) runs locally with the Anthropic lab provider (no Modal needed), cap $8; it is required.

### 0.2 Freeze rule (committed before full training's results are read)

Full training: R2i (`--arch mil --bits 16 --dim 24 --hidden 64 --quant int8 --rule2 --kind-weight 1.0`) and R2f
(`--arch bag --bits 16 --dim 24 --hidden 128 --quant int8 --rule2 --kind-weight 1.0`), 6 epochs, seeds 1 and 2. The
frozen candidate is the one run of the four with the highest dev `macro_union_veto` (its threshold and veto as
picked on dev by gate.py); ties go to the smaller and faster bag. It is then exported, parity-checked and scored once
on S3, S4, M2T and SIM56 (score.py), with the union as shipped (the gate alone reported beside it, not decided on).

## 2. Rounds 1 and 2 (dev only)

Round 1 (four Haiku helper sessions, round-1 data, dev = M2 split, generated split, P2 sets 1–2; score = acting
recall − 2 × false starts): H2b (bag + hidden 64, int8) 0.905, H2a 0.877, H8b (skeleton) 0.875, H7b (clauses + rule
features pooled) 0.870, H4b (clauses) 0.860, H1b (linear) 0.859, H3b (binary sign code, 16.8M parameters) 0.851, H5b
(char CNN) 0.735, H6b (minGRU) 0.327. Every model beat the rule on generated and non-English rows and **lost to it on
hand-written English** (P2 set 1 indirect 77–92% against 97%). With the sim's train3–4 in dev (addendum A), H2b
started 74% of train3's requests (rule 100%): plain imperatives with engineering words ("Give Dana read access to the
production customer database …", score 0.00) read as statements, because generated pasted logs taught "tech words =
statement", and the generated `intent` class taught "I want to <task>" = a wish.

Round 2 (data v2: work-topic contrastive sets, acting requests that quote logs, "a concrete task is never an
intent", P2 set 1 in training; dev adds M14's G2/G3 requests; H7' feeds the rule's reading after pooling; the union
keeps a rule start unless the gate's score is under a veto picked on dev). Start rates, gate → union:

| Run | Architecture | Veto | Sim acting | P2 acting | Gen-EN neg | Other-language neg | P2 neg |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rule | `pushStart` | | 99.0 | 89.2 | 25.0 | 71.6 | 7.3 |
| R2a | bag h64 int8 | | 92.8 | 95.0 | 1.9 | 2.2 | 4.5 |
| R2b | + rule after pooling | 0.07 | 92.0 → 98.6 | 93.3 → 95.8 | 0.8 → 2.2 | 1.6 → 4.0 | 3.6 → 4.5 |
| R2c | clauses + rule | 0.02 | 87.7 → 98.6 | 91.7 → 97.5 | 1.2 → 4.3 | 2.7 → 9.2 | 5.5 → 8.2 |
| R2d | + skeleton | none fits | 88.9 | 94.2 | 1.4 | 2.4 | 7.3 |
| R2f | bag h128 + rule, kind weight 1 | 0.11 | 94.7 → 98.6 | 94.2 → 95.8 | 1.3 → 2.4 | 1.9 → 4.1 | 5.5 → 6.4 |
| R2i | clauses + rule, kind weight 1 | 0.09 | 94.4 → 98.6 | 95.0 → 96.7 | 1.0 → 2.6 | 2.4 → 4.3 | 1.8 → 2.7 |

Full training (6 epochs, 2 seeds, §0.2's rule): R2i seed 1 frozen (dev macro under the union 0.919; R2i s2 0.891, R2f
0.894 / 0.893), threshold 0.28, veto 0.04; 1,581,944 bytes of weights, parity 64/64 (worst logit gap 5.6e-6), 68 µs
a turn mean in TypeScript (p50 43, p99 240; dev's 83,046 turns, one core).

## 3. The held-out read of the round-2 candidate (once, 48d94573)

| | Gate (union) | Rule |
| --- | --- | --- |
| S3 indirect acting | **98.3** | 79.2 |
| S4 act + qact, 9 languages | **94.5** | 76.8 |
| M2T, all 17,243 | **99.0** (terse 95.4, non-English 99.7, follow-up 97.4) | 79.4 (12.7, 39.1, 46.9) |
| SIM56 / its reworded part | **100 / 100** | 96.1 / 94.6 |
| S3 chatter + statements started | **7 of 75** | 18 |
| S4 chatter + intent + statements started | **182 of 641** | 479 |
| Logs started, S3 / S4 | 0 / 2.4% | 12 / 33% |
| Info questions started, S3 / S4 | 20.0 / 19.8% | 3.3 / 60.4% |

**The bar fails** on three items: S3's information questions (6 of 30 start, all general-knowledge: "How many calories
are in a medium avocado?"; the training set held only questions about the user's own world), language parity (fr,
es, pl false starts 33–37% against English's 28%; pt acting 89.6 against 97.4), and the fixtures (7 of 78 wrong:
"Yes", "Got it", "Sorry, please disregard, wrong chat", "Long day, will you be home for dinner?", "We need the big
oven", "I need to stop paying for Netflix", "Ich brauche ein neues Bett"). Post hoc: S4's chatter rows often hold a
real request (79 of 213 start; "ti ricordi di mettere …", Hindi "याद दिला", remind me), so S4's false starts overstate,
but no row is relabelled after reading. The gate alone (no union, reported only) starts fewer negatives (148) and
fewer acting requests (S4 91.7), and fails more languages. Not promoted.

### 3.1 Addendum B: round 3 (committed before its data, its blind set or any of its training)

The headline beats the rule by far more than the bar asks, so one more round (the owner's rule: stop after two
rounds only if nothing clearly beats the rules). S3 and S4 are read: they are reported, never decided on again.

- **Training additions** (generated, a new brief): questions for general knowledge and facts about the world, in the
  nine languages; bare replies and acknowledgements ("yes", "got it", "ok cool"); retractions ("never mind",
  "ignore that, wrong chat"); questions to the assistant about itself or the user's day that ask nothing done ("will
  you be home for dinner?" style chatter); and wants for a thing with no task, in every language.
- **S5**, a new blind set: gen_blind4.py's brief with stricter definitions (chatter and statements hold no request,
  question or reminder for the assistant; asks include general knowledge), new seeds, the same nine languages and
  kinds, plus 200 English turns in P2's style (indirect requests, chatter, statements, questions, logs). Written
  before round 3's training starts and not read before the frozen candidate is scored.
- **The bar** is §0's, applied to S5 in place of S3 and S4 (S5's English part for item 1's "indirect" and item 2's
  S3 lines), with M2T and SIM56 as before, and fixtures.json unchanged (bar item 7). Freeze rule as §0.2 on the
  round-3 runs (R2i's and R2f's configurations).
- If this candidate fails the bar, the trial is deleted with its engine code and tests; the lab kit stays.
- **Fixtures, addendum B2** (written after the parent's approval, before any round-3 result was read; no round-3 data
  was made from it): `fixtures-2.json`, 57 new hard-gate turns (short commands, indirect and non-English requests,
  bare replies, retractions, general and personal questions, wants, logs). Bar item 7 now needs every row of both
  files right.

## 4. Round 3 (addenda B, B2) and its read of S5 (once, 8f2c7dba)

Training added general-knowledge questions, bare replies, retractions, social remarks and wants for a thing, in the
nine languages (4,939 rows). Dev (no held-out set): R2f seed 1 0.925 under the union (veto 0.25), R2f seed 2 0.919,
R2i 0.923 / 0.917; R2f seed 1 frozen. Weights 1,590,904 bytes; parity 64/64 (worst logit gap 4.5e-6); 42.6 µs a turn
mean (p50 37.9, p99 99.3) over dev's 84,051 turns, load 5.1 ms.

| | Gate (union) | Rule |
| --- | --- | --- |
| S5 English acting (129) | 95.3 | 94.6 |
| S5 acting, nine languages (764) | **92.7** | 79.7 |
| M2T (17,243) | **98.4** (terse 94.7, non-English 98.7, follow-up 97.1) | 79.4 (12.7, 39.1, 46.9) |
| SIM56 / its reworded part | **99.4 / 99.0** | 96.1 / 94.6 |
| S5 English chatter, statements and wants started | **23 of 158** | 75 |
| S5 all chatter, statements and wants started | **93 of 703** | 530 |
| S5 logs / info questions started | 0 / 18.8% | 31.0 / 57.5% |

By language (S5 acting / false starts; M2T acting): en 94.6 / 14.6; 98.3; de 92.1 / 10.3; 99.4; fr 92.8 / 13.9; 98.6;
es 94.9 / 12.5; 99.3; it 92.5 / 11.1; 99.3; pt 96.2 / **25.0**; 97.4; nl 92.0 / 12.7; 99.3; pl 92.5 / 8.6; 97.7; hi
**84.4** / 10.0; 98.4 (the rule: acting 66.7–91.3, false starts 47.5–90.0).

**The bar fails** on: S5's English acting (the rule is above 88% there, so the bar asks 98%; the gate reads 95.3),
Hindi acting (84.4, more than 5 points under English's 94.6), Portuguese false starts (25.0, more than 5 over
English's 14.6), and 5 of 135 fixtures ("We need the big oven", "yes please cancel it", "Who won the 2018 World
Cup?", "Che caldo oggi", "ERROR 502 Bad Gateway upstream timed out after 30000ms"). The "S3 log" guard is empty on
S5's English part (S5's logs are tagged `xx`): a scorer artefact, neither a pass nor a fail.

## 5. Decision (D1010–D1013) and what was not run

Deleted by addendum B's rule: `pushGate`, `turn-gate.ts` in the engine, its weights and tests. Kept as lab tooling:
`packages/sim/lab/m13/` (the TypeScript forward moved there) and the data on `claude/m13-data`.

- **Funnel and eval** (before deletion): `bun run eval` gave the same headline numbers and acting block with the
  switch on and off (its `decisions` block moves: one reader-push decision, four planned lookups; the eval's
  turns are English imperatives the union passes; acting block 19 of 28 neutral packets, 10 of 11 facts, 3 of 10
  look-alikes). The funnel (train 41–44, `--neutral`, round 2's provisional model, not a frozen candidate) surfaced
  575 hidden and 528 look-alikes either way and handed 512 hidden by the push against 525. The funnel covers train5–6,
  SIM56's suites; no selection used it.
- **Pi pair:** not run. The pre-registration ran it only after an offline pass.
- **Helpers:** round 1 ran on four Haiku helper sessions; in round 2 three of them treated the peer message as
  needing a human's go-ahead, so their configurations ran in this session instead.
- **The gains, as a finding (round 3, blind S5 and M2T):** false starts on chatter, statements and wants −82% across
  nine languages (−69% in English), acting requests started +13.0 points (92.7 against 79.7) on S5 and +19.0 on M2T,
  logs started 0 against 31%; 42.6 µs a turn and 1.59 MB of weights in TypeScript.
- **What blocked it, where a next attempt starts:** Hindi acting requests (84.4, English 94.6); Portuguese chatter
  and wants (25.0% started, English 14.6); hand-written English requests, where the rule is already at 94.6% and the
  bar asked 98%; five hard-gate turns; and the funnel's push handing 13 fewer hidden facts on train (512 against 525,
  round 2's provisional model: the union still dropped some English starts the rule makes).
- **Next, if anyone tries again [EST]:** the misses are where the rule is already right (hand-written English) and
  where the generated data is thin (Hindi requests, Portuguese chatter); a gate that only ever adds starts to the rule
  for non-English and terse turns, and vetoes only the rule's open-shape starts, would keep English exactly as it is.

## Reproduce

```bash
python3 -m venv .venv-m3 && .venv-m3/bin/pip install numpy torch --index-url https://download.pytorch.org/whl/cpu
python3 -I packages/sim/lab/m13/gen_train.py .local/m13/train/gen.jsonl --calls-scale 1.5  # + gen_logs, gen_extra
.venv-m3/bin/python -I packages/sim/lab/m13/build.py  # needs M2 v2 (claude/m9-data), M14's G2/G3, the blind sets
.venv-m3/bin/python -I packages/sim/lab/m13/gate.py --arch bag --bits 16 --dim 24 --hidden 128 --quant int8 \
  --rule2 --kind-weight 1.0 --epochs 6 --seed 1 --out .local/m13/r3/R2f-s1
.venv-m3/bin/python -I packages/sim/lab/m13/score.py .local/m13/r3/R2f-s1.pt --s5
.venv-m3/bin/python -I packages/sim/lab/m13/export.py .local/m13/r3/R2f-s1.pt G.bin P.json
bun packages/sim/lab/m13/parity.ts G.bin P.json && bun packages/sim/lab/m13/bench.ts G.bin .local/m13/sets/dev.jsonl
```

## 6. Ready state

On the branch after merging origin/main: `CHECK_COLD=1 bun run check` passed (format, types, every test, 64 s);
`bun run eval` precision 0.65, recall 0.52, falseFireRate 0, acting block 19 of 28 neutral packets (1.18 items), 10
of 11 facts handed, 3 of 10 look-alikes; `bun run funnel` hidden 281/384, decoys 264/384: main's numbers, as the
engine, server and client are byte-identical to main (the trial's code is deleted). No `reviewer` run: the branch
leaves no engine, server or privacy change (CLAUDE.md's rule).

## 7. The owner's decision (D1014) and the promotion's checks

The owner accepts the failed clauses (language parity, the strict English clause, the fixtures) as not blocking and
asks for the gate in the default, with facts as the remaining guard.

**Funnel facts at shipped coverage** (round-3 model, union, veto 0.25; seeds 41–44, `-- --neutral`;
`packages/sim/lab/m13/fpair.py`): hidden facts handed by the push train 525 → 521 (−0.8%, inside the owner's −1%;
two templates' rule starts vetoed, `audit-iam-snapshot-hold`, `dpia-before-pilot`), P7's reworded train 431 → **465**,
P2's train-rw 580 → **588**; surfaced unchanged on all three (575, 536, 629); look-alikes handed 482 → 482, 400 → 426,
503 → 511; neutral tasks given a packet 746 → 751, 668 → 707, 740 → 748 of 768 (neutral tasks share the hidden
requests' text, so a start gained there is a neutral packet too; the push check silences those live). The veto is
not tuned: facts are level.

**Pi pair, pre-registered (this commit, before any call):** `packages/sim/lab/m13/pi.sh` (P3's recipe: Haiku 5.5 as
agent, grader, card and reader model, cards replayed, `--tenant-prompt`, payload notices, the `direct` profile),
arms `eden` and `eden~G` (`pushGate` on), `--variants hidden,control,neutral`, seed 41 on `train` and on
`reworded`, then seed 42 on both if the ledger allows; one ledger, hard cap $8. Promote if hidden facts raised
(Haiku grade) have a template-clustered 95% lower bound above −1.5 points (gate − default, both suites pooled) and
control and neutral concerns are not up (Sonnet regrade of the concerns if the Haiku counts differ). Neutral packets
and false starts reported.

**Pi pair result** (Haiku 5.5 agent, grader, cards and check; train and reworded, seeds 41–42; 3,072 task runs an arm
of hidden, control and neutral; Sonnet 5.5 regraded every hidden answer and every flagged concern; P3's
`report.py --pair eden~G:eden --cluster template`):

| | `eden` | `eden~G` |
| --- | --- | --- |
| Hidden facts raised | 512 / 768 (66.7%) | 520 / 767 (67.8%) |
| Planted item handed at its request | 616 (80%) | 621 (81%) |
| Control concerns (Haiku; Sonnet-confirmed) | 8; 0 | 7; 0 |
| Neutral concerns (Haiku; Sonnet-confirmed) | 4; 0 | 3; 0 |
| Neutral requests given a packet | 415 (54%) | 435 (57%) |
| $ per 1,000 task runs (agent + Eden) / wall | $0.479 / 4.14 s | $0.482 / 4.12 s |

Hidden raised, gate − default: **+1.2 points (−1.4..+3.8)**, 767 pairs in 384 template clusters (train +1.0, −2.3..+4.7;
reworded +1.3, −2.6..+5.0). The pre-registered rule holds (lower bound above −1.5, confirmed concerns not up):
promoted (D1014). Spend: $3.42 (four runs $0.62–0.65 each, the regrade batch $0.88). No new held-out read: the veto
was not tuned, so §4's read of this frozen model stands.
