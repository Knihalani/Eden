# R1 — Cue experiment: how Eden should match cues beyond lexical tokens

**Dated 2026-09-29. Status: complete. Apple M3, Bun 1.3.13. All numbers are from the scratchpad runs listed in §8.**

## 0. Verdict

1. **Eden's biggest cue problem today is silence, not paraphrase.** The current algorithm (M0, imported from `src/index.ts`) injects on **50%** of test negatives. On math, off-topic coding and hard negatives it injects on 50–69%. Only 20% of its bullets are gold. Test recall@4 is 0.52. A calibrated BM25F gate on the same lexical signal plus context (M1 + M7) keeps recall (0.58 at a 5% dev false-inject target; 0.50 at a 0% dev target) and cuts the test false-inject rate to 15% / 7.5%. Bullet precision goes from 0.20 to 0.76–0.86.
2. **No method bridges zero-overlap cues under a silence constraint.** 57 test positives share no content token with any gold row. On them, recall@4 is 0.00–0.12 for every method: BM25F, doc2query aliases, static embeddings, bge-small, MiniLM, cross-encoder and hybrids. The categories where users actually restate things fare worst. `indirect` scores ≤ 0.07 everywhere, and `policy` (R6: workflow policy) ≤ 0.22.
3. **Static embeddings (Model2Vec) are cheap but not useful here.** Cold, they add only 6–10 ms at 205 rows and 26–33 ms at 20k. The TypeScript implementation matches the Python reference exactly: 0 token-id mismatches and cosine 1.0000000 on 564 texts. But alone they lose to BM25F on every category (test recall@4 0.38–0.46 vs 0.56). As a hybrid arm they add nothing: M6 with potion-r32 ≤ M1.
4. **bge-small-en-v1.5 is the best single scorer** (test r@4 0.589, FIR 5.0%, precision 0.87; at the strict point 0.520 / FIR 1.25%). It transfers its dev threshold to test better than BM25 does. But a cold process needs **165 ms p50** (transformers.js + onnxruntime-node int8), which exceeds the 150 ms Submit budget. Warm, it is **1.3 ms/query**, so it belongs in the daemon (`hookd`). Its gain over BM25F + context (+0.01–0.03 recall@4) is inside the bootstrap CIs (±0.06).
5. **Context augmentation (M7) is the one clear, free win.** Appending the previous user turn and path tokens from `last_paths` raises `ctx` recall@4 from 0.18 to 0.41 (BM25F) and from 0.20 to 0.43 (bge). Overall FIR does not change. It costs microseconds.
6. **Sleep-side doc2query aliases from a small local LLM (Phi-3.5-mini) are mixed.**
   - Raw aliases make the gate more conservative: FIR 7.5%, but recall drops (0.53 vs 0.56).
   - df-capped aliases (A2 §2.3 cap) lift paraphrase recall (0.49 → 0.57) but lose silence (FIR 17.5%).
   - Verdict: adopt aliases only through A4 P4.3 "alias maturation against a silence set", not blind doc2query.
7. **R2 evidence-typed gate (M9).** Calibration on dev rejected "1 STRONG (a df ≤ 5 token) admits": 90/150 negatives contain such a token ("docker", "tailwind", "Next.js", "python"). The chosen rule was *2 MEDIUM, or 1 MEDIUM + bge cos ≥ 0.72*. On test with context: r@4 0.594, FIR 7.5%, but bullet precision drops to 0.56 because it admits more bullets. The top-1/top-2 gap abstention for dense-only admission was never selected: dense-only admission stayed off at every tuned point.

**Decision.**
- **Hot path (fresh Bun):** stay lexical and keep lock L6. Use BM25F(subject×2, text×1) over scoped live rows. Build the cue as prompt ⊕ previous user turn ⊕ path tokens from `last_paths`. Gate on the top BM25F score, plus a relative cut of 0.7·top. **Calibrate the gate per repo at sleep, against a silence set**: the absolute BM25F value is corpus-dependent (here τ = 3.2 at the 5% point, 4.1 at the 0% point).
- **Daemon (`hookd`, warm):** optionally add bge-small int8 as a second arm (τ_cos ≈ 0.70–0.72 with the BGE query prefix, margin 0.04), in an RRF union or as a veto. Expected gain +0.01–0.03 recall@4. Not worth a dependency on its own; worth it if the daemon already exists.
- **Cross-encoder:** a high-precision veto only (FIR 0% at τ = 3.4, but recall 0.39). It costs 30 ms warm for 20 pairs and 167 ms cold.
- **Sleep:** aliases enter only through miss-driven maturation with silence-set replay. Do not expect semantic retrieval to fix policy / indirect needs. Those need keyed pins, compiled triggers and intent rules (R2 §7, R6 §9.6).

## 1. Fixture (CueBench-code)

A synthetic but realistic TypeScript monorepo ("acme": Next.js web, Fastify API, a CLI package, a BullMQ worker, Terraform/EKS infra).

