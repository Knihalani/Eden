# R10 — experiment ledger (append-only)

Each entry: id, date, hypothesis, setup (command, data, commit), numbers as printed, verdict. Never edited after the fact; corrections are new entries.

---

## C1-E1 · 2026-10-18 · StreamBench built; realism audit of what came before
- **Hypothesis:** the earlier R10 fixtures (LifeBench, R1/R8 pairs) do not meet BRIEF §4, and a stream benchmark played through the real plugin changes the picture.
- **Setup:** `REALISM-AUDIT.md`; `benchmarks/memory-stream/` (plan.py seed 1, AUTHORING.md, 27 author subagents on the session's default model, assemble.py, replay.ts, score.py).
- **Numbers:**
  - code world: 110 sessions, 2,636 events, 493 human turns, 69 need turns (14.0%), non-human share 0.45, 7 action-moment needs. Checker: 2 state, 1 non-human-count and 5 leak flags. The leak flags were inspected: all topic-word overlaps, no answer stated.
  - life world: 160 sessions, 2,991 events, 697 human turns, 98 need turns (14.1%), 57 triggers (33 with needs). Checker: 4 state flags.
- **Verdict:** the earlier fixtures are secondary arms. LifeBench's cue files were never committed. StreamBench is the primary benchmark.

## C1-E2 · 2026-10-18 · Baselines on StreamBench code (dev, plan labels)
- **Setup:** `score.py --world code --split dev`. Oracle store = one clean row per item. Write store = the plugin's rows after replay (2,737 rows, `runs/code-eden`). Sleep store = 375 rows from 11 sonnet sleep compilers (SLEEP-SPEC.md).
- **Numbers (human turns):**

  | System | Recall | Proactive | Precision | Human silence | Tokens |
  |---|---|---|---|---|---|
  | eden (the plugin today, write path) | 0.0909 | 0.0769 | 0.0062 | 0.1042 | 61.7 |
  | lex τ=6 on the write store | 0.1545 | 0.0 | 0.0103 | 0.0774 | 194.5 |
  | lex τ=4 on the oracle store | 0.2121 | 0.0769 | 0.0146 | 0.1994 | 41.1 |
  | lex τ=8 on the oracle store | 0.0879 | 0.0 | 0.0368 | 0.753 | 7.0 |
  | lex τ=4 on the sleep store | 0.2485 | 0.0769 | 0.0139 | 0.1518 | 178.1 |
  | lex τ=4, when=1 on the sleep store | 0.3848 | 0.3846 | 0.0221 | 0.125 | 185.0 |
  | judge (opus) on the sleep store; 165-event sample | 0.8424 | 0.7692 | 0.2367 | 0.5091 | 81.8 |
  | oracle-need on the sleep store | 0.9758 | 0.9231 | 1.0 | 1.0 | 10.6 |
  | oracle-need on the write store | 1.0 | 1.0 | 1.0 | 1.0 | 24.9 |

  - **Eden's bullet classes:** user's own past prompts 523 (65.2%), other items 92, in context 57, untraced 47, tool output 34, stale 20, needed 5 (0.6%).
  - **Eden's latency:** UserPromptSubmit p50 129.8 ms, p99 402.7 ms (n 898) at 2,737 rows. The machine was loaded with about 20 concurrent subagents: unverified on a quiet machine.
  - **Lexical recall by need type (no gate, oracle store):** direct 0.545, indirect 0.15, proactive 0.133, multi 0.25, stale 0.182.
  - **AUC of the max lexical score, need vs no-need human turns:** 0.658 (oracle store), 0.686–0.699 (sleep store).
- **Verdict:**
  1. Lexical retrieval cannot do the silence decision on realistic streams (AUC ≤ 0.70).
  2. The write path loses almost nothing: oracle-need ≈ 1.0 on both the write and sleep stores. The loss is in retrieval and gating.
  3. Compiled `when` cues (F11) raise proactive recall 0.08 → 0.38 at equal silence. F11 lives.
  4. Habituation (F12, hab = 2–4) barely changes silence (0.13 → 0.18–0.26) and costs recall. F12 is weak as a row-level gate. It is kept only as a feature.

## C1-E3 · 2026-10-18 · Label validity: independent labeler vs plan
- **Setup:** label.py, 11 sonnet labelers, strict instruction. Every human turn of the code world.
- **Numbers:** turns 493; plan need turns 69; labeler need turns 176. Items both 71, plan-only 15, labeler-only 224. Labeler recall of the plan 0.826. Labeler-only need turns by plan category: statement 52, task 39, meta 7, paste 5, ack 4, general 2.
- **Verdict:**
  - The plan's needs are confirmed (83% found blind).
  - The broad reading puts 36% of human turns at need, against 8% measured in real use. Strictness must be settled by the downstream-effect check (§4.7).
  - Until then, every result is reported under `plan` and `union` labels.
  - Under union labels, the judge's precision goes from 0.24 to 0.51 and its silence from 0.51 to 0.63.

## C1-E4 · 2026-10-18 · Realism gap found in StreamBench itself
- **Observation:** Eden fires on 90% of no-need human turns here (silence 0.104). R6's real negatives give 39/125 = 31% with the best fix. Packet rate on this benchmark is far above the real one.
- **Candidate causes:** a denser store over a shorter span; author prompts longer than real ones (R6: about 3.5 typed prompts per session, often short); the plugin build differs from the one R6 measured.
- **Verdict:** open. The cycle-2 critic and the red team must check prompt length and lexical density against R6 aggregates.
- **C1-E4 addendum (measured):**
  - Code-world human prompts: median 21 words (p25 14, p75 31). Life: median 26 (p25 17, p75 40).
  - R6 real typed prompts (R6 §3 table): p50 12 words, p90 42; 24.2% of prompts ≤ 3 words.
  - StreamBench prompts are about twice as long as real ones, with too few tiny prompts. This is a confirmed realism gap and a likely cause of the inflated lexical fire rate.
  - Cycle 2 fixes it in the plan (more acks and short prompts) and with a length-calibration rewrite pass, written by a different author, for the next stream version.

## C1-E5 · 2026-10-18 · Correction to C1-E2's Eden bullet classes (critic C1)
- The critic re-ran C1-E2. The counts it got were close to the ledger's, but the ledger omitted three classes, and `trace()` broke ties nondeterministically (set order).
- Fixed: candidates are now sorted before the max.
- Deterministic re-run on dev: user's own past prompts 519 (64.7%), other items 92, in context 57, untraced 47, tool 35, stale 20, assistant 10, allowed 8, notification 7, needed 5 (0.6%), compaction 2.
- **Eden-today CIs (bootstrap, 500 resamples):** recall 0.0909 [0.0182, 0.1724]; silence 0.1042 [0.0712, 0.1339]; precision 0.0062 [0.0012, 0.0121].
- Judge scoring now enforces row visibility at the event (1 of 259 picks was a later row).

## C1-E6 · 2026-10-18 · F4 self-play exemplar bank, and its AND with compiled cues
- **Hypothesis (F4):** prompt-to-exemplar matching beats prompt-to-fact matching. A third model family (haiku, 10 generators) writes the exemplars: 6 situations that need the memory and 6 near misses, per sleep row, from row text only. The generators never see the stream.
- **Kill criterion (pre-run):** dead if it does not beat lex + when by ≥ 0.05 recall at equal silence, or ≥ 0.10 silence at equal recall, on code dev.
- **Leak control:** the critic found the sleep compiler read whole 10-session batches. `--strict` makes a batch's rows visible only after its last session. That is leak-free, and it lowers the oracle-need ceiling to 0.9152.
- **Numbers (strict, dev, plan labels, human turns, 95% CI):**

  | Method | Recall | Proactive | Precision | Silence | Tokens |
  |---|---|---|---|---|---|
  | lex τ=4 | 0.2303 [0.126, 0.350] | 0.0769 | 0.0149 | 0.2232 [0.182, 0.263] | 168.8 |
  | lex τ=4, when=1, gate | 0.3545 [0.226, 0.473] | 0.3077 | 0.0213 | 0.2143 [0.175, 0.255] | 173.2 |
  | bank τ=0.2, gate | 0.4152 [0.293, 0.549] | 0.3077 | 0.0331 | 0.3095 [0.262, 0.355] | 125.7 |
  | bank τ=0.2 ∧ lex+when ltau=2 | 0.3879 [0.264, 0.516] | 0.2308 | 0.0446 | 0.4702 [0.416, 0.524] | 88.8 |
  | bank τ=0.2 ∧ lex+when ltau=4 | 0.3182 [0.199, 0.438] | 0.1538 | 0.0484 | 0.5595 [0.509, 0.615] | 66.4 |

  Non-strict, for reference: bank ∧ ltau=2 gives recall 0.4303, silence 0.4226.
- **Verdict:**
  - F4 passes its kill criterion on silence (+0.26 at equal recall versus lex + when, with no CI overlap).
  - The AND of two kinds of evidence (exemplar similarity, compiled cues) is the new code-world frontier point.
  - Still far from the judge (recall 0.84, silence 0.51) and from realistic silence.
  - Proactive recall falls under the AND (0.31 → 0.23). The two kinds of evidence disagree most on proactive needs.
  - Life world not yet run.
