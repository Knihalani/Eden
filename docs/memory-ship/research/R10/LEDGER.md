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

## C4-E9 · 2026-10-19 · F22 re-run leak-free: result
- **Run:** `score.py --store sleep --strict --split dev --sample judge --ci --systems "verify:tag=seq verify:tag=seq,ideal=1 verify verify:ideal=1"`. Red team: `--split fresh --systems "verify:tag=seq verify:tag=seq,ideal=1 lex:tau=4,when=1,gate=1"`.
- **Numbers (human turns, plan labels):**

  | World | Run | Recall [95% CI] | Proactive | Precision | Silence | Tokens |
  |---|---|---|---|---|---|---|
  | code dev | seq (deferred) | 0.5182 [0.398, 0.639] | 0.3077 | 0.128 | 0.4273 | 100.1 |
  | code dev | seq ideal | 0.5545 | 0.3077 | 0.1279 | 0.3727 | 103.9 |
  | code dev | batched (C4-E5) | 0.4758 | 0.3077 | 0.2086 | 0.6636 | 55.2 |
  | life dev | seq (deferred) | 0.3038 [0.210, 0.410] | 0.2174 | 0.1531 | 0.6204 | 50.6 |
  | life dev | seq ideal | 0.3882 | 0.2609 | 0.1472 | 0.4444 | 68.8 |
  | life dev | batched (C4-E5) | 0.2553 | 0.1739 | 0.1689 | 0.7222 | 38.0 |
  | code-rt1 fresh | seq (deferred) | 0.4218 [0.256, 0.570] | 0.6667 | 0.2212 | 0.6889 | 80.5 |
  | code-rt1 fresh | lex tau=4,when=1,gate=1 | 0.2552 | 0.5 | 0.0691 | 0.3111 | 147.3 |
  | life-rt1 fresh | seq (deferred) | 0.1594 [0.060, 0.272] | 0.15 | 0.2308 | 0.7647 | 39.7 |
  | life-rt1 fresh | lex tau=4,when=1,gate=1 | 0.1159 | 0.05 | 0.0414 | 0.2353 | 167.0 |

  life-rt1 triggers (seq): recall 0.3077, silence 0.3636 (24 events). life dev triggers: recall 0.1923, silence 0.0.
- **Verdict, by the pre-registered rule: the batched C4-E5 numbers are retracted. Silence is 0.24 worse on code and 0.10 worse on life.**
  - Seen one case at a time, haiku fires far more often. Much of F22's silence came from contrast within a 50-case batch, which a deployed hook never has.
  - **F22 (seq) is now:**
    - code: recall 0.52 at silence 0.43. That beats the hook vote's recall (0.38) at about the same silence (0.42): a recall gain only.
    - life: 0.30 recall at 0.62 silence.
  - On the red-team cases it still clearly beats lex on both worlds: silence +0.38 / +0.53, precision 3–5×.
  - The verifier's *calibration* is the open problem. A causal fix must give it the contrast it had in the batch, for example few-shot examples of the user's own past no-need turns, or a probability with a threshold tuned on dev.

## C4-E8 · 2026-10-19 · Draft check: result
- **Fires** (`draftcheck.py fires`): plan 8/30 (0.2667, need recall 0.1778); labeler-only 3/15 (0.2, need recall 0.1667); no-need 4/15 (0.2667). Firing does not separate need from no-need turns.
- **Outcome** (`draftcheck.py report`: blind opus judge on the 15 blocked turns; unblocked turns count 0):

  | Judge | plan: revised − none (30 turns) | labeler-only (15) | no-need (15) |
  |---|---|---|---|
  | reference facts only | −0.1 | −0.133 | −0.467 |
  | with history evidence (`evidence.py`) | +0.1 | +0.133 | +0.067 |

- **Verdict: dead by kill lines 1 and 2.**
  - Kill line 1: 4 of 15 no-need turns fire (more than 12%).
  - Kill line 2: +0.1 is below +0.48.
  - Kill line 3 (life) was not run.
- **Finding about the benchmark (more important than the verdict):**
  - The downstream judge's `reference_facts` hold only planned items. A response that recalled true episodic history was marked as fabricating: zod PR #1312, the unpushed a8c4f31, the billing_sync enqueue bug, branch 4f2a9c1. All of these occur in earlier stream events.
  - With history evidence (a greedy idf cover of the earlier events matching the rare tokens the responses add), the revisions go from net harm to a small net gain on every group. The "no-need" blocks were mostly helpful (+0.067), so the plan labels miss some real episodic needs.
  - Every downstream number judged without evidence (C3-E4, and the first draft-check pass) under-credits memory. C4-E10 re-measures the effect.
- **Caveats:**
  - The checker for c00–c19 grepped other checkers' output files at the end (after writing its own), so it saw no inputs ahead of time.
  - 4 of the 45 C3-E4 code cases had the responder's order swapped (C4-E10), so a few drafts may not be true no-memory drafts.
  - One responder run per condition.

## C4-E11 · 2026-10-19 · F22b: calibrated verifier with causal contrast (pre-registration)
- **Setup:** `verify.py prep --per 1 --tag cal --contrast 8` (`--fresh` for rt1). The candidates are the same as F22's.
  - Each case adds `earlier_turns`: the user's last 8 human turns from earlier sessions (past only). They give the contrast that batches gave, without a leak.
  - haiku, one case per file in stream order, gives a probability per candidate. `verify:tag=cal,p=<thr>` keeps rows with p ≥ thr, at most 4.
- **Threshold rule:** one p per world, from {0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9}, chosen on dev (judge sample): the largest deferred recall with human silence ≥ 0.65. That same p is then applied to the rt1 fresh split.
- **Kill:** dead if any of these holds:
  - no p on code dev gives silence ≥ 0.65 at recall ≥ 0.45;
  - the dev-chosen p gives silence < 0.55 on either rt1 world;
  - rt1 recall falls below F22 seq's (code 0.42, life 0.16) by more than 0.05.

## C4-E10 · 2026-10-19 · Downstream effect re-measured (both worlds), with two harness fixes
- **Fix 1, responder order:** the C3-E4 responder answered a list of packets per turn and swapped the order on 4 of 45 code cases (13 of 45 on a first life run). This was detected by overlap between each response and the oracle packet's rare tokens.
  - `downstream.py items` now gives one shuffled item per (turn, packet), each with its own id, and `collect` reassembles them.
  - The C3-E4 outputs are kept in `downstream/old-c3/`.
- **Fix 2, judge history:** the judge gets `history_evidence` (`evidence.py`; see C4-E8).
- **Setup:** the same 60 turns per world as C3-E4 (life: new sample, seed 5). Responder: sonnet. Judge: opus, blind. Code conditions: none / oracle / vote (`vote:need=2,bt=0.25,lt=6,st=4,strip=1`); life: none / oracle.
- **Numbers (`downstream.py report`):**

  | World | Group | n | Mean none / oracle (/ vote) | Oracle − none | Share with effect ≥ 1 | Vote − none |
  |---|---|---|---|---|---|---|
  | code | plan | 30 | 2.07 / 2.87 / 2.23 | +0.8 | 0.767 | +0.167 |
  | code | labeler-only | 15 | 2.4 / 2.8 / 2.53 | +0.4 | 0.467 | +0.133 |
  | code | no-need | 15 | 2.67 / 2.73 / 2.67 | +0.067 | 0.067 | 0.0 |
  | life | plan | 30 | 1.77 / 2.67 | +0.9 | 0.767 | — |
  | life | labeler-only | 15 | 2.33 / 2.87 | +0.533 | 0.6 | — |
  | life | no-need | 15 | 2.8 / 2.67 | −0.133 | 0.0 | — |

- **Verdict:**
  - The labels hold on both worlds: memory changes the outcome on 77% of plan-need turns, at about +0.8–0.9 on a 0–3 scale.
  - Labeler-only needs are about half real (+0.4 / +0.53).
  - C3-E4's "a wrong packet hurts" (vote −0.40 on no-need) does not reproduce with the fixes (vote − none = 0.0). That claim is withdrawn: wrong bullets cost tokens but showed no measured outcome harm at n = 15.
  - The vote keeps about 21% of the available benefit on code plan turns (0.167 of 0.8).
- **Caveats:** one responder run per condition; n = 15 in the small groups; all models are Claude; life has no system condition yet.

## C4-E12 · 2026-10-19 · Judge ceiling, one case per call
- **Setup:** `judge.py prep-seq --n 30` takes a seeded subsample (seed 21) of the judge sample's dev human events. Each case gets its own file with the store visible at its own moment, in stream order. Judge: opus, same prompt as the ceiling.
  - Compared on the same 30 events (`score.py --only seq`) with the batched judge (15 cases per call) and F22 seq.
  - The judges reused rows already read from earlier files and read only new rows, from past files only.
- **Numbers (human; plan labels):**

  | World | System | Need / neg events | Recall | Precision | Silence |
  |---|---|---|---|---|---|
  | code | judge, one per call | 9 / 21 | 0.6111 | 0.2439 | 0.6667 |
  | code | judge, batched | 9 / 21 | 0.5556 | 0.3448 | 0.8095 |
  | code | F22 seq | 9 / 21 | 0.5741 | 0.1915 | 0.5714 |
  | life | judge, one per call | 11 / 19 | 0.5 | 0.1364 | 0.3684 |
  | life | judge, batched | 11 / 19 | 0.4091 | 0.186 | 0.5789 |
  | life | F22 seq | 11 / 19 | 0.0909 | 0.05 | 0.4737 |

- **Verdict:** batching flatters the strong judge too: silence −0.14 on code and −0.21 on life when it sees one case at a time (n = 21 and 19 negatives, so wide error).
  - The judge "ceiling" rows in STATE overstate silence.
  - Even opus, honestly fed, fires on about a third (code) to two thirds (life) of plan-no-need turns.
- **Open question this raises:** are those fires wrong, or are the plan labels missing real needs? The C4-E8 draft check suggested some "no-need" turns do benefit from episodic memory. C4-E13 runs opus's no-need-turn picks through the fixed downstream harness to decide.

## C4-E13 · 2026-10-19 · Do the judge's "false" fires help? (pre-registration)
- **Setup:** `downstream.py prep-picks --tag "" --n 30` (batched opus judge picks, visible rows only, dev human turns).
  - Per world: 30 turns where the plan says no need but the judge fired (of 40 code / 38 life such fires), and 15 turns where it fired on a plan need.
  - Conditions: none / judge picks. Order-free responder (sonnet), then the blind opus judge with history evidence.
- **Decision rule, set before running** (picks − none on the 30 no-need-fired turns):
  - ≥ +0.3 mean, with ≥ 30% of turns at effect ≥ 1: the plan labels miss real needs, so "silence" overstates false fires. Re-label with a downstream-validated label before tuning any system for silence.
  - ≤ +0.1: the models over-fire, and silence stands as the target.
  - In between: mixed; report both.

## C4-E13 · 2026-10-19 · Do the judge's "false" fires help? Result
- **Numbers** (`downstream.py report --sub <world>-picks`; picks − none; effect counts as {Δ: turns}):

  | World | Group | n | Mean picks − none | Share ≥ 1 | Effect distribution |
  |---|---|---|---|---|---|
  | code | plan-no-need, judge fired | 30 | +0.4 | 0.467 | −1: 2, 0: 14, +1: 14 |
  | code | plan need, judge fired | 15 | +0.8 | 0.667 | 0: 5, +1: 8, +2: 2 |
  | life | plan-no-need, judge fired | 30 | +0.133 | 0.267 | −1: 4, 0: 18, +1: 8 |
  | life | plan need, judge fired | 15 | +0.867 | 0.8 | −2: 1, 0: 2, +1: 9, +2: 3 |

- **Verdict, by the pre-registered rule:**
  - **Code: the plan labels miss real needs** (+0.4, 47% helped, 7% hurt). About half of the strong judge's "false" fires on code improve the answer. Mostly these are episodic state (in-flight branches, unpushed work, open PRs) and rules the plan did not tag for that turn.
  - **Life: mixed** (+0.133, 27% helped, 13% hurt).