**Memories: 214 rows, 205 live + 9 superseded** (`fixture/memories.psv`), each with `id | scope | kind | subject | text | superseded_by`.

| Scope | Rows | Examples |
|---|---|---|
| `""` (repo root) | 50 (2 superseded) | pnpm 9, Node 20.11 in `.nvmrc`, never commit `.env`, Conventional Commits, `ERR_REQUIRE_ESM` fix, Biome, lefthook, ports |
| `apps/web` | 37 (2) | Clerk auth (superseded Auth0), redirect-loop gotcha, hydration mismatch fix, `Can't resolve 'fs'` fix, Tailwind v4 |
| `apps/api` | 38 (2) | Postgres 16 (superseded MySQL 8), Drizzle, `db:migrate`, PgBouncer prepared statements, Stripe raw body, money in cents |
| `packages/cli` | 19 (1) | commander, tsup, `~/.acme/config.json`, ESM-only + Node 18, Windows paths gotcha |
| `services/worker` | 17 (1) | BullMQ/Redis 7, retries, sharp-on-Alpine gotcha, `removeOnComplete`, idempotency |
| `infra` | 23 (1) | Terraform state bucket, EKS `acme-prod`, never `apply` from laptop, KEDA/HPA |
| `""` policy / preference (added after R6) | 30 | never merge PRs yourself, don't open the PR until told, work on a branch, re-check for bugs before "done", ask before new deps, no emojis, plain explanations |

Kinds: fact, constraint (rule), procedure (command), episode (decision / gotcha), preference. There are live near-duplicates across scopes (web auth = Clerk vs API verifies Clerk JWTs; two `ERR_REQUIRE_ESM` notes, root vs CLI; Redis in worker, API, infra). Superseded rows are excluded before ranking for every method, as in A4 §5 step 4.

**Scope.** Each cue carries a scope. A method sees root rows plus rows of that scope (the L2 cascade; siblings never). Every gold id is visible from its cue's scope (asserted by `build_cues.py`).

**Cues: 666** (median 43 chars) (`fixture/cues.json`, built from `cues-hand.psv` and `cues-llm.psv`).

| Category | n (dev/test) | Author | What it tests |
|---|---|---|---|
| `lex` exact/lexical | 87 (39/48) | hand | cue shares the memory's distinctive tokens (`ERR_REQUIRE_ESM`, `pnpm`, `/healthz`) |
| `para` paraphrase/synonym | 180 (90/90) | 85 hand + 95 LLM | "login provider" vs auth, "db", "k8s", "IaC", "tz" |
| `natural` | 95 (51/44) | LLM | a natural message a developer would send when needing the note |
| `ctx` implicit/contextual | 55 (33/22) | hand | the cue lacks the subject; `last_paths` and/or the previous user turn carry it ("why does it keep bouncing back?" + `apps/web/middleware.ts`) |
| `indirect` indirect need | 39 (22/17) | hand | "set up the project on a new laptop" → pnpm + node + env + compose; multi-gold (1–4 ids) |
| `policy` workflow policy | 60 (28/32) | hand | task prompts where a standing policy applies: "fix the typo and get it merged" → never merge yourself; "reset my local db" → ask before destructive commands. 33/60 share no content token with the policy row |
| `neg-chat` | 30 | hand | "thanks!", "lgtm", "keep going" |
| `neg-math` general | 25 | hand | "what is 17 * 23?", "capital of Australia" |
| `neg-offtopic` coding | 50 | hand | "reverse a linked list", "explain the CAP theorem" |
| `neg-hard` | 45 | hand | shares words with memories but needs none: "write a poem about redis", "what year was Next.js first released?", "explain JWT structure", "what does HMAC stand for?" |

Positives: 516. Negatives: 150 (70 dev / 80 test); 90 of them share a token with df ≤ 5 with some memory.

