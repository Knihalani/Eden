# N2: recall without look-alikes — widen the pool behind the "changes the action" check, re-show over days, silence

Status: 2026-11-10, branch `claude/n2-recall` (from `claude/lucid-hypatia-v9wqk5` at 3e10a6fe), session N2.
Decisions D510–D514. Train suites only (train1–6); heldout18 is not dumped, labelled or run. Numbers marked
**[EST]** are arithmetic or judgement; every other number comes from a command in this note. Every paid call goes to
Anthropic directly with `HAIKU_API_KEY` through the lab (D97): **Anthropic-direct lab figures**. Caps: Anthropic $12
(ledger `.local/n2/ledger.jsonl`), Modal $15.

## In plain words

- **Silence works.** Asking Haiku "does this item change what the agent should do?" over the push's pool and sending
  nothing when it names nothing cuts packets on requests where nothing applies by 65–85% and loses no planted fact
  from the packet (H3), with every check measured here.
- **Wider reach works only behind a careful check.** Adding embedding neighbours and raw intent hits to what the check
  reads finds facts that share no word with the request. With Haiku thinking at effort low, the look-alikes stay out:
  every pre-registered bar passed on two sets of worlds, and live on Pi hidden facts rose **+12.5 points** one request
  a session and **+10.9** over a user's days (Sonnet-graded). Without thinking (this note's prompt or I3's shippable
  check) the widening adds about one look-alike per fact again (H1 failed behind I3's check).
- **Re-showing a fact handed earlier, even when the check says it applies now, lost facts over days (H2): deleted.**
- **The careful check is too slow and too dear to ship as is:** 5–7 s a push and about $1 per 1,000 tasks, three times
  the agent. `pushWiden` stays an off trial for a check that is both careful and fast. Engine default unchanged.

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

## 2. Screen results (seeds 41–44, all train templates; §1's arms and bars)

The labels: arm C1's and C3's live runs called Haiku (no thinking) once per push and kept every answer
(`.local/n2/check.jsonl`: 1,901 calls on the ledger, $1.0054, $0.00053 a call at about 15 items; `check-widen.jsonl`:
1,903 calls, $1.6942, $0.00089 a call at 26.8 items); every figure below
replays them with no wait (`--check-cache`, no `--check-live`), as I2 served its labels. **Why replayed:** live, a
check takes p50 3.5 s (p90 4.1 s, 15–31 items, the `why` field included), longer than the funnel's 3 s observe wait;
on 105 hidden tasks the push had not landed when the task ended (no `pushPoolAt`), so the live C1 run read planted
handed 449 against 554 with the same labels. That is a latency finding for any shipped check (§5), not a quality one.
Replay misses: 0–4 pairs a process, scored from the same request's per-pair labels.

| Arm | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets | Packet KB (hid/ctl/neu) |
| --- | --- | --- | --- | --- | --- | --- |
| C0 default | 634 | 552 | 491 | 418 | 617 | 964 / 926 / 693 |
| C1 check | 664 (+30 −0) | 580 | 554 | 445 | 617 | 714 / 697 / 641 |
| C2 check, silent (H3) | 664 | 578 | 554 | 403 | **185** | 692 / 542 / 176 |
| C3 check, widen (H1) | 685 (+53 −2) | 615 | 574 | 480 | 620 | 758 / 715 / 653 |
| C4 check, widen, silent | 685 | 613 | 571 | 433 | 207 | 744 / 573 / 200 |

(of 768 each; `python3 -I packages/sim/lab/n2/compare.py --arm C0=… --arm C1=…`.)

- **H3 passes** (C2 against C1): planted handed +0, hidden surfaced +0, neutral packets 617 → 185.
- **H1 fails** (C3 against C1): planted handed **+20** (bar ≥ +8) but decoy handed **+35** (bar ≤ +3), and above C0's.
- **H1+H3 fails** (C4 against C0): planted handed 491 → 571 and hidden surfaced +51, but decoy handed 418 → 433
  (bar: ≤ 376).
- **Why: the no-thinking check is lenient.** Of the planted items in the pool it passes 558 of 564; of the decoys 404
  of 495 (82%; I2's effort-low Haiku passed 42% of held-out decoys). It removes items unrelated to the request, not
  the look-alike. Widening then brings in look-alikes the lexical pool never ranked, and the check lets most through.

## 3. Addendum, pre-registered before its run: the check with thinking at effort low

Written after §2. The same arms and bars as §1 with one change: the checker thinks (`--check-thinking low`, adaptive
thinking at effort low, I2's labelling setting). To stay inside the cap, only the widened pools are labelled live
(arm C3L's run, `.local/n2/check-low.jsonl`); C1L and C2L replay the same labels per pair (each base pool item was
labelled inside the widened set it belongs to, a larger context than C1L's own call would have: labelled so). Arms
C1L–C4L, screen on seeds 41–44, the bars of §1 unchanged. The confirmation (§1) runs for whichever check (off or
low) passes H1+H3, or, if neither does, for the low check's C2L (H3) only.

## 4. Effort-low results (§3), screen and confirmation

Labels: C3L's live run, 1,903 calls on seeds 41–44 ($2.1813 on the ledger, $0.00115 a call; p50 6.8 s, p90 8.4 s a
check, 26 items a call,
`.local/n2/check-low.jsonl`), replayed with no wait; 0 pairs missed in every arm. Confirmation: seeds 45–48, I2's 40
held-out templates (`--templates`), its own live labelling run (`check-low45.jsonl`), 3–5 pairs missed an arm;
intent inert in every arm there (no replay covers 45–48).

| Arm | Seeds | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets | Packet KB (hid/ctl/neu) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C0 default | 41–44 | 634 | 552 | 491 | 418 | 617 | 964 / 926 / 693 |
| C1L check | 41–44 | 665 (+31 −0) | 569 | 560 | 395 | 617 | 636 / 779 / 670 |
| C2L check, silent | 41–44 | 665 | 564 | 560 | 193 | **93** | 603 / 384 / 115 |
| C3L check, widen | 41–44 | 690 (+56 −0) | 590 | 584 | 398 | 619 | 666 / 788 / 666 |
| **C4L check, widen, silent** | 41–44 | **690** | 585 | **584** | **195** | **150** | 651 / 424 / 159 |
| C0 default | 45–48 held-out | 82 | 83 | 64 | 66 | 107 | 194 / 185 / 112 |
| C1L | 45–48 held-out | 103 | 88 | 91 | 69 | 108 | 153 / 161 / 110 |
| C2L | 45–48 held-out | 103 | 84 | 91 | 45 | 14 | 110 / 67 / 12 |
| C3L | 45–48 held-out | 124 | 92 | 112 | 69 | 109 | 146 / 161 / 109 |
| **C4L** | 45–48 held-out | **124 (+42 −0)** | 86 | **112** | **42** | **22** | 128 / 69 / 18 |

(hidden, control and neutral tasks: 768 each on 41–44, 160 each on the confirmation.)

- **Screen (41–44): every bar passes.** H1 (C3L against C1L): planted handed +24, decoy handed **+3** (bar ≤ +3,
  at the edge), hidden surfaced +25, decoy handed 398 ≤ C0's 418. H3 (C2L against C1L): planted handed +0, hidden
  +0, neutral packets 617 → 93. H1+H3 (C4L against C0): planted handed 491 → 584, decoy handed 418 → 195, hidden
  surfaced 634 → 690, neutral packets 617 → 150.
- **Confirmation (45–48): H3 passes; H1+H3 passes; H1 alone fails one clause.** H1: planted handed +21, decoy handed
  +0 against C1L, hidden +21, but C3L's decoy handed (69) is above C0's (66) — as C1L's already is: without silence
  the check alone does not cut look-alikes on these worlds. H1+H3 (C4L against C0): hidden 82 → 124, planted handed
  64 → 112, decoy handed 66 → 42, neutral packets 107 → 22.
- **Not in any bar, reported:** decoys *surfaced* (packet or the funnel's ask) rise with the check: 552 → 585 (C4L,
  41–44) and 83 → 86 (45–48). The look-alikes leave the packet; some reach the ask's answer instead (the funnel always
  asks). Whether that matters is the live concern count's question.
- **What thinking buys.** The same rule with the no-thinking check failed H1 (§2): of the pool's decoys it passed
  82%; with thinking at effort low the packet's decoys halve. It costs latency: p50 6.8 s a check against 3.5 s.

## 5. Live, pre-registered before the run (the arm and its wait)

The live arm is **C4L**: `eden~N2` = `pushCheck`, `pushWiden`, `pushCheckSilent`, `pushCheckWaitMs` 10,000, the lab
checker with thinking at effort low (`--check-thinking low`), the embedding table `widen-train-41-48.jsonl.gz`
(checked in, 0.3 MB of ids; short worlds only, a `--days` user's world is not in it, so over days the widening is the
intent and deeper-rank routes alone). A check takes about 7 s, past the harness's 3 s first-observe wait, so the arm
waits for it: **`@w12000`** (the agent's first model call waits up to 12 s for Eden's push). The cost of that wait
is reported in the wall column; a shippable check must be faster (§6). `eden` runs at the default `@w3000`.

- **Short:** `lab_fanout.py --preset bench-tools --seeds 41-48 --args "--conditions eden,eden~N2@w12000 --variants
  hidden,control,neutral --templates <the 40 held-out templates>"`, `--max-streams 72` (two shards at a time).
- **Days:** `--days 8`, users w41–w44, arms `eden`, `eden~N2@w12000`, `eden~N2R@w12000` (N2 plus
  `pushCheckReshow`, H2), `--max-streams 6` (two shards at a time).
- Bars as §1. Every hidden answer and every concern of the paired arms regraded by Sonnet 5.5.

## 6. I3's check landed: H1 behind it, pre-registered before its run

I3 (`claude/i3-push-check`, D500–D502) built the shippable check: one budgeted Haiku call a push, only where the
default's constraint-like gate would hand candidates, no thinking, a reply that lists only the items that change the
action (stop sequence on the first rejection), 15 items of 200 characters; p50 0.9 s and $0.0002 a call in I3's
pilot, against this note's lab checker's 5.8 s and $0.00115. Its "none named, no packet" is H3. This branch merges
it and rebuilds H1 and H2 on it (§1's lab checker and the code that measured §2–§5 are in commit 69ce1942):
`pushWiden` adds, after the pool's head and within the check's 20 items, `pushWidenEmbed` 3 embedding neighbours
(first: they carried most of H1's gains, 17 of 22 facts handed in §2's route split) and `pushWidenIntent` 2 raw
intent hits; `pushWidenDeep` 0 (no facts in §2's split came that way that the other routes did not bring).

**Screen.** `bun run funnel --suite train --seeds 41,42,43,44 -- --neutral --check live --check-cache F`, Haiku live
with I3's settings and `pushCheckWaitMs` 60,000 (every decision the check's), arms K1 (`pushCheck`) and K3
(`pushCheck`, `pushWiden`, `--widen-table`), and the default C0. **Confirmation:** seeds 45–48, I2's held-out
templates, the same arms. **Bars:** §1's H1 bar with K1 for C1 and K3 for C3 (planted handed ≥ +8, ≥ +2 on the
confirmation; decoy handed ≤ +3, ≤ +1; hidden surfaced not lower; neutral packets not more than +5%; K3's decoy
handed ≤ C0's). No live run: the cap does not allow one after §5 (§7's spend).

## 7. Results: live (§5) and H1 behind I3's check (§6)

**Live, short** (Pi on Modal, `lab_fanout.py`, commit 69ce1942: this note's lab checker, effort low, `@w12000`;
train seeds 41–48, I2's 40 held-out templates, hidden, control and neutral; 1,920 task runs; every hidden answer and
every concern regraded by Sonnet 5.5; `bench_report.py --sonnet`, template-clustered intervals):

| `eden~N2` − `eden` | Effect | Interval | Bar |
| --- | --- | --- | --- |
| hidden facts raised (Sonnet) | **+12.5 points** (65.0 vs 52.5, n 320) | +5.6..+19.4 | pass (≥ 0, low end ≥ −3) |
| false concerns, control + neutral (Sonnet) | +0.2 points (1 vs 0 of 640) | +0.0..+0.5 | see below |
| agent $ per 1,000 tasks (check not included) | −0.002 (0.312 vs 0.314) | −0.018..+0.014 | |
| the check's own $ per 1,000 tasks | **+0.98** ($0.94 for 816 calls on 960 tasks) | | reported |
| wall a task | +5.13 s | +4.38..+5.84 | reported |
| `ask_context` calls a task | +0.205 | +0.103..+0.315 | |

The check on Pi: 102 calls a shard, p50 5.5–5.9 s and p90 7.2–7.9 s by shard (each shard's `CHECKER` line), 27.0–28.0
items a call. Haiku's grades read 54.4% → 68.8% hidden and 1 → 8 control and neutral concerns; Sonnet kept 1 of the 8
(`w45 train3-neutral pooled-accounts-banned`). The concern clause ("not up") reads 0 → 1 of 640: up by one, with the
interval's low end at zero. It is the clause D380 failed on (0 → 1); it is recorded as **failed on a literal reading**.

**Live, days** (`--days 8`, users w41–w44, 480 task runs an arm, 46 hidden; the widening there is the intent and
deeper routes only, §5):

| Pair | Hidden (Sonnet) | Concerns (Sonnet) | Agent $/1k (check not included) | Wall |
| --- | --- | --- | --- | --- |
| `eden~N2` − `eden` | **+10.9** (73.9 vs 63.0), −2.0..+24.4 | 0 vs 0 | **−0.036** (−0.045..−0.028) | +4.35 s |
| `eden~N2R` − `eden~N2` (H2) | **−10.9** (63.0 vs 73.9), −22.7..+0.0 | 0 vs 0 | +0.026 (+0.017..+0.035) | +0.02 s |

The check's own cost over days: $0.77 for 772 calls on the two check arms' 960 task runs, **+$0.80 per 1,000 tasks**.
The silent packets cut the agent's input (6,819 → 5,256 tokens a hidden task, Haiku's report), which is why the
agent's cost falls. **H2 fails** (bar ≥ +2 points): with the check gating it, the re-show still loses facts on these
days; the switch is deleted (D512).

**H1 behind I3's check** (§6; funnel, seeds 41–44, Haiku live, I3's settings; K3 replayed on the final tree reads the
same):

| Arm | Hidden surfaced | Decoys surfaced | Planted handed | Decoy handed | Neutral packets |
| --- | --- | --- | --- | --- | --- |
| C0 default | 634 | 552 | 491 | 418 | 617 |
| K1 I3's check | 662 | 565 | 550 | 251 | 213 |
| K3 I3's check + widen | 678 | 591 | 566 | 291 | 238 |

**H1 fails behind I3's check:** planted handed +16, but decoy handed **+40** and neutral packets +25 (bars ≤ +3 and
≤ +5%). 1,887 calls an arm, $0.000201 (K1) and $0.000237 (K3) a call, p50 0.84–0.86 s. No confirmation was run (the
screen failed). The same pattern as §2: a check that does not think lets the widened look-alikes through; the
effort-low check (§4) kept them out.