- **Consequences:**
  - On code, "silence" against plan labels overstates false fires: a system that fires where the judge fires is partly right. Silence-driven tuning on code (C4-E11's threshold rule among them) is biased toward missing real needs.
  - Before tuning for silence again: build **downstream-validated labels**. A turn needs a row when adding it raises the blind-judged outcome by ≥ 1. Use them on a fixed subset, as the gold standard that the plan labels are checked against.
- **Caveats:**
  - One responder run.
  - n = 30 per group.
  - The judge picks are the batched judge's (the same family as the downstream judge: correlated errors are possible).
  - The responder can use a picked row in a way the judge likes even when the user would not have wanted it raised. The judge's "don't reward irrelevant facts" instruction only partly guards against this.

## C4-E11 · 2026-10-19 · F22b calibrated verifier: result
- **Runs:** `score.py --store sleep --strict --split dev --sample judge` and `--split fresh` on rt1, systems `verify:tag=cal,p=0.3 … p=0.9 verify:tag=seq`. Life columns use all 245 life-cal outputs (fixed after review; the first scoring had 243).
- **Dev sweep (human; plan labels):**

  | p | code recall | code precision | code silence | life recall | life precision | life silence |
  |---|---|---|---|---|---|---|
  | 0.3 | 0.5303 | 0.1076 | 0.4182 | 0.3038 | 0.1088 | 0.6111 |
  | 0.4 | 0.5303 | 0.1289 | 0.4636 | 0.2975 | 0.1316 | 0.6481 |
  | 0.5 | 0.5121 | 0.1636 | 0.5455 | **0.2975** | 0.1613 | **0.6667** |
  | 0.6 | 0.5121 | 0.2308 | 0.6364 | 0.2785 | 0.2171 | 0.7407 |
  | **0.7** | **0.4788** | 0.3143 | **0.7636** | 0.2532 | 0.2989 | 0.8056 |
  | 0.8 | 0.4606 | 0.4103 | 0.8182 | 0.2152 | 0.3182 | 0.8426 |
  | 0.9 | 0.3455 | 0.5349 | 0.9 | 0.1456 | 0.4167 | 0.9259 |
  | seq (no p) | 0.5182 | 0.128 | 0.4273 | 0.3038 | 0.1531 | 0.6204 |

  The rule picks p = 0.7 on code and p = 0.5 on life.
- **Fresh (rt1) at the dev-chosen p:**
  - code-rt1, p 0.7: recall 0.2379, precision 0.3548, silence 0.8444 (seq: 0.4218 / 0.2212 / 0.6889);
  - life-rt1, p 0.5: recall 0.1377, precision 0.2258, silence 0.7941 (seq: 0.1594 / 0.2308 / 0.7647).
  - life-rt1 triggers at p 0.5: recall 0.2692, silence 0.4545 (11 negatives).
- **Verdict: dead by kill line 3 on code.**
  - code-rt1 recall falls 0.18 below F22 seq (the allowance was 0.05).
  - Life passes all lines; code passes lines 1–2.
- **What it shows:**
  - Causal contrast plus a probability makes the verifier calibratable on dev. Code p 0.7 reaches 0.48 recall at 0.76 silence and 0.31 precision, better than even the batched run.
  - But the threshold does not transfer to the shorter, harder red-team prompts: their probabilities sit lower.
  - C4-E13 also found that, on code, silence measured against plan labels penalises real needs. Tuning for it is the wrong target until there are downstream-validated labels.
- **Correction (same day):** the 2 missing life-cal files landed after scoring. Re-scored with all 245: p 0.4 recall 0.2975 / precision 0.1316 / silence 0.6481; p 0.5 0.2975 / 0.1613 / 0.6667; p 0.6 0.2785 / 0.2171 / 0.7407. The rule still picks p 0.5, and the verdict is unchanged.

## C4-R · 2026-10-19 · Review of the cycle 4 consolidation (slice-reviewer, round 1: REQUEST_CHANGES)
- **Confound in the order-free responder (affects C4-E10 and C4-E13).**
  - `downstream.py items` shuffled all (turn, packet) items and cut them into files of 45, so a turn's no-memory and with-memory items sometimes shared one responder prompt: 13/60 code and 16/60 life turns (C4-E10); 22/45 code-picks and 22/45 life-picks (C4-E13).
  - The reviewer measured that, in shared files, the no-memory reply repeats about twice the packet's new tokens (code 0.283 vs 0.145; life 0.131 vs 0.055). Oracle − none differs too (life 0.31 shared vs 0.64 apart; code 0.62 vs 0.49). These reviewer numbers were not re-derived in this session.
  - On code no-need turns, vote − none is 0.0 either way, so the R10-3 withdrawal holds.
  - **The C4-E10 and C4-E13 effect sizes (+0.8 / +0.9; +0.4 / +0.133) may be biased by this, in either direction per world.** Fixed: `items` now puts item j of every turn into group j, so no turn shares a file. Re-running both experiments with the fixed protocol is the first task of cycle 5; until then their verdicts are provisional.
- **Verify scoring** now counts only rows visible at the moment.
  - Some seq outputs named rows outside their own case's candidates (code-seq 3, life-seq 1, life-rt1-seq 1, all visible). So those verifiers saw some content outside their file, which weakens the "reads each file only when it processes it" claim.
  - The batched C4-E5 life run named 2 future rows; its precision moves 0.1689 → 0.1712 (C4-E5 is already retracted). Every other published number is unchanged.
- **Other fixes:**
  - `prep_picks` visibility now honours `invalid_at` (no row was affected).
  - The C4-E11 life sweep was updated to all 245 outputs.
  - PROMPTS rows were added for verify `tag=seq`, `tag=cal` and judge `prep-seq`.
  - Doc corrections were made in STATE and R10-retrieval.
- **Noted:**
  - C4-E7's kill line (in critic-c4.md) was committed in the same commit as its result, so git cannot show it predates scoring.
  - C4-E8's drafts include the known swapped C3-E4 cases.

## C5-E1 · 2026-10-19 · Re-run of C4-E10 and C4-E13 with the per-turn responder split (pre-registration)
- **Setup:** the same turns, keys and conditions as C4-E10 (`downstream/code`, `downstream/life`) and C4-E13 (`downstream/<world>-picks`).
  - `downstream.py items` now puts item j of every turn in group j, so no responder prompt sees one turn twice.
  - The old outputs moved to `downstream/old-c4/`. Responder: sonnet. Judge: opus, blind, with history evidence. Prompts are as in PROMPTS.md.
- **Rules (set before running):**
  - C4-E13's decision rule applies unchanged to the re-run: ≥ +0.3 with ≥ 30% helped means the labels miss needs; ≤ +0.1 means the models over-fire.
  - C4-E10's verdict ("memory changes the outcome on most plan-need turns") stands if plan oracle − none ≥ +0.5 on both worlds.
  - R10-3's withdrawal stands if vote − none on code no-need turns is ≥ −0.1.
  - The re-run numbers replace the provisional ones whatever they show.

## C5-E1 · 2026-10-19 · Re-run of C4-E10 and C4-E13 with the per-turn responder split: result
- **Run:** `downstream.py items` → sonnet responders, one group per call. One code file came back with 35 of 45 items; the 10 missing items were answered in a separate call (`items-1-2`). Then `collect`, `judge-prep` (history evidence), the blind opus judge and `report`.
- **Downstream effect (replaces C4-E10):**

  | World | Group | n | Mean none / oracle (/ vote) | Oracle − none | Share ≥ 1 | Vote − none | Vote effect distribution |
  |---|---|---|---|---|---|---|---|
  | code | plan | 30 | 1.73 / 2.97 / 2.37 | **+1.233** | 0.967 | +0.633 | −1: 2, 0: 12, +1: 12, +2: 3, +3: 1 |
  | code | labeler-only | 15 | 2.07 / 2.87 / 2.33 | +0.8 | 0.733 | +0.267 | −1: 1, 0: 10, +1: 3, +2: 1 |
  | code | no-need | 15 | 2.6 / 2.53 / 2.13 | −0.067 | 0.0 | **−0.467** | −2: 2, −1: 4, 0: 8, +1: 1 |
  | life | plan | 30 | 1.7 / 2.8 | **+1.1** | 0.867 | — | — |
  | life | labeler-only | 15 | 2.4 / 2.93 | +0.533 | 0.533 | — | — |
  | life | no-need | 15 | 2.87 / 2.8 | −0.067 | 0.0 | — | — |

- **Judge's "false" fires (replaces C4-E13):**

  | World | Group | n | Mean picks − none | Share ≥ 1 | Distribution |
  |---|---|---|---|---|---|
  | code | plan-no-need, judge fired | 30 | **+0.467** | 0.6 | −1: 5, 0: 7, +1: 17, +2: 1 |
  | code | plan need, judge fired | 15 | +0.8 | 0.8 | −1: 1, 0: 2, +1: 11, +2: 1 |
  | life | plan-no-need, judge fired | 30 | **−0.033** | 0.233 | −2: 2, −1: 4, 0: 17, +1: 7 |
  | life | plan need, judge fired | 15 | +0.867 | 0.8 | −2: 1, −1: 1, 0: 1, +1: 8, +2: 4 |

- **Verdicts, by the C5-E1 rules:**
  - **Memory matters more than C4-E10 said.** The right packet improves the outcome on 97% (code) and 87% (life) of plan-need turns, at +1.23 and +1.1. C4-E10's verdict stands, with larger effects.
  - **Wrong packets do hurt: R10-3's withdrawal is reversed.** On code no-need turns the vote scores −0.467 against no memory, while the empty-packet noise floor is −0.067; 6 of 15 turns got worse and 1 better. The rule required vote − none ≥ −0.1.
    - The C4-E10 "0.0" came from the confounded split: no-memory replies written in the same prompt as the packet replies copied their mistakes.
    - The vote also keeps about half of the available benefit on code plan turns (+0.633 of +1.233), more than the 21% C4-E10 showed.
  - **C4-E13 holds on code:** the plan labels miss real needs (+0.467, 60% helped, 17% hurt).
  - **On life the C4-E13 verdict changes from "mixed" to "over-fire"** (−0.033; 7 helped, 6 hurt). On life, plan labels are a fair silence target. On code they are not.
- **What this means for the push design:** firing has a real cost (about −0.5 on a wrong turn) and a real benefit (about +1.2 on a right turn). With code's measured help/hurt rates, a packet is worth sending when P(needed) > about 0.3. That is a value-of-information threshold (F6), which we can now measure.
- **Caveats:**
  - One responder run per condition.
  - n = 15 in the small groups.
  - All models are Claude.
  - The judge reported that some reference facts contradict each other (for example Express 4 vs Fastify 5), and scored against the later fact. The world's superseded links may be incomplete; to check.

## C5-E2 · 2026-10-19 · Outcome utility per turn (descriptive, post hoc; no kill line)
- **Method** (`utility.py`): utility = (need events × recall × G − no-need events × (1 − silence) × C) / human events.
  - G = +1.233 and C = 0.467 come from C5-E1, code.
  - Assumptions:
    - every system's wrong packet costs what the vote's did;
    - life uses code's C;
    - code plan labels undercount needs (C4-E13), so firing systems are under-credited on code.
  - It is the same judge sample as the frontier (dev) and the rt1 fresh split.
- **Numbers (utility per human turn; recall / silence from score.py):**

  | System | code dev | life dev | code-rt1 | life-rt1 |
  |---|---|---|---|---|
  | eden (plugin today) | **−0.2202** (0.091 / 0.173) | **−0.2316** (0.044 / 0.056) | — | — |
  | hook vote | −0.0104 | −0.0174 | — | — |
  | lex tau=4,when=1,gate=1 | — | — | −0.0723 | −0.1554 |
  | F22 verify seq | +0.0347 | +0.0559 | **+0.1155** | +0.0138 |
  | F22b cal p=0.5 | +0.0690 | +0.0651 | +0.0948 | +0.0112 |
  | F22b cal p=0.6 | +0.0973 | +0.0751 | +0.1019 | −0.0067 |
  | F22b cal p=0.7 | +0.1232 | +0.0795 | +0.0708 | +0.0179 |
  | pull k=2 (agent asks) | +0.1097 | +0.1070 | — | — |
  | judge (opus, batched; optimistic) | +0.1708 | +0.2018 | — | — |

- **Reading:**
  - **The plugin as it ships today likely makes the agent's replies worse on average** (−0.22 per turn on both worlds): it fires on 83–94% of no-need turns and finds under 10% of needs. This rests on the assumption that its wrong packets cost what the vote's did. Its bullets are mostly the user's own past prompts, which may cost less; a direct downstream run of eden's packets is needed to confirm. **This is the most important open measurement.**
  - Cheap hook-side matching is at about zero.
  - The off-hook verifier is the only push method clearly positive on every split, and best on code-rt1 when uncalibrated (seq).
  - On utility, a mid threshold (p 0.6) is a reasonable dev/fresh compromise on code. On life-rt1 every verifier variant is near zero.

## C5-E3 · 2026-10-19 · The plugin as it ships today, downstream (pre-registration)
- **Setup:** `downstream.py prep-eden`. The same 60 turns per world and groups as C5-E1 (30 plan-need, 15 labeler-only, 15 no-need).
  - Conditions: none / eden, where eden is the bullets the real plugin injected at that turn's UserPromptSubmit (`runs/<world>-eden/packets.jsonl`). 59 of 60 turns per world got a packet.
  - Protocol as in C5-E1: per-turn split, sonnet responder, blind opus judge with history evidence.
- **Rule, set before running:**
  - **Net-negative confirmed** if, on the 60-turn mix reweighted to the real need base rate (14%), the expected eden − none is < 0, that is 0.14 × (plan-need effect) + 0.86 × (no-need effect) < 0.
  - **Net-positive** if > +0.05.
  - In between: near zero.

## C5-E3 · 2026-10-19 · The plugin as it ships today, downstream: result
- **Numbers** (`downstream.py report --sub <world>-eden`; eden − none; distribution as {Δ: turns}):

  | World | Group | n | Mean eden − none | Distribution |
  |---|---|---|---|---|
  | code | plan-need | 30 | +0.1 | −1: 5, 0: 19, +1: 4, +2: 2 |
  | code | labeler-only | 15 | +0.133 | −1: 1, 0: 11, +1: 3 |
  | code | no-need | 15 | −0.067 | −1: 3, 0: 10, +1: 2 |
  | life | plan-need | 30 | **−0.2** | −2: 1, −1: 7, 0: 19, +1: 3 |
  | life | labeler-only | 15 | −0.2 | −2: 2, −1: 2, 0: 9, +1: 1, +2: 1 |
  | life | no-need | 15 | +0.067 | −1: 3, 0: 8, +1: 4 |

  Reweighted to a 14% need rate (0.14 × plan + 0.86 × no-need): **code −0.0433 → net-negative by the rule; life +0.0293 → near zero.**
- **Verdict:**
  - The shipping plugin's packets do almost nothing to the agent's replies.
  - On code they add +0.1 where memory is needed, against +1.233 for the right packet (C5-E1): about 8% of the available benefit.
  - On life they *lower* replies on need turns (−0.2; 8 worse, 3 better). The packet (mostly the user's own past prompts) crowds out or misleads, and does not supply the needed fact.
  - By the pre-registered rule, code is net-negative (by a small margin) and life is near zero.
- **Correction to C5-E2:** its −0.22 per turn for eden assumed eden's wrong packets cost what the vote's did (−0.467). Measured directly, eden's no-need cost is about −0.07 on code and +0.07 on life, about the noise floor, because past prompts rarely mislead. Eden-today's true utility is near zero, not strongly negative. The C5-E2 rows for other systems keep their stated assumption.
- **Note:** for life-s028-e010 the judge flagged a response stating grocery totals that appear only in later turns. Its eden packet (two past prompts about the TD account) does not contain them, so the responder invented them. Isolated; one case.

## C5-E4 · 2026-10-19 · The best push method, downstream (pre-registration)
- **Setup:** `downstream.py prep-verify --p 0.6`. The same 60 turns per world as C5-E1 and C5-E3. Conditions: none / verify.
  - verify is the calibrated off-hook verifier (F22b): rows with p ≥ 0.6, at most 4, visible at the turn, delivered only on turns with a tool call.
  - Turns outside the judge sample get verifier outputs from the same prompt, one case per file (`verify/<world>-cal-ds`, via `verify.py --events`).
  - p 0.6 is the C5-E2 utility compromise, fixed now, before any downstream result.
  - Protocol as in C5-E1.
- **Rule, set before running:** the 14%-reweighted verify − none (0.14 × plan-need + 0.86 × no-need effect).
  - **Better than the plugin** if it beats C5-E3's eden on both worlds (code −0.0433, life +0.0293) by ≥ +0.05.
  - **Worth building** if it is > +0.05 on both worlds.

## C5-E4 · 2026-10-19 · The calibrated verifier (p 0.6), downstream: result
- **Numbers** (verify − none; packets on code 37/60 turns, life 27/60):

  | World | Group | n | Fired | Mean verify − none | Distribution |
  |---|---|---|---|---|---|
  | code | plan-need | 30 | 24 | **+0.733** | −1: 2, 0: 8, +1: 17, +2: 2, +3: 1 |
  | code | labeler-only | 15 | 6 | +0.133 | −1: 1, 0: 11, +1: 3 |
  | code | no-need | 15 | 7 | **−0.267** | −1: 4, 0: 11 |
  | life | plan-need | 30 | 17 | **+0.367** | −1: 3, 0: 15, +1: 10, +2: 2 |
  | life | labeler-only | 15 | 7 | −0.133 | −2: 2, −1: 1, 0: 10, +1: 1, +2: 1 |
  | life | no-need | 15 | 3 | −0.067 | −2: 1, 0: 13, +1: 1 |

  - **Pre-registered (14% two-way) reweight:** code −0.127 (eden −0.0433), life −0.0062 (eden +0.0293).
  - **Post hoc, three-way reweight with dev's real group shares** (code plan 0.141 / labeler-only 0.171 / no-need 0.688; life 0.137 / 0.215 / 0.648): code verify −0.0575 vs eden −0.009; life verify −0.0216 vs eden −0.0273.
- **Verdict: neither "better than the plugin" nor "worth building" by the rule.** Both are about zero per turn, through different routes:
  - Where memory is needed, the verifier is far better: code +0.733 vs eden +0.1; life +0.367 vs −0.2. It delivers about 60% (code) and 33% (life) of the right packet's gain.
  - Where nothing is needed, it pays it back: when it fires, a no-need turn loses about 0.6 (code −4 over 7 fires; life −2 over 3) and a need turn gains about 0.8 (code +21 over 24; life +12 over 17).
  - **Break-even precision is about 43%**, but at the real base rate only about 20–25% of its fires land on need turns.
- **What would make push pay:**
  1. Fewer no-need fires at the same hit rate (precision ≥ 0.45).
  2. A lower cost per wrong fire, for example a delivery format the agent can safely ignore.
  3. Both.

  These are the next experiments. The downstream harness now measures them directly.

## C5-E5 · 2026-10-19 · Cross-batch supersession at sleep (pre-registration)
- **Finding that motivates it:**
  - The sleep compiler's `supersede` op can only name a row in its own batch (`sleep.rows` prefixes ids with the current batch). So facts that change across batches leave the old row live: only 3 of 375 code rows and 37 of 611 life rows ever get `invalid_at`.
  - C5-E4's code losses on no-need turns came from stale rows: "where did we leave things" got 08-30 state; a CI question got "the repo pins yarn" after the pnpm migration. Live rows such as "The acme-platform API is Express 4" sit next to "migrated from Express 4 to Fastify 5".
- **Setup:** `supersede.py`.
  - After each batch b ≥ 1, a model (sonnet; the sleep step's family) sees b's new rows and every older live row. It lists `{old, new}` pairs where the new row replaces the old (a corrected fact, a changed state, a finished task, a moved date).
  - `sleep.rows(..., supersede=True)` ends the old row at the new row's time; `score.py --supersede` applies it. It is causal: a row ends only when its replacement exists.
- **Measures, set before running:**
  1. **Stale share of delivered bullets** (`stale` in score.py) for F22 seq and cal p 0.6, judge sample dev, with vs without `--supersede`.
  2. **Recall** on the same.
- **Kill:** dead if the stale share does not fall by ≥ 30% relative on both worlds, or recall drops > 0.03 on either.
- **Pass:** the C5-E4 downstream turns whose verify packet changes get re-run (none / verify-with-supersession).

## C5-E5 · 2026-10-19 · Cross-batch supersession: result
- **Pass output:** 26 (code) and 112 (life) superseded rows from sonnet over 10 and 15 batches. Examples:
  - "The acme-platform API is Express 4" → ended by "migrated from Express 4 to Fastify 5";
  - Node 18 → 20.11;
  - yargs → commander;
  - many life schedule and contact changes.

  The model reported that some source rows contradict each other in the stream itself (bin day, Leo's age, yargs vs commander), and on those it made judgement calls.
- **Numbers** (`score.py --store sleep --strict [--supersede] --split dev --sample judge`):

  | World | System | Stale share without → with | Relative change | Recall without → with |
  |---|---|---|---|---|
  | code | verify seq | 0.0901 → 0.0727 | −19% | 0.5182 → 0.5182 |
  | code | cal p 0.6 | 0.0833 → 0.0617 | −26% | 0.5121 → 0.5121 |
  | life | verify seq | 0.1327 → 0.0825 | −38% | 0.3038 → 0.2911 |
  | life | cal p 0.6 | 0.1053 → 0.0541 | −49% | 0.2785 → 0.2658 |

- **Verdict: dead by the kill line** (code stale share falls 19–26%, under the 30% line). Life passes strongly, with recall down 0.013. By the rule, the downstream re-run does not happen.
- **Diagnostic (post hoc):**
  - Of the C5-E4 turns where the verifier's packet hurt the reply, supersession changes the packet on 1 of 6 (code) and 2 of 4 (life).
  - So stale *facts* explain a minority of the harm. Most of the rest is stale *episodic state* ("where did we leave things" answered with 08-30 work; old in-flight branches) and plainly off-target rows.
  - Episodic state is not an item, so the stale metric does not see it. It needs its own handling: state rows that expire unless re-confirmed, or that are always shown with their date.
- **Engineering note:** the cross-batch blind spot itself is a real bug in the sleep design. Any production sleep compiler that runs per batch needs this pass, whatever this kill line says. Logged for the plan.

## C5-E6 · 2026-10-19 · Dated delivery: each delivered row carries "[as of <date>]" (pre-registration)
- **Setup:** `downstream.py prep-verify --p 0.6 --dated`. The packets are the same as C5-E4's (calibrated verifier, deferred), but each row is prefixed with the date it became visible (its batch's last session date, the strict visibility time).
  - Only turns where verify fired are re-run (code 37, life 27). Both conditions (none / dated verify) get fresh responses, with the same protocol as C5-E1.
- **Comparison, set before running:** on the same fired turns, by group, compare C5-E4's undated verify − none with dated verify − none.
  - **Dated helps** if the mean on fired plan-no-need turns rises by ≥ +0.25 (towards 0) on the pooled worlds, while the mean on fired plan-need turns does not fall by more than 0.15.
  - **Dead** otherwise.

## C5-E6 · 2026-10-19 · Dated delivery: result
- **Numbers** (on the turns where verify fired; dated is this run, undated is C5-E4 on the same turns; verify − none):

  | World | Group | n | Undated | Dated |
  |---|---|---|---|---|
  | code | plan-need | 24 | +0.875 | +0.917 |
  | code | labeler-only | 6 | +0.5 | +0.333 |
  | code | no-need | 7 | −0.571 | −0.286 |
  | life | plan-need | 17 | +0.706 | +0.706 |
  | life | labeler-only | 7 | 0.0 | −0.143 |
  | life | no-need | 3 | −0.667 | +0.333 |
  | **pooled** | plan-need | 41 | +0.805 | +0.829 (+0.024) |
  | **pooled** | labeler-only | 13 | +0.231 | +0.077 (−0.154) |
  | **pooled** | no-need | 10 | −0.6 | **−0.1 (+0.5)** |

- **Verdict, by the pre-registered rule: dated delivery helps.** Fired no-need turns rise +0.5, past the ≥ +0.25 line; fired need turns do not fall (+0.024).
  - Caveats:
    - n = 10 fired no-need turns.
    - Labeler-only turns dropped −0.154 (n 13; possibly noise, possibly the date making mild needs look stale).
    - One responder run.
- **Per-turn utility (post hoc):** non-fired turns count 0 for both runs, using the three-way real group shares of C5-E4.

  | World | Undated verify | Dated verify | Eden today (C5-E3, three-way) |
  |---|---|---|---|
  | code | −0.0506 | **+0.0345** | −0.009 |
  | life | −0.0316 | **+0.0837** | −0.0273 |

  - The two-way 14% versions: code −0.1313 → −0.012; life −0.0587 → +0.1133.
  - **The first positive per-turn outcome for any push method on both worlds.** Dated verify beats today's plugin by +0.044 (code) and +0.111 (life).
- **Why it works (from the judge's notes on C5-E4 losses):** wrong packets hurt mostly by presenting old state as current. A date lets the agent treat a row as history ("as of 08-30 the branch was …; let me check now") instead of fact.
- **Next:** confirm head to head on fresh turns (C5-E7, pre-registered), with dating applied to eden too, for a fair comparison.

## C5-E7 · 2026-10-19 · Head to head on fresh turns: plugin vs dated verifier (pre-registration)
- **Setup:** `downstream.py prep-h2h`. Fresh dev human turns, none in `downstream/<world>` (seed 23).
  - code: 25 plan-need (all that remain), 15 labeler-only, 30 no-need = 70 turns. life: 30 / 15 / 30 = 75 turns.
  - Three conditions per turn:
    - **none**;
    - **eden**, the real plugin's injected bullets, each dated by the first earlier event that contains it (dating applied to eden too, for fairness);
    - **verify**, the calibrated verifier, p ≥ 0.6, at most 4 rows, dated, deferred.
  - Missing verifier outputs come from the same prompt, one case per file (`verify/<world>-cal-ds2`).
  - Protocol as in C5-E1: per-turn split, sonnet responder, blind opus judge with history evidence.
- **Primary measure:** per-turn utility = Σ over groups (real dev share × mean condition − none). The shares are C5-E4's: code 0.141 / 0.171 / 0.688; life 0.137 / 0.215 / 0.648.
- **Rules, set before running:**
  - **Confirmed:** verify − eden ≥ +0.05 on both worlds, and verify > 0 on both.
  - **Not confirmed:** verify − eden < 0 on either world.
  - In between: partial.

## C5-E7 · 2026-10-19 · Head to head on fresh turns: result
- **Run:**
  - code 70 turns (25 plan-need, 15 labeler-only, 30 no-need); life 75 (30 / 15 / 30).
  - Packets: verify fired on code 38/70; eden on code 65/70.
  - One life case (life-s075-e000) was skipped by a judge call and judged alone afterwards.
  - `h2h.py code life`.
- **Numbers** (condition − none, mean per group; better/worse turn counts):

  | World | Group | n | Eden (dated) | Verify (dated) |
  |---|---|---|---|---|
  | code | plan-need | 25 | +0.08 (5 / 3) | **+0.56 (13 / 2)** |
  | code | labeler-only | 15 | −0.2 (0 / 3) | −0.067 (3 / 3) |
  | code | no-need | 30 | +0.033 (4 / 2) | +0.067 (5 / 3) |
  | life | plan-need | 30 | −0.133 (2 / 6) | **+0.6 (15 / 2)** |
  | life | labeler-only | 15 | +0.067 (3 / 1) | +0.2 (5 / 2) |
  | life | no-need | 30 | 0.0 (4 / 5) | 0.0 (4 / 4) |

  Per-turn utility with dev's real group shares:
  - **code:** eden 0.0, verify +0.1134, difference **+0.1134**;
  - **life:** eden −0.0039, verify +0.1252, difference **+0.1291**.

  Paired bootstrap 95% CI of the difference (turns resampled within groups, 4000 draws): code [−0.0695, +0.2955], life [−0.0441, +0.2893].
- **Verdict: confirmed by the pre-registered rule** (difference ≥ +0.05 and verify > 0 on both worlds).
  - Stated plainly: the 95% intervals still include 0. The no-need group carries about 2/3 of the weight, and its 30 turns are noisy. More turns are needed for statistical firmness.
- **What this establishes:**
  - On fresh turns, with dated delivery, the off-hook verifier lifts replies where memory is needed: code +0.56, life +0.6, against eden's +0.08 and −0.13.
  - It does no measurable harm where memory is not needed (+0.07 / 0.0).
  - It is the first push design that beats the shipping plugin, by its effect on replies, on both worlds.
- **Caveats:**
  - One responder run per condition.
  - All models are Claude.
  - Latency and cost of the off-hook haiku call are not measured.
  - Delivery at the first tool call is simulated: the responder sees the packet as context, not mid-turn.
  - Eden was dated here too, so the comparison is fair, but eden as shipped is undated (C5-E3: about 0 too).

## C5-R · 2026-10-19 · Review of the cycle 5 consolidation (slice-reviewer, round 1: REQUEST_CHANGES), and fixes
- **C5-E5 depended on file order.**
  - `supersede.pairs` read the outputs unsorted and kept the first replacement it saw. Fixed: it now reads in batch order, and `sleep.rows` ends the old row at the earliest replacement.
  - Re-run (`score.py --strict --supersede --split dev --sample judge`):

    | World | System | Stale | Recall | Silence |
    |---|---|---|---|---|
    | code | verify seq (unchanged) | 0.0727 | 0.5182 | 0.4364 |
    | code | cal p 0.6 (unchanged) | 0.0617 | 0.5121 | 0.6545 |
    | life | verify seq | 0.0833 (was 0.0825) | 0.2911 | 0.6296 |
    | life | cal p 0.6 | 0.0548 (was 0.0541) | 0.2658 | 0.75 |

    Life relative changes become −37% and −48%. The verdict is unchanged: dead by the code kill line.
  - Also noted: `supersede.py prep` offered older rows without the pass applied, so a row already ended in an earlier batch could be offered again. This does not change `invalid_at`, because the earliest replacement wins. The pass was not re-run.
- **Exact reweights** (C5-E4 used rounded group means): code verify three-way −0.0573 (written −0.0575); life eden three-way −0.0272 (−0.0273); life verify two-way −0.0060 (−0.0062). No verdict changes.
- **C5-E7 fire counts, life:** verify 34/75, eden 74/75.
  - "Fresh" means not in `downstream/<world>`: 12 code and 11 life h2h turns overlap the C4-E13/C5-E1 `*-picks` turns.
  - The h2h turns are dev turns, and p 0.6 was chosen on the dev judge sample.
- **CIs:** `h2h.py` now computes the paired bootstrap (stratified, 4000 draws, seed 1). It reproduces code [−0.0695, +0.2955] and life [−0.0441, +0.2893].
- **Harness:**
  - `utility.py` reformatted; it runs from any directory.
  - `downstream.py prep-verify --fired-only` now does the C5-E6 filter. Regenerated keys are identical to the committed ones.
  - The `--dated` help text says "date it became visible".
- **Wording corrected** in STATE, R10-retrieval and DECISIONS R10-5:
  - C5-E6 and C5-E7 are "confirmed by rule, not yet firm" (n = 10 fired no-need turns; CIs include 0).
  - Eden-today on code is net-negative by the C5-E3 rule (−0.0433), not "near zero".
  - The supersession pass is dead by its code kill line, and is recommended only as a bug fix.

## C6-E1 · 2026-10-19 · Firming up C5-E7: more fresh turns (pre-registration)
- **Setup:** `downstream.py prep-h2h --seed 31 --exclude <world>-h2h`, the same conditions and protocol as C5-E7. New dev turns, in neither `downstream/<world>` nor `<world>-h2h`:
  - code: 0 plan-need (none remain), 15 labeler-only, 60 no-need = 75;
  - life: 19 plan-need (all that remain), 15 labeler-only, 60 no-need = 94.
  - Missing verifier outputs come from the same prompt, one case per file (`verify/<world>-cal-ds3`).
- **Analysis:** `h2h.py code life --pool h2h2` pools C5-E7 and C6-E1 per group, with the same shares and the same bootstrap (4000 draws, seed 1).
- **Rule, set before running:**
  - **Firm** if the pooled 95% CI lower bound of verify − eden is > 0 on both worlds.
  - **Lead stands** if the point estimate stays ≥ +0.05 on both but a CI includes 0.
  - **Weakened** if the point estimate falls below +0.05 on either world.

## C6-E1 · 2026-10-19 · Firming up the head-to-head: result
- **Run:** 75 new code turns and 94 new life turns (all judged), via `h2h.py code life --pool h2h2`.
- **Pooled with C5-E7** (condition − none per group; better/worse turn counts):

  | World | Group | n | Eden (dated) | Verify (dated) |
  |---|---|---|---|---|
  | code | plan-need | 25 | +0.08 (5 / 3) | +0.56 (13 / 2) |
  | code | labeler-only | 30 | −0.167 (0 / 5) | −0.033 (4 / 4) |
  | code | no-need | 90 | −0.022 (8 / 10) | −0.011 (12 / 13) |
  | life | plan-need | 49 | −0.02 (5 / 8) | **+0.49 (20 / 2)** |
  | life | labeler-only | 30 | +0.233 (9 / 1) | +0.3 (13 / 5) |
  | life | no-need | 90 | −0.022 (7 / 10) | +0.056 (12 / 8) |

  Per-turn utility, pooled:
  - **code:** verify +0.0656, eden −0.0325, difference **+0.0981**, 95% CI **[−0.0158, +0.2158]**;
  - **life:** verify +0.1676, eden +0.033, difference **+0.1346**, 95% CI **[+0.0352, +0.2332]**.

  New turns alone: code difference +0.0228 [−0.1033, +0.1489] (no plan-need turns remained for code); life +0.0973 [−0.0392, +0.2305].
- **Verdict, by the rule: lead stands** (point estimates ≥ +0.05 on both worlds, but the code CI includes 0).
  - **Firm on life.** The dated verifier beats today's plugin, with the CI above 0.
  - **Code is not firm.** Its advantage comes entirely from plan-need turns, and all 55 dev plan-need turns are now used. Code no-need turns are a wash for both systems.
- **Next for code:** the only way to firm it up on dev is a second responder and judge run on the same turns (to cut noise), or new need turns from the test split or a fresh code world. The test split stays unlooked-at, so this needs a decision in a later cycle.

## C6-E2 · 2026-10-19 · Code head-to-head, second independent run (pre-registration)
- **Setup:** a second, independent responder (sonnet) and blind-judge (opus, history evidence) run on the same 145 code turns and packets as C5-E7 and C6-E1 (`downstream/code-h2h-r2`, `code-h2h2-r2`: copies of the inputs and keys, new responses, new judgments).
  - Each turn's condition − none is averaged over the two runs (`h2h.py code --pool h2h2 --runs r2`); shares and bootstrap are unchanged.
- **Rule, set before running (the averaged result decides, whichever way it goes):**
  - **Firm on code** if the averaged pooled 95% CI lower bound is > 0.
  - **Lead stands** if the point estimate stays ≥ +0.05.
  - **Weakened** if it falls below +0.05.

## C6-E2 · 2026-10-19 · Code head-to-head, second independent run: result
- **Run:** the same 145 code turns and packets. A new sonnet responder and a new blind opus judge (history evidence); all 145 turns judged.
  - One responder call came back with 31 of 45 items; the 14 missing items were answered in a separate call (`items-2-2`).
- **Run 2 alone:** verify +0.1363, eden +0.0324, difference +0.1039, 95% CI [−0.0046, +0.2137]. It replicates run 1 (+0.0981).
- **Decision measure (each turn averaged over both runs; `h2h.py code --pool h2h2 --runs r2`):**

  | Group | n | Eden (dated) | Verify (dated) |
  |---|---|---|---|
  | plan-need | 25 | +0.04 (5 / 5) | **+0.52 (14 / 1)** |
  | labeler-only | 30 | −0.033 (3 / 5) | +0.05 (9 / 7) |
  | no-need | 90 | 0.0 (16 / 14) | +0.028 (16 / 16) |

  Per-turn utility: verify +0.101, eden −0.0001, **difference +0.1011, 95% CI [+0.0085, +0.1988]**.
- **Verdict, by the rule: firm on code** (CI lower bound > 0).
- **With C6-E1 (life firm: +0.1346 [+0.0352, +0.2332]), the head-to-head is now firm on both worlds:** the dated off-hook verifier beats today's plugin, by its effect on replies.
- **Caveats:**
  - All models are Claude: responder sonnet, judge opus, verifier haiku, sleep compiler sonnet.
  - Life rests on one responder run per turn.
  - The turns are dev turns.
  - Latency and cost are not measured.
  - Delivery at the first tool call is simulated.

## C6-E3 · 2026-10-19 · Dated delivery for the model-free hook matcher (pre-registration)
- **Question:** R10-5's verifier calls a model in-turn, which the current rules do not allow. Does dated delivery alone make the model-free hook vote worth it?
- **Setup:** `downstream.py prep-system --system "vote:need=2,bt=0.25,lt=6,st=4,strip=1" --dated --turns <world>-h2h,<world>-h2h2`.
  - The same turns as C5-E7 and C6-E1 (code 145, life 169). Conditions: none / vote; the vote packet on the strict sleep store, delivered at Submit, each row dated. The vote fires on code 76/145 and life 105/169 turns.
  - Protocol as in C5-E1: one responder run.
  - It is compared with eden (dated) on the same turns, from those runs. That is a different responder call, so the comparison is between runs.
- **Measure:** per-turn utility of vote − none, with the same shares and bootstrap.
- **Rule, set before running:**
  - **Model-free push pays** if vote-dated utility is > +0.05 on both worlds, with its CI lower bound > 0.
  - **Positive but not firm** if > 0 on both worlds.
  - **Not enough** otherwise.

## C6-E3 · 2026-10-19 · Dated delivery for the model-free hook vote: result
- **Run:** all judged (code 145, life 169); `h2h.py --single <world> <world>-vote-dated`.

  | World | Group | n | Vote (dated) − none | Better / worse |
  |---|---|---|---|---|
  | code | plan-need | 25 | +0.4 | 13 / 4 |
  | code | labeler-only | 30 | −0.133 | 1 / 5 |
  | code | no-need | 90 | −0.022 | 10 / 12 |
  | life | plan-need | 49 | +0.286 | 15 / 7 |
  | life | labeler-only | 30 | −0.133 | 3 / 5 |
  | life | no-need | 90 | −0.022 | 11 / 11 |

  Per-turn utility: **code +0.0183 [−0.0888, +0.1262]; life −0.0039 [−0.1039, +0.0928]**.
- **Verdict, by the rule: not enough.** The model-free vote, even dated, is about zero per turn on both worlds.
  - Dating does stop its wrong fires from costing much (no-need −0.022, against −0.467 undated in C5-E1).
  - But its gain where memory is needed (+0.4 / +0.29) is smaller than the verifier's (+0.52 / +0.49). On the more frequent mildly-related turns it loses (−0.133).
- **What this says:** the verifier's judgment, not dating alone, is what makes push pay. A model-free hook path needs better selection (precision on labeler-only and no-need turns) before it can stand alone.
  - R10-5 part (a), the in-turn off-hook model call, stays the thing to decide; part (b), dating, is necessary but not sufficient.

## C6-R · 2026-10-19 · Review of the cycle 6 consolidation (round 1: REQUEST_CHANGES) and fixes
- **"Firm on both worlds" corrected to "firm by the pre-registered rules", with its caveats:**
  - Code is firm only on the two-run average (C6-E2), a second look pre-registered after C6-E1 found code not firm. Neither run alone excludes 0: run 1 +0.0981 [−0.0158, +0.2158]; run 2 +0.1039 [−0.0046, +0.2137].
  - Life rests on one responder run.
  - The code lower bound is +0.0085 (not "+0.01").
  - Updated in STATE, R10-retrieval and DECISIONS R10-5. The C6-E2 result line above ("firm on both worlds") reads with these caveats.
- **R10-5 now cites D37 as the governing rule.**
  - The measured verifier is haiku, a Claude model that D37 does not allow. Adopting it needs the user to approve an in-turn call and a provider; a NIM model would need a re-measure.
- **C6-E1 setup command:** add `--counts 30,15,60` (the default gives 45 and 64 cases). With it, the committed keys and inputs reproduce exactly.
- **C6-E3 comparison caveats:**
  - "no-need −0.022 vs −0.467 undated (C5-E1)" compares different turn sets (90 vs 15), and the 90 include non-fired turns, where both conditions got an empty packet, so their difference is noise.
  - Fired-only vote − none: code plan-need +0.333 (n 24), labeler-only −0.214 (14), no-need +0.053 (38); life +0.333 (42), −0.167 (24), −0.077 (39).
  - The verifier comparison (+0.52 / +0.49) is between runs, and code's +0.52 is a two-run average.
  - The verdict ("not enough") stands: the vote is about 0 per turn on both worlds (code +0.0183, life −0.0039), and fired-only no-need is about 0 (+0.053 / −0.077).
- **Harness:**
  - `prep_h2h` takes `--vtag` (default `cal-ds3`) for missing verifier outputs.
  - `h2h.py` shares its loading and bootstrap helpers, uses argparse (argument order no longer matters), and asserts when a repeat run lacks a turn.
  - All published numbers re-run unchanged.

## C7-E1 · 2026-10-19 · A model-free hook path, tightened: vote k ≤ 2, superseded store, dated (pre-registration)
- **Blocked first:** a NIM re-measure of the verifier (R10-5 under D37). This environment has no `NVIDIA_API_KEY`; the endpoint answers, but no key is set. That waits on the user adding one to the environment.
- **Motivation (C6-E3 harm cases):** the vote's harmful packets on non-need turns carried stale rows ("the CLI uses yargs" after commander; org-timezone formatting), rules that do not apply, and extra rows beyond the first.
- **Setup:** `prep-system --system "vote:need=2,bt=0.25,lt=6,st=4,strip=1,k=2" --dated --supersede`.
  - Same turns as C6-E3: code 145, life 169. Packets change on 39 and 63 turns.
  - At most 2 rows; the store has the C5-E5 cross-batch supersession pass applied (a sleep-time model, sonnet here; D37 would require NIM); each row dated; delivered at Submit; no model at hook time.
  - Protocol as in C5-E1.
- **Rule, set before running** (`h2h.py --single <world> <world>-vote-k2-sup`):
  - **Model-free path pays** if per-turn utility is > +0.05 on both worlds, with CI lower bound > 0.
  - **Positive, not firm** if > 0 on both.
  - **Not enough** otherwise.

## C7-E1 · 2026-10-19 · A model-free hook path, tightened: result
- **Run:** all judged (code 145, life 169); `h2h.py --single <world> <world>-vote-k2-sup`.

  | World | Group | n | Vote (k ≤ 2, superseded, dated) − none | Better / worse |
  |---|---|---|---|---|
  | code | plan-need | 25 | +0.08 | 11 / 7 |
  | code | labeler-only | 30 | +0.1 | 5 / 3 |
  | code | no-need | 90 | −0.022 | 10 / 11 |
  | life | plan-need | 49 | +0.245 | 15 / 6 |
  | life | labeler-only | 30 | −0.133 | 5 / 6 |
  | life | no-need | 90 | +0.089 | 12 / 5 |

  Per-turn utility: **code +0.0131 [−0.0947, +0.1174]; life +0.0625 [−0.0276, +0.153]**.
- **Verdict, by the rule: positive, not firm.** Both worlds are above 0; neither CI excludes 0, and code is about 0.
- **Fired turns only (post hoc; vote − none, C6-E3's dated vote on the same turns in brackets):**
  - code plan-need +0.087 n 23 (+0.333 n 24), labeler-only +0.308 n 13 (−0.214 n 14), no-need −0.054 n 37 (+0.053 n 38);
  - life plan-need +0.293 n 41 (+0.333 n 42), labeler-only −0.174 n 23 (−0.167 n 24), no-need +0.162 n 37 (−0.077 n 39).
  - The packets differ on only 39 code and 63 life turns, yet code's fired group means move by 0.25–0.5 between the two
    runs. At n ≈ 13–40 per group, one responder run cannot separate the k ≤ 2 / supersession change from run noise
    on code. Life's fired no-need turns gain (+0.162 against −0.077), the direction supersession aimed at;
    but that 0.24 shift is inside the code run-to-run range, and k ≤ 2 changed with it, so it is not attributable.
- **What this says:** tightening the vote helps life a little and does nothing measurable on code. The model-free
  vote is still well below the verifier (+0.52 / +0.49 on need turns, C6). Its weakness is which rows it picks, not
  how they are delivered.

## C7-E2 · 2026-10-19 · Distil the verifier into a model-free scorer (pre-registration)
- **Question:** can a model-free scorer, trained offline on the calibrated verifier's scores, pick rows at the hook
  nearly as well as the verifier does? It would be a small logistic model over lexical, self-play, situation and
  recency features of each candidate: no LLM or embedding call at hook time, and its weights are learned offline.
- **Setup:** `methods_distill.py` (`distill:train=<worlds>,k=2`), `distill.py train`.
  - Candidates: the verifier's own shortlist (lex top 7 + bank top 15, first 15 unique; `verify.py prep`).
  - Target: the verifier's calibrated p for each candidate, from all dev-world calibrated runs (`verify/<world>-cal*`).
  - Threshold: set on the training events alone, so that the scorer fires on the same share of human turns as the
    verifier at p ≥ 0.6. Fixed before any test.
  - Tests (retrieval, `score.py --strict`, human turns):
    - (a) leave one world out on dev (train code → test life `--split dev --sample judge`, and the reverse);
    - (b) train on both dev worlds → test on the red-team worlds `code-rt1`, `life-rt1` (`--split fresh`).
  - Baseline: `vote:need=2,bt=0.25,lt=6,st=4,strip=1,k=2` on the same events. Reference: `verify:tag=cal,p=0.6`.
    - Measured now on (b): vote k2 recall / precision / silence: code-rt1 0.1276 / 0.1569 / 0.6444; life-rt1
      0.1739 / 0.1489 / 0.6176. Verifier: code-rt1 0.3414 / 0.3673 / 0.7778; life-rt1 0.0688 / 0.1667 / 0.8529.
- **Rule, set before running** (on all four tests):
  - **Worth a downstream run** if precision ≥ vote k2 + 0.10 and recall ≥ vote k2 − 0.02, on at least 3 of the 4.
  - **Dead** if precision is not above vote k2 on at least 3 of the 4.
  - **Unclear** otherwise (report, no downstream run).

## C7-E2 · 2026-10-19 · Distil the verifier into a model-free scorer: result
- **Training** (`distill.py train --worlds code|life|code+life`): the shortlist rebuilds the verifier's exactly
  (code 4095/4095 candidates, life 4993/4994). The verifier fires on 0.4719 (code), 0.4983 (life) and 0.4858
  (both) of the training human turns; thresholds 0.2856 / 0.3125 / 0.293. Fit to the verifier's p on the training
  rows: corr 0.599 / 0.5545 / 0.5729. The largest weights are the lexical score, situation entry and the bank score.
- **Tests** (human turns; recall / precision / silence):

  | Test | Vote k2 | Distilled | Verifier p0.6 |
  |---|---|---|---|
  | (a) train code → life dev | 0.1751 / 0.0817 / 0.5278 | 0.1962 / 0.113 / 0.5741 | 0.2785 / 0.2171 / 0.7407 |
  | (a) train life → code dev | 0.2697 / 0.103 / 0.5545 | 0.2606 / 0.1345 / 0.6091 | 0.5121 / 0.2308 / 0.6364 |
  | (b) both → code-rt1 | 0.1276 / 0.1569 / 0.6444 | 0.1034 / 0.1163 / 0.6667 | 0.3414 / 0.3673 / 0.7778 |
  | (b) both → life-rt1 | 0.1739 / 0.1489 / 0.6176 | 0.1558 / 0.1395 / 0.6176 | 0.0688 / 0.1667 / 0.8529 |

- **Verdict, by the rule: dead.** Precision is above vote k2 on 2 of the 4 tests (+0.0313 and +0.0315 on dev),
  below on both red-team worlds (−0.0406, −0.0094); the rule needed 3 of 4. It never reaches the +0.10 line.
- **What this says:** the features a hook can compute cheaply (word overlap, self-play matches, new entities,
  recency, row kind) explain about a third of the verifier's judgment (corr ≈ 0.57), and the learned mix of them is
  no better a picker than the hand-set vote. The verifier's edge is understanding the turn, which these features do
  not carry. F16 (C3-E2) found the same at the turn level; this closes the row level.

## C7-E3 · 2026-10-19 · Life head-to-head, second independent run (pre-registration)
- **Why:** the head-to-head's life result (C6-E1, +0.1346 [+0.0352, +0.2332]) rests on one responder and judge run;
  code needed a second run to be firm (C6-E2). The same second look for life, set up exactly as C6-E2.
- **Setup:** a new sonnet responder and a new blind opus judge (history evidence) on the same 169 life turns and
  packets as C5-E7 and C6-E1 (`downstream/life-h2h-r2`, `life-h2h2-r2`: copies of the inputs and keys).
  - Each turn's condition − none is averaged over the two runs (`h2h.py life --pool h2h2 --runs r2`); shares and
    bootstrap unchanged.
- **Rule, set before running (the averaged result decides, whichever way it goes):**
  - **Firm on life (two runs)** if the averaged pooled 95% CI lower bound is > 0.
  - **Lead stands** if the point estimate stays ≥ +0.05.
  - **Weakened** if it falls below +0.05.
  - Run 2 alone is reported too.

## C7-E3 · 2026-10-19 · Life head-to-head, second independent run: result
- **Run:** the same 169 life turns and packets; a new sonnet responder and a new blind opus judge (history
  evidence); all 169 turns judged (`life-h2h-r2` 75, `life-h2h2-r2` 94).
- **Run 2 alone:** verify +0.1189, eden −0.0149, difference **+0.1338, 95% CI [+0.0181, +0.2475]**. It replicates
  run 1 (+0.1346 [+0.0352, +0.2332]), and on its own it also excludes 0.
- **Decision measure (each turn averaged over both runs; `h2h.py life --pool h2h2 --runs r2`):**

  | Group | n | Eden (dated) | Verify (dated) |
  |---|---|---|---|
  | plan-need | 49 | +0.041 (7 / 10) | **+0.469 (24 / 3)** |
  | labeler-only | 30 | +0.133 (11 / 3) | +0.25 (14 / 7) |
  | no-need | 90 | −0.039 (11 / 18) | +0.039 (19 / 12) |

  Per-turn utility: verify +0.1433, eden +0.0091, **difference +0.1342, 95% CI [+0.0415, +0.2275]**.
- **Verdict, by the rule: firm on life (two runs).** Both worlds now rest on two independent responder and judge
  runs: code +0.1011 [+0.0085, +0.1988], life +0.1342 [+0.0415, +0.2275]. Unlike code, each life run alone also
  excludes 0.
- **Caveats unchanged:** every model is Claude (responder sonnet, judge opus, verifier haiku, sleep compiler sonnet);
  the verifier's model is not one D37 allows; the turns are synthetic StreamBench turns.

## C7-R · 2026-10-19 · Review of the cycle 7 consolidation (round 1: REQUEST_CHANGES) and fixes
- **DECISIONS R10-5:** "model-free alternatives about 0" replaced by each verdict as recorded: C6-E3 about 0; C7-E1
  positive, not firm (code +0.013, life +0.063, both CIs include 0); C7-E2 dead on retrieval precision, no
  downstream run.
- **Headline:** "no model at all" → "no model in the turn" (C7-E1's store has a sleep-time supersession pass, and
  both use sleep-compiled rows); C7-E1's small life result is stated.
- **C7-E1 life fired no-need gain:** now labelled post hoc, between runs, and confounded with k ≤ 2 (STATE, LEDGER).
- **Harness:** the verifier's shortlist is one helper (`methods.shortlist`) used by `verify.py prep` and
  `methods_distill.py`; dead `-rt` check removed from `distill.py`; features constant in training standardise to
  0 (sd floor). Retrained weights reproduce every C7-E2 number above unchanged.
- **Process note (C7-E2):** the prereg was committed before the scorer code but did not freeze the feature list or
  fit settings. Future preregs commit the method with the rule.
- **Local CI on the cycle 7 tree:** format, typecheck, build pass. test:parallel has 3 failures: `switches.test.ts`
  and `memory-purge.test.ts` fail identically on origin/main in this environment (root on Linux; chmod 000 does not
  stop root), and `doctor.test.ts` "a hung wrap fetch" failed under load and passes alone on main and this branch.
  No TypeScript changed in this cycle.

## C8-E1 · 2026-10-19 · Where the dated verifier still gives nothing (diagnostic, post hoc)
- **Data:** run 1 of the head-to-head (`<world>-h2h`, `<world>-h2h2`; code 145, life 169 turns). Packets from
  `in/responses-in.json`; verify − none from the judged files.
- **Plan-need turns with an empty verify packet:** code 5 of 25, life 18 of 49. Causes (`score.action_text` and the
  calibrated scores):
  - no tool call in the turn, so the deferred delivery point never comes: code 2, life 11 (for example "remind me what
    I said actually helps me unwind on weekends", "remind me how I said I learn spanish best");
  - the turn had a tool call but nothing passed: the verifier gave every candidate < 0.6 (code 3, life 5), or the
    hook's shortlist was empty (life 2: life-s005-e002, life-s007-e013).
- **If no-tool turns were delivered too** (for example, by a pickup call the hook asks for): packets would be added on
  code 2 plan / 1 labeler-only / 2 no-need turns and life 11 / 3 / 8. Rough ceiling: plan share × the share of plan
  turns that would gain a packet × the two-run gain on plan turns that did get one (C7-E3 data; life +0.726, n 31;
  code +0.625, n 20): life 0.137 × 11/49 × 0.726 ≈ +0.022 per turn, code 0.141 × 2/25 × 0.625 ≈ +0.007.
  It assumes
  the added packets help as much as the delivered ones and ignores the 8 / 2 added no-need packets. An effect of
  that size is well inside the ±0.1 per-turn CIs, so no downstream run is pre-registered. (Corrected in C8-R; it first
  read "at most +0.015", using the all-plan-turn mean +0.469 from C7-E3, which includes the 18 empty-packet turns.)
- **Empty-packet turns are an A/A check:** where verify's packet is empty, both conditions are "no memory", so their
  differences are pure responder + judge noise: code no-need 4 better / 10 worse / 54 equal, life 6 / 3 / 66.

## C8-T1 · 2026-10-19 · NIM verifier runner, ready for the R10-5 re-measure
- `verify_nim.py` runs the calibrated verifier prompt (PROMPTS.md F22b) on an NVIDIA NIM model over the inputs of the
  existing calibrated runs, writes outputs in the same format to `verify/<world>-<tag>/out/` and logs each call's
  latency and usage. `--latency` prints p50 / p95 / max. The key is read from the environment or `.env`, never
  printed or written.
- Checked against a local mock endpoint: outputs parse, `score.py --systems verify:tag=<tag>,p=0.6` reads them, the
  latency summary prints, and a missing key exits with a message. Not run against NIM: no key in this environment.

## C8-E2 · 2026-10-19 · Sleep lag in the harness store (diagnostic, post hoc)
- **Seen in C8-E1's misses:** life-s156-e000 ("halloween is in 11 days…") needs the Halloween plan agreed with Hannah
  (astronaut, leaving 5:45). The store has that row, but it becomes visible at t 2991.5, after the turn (t 2970): the
  harness compiles 10 sessions per sleep batch, and `--strict` shows a batch's rows only after its last session.
- **Store ceiling (oracle-need, dev, human turns; recall / full):**

  | World | Batch end (`--strict`) | Session end |
  |---|---|---|
  | code | 0.8242 / 0.8 | 0.9212 / 0.9091 |
  | life | 0.6667 / 0.6076 | 0.7532 / 0.7089 |

  Session-end visibility is optimistic: the compiler read the whole batch, so a row's cues (and sometimes text) can
  carry later sessions' content. The truth for a per-session sleep lies between the two columns.
- **Head-to-head plan-need turns with a need coverable only after the lag:** code 3 of 25, life 6 of 49.
- **What this says:** the product sleeps far more often than every 10 sessions (the idle sleeper runs after each
  burst of activity, and the hook writes some rows at once, DECISIONS P-tier notes on `eden sleep --idle`). The
  head-to-head gave eden its own packets from the real plugin replay, but gave the verifier the batch-lagged harness
  store, so on store freshness the C6/C7 comparison is conservative for the verifier. A leak-free per-session
  compile would measure it; it costs one compiler run per session (code 110, life 160 sessions) and is not
  scheduled.

## C8-E3 · 2026-10-19 · How well do two independent runs agree turn by turn? (diagnostic)
- **Data:** the head-to-head turns judged in both runs (code 145, life 169); per turn, condition − none in run 1 vs
  run 2 (same packets, new responder, new judge).

  | Sub | n | verify − none: r / sign agreement | eden − none: r / sign agreement |
  |---|---|---|---|
  | code-h2h | 70 | 0.366 / 0.671 | 0.132 / 0.686 |
  | code-h2h2 | 75 | 0.048 / 0.68 | 0.18 / 0.693 |
  | life-h2h | 75 | 0.59 / 0.76 | 0.294 / 0.653 |
  | life-h2h2 | 94 | 0.459 / 0.691 | 0.266 / 0.691 |

- **What this says:** a single turn's verdict is mostly noise (r 0.05–0.59; a quarter to a third of signs
  differ between runs), so only aggregates over about 150 turns carry information, and a second run is worth
  what it cost. The verifier's effect replicates better than eden's (higher r on three of four), which fits a real
  effect against a near-zero one. Per-turn examples in this ledger illustrate; they never decide.

## C8-E4 · 2026-10-19 · Time from Submit to the first tool call in real Claude Code sessions (pre-registration)
- **Why:** R10-5's checker must finish before the turn's first tool call (R10-5-BUILD-SKETCH.md). The harness has no
  clock; a real session does.
- **Setup:** headless `claude -p` (the CLI's default model) in a throwaway worktree of this repo at origin/main;
  hooks log timestamps at UserPromptSubmit, every PreToolUse and Stop. Read-only tools allowed (Read, Grep, Glob,
  `git log`/`git diff`); writes are denied, which can only delay or remove the first call, never hasten it.
  12 fixed prompts, one fresh session each: 10 ordinary coding asks about this repo, 2 with no work ("thanks…",
  arithmetic). Prompts are listed in `benchmarks/memory-stream/ttft/prompts.txt`.
- **Measure:** first PreToolUse − Submit (seconds), p50 / p90 / max over the turns that make a call; the share of
  turns with no call; Stop − Submit for those.
- **What it informs (set before running):** a checker whose p95 latency is above the p50 of this gap misses more
  than half of the turns it would serve. D37's recorded NIM p95 (40–70 s) is the case in question. It is a timing
  measurement on one machine and one model, not an outcome measure.
- **C8-E4 run 1 void (harness bug):** the loop fed prompts on stdin, and `claude -p` also reads stdin, so the first
  session received every remaining prompt appended and later sessions got the leftovers (sessions answered "your
  message also had a list of earlier requests"). Its timings are discarded and not reported. Re-run with
  stdin closed (`< /dev/null`), one prompt per session.

## C8-E4 · 2026-10-19 · Time from Submit to the first tool call: result
- **Run 2** (stdin closed; 12 sessions, one prompt each; headless `claude -p`, the CLI's default model, read-only
  tools). Per session (seconds after Submit):

  | # | Prompt (short) | First tool | Calls | Last tool | Stop |
  |---|---|---|---|---|---|
  | 1 | hook exit 0 | 2.49 | 6 | 11.2 | 24.1 |
  | 2 | test-parallel vs test | 4.21 | 2 | 4.8 | 13.1 |
  | 3 | add a unit test (write denied) | 5.36 | 9 | 27.4 | 34.5 |
  | 4 | rename (write denied) | 2.51 | 4 | 8.7 | 15.7 |
  | 5 | EDEN_MEMORY_DIR in tests | 2.23 | 3 | 4.8 | 12.8 |
  | 6 | fix long line (write denied) | 2.62 | 2 | 4.8 | 9.2 |
  | 7 | PROGRESS next | 2.92 | 1 | 2.9 | 12.6 |
  | 8 | purge command | 14.13 | 2 | 15.8 | 24.0 |
  | 9 | explain h2h.py | 2.17 | 1 | 2.2 | 8.6 |
  | 10 | last 3 commits | 2.96 | 2 | 6.2 | 16.8 |
  | 11 | thanks | — | 0 | — | 5.3 |
  | 12 | 17 × 23 | — | 0 | — | 7.9 |

- **First tool call** (10 turns with a call; index method int(f·n), not pre-specified; the conventional median is
  2.77 s): p50 2.92 s, p90 14.13 s, max 14.13 s, min 2.17 s. 2 of 12 turns make no call.
- **If delivery could use any later tool call in the turn** (post hoc): a checker answering in 3 s still finds a call
  to come in 8 of 12 turns; 5 s: 5; 10 s: 3; 20 s: 1; 40 s and 70 s: 0.
- **What this says:** the checker has about 3 seconds. For hosted NIM the repo records p50 1–20 s and p95 40–70 s
  (EXECUTION.md, R8): at best it would reach some turns (calls near the low end of its median), and it would miss
  at least the slowest 5% of calls entirely. Real numbers wait on the `verify_nim.py` re-measure.
- **Correction to the prereg's inference (C8-R):** "a checker whose p95 latency is above the p50 of this gap misses
  more than half of the turns" does not follow; missing more than half needs the checker's *median* above the gap's
  median. The prereg text above stands as written.
- **Model and setup:** the sessions ran on the CLI's default model (sonnet), with haiku for the CLI's auxiliary
  calls. The committed `ttft/settings.json` is the hooks that ran, with the scratch log path replaced by
  `$TTFT_LOG`.
- **Caveats:** one machine, one model, n = 12, and writes were denied, which ends edit turns early (more calls would
  follow in a real edit turn, so the later-call counts are a floor).

## C8-E5 · 2026-10-19 · Could the check run late and deliver at the next turn? (post hoc label check)
- **Idea:** with no time pressure, a slow D37 model checks turn t in the background, and its packet is delivered at
  turn t+1's Submit (model-free at the hook). It helps only if turn t+1 needs what turn t needed.
- **Labels (dev human turns with a need and an earlier human turn in the same session):** turns whose needs or
  in-context items overlap the previous turn's: code 0 of 37, life 0 of 59. A further 18 of 55 code and 20 of 79 life
  need turns are the first human turn of their session, with no earlier turn to check.
- **Verdict: dead on this benchmark.** Each need in StreamBench is its own moment. This may understate continuity in
  real work (the worlds were authored that way), but nothing here supports building it.

## C8-E6 · 2026-10-19 · How fast is the small Claude model on the checker call? (pre-registration)
- **Setup:** `claude -p --model haiku --system-prompt <the calibrated verifier prompt> --tools ""` on 20 verifier
  inputs (the first 10 cases with candidates in `verify/code-cal/in` and in `verify/life-cal/in`), one call each,
  stdin closed. Read `duration_api_ms` and token usage from the JSON output.
- **Measure:** p50 / p90 / max API time; output and thinking tokens. The CLI keeps a thinking budget it does not let
  me turn off (two probes: about 500 thinking tokens with and without `MAX_THINKING_TOKENS=0`), so this times the
  call as the CLI makes it; a direct API call without thinking would be faster and is not measured.
- **What it informs:** whether the measured checker fits C8-E4's ~3 s budget as is.

## C8-E6 · 2026-10-19 · How fast is the small Claude model on the checker call? Result
- **20 calls** (10 code, 10 life). API time: **p50 5645 ms, p90 8422 ms, max 8744 ms, min 3525 ms**. Output tokens
  median 893, of which thinking median 599. The one call with no thinking (294 output tokens) took 3525 ms.
- **Against C8-E4's budget:** at about 5.6 s the check misses the first tool call in most turns; delivering at any
  later call of the turn, a 5 s check reached 5 of 12 turns and a 10 s check 3 of 12 (C8-E4, post hoc).
- **What this says:** as the CLI runs it, the measured checker is about twice too slow for the turn. Output length is
  the lever: about 900 tokens (thinking plus 15 scores) at roughly 6 ms a token. A direct API call with thinking off
  and a reply that lists only the rows it keeps would be a few dozen output tokens; that variant's latency and
  quality are not measured (its quality would need the C6-style downstream re-run, since it changes the prompt).
- **Probes (unverified: one call each, no saved artifact):** `MAX_THINKING_TOKENS=0` and `--effort low` did not turn
  thinking off (514 and 454 thinking tokens; 4792 and 5230 ms). The no-thinking variant cannot be timed from here.
- **Correction (C8-R):** "roughly 6 ms a token" is an average. A linear fit over the 20 calls gives about 3.9 ms per
  output token plus about 2.4 s fixed; the one no-thinking call (294 output tokens) took 3525 ms, already above
  C8-E4's 2.92 s. So even a short, no-thinking reply may sit at or above the budget through this route. The calls
  carried 3.3k–4.2k input tokens (CLI overhead on top of the ~1.7k-token case).

## C8-R · 2026-10-19 · Review of the cycle 8 consolidation (round 1: REQUEST_CHANGES) and fixes
- **NIM latency claim corrected:** "would reach no turn" used only the p95. The repo records hosted NIM at p50 1–20 s
  and p95 40–70 s (EXECUTION.md, R8), so it would reach some turns at best and miss at least the slowest 5% of calls.
  Corrected in the C8-E4 result (with a note that the prereg's inference does not follow), STATE, the sketch and
  the headline.
- **C8-E1 ceiling recomputed** with the gain on plan turns that did get a packet (C7-E3 two-run data: life +0.726,
  n 31; code +0.625, n 20): about +0.022 (life) and +0.007 (code) per turn, not "at most +0.015"; still far inside
  the ±0.1 per-turn CIs.
- **C8-E1 cause split:** life's 7 "below 0.6" turns are 5 below 0.6 plus 2 with an empty shortlist.
- **C8-E4:** the percentile index method is labelled as not pre-specified (conventional median 2.77 s); the model
  (sonnet; haiku for auxiliary calls) and the settings file's `$TTFT_LOG` substitution are stated.
- **C8-E6:** the thinking-off probes are labelled unverified (no saved artifact); the per-token figure is replaced by
  a linear fit (≈ 3.9 ms per output token + ≈ 2.4 s fixed), which says a short reply may still miss through the CLI.
- **Build sketch:** both effects labelled "over today's plugin"; the CLI calls' input size (3.3k–4.2k) noted.
- **verify_nim.py:** an unparseable reply is logged (`parsed`, `finish_reason`) and counted at the end; latency now
  covers the whole call with retries and backoff, with `attempts` logged; dropped connections are retried; the
  docstring no longer claims a NIM_MODEL default and says which preps read a NIM tag. Re-checked against mock
  endpoints (normal, garbage, one 500, one dropped connection): 0 / 6 / 0 / 0 unparsed replies, 1 / 1 / 2 / 2
  attempts, and the test key in no output.
- **Local CI on 4feb48ce** (outside the repo): format, typecheck, build pass; test:parallel 5320 pass, 32 skip,
  2 fail (`switches.test.ts`, `memory-purge.test.ts`, the root-on-Linux failures that also fail on origin/main), and
  the serial latency-gated files pass alone. Only Python and Markdown changed after it.

## C9-E1 · 2026-10-19 · A short-reply checker: does listing only the kept rows keep its quality? (pre-registration)
- **Why:** C8-E6 found the checker's latency is mostly output length (≈ 900 output tokens; ≈ 3.9 ms per token plus
  ≈ 2.4 s fixed). A reply that lists only the rows it keeps is a few dozen tokens. Before timing it anywhere, check
  that it picks as well.
- **Setup:** the calibrated prompt (PROMPTS.md F22b) with one change to the output: list only candidates with
  p ≥ 0.5 (`{"scores": {id: p}}` for those, `{}` if none). Same model (haiku), same inputs: `verify/<world>-cal/in`
  (dev) and `verify/<world>-rt1-cal/in` (red team), one case per file in stream order, written to
  `verify/<world>-short/out`. Read by `score.py --systems "verify:tag=short,p=0.6"`.
- **Compare** (human turns, `--strict`): recall and precision against `verify:tag=cal,p=0.6` on four tests: code dev
  and life dev (`--split dev --sample judge`), code-rt1 and life-rt1 (`--split fresh`).
- **Rule, set before running:**
  - **Keeps quality** if recall ≥ cal − 0.03 and precision ≥ cal − 0.03 on at least 3 of the 4.
  - **Loses quality** otherwise.
  - Latency is not measured here.

## C9-E1 · 2026-10-19 · A short-reply checker: result
- **Run:** all inputs answered (code 195, life 245, code-rt1 74, life-rt1 81 files). Human turns, recall / precision:

  | Test | cal p0.6 | short p0.6 | Δ recall | Δ precision | Pass? |
  |---|---|---|---|---|---|
  | code dev | 0.5121 / 0.2308 | 0.5121 / 0.2093 | 0.0 | −0.0215 | yes |
  | life dev | 0.2785 / 0.2171 | 0.2848 / 0.2393 | +0.0063 | +0.0222 | yes |
  | code-rt1 | 0.3414 / 0.3673 | 0.3701 / 0.3115 | +0.0287 | −0.0558 | no |
  | life-rt1 | 0.0688 / 0.1667 | 0.1159 / 0.2857 | +0.0471 | +0.119 | yes |

- **Verdict, by the rule: keeps quality** (3 of 4 within −0.03 on both).
- **Reply size:** the short checker keeps on average 1.59 (code), 1.23 (life), 1.65 (code-rt1), 1.0 (life-rt1) rows
  per case, and nothing on 67 / 87 / 23 / 30 cases. The reply is a few dozen tokens instead of 15 scores (thinking
  aside).
- **Invented ids:** in 4 code dev files the short checker named 5 row ids that were not among that case's
  candidates (the calibrated outputs have none). Scoring only each case's candidates moves code dev short precision
  from 0.2093 to 0.2118 (reviewer probe); the verdict does not change.
- **Silence (counter-metric, not in the rule):** lower on all four tests, cal → short: code 0.6364 → 0.6091, life
  0.7407 → 0.7315, code-rt1 0.7778 → 0.7556, life-rt1 0.8529 → 0.8235. The short checker fires on more no-need turns.
  life-rt1 has 57 human turns at recall ≈ 0.1 and code dev passes precision by 0.0085, so 3 of 4 is weak evidence.
- **Caveats:** retrieval-level only, against plan labels; a downstream run would be needed before it replaces the
  calibrated checker in an outcome claim. Latency is not measured here (the CLI keeps thinking on; C8-E6), so whether
  it fits the ~3 s budget is still open; C8-E6's fit puts ≈ 2.4 s fixed under each CLI call.

## C9-E2 · 2026-10-19 · Latency of the short-reply checker through the CLI (pre-registration)
- **Setup:** as C8-E6 (same 20 inputs, `claude -p --model haiku --tools ""`, stdin closed), with the short-reply
  system prompt (C9-E1's output rule). Read `duration_api_ms` and token usage.
- **Measure:** p50 / p90 / max API time and output tokens, beside C8-E6's (p50 5645 ms). Thinking stays on (the CLI
  does not let it be turned off), so this times the short reply plus thinking.

## C9-E2 · 2026-10-19 · Latency of the short-reply checker through the CLI: result
- **20 calls:** API time **p50 4994 ms, p90 7727 ms, max 10045 ms, min 2491 ms** (C8-E6 full-score: p50 5645 ms).
  Output tokens median 591, of which thinking median 563 (index rule int(f·n); conventional medians 585 and 539), so the visible reply is now about 30 tokens and thinking is
  almost all of the output (`ttft/checker-latency-c9e2.json`).
- **What this says:** the short reply removes the scoring text, but through the CLI thinking dominates and the call
  is still about 5 s at p50. The remaining lever is turning thinking off, which this environment cannot do. By
  C8-E6's fit (≈ 3.9 ms per output token, ≈ 2.4 s fixed), dropping ~560 thinking tokens would land near 2.5–3 s, at
  the edge of the ~3 s budget; that is an extrapolation, not a measurement.

## C9-R · 2026-10-19 · Review of the cycle 9 consolidation (APPROVE, minor fixes)
- Recorded above: the 5 invented ids and their effect, the silence drop on all four tests, the median convention.
- STATE: code-rt1 precision "drops 0.056 (limit 0.03)". Sketch: "passes 3 of 4 quality tests" in place of "picks
  as well". PROMPTS.md: an F22c row with the short-reply output rule (subagent and CLI forms).
- **Local CI on 07013892** (outside the repo): format, typecheck, build pass; test:parallel 5319 pass, 32 skip,
  4 fail. `switches.test.ts` and `memory-purge.test.ts` are the root-on-Linux failures that also fail on origin/main;
  `doctor.test.ts` ("a hung wrap fetch") and `benchmarks/memory-long-horizon/harness/replay.test.ts` (a hook timed
  out) failed under load and pass alone (40 and 6 tests, 0 fail; the reviewer re-ran both too). No code changed in
  this cycle.

## C9-E3 · 2026-10-19 · Gain kept at each checker latency (estimate, post hoc)
- From C8-E4's 10 sessions with a tool call (last tool call times as in its table) and the two-run gains over today's
  plugin (code +0.1011, life +0.1342): reachable turns at latency L × gain. L ≤ 2 s: 10 of 10 (+0.1011 / +0.1342);
  3 s: 8 (+0.0809 / +0.1074); 5 s: 5 (+0.0505 / +0.0671); 10 s: 3 (+0.0303 / +0.0403); 20 s: 1 (+0.0101 / +0.0134).
- Assumes an even spread of the gain over turns and delivery at any later tool call; n = 10. Added to the build
  sketch as an estimate.

## C10-E1 · 2026-10-19 · Fast non-thinking NIM models as the checker (pre-registration; waits on the key)
- **Why:** the checker's latency is mostly thinking (C8-E6, C9-E2). A fast model that answers directly, with the
  short reply (F22c), may fit the ~3 s budget, and NIM is the D37 provider. The user connected NIM; the key is not
  visible in this session yet (a NIM call returned 401, "authorization missing").
- **Candidates** (on the NIM list today, non-reasoning, small or fast): `google/gemma-3-4b-it`,
  `google/gemma-3-12b-it`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `z-ai/glm-5.3-flash`,
  `nv-mistralai/mistral-nemo-12b-instruct`.
- **Step 1, smoke (per model):** `verify_nim.py --world code-rt1 --src cal --tag nim-<m> --short --model <id>`
  on the first 30 code-rt1 inputs. Read end-to-end latency (retries and queueing included) and the parse rate.
  Models with p50 ≤ 3 s and ≥ 95% parsed go to step 2 (at most the two fastest).
- **Step 2, quality:** the same model on all four C9-E1 test inputs (code and life dev `cal`, code-rt1 and life-rt1
  `cal`), scored with `score.py --strict --systems verify:tag=nim-<m>,p=0.6` against `verify:tag=cal,p=0.6`.
- **Rule, set before running:**
  - **Viable checker** if p50 latency ≤ 3 s over all its calls AND recall ≥ cal − 0.03 and precision ≥ cal − 0.03
    on at least 3 of the 4 tests.
  - **Fast but weaker** if the latency holds and quality fails; **too slow** if p50 > 3 s.
- `verify_nim.py` gains `--model` and `--short` (checked against a mock endpoint).
- **Amendment before any result (2026-10-19):** the user amended D37 to allow the in-turn checker on TypeSafe Jev
  or a fast NIM model. **Jev joins the candidates**, run by `verify_jev.py` (one request per turn; the turn, recent
  context and earlier turns as `state`; one Noul yes/no question per candidate; the Noul value is the row's p;
  `--tag jev`). Same two steps and the same rule as above (smoke on the first 30 code-rt1 inputs, then the four
  quality tests at p ≥ 0.6; viable if p50 ≤ 3 s end to end and the C9-E1 quality rule holds). Jev's latency is
  measured from this container, network included. Checked against a mock endpoint; no TypeSafe key is set yet.

## C10-E1 · 2026-10-19 · Fast checkers: result for TypeSafe Jev (NIM still running)
- **Run:** a child session in the same environment (this session cannot see secrets added after it started) ran
  `verify_jev.py` on all four tests' inputs (rebuilt from `verify.py prep`; they match the originals exactly) and
  pushed the outputs (`claude/r10-c10-runs`, merged here). Model `jev-1.13.0`; 0 unanswered questions; no retries.
- **Latency, end to end from the container** (`verify_jev.py --latency`): code-rt1 p50 0.207 s, p95 0.271 s (74
  calls); life-rt1 0.229 / 0.336 (81); code 0.262 / 0.461, max 5.11 (181); life 0.234 / 0.34 (228).
- **Quality at p ≥ 0.6** (human turns, recall / precision):

  | Test | cal p0.6 | Jev p0.6 | Δ recall | Δ precision | Pass? |
  |---|---|---|---|---|---|
  | code dev | 0.5121 / 0.2308 | 0.4636 / 0.2366 | −0.0485 | +0.0058 | no |
  | life dev | 0.2785 / 0.2171 | 0.1962 / 0.2174 | −0.0823 | +0.0003 | no |
  | code-rt1 | 0.3414 / 0.3673 | 0.2253 / 0.2979 | −0.1161 | −0.0694 | no |
  | life-rt1 | 0.0688 / 0.1667 | 0.1159 / 0.24 | +0.0471 | +0.0733 | yes |

- **Verdict, by the rule: fast but weaker** (latency far inside 3 s; quality passes 1 of 4).
- **Post hoc, lower thresholds do not rescue it:** at p 0.5 / 0.4 / 0.3 / 0.2 recall barely rises (code-rt1 0.2425 /
  0.277 / 0.277 / 0.2943, never reaching cal's 0.3414) while precision falls (0.2055 / 0.1868 / 0.1429 / 0.125).
- **NIM so far (child session, smokes still running):** both Gemma models returned HTTP 404; Nemotron 3.5 Lightning
  ran at p50 ≈ 14.5 s (over the bar). Recorded fully when the child finishes.

## C10-E2 · 2026-10-19 · Does Jev do better with a better-posed question? (pre-registration)
- **Why (the user's question):** Jev reads questions literally and judges each question in isolation (TypeSafe's
  jaggedness notes). C10-E1 gave it short criteria, each row alone, and the earlier-turns calibration block that
  was written for haiku.
- **Variants** (`verify_jev.py --variant`), all on the same inputs:
  - `rich`: precise criteria with boundary cases; state = turn + recent (no earlier turns).
  - `list`: as `rich`, plus every candidate row in the state, so each row is judged with its alternatives visible.
  - `decomp`: as `rich`, three atomic Nouls per row (needed, already stated in turn/recent, about something the turn
    involves); p = needed × (1 − stated) × related, combined in code.
- **Selection on dev only:** each variant × threshold in {0.3, 0.4, 0.5, 0.6, 0.7} on code dev and life dev; the
  pick maximises the mean over the two of (recall − cal recall) + (precision − cal precision).
- **Test once on the red-team worlds** with the pick: **viable** if on both code-rt1 and life-rt1 recall ≥ cal − 0.03
  and precision ≥ cal − 0.03, with p50 latency ≤ 3 s; otherwise **still weaker**. C10-E1's base Jev stays recorded
  as it is.

## C10-E1 · 2026-10-19 · NIM smokes (child session, code-rt1, first 30 inputs)
- `google/gemma-3-4b-it`, `google/gemma-3-12b-it`, `nv-mistralai/mistral-nemo-12b-instruct`: HTTP 404, 0 calls.
- `nvidia/nemotron-3.5-lightning-30b-a3b`: 30 calls, p50 14.344 s, p95 69.474 s, max 98.773 s; 30 of 30 replies did
  not parse.
- `z-ai/glm-5.3-flash`: failed after retries with no HTTP status (network or timeout), 0 calls.
- **Verdict for NIM: no candidate met the smoke bar** (p50 ≤ 3 s and ≥ 95% parsed), so no full NIM runs.

## C10-E2 · 2026-10-19 · Better-posed Jev questions: dev selection
- **Dev runs** (child session, `verify_jev.py` at 0e95f386; 0 unanswered questions; p50 latency 0.231–0.249 s,
  p95 0.303–0.368 s, max 0.663 s in every variant × world).
- **Selection score** (mean over code and life dev of Δrecall + Δprecision against cal p0.6), top five:

  | Variant, threshold | Score | code recall / precision | life recall / precision |
  |---|---|---|---|
  | decomp 0.7 | −0.0058 | 0.2152 / 0.4 | 0.0823 / 0.5294 |
  | rich 0.7 | −0.0208 | 0.497 / 0.2194 | 0.2532 / 0.2273 |
  | list 0.7 | −0.0248 | 0.4879 / 0.2378 | 0.2532 / 0.2101 |
  | decomp 0.5 | −0.0297 | 0.4697 / 0.2689 | 0.1835 / 0.2571 |
  | list 0.6 | −0.0393 | 0.5061 / 0.1832 | 0.2848 / 0.1859 |

  (cal p0.6: code 0.5121 / 0.2308, life 0.2785 / 0.2171.)
- **The pre-registered pick is decomp at 0.7.** It is a lopsided point: much higher precision, much lower recall.
  The selection score adds Δrecall and Δprecision, so it can reward giving up recall for precision; the test rule
  (both within −0.03) will not. That is a flaw in the pre-registered selection, recorded here before the test.
- **Not pre-registered, noted before the test:** rich 0.7 and list 0.7 are within −0.03 of cal on both recall and
  precision on both dev worlds (largest gap −0.0253), while C10-E1's base Jev at p0.6 was not (recall −0.0485,
  −0.0823). They will be run on the red-team worlds too and reported as post hoc; only decomp 0.7 decides C10-E2.

## C10-E2 · 2026-10-19 · Better-posed Jev questions: red-team result
- **Runs** (child session; 0 unanswered questions; p50 0.221–0.273 s, p95 0.288–0.342 s, max 0.688 s). Human turns,
  recall / precision:

  | Test | cal p0.6 | decomp 0.7 (the pick) | rich 0.7 (post hoc) | list 0.7 (post hoc) |
  |---|---|---|---|---|
  | code-rt1 | 0.3414 / 0.3673 | 0.0828 / 0.6 | 0.3011 / 0.2951 | 0.2897 / 0.3617 |
  | life-rt1 | 0.0688 / 0.1667 | 0.0 / — (never fires) | 0.1159 / 0.2308 | 0.1159 / 0.2143 |

- **Verdict, by the rule: still weaker.** The pick (decomp 0.7) loses most of its recall on both red-team worlds
  (code −0.2586; life fires on no human turn).
- **Post hoc (not deciding):** list 0.7 is the closest: code-rt1 recall −0.0517, precision −0.0056; life-rt1 recall
  +0.0471, precision +0.0476. rich 0.7: code-rt1 −0.0403 / −0.0722; life-rt1 +0.0471 / +0.0641. Neither is within
  −0.03 on code-rt1 recall. Against C10-E1's base Jev at p0.6 on code-rt1 (0.2253 / 0.2979), list 0.7 gains +0.0644
  recall and +0.0638 precision: the better-posed question does most of the work the user expected.
- **What this says:** Jev is about ten times inside the latency budget, and with precise criteria and the candidate
  list in view it nearly matches the calibrated haiku checker at retrieval level (short by about 0.05 recall on
  code-rt1, ahead on life-rt1). Whether that gap matters for replies is an outcome question: a C6-style downstream
  head-to-head of Jev list 0.7 is the next test.

## C10-E3 · 2026-10-19 · Jev on the outcome measure: four-way head-to-head (pre-registration)
- **Question:** does Jev (list variant, p ≥ 0.7, from C10-E2's post-hoc look) carry the dated checker's gain over
  today's plugin into the agent's replies, and how does it compare with the haiku checker on the same turns?
- **Setup:** `downstream.py prep-h2h-jev --world <w> --sub <w>-h2h-jev --turns <w>-h2h,<w>-h2h2 --jtag jev-list
  --p 0.7` (since C10-R the head-to-head outputs are under `--jtag jev-list-h2h`, the new default): the same 145 code and 169 life turns as C5-E7 / C6-E1, with four conditions in one new responder run:
  none, eden (dated), verify (haiku, dated, the same packets as before) and jev (dated, deferred like verify). Jev's
  outputs come from `verify_jev.py --variant list` on these turns' shortlists. Protocol as C5-E1 (per-turn split,
  sonnet responder, blind opus judge with history evidence). Report: `h2h.py --four <w> <w>-h2h-jev`.
- **Rule, set before running:**
  - **Jev beats today's plugin** if jev − eden per-turn utility is > 0 on both worlds with CI lower bound > 0 on at
    least one, and > +0.05 on both.
  - **Jev matches the haiku checker** if jev − verify ≥ −0.03 on both worlds (point estimates; one run).
  - Otherwise report both differences as measured. One run; the C6/C7 two-run standard is not met by this alone.

## C10-E3 · 2026-10-19 · Jev on the outcome measure: result
- **Run:** 145 code and 169 life turns, four conditions each, one new responder run (sonnet, per-turn split) and blind
  opus judges with history evidence; all judged. Jev's packet fired on 56 code and 59 life turns.
- **Judging incident:** several code judges shared a scratchpad and overwrote each other's helper scripts; one
  reported scoring some cases on shortened text. All code judgments from judges that reported a collision (files 0–5)
  were set aside (`out/collided-judged-*.json`, kept for comparison) and re-judged by judges told to use private
  temp directories. The set-aside and re-judged score lists are identical on 9, 8, 12 and 10 of 15 cases in files
  0, 1, 4, 5 (no baseline for two independent judges was measured). Some judges read the long, near-identical
  `reference_facts`
  list as a diff between cases rather than verbatim (they said so); every other field was read in full.
- **Per group (condition − none):**

  | World | Group | n | Eden | Verify (haiku) | Jev |
  |---|---|---|---|---|---|
  | code | plan-need | 25 | −0.04 | +0.48 | +0.56 |
  | code | labeler-only | 30 | −0.1 | 0.0 | 0.0 |
  | code | no-need | 90 | −0.033 | 0.0 | −0.033 |
  | life | plan-need | 49 | −0.041 | +0.367 | +0.388 |
  | life | labeler-only | 30 | +0.033 | +0.067 | +0.2 |
  | life | no-need | 90 | +0.078 | +0.156 | +0.067 |

- **Per-turn utility:** code eden −0.0457, verify +0.0677, jev +0.056; life eden +0.052, verify +0.1655,
  jev +0.1393.
  - **jev − eden:** code +0.1017 [−0.0009, +0.2]; life +0.0873 [−0.0073, +0.1872].
  - **jev − verify:** code −0.0117 [−0.1125, +0.0877]; life −0.0262 [−0.1096, +0.0604].
- **Verdict, by the rule:**
  - **Jev matches the haiku checker** (jev − verify ≥ −0.03 on both worlds: −0.0117, −0.0262).
  - **"Jev beats today's plugin" is not met as written:** both differences are above +0.05, but neither CI lower bound
    is above 0 (−0.0009, −0.0073). One run; the C6/C7 standard (two runs) is not met by this alone.
- **In this same run, haiku verify − eden** is code +0.1134 and life +0.1135, close to its C6/C7 values, so this run
  is not an unusually weak one for the checker.
- **What this says:** Jev, posed well, gives the agent's replies about the same lift as the haiku checker, at about a
  tenth of the time budget. A second independent run (as C6-E2, C7-E3) is the way to firm "beats today's plugin".

## C10-E4 · 2026-10-19 · Jev four-way, second independent run (pre-registration)
- **Setup:** as C6-E2 / C7-E3: the same turns and packets as C10-E3 (`downstream/<w>-h2h-jev-r2`, copies of its
  inputs and keys), a new sonnet responder run and new blind opus judges (private temp directories). Each turn's
  condition − none is averaged over the two runs.
- **Rule, set before running (the averaged result decides):**
  - **Jev beats today's plugin (two runs)** if jev − eden has a CI lower bound > 0 on both worlds.
  - **Jev matches the haiku checker (two runs)** if jev − verify ≥ −0.03 on both worlds.
  - Run 2 alone is reported too.

## C10-E4 · 2026-10-19 · Jev four-way, second independent run: result
- **Run 2** (new sonnet responders, new blind opus judges in private temp directories; no judge reported a
  collision; several read the long repeated `reference_facts` list as a case-to-case diff, as in C10-E3). All judged.
  - **Code run 2 alone:** utility eden −0.0477, verify +0.0798, jev +0.0945; jev − eden +0.1422 [+0.051, +0.2355];
    jev − verify +0.0147 [−0.0749, +0.1092].
  - **Life run 2 alone:** eden +0.0298, verify +0.0183, jev +0.0689; jev − eden +0.0391 [−0.058, +0.1394]; jev −
    verify +0.0506 [−0.0287, +0.1324].
- **Decision measure (each turn averaged over both runs):**

  | World | Group | n | Eden | Verify (haiku) | Jev |
  |---|---|---|---|---|---|
  | code | plan-need | 25 | −0.02 | +0.32 | +0.52 |
  | code | labeler-only | 30 | −0.1 | +0.033 | −0.033 |
  | code | no-need | 90 | −0.039 | +0.033 | +0.011 |
  | life | plan-need | 49 | +0.01 | +0.408 | +0.367 |
  | life | labeler-only | 30 | +0.1 | +0.05 | +0.2 |
  | life | no-need | 90 | +0.028 | +0.039 | +0.017 |

  - **Code:** utility eden −0.0467, verify +0.0738, jev +0.0753; **jev − eden +0.122 [+0.0392, +0.2039]**;
    jev − verify +0.0015 [−0.0777, +0.0834].
  - **Life:** eden +0.0409, verify +0.0919, jev +0.1041; **jev − eden +0.0632 [−0.0186, +0.1499]**; jev − verify
    +0.0122 [−0.0532, +0.0799].
- **Verdict, by the rule:**
  - **Jev matches the haiku checker (two runs):** jev − verify +0.0015 (code), +0.0122 (life), both ≥ −0.03.
  - **Jev beats today's plugin (two runs): on code yes** (CI lower bound +0.0392); **on life no** (CI includes 0;
    point estimate +0.0632).
- **Context:** in these four-way runs the haiku checker's own lead over eden on life is +0.051 (two-run average),
  smaller than in the three-way C6/C7 runs (+0.1342). Eden scores higher on life here (+0.0409 against +0.0091 in
  C7-E3), on different responder and judge runs. Jev tracks the haiku checker closely in both worlds; what moved is
  the life baseline (and haiku's own life utility, +0.1433 in C7-E3 → +0.0919), not Jev relative to haiku.
- **What this says:** Jev matches the haiku checker on replies on point estimates (two runs, both worlds; the CIs of
  the difference span about ±0.08), about ten times
  inside the latency budget, and on D37's amended provider list. The claim "the checker beats today's plugin on
  life" now rests on the C6/C7 three-way runs, and these four-way runs do not reproduce it firmly.

## C11-E1 · 2026-10-19 · Getting the needed memory into a bounded candidate set (pre-registration; exploratory)
- **Why (the user's direction):** recall to 95–100% at massive scale. The funnel (dev, human need turns; needed items
  that survive each stage) is: in store code 84% / life 67%; in the 15-row shortlist 61% / 40%; kept by the checker
  55% / 36%; delivered 52% / 27%. The shortlist is the largest leak, and at scale it can only grow: the hook must
  pick a bounded set from a store 100–10,000× larger, so checking every row (or putting the store in context) is
  out. The answer has to be better indexes, built while dreaming, and searched in bounded time at the hook.
- **Measure:** for each needed item on dev need turns, the best rank of a visible row covering it under each
  candidate generator; recall@k for k = 5, 15, 50; and the share of needed items at rank ≤ 3 (a scale proxy: a
  rank that is already deep in a 400-row store will not survive a store 100× larger).
- **Generators** (all model-free at the hook; every index is built offline from the rows' dream-written fields):
  G0 current (lexical with cues + self-play bank, the verifier's shortlist); G1 + session context (the previous
  human turns and reply in the query); G2 + entity graph (rows sharing a rare entity with the top rows); G3 + time
  index (rows whose `when.times` matches the turn's date or a date the turn names); G4 all fused (reciprocal rank).
- **No verdict rule:** this chooses what to build and test next; every number is reported.

## C11-E1 · 2026-10-19 · Candidate generation at scale: result (exploratory)
- **Fused model-free generators barely help** (`recall_funnel.py`; needed items on dev need turns, recall@k of the
  needed item under each generator; code 69 items, 84% in store; life 103, 67% in store):

  | Generator | code @3 / @15 / @50 | life @3 / @15 / @50 |
  |---|---|---|
  | G0 lexical + bank (today's shortlist) | 0.275 / 0.536 / 0.739 | 0.214 / 0.32 / 0.515 |
  | G1 + session context | 0.261 / 0.478 / 0.725 | 0.194 / 0.33 / 0.505 |
  | G2 + entity index and graph | 0.217 / 0.565 / 0.754 | 0.097 / 0.369 / 0.544 |
  | G3 + time index (next 14 days or the turn's weekday; see note) | 0.275 / 0.536 / 0.739 | 0.155 / 0.311 / 0.495 |
  | G4 all fused (RRF) | 0.232 / 0.565 / 0.725 | 0.146 / 0.369 / 0.534 |

  G3 matches rows whose times name a date in the next 14 days or the turn's weekday; it does not parse dates the
  turn names, so it is narrower than the prereg. Only about a quarter of needed items rank in the top 3 under any single ranking: a ranked list over a growing store
  will not find them.
- **What the misses are** (life, 31 needed items with a covering row outside G4's top 15; 8 read): constraints and
  conflicts set by the action, not by the turn's words. Scheduling a meeting needs the standing calendar rules;
  "Sunday at 9" needs the Sunday 9 pm call; "while we're away in July" needs the trip dates; a weekend trip needs
  the family travel preferences; a vet form needs Biscuit's birth date (an entity the turn names, outranked by other
  Biscuit rows).
- **Channels as sets, not one ranking** (needed items that have a covering row; pool = union size per turn):

  | | code (58) | life (69) |
  |---|---|---|
  | G0 top 15 | 0.64 | 0.48 |
  | entity channel (rows holding an entity named in the turn or its session) | 0.59 | 0.62 |
  | time channel (rows whose times share a weekday or month the turn names) | 0.0 | 0.19 |
  | union | **0.81** | **0.75** |
  | union pool size, median / p90 | 32 / 66 | 69 / 151 |

- **What this says:** the needed memory is usually reachable through a typed channel (an entity, a time, an action)
  even when no ranking puts it on top; a fast checker can then judge a bounded union (Jev answers all questions of a
  request in parallel). The remaining fifth to quarter are action constraints (scheduling, travel, tool setup), a
  channel the dreaming step would have to build. Pools grow with the store (an entity like "Leo" gains rows for
  years), so at scale each channel needs its own bound: entity facets, time windows, action registries.

## C11-E2 · 2026-10-19 · An action-constraint registry built while dreaming (pre-registration; exploratory)
- **Idea:** the dreaming step tags each memory with the kinds of action it constrains or informs, from a fixed
  taxonomy (`benchmarks/memory-stream/dream/actions.json`, 28 types across both worlds). At the hook, a fast
  classifier names the action types the turn involves (Jev, one yes/no question per type, run by the session that
  holds the key); the action channel is every visible row tagged with one of them. Bounded at scale by the
  taxonomy, not by the store.
- **Dream tagging:** sonnet subagents (the sleep compiler's role) tag every row of both stores with up to 3 types or
  none, from the row text and kind alone (`dream/<world>/out/tags-*.json`).
- **Measure:** the action channel's coverage of needed items, its union with C11-E1's channels, and pool sizes.
  No verdict rule; it decides whether the registry goes into the build plan.

## C11-E3 · 2026-10-19 · What the dreaming step leaves out (diagnostic)
- **Needed items absent even from the session-end store** (dev need turns), by the world's item kind:
  - code: fact 4 of 44, preference 1 of 3; procedures, episodes and constraints all stored.
  - life: **episode 11 of 15**, **tool result 6 of 8**, commitment 2 of 3, fact 2 of 18, routine 2 of 11,
    relationship 1 of 1; preferences, instructions, plans, people and decisions all stored.
- **Every life item, share ever stored by the compiler:** episode 7 of 36, tool result 10 of 30; person 35/35,
  preference 28/28, plan 42/46, fact 44/48, routine 28/30, instruction 26/27, commitment 16/17, decision 15/17.
- **Examples missed:** "2026-01-17: Riya asked for photos of zellige tile backsplashes; she did not pick one";
  "Order confirmation: one 8-inch vanilla cake, pickup 2025-11-08"; "Directions to Glebe, Ottawa, 452 km";
  "Riya promised her mother a video call every Sunday at 9 pm".
- **What this says:** the compiler does semantic memory well and drops episodic memory, as its spec told it to
  ("not one-off requests; not tool output"). Later turns ask "where did we leave the backsplash", "when is the cake
  pickup". A dreaming system needs an episodic layer next to the semantic one: compact, dated records of what
  happened and what tools returned, indexed by time and entity, rolled up over time so it stays bounded at scale.

## C10-R · 2026-10-19 · Review of the cycle 10 consolidation (REQUEST_CHANGES) and fixes
- **Jev output provenance:** the head-to-head Jev outputs had been written under the same tag as C10-E2's dev run
  (`verify/<w>-jev-list`), and `verify.picks` keeps whichever file it reads last. They now have their own tag
  (`verify/<w>-jev-list-h2h`, call logs split: code 181 dev + 132 head-to-head calls, life 228 + 158). With the
  split, the C10-E2 dev table reproduces exactly from the documented command. The committed
  `downstream/<w>-h2h-jev/in/responses-in.json` stays the measured input: in it, the Jev packet of **6 code and 4
  life turns came from the dev-run call** on identical candidates, not from the call on the head-to-head shortlist
  (139 and 165 match the head-to-head call). The head-to-head shortlist inputs (`verify/<w>-h2hjev*/in`) exist only
  in the child session; `verify.py prep --per 1 --contrast 8 --events downstream/<w>-h2h(2)/key.json` rebuilds them.
- **New finding, Jev's repeat-call variance:** on the events both runs scored with identical candidates, the
  p ≥ 0.7 packet differs between the two calls for 7 of 64 code and 9 of 83 life events (about 10%). A production
  checker should not assume one call is deterministic.
- **Code behind C11-E1's channel table and C11-E3:** `recall_funnel.py --channels` and `--missing` (committed); both
  reproduce the recorded numbers exactly. C11-E3's "absent" means: no visible row covers the item in the
  session-end store (`sleep.rows(strict=False)`, rows visible after their own session).
- **Collision sensitivity** (C10-E3 code judgments): the collided `judged-2.json`, deleted in c2f7169f, is restored
  as `collided-judged-2.json`. Using the collided judgments instead of the re-judges (reviewer's probe): C10-E3 code
  jev − eden +0.0792 [−0.0216, +0.1836] (re-judged +0.1017), jev − verify −0.0288 (−0.0117); C10-E4 code jev − eden
  +0.1107 [+0.0299, +0.19] (+0.122), jev − verify −0.0071 (+0.0015). No verdict changes; C10-E3's "matches" margin
  would shrink to 0.0012.
- **Jev and D37's named rule:** D37 (as amended) says the shipped checker is chosen by "p50 latency ≤ 3 s and the
  C9-E1 quality rule". Jev meets the latency bar but **not** that retrieval rule: base Jev passed 1 of 4 (C10-E1), the
  pre-registered C10-E2 pick failed, and list 0.7 was chosen after the results and still misses code-rt1 recall
  (−0.0517). The case for Jev rests on the outcome measure (C10-E3/E4: matches haiku on replies over two runs).
  Whether D37 should name the outcome measure as its criterion is the user's decision; the docs now say this.
- **Wording:** C10-E4's context line now notes haiku's own life utility also fell (+0.1433 in C7-E3 → +0.0919);
  "drop-in" is softened to "matches on point estimates (CIs about ±0.08)"; STATE no longer says life-rt1 was
  "within 0.03" (it was +0.047 ahead); the sketch no longer frames an unmet rule as "CIs just touching 0"; the
  headline says list 0.7 was chosen after the results.
- **Harness:** `h2h.py --four … --runs r2` gives the C10-E4 two-run numbers (reproduce exactly); `recall_funnel.py`
  line length and dead code fixed; G3's label states what it parses.
- **Evidence outside artifacts:** the NIM smokes' 404s and the GLM connection failure are recorded only by the child
  session's report (their `calls.jsonl` files are empty). The `dream/in` builder was an inline script (it writes
  each store's rows as id, kind, text in files of 100). C11-E1's pre-registration and result were committed minutes
  apart; it is exploratory with no verdict rule.
- **Local CI (6400cf08, outside the repo):** format, typecheck, build pass; test:parallel 5319 pass, 32 skip, 3 fail
  (`switches`, `memory-purge`: root-on-Linux, also fail on main; `doctor` hung-wrap: under load, passes alone).
  Since then only .py, .json and .md changed.

## C11-E2 · 2026-10-19 · Action-constraint registry: result (exploratory)
- **Turn classification** (Jev, one yes/no per action type, child session; `dream/<w>/turn-actions.json`): 165 code
  and 187 life turns; latency p50 0.236 / 0.234 s, p95 0.335 / 0.306 s.
- **Coverage of needed items that have a covering row** (`recall_funnel.py --actions --thr 0.5`):

  | | code (58) | life (69) |
  |---|---|---|
  | action channel (rows tagged with a type Jev says the turn involves) | **0.97** | **0.88** |
  | union with G0@15, entity, time | **1.0** | **0.97** |
  | union pool, median / p90 | 108 / 190 | 152 / 327 |
  | capped union (G0 15, entity 20, time 10, action 20; lexical order inside) | 0.83 | 0.71 |
  | capped pool, median / max | 36 / 46 | 36 / 54 |

  At threshold 0.3: action 0.98 / 0.91, union 1.0 / 0.97, capped 0.81 / 0.70.
- **Ordering inside the caps (post hoc, same data):** ranking by how many other channels a row appears in, then by
  durable kind, then lexical, does not help (code 0.79, life 0.68); action ∩ other channels plus 20: 0.84 / 0.71;
  action cap 40: 0.86 / 0.75 (pool median 47 / 45).
- **What this says:** the typed channels together reach almost every needed item that exists in the store, but
  the action channel is a quarter of the store and grows with it, and no cheap order inside it keeps the needed
  rows in a fixed-size cap. Bounding it needs either understanding at read time (a checker over the whole channel)
  or compression at write time: the dreaming step keeps a fixed-size card per action type.

## C11-E4 · 2026-10-19 · Dream-maintained action cards (pre-registration; exploratory)
- **Idea:** dreaming keeps, for each action type, a card of at most 20 lines: the standing rules, preferences,
  routines, commitments and upcoming plans that would change how the assistant does that action. Each line cites
  the row ids it comes from. Cards are updated incrementally, batch by batch: after each sleep batch the dreamer
  sees the previous cards plus the batch's new rows (and their action tags) and rewrites the cards. A card's size
  does not grow with the store.
- **Leak-free use:** a turn sees the cards as they stood after the last batch visible to it (`--strict` timing).
- **Measure:** the needed item is covered if a line of a card for one of the turn's action types (Jev p ≥ 0.5)
  cites a row covering it; reported alone and in a bounded union with G0@15, entity (cap 20) and time (cap 10);
  pool = rows plus card lines. Compared with C11-E2's capped union (0.83 / 0.71 at a pool of 36).
- **No verdict rule:** it decides whether action cards are the bounded channel the build plan relies on.

## C11-E5 · 2026-10-19 · An episodic layer in dreaming (pre-registration; exploratory)
- **Idea (from C11-E3):** next to semantic rows, dreaming writes compact dated episode records per session: what the
  user asked or decided, what was done, and what tools returned (orders, bookings, directions, lookups), each with
  its date and entities. Rolled up over time at scale; here only the per-session layer is tested.
- **Setup:** life only (code drops few episodes). Sonnet subagents read the same label-free batch inputs as the
  sleep compiler (`sleep/life/in/*.json`) and write `dream/life/episodes/<batch>.json`. Visibility as `--strict`
  (after the batch's last session).
- **Measure:** for dev need turns, needed items covered by a visible episode record (via the same coverage check as
  rows), by item kind; the store ceiling with episodes added; and whether entity / lexical lookup over episode
  records finds them (rank of the covering record under lexical score; entity match).
- **No verdict rule.**
- **Result (2026-10-19, `python3 benchmarks/memory-stream/recall_funnel.py --worlds life --episodes`):** 485
  episode records over the 160 life sessions (16 batches; each output's session ids match its input exactly; after
  writing, the b00–b03 agent edited one record of b02 to name the child correctly, before scoring).
  - Needed items on dev need turns (103): in visible rows 69, in visible episodes 70, in either 83. Store ceiling
    0.67 → 0.806.
  - By kind (total / rows / episodes / either): episode 15 / 4 / 10 / 11; tool 8 / 1 / 7 / 7; fact 18 / 15 / 14 /
    15; preference 16 / 13 / 9 / 13; routine 11 / 8 / 7 / 8; plan 7 / 5 / 3 / 5; others unchanged.
  - Items only episodes cover: 14. A lookup finds 11 of them (lexical top 10: 4; entity match: 8).
- **What this says:** episodes and tool results are what the semantic rows drop, and a per-session episode layer
  recovers most of them (episode 4 → 11 of 15, tool 1 → 7 of 8). It does not replace rows (it misses preferences
  and routines rows hold). Entity lookup reaches most episode-only items, so episodes belong in the entity and time
  channels. Synthetic, one world, one dreamer run, no outcome test.

## C11-E6 · 2026-10-19 · How each channel grows with the store (pre-registration; exploratory)
- **Question:** the build plan must hold at millions of memories, and the worlds hold hundreds. The stores do grow
  over each stream, so the growth rate of each channel can be measured and projected.
- **Setup:** dev need turns of the judge sample (as C11-E1/E2). For each turn: N = rows visible (`--strict`); the
  set size of the entity, time and action (Jev p ≥ 0.5) channels as C11-E2 builds them; whether G0's top 15 holds
  a covering row for each needed item that has one.
- **Measure:** per world and channel, the least-squares slope b of log(set size) on log(N) over turns with N ≥ 20
  and a non-empty set, and the share of turns with an empty set; G0@15 recall for turns below and above the median
  N. The plan projects set sizes to N = 10^4, 10^5 and 10^6 from b (an extrapolation over 2–4 orders of magnitude,
  stated as such).
- **No verdict rule.**
- **Result (2026-10-19, `python3 benchmarks/memory-stream/recall_funnel.py --growth`):** turns with N ≥ 20: code
  54, life 76.

  | World | Channel | Slope b | Empty sets | Median share of N | Projected at 10^4 / 10^5 / 10^6 |
  |---|---|---|---|---|---|
  | code | entity | 0.624 | 0/54 | 0.124 | 233 / 980 / 4123 |
  | code | time | — | 54/54 | — | (no code turn names a weekday or month a row holds) |
  | code | action | 1.168 | 0/54 | 0.419 | 7558 / 111410 / 1642154 |
  | life | entity | 1.176 | 1/76 | 0.195 | 2737 / 41044 / 615407 |
  | life | time | 0.562 | 23/76 | 0.020 | 88 / 320 / 1166 |
  | life | action | 1.184 | 3/76 | 0.480 | 8328 / 127122 / 1940454 |

  G0@15 recall by store size: code N < 279: 18/27 = 0.667, N ≥ 279: 19/31 = 0.613; life N < 331: 15/33 = 0.455,
  N ≥ 331: 18/36 = 0.500.
- **What this says:** the action channel grows in proportion to the store (b ≈ 1.17 in both worlds), so as a set
  it is unusable at scale; it must be replaced by something fixed-size (cards). The entity channel is sublinear in
  code but linear in life, where a few hub entities (the user's partner, children, home) sit on a fifth of all rows:
  hub entities need their own fixed-size cards, and the entity channel should use only rarer entities. The time
  channel stays small. Over this range (tens to hundreds of rows) G0's top-15 recall does not fall with N; whether
  it holds at 10^5 rows is untested. The projections extrapolate 2–4 orders of magnitude past the data.

## C11-E7 · 2026-10-19 · Entity channel without hub entities (pre-registration; exploratory)
- **Idea (from C11-E6):** hub entities (on many rows) make the entity channel grow with the store. Restrict the
  channel to entities on at most H rows of the visible store, H = max(5, 0.02 · N); hub entities are left to
  dream-kept entity cards (not tested here).
- **Measure:** as C11-E6 for the restricted channel (slope, median share of N), and its recall of needed items
  with a covering row next to the full entity channel's.
- **No verdict rule.**
- **Result (2026-10-19, `python3 benchmarks/memory-stream/recall_funnel.py --rare`):**
  - code: full entity channel 34/58 = 0.586, rare-entity channel 26/58 = 0.448; rare channel slope b 0.286, empty
    0/54, median share of N 0.080, median / max size 17 / 34.
  - life: full 43/69 = 0.623, rare 25/69 = 0.362; slope b 0.480, empty 1/76, median share 0.054, size 15 / 55.
- **What this says:** dropping hub entities bounds the channel (slope 0.29–0.48, about 15–17 rows) but loses a
  quarter (code) to almost half (life) of what it found: the hub entities carry real needs. So hubs need a bounded
  form of their own, a dream-kept card per hub entity, rather than being dropped.

## C11-E8 · 2026-10-19 · Jev over a wide candidate pool (pre-registration; exploratory)
- **Question:** the bounded read path needs the checker to pick from far more than 15 candidates. Does Jev keep its
  accuracy and speed over a pool of about 100–150?
- **Setup:** dev judge-sample human turns: every need turn, plus the same number of no-need turns (seeded sample,
  seed 1). Pool = C11-E2's uncapped union (G0@15 ∪ entity ∪ time ∪ action at p ≥ 0.5), ordered G0 first, then by
  how many channels hold the row, then lexical score, and cut at 150. One Jev request per turn, the `list` variant of
  C10-E2 (RICH_Q / RICH_C, candidates in the state). Picks: p ≥ 0.7, top 4 by p.
- **Measure:** latency p50 / p90 and its relation to pool size; recall of needed items that have a covering row in
  the pool (all, and those also in G0@15); turns with any pick, need vs no-need; picks per turn.
- **No verdict rule.** Compared descriptively with C10's 15-candidate Jev runs.