**LLM author.** The brief called for MiniMax. The key in `MINIMAX_API_KEY` is valid, but every endpoint answers `insufficient balance (1008)`: api.minimax.io `/v1/chat/completions`, `/v1/text/chatcompletion_v2`, and `/anthropic/v1/messages`, with MiniMax-M2 / M2.1 / M2.5 / M2.7 / Text-01 / M1. Two local held-out models replace it:
- **Qwen2.5-3B-Instruct** wrote the 190 LLM cues (`gen_cues_qwen.py`; 95 memories sampled with seed 7; one `para` cue told to avoid the note's words, plus one `natural` cue).
- **Phi-3.5-mini-instruct**, a different model family, wrote the sleep-side aliases for M3 (`gen_aliases_phi.py`). It sees only the memory text, never a cue.

Qwen mostly ignored the "do not reuse words" instruction (see §5). The paraphrase results are therefore also reported by *measured* lexical overlap with the gold row, not by author intent.

**Split.** Dev/test is grouped: a union-find over co-gold memory ids, then an md5 hash. No memory has cues in both splits, and no cue text is duplicated across splits (§5). Every threshold is tuned on dev only. Test is scored once per method.

## 2. Methods

Every method sees only live rows in the cue's cascade scope. The packet is at most 6 bullets; recall@4 counts the first 4. Tokenizer for M1–M3 and M9 (`lex.ts`):
- lowercase;
- compound identifiers are kept whole *and* split (`next.config.ts` → `next.config.ts`, `next`, `config`, `ts`);
- English stopwords plus chat words are removed;
- plural s-stemming.

| Id | Method | Implementation |
|---|---|---|
| M0 | Eden today | `openMemory` from `src/index.ts` in a temp dir, one store per scope. `remember(text, {kind, id})` per row, then `EDEN_MEMORY=readonly`. Silent if `isNoopCue` or `hookLane == none`, else `notesFor(cue)` → `packNotes(900 B, 6)`. Variants: `M0_paths` = `attachPlaceCues(cue, last_paths)` (today's place cue); `M0_ctx` = the same plus the previous turn. No calibration, because M0 has no threshold. |
| M1 | BM25F | k1 = 1.2, b = 0.75; fields subject ×2, text ×1; IDF over all live rows. **M1r**: plus a floor on the max matched IDF. |
| M2 | BM25F + char-trigram | rank = BM25F + 4·trigram-cosine over content words. Admit if BM25F ≥ τ or trigram ≥ τ_t. |
| M3 | BM25F + sleep aliases | Aliases field ×1.5. Up to 8 aliases per row from Phi-3.5-mini (1,711 aliases for 214 rows). **M3c**: the A2 §2.3 cap keeps an alias only if every token has df ≤ 6 (486 kept). |
| M4 | Model2Vec static | potion-base-8M (256-d) and potion-retrieval-32M (512-d), in TypeScript (`m2v.ts`): BERT WordPiece → row lookup → mean → L2. Doc text = `subject: text`. **M4a**: doc text plus aliases. |
| M5 | Small transformer | bge-small-en-v1.5 (with the BGE query instruction) and all-MiniLM-L6-v2. Quality numbers use sentence-transformers fp32. The Bun int8 path agrees with it on top-1 for 96% of 150 cues (max \|Δcos\| 0.038). |
| M6 | Hybrid union | Admit if lexical ≥ τ_l **or** dense ≥ τ_d; order by RRF(k = 60). Pairs: BM25F / BM25F + aliases / capped aliases × potion-r32 / bge. |
| M7 | Context-augmented cue | cue ⊕ previous user turn ⊕ path tokens (basename and non-generic dir segments of `last_paths`). Applied to every method; the suffix `_ctx` in the tables. |
| M8 | Cross-encoder | ms-marco-MiniLM-L6-v2. (a) scores every visible row; (b) reranks the top-20 of RRF(BM25F, bge). They are identical at every tuned threshold, because the gold was always in the top 20. |
| M9 | R2 evidence-typed gate | Per row: STRONG = matched token with df ≤ S; MEDIUM = df ≤ M. Admit on 1 STRONG, or ≥ `need` MEDIUM, or 1 MEDIUM + dense cos ≥ τ_d, or dense-only top-1 with cos ≥ τ_h **and** top-1 − top-2 gap ≥ g. Optional BM25F floor. **M9s** = no floor (the pure R2 rule). Grid: S ∈ {0,1,2,3}, M ∈ {10,25,50}, need ∈ {2,3}. |

**Calibration** (`eval.py`, dev split only):
- Grid-search each method's thresholds (quantile grids of the top-1 score; relative cut ρ ∈ {0, 0.5, 0.7} for BM25; margin δ ∈ {∞, 0.08, 0.04} for cosines).
- Maximize dev recall@4 + 0.1·(strict bullet precision), subject to dev false-inject rate ≤ target.
- Two targets: **FIR ≤ 5%** (≤ 3 of 70 dev negatives) and **FIR = 0** (strict silence).
- Score the test split once.

**Metrics:**
- Recall@k: mean over positive cues of |gold ∩ packet[:k]| / |gold|.
- Silence: the fraction of negatives with an empty packet. FIR = 1 − silence.
- Strict precision: the fraction of injected bullets on positives that are gold.
- 95% CIs: bootstrap with 2,000 resamples over test cues.

## 3. Results (test split: 253 positives, 80 negatives)

### 3.1 Operating point A: dev FIR ≤ 5%

| Method | lex | para | natural | ctx | indirect | policy | **all r@4 [95% CI]** | **silence [FIR CI]** | prec | bullets |
|---|---|---|---|---|---|---|---|---|---|---|
| M0 Eden today | 0.75 | 0.49 | 0.86 | 0.16 | 0.15 | 0.25 | 0.522 [0.46,0.58] | **0.500** [0.39,0.61] | 0.20 | 2.67 |
| M0_ctx (paths + prev turn) | 0.75 | 0.49 | 0.86 | 0.27 | 0.15 | 0.25 | 0.532 [0.47,0.59] | 0.500 | 0.20 | 2.73 |
| M1 BM25F | 0.98 | 0.49 | 0.93 | 0.18 | 0.04 | 0.16 | 0.560 [0.50,0.62] | 0.850 [0.07,0.24] | 0.78 | 0.74 |
| M1 BM25F_ctx | 0.98 | 0.49 | 0.93 | **0.41** | 0.04 | 0.16 | 0.580 [0.52,0.64] | 0.850 [0.07,0.24] | 0.76 | 0.78 |
| M2 BM25+trigram_ctx | 0.98 | 0.49 | 0.93 | 0.41 | 0.04 | 0.22 | 0.588 [0.53,0.65] | 0.850 | 0.61 | 0.99 |
| M3 BM25F+aliases_ctx | 0.95 | 0.46 | 0.91 | 0.45 | 0.02 | 0.12 | 0.557 [0.50,0.61] | 0.925 [0.03,0.14] | 0.80 | 0.70 |
| M3c aliases df-capped_ctx | 0.98 | 0.56 | 0.93 | 0.41 | 0.04 | 0.16 | 0.603 [0.54,0.66] | 0.825 [0.10,0.26] | 0.78 | 0.79 |
| M4 potion-base-8M | 0.92 | 0.34 | 0.84 | 0.05 | 0.00 | 0.06 | 0.455 [0.40,0.51] | 0.863 | 0.73 | 0.62 |
| M4 potion-base-8M_ctx | 0.92 | 0.33 | 0.84 | 0.20 | 0.00 | 0.06 | 0.464 | 0.887 | 0.73 | 0.65 |
| M4 potion-retrieval-32M | 0.85 | 0.24 | 0.75 | 0.00 | 0.00 | 0.00 | 0.379 [0.32,0.44] | 0.900 | 0.94 | 0.41 |
| M4a potion-r32 + aliases | 0.61 | 0.16 | 0.45 | 0.05 | 0.00 | 0.00 | 0.255 | 0.975 | 0.93 | 0.28 |
| M5 bge-small | 0.95 | **0.58** | 0.95 | 0.20 | 0.00 | 0.16 | 0.589 [0.53,0.65] | **0.950** [0.01,0.10] | 0.87 | 0.68 |
| M5 bge-small_ctx | 0.95 | 0.57 | 0.93 | 0.43 | 0.00 | 0.12 | 0.597 [0.54,0.66] | 0.950 [0.01,0.10] | 0.83 | 0.72 |
| M5 MiniLM-L6_ctx | 0.97 | 0.50 | 0.93 | 0.39 | 0.00 | 0.20 | 0.583 | 0.912 | 0.85 | 0.69 |
| M6 BM25F ∪ r32 RRF_ctx | 0.98 | 0.49 | 0.93 | 0.41 | 0.04 | 0.22 | 0.588 | 0.850 | 0.62 | 0.98 |
| M6 BM25F+alc ∪ r32 RRF_ctx | 0.98 | 0.57 | 0.93 | 0.45 | 0.04 | 0.22 | **0.619** [0.56,0.68] | 0.825 [0.09,0.26] | 0.59 | 1.08 |
| M6 BM25F ∪ bge RRF_ctx | 0.96 | 0.58 | 0.93 | **0.52** | 0.00 | 0.12 | 0.611 [0.55,0.67] | 0.887 [0.05,0.17] | 0.66 | 0.94 |
| M6 BM25F+al ∪ bge RRF_ctx | 0.98 | 0.56 | 0.93 | 0.41 | 0.00 | 0.16 | 0.601 | 0.912 | 0.66 | 0.93 |
| M9s pure R2 rule + r32_ctx | 0.96 | 0.41 | 0.93 | 0.52 | 0.04 | 0.16 | 0.558 | 0.925 | 0.56 | 1.02 |
| M9 evidence gate + bge_ctx | 0.98 | 0.49 | 0.95 | 0.52 | 0.04 | 0.16 | 0.594 [0.53,0.65] | 0.925 [0.03,0.14] | 0.56 | 1.08 |
| M8 cross-encoder_ctx | 0.98 | 0.42 | 0.91 | 0.34 | 0.02 | 0.06 | 0.533 [0.48,0.60] | 0.963 [0.00,0.09] | 0.79 | 0.68 |

Silence by negative class (test, point A): **M0 is chat 1.00 / math 0.50 / off-topic 0.45 / hard 0.31.** M1_ctx is 1.00 / 1.00 / 0.86 / 0.69. bge-small is 1.00 / 1.00 / 0.93 / 0.92. CE is 1.00 / 1.00 / 1.00 / 0.92. Every false inject of a tuned method is a **hard negative** ("what year was Next.js first released?", "tell me a joke about docker containers", "how do I write unit tests in Java with JUnit?") or near-hard off-topic ("write a quick unit test for an add(a, b) function"). Recall@6 equals recall@4 for every tuned method: after the gate and the relative cut, packets average 0.6–1.1 bullets.

### 3.2 Operating point B: strict silence (dev FIR = 0)

| Method | lex | para | natural | ctx | indirect | policy | all r@4 [CI] | test silence [FIR CI] | prec |
|---|---|---|---|---|---|---|---|---|---|
| M1 BM25F_ctx (τ = 4.14, ρ = 0.7) | 0.94 | 0.33 | 0.89 | 0.41 | 0.00 | 0.09 | 0.498 [0.43,0.56] | 0.925 [0.03,0.14] | 0.86 |
| M3c aliases capped_ctx (τ = 4.13) | 0.96 | 0.42 | 0.93 | 0.41 | 0.00 | 0.09 | 0.542 [0.48,0.60] | 0.925 | 0.86 |
| M4 potion-base-8M | 0.92 | 0.27 | 0.77 | 0.00 | 0.00 | 0.03 | 0.407 | 0.900 | 0.92 |
| M5 bge-small (cos ≥ 0.723, δ = 0.04) | 0.93 | 0.44 | 0.93 | 0.14 | 0.00 | 0.09 | 0.520 [0.46,0.58] | **0.988** [0.00,0.04] | 0.97 |
| M5 bge-small_ctx (0.719) | 0.93 | 0.44 | 0.93 | 0.20 | 0.00 | 0.09 | 0.526 | 0.975 | 0.94 |
| M6 BM25F ∪ bge_ctx (4.34 / 0.723) | 0.94 | 0.49 | 0.93 | 0.39 | 0.00 | 0.09 | 0.559 [0.50,0.62] | 0.925 | 0.77 |
| M6 BM25F+al ∪ bge_ctx | 0.94 | 0.47 | 0.93 | 0.32 | 0.00 | 0.09 | 0.545 | 0.975 [0.00,0.06] | 0.86 |
| M9 evidence gate + bge_ctx (2×MEDIUM df ≤ 50, or MEDIUM + cos ≥ 0.724) | 0.98 | 0.49 | 0.95 | 0.52 | 0.04 | 0.16 | **0.594** [0.53,0.65] | 0.925 | 0.56 |
| M8 cross-encoder_ctx (logit ≥ 3.4) | 0.89 | 0.24 | 0.70 | 0.14 | 0.00 | 0.00 | 0.389 | **1.000** | 0.98 |

**Threshold transfer.** Lexical gates tuned to dev FIR = 0 give **7.5%** test FIR, and 15% at the 5% point. With 70 dev negatives, one additional hard negative moves FIR by 1.25 points. The bge cosine threshold transfers best (dev 0 → test 1.25%). A per-repo silence set of ~70 prompts cannot certify "silence precision 1.0". The A5 silence arm needs hundreds of hard negatives, drawn from real logged prompts (R6).

### 3.3 Zero-overlap cues (R2's split), test recall@4 at point A

| Method | overlap none (n = 57) | common-only (n = 18) | rare token shared (n = 178) | none: para (24) / ctx (9) / indirect (5) / policy (19) |
|---|---|---|---|---|
| M0 Eden today | 0.02 | 0.32 | 0.70 | 0.00 / 0.00 / 0.00 / 0.05 |
| M1 BM25F_ctx | 0.02 | 0.19 | 0.80 | 0.00 / 0.11 / 0.00 / 0.00 |
| M3 aliases_ctx | 0.09 | 0.19 | 0.74 | 0.08 / 0.22 / 0.00 / 0.05 |
| M4 potion-base-8M | 0.04 | 0.17 | 0.62 | 0.04 / 0.00 / 0.00 / 0.05 |
| M5 bge-small_ctx | **0.12** | 0.22 | 0.79 | 0.12 / 0.33 / 0.00 / 0.05 |
| M5 MiniLM-L6_ctx | 0.11 | 0.36 | 0.76 | 0.04 / 0.44 / 0.00 / 0.05 |
| M6 BM25F ∪ bge_ctx | 0.11 | 0.28 | 0.81 | 0.08 / 0.33 / 0.00 / 0.05 |
| M9 evidence + bge_ctx | 0.04 | 0.24 | 0.81 | 0.00 / 0.28 / 0.00 / 0.00 |
| M8 cross-encoder_ctx | 0.02 | 0.17 | 0.74 | 0.00 / 0.11 / 0.00 / 0.00 |

**Reading.**
- Where cue and memory share a rare token, every lexical or dense method reaches 0.74–0.84.
- Where they share nothing, the best is 0.12. Dense similarity is not high enough to clear a threshold that also keeps "write a poem about redis" silent.
- The zero-overlap *policy* class ("fix the typo and get it merged" → *never merge PRs yourself*) is at 0.00–0.05 for every method.

## 4. Latency and footprint (Apple M3, Bun 1.3.13, quiet machine, load average ≈ 2)

### 4.1 Cold: fresh `bun cold.ts` process per query, 30 spawns, wall time spawn→exit

| Method | N rows | p50 | p95 | RSS | Internal breakdown (p50) |
|---|---|---|---|---|---|
| `bun` hello (floor) | — | 10.0 ms | 10.2 | 23 MB | — |
| M0 Eden today (import `src/index.ts` + open + `notesFor`) | 205 | 24.2 | 24.8 | 49 MB | import 10.9 ms, query 1 ms |
| M1 BM25F (index built in-process from JSON) | 205 | 15.1 | 15.3 | 37 MB | index 3.0 ms |
| M3 BM25F + aliases | 205 | 16.5 | 16.8 | 40 MB | index 4.3 ms |
| M4 potion-base-8M (vocab.txt + mmap raw f32 + doc vecs) | 205 | 21.5 | 22.1 | 45 MB | model 7.4 ms, embed 0.8 ms |
| M4 potion-retrieval-32M | 205 | 24.5 | 24.7 | 49 MB | model 9.7 ms |
| M6 BM25F+al ∪ r32 | 205 | 29.8 | 30.6 | 57 MB | — |
| **M5 bge-small int8** (transformers.js 4.3 + onnxruntime-node 1.30) | 205 | **165.2** | 166.7 | 196 MB | import 57 ms, model load 71 ms, embed 7 ms |
| **M8 CE int8, 20 pairs** | 205 | **166.8** | 171.7 | 193 MB | import 57, load 49, rerank 36 ms |
| M1 BM25F (in-process index build) | 20,000 | 107.3 | 112.2 | 156 MB | index 75 ms: prebuild postings (SQLite FTS, A2 §1) instead |
| M4 potion-base-8M, brute-force dot | 20,000 | 40.9 | 41.7 | 88 MB | dot 13 ms |
| M4 potion-retrieval-32M | 20,000 | 48.0 | 49.3 | 113 MB | dot 17 ms |

### 4.2 Warm: in-process, 200 real cues (the daemon path)

| Step | p50 | p95 |
|---|---|---|
| BM25F score all rows, N = 205 / 20k | 0.05 / 5.5 ms | 0.11 / 8.2 ms |
| BM25F + aliases, N = 205 / 20k | 0.06 / 5.9 ms | 0.11 / 8.9 ms |
| potion-base-8M embed + dot, N = 205 / 20k | 0.05 / 3.6 ms | 0.06 / 3.6 ms |
| potion-retrieval-32M embed + dot, N = 205 / 20k | 0.09 / 7.3 ms | 0.13 / 7.4 ms |
| bge-small int8 query embedding | 1.3 ms | 2.0 ms |
| Cross-encoder int8, 20 pairs | 30.1 ms | 33.6 ms |

### 4.3 Build (sleep) cost and disk

| What | Cost |
|---|---|
| BM25F index, 205 / 20k rows | 2.1 / 68 ms |
| Model2Vec doc vectors, 205 / 20k rows | 11–13 ms / 254–317 ms |
| bge-small int8 doc vectors, 205 rows | 457 ms (2.2 ms/row) |
| Phi-3.5-mini aliases (MPS fp16) | **~4.1 s per row** uncontended (123 s / 30 rows); 1,511 s for 184 rows under load |
| Disk: potion-base-8M | 29 MB f32 + 0.2 MB vocab (could be f16 / int8) |
| Disk: potion-retrieval-32M | 123 MB |
| Disk: bge-small int8 | 32 MB + onnxruntime-node **292 MB** + transformers.js 15 MB |

The safetensors payload was aligned, so mmap is zero-copy. The sleep step also writes a raw `emb.f32` so the hot path never parses the header.

**Hot-path feasibility (150 ms budget, A4 §5):**
- Lexical fits easily: M0's 24 ms is mostly importing its module graph.
- Static embeddings fit (+6–10 ms at 205 rows, +26–33 ms at 20k). They do not earn it on quality.
- bge-small and the cross-encoder each exceed the whole budget cold, from runtime import and model load alone. They are daemon-only.

## 5. Sanity checks

| Check | Result |
|---|---|
| Model2Vec TS vs Python `model2vec` 0.9.0 | 564 texts (memories, cues, accents / CJK / identifiers, a 150-char word, empty), both models: **0 token-id mismatches, min cosine 1.0000000** (`m2v_check.ts`) |
| bge-small int8 (Bun) vs fp32 (Python) | top-1 agreement 0.96 over 150 cues; max \|Δcos\| 0.038 (`lat/q8check.ts`). Quality tables use fp32; the Bun path would be slightly different |
| Dev/test leakage | union-find over co-gold ids: **0 memories** with cues in both splits; 0 exact duplicate cue texts; 1 near-duplicate pair (Jaccard ≥ 0.8) across splits, with different gold ("how do I run the tests for this?" / "run just these tests") |
| Paraphrase cues sharing rare tokens (df ≤ 5) with gold | **Qwen `para`: 85/95 share a rare token, only 3/95 share none.** The small LLM ignored "do not reuse the note's words", so LLM "paraphrases" behave like lexical cues. Hand `para`: 36/85 rare, 41/85 none. ctx: 20/55 none. indirect: 13/39 none. policy: 33/60 none. §3.3 therefore reports by measured overlap |
| Negatives sharing indexed tokens | 94/150 share some token with a memory; 90/150 a df ≤ 5 token. This is why "1 rare token admits" cannot hold silence |
| Aliases vs cues | Phi saw only memory text. Cue author (Qwen) and alias author (Phi) are different model families. Hand cues were written before the aliases existed |

## 6. Recommendation

**Hot path, fresh process (A4 §5 steps 2–5):**
1. Build the cue from three parts: **prompt ⊕ previous user turn ⊕ path tokens** from `last_paths` (basename and non-generic dir segments). This is M7. Keep a `c` / `q_prev` source for R2.
2. Candidates: scoped postings, as in A2 §2.2. Rank with **BM25F(subject ×2, text ×1, aliases ×1.5 only once matured)**, k1 = 1.2, b = 0.75.
3. Gate on the top BM25F score ≥ τ_repo, then keep rows ≥ 0.7·top. Here τ = 3.2 (5% point) to 4.1 (strict), but **τ is corpus-specific**. Sleep refits it per repo so that a replayed silence set stays silent: seed hard negatives plus logged prompts that got `ignored` labels.
4. Do not ship "any single df ≤ 5 token admits" (the old `D_rare` rule, and R2's STRONG as specified). It fires on hard negatives. Keep true identifier-shaped tokens (paths, `ERR_*`, flags, version ids) as STRONG. Plain rare words are MEDIUM.
5. No embeddings on this path; lock L6 stands. The new justification is measured: static embeddings cost < 10 ms but lose on quality; bge wins slightly but costs 165 ms cold.

**Daemon (`hookd`, warm), optional:**
- The same lexical pipeline, plus a bge-small int8 arm. Admit a lexical row as above, or a dense row with cos ≥ ~0.72 (δ = 0.04). Order with RRF. Expected +0.01–0.03 recall@4 and slightly better threshold transfer.
- If a daemon runs anyway, a cross-encoder veto (logit < ~3.4 drops) is the strongest silence tool measured (test FIR 0/80). It costs recall (0.39), so use it only to veto dense-only admissions, not lexical ones.

**Sleep:**
- Aliases come from **misses**, as in A4 P4.3: an alias is kept only if it adds hits and causes 0 false injects on the silence replay. Blind doc2query from a 3–4B local model was net-negative on silence or recall depending on the cap, and costs ~4 s/row on an M3 GPU.
- Policy / indirect needs ("get it merged", "set up on a new laptop") are not a retrieval-similarity problem. Semantic scoring got ≤ 0.22 on them.
  - For policies, R6's routes apply: a repo-root **policy pin** with habituation, or an intent trigger keyed on the action verb class (merge / push / open PR / delete / deploy / add dependency).
  - For indirect needs, compile **schema slots** (setup → package manager, node version, env).
  - These are the next experiment. A keyword-class trigger on 5–6 action verbs would likely cover most of the 60 policy cues.

**Re-open L6 only if** a larger held-out set (real prompts, ≥ 300 hard negatives) shows bge-class dense beating BM25F + context by > 0.05 recall@4 at equal test FIR. That is outside today's CIs.

## 7. Caveats and threats to validity

- **Synthetic, small corpus.** One invented repo, 205 live rows, all written by the same author (this agent), who also wrote 476 of the 666 cues. Hand cues may unconsciously track memory wording, or avoid it on purpose (hand `para`). Real stores have messier rows (episodes, tool text), longer prompts, and far more rows. IDF and thresholds will differ; the *relative* findings are the transferable part.
- **The planned LLM author was unavailable.** MiniMax had no balance, so Qwen2.5-3B (cues) and Phi-3.5-mini (aliases) stood in. Both are much weaker than a hosted model. Qwen leaked words into 97% of its "paraphrases", and Phi aliases are generic ("continuous integration", "code quality assurance"). A stronger sleep model could make M3 look better; rerun `gen_aliases_*.py` with a hosted model when available.
- **Small negative sets.** 70 dev / 80 test negatives. One false inject = 1.25 FIR points; FIR CIs are wide ([0.03, 0.14] at 7.5%). "Strict silence" was certified on only 70 dev prompts.
- **Gold is single-annotator** and, for LLM cues, is the single seed memory. Strict precision undercounts useful bullets; the lenient, same-subject precision equalled strict here. Multi-gold indirect cues are hard by construction. Policy golds encode one annotator's judgement of which policy applies.
- **Calibration objective choices.** Utility = r@4 + 0.1·precision, with a coarse grid. Packets average ≤ 1.1 bullets, so recall@6 = recall@4; "soft 4 / hard 6" never binds. A recall-heavier objective would raise indirect recall only by relaxing silence.
- **M0 differences from production.** Rows were loaded with `remember(kind, id)`, not `observe` (which would extract and classify). There was no ledger, no sleep and no SessionStart. One store per scope emulates the L2 cascade, which the real code does not have yet.
- **Latency** was measured on one M3 at low load (load average ≈ 2). Earlier runs under load average 20–30 were 5–10× slower and were discarded. Cold numbers include Bun's TypeScript transpile of the bench script; the Eden import (10.9 ms) dominates M0. At 20k, BM25F index build is in-process; a prebuilt SQLite FTS index (A2 §1) would be ~25 ms.
- **Quality vs runtime implementation.** bge/MiniLM/CE quality numbers use fp32 PyTorch; the timed path is int8 ONNX in Bun (96% top-1 agreement). Model2Vec quality and timing both use the verified TS implementation.

## 8. Reproduce

Scratchpad: `/private/tmp/claude-501/-Users-kaiavnihalani-Downloads-Eden/af5ec543-ea72-43a6-b1e5-cbb5004cc31b/scratchpad/cues/`. It is ephemeral; copy it into the repo if the fixture should be kept.

| File | Role |
|---|---|
| `fixture/memories.psv` → `memories.json` | 214 memories (205 live) |
| `fixture/cues-hand.psv`, `fixture/cues-llm.psv` → `cues.json` | 666 cues with gold, split, author |
| `fixture/aliases.json` | Phi-3.5-mini aliases; `out/aliases-capped.json` holds the df-capped set |
| `build_cues.py` | assemble; grouped dev/test split |
| `gen_cues_qwen.py`, `gen_aliases_phi.py`, `gen_aliases_phi2.py` | LLM authors (local, HF weights under `models/hf`) |
| `lex.ts` | tokenizer, BM25F, trigram, context cue |
| `m2v.ts`, `m2v_ref.py`, `m2v_check.ts` | Model2Vec in TS and its verification |
| `m0.ts` | Eden-today harness (imports repo `src/index.ts`) |
| `features.ts`, `py_features.py` | per-(cue, row) scores → `out/features-*.json` |
| `eval.py <fir> [results.json]` | calibration, test metrics, bootstrap, overlap table → `out/eval-fir{0.05,0.0}.txt`, `out/overlap-fir*.txt`, `out/results-fir*.json` |
| `sanity.ts` | leakage and overlap → `out/sanity.json` |
| `lat/prep.ts`, `lat/cold.ts`, `lat/drive.ts`, `lat/warm.ts`, `lat/q8check.ts` | sleep artifacts, cold spawn ×30, warm, int8 check → `out/cold-latency.json`, `out/warm-latency.json` |

Order: `python build_cues.py && bun features.ts && bun m0.ts && python py_features.py && python eval.py 0.05 && python eval.py 0.0 && bun sanity.ts`. Then, in `lat/`: `bun prep.ts && M0_DIR=<tmp-m0-*/apps_web> bun drive.ts && bun warm.ts`. The Python venv is `.venv` (uv, Python 3.11: model2vec 0.9, sentence-transformers 6.1, torch 2.14).

## Addendum A — action-class triggers for policy memories (2026-09-29, coordinator)

This tests R1 §6's open question: can a keyword trigger on action verbs cover the policy cues that every similarity method missed (≤ 0.22)?

- Script: `benchmarks/memory-cues/policy_trigger.py`.
- The lexicon was written from the 30 policy memory texts plus a generic action taxonomy, **before** scoring. Caveat: the author had seen 12 of the 60 policy cues.
- Each policy memory is compiled to action classes (for example `never merge PRs yourself` → `integrate`). It is injected when a class fires on the cue. There is no similarity score and no threshold.

| Variant | Test policy recall | Test negatives with any inject | Other positive cues gaining a policy bullet | Policy bullets per policy cue |
|---|---|---|---|---|
| Best similarity (R1 §3.1) | ≤ 0.22 | 5–15% | — | ≤ 1 |
| All 24 classes (incl. topical: tests, explain, docs, logs) | 0.55 | 39% | 31% | 1.9 |
| **High-stakes classes only** (integrate, review, complete, commit, branch, history rewrite, stash, deploy, delete, dependency, destructive db, generated files, billing) | **0.47** (0.55 of reachable) | **4%** | 19% | 1.6 |

**Reading.**
- A compiled action trigger doubles policy recall over any similarity scorer, at the same false-inject rate as the tuned lexical gate.
- Its cost is breadth: one fired class pulls every policy in that class (`complete` maps to 5 policies). That needs a per-class cap (≤ 2, ranked by recency of the user's statement) and the ledger's once-per-epoch refractory.
- Topical classes (tests / explain / docs / logs) behave like generic words. They belong to the lexical path, not to triggers.
- The strongest version of this trigger fires on the **tool action**, not the prompt: a PreToolUse `if`-filtered hook on `git merge|gh pr merge|git push|gh pr create|rm -rf|npm i|… ` sees the committal action itself. That is prospective-memory focality (A3 §3.15, R2 §1.5). This fixture cannot measure it because it has no tool events. R6 shows the actions exist, with 17 cross-session PR-policy recurrences.
