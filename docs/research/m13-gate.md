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
