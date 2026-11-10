# N2: recall without look-alikes — widen the pool behind the "changes the action" check, re-show over days, silence

Status: 2026-11-10, branch `claude/n2-recall` (from `claude/lucid-hypatia-v9wqk5` at 3e10a6fe), session N2.
Decisions D510–D514. Train suites only (train1–6); heldout18 is not dumped, labelled or run. Numbers marked
**[EST]** are arithmetic or judgement; every other number comes from a command in this note. Every paid call goes to
Anthropic directly with `HAIKU_API_KEY` through the lab (D97): **Anthropic-direct lab figures**. Caps: Anthropic $12
(ledger `.local/n2/ledger.jsonl`), Modal $15.

## 0. Why, and what is on the base

- **(a) Facts that never reach the agent.** On the base, train seeds 41–44 (768 hidden tasks, the funnel's shipped
  default with cards and intent replayed), 134 hidden facts are not surfaced. Where they are
  (`.local/n2/base.json`, `pushPoolAt`): 68 tasks where the push ran and the fact is not in its 15-item pool, 34 where
  it is in the pool at places 6–15 and is not handed, 32 where no push ran. A deeper lexical pool barely helps: with
  `askReaderPool` 60 only 10 of those 72 facts enter the top 60 (7 at 16–30), and 20 decoys do. The facts are not
  ranked lower; they are not ranked (no shared word: A15, M3).
- **Every earlier widening raised one look-alike per fact** (A15 D330–D333; M3 D450–D453: embedding k 3, +42 facts,
  +48 decoys). I2 (D490–D494) found a question that separates a fact from its all-clear twin: "does this item change
  what the assistant should do for this request?" (Opus AUC 0.917 held out; Haiku 0.876); Haiku's labels served as
  a push checker passed I2's bar on fresh worlds.
- **(b) Long horizon.** A17/A26: a fact handed early for an unrelated request is kept back at its own request by the
  not-twice ledger; a blind re-show (D340) was deleted (D380: +2.7 points, Sonnet-confirmed concerns 0 → 1).
- I2's label files are not in this container (`.local` is not committed; no Modal volume holds them), so the $0
  screens here replay **this session's own Haiku labels**: the lab checker (`n2-check.ts`) calls Haiku once per
  (request, item set) and keeps every answer; every re-run and every arm with the same set replays it at $0. Session
  I3 (`claude/i3-push-check`) is building the shippable check; it was not on the remote when this note was written.

## 1. Pre-registration (written and committed before any screen below was run)

### The check

The lab checker (`packages/sim/src/lab/n2-check.ts`): Haiku 5.5 (`claude-haiku-5-5`), I2's `CHANGES_SYSTEM` and
prompt layout (request and items fenced as data, items in a fixed shuffle by hash), **no thinking** (what the shipped
reader and card calls send, D144, D149; I2 labelled with effort low), one call per push over the items the push would
show it, confidence /100, pass mark **0.5** (I2's). Wired as the engine's `PairChecker`; the engine trial is I1/I2's
`pushCheck` revived (D510), waiting `pushCheckWaitMs` 60,000 in the funnel so every decision is the checker's. When
I3's check lands, the live runs use its engine code if it fits these rules unchanged; otherwise this one, and the
note says which.

### The switches (all off in the default; trial rows in docs/DECISIONS.md)

- `pushCheck` (D510): the push's candidates are the pool's items the checker passes (≥ 0.5), in pool order, first
  five. A checker that errs or misses its wait leaves the default's candidates.
- **H3** `pushCheckSilent` (D513): none passing sends no candidates packet. Off: none passing gets the default's rule.
- **H1** `pushWiden` (D511): the pool the checker reads gains, after the 15 lexical items, up to `pushWidenIntent` 6
  raw intent-index hits (the request against the items' written requests, no thresholds, no anchoring: the hits the
  default drops), `pushWidenEmbed` 5 nearest items by embedding (the `widen` dependency: in the lab a table made
  offline on Modal with M3's Qwen3-Embedding-0.6B, `n2_embed.py`), and `pushWidenDeep` 5 next lexical items. Bulk
  mail and items already in the pool are skipped. Only the checker can hand a widened item.
- **H2** `pushCheckReshow` (D512): a candidate the agent took for an earlier request of the session is handed again
  when the checker passes it for this request (D340's re-show with the check in place of the constraint test).

### Arms (funnel, `bun run funnel --suite train -- --neutral`)

| Arm | Settings |
| --- | --- |
| C0 | the default (trial off) |
| C1 | `pushCheck` |
| C2 (H3) | `pushCheck`, `pushCheckSilent` |
| C3 (H1) | `pushCheck`, `pushWiden` |
| C4 (H1+H3) | `pushCheck`, `pushWiden`, `pushCheckSilent` |

Figures per arm, task by task against the arm named in the bar: hidden and decoys surfaced (the funnel's, packet or
ask), **planted handed** (the planted item in the candidates packet), **decoy handed**, neutral tasks given a
candidates packet, packet bytes. **Screen: seeds 41–44, all train templates** (no rule here is fitted on data: every
setting above is fixed now); reported also on I2's held-out templates (`compare.py`'s hash, share 0.2) for comparison
with I2. **Confirmation: seeds 45–48, I2's held-out templates** (fresh worlds; intent replay does not cover 45–48, so
the intent index is inert there in every arm and H1's intent route is not tested by it; labelled).

### Bars (every clause must hold, screen and confirmation)

- **H1 (C3 against C1):** planted handed **≥ +8** (screen; ≥ +2 on the confirmation, a fifth of the templates);
  decoy handed **≤ +3** (≤ +1); hidden surfaced not lower; neutral packets not more than +5% of C1's. Also against
  C0: decoy handed not more than C0's.
- **H3 (C2 against C1):** planted handed **at most 2 fewer** (the brief: never lose a planted fact; I1 lost 47 of
  103); hidden surfaced at most 2 fewer; neutral packets **at least halved**.
- **H1+H3 (C4 against C0), the candidate for a live run:** planted handed **≥ C0's**; decoy handed **≤ C0's −10%**;
  hidden surfaced ≥ C0's; neutral packets at least halved.

### Live (Pi on Modal, only for an arm that passes its screen and confirmation)

`pi-ab` on the Pi harness, Haiku 5.5 agent and grader, `--tenant-prompt`, payload notices, cards and intent replayed
where covered, at most two Anthropic shards at a time, the Modal Secret `HAIKU_API_KEY`. Arms: `eden` (the default)
and `eden~N2` (the passing arm's settings; its check calls are counted in its cost). **Short:** train seeds 41–48, one
request a session, I2's held-out templates (40 of 192), hidden, control and neutral. **Days:** `--days 8`, users
w41–w44; H2 adds a third arm `eden~N2+reshow` here only (the funnel cannot see a re-show). Every hidden answer and
every concern is regraded by Sonnet 5.5 (`regrade.ts`).

**Live bars** (paired task by task, template-clustered bootstrap where the bench report applies):

- the N2 arm against `eden`: Sonnet-graded hidden raised not lower (point ≥ 0, interval's low end ≥ −3 points);
  Sonnet-confirmed concerns (control and neutral) not up; cost per 1,000 tasks reported with the check's calls.
  Promotion needs, in addition, a decision for a model call on the push (D4, D5), a cost estimate in
  docs/COST-MODEL.md and I3's latency measurement; this session can recommend, not promote.
- **H2** (`eden~N2+reshow` against `eden~N2`, days only): hidden raised ≥ +2 points with Sonnet-confirmed concerns not
  up (D380's failed clause), re-shown items counted.

If a bar fails, the arm stops there and the note says so.
