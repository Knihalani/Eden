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

## C2-E1 · 2026-10-18 · F14 negative-history pruning
- **Hypothesis:** query tokens common in the user's own earlier human turns (unlabeled, mostly no-need) are not evidence. Dropping them raises silence.
- **Kill criterion (pre-run):** silence +0.20 absolute at recall ≥ 0.30.
- **Numbers (code dev, strict, coverage v1):**

  | Method | Recall | Silence |
  |---|---|---|
  | lex+when, neghist 0.05 | 0.3212 | 0.2381 |
  | lex+when, neghist 0.02 | 0.3121 | 0.3065 |
  | lex+when, neghist 0.01 | 0.2636 | 0.4018 |
  | base (no pruning) | 0.3545 | 0.2143 |
  | bank, neghist 0.05 | 0.3455 | 0.3423 |
  | bank ∧ lex, neghist 0.05 | 0.3333 | 0.5327 |
  | bank ∧ lex, neghist 0.02 | 0.2303 | 0.6071 |

- **Verdict: dead as a mechanism (graveyard).** At recall ≥ 0.30 the best silence gain is +0.09. It moves along the existing frontier, not past it.

## C2-E2 · 2026-10-18 · Coverage rule v2 (critic C1 fix #1)
- **Setup:** 200 bullets (100 Eden packet bullets, 100 sleep rows), 1,245 bullet–item pairs. A sonnet judge said which items each bullet conveys.
- **Agreement with the judge:**

  | Rule | κ | Precision | Recall |
  |---|---|---|---|
  | v1: plain share ≥ 0.5 | 0.609 | 0.49 | 0.97 |
  | plain share ≥ 0.7 | 0.836 | — | — |
  | v2: idf-weighted ≥ 0.6 | **0.859** | 0.843 | 0.901 |

  v1 over-credited coverage, so every recall and precision number was inflated.
- **Re-scored (code dev, strict, v2, 95% CI):**

  | Method | Recall | Proactive | Precision | Silence |
  |---|---|---|---|---|
  | eden (write store) | 0.0909 [0.018, 0.172] | 0.0769 | 0.0062 | 0.1042 |
  | lex+when | 0.2758 [0.159, 0.389] | 0.1538 | 0.0170 | 0.2143 |
  | bank | 0.3364 [0.217, 0.461] | 0.1538 | 0.0284 | 0.3095 |
  | bank ∧ lex ltau=2 | 0.3273 [0.208, 0.446] | 0.1538 | 0.0395 | 0.4702 |
  | bank ∧ ltau=4 | 0.2939 | 0.1538 | 0.0461 | 0.5595 |
  | judge (visibility enforced) | 0.6909 [0.576, 0.795] | 0.4615 | 0.2552 | 0.6364 [0.558, 0.726] |
  | oracle-need (strict) | 0.8242 | 0.6154 | 1.0 | 1.0 |

- **Verdict:**
  - All later numbers use v2. The C1 tables above stay as written; they were measured under v1.
  - The frontier ordering survives the fix.
  - The extraction ceiling of the sleep store is 0.82, not 0.92: compiled rows paraphrase.
  - v2 is calibrated on code only. It must be re-checked on life.

## C2-E3 · 2026-10-18 · F15 situation tracking (phrase entry into the session)
- **Kill criterion (pre-run):** proactive + action recall < 0.30, or human silence < 0.60.
- **Numbers (code dev, strict, coverage v2):**

  | τ | Recall | Proactive | Silence | Action recall |
  |---|---|---|---|---|
  | 3 | 0.3121 | 0.0769 | 0.372 | 0.0 |
  | 5 | 0.2121 | 0.0769 | 0.4821 | 0.0 |
  | 6 | 0.1758 | 0.0769 | 0.7054 | 0.0 |

- **Verdict: dead as a standalone** (proactive 0.08). It is kept as one vote, because its silence comes from session state, not from lexical match.

## C2-E4 · 2026-10-18 · Three-detector vote (bank, lex+when, situation); paste stripping; informing-turn gate (F5)
- **Numbers (code dev, strict, plan labels):**

  | Method | Recall | Proactive | Silence | Precision |
  |---|---|---|---|---|
  | vote need=2, bt .25, lt 6, st 4 | 0.3121 | 0.2308 | 0.5089 | 0.0373 |
  | + strip | 0.3212 | — | 0.5208 | — |
  | + stmt | 0.2394 | — | 0.619 | — |
  | + strip + stmt | 0.2485 | — | 0.631 | — |
  | vote need=3 | 0.297 | — | 0.5833 | — |

- **False fires of the vote, by negative category:** statement 68/108, task 55/94, other project 17/19, paste 13/15, ack 0/34, general 3/30.
- **Eden's, for comparison:** statement 106/108, task 92/94, general 30/30, ack 6/34.
- **Verdict:**
  - Every heuristic combination sits on one curve: about 0.30 recall at 0.50–0.63 silence.
  - Paste stripping is a free small gain and is kept.
  - The statement gate only trades recall for silence.
  - This is the local-optimum signature. The decision needs a better judge of need, not more lexical evidence.

