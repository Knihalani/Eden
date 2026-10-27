# R2 — Cue architecture: how the right memory arrives when the prompt shares no words with it

**Dated 2026-09-29.** Research input to `A4-DELIVERY-CONTRACT.md` §5 (Submit pipeline) and `A2-TECHNICAL-CHOICES.md` §2.1–2.3. Mechanisms and architecture only; the embedding-vs-lexical measurement is a separate bench.

Verification legend: **[V]** primary source opened this session; **[V-abs]** abstract/listing page opened; **[U]** not opened, from model knowledge — do not cite externally until checked.

## 0. Summary

**The answer in one sentence:** when the prompt shares no words with the memory, it almost always shares something with the situation the memory came from: the agent's last message, the files and commands of the last few tool calls, an error, a slot. So cue on **conversation state and tool events**, not just the prompt. Build the semantic bridge **on the memory side, offline**. Gate injection on **typed evidence**, where only distinctive or independently corroborated cues can trigger.

1. **Science.**
   - Encoding specificity / TAP: store the *encoding context* with each memory (`enc_cues`).
   - TCM/CMR: keep a drifting session context vector.
   - ACT-R: `S_ji = S − ln fan` is IDF, the rational form is PMI (for learned edges), and the retrieval threshold is the silence gate.
   - Berntsen: involuntary recall runs on *distinctive* feature overlap, specific episodes and external cues. That is Eden's injection model.
   - Prospective-memory focality: compile memories into path / command / error triggers.
   - Feeling-of-knowing: familiarity is a good *negative* gate and a bad *positive* one.
2. **IR.**
   - Adopt doc-side expansion (inference-free SPLADE-doc, doc2query with doc2query--'s filtering, plus Eden's own silence-set filter).
   - Reject query-side expansion and PRF on the hot path.
   - RRF is for ranking only.
   - Retrieval-necessity methods (Self-RAG, FLARE, SKR) do not transfer: memories are private facts.
   - 2026 abstention work (arXiv:2609.15578, 2609.11646) says: gate on score-*distribution* shape and agreement, not on magnitude.
   - Cross-encoders: daemon/sleep only.
3. **Code cues.**
   - Error signatures, path anchors, command heads, co-change from git, test↔code names. All are local and exact.
   - Industry convergence: glob/file triggers for rules (Cursor, Windsurf), "description only" pointers, Cody's multi-retriever + pointwise-threshold ranker, Aider's personalized PageRank. Claude Code dropped RAG for agentic grep.
   - arXiv:2607.20972 **exists** (Saha, 23 Jul 2026). It corroborates path/event triggers and a fire ledger. It reports 0 voluntary memory calls in 114 turns. It gives no precision numbers and says its symbol/temporal triggers never fired.
4. **Anticipation.** "Predict wide at Stop, confirm narrow at Submit." Most of the value is in tier 0: the agent's own last message as a cue for "yes / do it" turns. An LLM prediction is a gated experiment (sleep-time compute gains track predictability; ProactiveBench F1 is only 66%).
5. **Architecture.**
   - Typed evidence: STRONG (slot, trigger, error signature, rare identifier) / MEDIUM (rare token, `enc_cues`, learned edge, `q_prev`) / WEAK (aliases, context, graph, prefetch, similarity).
   - Admit on 1 STRONG, or 2 MEDIUM from independent sources, or 1 MEDIUM plus a calibrated gate model.
   - Additional delivery points: PostToolBatch, PostToolUseFailure and optionally PreToolUse, all sharing one ledger.
6. **Build first:**
   1. the evidence-typed gate + shadow log;
   2. the previous-assistant-message cue + turn mode;
   3. error signatures;
   4. `enc_cues` + context vector;
   5. the slot detector;
   6. PostToolBatch place triggers.

   Then the learning loop (doc2query--, PMI edges), then experiments (LLM prediction, graphs, embeddings as features).

## 1. Cognitive science of cueing

The one idea that runs through all of this section: **a cue retrieves a memory because of what was stored *with* the memory, not because of what the memory says.** Eden today indexes what the memory says (its content tokens, plus sleep aliases). Most "no shared words" misses are really *encoding-context* misses: the prompt shares words with the situation the memory came from, not with the memory's text.

### 1.1 Encoding specificity and transfer-appropriate processing

**Mechanism.** Tulving & Thomson (1973): a retrieval cue is effective only to the extent that the information it carries was encoded together with the target. The classic demonstration: a strong semantic associate (`cold`) fails to cue `ICE` if `ICE` was studied with a weak associate (`ground`), while `ground` succeeds [U]. Morris, Bransford & Franks (1977), transfer-appropriate processing: memory performance depends on the *match* between the processing done at study and at test (rhyme study → rhyme test beats semantic study → rhyme test) [U]. Watkins & Watkins (1975), cue overload: a cue's power falls as more items are attached to it [U].

**What it means for Eden.**
- A memory should carry the **cues it was encoded with**, not just its content. When the user says "we use pnpm here" right after `npm i` failed in `apps/web`, the encoding context is `{npm, install, ERR_PNPM…, apps/web, package.json, lockfile}`. That set, not the word `pnpm`, is what the next session's "install deps" prompt will overlap with.
- Store it as a separate field: `enc_cues` (bounded ≤ 16 rare tokens drawn from the triggering prompt, the preceding assistant turn, and the last ≤ 3 tool calls). Index it in BM25F with its own weight. This is document expansion *from the episode*, which is cheaper and more grounded than LLM doc2query (§2.2), and it needs no model.
- TAP says the *form* of the stored cue should match the form of future cues. Future cues in a coding agent are **task imperatives** ("fix the flaky login test", "deploy staging") and **tool events** (a command about to run, a file about to be edited). So memories should be indexed by *the tasks and events that need them*, not only by their declarative content. That is exactly the doc2query idea, restated: "what would a developer type or do when this fact matters?"
- Cue overload is ACT-R's fan (§1.3) and IR's IDF. Generic tokens (`test`, `fix`, `auth`) are overloaded cues and must never trigger injection alone.

**Evidence strength.** The encoding-specificity principle is one of the best-replicated findings in memory research. Its engineering translation (store encoding context; index by task shape) is an inference, not a measured result. Eden's own restatement log (A4 §7) is the right test.

### 1.2 Temporal Context Model and CMR: context drift as a retrieval cue

**Mechanism.** TCM (Howard & Kahana 2002) keeps a slowly drifting context vector: `t_i = ρ_i · t_{i−1} + β · t_i^IN`, where `t^IN` is the input evoked by the current item and ρ is chosen so ‖t‖ = 1 [U: equation from model knowledge; the model and its lineage are V-abs]. Each studied item is associated with the context active when it was studied. At recall, the current context cues items whose study context is similar; a recalled item **reinstates** its own study context, which then cues its temporal neighbours. This explains recency and the contiguity effect (recalling item *i* tends to be followed by *i±1*). CMR (Polyn, Norman & Kahana 2009, *Psych Review* 116:129–156) generalizes the context to include *source* features (task, encoding operation) and pre-existing semantic associations; clustering by time, source and meaning all fall out of context-to-item associations [V-abs].

**What it means for Eden.** Three concrete borrowings, each cheap:
1. **A drifting session context vector** kept in `delivery.json`: a sparse map token → weight, updated at every PostToolUse and Submit as `c ← ρ·c + β·f(event)`, where `f(event)` is the set of rare tokens in that event (paths, symbols, command heads, error codes, prompt rare tokens). With ρ ≈ 0.7 per event, a file touched 5 tool calls ago keeps ~17% weight. Cap at 64 entries (drop the smallest). This *is* the "recency-weighted conversation-state cue" asked about in §5, and TCM is its principled form.
2. **Encoding-context snapshot.** When a memory is written, store the top-k of `c` at that moment as `enc_cues` (§1.1). Retrieval then scores `sim(c_now, enc_cues)` as one field, in addition to `sim(prompt, content)`. This is what lets "ok now do the same for the cli" retrieve something: the prompt shares nothing, but `c_now` still holds the paths and commands of the last few turns.
3. **Contiguity edges.** Memories written in the same episode (same session, within a few turns) get a weak mutual link. When one is retrieved with high confidence, its neighbours get a small boost — never enough to inject on their own (§7.4 gating). Predictive Associative Memory (Dury 2026, arXiv:2602.11322) is a recent learned version of exactly this: retrieval by temporal co-occurrence rather than similarity, reporting cross-boundary Recall@20 = 0.421 where cosine similarity scores zero [V-abs; single-author preprint, synthetic streams].

**Failure mode.** A drifting context is a *recency prior*. After a topic switch ("ok, different thing: the CI is red"), the old context still dominates for a few events and can pull in stale-topic memories. Mitigations: (a) the prompt's own rare tokens enter with a large β so a real switch dominates immediately; (b) context never triggers an injection alone — it only contributes to rank among candidates that already passed the gate (§7.4).

### 1.3 Spreading activation (ACT-R): S_ji, fan, and a retrieval threshold

**Mechanism.** ACT-R activation: `A_i = B_i + Σ_j W_j · S_ji (+ noise)`, retrieval succeeds only if `A_i > τ` (the retrieval threshold), and latency falls with activation. Associative strength `S_ji = S − ln(fan_j)`, where `fan_j` is how many chunks cue *j* is associated with (Anderson & Reder 1999) [V-abs via search result; Anderson 1974 fan effect U]. The underlying rational definition is `S_ji ≈ ln( P(i | j) / P(i) )` — the log-likelihood ratio that chunk *i* is needed given cue *j* is present (Anderson 1990 rational analysis) [U].

**What it means for Eden.**
- `S − ln(fan)` is **IDF** in disguise. Eden's rare-token-first rule is already ACT-R-consistent.
- The **rational** form `ln P(i|j)/P(i)` is the correct way to learn cue→memory edges from usage (§6.3): count how often memory *i* was `used` (A4 §8) when cue token *j* was in the context, versus its base rate. That is PMI, and it gives a principled weight to Hebbian edges.
- The retrieval threshold τ is the silence gate. ACT-R explicitly models "nothing comes to mind" as the normal outcome when no chunk clears τ. Eden should treat the gate as a threshold on a *summed activation* over several weak sources (prompt, context vector, learned edges, base-level), not as "one rare token matched". This lets two weak, independent cues together clear the bar while one weak cue does not.
- `W_j` (source activation, attention) is limited and divided among cue sources. Practical translation: normalize weights across cue components so adding more context tokens does **not** raise every memory's activation. Without normalization a long context vector makes everything look relevant.

**Recent agent-memory uses.** SYNAPSE (Jiang et al. 2026, arXiv:2601.02744) does spreading activation with lateral inhibition and temporal decay over an episodic-semantic graph, fused with embeddings, evaluated on LoCoMo [V-abs]. It is a chat-memory benchmark and uses embeddings; it is evidence that the mechanism is being revisited, not that it transfers to coding cues.