## 8. What this means

- **H3 (silence) holds with every check measured** (§2, §4, I3's): neutral packets fall 617 → 93–213 with no
  planted fact lost from the packet. It is I3's design; I3's own Pi run decides `pushCheck`.
- **H1 (wider reach) works only behind a check that can tell a fact from its twin.** With thinking at effort low it
  passes every bar on two sets of worlds and raises hidden facts live (+12.5 short, +10.9 over days, with H3); with no
  thinking (this note's prompt or I3's) it adds about as many look-alikes as facts, as every widening before it did.
  The embedding route carried most of it (§2).
- **H2 (re-show) fails** even when gated by the check.
- **Cost and wait are the blocker.** The effort-low check costs about $1 per 1,000 tasks (about three times the agent: $0.98 against $0.31) and
  5–7 s a push; I3's costs $0.2 and under 1 s but cannot gate widening. `pushWiden` stays a trial (off) for a check
  that is both: I3's request with thinking at effort low and its short reply is the first thing to measure
  (**[EST]** about 2–3 s and $0.0004 a call: I3's input, about 300 output tokens).
- **Not measured:** H1 live without H3; the embedding route over days (no table for `--days` worlds); held-out suites.

## 9. Spend

**Anthropic $9.77** of $12 (local ledger `.local/n2/ledger.jsonl` and the shards' ledgers): no-thinking labels
$2.70 (C1 $1.01, C3 $1.69), effort-low labels $2.53 (C3L $2.18, X3L $0.35), I3-check screens $0.83, Pi short $1.65
(check $0.94), Pi days $1.20 (check $0.77), Sonnet regrades $0.86, smokes $0.02. **Modal $0.44** (embedding $0.07,
the two Pi fan-outs $0.37; `modal billing report --for today --json`, by app id).

## Reproduce

```bash
bun run funnel --suite train --seeds 41,...,48 -- --neutral --corpus-dump .local/n2/corpus.jsonl          # $0
modal run packages/sim/modal/n2_embed.py --corpus .local/n2/corpus.jsonl --out .local/n2/widen.jsonl.gz   # $0.07
# §2–§4 used the lab checker at commit 69ce1942 (git checkout 69ce1942), e.g. C3L's labels, then replays:
bun run funnel --suite train --seeds 41,42,43,44 --jobs 16 --set '{"pushCheck":true,"pushCheckWaitMs":60000,
  "pushWiden":true}' -- --neutral --check-cache .local/n2/check-low.jsonl --check-live --check-thinking low \
  --widen-table .local/n2/widen.jsonl.gz --spend-ledger .local/n2/ledger.jsonl --spend-cap 12
python3 -I packages/sim/lab/n2/compare.py --arm C0=base.json --arm C1=C1L.json --arm C2=C2L.json --arm C3=C3L.json \
  --arm C4=C4L.json        # --confirm and --templates (the 40 held-out ones) for seeds 45-48
# §5 live: .local/n2/live.sh and days.sh (lab_fanout.py --preset bench-tools, --variant-config N2/N2R), regrades
# with regrade.ts --graders claude-sonnet-5-5 (--kinds hidden; --only-concerns), bench_report.py --sonnet.
# §6 on this tree (I3's check): --check live|replay --check-cache F, K1 = pushCheck, K3 = + pushWiden --widen-table
```