## C2-E5 · 2026-10-18 · F13 agent-pull: the host model calls `recall(query)` against a memory index
- **Setup:**
  - The judge sample (165 human, 30 non-human events).
  - A sonnet host sees the turn, recent context and a 30-phrase memory index, then decides whether to call and with what query.
  - A call runs lex+when on the strict sleep store and returns the top k rows.
- **Kill criterion (pre-run):** calls on > 25% of no-need human turns, or recall < 0.38.
- **Numbers (95% CI):**

  | Labels | Method | Recall | Proactive | Precision | Silence | Non-human silence | Tokens |
  |---|---|---|---|---|---|---|---|
  | plan | pull k=2 | 0.4667 [0.344, 0.587] | 0.2308 | 0.2025 [0.147, 0.266] | 0.7364 [0.656, 0.816] | 1.0 | 49.0 |
  | plan | pull k=4 | 0.5273 | — | 0.1338 | 0.7364 | — | — |
  | plan | judge, same events | 0.6909 | 0.4615 | 0.2552 | 0.6364 | — | — |
  | union | pull k=2 | 0.3367 | — | 0.3291 | 0.8171 | — | — |
  | union | judge | 0.6574 | — | 0.5156 | 0.7805 | — | — |

  Calls: 82 of 195 moments.
- **Verdict: alive, borderline on its kill line** (fires on 26.4% of no-need human turns, against the 25% bar).
  - Precision is 5× the best hook-side method, and silence is +0.27.
  - Retrieval after the call is plain lexical, which loses recall: the judge picks from the same store with 0.69.
  - **Cost:** the host model already reads every turn. The added cost is the index in context (about 150 tokens) and one tool round-trip on about 40% of moments. The hook stays model-free (D15 holds).
  - This changes the architecture question from "what should the hook inject" to "what should the hook push, and what should the model pull".

## C2-E6 · 2026-10-18 · Eden today on the life world (write path)
- **Replay:** 160 sessions, 7,037 hook events, 6,392 invocations, 0 non-zero exits, 0 timeouts. Store 3,633 rows. UserPromptSubmit p50 159.8 ms, p99 425.4 ms (n 1,315), measured with concurrent subagent load: unverified on a quiet machine.
- **Numbers (dev, plan labels, coverage v2):**

  | Method | Recall | Proactive | Precision | Human silence | Trigger recall | Trigger silence | Non-human silence | Tokens |
  |---|---|---|---|---|---|---|---|---|
  | eden | 0.0443 [0.006, 0.092] | 0.0435 | 0.0033 | 0.0503 [0.032, 0.070] | 0.0 | 0.0 | 1.0 | 74.5 |
  | lex τ=6 (write) | 0.1624 | — | — | 0.0382 | — | — | — | — |
  | oracle-need (write) | 0.9937 | — | — | — | — | — | — | — |

- **Eden's bullets:** user's own past prompts 58.7%, other items 18.8%, earlier triggers re-injected 8.4%, needed 0.3%.
- **Verdict:** today's plugin is worse on the personal world than on code. It fires on 95% of no-need human turns and on every trigger, but surfaces none of the triggers' needs.

## C2-E7 · 2026-10-18 · F4 bank and the vote on the life world
- **Setup:** 611 life sleep rows, haiku self-play for all of them (16 batches). Strict, dev, plan labels, coverage v2.
- **Numbers:**

  | Method | Recall | Proactive | Silence | Trigger recall |
  |---|---|---|---|---|
  | oracle-need (strict) | 0.6667 | 0.6522 | 1.0 | 0.9231 |
  | lex+when | 0.2321 | 0.0435 | 0.165 | 0.1154 |
  | bank τ=0.2 | 0.2278 | 0.087 | 0.326 | 0.1538 |
  | bank τ=0.3 | 0.0865 | — | 0.6982 | — |
  | bank ∧ lex ltau=4 | 0.2025 | 0.087 | 0.5171 | 0.1154 |
  | vote (bt .25, lt 6, st 4, strip) | 0.2152 | — | 0.4567 | — |

- **Verdict:**
  - F4 transfers on silence (+0.16 at equal recall versus lex+when, which passes its kill line on both worlds).
  - Life proactive recall stays below 0.09, and trigger recall at or below 0.15. No hook-side method handles triggers.
  - The strict life ceiling is 0.67: long 10-session batches delay rows across months. Leak-free per-session compilation would raise it.

## C2-E8 · 2026-10-18 · Life judge ceiling and F13 agent-pull on the life world
- **Setup:**
  - 10 opus judge batches on the strict life sleep store.
  - Sample: 79 need events (human and trigger), plus 110 no-need human or trigger events and 30 non-human events.
  - Agent-pull: sonnet hosts on the same moments; 107 calls of 245.
