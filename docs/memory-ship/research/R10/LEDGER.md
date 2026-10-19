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
