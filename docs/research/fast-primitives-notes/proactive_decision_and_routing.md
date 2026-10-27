# Proactive decision (inject vs silent) and source routing: fast primitives

Scope: how a proactive context system decides, on each agent event, whether to speak, and which of ~5–30 connected
read-only sources to query, cheaply (microseconds to milliseconds in TypeScript) with an LLM only as an escalation path.

Verification legend. Items marked **[fetched]** were read in full or in part during this session (Meta paper HTML;
Rhodes & Maes IBM Systems Journal PDF; arXiv abstracts for RAG-MCP and Conformal Cascade; the MSR page for Shokouhi &
Guo; the Remembrance Agent paper). Items marked **[canonical, not re-fetched]** are standard references cited by their
canonical URL from prior knowledge; the claim attached to them is the well-known headline result, and the report
writer should label any number from them as "not re-verified in this session" (Eden CLAUDE.md "Honest numbers").

## Q1. Meta, "Remember When It Matters: Proactive Memory Agent for Long-Horizon Agents" (Wu et al., arXiv:2607.08716)

### Takeaway
A separate LLM "memory agent" runs beside an unchanged action agent. Each time it is called, it first edits a
three-part memory bank through tool calls, then either emits one short reminder grounded in memory or emits an
explicit `<no_intervention/>`. Choosing when to stay silent beats exposing the whole bank (by 2.8 macro pp) and beats
Mem0-style top-10 retrieval. "Always inject" scores about the same on the micro average, so silence mostly buys
balance across domains and lower cost rather than a large accuracy gain. The paper reports no cost or latency figures.
Its design runs a frontier model on every step, which is the opposite of Eden's "model last" rule. What Eden can reuse
is the structure (bank schema, a silence action, criteria for intervening, event-based triggers), not the runtime.