- **Numbers (dev, plan labels, coverage v2, 95% CI):**

  | Method | Recall | Proactive | Precision | Human silence | Trigger recall | Trigger silence | Non-human silence | Tokens |
  |---|---|---|---|---|---|---|---|---|
  | judge | 0.5696 [0.471, 0.658] | 0.5217 | 0.2385 | 0.6481 [0.551, 0.741] | 0.5 | 0.5 | 0.9 | 66.9 |
  | pull k=2 | 0.2869 [0.201, 0.385] | 0.2174 | 0.1677 | 0.8426 [0.774, 0.905] | 0.1923 | 0.5 | 0.8667 | 39.6 |
  | pull k=4 | 0.346 [0.25, 0.445] | — | 0.1129 | — | 0.2308 | — | — | 78.6 |

  For comparison, the best hook-side point on life (bank ∧ lex ltau=4) is recall 0.2025, proactive 0.087, precision 0.0308, silence 0.5171.
- **Verdict:**
  - F13 holds on both worlds. On life it is +0.08 recall, +0.33 silence and 5× precision over the best hook-side method.
  - The life judge ceiling is lower than code's (0.57 vs 0.69 recall). Personal needs are harder even for a strong model with the whole store.
  - The pull's retrieval step (lexical on its query) is the weak half: recall about half the judge's.
  - Life has no independent labeler run yet, so union = plan.

## C3-E1 · 2026-10-18 · Corrections from critic C2 (`R10/critic-c2.md`)
- **Same-event comparison** (`score.py --sample judge`, code dev, strict, plan labels; 165 human events):

  | Method | Recall | Precision | Silence | Precision at 8% base | False-packet rate |
  |---|---|---|---|---|---|
  | bank ∧ lex ltau=2 | 0.3273 | 0.0796 | 0.4909 | 0.0233 | 0.5091 |
  | vote + strip | 0.3121 | 0.0816 | 0.5545 | 0.0245 | 0.4455 |
  | pull k=2 | 0.4667 | 0.2025 | 0.7364 | 0.0738 | 0.2636 |
  | judge | 0.6909 | 0.2552 | 0.6364 | 0.0886 | 0.3636 |

  - C2-E5's "5× precision, +0.27 silence" compared a sample (1:2 need to no-need) with full dev (1:6). On the same events the gain is 2.5× precision and +0.18 silence (code). The critic measured life at 2.1× and +0.26.
  - **At an 8% base rate, pull's bullets are still 93% unneeded.**