### 1.4 Involuntary autobiographical memory (Berntsen): the model for *silent, automatic* injection

**Mechanism** (Berntsen 2010, *Curr. Dir. Psych. Sci.* 19:138, doi:10.1177/0963721410370301) [V — author PDF opened]:
- Involuntary memories "come to mind with no preceding attempt directed at their retrieval". They are about as frequent as voluntary ones, typically 2–5 per day.
- They run on the same episodic store as voluntary memory but differ in **retrieval**: "an associative process — instigated by situational cues — that take place with little executive control".
- They favour "past events with a *distinctive* feature match to the current situation", and events made accessible by recency, novelty and emotion.
- They are **more specific** (a particular episode, not a summary) than voluntary memories.
- They arise most often when attention is *diffuse* (not concentrated on a task).
- The mode "operates in a way that optimizes relevance" because it requires distinctive overlap.
- The earlier diary study (Berntsen 1996) found that nearly all involuntary memories had an identifiable cue, mostly external (environment) rather than internal (thought) [V-abs via search summary].

**What it means for Eden.** Eden's injection *is* involuntary recall on behalf of the agent. The cognitive design lesson is clean:
- Trigger on **distinctive** overlap (identifiers, paths, error codes, rare tokens, specific commands), never on generic topical overlap. This is the strongest scientific argument for keeping the hot path lexical/identifier-first and making semantic similarity a *ranking* signal rather than a *trigger*.
- Prefer **specific episodes** ("on 2026-08-12 `pnpm test` failed with `ERR_REQUIRE_ESM`; fix was `--experimental-vm-modules`") to generic summaries. Specific episodes are exactly what the agent cannot re-derive.
- Recency, novelty and salience (A4 §3.6) legitimately raise accessibility.
- **External cues dominate.** For an agent, "external" means tool events: files opened, commands run, errors seen. This argues for making PostToolUse events first-class cues (§5), not just the user's words.

### 1.5 Prospective memory: cue focality

**Mechanism.** McDaniel & Einstein's multiprocess framework: a prospective-memory cue is **focal** when the ongoing task already processes the features that define it (e.g., the target is a specific word in a word-processing task); focal cues produce **spontaneous retrieval** with no monitoring cost. **Non-focal** cues (e.g., a syllable while doing semantic judgements) require costly strategic monitoring, and performance drops sharply without it [V-abs: Einstein & McDaniel 2005 *Curr. Dir.*; PMC2864946]. Implementation intentions ("when X, then Y", Gollwitzer 1999) make cues more focal [U].

**What it means for Eden.**
- An intent or memory is cheaply and reliably retrievable when its trigger is a feature Eden **already computes** on every event: a path glob, a command head, an error signature, a scope. Those are focal. A trigger that needs deep semantic judgement of the prompt is non-focal: it needs an expensive monitor (an embedding, an LLM) on every turn, and without that it will be missed.
- So: at write/sleep time, **convert memories into focal triggers** wherever possible. "Before running migrations, back up the dev db" → trigger `cmd:prisma migrate*` ∨ `path:**/migrations/**` ∨ `token:migrate`. This is exactly the path/symbol/event trigger vocabulary of the cue-anchored paper (§3.7).
- Non-focal triggers (pure semantics) are the ones to precompute speculatively (§4), not to evaluate from scratch on the hot path.

### 1.6 Feeling-of-knowing gates

**Mechanism.** Reder & Ritter (1992): in a "retrieve or compute?" task, the fast (< ~850 ms) decision to retrieve is driven by **familiarity of the question terms**, not by whether the answer is actually in memory; FOK can be inflated by making cues familiar without making answers retrievable [V-abs via search; PDF at acs.ist.psu.edu listed]. Metcalfe, Schwartz & Joaquim (1993) cue-familiarity heuristic; Koriat (1993) accessibility account (FOK from the amount of partial information that comes to mind) [U].

**What it means for Eden.**
- A cheap familiarity check (does any rare cue token have postings in this scope? A3 §3.13) is a good **negative** gate: low familiarity → silence, fast. That is what humans use it for.
- It is a bad **positive** gate. Familiar cue terms with no matching answer is the textbook FOK false alarm, and in Eden it is the "prompt mentions `auth`, we have 40 auth rows, none relevant" false inject. So familiarity may *skip* retrieval; it may never *justify* injection. Injection requires a candidate that clears the full evidence threshold (§7.4).
- Koriat's accessibility account supports the A3 **pointer bullet**: when many partial matches exist but none is decisive, say *that* something exists and where, not the content.

### 1.7 Section verdict

| Borrowed idea | Eden form | Where computed |
|---|---|---|
| Encoding specificity / TAP | `enc_cues` field: rare tokens of the triggering prompt, previous assistant turn, last ≤ 3 tool events | write (hook), refined at sleep |
| TCM drift | Sparse session context vector `c` in `delivery.json`, ρ≈0.7/event, ≤ 64 entries | PostToolUse + Submit |
| TCM contiguity | Weak links between memories written in the same episode | sleep |
| ACT-R fan / S_ji | IDF weighting; learned `S_ji = ln P(used_i \| cue_j) / P(used_i)` | sleep (learn), Submit (sum) |
| ACT-R threshold τ | Silence gate over **summed** evidence, not "any rare token" | Submit |
| Berntsen distinctiveness | Triggers must include a distinctive feature; semantic similarity ranks, never triggers | Submit |
| PM focality | Compile memories into path / command / error / symbol triggers | sleep |
| FOK | Familiarity = fast *negative* gate only; pointer bullets for partial matches | Submit |

## 2. IR mechanisms

The IR literature has spent 25 years on the exact problem "query and relevant document share no words" (the *vocabulary mismatch problem*, Furnas et al. 1987 [U]). It has converged on one lesson that fits Eden's constraints unusually well: **move the semantics to the document side, offline, and keep the query side a tokenizer.**

### 2.1 Learned sparse retrieval, and the inference-free (doc-only) variant