### Cited Findings
- Meta AI; 8 authors (Yifan Wu, Lizhu Zhang, Yuhang Zhou, Mingyi Wang, Bo Peng, Serena Li, Xiangjun Fan, Zhuokai
  Zhao). arXiv v1 submitted 9 July 2026, licensed CC BY 4.0. Code is at github.com/yifannnwu/proactive-memory-agent;
  this session could not reach it because GitHub access was not enabled, so the exact prompt text was not read.
  — [arXiv abs](https://arxiv.org/abs/2607.08716) [fetched]; [HTML](https://arxiv.org/html/2607.08716v1) [fetched]
- The paper names the failure mode **behavioral state decay**. Information that should shape later actions (task
  requirements, environment facts, previous attempts, failure diagnoses, intermediate discoveries, open subgoals)
  stops influencing the next decision. This happens even when the information is still in the context window; the
  paper cites "Lost in the middle". — [HTML §1](https://arxiv.org/html/2607.08716v1)
- **Formalism.** At memory step t, the memory agent sees the task x, a recent window w_t = W_k(τ<t, o_t) and the
  previous bank B_{t−1}. It produces B_t ~ π_M^edit(·|x, w_t, B_{t−1}) and then i_t ~ π_M^intervene(·|x, w_t, B_t),
  where i_t ∈ {∅, text reminder}. A non-null i_t is injected into the next action-agent call as transient context;
  it is never written into the persistent history. — [HTML §3.1, §3.3](https://arxiv.org/html/2607.08716v1)
- **Memory bank schema** B_t = (s_t, K_t, P_t):
  - s_t is a private status field (progress, open issues, unresolved risks). It is never shown to the action agent.
  - K_t holds knowledge memories: relatively stable facts such as requirements, environment properties, paths,
    configuration, and facts verified by the user or a tool.
  - P_t holds procedural memories: failed commands, fixes that worked, hypotheses ruled out, diagnostic signals and
    performance observations.
  - Each entry has a short identifier, natural-language content, and metadata (creation time, access statistics).
    In practice entries use a compact tagged format such as env facts, paths, task facts, bugs and perf.
  — [HTML §3.2](https://arxiv.org/html/2607.08716v1)
- **Phase 1 (bank edits)** uses only four tools, each called zero or more times and executed in order:
  `memory_update_status`, `memory_save_knowledge`, `memory_save_procedural` and `memory_delete` (by id). The output is
  a sequence of edits, not a free-form summary. **Phase 2** reads the updated bank and recent trajectory and emits
  either `<context_for_action>` or `<no_intervention/>`. It does not modify the bank. —
  [HTML §3.3, Fig. 2](https://arxiv.org/html/2607.08716v1)
- **Criteria for intervening** (paraphrased from the paper; the verbatim prompt was not read). "Intervene only when a
  remembered item is likely to affect the next action-agent decision". The paper lists useful cases: a requirement
  about to be violated, an environment fact that explains the current observation, a previous attempt that should not
  be repeated, a diagnosis that is still relevant, an open subgoal being neglected. It discourages broad strategic
  advice, restating what is already visible in the current observation, and taking over the action agent's planning.
  Silence is an explicit action. — [HTML §3.3](https://arxiv.org/html/2607.08716v1)
- **How often it runs.** In the general formulation the memory agent runs at the first step and then every k steps,
  under a trigger function g(t). The experiments use every step (k = 1) with a window of k = 8 recent messages. The
  paper names cheaper, more selective triggers it did not test: "only after tool errors, failed tests, repeated
  commands, or large context shifts". Its future work includes "learning when memory is invoked rather than running
  on a fixed schedule". — [HTML §3.4, §4.1, §5](https://arxiv.org/html/2607.08716v1)
- **Main results** (pass@1; memory agent = Claude Opus 4.6):
  - Terminal-Bench 2.0, 85 paired tasks: Sonnet 4.5 37.6% → 45.9% (+8.3 pp); Opus 4.6 43.5% → 45.9% (+2.4 pp).
  - τ²-Bench, 278 tasks, task-weighted: Sonnet 4.5 55.0% → 61.8% (+6.8 pp); Opus 4.6 66.2% → 68.7% (+2.5 pp).
  - Sonnet 4.5 per domain: airline +10.0, retail +9.6, telecom +2.6. Opus 4.6 per domain: airline +0.0, retail +4.4,
    telecom +1.8.
  - Gains are smaller for the stronger action agent.
  — [HTML Table 1](https://arxiv.org/html/2607.08716v1)
- **Ablations** (τ²-Bench, action agent Sonnet 4.5; Airline / Retail / Telecom / Macro / Micro):

  | Variant | Airline | Retail | Telecom | Macro | Micro |
  |---|---|---|---|---|---|
  | Baseline | 68.0 | 49.1 | 55.3 | 57.5 | 55.0 |
  | Full system (bank + selective reminder or silence) | 78.0 | 57.0 | 57.9 | **64.3** | 61.2 |
  | Full-bank context (passive exposure) | 74.0 | 52.6 | 57.9 | 61.5 | 58.6 |
  | Always inject (reminder forced every step) | 72.0 | 58.8 | 59.6 | 63.5 | **61.5** |
  | Injection-only, no bank (advisor-style) | 62.0 | 54.4 | 66.7 | 61.0 | 60.8 |
  | Mem0 (ADD; vector+BM25 top-10) | 68.0 | 59.6 | 58.8 | 62.1 | 60.8 |

  The authors say the 0.3-point micro lead of always-inject is "within expected run variance". Note that the
  full-system retail figure is 57.0 here but 58.8 in Table 1, so these are separate runs. That is itself evidence of
  run-to-run variance of about 2 pp. — [HTML Table 2, §4.3](https://arxiv.org/html/2607.08716v1)
- **Failure modes.** The remaining failures are "primarily calibration errors rather than failures of memory
  storage". The memory agent sometimes presents a speculative inference with too much confidence, repeats what the
  action agent already knows, or raises a plausible but unnecessary concern that causes extra verification. Helpful
  interventions often come "immediately before a state-changing tool call" (authentication requirements, eligibility
  conditions, one-shot tool limits, policy clauses). — [HTML §4.4, Table 3](https://arxiv.org/html/2607.08716v1)
- **Training.** Qwen3.5-27B is trained as the memory agent with a frozen Qwen3.5-122B-A10B action agent, on SETA
  terminal tasks with verifier rewards. SFT distills trajectories from the prompted memory agent (both phases). GRPO
  then tunes intervention calibration. Because rewards are sparse over many memory calls, "updates focus on pivot
  turns that labeled offline rollouts identify as likely to affect downstream success".
  - SETA validation reward: no memory 0.709; untrained 27B memory 0.693 (it hurts); SFT 0.720; GRPO 0.734.
  - Held-out Terminal-Bench: 37.6% → 41.1% (+3.5 pp).
  — [HTML §4.5, Tables 5–6](https://arxiv.org/html/2607.08716v1)
- **Cost and latency.** The paper reports no token, dollar or latency figures. It says only that a prompted memory
  agent "adds a frontier-model call at each memory step and its intervention calibration is imperfect". —
  [HTML §3.5, §4.5](https://arxiv.org/html/2607.08716v1)

### Inferences
- **Directly reusable for Eden:**
  1. Split state into private status, knowledge (stable facts) and procedural (attempts and outcomes), with
     identifiers so stale entries can be deleted.
  2. Make silence an explicit, logged decision, so that silence rate and fire rate can be measured.
  3. Use the five intervention criteria, plus the three "don't" rules, as the rubric for an LLM judge and as labels
     for the cheap classifier.
  4. Inject transiently: put context into the next call only, never into persistent history.
  5. Use event-based triggers instead of a call per step. Strong cheap cues include tool errors, repeated commands,
     an imminent state-changing tool call, and a large context shift.
- The "imminent state-changing tool call" cue costs nothing to detect from tool metadata. For Eden this is a
  high-prior moment to check for a constraint that is about to be violated.
- Always-inject roughly ties on micro accuracy. So in Eden's setting, the reasons for silence are the
  false-fire/annoyance cost and token cost that the benchmark does not price, plus robustness across domains (the
  airline case: 78 vs 72). Eden should price a false fire explicitly in its utility rather than expect silence to
  raise task success by itself.
- An untrained small model hurt performance (0.709 → 0.693). An uncalibrated cheap judge can be worse than none,
  which supports keeping Eden's default at silence until calibration data exists.
- GRPO focused on "pivot turns" is the same idea as off-policy labelling of only the high-uncertainty band (see Q4):
  spend labels where the decision is close.

### Gaps
- The verbatim Phase 1 and Phase 2 prompts and the reminder length limits were not read. The code repository could
  not be accessed from this session.
- The intervention rate (how often the agent stayed silent) is not reported in the parts read.
- There are no cost or latency numbers, and no confidence intervals beyond the "run variance" remark.
- The GRPO reward shaping, group size and number of pivot turns are not given in the HTML text read.

## Q2. Just-in-time IR lineage (Remembrance Agent, Margin Notes, Jimminy, Watson, proactive cards, surveys)

### Takeaway
Since 2000 the rule has been: favour precision over recall, show only a few suggestions in a low-salience interface
that can be ignored, gate them with a relevance threshold, and measure usefulness by what users go on to view or use,
not by relevance alone. Even the best query-free retrieval reached only about 50% "relevant" rates. Proactive
systems help mainly because they make retrieval cheaper, so they surface information users would not have searched
for at all.

### Cited Findings
- **Remembrance Agent (RA), 1996.**
  - It continuously uses the text being typed or read as a query against a SMART term-overlap index, rebuilt nightly.
  - Display lines use different context windows: the last 500, 50 and 10 words.
  - Suggestions refresh about every 10 seconds. There are up to 9 lines, with 3–4 by default.
  - Each suggestion shows a relevance number. The authors "always suggest many false positives" and chose
    low-salience one-line display over interrupting.
  — [Rhodes & Starner 1996](https://www.bradleyrhodes.com/Papers/remembrance.html) [fetched]
- **Later RA and Margin Notes used a minimum threshold.** "If a suggestion is below a minimum threshold, it is not
  displayed, and 'No suggestion' is shown instead". Relevance is shown as 0, 1 or 2 plus signs. Right-clicking shows
  the keywords that triggered the suggestion, which is an explainability affordance. Margin Notes annotates each
  section of a page only when its score is above a threshold. —
  [Rhodes & Maes 2000, IBM Systems Journal 39(3&4)](https://www.bradleyrhodes.com/Papers/rhodes-jitir-agents-ibmsj-2000.pdf)
  [fetched]
- **Design principles from the same paper:**
  - "Information retrieval algorithms for JITIR agents should tend to favor precision over recall". Because the agent
    plays a supporting role, it "usually should not suggest more than a few documents".
  - Reading the suggestion must be a secondary task, through an "ignorable" interface.
  - Disclosure is staged: each step costs attention in proportion to what it offers.
  - "Relevance may correlate with usefulness, [but] the two are not the same": a relevant document may already be
    known to the user.
  - Response delays above about 2 s reduce tool use (citing Miller).
  — [Rhodes & Maes 2000](https://www.bradleyrhodes.com/Papers/rhodes-jitir-agents-ibmsj-2000.pdf)
- **Controlled user study** (control group 14, experimental group 13, essay-writing task over a 16,240-article
  archive):
  - 78.5% of experimental subjects ranked the RA first, and rated it about one point higher (out of 7) than a search
    engine for usefulness.
  - Experimental subjects viewed about 3× as many articles, and about 2.5× more through the RA than through search
    (p < 0.01). Search use did not fall.
  - Margin Notes did poorly: fewer than a third of subjects viewed any of its suggestions, because it only showed
    them while subjects were not doing their main task.
  - Essay quality showed no significant difference.
  — [Rhodes & Maes 2000](https://www.bradleyrhodes.com/Papers/rhodes-jitir-agents-ibmsj-2000.pdf)
- **IR-quality test.** Margin Notes was run with no threshold over 152,860 INSPEC citations. Nine researchers rated
  112 annotations: mean 3.3/5 for relevance to the paper and 3.4/5 for relevance to the section. In Table 3, 47% (17%
  + 30%) scored 4–5 for general relevance and 54% (19% + 35%) for section relevance. The body text renders these
  numbers garbled ("7 ± 9 percent"). Usefulness ratings were lower than relevance: 32% scored 1. —
  [Rhodes & Maes 2000, Table 3](https://www.bradleyrhodes.com/Papers/rhodes-jitir-agents-ibmsj-2000.pdf)
- **Proactive cards (Shokouhi & Guo, SIGIR 2015).**
  - Card engagement varies by time and location.
  - The topics a user clicks are consistent across proactive cards and reactive search.
  - A supervised re-ranker uses context, history and reactive search history. Its labels are pseudo-relevance
    inferred from **viewport duration and clicks**, and it significantly improves card ranking.
  - The MSR page gives no numbers.
  — [MSR publication page](https://www.microsoft.com/en-us/research/publication/from-queries-to-cards-re-ranking-proactive-card-recommendations-based-on-reactive-search-history/)
  [fetched]
- **Watson** (Budzik & Hammond, IUI 2000) builds queries from the user's current document using term-weighting
  heuristics (for example position and emphasis) and finds related web documents. —
  [ACM DL 10.1145/325737.325783](https://dl.acm.org/doi/10.1145/325737.325783) [canonical, not re-fetched]
- **Deng et al. 2023** survey proactive dialogue systems: clarification, target-guided and non-collaborative
  dialogues. — [arXiv:2305.02750](https://arxiv.org/abs/2305.02750) [canonical, not re-fetched]

### Inferences
- Eden's "silent by default" matches 25 years of JITIR findings. Concrete defaults that follow:
  - At most 1–3 items per injection.
  - Show the matching keywords or cue as provenance, as the RA's right-click did.
  - Gate on a calibrated score threshold, never top-k unconditionally.
  - Prefer short, single-point documents, which the RA authors informally found gave better hits.
- Usefulness is not relevance. A "redundancy" feature (is the item already in the agent's recent context?) belongs in
  the gate. The Meta paper's "don't restate visible info" rule and the RA's "already known" remark make the same
  point.
- Expect a raw precision ceiling of about 50% for query-free retrieval at the top. The threshold must therefore cut
  coverage heavily to reach the ≥80–90% precision a silent-by-default product needs (see Q4).

### Gaps
- Watson's exact term-weighting scheme and any threshold values were not verified this session.
- Google Now's internal thresholds are not public. No reliable source was found.
- The Shokouhi & Guo numeric results (metrics, lifts) were not obtained; the PDF was not fetched.

## Q3. Query performance prediction (QPP) as a cheap confidence signal

### Takeaway
Use post-retrieval score-distribution features from the source's own result list. These are top-1 score,
rank-1 vs rank-2 gap, normalized std of top-k scores (NQC/SMV-like), and WIG-like mean top-k minus a corpus/baseline
score. Add a few pre-retrieval features: max/avg IDF of cue terms, cue length, and the fraction of out-of-vocabulary
terms. Combine them with logistic regression (Platt) when labels are scarce, and move to isotonic regression only
when there are about 1,000 or more labels per segment. All of these features take O(k) on scores you already have,
so they cost microseconds.

### Cited Findings
- **Pre-retrieval predictors** use only the query and corpus statistics. **Post-retrieval predictors** also use the
  ranked list. Pre-retrieval predictors are useful for short queries but poor on longer ones. Standard-deviation-based
  post-retrieval predictors correlate more strongly with performance. Most QPP research has targeted short keyword
  queries. — [Hashemi et al., ICTIR 2019](https://people.cs.umass.edu/~hhashemi/public/hashemi-ictir19.pdf) (search
  snippet); [QPP overview, UvA](https://pure.uva.nl/ws/files/243375214/Query_Performance_Prediction.pdf) (search
  snippet)
- **NQC** (Normalized Query Commitment) is the std of the top-k retrieval scores divided by the corpus score, from
  Shtok, Kurland, Carmel et al. (TOIS 2012). — [ACM DL 10.1145/2180868.2180873](https://dl.acm.org/doi/10.1145/2180868.2180873)
  [canonical, not re-fetched]
- **WIG** (Weighted Information Gain) is the mean top-k score minus the corpus-model score, normalized by query
  length, from Zhou & Croft (SIGIR 2007). — [ACM DL 10.1145/1277741.1277835](https://dl.acm.org/doi/10.1145/1277741.1277835)
  [canonical, not re-fetched]
- **Clarity** is the KL divergence between the query language model (built from top documents) and the collection
  model (Cronen-Townsend, Zhou & Croft, SIGIR 2002). It is more expensive because it needs a language model over the
  top documents. — [ACM DL 10.1145/564376.564429](https://dl.acm.org/doi/10.1145/564376.564429) [canonical, not
  re-fetched]
- **Pre-retrieval predictors** (avg/max IDF, SCQ, avg ICTF, query scope) were compared by Hauff, Hiemstra & de Jong
  (CIKM 2008). Simple IDF-family predictors are competitive with more complex ones. —
  [ACM DL 10.1145/1458082.1458311](https://dl.acm.org/doi/10.1145/1458082.1458311) [canonical, not re-fetched]
- **Dense retrieval.** Score-distribution predictors carry over less well to dense retrievers. Coherence of the
  top-k embeddings (pairwise similarity among the top results) has been proposed instead. —
  [arXiv:2310.11405](https://arxiv.org/pdf/2310.11405) (search result)
- **Evaluation.** A 2025 reproducibility study of post-retrieval QPP uses sMARE as well as correlation and RMSE, and
  tests whether different predictors capture distinct information. — [arXiv:2503.24251](https://arxiv.org/html/2503.24251v1)
  (search snippet)
- **Calibration.** Platt scaling fits a sigmoid to classifier scores (Platt 1999). Isotonic regression is
  non-parametric and overfits on small data. Niculescu-Mizil & Caruana (ICML 2005) found Platt better when there are
  few calibration examples and isotonic better with more (around 1,000 or more). —
  [ICML 2005](https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf) [canonical, not re-fetched]

### Inferences
- **Recommended feature vector per (cue, source) pair.** About 10 floats, all computable from data Eden already has:
  - s1, the top score
  - s1 − s2
  - s1 / mean(top 5)
  - std(top 5) / |s1| (an NQC-like value)
  - number of hits above a floor
  - max IDF of the cue terms
  - cue length
  - recency of the top hit
  - whether the top hit is already in recent context (redundancy)
  - the source's historical precision prior
- **Calibrate per source.** Score scales differ: BM25 is unbounded and cosine is bounded. Fit one logistic
  regression per source on its features, or one global model with source one-hot features. Refit nightly.
- **Labelling with little data.** Start with hand-set priors and fit hand-set weights to Eden's eval scenarios.
  Then refit as implicit feedback arrives (Q6). Report calibration with ECE and reliability plots.
- These predictors are known to be weak. Published correlations with actual effectiveness are modest. Treat QPP
  features as inputs to a learned gate, not as a standalone threshold.

### Gaps
- No single source compared NQC, WIG and SMV head-to-head on short or keyword queries with numbers in this session.
  Correlation values are therefore not quoted.
- QPP for heterogeneous personal sources (mail, calendar, CRM) is essentially unstudied. No source was found.

## Q4. Selective prediction, abstention, and cascades with an LLM judge

### Takeaway
Treat "inject" as selective classification. Pick the threshold τ on a held-out set to meet a target precision, for
example ≥ 0.9, at the highest coverage, and use a conformal or binomial upper bound so the guarantee holds with small
n. Escalate to an LLM judge only in an uncertainty band [τ_low, τ_high) and stay silent below τ_low. Size the band so
that expected judge calls per hour stay within the Budget. Learned or conformal deferral is better than raw
confidence thresholds because LLM confidence is miscalibrated.

### Cited Findings
- **Selective classification.** Geifman & El-Yaniv (NeurIPS 2017) choose a threshold on a confidence function that
  guarantees a target risk with probability 1 − δ. They use a binary search over thresholds with a binomial tail
  bound on calibration data, and report risk-coverage curves. — [arXiv:1705.08500](https://arxiv.org/abs/1705.08500)
  [canonical, not re-fetched]
- **Conformal risk control** (Angelopoulos et al. 2022) gives finite-sample control of the expected value of any
  monotone loss, for example a false-fire rate. It needs only exchangeable calibration data. —
  [arXiv:2208.02814](https://arxiv.org/abs/2208.02814) [canonical, not re-fetched]
- **FrugalGPT** (Chen, Zaharia & Zou 2023) cascades LLMs and uses a learned scorer to decide whether to accept an
  answer or escalate. It reports matching GPT-4 performance with up to 98% cost reduction on its benchmarks. —
  [arXiv:2305.05176](https://arxiv.org/abs/2305.05176) [canonical, not re-fetched]
- **Conformal Cascade** (Dou, Lian & Li, arXiv 2607.25018, July 2026):
  - It argues that raw confidence thresholds "are a weak deferral rule" because LLM confidence is miscalibrated.
  - It accepts at a tier when the conformal prediction set has one element and defers otherwise.
  - Coverage is ≥ 1 − Kα with a union bound over K tiers, or 1 − α under a selection-preservation condition.
  - It needs only black-box access. On 18 multiple-choice benchmarks it beats calibration-tuned heuristic cascades on
    most pairs. On easy benchmarks it sends most queries to the small model at no accuracy cost.
  - Open-ended outputs would need answer clustering, which the authors leave for future work.
  — [arXiv abs](https://arxiv.org/abs/2607.25018) [fetched]
- **Cascades with abstention:**
  - A lightweight model answers first and escalates to a larger model, then to a human. The deferral and abstention
    thresholds are adapted online by SGD on a joint risk of error, cost and abstention. —
    [arXiv:2506.11887](https://arxiv.org/pdf/2506.11887v3);
    [NeurIPS 2025 slides](https://neurips.cc/media/neurips-2025/Slides/119942.pdf) (search snippets)
  - "Cost-Saving LLM Cascades with Early Abstention" calibrates confidence with logistic regression. It sets
    abstention thresholds below the deferral thresholds so that early tiers can abstain. —
    [review summary](https://www.themoonlight.io/review/cost-saving-llm-cascades-with-early-abstention) (secondary
    source)

### Inferences
- **Concrete gate algorithm (per event, in microseconds):**
  1. Run the cheap cue extractor (rules, entities, keywords).
  2. If there is no cue, stay silent. This should be about 80–95% of events; that is an expectation, unmeasured.
  3. Route to sources (Q5/Q6) and score candidates.
  4. Compute p = calibrated P(useful | features).
  5. If p ≥ τ_high, inject. If p < τ_low, stay silent. Otherwise, if Budget allows, call the LLM judge with the Meta
     rubric (Q1) on bounded input. If the Budget is exhausted, stay silent (fail closed to silence).
- **Setting τ_high.** On n labelled events, sort by p. Take the smallest threshold at which the one-sided binomial
  (Clopper-Pearson) upper bound on the false-fire rate among accepted events is ≤ the target, for example 0.10 at
  δ = 0.1 (Geifman & El-Yaniv style). With n = 200 accepted examples, observed precision must be about 0.94 to certify
  0.90 at 90% confidence. That figure comes from standard binomial arithmetic, not from a run in this session.
- **Setting τ_low.** Set it where the recall lost below τ_low is acceptable, for example where fewer than 5% of
  useful items fall below it. Set the band width by Budget: expected judge calls = event rate × P(τ_low ≤ p < τ_high).
- **Retraining from the judge.** Log the judge's verdicts. They become labels for retraining the cheap model, which
  narrows the band over time (the FrugalGPT and online-threshold pattern).
- **Report two curves:** risk-coverage (falseFireRate vs fire rate) and cost-accuracy (judge calls vs precision).

### Gaps
- Conformal guarantees assume exchangeability. Drift in per-user event streams violates this, and no source was found
  quantifying how much slack to add. Recalibrating per window is the usual remedy, but it is unverified here.
- No numbers were found for LLM-judge agreement with users on "useful proactive context". Only the Meta paper's
  qualitative failure list was found.

## Q5. Federated search resource selection and modern tool/source routing

### Takeaway
Classic resource selection ranks collections using per-source term statistics:
- **CORI** is df/icf-based, a BM25-like score over a source "super-document".
- **ReDDE** estimates the number of relevant documents in each source from a centralized sample index.
- **CRCS** is ReDDE with rank-based decay.
- **Learned vertical selection** (Arguello et al.) combines corpus, query-log and query-string features in a
  classifier.

Modern MCP tool routing is the same problem: embed or BM25 tool descriptions and retrieve the top-k. RAG-MCP reports
43% vs 14% selection accuracy over putting all tools in the prompt. For Eden's 5–30 sources: keep a small sampled
index or term-statistics profile per source, built from recent items Eden has already read, and score cues against it.

### Cited Findings
- **RAG-MCP** (Gan & Sun 2025) retrieves relevant MCP tool descriptions before selection. Tool-selection accuracy
  rises from 13.62% to 43.13% and prompt tokens fall by more than 50%. — [arXiv:2505.03275](https://arxiv.org/abs/2505.03275)
  [fetched]
- **Keyword matching is not enough.** Server capabilities are described differently from user queries, so Contextual
  AI's approach retrieves candidate servers from their descriptions and then reranks them. —
  [Contextual AI blog](https://contextual.ai/?p=3395) (search snippet; vendor source)
- **The federated search survey** (Shokouhi & Si 2011, Foundations and Trends in IR) covers resource description
  (query-based sampling), resource selection (CORI, ReDDE, CRCS, SUSHI) and result merging. —
  [FnTIR 10.1561/1500000010](https://www.nowpublishers.com/article/Details/INR-010) [canonical, not re-fetched]
- **CORI** (Callan, Lu & Croft, SIGIR 1995) uses an inference network that scores collections with
  df × icf–style beliefs. — [ACM DL 10.1145/215206.215328](https://dl.acm.org/doi/10.1145/215206.215328) [canonical,
  not re-fetched]
- **ReDDE** (Si & Callan, SIGIR 2003) estimates the distribution of relevant documents across sources by running the
  query against a centralized sample index and scaling by estimated collection size. —
  [ACM DL 10.1145/860435.860490](https://dl.acm.org/doi/10.1145/860435.860490) [canonical, not re-fetched]
- **CRCS** (Shokouhi, ECIR 2007) is ReDDE-like, with linear or exponential decay by rank in the sample-index result.
  — [Springer 10.1007/978-3-540-71496-5_17](https://link.springer.com/chapter/10.1007/978-3-540-71496-5_17)
  [canonical, not re-fetched]
- **Arguello, Diaz, Callan & Crespo (SIGIR 2009)**, "Sources of evidence for vertical selection", combine:
  - corpus features (ReDDE, Clarity on vertical samples)
  - query-log features (the query likelihood under each vertical's query log)
  - query-string features (rule and regex triggers, for example a location or "weather")

  in a per-vertical classifier, which beats any single-evidence baseline. —
  [ACM DL 10.1145/1571941.1571997](https://dl.acm.org/doi/10.1145/1571941.1571997) [canonical, not re-fetched]

### Inferences
- **Eden source router, about 1 ms or less.** For each source keep:
  1. A small BM25 or term-frequency profile of recently fetched item titles and snippets, after `sanitizeForStore`
     and keyed per tenant/user. This is a ReDDE-like "sample index".
  2. A description embedding or keyword set for the tool itself (RAG-MCP-like).
  3. Rule triggers by cue type: a time expression → calendar; an email address or person → mail and CRM; a file name
     or URL → docs. These are Arguello's "query-string" features.
  4. A learned per-source prior from feedback (Q6).

  Score = calibrated logistic combination of these features. Select the sources whose p(source has a useful item) ≥
  θ, capped at k_max = 3. Querying a source is an MCP round-trip, so cost per source matters more than scoring cost.
- **ReDDE needs collection-size estimates.** With personal sources Eden can observe sizes or recency directly, which
  is simpler than query-based sampling.

### Gaps
- No 2025–2026 benchmark of routing across a single user's personal sources (mail, calendar, CRM) was found. Tool-
  routing benchmarks cover public tool catalogs.
- The RAG-MCP accuracy figure comes from a stress-test setting with many tools. It does not transfer directly to 5–30
  sources.

## Q6. Bandits for source selection, and implicit feedback for "was the injection used"

### Takeaway
Use Beta–Bernoulli Thompson sampling per (user, source, cue-type) as the default. Initialise each arm with a weak
cold-start prior (for example Beta(1,1), or a population prior scaled to about 2–5 pseudo-observations). Apply
exponential discounting (γ ≈ 0.98–0.995 per update) for non-stationarity. Choose the top-k with a semi-bandit
update, where each queried source gets its own reward. Use linear Thompson sampling or LinUCB only once there are
d ≈ 5–15 context features and enough traffic. Rewards come from implicit signals (the agent's reuse of injected
content, explicit thumbs, follow-up queries). These are delayed and position-biased, so attribute rewards per source
and log propensities.

### Cited Findings
- **Thompson sampling tutorial** (Russo, Van Roy, Kazerouni, Osband & Wen 2018) covers Beta–Bernoulli TS,
  non-stationarity and approximations. — [arXiv:1707.02038](https://arxiv.org/abs/1707.02038) [canonical, not
  re-fetched]
- **Chapelle & Li (NeurIPS 2011)** showed empirically that TS is competitive with or better than UCB, and robust to
  delayed or batched feedback. — [NeurIPS 2011](https://papers.nips.cc/paper/2011/hash/e53a0a2978c28872a4505bdb51db06dc-Abstract.html)
  [canonical, not re-fetched]
- **LinUCB** (Li, Chu, Langford & Schapire, WWW 2010) is a contextual bandit with a linear payoff. On Yahoo! Today
  news it reported a 12.5% click lift over a context-free bandit. It also introduced offline replay evaluation from
  logged random traffic. — [arXiv:1003.0146](https://arxiv.org/abs/1003.0146) [canonical, not re-fetched]
- **Linear Thompson sampling** (Agrawal & Goyal, ICML 2013) has a regret bound for linear payoffs. —
  [arXiv:1209.3352](https://arxiv.org/abs/1209.3352) [canonical, not re-fetched]
- **Combinatorial / top-k semi-bandits.** Wang & Chen (ICML 2018) prove regret bounds for combinatorial Thompson
  sampling with semi-bandit feedback. — [arXiv:1803.04623](https://arxiv.org/abs/1803.04623) [canonical, not
  re-fetched]
- **Non-stationarity.** Discounted UCB and sliding-window UCB (Garivier & Moulines, ALT 2011). —
  [arXiv:0805.3415](https://arxiv.org/abs/0805.3415) [canonical, not re-fetched]
- **Implicit feedback biases.** Joachims et al. (SIGIR 2005) found clicks are biased by position and by trust in the
  ranking, and that relative judgments ("clicked > skipped above") are more reliable than absolute ones. —
  [ACM DL 10.1145/1076034.1076063](https://dl.acm.org/doi/10.1145/1076034.1076063) [canonical, not re-fetched]
- **Proactive card labels from viewport and clicks.** Proactive cards were trained on pseudo-labels from viewport
  duration and clicks. — [Shokouhi & Guo 2015](https://www.microsoft.com/en-us/research/publication/from-queries-to-cards-re-ranking-proactive-card-recommendations-based-on-reactive-search-history/)
  [fetched]
- **The RA planned to learn from suggestion choice.** It logged how often users opened a suggestion's full text and
  planned to learn from which suggestions users chose to display; the version described did not yet learn. —
  [Rhodes & Starner 1996](https://www.bradleyrhodes.com/Papers/remembrance.html) [fetched]

### Inferences
- **Per-decision cost.**
  - Beta TS: one Beta sample per arm (two Gamma draws). For 30 arms this is far below 1 ms in JS. The state is two
    floats per arm per user.
  - LinTS / LinUCB with d = 10: a d×d matrix per arm, rank-1 Sherman–Morrison update (O(d²) = 100 flops). Sampling
    needs a Cholesky factor (O(d³) = 1,000 flops). This is microseconds.
- **Recommended parameters (starting points, to be tuned on Eden eval; unverified):**
  - Prior: Beta(α0, β0) with α0 + β0 = 4 at the population mean click/use rate for that source type.
  - Discount: on each update multiply α and β by γ = 0.99 (an effective memory of about 100 decisions), with a floor
    at the prior.
  - Top-k: sample θ_s for each source, multiply by P(cue-match) from Q5, pick the top k ≤ 3 above a floor.
  - Reward: 1 if any item from source s was used, else 0, for each queried source (semi-bandit).
  - Delayed rewards: accumulate them until a horizon (end of session or T minutes), then update. TS handles delay well
    (Chapelle & Li).
  - Exploration constraint: explore only in which sources to *query*, never by *injecting* low-confidence items.
    This keeps exploration invisible to the user and precision-preserving.
- **The implicit "used" signal for an agent consumer (not a human):**
  - Lexical or entity overlap between the injected item and the agent's subsequent tool calls or output, for example
    over a 3-shingle Jaccard or exact-entity threshold.
  - The agent citing an item id.
  - The agent issuing a follow-up read on the injected item.
  - Explicit feedback API calls.

  Known biases:
  - Position or first-item bias.
  - The agent may copy injected text whether or not it helped. Reuse is not usefulness; the Meta paper showed
    plausible but unnecessary reminders can cause extra verification.
  - Silent events have no counterfactual.

  Mitigations:
  - Log the propensity of every decision.
  - Randomise a small holdout (for example 1–5% of would-fire events are withheld) so that utility can be estimated
    with replay or inverse propensity scoring, as LinUCB's offline evaluation did.
- **Metrics:**
  - precision@fire (useful fires / fires)
  - falseFireRate
  - coverage / fire rate
  - recall against labelled "should have fired" scenarios
  - ECE of the gate
  - mean sources queried per cue and MCP latency per cue
  - judge calls per 1,000 events
  - cumulative regret against the oracle source set, in offline replay

### Gaps
- No published study was found measuring implicit "use" of proactive context by an LLM agent, as opposed to a human.
  The overlap-threshold proxy is unvalidated.
- Discount factor values for personal-source drift are not grounded in any study found. γ is a tuning parameter.
- Correcting for position bias when exactly one item is injected (k = 1) is not covered by click-model work, which
  assumes ranked lists.