- **F13's pre-registered kill line:**
  - The host called on 31/110 = **28.2%** of no-need code turns. That is above the 25% bar, so **F13 is dead on code by its own criterion.** C2-E5's 26.4% was the false-packet rate: 2 calls returned no rows.
  - Life: 18/108 = 16.7%, which passes.
  - The call *gate* stays valuable. It calls on 93% of code need turns. Judge picks gated by the pull call reach recall 0.6545 at silence 0.8273 on code (critic's run). This becomes a teacher for D1, below.
- **Cost recount:**
  - The memory index (p50 97 tokens code, 111 life) sits in every turn's context, so pull's per-event context cost is about 146 tokens on code, against 89.7 for bank ∧ lex.
  - Calls are extra model steps on about 33% of human turns at an 8% base rate.
- **Determinism:** `Vote`, `Bank` and `Situation` ordered ties by set iteration. Fixed: ties are now broken by row id.
  - Vote + strip, deterministic: recall 0.3121, precision 0.0394, silence 0.5208, identical under PYTHONHASHSEED 0/1/2.
  - This replaces C2-E4's 0.3212 / 0.5208. bank ∧ lex re-run: precision 0.0393, silence 0.4643, tokens 89.68 (C2-E2 said 0.0395 / 0.4702 / 88.8).
- **Text fix:** C2-E8's sample has 79 human need events plus 26 trigger need events, not "79 need events (human and trigger)".
- **Process fixes:** LOOKS.md created (no test look has ever been made). Model-step prompts committed in `benchmarks/memory-stream/PROMPTS.md`.

## C3-E2 · 2026-10-18 · F16 distilled need gate (cross-world)
- **Setup:** `methods_gate.py`. Logistic regression on 9 cheap features: stripped length, ask, request, informing, trigger, index hits, session novelty, best bank score, best lexical score.
  - Trained on one world's teacher decisions: pull call, or judge non-empty.
  - Tested on the other world's dev human and trigger turns against plan labels.
- **Kill criterion (pre-run):** AUC vs plan labels < 0.80.
- **Numbers (AUC):**

  | Train → test | Teacher | AUC | Positive / negative turns |
  |---|---|---|---|
  | life → code | pull | 0.659 | 55 / 336 |
  | life → code | judge | 0.673 | 55 / 336 |
  | code → life | pull | 0.639 | 105 / 514 |
  | code → life | judge | 0.627 | 105 / 514 |

- **Verdict: dead.**
  - Cheap structural and lexical features cap the need decision at AUC ≈ 0.63–0.70, which is the same ceiling as the raw lexical max score (C1-E2).
  - The model judges it well: the pull gate calls on 93% of code need turns.
  - The need decision needs semantics. Either a model in the loop (pull, or a warm daemon: a D15 question) or semantic features cheap enough for the hook.

## C3-E3 · 2026-10-18 · F19 static word vectors; Eden on length-calibrated prompts
- **F19 setup:** spaCy en_core_web_md vectors (20k × 300, from GitHub releases; not committed). idf-weighted mean over self-play exemplars. The test is the AUC of the turn's max score, need vs no-need, on dev human and trigger turns (strict).
- **Kill criterion (pre-run):** AUC < 0.75.
- **F19 AUC by negative-exemplar penalty m:**

  | World | m = 0 | m = 0.5 | m = 1 |
  |---|---|---|---|
  | code | 0.663 | 0.636 | 0.593 |
  | life | 0.615 | 0.564 | 0.512 |

- **Verdict: dead.**
  - Five hook-side mechanisms now cap near AUC 0.66–0.70 for "does this turn need memory?": lexical, exemplar, situation, distilled gate (C3-E2) and static vectors.
  - On these streams the need decision is not available from surface or static-semantic features.
- **StreamBench v1.1 (code-short):** prompts rewritten by sonnet to p50 15 words (was 21); prompts ≤ 3 words are 9.5%, against R6's 24%. The calibration is partial.
- **Eden on v1.1 (dev, write store):**

  | Stream | Recall | Silence | Precision | Store rows | UPS p50 / p99 |
  |---|---|---|---|---|---|
  | code-short | 0.0727 [0.017, 0.154] | 0.1161 [0.079, 0.145] | 0.0049 | 2,784 | 148.4 / 602.7 ms (loaded machine) |
  | code (v1) | 0.0909 | 0.1042 | — | — | — |

- **Verdict:** shorter prompts barely change Eden's false-fire rate (89% → 88%), so prompt length does not explain the gap with the real 31% (C1-E4). Next suspect: the real 31% was measured with P4.3's evidence gate, which is in shadow by default. A replay with `EDEN_FLAG_GATE_TAU=on` is running.

## C3-E4 · 2026-10-18 · Downstream effect (BRIEF §4.7), code world
- **Setup** (`downstream.py`, dev human turns): 60 turns (30 plan-need, 15 labeler-only need, 15 no-need).
  - Conditions: no memory; oracle packet (plan ∪ labeler needs, empty on no-need turns); system = vote (bt .25, lt 6, st 4, strip).
  - Responder: sonnet, one run per condition, the order shuffled per turn.
  - Judge: opus, blind to condition, sees the world's reference facts at that time, scores 0–3.
- **Numbers:**

  | Group | n | Mean score: none / oracle / system | Oracle − none | Share with effect ≥ 1 | System − none |
  |---|---|---|---|---|---|
  | plan | 30 | 1.90 / 2.87 / 2.20 | +0.967 | 0.80 | +0.30 |
  | labeler-only | 15 | 2.33 / 2.87 / 2.33 | +0.533 | 0.533 | 0.0 |
  | no-need | 15 | 2.93 / 2.67 / 2.53 | −0.267 | 0.067 | −0.40 |

  Effect distribution (oracle − none):
  - plan: −1: 1, 0: 5, +1: 18, +2: 6
  - labeler-only: 0: 7, +1: 8
  - no-need: −2: 2, −1: 1, 0: 11, +1: 1 (the oracle packet is empty here, so this is responder and judge noise)
- **Verdict:**
  1. **Plan labels are valid.** Memory changes the outcome on 80% of plan-need turns. The noise floor, measured on no-need turns, is about 7% for "effect ≥ 1".
  2. **About half of the labeler-only needs are real but mild** (mean +0.53). True need is between the plan's and the union's. The plan stays the primary label. Union becomes a lenient secondary.
  3. **Wrong bullets hurt outcomes:** the vote packet is −0.40 on no-need turns. Precision and silence are outcome metrics, not only token costs.
  4. **A hook-side packet keeps only about 30% of the available benefit** on need turns: +0.30 of +0.97.
- **Caveats:** one responder run per condition; n = 15 per small group; all models are Claude.

## C3-E5 · 2026-10-18 · Eden with P4.3's evidence gate on (`EDEN_FLAG_GATE_TAU=on`), code world
- **Replay:** 110 sessions, 0 non-zero exits, store 2,737 rows, 500 packets (default flags: 548). UPS p50 216.1 ms, p99 591.2 ms on a loaded machine: unverified.
- **Numbers (dev, write store):**

  | Flags | Recall | Proactive | Precision | Silence | Tokens |
  |---|---|---|---|---|---|
  | gate.tau = on | 0.0818 [0.015, 0.167] | 0.0 | 0.0089 | 0.2054 [0.162, 0.246] | 46.1 |
  | default (shadow) | 0.0909 | 0.0769 | 0.0062 | 0.1042 | 61.7 |

- **Verdict:**
  - The gate doubles silence at equal recall. It still fires on 79% of no-need human turns, against the real-negative 31% (C1-E4).
  - Length (C3-E3) and the gate together do not close the gap.
  - Remaining suspect: the negative mix. Acks are 10% of our dev no-need turns, while real prompts are 24% tiny. Next is the plan's ack share.
  - The P4.3 configuration is the fairer incumbent and is listed as such from now on.

## C3-E6 · 2026-10-18 · Blank-slate system (BRIEF §5 rule 3) and its budgeted-firing gate
- **Setup:** an independent designer with no access to STATE, LEDGER, methods or the sleep/self-play/judge artifacts built `methods_blank.py` (`BLANK-C3.md`):
  - a statement compiler over write-path rows;
  - an encoding-context index;
  - episode feedback;
  - leak-free LSA;
  - prompt gates;
  - budgeted firing.
  The designer reported that it read dev labels for aggregate diagnostics and about 20 examples (a tuning risk, disclosed).
- **Numbers (its report, dev):**

  | World / store | Recall | Precision | Silence | Tokens |
  |---|---|---|---|---|
  | code / write | 0.0364 | 0.0057 | 0.7768 | 32.4 |
  | code / oracle | 0.2242 | 0.0644 | 0.8542 | 12.8 |
  | life / write | 0.0738 | 0.0166 | 0.8109 | 27.2 |
  | life / oracle (LSA) | 0.1266 | 0.0312 | 0.829 | 22.7 |

  Its ranking ceiling with no gate: about 0.26–0.29 recall@4 on the code oracle store and about 0.35 on life.
- **Comparison:** below the current hook frontier in recall, above it in silence; a different point on the same curve.
- **Convergence:** it concluded independently that "the lexical/statistical family tops out at about 0.3 recall@4". The two levers it named are a sleep-time model writing the situations that need each memory, and a sleep-time statement compiler. Those are F4 and F11, which the main line already has. That is evidence the plateau is real, not path-dependent.
- **New mechanism adopted: budgeted firing.** A turn fires only when its evidence beats the q-quantile of the user's earlier turns. Added as `budget=q` to `lex`, `bank` and `vote`.

  | World | Method | Recall | Silence | Precision |
  |---|---|---|---|---|
  | code | vote bt .2, lt 4, st 3, strip, budget .7 | 0.2939 | 0.6161 | 0.0333 |
  | code | vote, budget .85 | 0.1879 | 0.7649 | — |
  | code | bank ∧ lex, budget .7 | 0.2697 | 0.6071 | — |
  | life | vote, budget .7 | 0.1751 | 0.6237 | 0.0202 |
  | life | vote, budget .85 | 0.0992 | 0.7887 | — |

  Code moves out about +0.1 silence at similar recall. Life stays on the frontier.
- **Verdict:** budgeted firing is kept as a per-user calibration of the packet rate. It is not a breakthrough. The blank-slate cycle confirms the semantic wall.

## C3-E7 · 2026-10-18 · Review corrections (independent PR reviewer, APPROVE)
- C3-E4's "wrong bullets hurt outcomes (−0.40)" overstates it. The empty oracle condition scores −0.267 on the same no-need turns, which is noise, so the packet's own effect is about −0.13 (n 15, one responder run). The verdict becomes "suggestive"; re-measure at a larger n.
- The harness edit (an optional `text` on Write specs in `benchmarks/memory-long-horizon/harness/shape.ts`) changes `harness_sha` from 07f8ef6d… to 2eecf75e…. Any slice pre-registered against main's harness amends its prereg visibly. None is in progress.

## C4-E1 · 2026-10-19 · F20 per-user need model from the user's own history
- **Setup:** `methods_hist.py`. History labels come from the independent labeler (sonnet). They are used causally: only sessions that ended before the turn's session.
  - A turn is matched by idf cosine against each memory's past needing turns; oracle store.
  - Scored against the plan's labels, which the labeler never saw.
- **Kill criterion (pre-run):** AUC < 0.75.
- **Numbers (code dev):**

  | What | Result |
  |---|---|
  | AUC, max score vs plan labels (all dev) | 0.647 (55 / 336) |
  | AUC, later half of the stream only | 0.618 (40 / 172) |
  | τ 0.25 | recall 0.0364, silence 0.9256 |
  | τ 0.35 | recall 0.0182, silence 0.9702 |

- **Verdict: dead.**
  - A memory is needed once or twice in a stream, so history gives almost no positives.
  - Two turns that need the same memory rarely share words.
  - Learning from history does not escape the lexical wall. The understanding has to come from a model, not from comparing texts.

## C4-E2 · 2026-10-19 · F21 anticipation: the next turn's packet prepared before the turn arrives
- **Setup:** `anticipate.py`. On the judge-sample moments, a sonnet model sees only the turns *before* the moment and the store. It writes at most 4 predicted rows, each with trigger phrases (the `if` field) or an always-on flag.
  - At hook time the cost is a phrase check, with no model.
  - `mode=all` fires every prediction.
  - Strict sleep store, dev.
- **Process note:** no kill criterion was written before this run. That is an omission against BRIEF §5 rule 6, recorded here. The verdict below uses the F13/F16 lines after the fact.
- **Numbers (same events as judge and pull):**

  | World | Labels | Method | Recall | Proactive | Precision | Silence | Tokens | Precision at 8% |
  |---|---|---|---|---|---|---|---|---|
  | code | plan | antic (condition check) | 0.2152 | 0.0769 | 0.2429 | 0.8636 | 22.2 | **0.0974** |
  | code | plan | antic, mode=all | 0.2152 | — | 0.1314 | 0.6909 | — | 0.0417 |
  | code | plan | pull k=2 | 0.4667 | — | 0.2025 | 0.7364 | — | 0.0738 |
  | code | plan | judge | 0.6909 | — | 0.2552 | 0.6364 | — | 0.0886 |
  | code | plan | vote | 0.3848 | — | 0.0695 | 0.4182 | — | 0.0201 |
  | code | union | antic | 0.1787 | — | 0.4286 | 0.8537 | — | 0.1147 |
  | life | plan | antic | 0.0464 | 0.0 | 0.0833 | 0.8333 | — | 0.0227 |
  | life | plan | antic, mode=all | 0.0464 | — | — | 0.6296 | — | — |
  | life | plan | antic trigger recall | 0.0 | — | — | — | — | — |
  | life | plan | pull k=2 | 0.2869 | — | — | 0.8426 | — | — |

- **Verdict:**
  - **Code: alive as a high-precision lane.** It has the best realistic-base-rate precision of any system, the judge included, with no model on the hook. Recall is low (0.22) and proactive recall lower (0.08).
  - **Life: dead.** The next moment's needs are not predictable from what came before. Even firing every prediction reaches 0.05 recall, and trigger recall is 0.
  - Coding work is continuous, so it is predictable. A personal assistant's moments are mostly new topics.
- **Life labels (independent labeler):** 754 turns. Plan need turns 131, labeler need turns 296. Items: both 123, plan-only 36, labeler-only 455. Labeler recall of the plan 0.774. The same pattern as code: the plan is confirmed, and the labeler is about 2× more lenient.

## C4-E3 · 2026-10-19 · Action-time cue (F18-lite): the agent's planned tool calls join the cue at the first PreToolUse
- **Leak check:** in no need turn (69 code, 98 life) do the agent's tool inputs already state a needed item at coverage ≥ 0.6.
- **Kill criterion (pre-run):** dead if neither world gains ≥ 0.05 recall at equal silence.
- **Numbers (dev, strict, plan labels; without → with act=1):**

  | World | Method | Recall | Silence |
  |---|---|---|---|
  | code | vote | 0.3848 → 0.4152 | 0.3839 → 0.3363 |
  | code | bank ∧ lex | 0.3273 → 0.2394 | 0.4702 → 0.5685 |
  | code | lex+when | 0.2758 → 0.3485 | 0.2143 → 0.1994 |
  | life | vote | 0.2257 → 0.2004 | 0.2938 → 0.2676 |
  | life | bank ∧ lex | 0.1962 → 0.1709 | — |
  | life | lex+when | 0.2321 → 0.2152 | — |

  Proactive recall is unchanged everywhere.
- **Verdict: dead in this lexical form.**
  - The agent's commands add as much noise as signal for these matchers.
  - The gain on code lex (+0.07 recall at −0.015 silence) does not carry over to life.
  - An action check with structure (tool name and arguments against a memory's rule, as the guard does) is a separate question. The policy-guard work (P2.x, P8.4) covers it.

## C4-E4 · 2026-10-19 · Red-team round 1 (fresh split; BRIEF §5 rule 5)
- **Setup:** an independent red-team author per world (session default model, a new instance) wrote 12 sessions continuing each timeline.
  - Mostly short, elliptic needs; proactive and multi needs; hard negatives.
  - The author gave explicit labels.
  - `redteam.py` builds `code-rt1` and `life-rt1`; scored with `--split fresh`, strict sleep store.
- **Size:**

  | World | Need / human (+trigger) events | Prompt words p50 | Triggers (with needs) |
  |---|---|---|---|
  | code-rt1 | 29 / 74 | 8 | — |
  | life-rt1 | 23 / 57 human; 36 / 81 with triggers | 7 | 24 (13) |

- **Numbers (fresh):**

  | World | Method | Recall | Proactive | Precision | Silence | Trigger recall / silence |
  |---|---|---|---|---|---|---|
  | code | lex+when | 0.2552 | 0.5 | 0.0691 | 0.3111 | — |
  | code | bank ∧ lex | 0.1897 | — | — | 0.4444 | — |
  | code | vote | 0.2943 | 0.3333 | 0.1 | 0.4667 | — |
  | code | vote + budget .7 | 0.2184 | — | 0.1075 | 0.7111 | — |
  | code | oracle-need | 1.0 | — | — | — | — |
  | life | lex+when | 0.1159 | — | — | 0.2353 | — |
  | life | bank ∧ lex | 0.163 | — | — | 0.2941 | — |
  | life | vote | 0.1775 | 0.25 | 0.0678 | 0.3235 | 0.2308 / 0.0909 |
  | life | oracle-need | 0.9022 | — | — | — | trigger recall 0.9615 |

- **Verdict:**
  - Code: frozen-set results roughly hold on fresh, shorter prompts (frozen vote 0.38 / 0.42, fresh 0.29 / 0.47).
  - Life: the matchers degrade on fresh cases (silence 0.24–0.32, against 0.29–0.52 frozen).
  - The cases are fair: oracle-need reaches 0.90–1.0.
  - Small n: 29 and 23 human need events.

## C4-E5 · 2026-10-19 · F22 deferred in-turn verification (push, with a model off the hook)
- **Setup:** `verify.py`.
  - At Submit the hook takes up to 15 candidates from lex+when and the bank (no model) and delivers nothing.
  - haiku (a third model family) checks the candidates.
  - The packet is delivered at the turn's first PreToolUse or PostToolBatch; a turn with no tool call gets nothing. `ideal=1` delivers at Submit as an upper bound.
  - Same judge-sample events, strict sleep store, dev.
- **Kill criterion (pre-run):** dead if, on both worlds, it does not beat the hook vote by ≥ +0.15 silence at equal or better recall.
- **Candidate ceiling** (share of plan needs among the 15 candidates): code 0.597 (55 events), life 0.3778 (105 events).
- **Numbers (plan labels; recall CI for code verify [0.348, 0.595]):**

  | World | Method | Recall | Proactive | Precision | Silence | Tokens | Precision at 8% | Trigger recall / silence |
  |---|---|---|---|---|---|---|---|---|
  | code | verify (deferred) | 0.4758 | 0.3077 | 0.2086 | 0.6636 | 55.2 | 0.0728 | — |
  | code | verify, ideal | 0.5121 | — | — | 0.6455 | — | — | — |
  | code | vote | 0.3848 | 0.2308 | 0.0695 | 0.4182 | — | — | — |
  | code | pull k=2 | 0.4667 | 0.2308 | 0.2025 | 0.7364 | — | — | — |
  | code | judge | 0.6909 | 0.4615 | 0.2552 | 0.6364 | — | — | — |
  | life | verify (deferred) | 0.2553 | 0.1739 | 0.1689 | 0.7222 | 38.0 | 0.0496 | 0.2308 / 0.0 |
  | life | verify, ideal | 0.3397 | — | — | 0.6019 | — | — | — |
  | life | vote | 0.2257 | — | 0.0494 | 0.3426 | — | — | — |
  | life | pull k=2 | 0.2869 | — | — | 0.8426 | — | — | — |
  | life | judge | 0.5696 | — | — | 0.6481 | — | — | — |

  Union labels, code verify: recall 0.4169, precision 0.3865, silence 0.7317.
- **Verdict: alive. It is the strongest push system, and it passes its kill line on both worlds.**
  - Code: +0.09 recall and +0.25 silence over the vote, at 3× the precision. It matches pull's recall and beats it on proactive needs (0.31 vs 0.23), with no help from the agent and no model on the hook.
  - Life: +0.38 silence and 3.4× precision over the vote.
  - Gaps:
    - candidate recall (life ceiling 0.38);
    - deferral loss on life (many moments have no tool call: 0.34 → 0.26);
    - trigger silence 0.0: the verifier fires on routine triggers.

## C4-E6 · 2026-10-19 · Critic C4 corrections (see critic-c4.md)
- **C4-E4 config:** the lex rows of C4-E4 used `lex:tau=4,when=1,gate=1`, not `lex:when=1`. Re-run this session with that config, it reproduces the ledger exactly:
  - code-rt1: 0.2552 / 0.5 / 0.0691 / 0.3111;
  - life-rt1: 0.1159 / 0.05 / 0.0414 / 0.2353.
  From now on every ledger row names its exact system string.
- **F22 caveats the critic raised, all accepted:**
  - The no-tool-call delivery rule gates silence. On life, 47 of 108 no-need turns have no tool call, against 18 of 79 need turns. Part of F22's silence comes from the delivery rule, not from the verifier.
  - Verifier batches held 50 cases from across the stream, so the verifier could see later turns in the same batch. This is a possible future leak. A leak-free re-run (stream order, one case per call, prompt committed) is still owed.
  - Precision at an 8% base rate equals pull's (0.0728 vs 0.0738).
  - Trigger silence rests on n=2 negatives.
  - Latency and PreToolUse injection semantics are unmeasured.
  - F22 is not yet scored on the red-team worlds.
  - Errors are correlated within one model family: when haiku fires on a no-need turn, the judge fires too 74% (code) and 58% (life) of the time.

## C4-E7 · 2026-10-19 · Critic direction A: store-wide haiku verifier (no lexical candidate stage)
- **Setup:** `judge:tag=haiku`. haiku sees the turn plus the whole strict sleep store visible at that moment. The cases are the same judge-sample events (code 165, life 187 human), on dev. `defer=1` applies F22's delivery rule (nothing on a turn with no tool call).
  - **Deviation from the critic's design:** 15 cases per call, not one per call. Input tokens after caching were not measured.
  - **System string:** `judge:tag=haiku judge:tag=haiku,defer=1 verify judge pull:k=4`, run as `score.py --store sleep --strict --split dev --sample judge --ci`.
- **Kill (critic C4, set before this scoring):** dead if life recall < 0.42 at ideal delivery, or human silence < 0.60.
- **Numbers (plan labels):**

  | World | System | Recall | Proactive | Precision | Silence | Tokens |
  |---|---|---|---|---|---|---|
  | code | haiku whole-store (ideal) | 0.5515 | 0.3077 | 0.2176 | 0.6364 | 60.1 |
  | code | haiku whole-store (deferred) | 0.497 | 0.3077 | 0.2061 | 0.6364 | 58.6 |
  | code | F22 verify (deferred) | 0.4758 | 0.3077 | 0.2086 | 0.6636 | 55.2 |
  | code | opus judge | 0.6909 | 0.4615 | 0.2552 | 0.6364 | 65.0 |
  | code | pull k=4 | 0.5273 | 0.2308 | 0.1338 | 0.7364 | 100.5 |
  | life | haiku whole-store (ideal) | 0.3586 | 0.1739 | 0.1878 | 0.5556 | 50.2 |
  | life | haiku whole-store (deferred) | 0.2595 | 0.1304 | 0.2029 | 0.7037 | 34.5 |
  | life | F22 verify (deferred) | 0.2553 | 0.1739 | 0.1689 | 0.7222 | 38.0 |
  | life | opus judge | 0.5696 | 0.5217 | 0.2385 | 0.6481 | 66.9 |
  | life | pull k=4 | 0.346 | 0.2174 | 0.1129 | 0.8426 | 78.6 |

- **Verdict: dead by its kill line.** Life recall is 0.3586 (< 0.42) and life silence 0.5556 (< 0.60).
  - Deferred, it ties F22 on both worlds: recall +0.02 / +0.004, silence −0.03 / −0.02.
  - So the lexical shortlist barely limits F22. The small model's understanding is the limit: opus with the same view gets +0.14 / +0.21 recall.
  - Next: a bigger verifier off the hook (cost and latency), or the draft check (direction B), which also fixes no-tool turns.

## C4-E8 · 2026-10-19 · Critic direction B: the draft check (pre-registration)
- **Setup:** `draftcheck.py`.
  - The turns and drafts are C3-E4's 60 code downstream turns: 30 plan-need, 15 labeler-only, 15 no-need. Each draft is the `none` response, written with no memory.
  - The checker (haiku; prompt in PROMPTS.md) sees the turn, the recent context, the draft and F22's shortlist (≤ 15 rows, strict sleep store). It reads one case per file, in stream order.
  - A blocked draft is revised by sonnet with the note and rows. The opus judge scores none / oracle / revised blind, on the blocked turns. An unblocked turn counts revised − none = 0.
- **Candidate ceiling:** plan 0.6156 (30 turns), labeler-only 0.4889 (15).
- **Kill lines (critic C4, set before running):**
  1. Fires on > 12% of no-need turns (more than 1 of 15).
  2. Mean revised − none over the 30 plan turns < 0.48 (half of C3-E4's oracle gain, +0.967).
  3. Life direct recall < 0.45. This needs a life downstream sample, so it is not run yet.

## C4-E9 · 2026-10-19 · F22 re-run leak-free (pre-registration)
- **Setup:** `verify.py prep --per 1 --tag seq`. It uses the same candidates as C4-E5 (same ceilings: code 0.597, life 0.3778), with one case per file in stream order. The haiku verifier reads each file only when it processes it. Also run on `code-rt1` and `life-rt1` with `--fresh` (all fresh human and trigger events; ceilings 0.5437 and 0.3519).
- **Rule, set before scoring:**
  - If seq recall or silence is more than 0.05 worse than C4-E5's batched run on either world, the batched F22 numbers are retracted as leak-inflated, and seq replaces them on the frontier.
  - Otherwise seq becomes the reference run and C4-E5 stands.
