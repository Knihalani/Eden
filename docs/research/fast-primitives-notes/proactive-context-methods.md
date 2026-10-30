# Proactive context: surfacing what the agent was not asked for, cheaply

Scope: a context partner beside an assistant agent reads the end user's mail, calendar, docs, CRM and chat (read-only)
and must surface context the agent did not ask for but needs before it acts. Examples: a calendar clash while
scheduling, an invoice already paid when asked to pay it, a friend's nut allergy when buying a gift, a legal hold when
committing to a date, an out-of-office reply when delegating. This note collects methods, parameters, reported numbers
and pitfalls from 2023–2026 work (plus a few older anchors), and ends with a ranked plan for a no-model-first engine.

Verification legend (Eden CLAUDE.md, "Honest numbers"):

- **[fetched]**: the page (abstract, HTML or summary of the PDF) was read in this session; the numbers come from it.
- **[search]**: the number came from a search-result snippet or a secondary summary in this session. It was not
  checked against the paper's tables.
- **[canonical]**: a well-known reference cited from prior knowledge. It was not re-fetched in this session, so treat
  any number attached to it as unverified.

No real personal data appears here. All examples are invented.

---

## 1. Anticipatory retrieval: turning a requested action into "check queries"

### 1.1 What the evidence says

- **Pre-execution gates work when the precondition is decidable from state.** A 2026 study adds four deterministic,
  read-only gates to τ²-bench airline. Each gate inspects a proposed write plus the current DB state and either allows
  it or rejects it with a structured reason. The gates make no model calls and fail open if they crash.
  Results: pass^1 rose from 29.6% to 42.0% (+12.4pp, paired bootstrap p=0.0012) and replicated at +12.3pp on 15
  disjoint seeds. pass^5 rose from 8.0% to 26.0%. With gpt-5.2 the gain was +10.4pp (61.2% to 71.6%, n=5,
  unreplicated). 78% of failures were silent wrong-state writes. The gains concentrated in tasks where a gate fired
  (+19.2pp), against +5.0pp (CI includes 0) where none fired. One gate, `cancellation_eligibility`, had 100% precision
  over 161 fires and carried most of the lift. Another gate had poor precision. Negative controls: in retail, whose
  tools already enforce policy, the change was −4.7pp (CI includes 0). On BFCL multi-turn the gates never fired
  (52.5% vs 51.0%). — [HF paper page, arXiv 2607.07405](https://huggingface.co/papers/2607.07405.md) [fetched]
  - Relevance to Eden: this is the cleanest evidence that a **typed precondition check per action type**, run against
    current source state with no model, catches the "invoice already paid" and "calendar clash" class. Eden cannot
    block the action (it is read-only and advisory), but the same predicate decides what to inject. The rejection
    _message_ may carry part of the gain; the authors call this a confound. That suggests the injected text should
    state the conflicting fact plainly.
- **Contracts as Hoare-style pre/postconditions.** ToolGate models each tool as a contract. The precondition gates
  invocation against a symbolic state, and the postcondition decides whether a result may update that state.
  — [arXiv 2601.04688](https://arxiv.org/html/2601.04688v1) [search]
- **Deterministic verifier with outcomes classified as success / clean failure / silent failure.** "Look Before You
  Leap: Pre-Action Verification" stresses that silent failure, where the action takes effect but is wrong, is the
  dangerous case. — [arXiv 2609.11957](https://arxiv.org/pdf/2609.11957) [search, fragment only]
- **Bounded review beats long review for LLM monitors.** "More Rejective, Not More Discriminative" evaluated six LLM
  judges in two domains. Reviewing longer action sequences before an irreversible step made monitors reject more
  legitimate plans without improving discrimination (informedness). Reviewing one or two actions did best.
  — [arXiv 2608.23941](https://arxiv.org/pdf/2608.23941) [search; secondary summary]
  - Relevance: if a model is used to judge, give it the **one pending action plus a few candidate facts**, not the
    whole trajectory.
- **Model-generated "what could go wrong" before acting.** Devil's Advocate (anticipatory reflection) has the agent
  predict likely failures and alternative remedies before each action, at the cost of one extra LLM call per action.
  It reports a 23.5% success rate on WebArena-style tasks, +3.5pp over zero-shot baselines.
  — [arXiv 2405.16334](https://arxiv.org/pdf/2405.16334) [search]
  - Small gain for one model call per step. That fails Eden's "no per-event model call" rule. Use it offline instead:
    generate the per-action-type checklist once, review it, and freeze it as rules (§6).
- **Generating implicit "dimensions" (PROPER).** A fine-tuned 8B "dimension generating agent" proposes latent
  aspects of the task the user has not raised. A calibrated reranker picks a fixed budget of k of them, scoring each
  by generator log-prob confidence, similarity to unmet explicit needs (BGE-small embeddings) and diversity. A
  response agent then folds them in concisely. Reported (GPT-5 judge, μScore): LLaMA-8B 2.19→3.86 (Medical),
  1.26→2.13 (Code-Contests), 2.34→4.06 (PersonalWAB). Removing the generator hurts most; removing the reranker costs
  less. The paper reports no over-proactivity rate, and judge style bias is a risk.
  — [arXiv 2601.09926](https://arxiv.org/html/2601.09926v2) [fetched]
  - Relevance: the useful pattern is **"generate many candidate needs → rerank under a hard budget k → state them
    concisely"**. Eden can do the generation step from a static per-action checklist and the reranking from structural
    signals, with no model.

### 1.2 Query expansion for implicit needs

Each entry: what it does; reported effect; cost on the hot path.

- **HyDE** (Gao et al. 2022 / ACL 2023): an LLM writes a hypothetical answer, which is embedded to retrieve
  neighbours. Beats unsupervised Contriever and is comparable to fine-tuned retrievers; weaker on TREC-COVID, FiQA
  and DBPedia. One LLM generation per query.
- **query2doc** (Wang et al., EMNLP 2023): a few-shot LLM pseudo-document is appended to the query (the query is
  repeated to keep its weight). BM25 +3% to +15% on MS MARCO and TREC DL with no fine-tuning. One LLM generation per
  query.
- **Step-back prompting** (Zheng et al., ICLR 2024): ask a more abstract question first, then retrieve or reason for
  both. PaLM-2L: TimeQA +27%, MuSiQue +7% (from a base near 40%). One or two LLM calls.
- **doc2query--** (Gospodinov et al., ECIR 2023): at **index time**, generate queries per document and _filter_ out
  hallucinated ones with a relevance model. Up to +16% effectiveness, index −33%, query time −23%. Zero cost at
  query time; paid at ingest.
- **LongMemEval fact-augmented keys**: at **index time**, add extracted facts to each memory key (K = V + fact).
  Recall@5 0.582→0.644; GPT-4o QA 0.615→0.657; on average +9.4% recall and +5.4% accuracy. Zero cost at query time.
- **LongMemEval time-aware expansion**: extract a time range from the query and filter by timestamp. On the temporal
  subset, Recall@10 0.550→0.722 with GPT-4o as the extractor; **an 8B extractor was worse than none**. Cheap if the
  time range is parsed by rules.

Sources: HyDE — [arXiv 2212.10496](https://arxiv.org/abs/2212.10496) [fetched abstract; per-dataset numbers not
verified]; query2doc — [arXiv 2303.07678](https://arxiv.org/abs/2303.07678v1) [search]; step-back —
[arXiv 2310.06117](https://arxiv.org/abs/2310.06117v1) [search]; doc2query-- —
[arXiv 2301.03266](https://arxiv.org/abs/2301.03266v3) [search]; LongMemEval —
[arXiv 2410.10813](https://arxiv.org/html/2410.10813v2) [fetched]. A 2025 re-evaluation puts HyDE and query2doc
within about 0.4 nDCG of each other on a BEIR average with Qwen2.5-7B (~32.6–33.0), and adding Rocchio-style feedback
reaches 34.7. — [arXiv 2511.19349](https://arxiv.org/pdf/2511.19349) [search; table garbled, row attribution unsure]

Takeaways for Eden:

1. **Move expansion to index time.** doc2query-- and fact-augmented keys show that expansion paid once per document
   at ingest (with filtering) gets most of the recall at zero query-time cost. That fits "model last": ingest work
   can be batched under `Budget`, while the fast path stays lexical.
2. **Query-time LLM expansion (HyDE, query2doc, step-back) gives single-digit to low-double-digit relative gains** on
   ad-hoc IR. Those benchmarks do not test "context the agent did not ask for". The implicit-need problem is better
   served by **action-typed check queries** (§6), which are deterministic and cover the needed facets by
   construction.
3. **Time scoping is high-yield and rule-parsable.** The LongMemEval result that a weak extractor hurts argues for
   rule-based date and range parsing (chrono-style) over a small model.

---

## 2. Entity-centric memory: entity cards, linking, latest-state-wins

### 2.1 Evidence

- **Granularity matters more than summarising.** LongMemEval: splitting sessions into rounds "significantly enhances"
  reading. Replacing raw values with extracted summaries or facts lowers QA because information is lost; facts help
  as _keys_ (index expansion), not as replacement _values_. Long-context reading drops sharply: GPT-4o goes from
  0.870 (oracle) to 0.606 (full history), −30%, and Llama-3.1-70B drops 55%. Llama-3.1-8B degrades beyond about 3k
  retrieved tokens. Commercial ChatGPT scored 0.577 against 0.918 for offline GPT-4o reading on a shorter setup.
  — [arXiv 2410.10813](https://arxiv.org/html/2410.10813v2) [fetched]
  - Relevance: store **raw snippets as values** and use entity and fact fields as keys. Keep the injected payload
    small (well under 3k tokens if a small reader model is ever used).
- **Bi-temporal facts with explicit invalidation (Zep / Graphiti).** Each edge carries a validity window (when the
  fact was true in the world) and a transaction time (when the system learned it). A new contradicting fact
  _invalidates_ the old edge rather than deleting it. Vendor-reported: up to +18.5% accuracy and −90% latency against
  baselines on LongMemEval (Jan 2025 paper); a later page reports 90.2% (451/500) at a median context of 4,408 tokens.
  The graph is built with an LLM (gpt-4o-mini) at ingest. — [arXiv 2501.13956](https://arxiv.org/pdf/2501.13956.pdf),
  [Zep blog](https://blog.getzep.com/zep-a-temporal-knowledge-graph-architecture-for-agent-memory) [search;
  vendor-run, not independently replicated]
- **Mem0**: an extract-then-update memory (ADD / UPDATE / DELETE / NOOP decided per candidate fact). On LoCoMo it
  reports −91% p95 latency and >90% fewer tokens than full context, and a +26% relative LLM-judge gain over OpenAI's
  memory. — [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) [search; abstract-level claims]
  - Caveat: in the Meta proactive-memory ablation, Mem0-style retrieval gave **no gain on airline** (68.0→68.0) while
    selective intervention gave +10. Generic memory retrieval is not proactive context. — §3.1
- **Knowledge updates are a weak spot across systems.** LongMemEval separates "knowledge update" questions, where
  the latest value supersedes the old one. Vendors report very different KU scores (83% to 100%), and none of these
  numbers are independent. — [Supermemory report](https://supermemory.ai/research/longmembench) [search; vendor]
- **Implicit preferences are not applied by LLMs unaided.** PrefEval: 3,000 preference–query pairs over 20 topics,
  with contexts up to 100k tokens. Zero-shot preference-following accuracy falls below 10% at 10 turns (~3k tokens)
  for most models. Prompting and retrieval only partially help.
  — [arXiv 2502.09597](https://arxiv.org/abs/2502.09597v1) [search]
  - Relevance: this is the "friend's nut allergy" case. The agent will not reliably recall a constraint stated weeks
    ago in chat. It must be **pushed** at the moment of the matching action (buy, book, order).
- **Calendar preferences need persistent strategy memory.** CalConflictBench gives agents year-long synthetic
  calendars with conflicts arriving round by round. Qwen-3-30B-Think has a 35% average error rate. PEARL adds an
  external memory of inferred strategies (attendee priority, topic importance, time and location preferences) plus
  RL, and reports a 55% improvement in average error rate over the strongest baseline.
  — [arXiv 2601.11957](https://arxiv.org/abs/2601.11957) [fetched abstract]
- **Entity resolution for personal data.** Named entity resolution in personal knowledge graphs is framed as "do two
  mentions refer to the same real-world entity", with blocking for efficiency.
  — [arXiv 2307.12173](https://arxiv.org/abs/2307.12173v1) [search]. Practical name-variant resources:
  the American English Nickname Collection has 331,237 nickname→given-name mappings built by record linkage, with a
  noise threshold — [Princeton DSS](https://dss.princeton.edu/catalog/resource6188) [search]. Febrl notes that valid
  spelling variants (Gail/Gale/Gayle) defeat dictionary spelling correction —
  [Christen slides](https://cs.anu.edu.au/people/Peter.Christen/publications/mcd2006-slides.pdf) [search]. Assistant
  patents describe phonetic expansion (double metaphone) and ranking by interaction frequency for "call my friend X"
  style resolution — [USPTO 11861315](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11861315)
  [search; patent, not validated research].

### 2.2 Concrete entity-card design (synthesised from the above; not a single paper's recipe)

- **Identity keys** (strongest first): email address (lower-cased, plus-tags stripped), phone (E.164), CRM ID,
  chat handle. Display names and first names are _aliases_, not keys.
- **Alias set** per entity: display names from headers, signature lines, calendar attendee names, nickname-table
  expansions (Bob↔Robert), and role aliases learned from co-occurrence ("my accountant", "legal", "the landlord"),
  each with a count and a last-seen time.
- **Linking a mention**: (1) exact key hit; (2) alias hit scored by recency × frequency of interaction with the user
  (people the user mailed last week beat a namesake from 2019); (3) ambiguity → do not inject an entity-specific
  claim, or inject both candidates labelled. Interaction-frequency priors are what assistant patents use and are
  cheap to keep as counters.
- **Typed facet slots** on the card, each a list of `(value, source ref, observed_at, valid_from, valid_to?)`:
  `constraint` (allergy, dietary, accessibility, legal hold), `availability` (OOO window, travel, working hours, time
  zone), `preference`, `status` (invoice paid/unpaid, contract signed, ticket open), `relationship` (manager, client).
  Facets are filled at ingest by rule extractors where possible (OOO auto-reply headers and subject patterns, ICS
  data, invoice status fields from CRM/accounting, "allergic to …" patterns), with an optional batched model
  extractor under `Budget` for free-text.
- **Latest-state-wins**: per (entity, facet, key) keep the newest observation by `observed_at`. Retain the older
  ones as invalidated (bi-temporal, as in Zep) so "it changed" can be explained. Precedence: an explicit status field
  in a system of record (CRM, accounting, calendar) beats a statement in a message, and a message from the entity
  beats a third-party mention.
- **Safety constraints never expire by recency alone.** A nut allergy stated once two years ago is still live unless
  contradicted. Availability expires at `valid_to`. This asymmetry is a per-facet TTL policy, not a global decay.

---

## 3. Conflict and constraint detection: calendars and commitments

### 3.1 Proactive memory as intervention (Meta, arXiv 2607.08716)

- Architecture: a memory agent beside an unmodified action agent. Phase 1 edits a bank B = (status, knowledge,
  procedural) via tool calls. Phase 2 emits either `<context_for_action>…` or `<no_intervention/>`, looking at the last
  k=8 messages. The prompt guidance is to intervene only when a remembered item is likely to affect the **next**
  action decision, and not to restate what is already visible or to give broad strategy.
- τ²-Bench (Sonnet 4.5 action, Opus 4.6 memory), macro / micro: baseline 57.5 / 55.0; full 64.3 / 61.2; passive
  full-bank 61.5 / 58.6; always-inject 63.5 / 61.5; advisor-only (no bank) 61.0 / 60.8 (airline _fell_ 68→62);
  Mem0 62.1 / 60.8 (airline flat at 68). Terminal-Bench 2.0 +8.3pp; τ²-Bench +6.8pp.
- Pitfalls the authors name: overconfident speculative inferences, redundant reminders, and plausible but unnecessary
  concerns that trigger extra verification. Prompted intervention is "imperfectly calibrated". No cost figures are
  given; it calls a frontier model at every memory step. An untrained 27B memory agent made results _worse_
  (0.709→0.693).
- [arXiv abs](https://arxiv.org/abs/2607.08716), [HTML](https://arxiv.org/html/2607.08716v1) [fetched]
- Reading for Eden: the value is **grounded, action-relevant, non-redundant** injection. Ungrounded advice hurts
  (advisor-only). Always-inject is close on micro average, so most of silence's value is balance and cost. A
  rule-gated injector that only speaks when a typed conflict exists is the cheap analogue.

### 3.2 Calendar-specific

- Calendar.help (Microsoft Research, CHI 2017) broke scheduling into well-defined workflows of microtasks: automated
  when possible, done by humans otherwise, with unusual cases escalated. It ran for over a year and scheduled
  thousands of meetings. — [arXiv 1703.08428](https://arxiv.org/pdf/1703.08428) [search]
  - Lesson: scheduling decomposes into a **fixed set of checks** (attendee availability, time zone, working hours,
    travel buffer, existing holds, room). This is checklist territory, not open-ended reasoning.
- CalConflictBench / PEARL (above): resolving _which_ meeting to keep is preference-heavy and LLMs err about 35% of
  the time. Eden's job is narrower: **detecting** the clash and surfacing the facts (both events, the organisers,
  any stated priority), leaving the choice to the agent.
- Detection itself is deterministic interval arithmetic: an interval tree or a sorted array of busy intervals per
  user and per known attendee (free/busy where the source exposes it). Add buffer rules (travel time when locations
  differ) and all-day OOO events. Treat tentative or declined events as soft or ignored.

### 3.3 Commitments and status in mail

- Commitment detection ("I'll send it by Friday") was shipped in Cortana/Outlook. In WSDM 2019, Azarbonyad, Sim and
  White show that domain shift between email corpora hurts commitment detectors badly, and that feature-level and
  sample-level domain adaptation recovers precision and recall. Privacy pushes training onto public corpora
  (Avocado, Enron). — [MSR publication](https://www.microsoft.com/en-us/research/?p=564174),
  [MSR blog "Email overload"](https://www.microsoft.com/en-us/research/?p=566577) [search]
  - Lesson: a learned commitment classifier is brittle across tenants. Prefer **structured signals** (calendar
    holds, CRM stage, invoice status, OOO auto-reply headers such as `Auto-Submitted: auto-replied` and
    `X-Autoreply`) and treat free-text commitment extraction as low-confidence enrichment.

---

## 4. Deciding relevance cheaply: rules, small judges, cascades, calibration

### 4.1 Evidence

- **Out-of-the-box LLMs over-fire.** ProactiveBench (ICLR 2025): 6,790 train and 233 test events. False-alarm rates
  were GPT-4o 51.85%, Claude-3.5-Sonnet 54.63%, GPT-4o-mini 64.73%. Fine-tuned Qwen2-7B reached F1 66.47% with
  50.22% false alarms. A fine-tuned LLaMA-3.1-8B _reward model_ agreed with human labels at 91.67% accuracy (F1
  91.80%), against 67% F1 for prompted GPT-4o and LLaMA-70B as judges. Predicting up to 3 candidate tasks cut GPT-4o
  false alarms 51.85%→36.44% (F1 64.60→77.72). Reward-model feedback cut false alarms but also recall.
  — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3) [fetched]
  - Two lessons: (a) a **small fine-tuned judge beats a large prompted judge** at "is this help wanted". (b) Prompted
    frontier models default to speaking, so silence has to be enforced by the gate, not requested in the prompt.
- **Decision-theoretic gate with calibrated probabilities (PRISM, 2026).** Speak iff p_accept ≥ τ, where
  τ(p_need) = C_FA / (C_FA + p_need · C_FN) is the Bayes-optimal threshold under asymmetric costs. Temperature scaling
  is fit on held-out data (T_need=0.5, T_accept=0.7) and cut ECE from 21.5% to 12.2% (need) and from 13.2% to 7.4%
  (accept). **Without calibration, the dynamic threshold underperformed a fixed one** (F1 70.29% vs 80.74%). A
  slow-thinking pass runs only when |p_accept − τ| ≤ δ, with δ=0.1. That routed about 11% of cases (10–15% across
  cost ratios) and gave p95 latency 196 ms against 176 ms fast-only and 312 ms slow-only (541 vs 510 vs 693 tokens).
  Qwen3-8B reached false alarms 22.94% and F1 86.61% on ProactiveBench (human-expert eval: 25.91% and 84.85%). Labels
  come from a 3-LLM majority vote (human agreement 89.1%, κ=0.71, n=229).
  — [arXiv 2602.01532](https://arxiv.org/html/2602.01532v1) [fetched]
  - This is the most directly reusable recipe: **calibrate, set the threshold from explicit costs, and escalate only
    the margin band.** The same structure works with a rule score in place of an 8B model.
- **Cascades.** FrugalGPT matches the best single LLM with up to 98% cost reduction, or gains +4% accuracy at equal
  cost, by trying cheap models first and stopping when a learned scorer accepts the answer.
  — [arXiv 2305.05176](https://arxiv.org/pdf/2305.05176) [search; abstract-level]. Adaptive-RAG routes queries with a
  small trained complexity classifier to no retrieval, single-step or multi-step retrieval. Classifier quality is the
  bottleneck: an oracle router is both better and cheaper.
  — [arXiv 2403.14403](https://arxiv.org/html/2403.14403v2) [search]
- **Relevance judges: agreement and prompt sensitivity.** UMBRELA (GPT-4o, Bing's relevance prompt) reports Cohen's
  κ against TREC DL qrels of about 0.42–0.50, higher on binary labels, and Kendall τ of 0.87–0.94 for system
  rankings. — [arXiv 2406.06519](https://web3.arxiv.org/abs/2406.06519),
  [comparison 2504.12558](https://arxiv.org/html/2504.12558v1) [search]. Arabzadeh & Clarke compared 72 usable
  prompts (human- and LLM-written) across binary, graded and pairwise formats with three LLM judges and found that
  agreement depends on the prompt. — [arXiv 2504.12408](https://arxiv.org/abs/2504.12408) [fetched abstract; κ
  ranges not read]. Multi-stage pipelines in which a larger judge can overturn a small model's "irrelevant" can beat
  GPT-4o alone. — [arXiv 2501.14296](https://arxiv.org/html/2501.14296v1) [search]
- **Calibration source.** For a classification-style judge, label-token log-probs plus temperature scaling on a
  held-out set is the standard recipe. Results differ by model: verbalized confidence beat raw probabilities for RLHF
  chat models in Tian et al. 2023 ([arXiv 2305.14975](https://arxiv.org/pdf/2305.14975)), while logit methods won on
  ECE for Qwen-2.5-7B in a 2026 study ([arXiv 2605.11954](https://arxiv.org/pdf/2605.11954)). Sampling consistency was
  the most reliable signal for long-form output ([arXiv 2602.00279](https://arxiv.org/html/2602.00279v1)). [search]
- **Reranker cost.** Small cross-encoders (MiniLM-L6, 22M params) rerank about 20 passages in roughly 50–150 ms.
  LLM listwise reranking is about 10–50× more expensive at 1–5 s. These are blog figures without a controlled
  benchmark. — ZeroEntropy, "Should you use LLMs for reranking?" (zeroentropy.dev/articles),
  [Redis](https://redis.io/blog/top-reranking-models-rag-accuracy.md) [search; unverified ballparks]

### 4.2 Judge framing (when a model is used at all)

Synthesised from the Meta guidance, PRISM and the monitor-length result. These are not separately A/B-tested in a
single paper.

- Ask a **counterfactual action question**, not a topical one: "Given the pending action A, does fact F make A wrong,
  unsafe, redundant or in need of change? yes/no". "Is F relevant to the conversation?" invites topical over-firing,
  which is the ProactiveBench failure.
- Show **one pending action and at most a handful of candidate facts**, each with source and date. Longer context
  made monitors more rejective without being more discriminative.
- Put the facts in a data block marked as untrusted source text (Eden "Untrusted content").
- Read a **binary label's log-prob**, temperature-scale it on held-out data, and threshold it with
  τ = C_FA / (C_FA + C_FN · p_need). Never use the uncalibrated verbalized score directly.
- Add a **"redundant" check**: drop any fact already present in the agent's visible context (string or ID match). Meta
  names redundant reminders as a top failure, and the check costs nothing.

---

## 5. Benchmarks for proactive assistants and what worked

Each entry: setting; headline finding; what helped.

- **ProactiveBench** (ICLR 2025): coding, writing and daily-life event streams, 233 test events. Frontier models
  false-alarm about 52–65% of the time. Helped: fine-tuning; top-3 candidate prediction; reward-model feedback (at a
  cost in recall).
- **PRISM on ProactiveBench** (2026): same setting. False alarms 22.9%, F1 86.6% with an 8B model. Helped: a
  calibrated cost-sensitive gate plus a slow pass only in the margin band.
- **PROPER / ProPerBench** (2026): Medical, Code-Contests and PersonalWAB shopping. Win rates against the base model
  of about 75–93%. Helped: generating implicit dimensions, reranking to a budget k, and integrating them concisely.
- **τ²-Bench + memory agent** (2026): airline, retail and telecom tool use. +6.8pp. Helped: selective grounded
  reminders; advisor-only and Mem0 did not help airline.
- **τ²-Bench + read-only gates** (2026): airline. +12.4pp pass^1, pass^5 roughly ×3. Helped: deterministic state
  predicates per write type.
- **CalConflictBench** (ACL 2026): year-long calendar conflicts. 35% error for Qwen-3-30B-Think. Helped: persistent
  preference-strategy memory plus RL.
- **LongMemEval** (ICLR 2025): 500 questions across extraction, multi-session, temporal, knowledge-update and
  abstention. About a 30% drop from oracle to full history. Helped: round granularity, fact-augmented keys,
  time-scoped retrieval.
- **PrefEval** (ICLR 2025): 3,000 preference pairs, contexts up to 100k tokens. Under 10% zero-shot preference
  following at 10 turns. Helped: retrieval and reminders only partly; fine-tuning helps.
- **ContextAgent** (NeurIPS 2025): 1,000 samples, 9 scenarios, 20 tools, wearable context. +8.5% proactive accuracy
  over the best baseline (8B). Helped: persona context plus sensory context before deciding to act.
- **PersonaLens** (ACL Findings 2025): 1,500 profiles, 111 tasks, 20 domains. Large variance in personalization
  across assistants.

Sources: [ProactiveBench](https://arxiv.org/html/2410.12361v3) [fetched]; [PRISM](https://arxiv.org/html/2602.01532v1)
[fetched]; [PROPER](https://arxiv.org/html/2601.09926v2) [fetched];
[Meta memory agent](https://arxiv.org/html/2607.08716v1) [fetched];
[gates](https://huggingface.co/papers/2607.07405.md) [fetched];
[CalConflictBench](https://arxiv.org/abs/2601.11957) [fetched abstract];
[LongMemEval](https://arxiv.org/html/2410.10813v2) [fetched]; [PrefEval](https://arxiv.org/abs/2502.09597v1) [search];
[ContextAgent](https://arxiv.org/html/2505.14668v2) [search]; [PersonaLens](https://arxiv.org/pdf/2506.09902) [search].

Human-factors evidence on over-proactivity:

- Unsolicited (anticipatory) AI help raised perceived self-threat and lowered willingness to accept help and to use
  the system again, more so than the same help from a human. _Offering_ help was received better than _acting_
  automatically. Two vignette studies, N=761 and N=571 (preregistered).
  — [arXiv 2509.09309](https://arxiv.org/abs/2509.09309v1) [fetched abstract; no effect sizes on the abstract page]
- ProMemAssist (UIST 2025) times interventions from a working-memory model, weighing value against interruption
  cost. In a 12-person study it was more selective and drew more engagement than an LLM-timed baseline.
  — [arXiv 2507.21378](https://arxiv.org/abs/2507.21378v1) [search]
- Just-in-time IR (Rhodes & Maes 2000): proactive retrieval from local context, shown non-intrusively, led users to
  retrieve and use more information than with search. This is the origin of "silent by default, cheap lexical
  match on current context".
  — [IBM Systems Journal PDF](https://www.bradleyrhodes.com/Papers/rhodes-jitir-agents-ibmsj-2000.pdf)
  [search]
- Eden's audience is an agent, not a person, so self-threat does not apply directly. Precision still matters because
  every injection costs the agent tokens and attention, and Meta's "unnecessary concern → extra verification" failure
  is the agent-side equivalent.

---

## 6. Pitfalls (collected)

1. **Topical relevance ≠ decision relevance.** Retrieval-style memory (Mem0) and passive bank exposure underperform
   selective, action-conditioned injection (Meta). Score facts by whether they bear on the pending action's
   preconditions, not by similarity to the conversation.
2. **Prompted LLMs over-fire** (ProactiveBench FA >50%). Silence must be structural: a threshold or a rule, not a
   prompt instruction.
3. **Uncalibrated thresholds are worse than fixed ones** (PRISM: 70.3 vs 80.7 F1). If Eden learns a threshold, it
   should calibrate on held-out eval first.
4. **Weak extractors can hurt** (LongMemEval: 8B time-range extractor below no expansion; untrained 27B memory agent
   below baseline). A small model is not automatically better than a rule.
5. **Gate quality is uneven** (one gate carried the lift, one had poor precision). Audit precision per rule and keep a
   per-rule fire log, which Eden's eval can report.
6. **Overfitting rules to the eval.** The τ² gates were written from the same tasks they were tested on. Hold out
   scenarios when writing per-action checklists.
7. **Summaries lose information** (LongMemEval). Inject raw source snippets with source and date, not paraphrases.
8. **Long review context makes judges more rejective, not more accurate** (2608.23941). Bound the input.
9. **Stale state.** Latest-state-wins needs `observed_at` from the source system, not ingest time, and safety facets
   (allergy, legal hold) must not decay by recency.
10. **Name ambiguity.** First names collide. Without a unique key or a strong interaction prior, abstain from
    entity-specific claims.
11. **Vendor numbers** (Zep, Mem0, Supermemory) are self-reported and disagree. Do not use them as targets.

---

## 7. Ranked recommendations for a no-model-first engine

Ordered by expected value per unit cost, cheapest and best-evidenced first. "Evidence" names the closest supporting
result; none of these numbers were measured on Eden, so each change needs its own `bun run eval` before/after.

1. **Action-type precondition checklists (rules, no model).** Classify the pending action into a small closed set by
   verb and tool name (`schedule`, `pay`, `buy/gift`, `commit-date`, `delegate/assign`, `send`, `book-travel`,
   `cancel`). Each type has a fixed list of _check queries_ over typed facets: schedule → attendee busy intervals,
   OOO, time zone, working hours; pay → invoice status, prior payment with same amount/payee/reference, duplicate
   invoice number; gift/buy → recipient constraints (allergy, dietary, dislikes), recent gifts; commit-date → legal
   hold, blackout, conflicting deadlines; delegate → assignee OOO, workload, role. Evidence: deterministic state gates
   gave +12.4pp on τ² airline at zero model cost; Calendar.help shows scheduling decomposes into fixed checks. Write
   the lists offline (a model may draft them; a human freezes them) and hold out eval scenarios.
2. **Typed entity cards with identity keys, alias sets and bi-temporal facets.** Link mentions by exact key, then
   alias weighted by interaction recency and frequency; abstain when ambiguous. Keep latest-state-wins per facet, with
   per-facet TTL (availability expires; safety constraints persist until contradicted) and source precedence (system
   of record > the entity's own message > third-party mention). Evidence: LongMemEval knowledge-update category and
   fact-keyed indexing gains; Zep bi-temporal invalidation; PrefEval shows that stated preferences are not recalled
   unaided, so they must be pushed.
3. **Deterministic conflict detectors** over structured sources: interval overlap on calendars (an interval tree or
   sorted typed arrays), equality/near-equality on invoice IDs, amounts and payees, OOO windows from auto-reply headers
   and calendar, and legal-hold flags. These produce _facts with provenance_, not scores, and are the highest-precision
   class (the 100%-precision `cancellation_eligibility` gate is this kind).
4. **Index-time expansion, not query-time.** At ingest, attach extracted entity IDs, facet tags, dates and (optionally,
   batched under `Budget`) doc2query-style questions filtered for hallucination. Evidence: doc2query-- +16% with a 33%
   smaller index; fact-augmented keys +9.4% recall. Query time stays lexical (one tokenizer, typed arrays) and adds
   rule-parsed time ranges (LongMemEval time-scoping; avoid weak model extractors).
5. **Decision-relevance gate with explicit costs.** Fire only when a check returns a _conflicting or constraining_
   fact for the pending action, the fact is not already in the agent's visible context (redundancy filter), and the
   rule's calibrated precision exceeds τ = C_FA / (C_FA + C_FN · p_need), with C_FA set high (silence by default).
   Calibrate per-rule precision from eval fire logs. Evidence: PRISM (calibrated cost-sensitive gate: FA 52%→23%; an
   uncalibrated dynamic threshold was worse than a fixed one); ProactiveBench (prompted models over-fire).
6. **Budgeted, diverse packing.** Select at most k facts (k≈1–3) by rule priority × recency × diversity (one fact per
   facet and entity), and inject raw snippets with source and date. Evidence: PROPER's budget-k reranker with a
   diversity term; ProactiveBench top-3 candidates cut false alarms; Meta's redundancy failure mode; LongMemEval shows
   small readers degrade past ~3k tokens.
7. **Margin-only escalation to a small judge.** Only when the rule score falls inside a narrow band around τ (PRISM
   used δ=0.1, about 11% of cases), call a small model under `Budget`. Frame it as "does F make pending action A
   wrong, unsafe or redundant? yes/no", with bounded input (one action, ≤3 facts, untrusted-data block), and read the
   label log-prob with temperature scaling. Evidence: PRISM p95 196 ms vs 176 ms fast-only; small fine-tuned judges
   beat prompted GPT-4o on ProactiveBench (91.8 vs 67.0 F1); long-context review makes monitors over-reject. Needs
   a decision and a COST-MODEL entry before it ships (Eden rule: no per-event model call without one).
8. **Learned or fine-tuned components last.** A fine-tuned small "need" classifier (ProactiveBench, PRISM) or a
   dimension generator (PROPER) earns its place only once rule coverage plateaus in eval. Commitment-detection
   history (WSDM 2019) warns that such classifiers break under tenant domain shift, so keep them behind the rules,
   never in place of them.
9. **Do not adopt**: per-event frontier-model memory agents (Meta's design: real gains, but a frontier call per step
   and no cost data), query-time HyDE/query2doc on the fast path (one LLM call per query for single-digit gains on
   benchmarks that do not test implicit needs), and per-action LLM "what could go wrong" reflection (Devil's Advocate:
   +3.5pp for a model call per action). Use their _outputs_ offline to author checklists instead.
