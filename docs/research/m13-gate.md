# M13: a tiny learned gate for the push (does this turn need context, and what kind of turn is it)

Status: in progress, branch `claude/m13-gate`. Decisions D1010–D1019.

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