**Mechanism.** SPLADE (Formal, Piwowarski & Clinchant, SIGIR'21, arXiv:2107.05720) [V-abs] uses a BERT MLM head to produce a sparse weight vector over the ~30k wordpiece vocabulary for both query and document: log-saturated term weights plus learned **expansion** terms, with a FLOPS regularizer controlling sparsity. It lives in an ordinary inverted index. The **inference-free** variant encodes only documents; the query side is "a tokenizer and a weight look-up table" (IDF) [V: OpenSearch `opensearch-neural-sparse-encoding-doc-v3-distill` model card: 67M params, BEIR avg NDCG@10 0.517; doc-v2 0.504; doc-v3-gte 0.546]. Geng et al. 2024 (arXiv:2411.04403) add an IDF-aware penalty and heterogeneous-teacher distillation, reporting +3.3 NDCG@10 over prior inference-free models with **client-side latency 1.1× BM25** [V-abs]. BM25's BEIR average on the same 13-dataset set is ≈0.43–0.44 [U].

**Fit for Eden.** Very good in principle, with two caveats.
- *Good:* it is exactly the A2 §2.3 plan (semantics on the doc side at sleep, query = tokenizer), and the literature says it recovers most of the dense-retrieval gain. A 67M model at sleep encodes a few thousand rows per minute on CPU [U, estimate].
- *Caveat 1 — vocabulary.* The expansion terms are BERT wordpieces. Code identifiers (`useAuthRedirect`, `ERR_REQUIRE_ESM`) split into sub-word pieces, and the model was trained on web QA (MS MARCO etc.), not on developer prompts. Use it **only** to add *whole-word* expansion terms (drop `##` pieces), and keep Eden's own identifier tokenizer for everything else.
- *Caveat 2 — silence.* Expansion adds many low-weight terms per row. Those terms must be treated as **weak evidence** (like aliases, weight ≤ 1.0 and never sufficient alone to trigger), otherwise expansion fattens postings and raises false injects. Doc2query-- (next) shows the fix: filter the expansions.

### 2.2 Doc2query and doc2query--

**Mechanism.** Doc2query/docTTTTTquery (Nogueira et al. 2019) generates likely queries for each document with a seq2seq model and appends them to the document before indexing [U]. Doc2query-- (Gospodinov, MacAvaney & Macdonald, ECIR 2023, arXiv:2301.03266) [V-abs] observes that generated queries hallucinate; **filtering them with a relevance model before indexing** improves effectiveness by up to 16%, cuts query time 23% and index size 33%.

**Fit for Eden.** This is the right shape for the sleep-time "what would a developer type when this matters?" pass (A2 §2.3), with an LLM as the generator. The doc2query-- lesson maps to two filters Eden can apply cheaply:
1. **Relevance filter** — keep a generated cue only if a scorer (the sleep LLM itself, or a cross-encoder) rates it relevant to the row.
2. **Silence filter** (Eden-specific, stronger) — replay the generated cue against the store; drop it if it would pull in *other* rows above threshold or if it matches the silence set (A4 §7 alias maturation). A cue that makes the store less selective is a hallucination by Eden's definition.

Generated cues should be **task-shaped** (imperatives and questions: "set up the db locally", "why does login redirect twice") because that is what TAP (§1.1) says future cues will look like.

### 2.3 Query-likelihood models, and TILDE

**Mechanism.** Ponte & Croft (1998) rank documents by the probability that the document's language model generates the query [U]. TILDE/TILDEv2 (Zhuang & Zuccon 2021, arXiv:2108.08513) [V-abs] apply this with BERT at indexing only: passages are expanded and scored per token at index time, the query is only tokenized, re-ranking stays **< 100 ms on commodity CPU**, index 99% smaller than TILDE.

**Fit for Eden.** Conceptually identical to §2.1 (doc-side precompute, tokenizer at query). No reason to prefer it over the sparse-expansion route; it confirms the design pattern from a second independent line of work.

### 2.4 HyDE — and running it at Stop instead of Submit

**Mechanism.** HyDE (Gao, Ma, Lin & Callan 2022, arXiv:2212.10496) [V-abs] has an LLM write a *hypothetical answer document* for the query, embeds it, and retrieves real documents near it. It beat unsupervised Contriever and approached fine-tuned retrievers zero-shot.

**Can it run at Stop?** Not in its original form: HyDE needs the query, and at Stop the next prompt does not exist yet. But its *spirit* transfers two ways:
- **Doc-side HyDE = doc2query** (§2.2). At sleep, write the hypothetical *queries* for each memory instead of the hypothetical *document* for each query. Same bridge, opposite side, no hot-path cost.
- **Next-turn HyDE at Stop** (§4): at Stop, an LLM (or the agent's own final message) is used to *predict what the next turn will need* and pre-retrieve against that prediction. That is HyDE with the *predicted* next prompt. Its value is bounded by how predictable the next turn is (§4.3).

### 2.5 BM25 + dense hybrid, and RRF

**Mechanism.** Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009) scores `Σ_r 1/(k + rank_r(d))`, k = 60, and beat Condorcet and learned rank fusion on TREC [V-abs: dblp / IR Anthology listing]. Hybrids of BM25 and dense routinely beat either alone on BEIR [U, widely reported].

**Fit for Eden.** RRF is a *ranking* tool, not a *gating* tool, and that is the key point for Eden:
- RRF discards scores, so it cannot say "nothing is relevant". A fused list always has a top item. **RRF must sit after the silence gate, never replace it.**
- RRF also rewards documents that appear in *both* lists, which is a cheap agreement signal. Eden can use **agreement as gate evidence**: a candidate found independently by two different cue sources (e.g. the prompt's lexical match *and* the context vector, or the prompt *and* a learned edge) is much more likely relevant than one found by either alone. That is the ACT-R "summed activation from independent sources" idea (§1.3) again.

### 2.6 When to retrieve: Self-RAG, Adaptive-RAG, FLARE, SKR, and calibrated abstention

**What these do.**
- *Self-RAG* (Asai et al. 2023, arXiv:2310.11511) trains the generator to emit a `Retrieve` reflection token and critique tokens [V-abs].
- *Adaptive-RAG* (Jeong et al., NAACL 2024, arXiv:2403.14403) routes each query to no-retrieval / single-step / multi-step via a small classifier trained on automatically derived labels [V-abs].
- *FLARE* (Jiang et al. 2023, arXiv:2305.06983) generates a tentative next sentence and retrieves only when it contains low-confidence tokens, using the tentative sentence as the query [V-abs].
- *SKR* (Wang et al. 2023, arXiv:2310.05002) decides from the model's self-knowledge, via similar previously seen questions, whether to retrieve [V-abs].
- *Mallen et al.* (ACL 2023, arXiv:2212.10511): retrieve only for less popular entities; parametric memory suffices for popular ones [V-abs].

**Why most of this does not transfer to Eden.** All of these ask *"does the model already know the answer?"*. Eden's memories are **private project facts** that the model cannot know parametrically. For Eden the necessity question splits into two different questions:
1. **Does a relevant private memory exist?** → a *retrieval-sufficiency* / query-performance-prediction problem (below).
2. **Is it already in the context window?** → the delivery ledger, residual check and shadow set (A4 §4, §6). No retrieval-necessity paper addresses this, because they all assume a stateless single query.

Self-RAG and FLARE also need the generator's internals (special tokens, token probabilities). Claude Code exposes neither. Adaptive-RAG's idea — a tiny classifier over the query deciding the retrieval *mode* — does transfer (§6.1).

**Calibrated abstention — the part that does transfer.** Two September 2026 papers are directly on point:
- *The Magnitude Mirage* (Holdcroft, Abdallah & Jatowt, EMNLP 2026, arXiv:2609.15578) [V-abs]: across 11 retrievers and 28 datasets, raw similarity scores are poorly calibrated for abstention; neural retrievers give high scores to related documents that violate logical/temporal constraints. **Score-distribution** signals (top-1 − top-2 gap, magnitude + variance) improve abstention AUROC by up to 0.16 on reasoning-heavy queries.
- *Distribution-Shape QPP* (Veselý, Průšek & Franc, TSD 2026, arXiv:2609.11646) [V-abs]: 24 cheap features (15 of them about score-distribution shape) predict retrieval sufficiency at weighted AUROC 0.856 **at 2 ms per query**, beating classical QPP (0.835) and a local LLM judge (0.649).

**Consequence for Eden's silence gate.** A fixed cosine floor (the Hindsight 0.3 pattern, A2 §2.1) is the "magnitude" approach these papers show to be fragile. Eden's gate should be a **small logistic model over distribution and evidence features**, fit on Eden's own labelled cues (silence set + gold set + `used`/`ignored` labels from A4 §8):
- rarest matched token df; count of *distinct* cue sources agreeing (prompt, context vector, learned edge, trigger); keyed-slot hit (bool);
- top-1 score, top-1 − top-2 gap, top-1 / mean-of-top-10 (a Clarity-like peakedness);
- whether the top candidate was already delivered this epoch;
- prompt surface features: length, question vs imperative, is-acknowledgement ("ok", "thanks", "go on").

This is ~20 floats and one dot product: microseconds. It is also *deterministic*, which the long-horizon tests need. Target: operate at silence precision 1.0 on the silence set and maximize gold recall subject to that (the doc's G3).

### 2.7 Cross-encoder reranking on CPU

**Cost.** `cross-encoder/ms-marco-MiniLM-L6-v2` (23M params) reaches NDCG@10 74.30 on TREC DL19 vs 71.01 for L2; published throughput is 1,800 docs/s **on a V100 GPU** (L2 ~9,000) [V: model card]. No primary CPU number was found. Rough CPU estimate for short (≤ 128-token) pairs with int8 ONNX: low single-digit ms per pair, so ~30–100 ms for 20–30 candidates, **plus** 100–300 ms runtime/weights load in a fresh process [U — estimate, measure locally]. ConvMemory (Pan 2026, arXiv:2605.28062) distils a cross-encoder into a 3.6M-param reranker over fused dense+lexical features, 12–47× lower latency than BGE-large CE within 0.025 Recall@10 [V-abs; single-author, unaudited].

**Fit for Eden.**
- **Not in a fresh Submit process.** Load time alone blows the 150 ms budget.
- **In a warm daemon**, reranking ≤ 20 already-gated candidates is affordable (tens of ms). But a cross-encoder answers "how relevant is this passage to this query", which has the same magnitude-calibration problem as §2.6 and does not know what is already in context. Use its score as **one feature** of the gate model, not as the gate.
- **At sleep and Stop-prefetch**, a cross-encoder (or the sleep LLM) is the right tool for filtering doc2query cues (§2.2) and for scoring the precomputed candidate set (§4).

### 2.8 Section verdict

| Mechanism | Verdict for Eden | Where |
|---|---|---|
| Doc-side expansion (SPLADE-doc / doc2query / LLM cues) | **ADOPT** as the main answer to vocabulary mismatch; filtered (doc2query--) and weak-weighted | sleep |
| Query-side expansion / HyDE on hot path | **REJECT** (latency, silence, lock) | — |
| HyDE on predicted next turn | **EXPERIMENT** as part of Stop-prefetch (§4) | Stop (async) |
| RRF | **ADOPT for ranking only**; agreement across sources is gate evidence | Submit |
| Retrieval-necessity (Self-RAG, FLARE, SKR) | **Does not transfer** (private facts; no model internals) | — |
| Distribution-shape abstention (QPP) | **ADOPT**: small logistic gate over score-shape + agreement + surface features | Submit; fit at sleep |
| Cross-encoder rerank | Daemon-only feature; sleep/Stop filter | daemon, sleep |

## 3. Code-specific cues

**Framing.** In a coding session the prompt that shares no words with the memory almost always shares a **place** or an **event** with it: the file being edited, the command about to run, the error just printed, the test that failed. Those are cheap, exact, distinctive (Berntsen §1.4) and focal (§1.5). Code structure is the best "no shared words" bridge Eden has, and none of it needs a model at query time.

A second framing point: Eden's payload is **non-derivable knowledge** (decisions, preferences, gotchas, past failures and their fixes, how-tos that live in nobody's README). Code *content* the agent can grep for itself; Claude Code's team found agentic grep/glob beat a local RAG index "by a lot" (Cherny, public statements on X and in interviews) [V-abs: X post and Pragmatic Engineer interview listed; not opened in full]. So in Eden, code structure is the **index into** memory, not the memory.

### 3.1 How the products gather context (what transfers)

| Product | Mechanism | Trigger kind | Transfer to Eden |
|---|---|---|---|
| **Claude Code** | No index; model-driven Glob/Grep/Read. Early RAG + local vector DB dropped | Agent-initiated | Eden must be *automatic*; the agent will not search memory voluntarily (cue-anchored paper: 0 memory calls in 114 turns, §3.7) |
| **Cursor rules** | Always / *Apply Intelligently* (agent reads description) / *Apply to Specific Files* via globs when "a matching file is in context" / manual `@` [V: cursor.com/docs/context/rules] | Path glob; description | Glob triggers = path cues; "description only" = pointer bullet (A3 §3.13) |
| **Windsurf / Devin Desktop Cascade** | Rules: always_on / model_decision ("only the description is shown … reads the full rule when it decides it is relevant") / glob ("applied when Cascade **reads or edits** a file matching") / manual. Auto memories "retrieved when [Cascade] believes they're relevant", stored locally [V: docs.devin.ai/desktop/cascade/memories] | Tool event on file; model judgement | Glob-on-read/edit = **PostToolBatch path trigger** (R0 F10). Model-judged memories are the opposite of Eden's deterministic gate |
| **GitHub Copilot** | "Neighboring tabs": snippets from other open files, **+5% relative acceptance**; FIM +10% [V: GitHub blog]. Jaccard over 60-line sliding windows [V-abs: third-party reverse engineering, not the blog] | Lexical similarity to cursor context | Cheap lexical similarity over *recent context* (≈ the TCM context vector) is a proven production signal |
| **Sourcegraph Cody** | Multiple complementary retrievers (keyword, search, code graph, embeddings historically), then a **pointwise relevance ranker with a threshold or token budget**; moved off OpenAI embeddings to native search for scale and privacy [V-abs: arXiv:2408.05344; blog] | Query + editor state | Two-stage "generate from several sources → pointwise gate" is the architecture Eden should copy (§7) |
| **Aider repo map** | tree-sitter defs/refs → file graph → **personalized PageRank**. In source: edge weight ×10 if the identifier is mentioned in chat, ×10 for long snake/camel identifiers, ×0.1 for `_private` and for identifiers defined in > 5 files, ×50 if the referencing file is in the chat, `sqrt(num_refs)`; personalization mass 100/N on chat files, mentioned files, and files whose path components match mentioned identifiers [V: `aider/repomap.py` read] | Chat files + mentioned identifiers | A ready-made, tested formula for spreading activation over a code graph, with fan penalties (×0.1 if > 5 definers) that are ACT-R's `ln fan` in integer form |
| **Augment** | Real-time embedding index of workspace **and commit history** ("Context Lineage"), claimed < 200 ms added latency [V-abs: vendor pages] | Semantic | Commit history is a first-class context source (§3.4) |
| **Continue** | Historically embeddings + full-text + optional reranker for `@codebase` [U: docs URL 404'd] | Query | — |

The pattern across the successful products: **deterministic, path/event-anchored triggers for rules and conventions; model or similarity judgement only for ranking or for the agent's own voluntary search.** Nobody silently injects on pure semantic similarity.

### 3.2 Path proximity

- **Signal.** The paths the agent touched in the last few tool calls (PostToolUse/PostToolBatch `tool_input.file_path`, Grep/Glob `path`, Bash `cwd`; R0 F9) versus each memory's anchor paths (paths mentioned in the memory, paths touched in its encoding episode).
- **Score.** Tree distance: same file 1.0, same directory 0.7, same scope 0.4, ancestor scope 0.2, sibling scope 0 (hard, A4 §2.4).
- **Where.** Anchors at write/sleep; distance at Submit and PostToolBatch (a string prefix compare).
- **Failure modes.** Renames (sleep follows `git log --follow` / manifest name, A4 §2.1); generic files (`package.json`, `README.md`, `index.ts`) that everything touches. Treat anchor files by *fan*: an anchor shared by > 20 memories is weak.

### 3.3 Symbol and import graphs

- **Signal.** Identifiers in the prompt and in tool inputs (Grep patterns, Edit `old_string`), mapped to their defining files; import edges between files.
- **Mechanism.** Build at sleep with tree-sitter (defs/refs, imports) — the Aider recipe. Then for each memory anchored to file A, precompute its **neighbour set** N(A): the top-k files by personalized PageRank seeded at A. At query time a touch on B ∈ N(A) adds weak evidence for A's memories.
- **Cost.** Sleep only. tree-sitter over a 5k-file repo is seconds [U]. Store ≤ 20 neighbours per anchor.
- **Fit.** Medium. It helps "memories about module X surface when working on a caller of X". It is also a classic source of related-but-irrelevant neighbours (The Power of Noise, arXiv:2401.14887 [V-abs]: distracting high-scoring passages hurt; interestingly *random* ones did not). So graph evidence must be **weak, additive, never a trigger**.
- **Language coverage.** tree-sitter grammars for the major languages; fall back to a regex identifier extractor elsewhere.

### 3.4 Co-change (evolutionary coupling) from git history

- **Mechanism.** ROSE (Zimmermann, Weißgerber, Diehl & Zeller, ICSE 2004 / TSE 2005) mines association rules "programmers who changed these also changed …" from version history. Its top-3 suggestions contained a correct location > 70% of the time across eight projects, and it finds couplings "undetectable by program analysis" [V-abs]. Evolutionary coupling has also been used to link tests to code (arXiv:2203.11343 [U: title only]).
- **Eden form.** At sleep: `git log --name-only -n 2000` (local only, nothing leaves the machine) → for file pairs, support = co-commits and confidence = P(B | A). Keep pairs with support ≥ 3 and confidence ≥ 0.3. Memories anchored to A get a weak edge from B.
- **Why it matters for "no shared words".** Co-change captures *non-lexical, non-structural* coupling: the migration file and the ORM schema, the API route and its client hook, the config and the CI yaml. That is exactly where "you forgot to also update X" memories live.
- **Cost.** Seconds at sleep for thousands of commits. Zero hot-path cost beyond a lookup.
- **Failure modes.** Mass commits (formatting, renames, dependency bumps) create spurious pairs; skip commits touching > 30 files. New repos have no history.

### 3.5 Error signatures

- **Signal.** Bash/tool output with a non-zero exit code, captured at PostToolUse/PostToolBatch (R0 F9, F10).
- **Normalization** (the crash-bucketing literature: ReBucket, TraceSim arXiv:2009.12590 [V-abs via search]: frame trimming and tokenization, weighting top frames, TF-IDF on frames):
  1. Extract the error class/code line: `ERR_[A-Z_]+`, `TS\d{4}`, `E\d{4}`, `[A-Z][a-zA-Z]+Error:`, `exit code \d+`, Python `^\w+Error`, Rust `error\[E\d+\]`.
  2. Strip volatile parts: absolute paths → repo-relative; line/column numbers; hex addresses; UUIDs; timestamps; ports; numbers inside quotes.
  3. Keep the top ≤ 3 in-repo stack frames as `file:function`.
  4. `sig = hash(code + normalized message + top frames)`, plus the raw tokens for fuzzy match.
- **Eden use.** A failure→success episode (A4 §6.2) is stored with its `sig`. When the same `sig` (or the same code + a top frame) appears again, the resolution episode is the single most valuable memory Eden can deliver, and it should arrive **at PostToolBatch, mid-turn**, not wait for the user's next prompt. The prompt ("still broken, try again") shares no words with it; the tool output does.
- **Fit.** Very high precision; exact match; cheap. The best first code-cue to build.

### 3.6 Test-name linking

- **Mechanism.** Naming conventions (`login.test.ts` ↔ `login.ts`; `test_parse_config` ↔ `parse_config`). TCTracer (White & Krinke, ICSE 2020; EMSE 2022) combines static and dynamic techniques; test-to-function MAP 78–85%, test-class-to-class MAP 92–93% [V-abs].
- **Eden form.** The static naming-convention part only, at sleep: map test files to their subject files and include both in each other's anchor neighbourhoods. Flaky-test memories anchored to a test file then fire when the agent edits the code under test, and vice versa.

### 3.7 The cue-anchored memory paper (arXiv:2607.20972) — verified

**It exists.** Swapnanil Saha, *"Delivery, Not Storage: Cue-Anchored Working Memory as a Harness Property for Coding Agents"*, arXiv:2607.20972, 23 July 2026 [V: abstract and HTML opened].

**What it says.**
- Two memory tiers: deliberate storage (instruction files, artifacts the agent authors) and **situationally-bound operational facts** that should surface automatically.
- Memories carry **first-class trigger conditions** over a composable vocabulary:
  - *path* (glob over touched files);
  - *symbol* ("requires a code symbol graph");
  - *semantic* ("similarity of current activity above a floor");
  - *event* (session start, prompt submit, pre-edit, pre-run, pre-compaction, post-compaction);
  - *temporal* (not-before, cooldown).
  - "Conjunction within a trigger, disjunction across triggers."
- Evaluation is harness-side: "No model judgment sits in the delivery path". A per-session **fire ledger** deduplicates and resets at compaction. Injected notes carry provenance framing ("recorded by an AI session … verify") and a staleness warning when the anchored file changed.
- **Results** (small n): voluntary memory — **0 memory calls in 114 turns** despite seeded facts and tools; 12/12 graded runs passed with injection introducing no failures; "39% of intra-session re-reads re-retrieve content the session had already paid for before a compaction boundary"; ten facts delivered intact across 138 forced compactions (139 audited deliveries).

**Limitations the author states:** symbol and temporal triggers were implemented but **never fired** in graded runs; facts were harness-seeded (capture unevaluated); n = 2–3 per arm; one corpus (Apache Camel); no trigger-precision numbers; the semantic trigger's model and floor are unspecified.

**What it means for Eden.** It independently converges on A4's ledger and compaction handling, and on path/event triggers. It **does not** answer Eden's question (how the right memory arrives with no shared words, *without* false injects): its semantic trigger is an unspecified similarity floor and it publishes no silence/precision numbers. Treat it as design corroboration, not as evidence of recall or precision.

### 3.8 Section verdict

| Code cue | Precision | Recall gain on "no shared words" | Cost | Build order |
|---|---|---|---|---|
| Error signature → resolution episode (PostToolBatch) | very high | high for debugging loops | hot: regex + hash | **1st** |
| Path anchors + proximity (Submit + PostToolBatch) | high | high (bare prompts after tool use) | hot: prefix compare | **1st** |
| Command-head triggers for procedures (`pnpm test`, `prisma migrate`) | high | medium | hot: token match | 2nd |
| Co-change edges from git | medium | medium, unique (non-lexical coupling) | sleep: seconds | 3rd |
| Test ↔ code naming links | high | low–medium | sleep | 3rd |
| Symbol / import graph neighbours (Aider-style PPR) | medium–low | medium | sleep: tree-sitter | 4th, experiment |
| Branch-name tokens | low | low | hot: trivial | boost only (A3 §3.5) |

## 4. Anticipatory / speculative retrieval

### 4.1 Evidence

- **Sleep-time compute** (Lin, Snell, Wang, Packer, Wooders, Stoica & Gonzalez 2025, arXiv:2504.13171) [V-abs]: letting a model "think" offline about a context before the query arrives cuts test-time compute ~5× at equal accuracy on Stateful GSM-Symbolic / AIME, adds up to 13–18% accuracy when scaled, and cuts average cost per query 2.5× when amortized over related queries. Crucially: **"query predictability is well correlated with the efficacy of sleep-time compute."** It includes an agentic SWE application.
- **SpecAgent** (Ma et al., Amazon, arXiv:2510.17925, rev. Apr 2026) [V-abs]: at *indexing* time an agent explores the repo and builds speculative context for likely future edits; at inference it only retrieves the precomputed context. +9–11 points absolute (48–58% relative) on code completion over the best baselines, with lower inference latency. It also warns that existing benchmarks suffer **"future context leakage"**, which inflates such results. Eden's harness must guard against the same thing: a prefetch must never be computed from the turn it is scored on.
- **FLARE** (§2.6) is the within-generation version: predict the upcoming sentence and use it as the query.
- **Proactive Agent / ProactiveBench** (Lu et al. 2024, arXiv:2410.12361) [V-abs]: predicting what help a user needs next from activity is **hard**. The best fine-tuned model reaches F1 = 66.47% at deciding to offer help. So roughly one in three proactive offers is wrong or missed. Predictions are good *candidate generators* and bad *triggers*.
- **Letta sleep-time agents / context repositories** [V-abs: docs and blog, Feb 2026]: a background agent rewrites shared memory blocks between turns; Letta Code's "memory reflection" periodically persists important information into a git-versioned memory repo. That is consolidation, not per-turn prediction.

### 4.2 Design: "predict wide at Stop, confirm narrow at Submit"

```
Stop (async hook, prints nothing — R0 F19)        Submit / PostToolBatch (hot path)
───────────────────────────────────────────        ─────────────────────────────────
inputs: last_assistant_message (R0 F8/F18),        read prefetch.json (≤ 8 KB) if
        context vector c, open errors,             prefetch.turn == turn-1, else ignore
        current task, last tool events
tier 0 (no LLM, ≤ 50 ms):                          candidates = fresh(prompt ⊕ c)
  run Eden retrieval with cue = assistant msg       ∪ prefetch.P
  ⊕ c ⊕ errors ⊕ task → P0 (≤ 30 ids)             gate: a prefetch item is admitted
tier 1 (optional LLM, consented, 1–3 s):              only if the ACTUAL prompt or the
  "list ≤ 5 likely next requests + search terms"     actual next tool event supplies
  → retrieve per prediction → LLM relevance         confirming evidence (§7.4), or the
  judgement → P1 with per-item confirm_tokens       prompt is a continuation ("yes",
write prefetch.json {turn, P, confirm_tokens}       "go ahead") of the proposal P came from
```

The Submit hook **never** injects a prefetched item on the prediction alone. The prediction only (a) widens the candidate set with items the prompt's words would not have reached, and (b) supplies per-item `confirm_tokens` so the confirmation test is a set intersection.

### 4.3 The cheap version wins most of the value

The single highest-value "prediction" is not an LLM prediction at all. It is **the agent's own last message**. In coding sessions the assistant usually ends a turn by proposing the next step ("Next I'll run the migration and update the seed script — want me to proceed?"), and the user replies "yes", "do it", "go ahead", "ok and the tests too". Those replies share no words with anything; the assistant message shares all of them. Today `isNoopCue` sends these to silence.

So tier 0 is:
- Persist the rare tokens of `last_assistant_message` at Stop into `delivery.json` (the transcript may lag, R0 F8).
- At Submit, if the prompt is short or a continuation, use the assistant message as the main cue component (§5.2).
- No LLM, no privacy change, microseconds on the hot path.

Tier 1 (LLM prediction) earns its cost only where the next turn is predictable *and* not already implied by the assistant's message: after a plan (ExitPlanMode `tool_response.plan`), after a task list is created (`TaskCreated.task_subject`), at a failing-test loop. Measure first (§8).

### 4.4 Cost, latency, benefit

| | Tier 0 (assistant-msg + context) | Tier 1 (LLM prediction) |
|---|---|---|
| Hot-path cost | ~0 (reads a small JSON) | ~0 (reads a small JSON) |
| Off-path cost | ≤ 50 ms at Stop | one small-model call per turn, ~1–3 s async; ~$0.001–0.003 per turn with a Haiku-class model [U: price estimate]; ~$0.3–1 per 300-turn session |
| Privacy | none new | sends the assistant message, task and error text to the model provider → **same consent gate as sleep LLM** (§7.7) |
| Benefit ceiling | continuation prompts, "do the same for X", "now fix the tests" | predictable multi-step plans; bounded by predictability (sleep-time compute paper) |
| Race | none | the user can reply before tier 1 finishes. `prefetch.turn` must equal `turn−1`; otherwise ignore and fall back to fresh retrieval |

### 4.5 Failure modes

| Failure | Consequence under this design | Why it is safe (or not) |
|---|---|---|
| Prediction wrong | P holds irrelevant items; none is confirmed by the real prompt; **nothing extra is injected** | Confirmation required (§7.4) |
| Prediction right, confirmation too strict | A miss, same as today | Tune on the `restate` log |
| Continuation prompt, but the user changed course ("yes but first fix CI") | The prompt's own rare tokens (`CI`) outweigh the assistant-message component (weights §5.2) | Normalized source mass |
| Stale prefetch across compaction | Items reference pre-compaction state | Epoch mismatch → drop prefetch |
| Future leakage in benchmarks | Inflated recall (SpecAgent warning) | Harness computes the prefetch strictly from turns < t |
| Prefetch writes a memory | Predictions pollute the store | Prefetch output is **never** encoded as a memory; it is a cache |

## 5. Conversation-state cues

### 5.1 Components, sources, and what each is good for

All of these come from hook payloads Eden already receives (R0 F8–F13, F18) or from one cheap read. None needs the transcript on the hot path.

| Component | Source (hook) | Distinctive? | Good for | Risk |
|---|---|---|---|---|
| **Prompt rare tokens** | UserPromptSubmit `prompt` | yes | explicit asks | the "no shared words" case |
| **Previous assistant message** | Stop `last_assistant_message` → `delivery.json` | yes (it names files, commands, next steps) | continuation prompts ("yes", "do it") | the user changes course |
| **Recent tool events** (paths, command heads) | PostToolUse / PostToolBatch `tool_input` | yes | bare prompts after tool use; place | generic files |
| **Open errors** (unresolved failing commands, error signatures) | PostToolUseFailure `error` (first line `Exit code N`) + PostToolUse exit codes | very | debugging loops; failure→resolution recall | noisy logs; normalize (§3.5) |
| **Current task / goal** | `TaskCreated.task_subject` / `task_description`; ExitPlanMode `tool_response.plan`; a TodoWrite-style tool's input where present | medium | the "why" behind a bare prompt | stale after the task completes (`TaskCompleted`) |
| **Scope** | derived from paths (A4 §2) | — | hard filter | — |
| **Branch name** | git HEAD at SessionStart / CwdChanged, not per Submit | weak | feature-branch episodes | fragmenting facts by short-lived branches (A3 §3.5) → boost only |

### 5.2 Weighting: a TCM context vector with per-source mass limits

Keep one sparse vector `c` (token → weight, ≤ 64 entries) in `delivery.json`:

```
on every event e (PostToolBatch, PostToolUseFailure, Stop, Submit):
    c ← ρ_e · c + β_e · normalize(rare_tokens(e))        # TCM update, §1.2
    prune to top 64
ρ: 0.7 per tool batch, 0.5 per user turn   (a user turn is a bigger context shift)
β: prompt 1.0 · error 0.9 · paths/commands 0.6 · assistant msg 0.5 · task 0.4 · branch 0.1
```

At Submit, the cue has three separately-scored parts:

```
q_prompt  = rare tokens of the prompt                             (weight W_p)
q_prev    = rare tokens of the previous assistant message         (weight W_a)
q_ctx     = c                                                     (weight W_c)
W_p + W_a + W_c = 1     # ACT-R's limited source activation (§1.3)

default:                W_p 0.6  W_a 0.15 W_c 0.25
short / continuation:   W_p 0.2  W_a 0.5  W_c 0.3     # "yes", "go ahead", ≤ 4 content tokens
acknowledgement-only:   silence unless an open error or intent trigger fires  # "thanks", "ok"
```

Each candidate's relevance is computed **per part** (BM25F against the memory's content fields for `q_prompt`; against content **and** `enc_cues` for `q_prev` and `q_ctx`), and the gate sees the per-part scores, not only their sum (§7.4). This is what keeps a long, busy context from making everything look relevant.

**Why normalize.** Without the `W` budget, every added context token raises every memory's score, which lowers silence precision as the session grows. That is the same bug as the "fat postings" failure in the long-horizon bench, moved from the store to the cue.

### 5.3 Failure modes

- **Topic switch.** Handled by the large β and W_p for a prompt with its own rare tokens, and by the rule that context alone never triggers (§7.4).
- **Assistant echo.** The previous assistant message may contain things *Eden itself* injected. Strip tokens of bullets delivered in the last turn from `q_prev` before scoring, or every delivered memory re-cues itself (a feedback loop). The ledger would drop the repeat anyway, but the echo would still crowd the candidate budget.
- **Tool-output poisoning.** Tool output is untrusted (A6). It may *cue* retrieval (read-only) but may never *create* memories on its own (A4 §3.1). Cueing from hostile text can at worst surface one of the user's own memories, which is benign.
- **Subagents.** Keep a separate `c` per `agent_id` (R0 F13). A subagent's context should not drift the parent's.

## 6. Intent/slot classification and learned associations

### 6.1 Two cheap classifiers on the hot path

**(a) Turn mode** (7 classes): `ack` ("thanks", "ok"), `continuation` ("yes", "go ahead", "do the same for X"), `project-question`, `task-imperative`, `debug` (error text, "still failing"), `how-to` ("how do I run…"), `meta/chitchat`. The mode selects the cue weights (§5.2) and the lanes (debug → error episodes; how-to → procedures; ack → silence unless an error or intent trigger fires). This is Adaptive-RAG's idea (§2.6) — a small classifier routes retrieval — applied to *how* to cue, not *whether* the model knows the answer.

**(b) Slot detector**: `P(slot | prompt ⊕ q_prev)` over the closed predicate vocabulary (A2 §2.6: package manager, test command, auth, db, deploy, ci, env/secrets, formatter, node version, …). A slot hit goes straight to the keyed `live(scope, slot)` lookup (A4 step 3a). This is the safest "no shared words" path Eden has: the answer is one current value, validity is already tracked, and it is exactly where restatements concentrate ("we use pnpm", "tests run with vitest").

**Model.** A fastText-style linear model (Joulin et al. 2016, arXiv:1607.01759 [V-abs]): hashed unigrams + bigrams + character trigrams → a few thousand weights per class, a dot product at Submit (microseconds, a few hundred KB, loads in < 1 ms). Trained at sleep on Eden's own labels:
- positives: cue → slot of a memory that was `used` (A4 §8), and cue → slot of every `restate` repair (A4 §7);
- negatives: the silence set and `ignored` deliveries;
- a seed lexicon per slot for cold start (`install`, `deps`, `lockfile`, `add package` → package_manager; `test`, `spec`, `jest`, `vitest`, `flaky` → test_command; `login`, `session`, `token`, `oauth`, `sso`, `callback` → auth).

**Calibration.** Choose each slot's threshold so the silence set produces zero slot hits (silence precision 1.0), then maximize restate-fix recall. Keep thresholds per slot; slots differ a lot in how generic their words are (`test` vs `prisma`).

**Failure modes.**
- Cold start: seed lexicon only → high precision, low recall. Acceptable.
- Drift: new slots appear (a repo adopts Temporal, Kafka). Sleep proposes new slots from clusters of restated copulas with an unknown predicate; the user never sees this.
- Over-triggering on generic words: `test` in "test this idea" is not the test command. Mitigation: the slot hit also needs the slot to *have a live value in scope* and not be delivered this epoch; and mode ≠ `meta`.

### 6.2 Query rewriting without an LLM on the hot path

| Technique | Side | Verdict |
|---|---|---|
| Identifier splitting (camelCase / snake / kebab / path segments / dotted names) | both | **ADOPT**; cheap and exact; `useAuthRedirect` → `use auth redirect` |
| Character trigrams / FlyHash for morphology (`authentication`↔`auth`) | both | as A3 §3.10: experiment, ship only if it beats trigram Jaccard |
| Abbreviation/synonym table (`db`↔`database`, `k8s`↔`kubernetes`, `pm`↔`package manager`) | **doc side** (aliases on the row) | **ADOPT**; curated seed + learned from restatements; respects the "no cue-time synonym explosion" lock |
| Pseudo-relevance feedback (RM3: expand the query with top-doc terms) | query | **REJECT** on the hot path: it amplifies whatever was top-1, including a wrong top-1, which is exactly the silence failure |
| Slot mapping (§6.1b) | query → key | **ADOPT**; this is query rewriting into a *key*, not into more words |
| Previous-assistant-message substitution for continuations (§4.3) | query | **ADOPT** |

### 6.3 Learned cue → memory association from usage

**Hebbian edge with the ACT-R/PMI weight.** For cue token *j* and memory *i*:

```
S_ji = ln( (n_ij + α) / (n_j + α·K) ) − ln( (n_i + α) / (N + α·K) )     # smoothed PMI
n_ij = sessions in which i was USED (or restated) while j was in the cue (prompt, q_prev or c)
```

Stored as sparse edges on the memory (`learned_cues: {token: S}`, ≤ 16), indexed like aliases. Updated at sleep only.

**Lessons from click models** (Joachims 2002; Joachims, Granka, Pan, Hembrooke & Gay, SIGIR 2005 [V-abs]: "clicks are informative but biased"; relative preferences from clicks are reasonably accurate, absolute judgements are not; Joachims, Swaminathan & Schnabel, WSDM 2017, arXiv:1608.04468 [V-abs]: propensity-weighted unbiased learning-to-rank):
1. **Exposure bias.** Eden only sees `used` for items it delivered. A learner trained only on deliveries reinforces its own choices (the rich-get-richer loop A3 §3.9 warns about). The **unbiased** positive signal Eden has is the **restatement**: the user tells Eden, unprompted, that fact X was needed at cue Y. Weight restatement-derived edges higher than `used`-derived ones.
2. **Position / trust bias.** The first bullet in a packet is more likely to be "used". Use relative preferences (bullet 2 used while bullet 1 ignored → prefer 2 for this cue) rather than absolute counts, and down-weight first-position uses by an estimated propensity.
3. **Counterfactual (shadow) logging instead of exploration.** Search engines explore by randomizing rankings. Eden cannot inject randomly without breaking silence. Instead, log the top-3 *gated-out* candidates per turn (ids only) to `shadow.jsonl`. At sleep, label them post hoc: did the agent later Read the memory's anchor file, run its command, or did the user restate its value within the next 5 turns? That gives labels for items that were never shown, at zero user-visible cost.

**Guardrails.**
- An edge counts toward the **gate** only after it is seen in ≥ 2 distinct sessions. Before that it only ranks.
- Decay edges with the ACT-R base-level form, fitted on Eden's own logs (A2 §2.12b).
- Cap per memory (≤ 16) and per token (fan: a token with edges to > 30 memories is not a cue).
- Assistant-text tokens can join an edge's cue side only through the `q_prev` channel, never as memory content (A4 §3.1 authority ladder).

## 7. Proposed Eden cue architecture

### 7.1 Three principles

1. **Triggers are focal and distinctive; similarity only ranks.** A memory may be *injected* only on distinctive evidence: an identifier, a path, an error signature, a command, a calibrated slot, or two independent medium cues that agree (Berntsen §1.4, PM focality §1.5, ACT-R threshold §1.3, abstention literature §2.6). Semantic or graph similarity may *find* and *order* candidates. It never triggers alone.
2. **Semantics lives on the memory, computed offline.** The "no shared words" bridge is built at encode and sleep, as extra cue fields on each memory: encoding context, filtered generated cues, aliases, learned edges, anchors and compiled triggers. The hot path stays tokenizer + postings + a dot product (IR §2.1–2.3; A2 §2.3).
3. **Prediction widens, evidence confirms.** Stop-time prediction and conversation context add candidates. Only evidence from the *actual* prompt or the *actual* next tool event lets one through (§4.2).

### 7.2 The memory side: cue fields per row

| Field | Content | Written | Evidence class when matched |
|---|---|---|---|
| `subject`, `value`, `body` | the memory itself (BM25F ×2 / ×3 / ×1, A4 §5) | encode | by df: rare identifier (df ≤ 5) **STRONG**; rare token (df ≤ 50) **MEDIUM**; else WEAK |
| `slot` | closed predicate (package_manager, test_command, auth, …) | encode (schema fast path) / sleep | **STRONG** if the slot detector's P ≥ θ_slot |
| `anchors` | repo-relative paths / globs, command heads, error signatures (§3.5), symbols | encode (from the episode's tool events) + sleep | path/cmd/error touched **now**: **STRONG**; touched within the context window: MEDIUM |
| `triggers` | compiled focal rules: `{path_glob, cmd_prefix, error_sig, slot, event}` with conjunction inside, disjunction across (cue-anchored vocabulary, §3.7) | sleep | **STRONG** |
| `enc_cues` | ≤ 16 rare tokens of the encoding context: triggering prompt, previous assistant turn, last ≤ 3 tool events (§1.1) | encode | MEDIUM |
| `learned_cues` | ≤ 16 PMI edges from restatements / `used` / shadow labels (§6.3) | sleep | MEDIUM after ≥ 2 sessions; WEAK before |
| `aliases` | curated abbreviation table + filtered doc2query cues + SPLADE-doc whole-word expansions (§2.1–2.2) | sleep | WEAK (MEDIUM only after the silence-set replay proves it adds hits with 0 false injects, A4 §7) |
| `neighbors` | co-change files, test↔code, import/PPR neighbours of anchors (§3.3–3.6) | sleep | WEAK |
| `episode_links` | TCM contiguity: same-episode memories (§1.2) | sleep | WEAK |

(An embedding vector for rows, if the parallel bench justifies it, is one more **WEAK or MEDIUM** field, computed at sleep; see §7.8.)

### 7.3 The query side: where each signal is computed

| Where | Budget | Computes | Writes |
|---|---|---|---|
| **Encode** (Submit tail, Stop, PostToolBatch) | inside hook budget | `enc_cues`, `anchors` from the current episode; error signature on failure→success | memory rows |
| **PostToolBatch** (R0 F10, F11) | ≤ 50 ms (blocks the next model call) | update context vector `c`; `last_paths`; error signatures from failures; **mid-turn delivery** on STRONG path/error/command triggers only | `delivery.json` |
| **PostToolUseFailure** | ≤ 50 ms | error signature → resolution episode lookup → deliver next to the error (R0: `additionalContext` "alongside the error") | ledger |
| **PreToolUse** with `if` filters (optional) | spawns only on match | compiled `cmd_prefix` triggers ("before `prisma migrate` …"). The `if` field means the hook process is **never spawned** for non-matching commands | ledger |
| **Stop tier 0** (async, prints nothing) | ≤ 100 ms, off path | persist rare tokens of `last_assistant_message`; tier-0 prefetch P0 | `delivery.json`, `prefetch.json` |
| **Stop tier 1** (async, opt-in LLM) | 1–3 s, off path | predicted next requests → P1 with `confirm_tokens` | `prefetch.json` |
| **Submit** (hot path) | **150 ms total** | turn mode + slot classifiers; cue parts `q_prompt`, `q_prev`, `c`; candidate generation; gate; novelty; shape | packet, ledger |
| **Sleep** (detached; may use LLM) | minutes | triggers, aliases, doc2query--, learned edges, classifiers, gate model fit, co-change, test links, symbol graph, shadow labelling | rows, postings, models |
| **Daemon** (optional, warm) | ≤ 30 ms RPC | holds postings/models in memory; can add a query embedding or cross-encoder score as **features** | nothing new |

### 7.4 Candidate generation and the silence gate

```
Submit(prompt):
  mode  = turn_mode(prompt)                                    # §6.1a
  if mode == ack and no open error and no intent trigger: return silence
  W     = weights(mode)                                        # §5.2
  cands = keyed(slot_detector(prompt ⊕ q_prev), scope)         # STRONG path
        ∪ triggers(prompt tokens, last_paths, open errors)     # STRONG path
        ∪ postings(q_prompt)  rarest-first, newest-64 on fat terms, |C| ≤ 200   # A2 §2.2
        ∪ postings(q_prev)    over content + enc_cues + learned_cues
        ∪ postings(top-16 of c) over enc_cues + anchors
        ∪ prefetch.P  (if prefetch.turn == turn−1 and epoch matches)
  for each candidate: evidence = {class, source} per match; features for the gate
  validity  (A4 step 4)        → drop superseded / invalid / stale_for / suspect / sibling / failed citation
  gate:
    admit if  any STRONG
          or  ≥ 2 MEDIUM from different sources   (prompt, q_prev, c, learned, prefetch-confirmed)
          or  1 MEDIUM and gate_model(features) ≥ θ     # θ fit for silence precision 1.0
    WEAK evidence never admits; it only adds to rank
  novelty   (A4 step 6)        → ledger · residual(prompt ⊕ q_prev ⊕ last 64 KB) · shadow set
  rank      RRF over sources for order; BM25F + priors as tiebreak   # §2.5
  shape     (A4 steps 7–8)     → ≤ 4 soft / 6 hard; pointer bullets for partial matches (§1.6)
```

**Gate model features** (logistic, ~20 floats, fit at sleep on the silence set + gold set + `used`/`ignored` + shadow labels): per-source best score; number of agreeing sources; min df of matched tokens; top-1 − top-2 gap; top-1 / mean top-10; slot probability; turn mode; prompt length; already-delivered flag; activation (A2 §2.12b). **In v1 the model may only veto** rule admissions. Once ≥ 500 labelled turns exist and it holds silence precision 1.0 on held-out data, it may also admit single-MEDIUM candidates.

**PostToolBatch / PostToolUseFailure gate** is stricter: STRONG only, ≤ 2 bullets, and never an item whose `cid` is in the ledger for this epoch. Mid-turn text costs tokens the agent did not ask for.

### 7.5 The six explicit constraints

**Silence precision.**
- Evidence classes: WEAK sources (aliases, context, graph, prefetch, similarity) can never admit on their own.
- Source-mass normalization (§5.2): a long session does not raise every score.
- `ack` turns are silent unless an error or intent trigger fires.
- Every generated cue (doc2query, SPLADE expansion, learned edge) passes a silence-set replay before it gains MEDIUM status (doc2query-- §2.2, A4 §7).
- The gate is calibrated on distribution shape, not raw magnitude (§2.6).
- Target: silence precision 1.0 on the A5 silence set, measured per delivery point.

**Redundancy with context.**
- One ledger (A4 §4) across **all** delivery points, keyed by `cid`: SessionStart, Submit, PostToolBatch, PostToolUseFailure, PreToolUse.
- The residual check covers `q_prev` too: if the assistant just said it, it is in context.
- Shadow set from `InstructionsLoaded` (R0 F16), so facts already stated in a loaded CLAUDE.md / rule never inject.
- Strip Eden's own delivered tokens from `q_prev` (echo loop, §5.3).
- After compaction, re-arm selectively from `compact_summary` (R0 F14).
- Prefetch is a cache of **ids**, never of rendered text.

**Staleness.**
- Triggers, prefetch, learned edges and `enc_cues` all point to `cid`s. The **value** is resolved against `live` at delivery time and passes the full validity step. No value is ever cached on the cue side.
- `FileChanged` on anchored files (R0 F21) marks anchored memories for citation recheck.
- Prefetch older than one turn or from another epoch is ignored.
- Learned edges decay; a superseded memory's edges transfer to its successor only if the subject is unchanged.

**Latency (150 ms hot path).** Rough budget for a fresh Bun process (A2 §1 measures process start; the rest are estimates to verify):

| Step | Budget |
|---|---|
| process start + imports | ≤ 40 ms (measured class, A2 §1) |
| open store, read `delivery.json` + `prefetch.json` | ≤ 10 ms |
| tokenize, split identifiers, two linear classifiers | ≤ 2 ms |
| postings for three cue parts, |C| ≤ 200 | ≤ 20 ms (SQLite, newest-64 on fat terms: 0.1–0.3 ms per term, A2 §1) |
| validity, BM25F, gate, novelty (seek-from-end 64 KB) | ≤ 15 ms |
| emit + ledger write | ≤ 5 ms |
| **headroom** | **~60 ms** |

Everything expensive (LLM, SPLADE, cross-encoder, graphs, PMI, gate fitting) is at sleep or Stop. PostToolBatch has the same process cost but a smaller body, target ≤ 50 ms. The daemon is an optimization, not a dependency.

**Fail-open.** Every new component is optional and independently skippable: no `prefetch.json` → no prefetch; no classifier file → seed lexicon; no `c` → prompt-only; daemon socket not answering in 5 ms → in-process path; any exception → `{}`. The budget timer aborts to `{}` (A2 §2.8). PostToolBatch/PreToolUse hooks never return a `decision`.

**Privacy (sending code to an LLM at sleep).**
- **Local by default.** Everything in §3 (co-change, error signatures, test links, symbol graph), the classifiers, PMI edges, the gate model and the context vector are computed locally with no model. That is most of the value.
- **LLM uses are opt-in per repo**, and ranked by exposure:
  1. doc2query cues for memory rows (sends already-scrubbed memory rows, not files) — lowest exposure, highest value;
  2. contradiction pass (A4 P5.3);
  3. Stop tier-1 prediction (sends the assistant's last message, task and error text) — highest exposure per unit of value.
- Scrub first (A6 `sanitizeForStore`), then send. Never send whole files or diffs. Paths may be sent as repo-relative strings; offer hashing for sensitive repos.
- Provide a **local-model path** (a small instruct model via llama.cpp/Ollama) for doc2query; quality is lower but sufficient for a filtered expansion, because the silence filter catches bad cues.
- Record per row which model generated which alias (`src=sleep`, model id), so a user can purge everything a provider saw.

### 7.6 Worked example (the "no shared words" cases)

| Turn | Prompt | Shares words with memory? | What fires | Evidence |
|---|---|---|---|---|
| 1 | "why does login redirect twice?" | yes | keyed `auth` slot → `provider = Clerk`; episode about `redirect_url` | STRONG (slot) |
| 2 | *(agent runs `pnpm test apps/web`, it fails with `ERR_REQUIRE_ESM`)* | — | PostToolUseFailure: error signature matches a failure→success episode ("fixed by `"type":"module"` in vitest config, 2026-08-12") → delivered next to the error | STRONG (error sig) |
| 3 | "yes do that" | **no** | turn mode `continuation` → `q_prev` = the assistant's proposal ("update vitest.config.ts to ESM") → learned edge `vitest.config` → memory "vitest config must stay .mts because of the Storybook plugin" | MEDIUM (q_prev) + MEDIUM (learned edge) = 2 sources |
| 4 | "ok now the same for the cli" | **no** | scope → `packages/cli` (the prompt names the scope's manifest name, `cli`); `c` still holds `vitest`, `ESM`; cli-scoped memory "cli uses node:test, not vitest" matches `enc_cues` via `c` and the `test_command` slot via `q_prev` | STRONG (slot, cli scope override) |
| 5 | "thanks" | no | `ack` → silence | — |
| 6 | *(agent first Reads `packages/db/prisma/schema.prisma`)* | — | PostToolBatch: path trigger on the procedure "back up the dev db before `prisma migrate`" | STRONG (path trigger), delivered once per epoch |

### 7.7 What this architecture deliberately does not do

- No query-side synonym expansion or PRF on the hot path.
- No model judgement in the delivery path (the cue-anchored paper's rule, §3.7). Models run offline and leave behind data: aliases, triggers, weights.
- No `memory_search` tool loop (A4 non-goal). The agent will not call it anyway (0 calls in 114 turns, §3.7).
- No injection from prediction alone.

### 7.8 Where embeddings fit, whatever the parallel bench finds

The design has a slot for them that does not break silence:
- **Doc side at sleep:** embed rows; use nearest-neighbour vocabulary from the user's own past cues to propose aliases (A2 §2.3 b). They are then filtered like any generated cue.
- **Query side, daemon only:** cosine as a **feature** of the gate model and a **WEAK** candidate source. It becomes MEDIUM only if the bench shows that, at silence precision 1.0, it adds gold recall that `enc_cues` + `q_prev` + slots + learned edges do not already cover.
- The L6 reopen rule (A4 §9: > 10% of logged misses are paraphrase misses that aliases failed to fix) stays the decision rule. The "no shared words" categories below make it measurable.

## 8. Build order with expected impact

### 8.1 First, measure the problem by category

Before building, split "prompt shares no words with the gold memory" into categories. Each category has a different fix, and the embedding bench only addresses one of them. Build the set from (a) A5 harness fixtures written for each category, and (b) Eden's own `restate` log once P4.1 lands (restatements are the real-world "no shared words" misses).

| Category | Example | Mechanism that should fix it |
|---|---|---|
| C1 continuation | "yes do it" after a proposal | `q_prev` (§4.3) |
| C2 place-only | bare prompt after editing a file | anchors + `c` + PostToolBatch (§3.2, §5.2) |
| C3 event-only | the agent hits an error it has hit before | error signature (§3.5) |
| C4 slot synonym | "install deps" ↔ package_manager = pnpm | slot detector + aliases (§6.1) |
| C5 encoding-context | "set up the db" ↔ memory written after `docker compose up pg` failed | `enc_cues` (§1.1) |
| C6 cross-file coupling | editing the API route ↔ memory about the client hook | co-change / graph (§3.4) |
| C7 true paraphrase | "why is sign-in slow" ↔ "Clerk session fetch adds 400 ms" | doc2query-- aliases; embeddings (bench) |

Report gold recall **per category at silence precision 1.0**, per delivery point. That tells the team how big C7 actually is, which is the only category where embeddings are the natural fix.

### 8.2 Ranked build list

Impact is an estimate of the share of "no shared words" misses addressed, argued from the mechanism; none is measured yet. Every item's exit gate includes "silence precision stays 1.0".

| # | Build | Fixes | Expected impact | Cost | Depends on |
|---|---|---|---|---|---|
| **1** | **Evidence-typed gate + shadow-candidate log** (§7.4, §6.3). Rules first; logistic model later | prerequisite for everything below; protects silence as sources are added | none on recall alone; **enables** 2–9 safely and produces unbiased labels | S | P2.3 |
| **2** | **Previous-assistant-message cue + turn-mode classifier** (§4.3, §5.2, §6.1a) | C1 | **High.** Continuations are frequent in agent sessions and are silenced today by `isNoopCue` | S (Stop writes tokens; Submit reads) | 1 |
| **3** | **Error signatures + PostToolUseFailure / PostToolBatch delivery** (§3.5) | C3 | **High precision, medium–high recall** in debugging loops; the most valuable single bullet type | S–M | 1, A4 §6.2 failure→success episodes |
| **4** | **`enc_cues` at encode + context vector `c`** (§1.1, §1.2, §5.2) | C2, C5 | **High** for bare prompts and "the same thing again"; no model | S–M | 1, P0.5 delta encode |
| **5** | **Slot detector** (seed lexicon now; sleep-trained linear model later) → keyed lookup (§6.1b) | C4 | **High** where restatements concentrate (package manager, test command, auth, db) | S (lexicon) → M (trained) | P2.1 live table |
| **6** | **Path anchors + PostToolBatch place triggers** (first touch of a scope or an anchored file) (§3.2, R0 F10) | C2 | **Medium–high**; delivers memory when the agent *enters* a place, not only when the user types | M | 1, P1.2, P3.1 ledger |
| **7** | **Sleep doc2query-- with silence filter** (LLM opt-in, or local small model) + curated abbreviation table (§2.2) | C4, C7 | **Medium**; the main non-embedding answer to true paraphrase | M; LLM cost at sleep | 1, P4.3 alias maturation |
| **8** | **Learned PMI edges** from restatements + `used` + shadow labels (§6.3) | C4, C5, C7 over time | **Medium, compounding**; this is how "the user never says it a third time" | M | 1, 2, P4.1, P4.5 |
| **9** | **Co-change + test↔code links** from local git (§3.4, §3.6) | C6 | **Medium**, unique coverage; zero privacy cost | M | 6 |
| 10 | Stop tier-1 LLM prediction (§4) | C1 residual, plan-driven turns | **Unknown**; experiment only after 2 shows what is left | M; per-turn LLM | 2, consent |
| 11 | Symbol/import graph with Aider-style personalized PageRank (§3.3) | C6 | Low–medium; distractor risk | M–L (tree-sitter) | 6, 9 |
| 12 | Warm daemon; embedding / cross-encoder as gate **features** (§2.7, §7.8) | C7 | Depends on the parallel bench and the C7 share | L | 1, bench |
| 13 | PreToolUse `if`-filtered command triggers (§7.3) | "before X, do Y" intents | Low–medium; very precise | S, but it touches hook config | P4.6 intents |

### 8.3 Order rationale

- **1 before anything.** Every new cue source raises recall *and* false-inject risk. Without typed evidence, adding sources 2–9 trades silence for recall, which is the failure the A4 invariants forbid.
- **2–5 are cheap, local, and deterministic**, and together cover the four categories (C1–C5) that are most common in coding sessions and most visible to users as restatements.
- **7–8 are the learning loop**, and they need the labels that 1 (shadow log) and P4.1/P4.5 produce.
- **10–12 are experiments** whose value depends on what 1–9 leave behind. The per-category report (§8.1) decides.

## R. References

Status: **V** = primary source opened this session (full text or the relevant part); **V-abs** = abstract / listing / model card / official doc page opened, or the primary source confirmed via search listing; **U** = not opened; from model knowledge; verify before citing externally.

### Cognitive science
| Ref | Status |
|---|---|
| Berntsen, D. (2010). The unbidden past: Involuntary autobiographical memories as a basic mode of remembering. *Curr. Dir. Psychol. Sci.* 19:138. doi:10.1177/0963721410370301. Author PDF: https://pure.au.dk/ws/files/71800737/Berntsen_2010_.pdf | **V** |
| Berntsen, D. (1996). Involuntary autobiographical memories. *Appl. Cogn. Psychol.* 10(5):435–454. https://onlinelibrary.wiley.com/doi/abs/10.1002/(SICI)1099-0720(199610)10:5<435::AID-ACP408>3.0.CO;2-L | V-abs (search listing) |
| Polyn, S. M., Norman, K. A., & Kahana, M. J. (2009). A context maintenance and retrieval model of organizational processes in free recall. *Psych. Review* 116(1):129–156. https://psycnet.apa.org/record/2009-00258-003 | V-abs (listing; PDF fetch failed on TLS) |
| Howard, M. W., & Kahana, M. J. (2002). A distributed representation of temporal context. *J. Math. Psych.* 46:269–299 | U (equation from model knowledge) |
| Anderson, J. R., & Reder, L. M. (1999). The fan effect: New results and new theories. *JEP: General*. http://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/35jra_lmr_1999.pdf | V-abs (search result, `S_ji = S − ln fan`) |
| Anderson, J. R. (1990). *The Adaptive Character of Thought* (rational analysis; `S_ji` as log-likelihood ratio) | U |
| Tulving, E., & Thomson, D. M. (1973). Encoding specificity and retrieval processes in episodic memory. *Psych. Review* 80:352–373 | U |
| Morris, C. D., Bransford, J. D., & Franks, J. J. (1977). Levels of processing versus transfer appropriate processing. *JVLVB* 16:519–533 | U |
| Watkins, O. C., & Watkins, M. J. (1975). Buildup of proactive inhibition as a cue-overload effect. *JEP:HLM* 1:442–452 | U |
| Einstein, G. O., & McDaniel, M. A. (2005). Prospective memory: Multiple retrieval processes. *Curr. Dir. Psychol. Sci.* https://journals.sagepub.com/doi/10.1111/j.0963-7214.2005.00382.x ; focal/non-focal: https://pmc.ncbi.nlm.nih.gov/articles/PMC2864946/ | V-abs |
| Gollwitzer, P. M. (1999). Implementation intentions. *Am. Psychol.* 54:493–503 | U |
| Reder, L. M., & Ritter, F. E. (1992). What determines initial feeling of knowing? Familiarity with question terms, not with the answer. *JEP:LMC* 18:435–451. https://acs.ist.psu.edu/papers/rederR92.pdf | V-abs (search listing) |
| Metcalfe, J., Schwartz, B. L., & Joaquim, S. G. (1993). The cue-familiarity heuristic in metacognition. https://www.columbia.edu/cu/psychology/metcalfe/PDFs/Metcalfe%20Schwartz%20et%20al%201993.pdf | V-abs (listing) |
| Koriat, A. (1993). How do we know that we know? *Psych. Review* 100:609–639 | U |
| Dury, J. (2026). Predictive Associative Memory: Retrieval beyond similarity through temporal co-occurrence. arXiv:2602.11322 | V-abs |
| Jiang, H. et al. (2026). SYNAPSE: Episodic-semantic memory via spreading activation. arXiv:2601.02744 | V-abs |

### Information retrieval
| Ref | Status |
|---|---|
| Formal, T., Piwowarski, B., & Clinchant, S. (2021). SPLADE. SIGIR. arXiv:2107.05720 | V-abs |
| Geng, Z., Wang, Y., Ru, D., & Yang, Y. (2024). Towards competitive search relevance for inference-free learned sparse retrievers. arXiv:2411.04403 | V-abs |
| OpenSearch `opensearch-neural-sparse-encoding-doc-v3-distill` model card. https://huggingface.co/opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill | V |
| Gospodinov, M., MacAvaney, S., & Macdonald, C. (2023). Doc2Query--: When less is more. ECIR. arXiv:2301.03266 | V-abs |
| Nogueira, R. et al. (2019). Document expansion by query prediction (doc2query / docTTTTTquery). arXiv:1904.08375 | U |
| Zhuang, S., & Zuccon, G. (2021). Fast passage re-ranking with contextualized exact term matching and efficient passage expansion (TILDEv2). arXiv:2108.08513 | V-abs |
| Ponte, J. M., & Croft, W. B. (1998). A language modeling approach to information retrieval. SIGIR | U |
| Gao, L., Ma, X., Lin, J., & Callan, J. (2022). Precise zero-shot dense retrieval without relevance labels (HyDE). arXiv:2212.10496 | V-abs |
| Cormack, G. V., Clarke, C. L. A., & Büttcher, S. (2009). Reciprocal rank fusion outperforms Condorcet and individual rank learning methods. SIGIR, 758–759. https://dblp.org/rec/conf/sigir/CormackCB09.html | V-abs (listing) |
| Asai, A. et al. (2023). Self-RAG. arXiv:2310.11511 | V-abs |
| Jeong, S. et al. (2024). Adaptive-RAG. NAACL. arXiv:2403.14403 | V-abs |
| Jiang, Z. et al. (2023). Active retrieval augmented generation (FLARE). arXiv:2305.06983 | V-abs |
| Wang, Y. et al. (2023). Self-knowledge guided retrieval augmentation (SKR). arXiv:2310.05002 | V-abs |
| Mallen, A. et al. (2023). When not to trust language models. ACL. arXiv:2212.10511 | V-abs |
| Holdcroft, J., Abdallah, A., & Jatowt, A. (2026). The Magnitude Mirage: Rethinking confidence for reasoning-intensive retrieval. EMNLP. arXiv:2609.15578 | V-abs |
| Veselý, M., Průšek, M., & Franc, J. (2026). Your retriever already knows: Distribution-shape QPP for RAG retrieval sufficiency. TSD. arXiv:2609.11646 | V-abs |
| Cuconasu, F. et al. (2024). The Power of Noise: Redefining retrieval for RAG systems. arXiv:2401.14887 | V-abs |
| `cross-encoder/ms-marco-MiniLM-L6-v2` model card (NDCG, docs/s on V100). https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2 | V |
| Pan, T. (2026). ConvMemory: A lightweight learned memory reranker … arXiv:2605.28062 | V-abs |
| Furnas, G. W. et al. (1987). The vocabulary problem in human-system communication. *CACM* 30(11) | U |
| Joulin, A., Grave, E., Bojanowski, P., & Mikolov, T. (2016). Bag of tricks for efficient text classification (fastText). arXiv:1607.01759 | V-abs |
| Joachims, T., Granka, L., Pan, B., Hembrooke, H., & Gay, G. (2005). Accurately interpreting clickthrough data as implicit feedback. SIGIR. https://www.cs.cornell.edu/people/tj/publications/joachims_etal_05a.pdf | V-abs (listing) |
| Joachims, T. (2002). Optimizing search engines using clickthrough data. KDD | U |
| Joachims, T., Swaminathan, A., & Schnabel, T. (2017). Unbiased learning-to-rank with biased feedback. WSDM. arXiv:1608.04468 | V-abs |

### Code and coding agents
| Ref | Status |
|---|---|
| Saha, S. (2026). Delivery, not storage: Cue-anchored working memory as a harness property for coding agents. arXiv:2607.20972 | **V** (abstract + HTML) |
| Aider repo map docs https://aider.chat/docs/repomap.html and source `aider/repomap.py` (edge weights, personalized PageRank) https://github.com/Aider-AI/aider/blob/main/aider/repomap.py | **V** (source read) |
| Hartman, J. et al. (2024). AI-assisted coding with Cody: Lessons from context retrieval and evaluation for code recommendations. arXiv:2408.05344 | V-abs (HTML summary) |
| Sourcegraph blog, "How Cody understands your codebase". https://sourcegraph.com/blog/how-cody-understands-your-codebase | V-abs (search summary) |
| GitHub blog, "How GitHub Copilot is getting better at understanding your code" (neighboring tabs +5%, FIM +10%). https://github.blog/ai-and-ml/github-copilot/how-github-copilot-is-getting-better-at-understanding-your-code/ | V |
| Copilot Jaccard / 60-line windows (reverse-engineered). https://thakkarparth007.github.io/copilot-explorer/posts/copilot-internals.html | V-abs (search summary; unofficial) |
| Cursor rules docs. https://cursor.com/docs/context/rules | V |
| Windsurf / Devin Desktop Cascade memories & rules. https://docs.devin.ai/desktop/cascade/memories | V |
| Augment Context Engine / real-time index / context lineage. https://www.augmentcode.com/context-engine ; https://www.augmentcode.com/blog/announcing-context-lineage | V-abs (search summary; vendor claims) |
| Cherny, B. — Claude Code dropped RAG + local vector DB for agentic search. https://x.com/bcherny/status/2017824286489383315 ; https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny | V-abs (search summary) |
| Continue `@codebase` retrieval | U (docs URL returned 404) |
| Claude Code hooks reference (PreToolUse/PostToolUseFailure/PostToolBatch `additionalContext`, `if` filters, TaskCreated). https://code.claude.com/docs/en/hooks.md ; see also `R0-claude-code-hook-facts.md` | **V** (raw page grepped) |
| Zimmermann, T., Weißgerber, P., Diehl, S., & Zeller, A. (2004/2005). Mining version histories to guide software changes. ICSE 2004; *IEEE TSE* 31(6). https://thomas-zimmermann.com/publications/files/zimmermann-tse-2005.pdf | V-abs |
| Vasiliev, R. et al. (2020). TraceSim: A method for calculating stack trace similarity. arXiv:2009.12590 | V-abs (search listing) |
| Dang, Y. et al. (2012). ReBucket: Clustering duplicate crash reports based on call stack similarity. ICSE | V-abs (search listing) |
| White, R., Krinke, J., & Tan, R. (2020). Establishing multilevel test-to-code traceability links. ICSE; White & Krinke, TCTracer, *EMSE* 2022 | V-abs |

### Anticipation and agent memory
| Ref | Status |
|---|---|
| Lin, K., Snell, C., Wang, Y., Packer, C., Wooders, S., Stoica, I., & Gonzalez, J. E. (2025). Sleep-time compute: Beyond inference scaling at test-time. arXiv:2504.13171 | V-abs |
| Ma, G. et al. (2025/2026). SpecAgent: A speculative retrieval and forecasting agent for code completion. arXiv:2510.17925 | V-abs |
| Lu, Y. et al. (2024). Proactive Agent: Shifting LLM agents from reactive responses to active assistance (ProactiveBench). arXiv:2410.12361 | V-abs |
| Letta sleep-time agents docs https://docs.letta.com/guides/agents/architectures/sleeptime/ ; Context Repositories (12 Feb 2026) https://www.letta.com/blog/context-repositories/ | V-abs / V |

**Not verified and not used as evidence:** exact CPU latencies for cross-encoders and static embeddings; BM25's exact BEIR average; LLM per-turn prices. All are marked as estimates in the text.
