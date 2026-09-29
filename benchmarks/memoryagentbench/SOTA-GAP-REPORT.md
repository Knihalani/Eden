# Eden vs SOTA memory systems — adversarial gap report

**Bar:** not “competent RAG.” SOTA versus other solutions, on the exams those solutions actually publish.  
**Date:** 2026-09-16 (benchmark catalog updated same day).  
**Scope:** product `AgentMemory`, bench `BrainMemory`/CLS, and the 2026 exams Eden should actually run (not vendor LoCoMo).  
**This is not a patch list.** It is the honest leaderboard and the only path that can put Eden *first*.  
**What we build:** `docs/MEMORY-PLAN.md`. **How we build (20×4 parallel waves):** `docs/MEMORY-WAVES.md` (also `docs/ROADMAP.md` Arc 9 / Memory waves M1–M20). Competitors: `docs/MEMORY-COMPETITORS.md`. Product locks: any-agent, silent inject, real sleep, silent procedures; bar overall ≥50 on inject, not BM25 41.5.

---

## 0. What “SOTA” is allowed to mean

There is no single number. Vendors mix exams. Eden has mixed objects. If a claim cannot name **exam + metric + length + k + backbone + API under test**, it is not SOTA.

| Arena | Exam | Current SOTA (cite this) | What “Eden is SOTA” requires |
|---|---|---|---|
| **A. Memory-agent overall** | ICLR 2026 MemoryAgentBench Table 3, GPT-4o-mini RAG/memory rows | **HippoRAG-v2 41.6** ≈ BM25 **41.5**. Next dense RAG: Qwen3-Emb-4B **38.2** | **> 41.6 overall** on the **official protocol** (k=10, 512/4096 chunks, reader metrics, longest lengths). Tying BM25 is not SOTA. |
| **B. Absolute Table 3** (includes long-context) | same table | **GPT-5-mini 60.6**, Claude-3.7 **49.6**, GPT-4o **48.8** | **> 49.6** to beat every non-reasoning long-context; **> 60.6** to beat GPT-5-mini. RAG-only cannot do this without an LRU/TTL path that is not top-k. |
| **C. Selective forgetting** | Table 3 FC-SH/MH **262k** | Table 3: HippoRAG **54 / 5**. **Post-May 2026 SOTA:** structured assembly **82 / 27** (4o-mini @262k), **93 / 41** (4o) ([arXiv:2606.01435](https://arxiv.org/abs/2606.01435)) | **≥ 82 SH and ≥ 27 MH** at 262k, same backbone. HippoRAG 54 is obsolete as the SF bar. |
| **D. Conversational judge** | LoCoMo-10 J | Vendor: Mem0 Cloud **92.5**, others 88–96. Independent: paper OSS Mem0 **~67**, Zep corrected **75.1**, AutoMem **84.7**. Audit: label errors **6.4%**, judge accepts **63%** of wrong topical answers, ceiling **~93.6%** | Run **the same judge protocol**. Beat **independent** SOTA (~75–85), not a self-reported 92. Retrieve@5 45% is not this exam. |
| **E. Chat long-memory** | LongMemEval (V1) | Vendor Mem0 **94.4**, Hindsight **94.6**, Zep **71.2**, independent Mem0 **44–74** | Same judge, same split (S vs S*). Table 3 LME(S*) memory-agent SOTA is HippoRAG **50.7** / TE3-L **50.3**. |
| **F. Agent-trajectory memory (2026)** | **LongMemEval-V2** | **AgentRunbook-C 74.9%** small / **70.1%** medium; Codex **69.9 / 68.7**; RAG slice **42.8 / 38.1** | File-based coding-agent memory controller + latency. Eden has **zero** LME-V2 path. This is the exam that matches “coding agent sidecar.” |
| **G. Product coding memory** | No public standard. Closest: LME-V2 + a locked coding-holdout on the **inject/hook** path | AgentRunbook-C / Codex-as-memory | Hook `notesFor` remembers flakes, ADRs, file rules, tool failures, versions. **Unmeasured today.** |
| **H. Scale (chat, not code)** | BEAM ICLR 2026 1M / 10M | Mem0 vendor **64.1 / 48.6**; LIGHT +3.5–12.7% over paper baselines. Unsaturated. | Official BEAM-1M first; 10M only after ingest exists. |
| **I. Execution-graded coding** | Terminal-Bench 2.1 **Δ vs locked harness** | Public ~83–87% is the *agent*. Memory claim is **+pts / −tokens**. Proactive Memory +8.3 on Sonnet, +2.4 on Opus. | Same model, k=5, Harbor-verified. Absolute % is a trap. |

**Forbidden comparisons**

- Retrieve@40 ICL vs Table 7 MCC @ k=10.
- EventQA-64k vs Table 3 EventQA-**534k**.
- Fact 6k vs Table 3 **262k**.
- `goldHit` retrieve@5 vs Mem0 Cloud 92.5 J.
- HCM bakeoff vs current CLS `BrainMemory`.
- `BrainMemory.retrieve` vs what Claude Code sees (`AgentMemory`).
- Long-context GPT-5-mini 60.6 vs a JSONL BM25 without saying so.

---

## 1. Executive verdict

Eden is **not SOTA on any arena**.

- Versus **memory agents** on the only shared multi-competency exam (Table 3): not run at protocol. Architecture is **Simple RAG** (BM25 class). That class’s ceiling is **41.5**, 0.1 behind HippoRAG. A BM25 clone cannot be SOTA. HippoRAG took AR (65.1 vs 60.5) and SF (29.5 vs 25.5) and paid TTL (35.8 vs 44.5). **SOTA is the system that stops paying that tax.**
- Versus **long-context**: Claude 49.6 / GPT-5-mini 60.6 win TTL+LRU. Top-k RAG is the wrong tool for LRU (GraphRAG summ **0.4**, HippoRAG **14.6**, BM25 **19.0** vs Claude **52.5** / GPT-5-mini **56.3**).
- Versus **Mem0/Zep/Hindsight on LoCoMo**: different metric; Eden never ran J; evidence ceiling HCM @50 is **57%**, which cannot support 92% without a generous judge.
- Versus **2026 agent memory (LME-V2)**: not a competitor. The leader is a **coding agent walking files**, which is closer to Codex than to CLS comments.
- Versus **the product it ships**: extract drops `Please fix the flake`; tools are never observed; `BrainMemory` is not on the hook.

The previous “be competent = match BM25 41.5” target is **losing**. SOTA among memory agents in 2026 is either HippoRAG **41.6** (stale SF) or, if you take the assembly paper, a stack that can push **overall toward ~50** by actually solving SF while keeping HippoRAG AR and BM25 TTL. That **would beat Claude 49.6** without a 400k window. That is the only Table 3 path that is SOTA vs *both* memory agents *and* non-reasoning long-context.

---

## 2. Integrity: three systems, one brand

| Object | Path | Used by | Status |
|---|---|---|---|
| Product `AgentMemory` | `src/index.ts` | wrap, Claude hook, `processMemory()` | **What ships.** Regex extract, JSONL, lexical `notesFor`, k=6 unlabeled bullets. |
| Bench `BrainMemory` | `src/brain-memory.ts` | MAB, bakeoff `BrainProduct`, archived coding-holdout | CLS adapter. MAB sets **`cortex: false`**. |
| Bakeoff `HcmSys` | `benchmarks/memory-bakeoff/brain/systems.ts` | Sep 8 RESULTS.md | RRF; `sem` double-counted; dates stamped into turns. **Not** current `brain-memory.ts`. |

`openBrainMemory` was deleted. RESULTS still cites it. CLS landed after the HCM bakeoff. Evaluating the unused object is how you fake progress.

---

## 3. ICLR Table 3 — full adversarial grid

All RAG / memory agents: **GPT-4o-mini** unless noted. Overall = mean of four competency averages, not mean of 10 leaves.

| Method | SH | MH | LME | EventQA | AR | MCC | Rec | TTL | Summ | DetQA | LRU | FC-SH | FC-MH | SF | **Ov** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **GPT-5-mini LC** | 85 | 71 | 63.3 | 78.2 | 74.4 | 84 | 13.2 | 48.6 | 56.3 | 76.1 | 66.2 | 78 | 28 | 53.0 | **60.6** |
| Claude-3.7 LC | 77 | 53 | 34 | 74.6 | 59.7 | **89.4** | **18.3** | **53.9** | 52.5 | 71.8 | 62.2 | 43 | 2 | 22.5 | **49.6** |
| GPT-4o LC | 72 | 51 | 32 | 77.2 | 58.1 | 87.6 | 12.3 | 50.0 | 32.2 | **77.5** | 54.9 | 60 | 5 | 32.5 | 48.8 |
| GPT-4.1-mini LC | 83 | 66 | 55.7 | **82.6** | 71.8 | 75.6 | 16.7 | 46.2 | 41.9 | 56.3 | 49.1 | 36 | 5 | 20.5 | 46.9 |
| GPT-4o-mini LC | 64 | 43 | 30.7 | 59 | 49.2 | 82 | 15.1 | 48.6 | 28.9 | 63.4 | 46.2 | 45 | 5 | 25.0 | 42.2 |
| **HippoRAG-v2** | **76** | **66** | **50.7** | 67.6 | **65.1** | 61.4 | 10.2 | 35.8 | 14.6 | 57.7 | 36.2 | 54 | 5 | **29.5** | **41.6** |
| **BM25** | 66 | 56 | 45.3 | **74.6** | 60.5 | **75.4** | 13.6 | 44.5 | **19.0** | 52.1 | 35.6 | 48 | 3 | 25.5 | **41.5** |
| Qwen3-Emb-4B | 57 | 47 | 43.3 | 71.4 | 54.7 | 78.0 | 12.2 | 45.1 | 14.8 | 59.2 | 37.0 | 29 | 3 | 16.0 | 38.2 |
| TE3-Large | 54 | 44 | 50.3 | 70 | 54.6 | 72.4 | **16.2** | 44.3 | 18.2 | 56.3 | **37.3** | 28 | 4 | 16.0 | 38.0 |
| MIRIX (4.1-mini) | 73 | **75** | 51 | 53 | 63.0 | 61 | 10.3 | 35.7 | 18.9 | 62 | 40.5 | 20 | 3 | 11.5 | 37.7 |
| MemGPT | 41 | 38 | 32 | 26.2 | 34.3 | 67.6 | 14.0 | 40.8 | 2.5 | 42.3 | 22.4 | 28 | 3 | 15.5 | 28.3 |
| MIRIX (4o-mini) | 62 | 61 | 37.3 | 29.8 | 47.5 | 38.4 | 9.8 | 24.1 | 9.9 | 40.8 | 25.4 | 14 | 2 | 8.0 | 26.2 |
| Zep | 44 | 25 | 38.3 | 42.5 | 37.5 | 62.8 | 12.1 | 37.5 | 4.2 | 28.2 | 16.2 | **7** | 3 | 5.0 | 24.0 |
| GraphRAG | 47 | 47 | 35 | 34.4 | 40.9 | 39.8 | 9.8 | 24.8 | **0.4** | 39.4 | 19.9 | 14 | 2 | 8.0 | 23.4 |
| Mem0 | 25 | 32 | 36 | 37.5 | 32.6 | 32.4 | 10.0 | 21.2 | 4.8 | 36.6 | 20.7 | 18 | 2 | 10.0 | 21.1 |
| **Assembly (not in Table 3)** | — | — | — | — | — | — | — | — | — | — | — | **82** | **27** | **~54.5** | — |

**Table 7 MCC (the TTL leaf that dominates TTL avg):** Claude 97/98/86/87/79; GPT-4o-mini LC 93/93/87/73/66; BM25 89/89/84/62/53; Qwen3-Emb 90/88/86/67/59; HippoRAG **81/86/73/38/29**; Mem0 **35/37/35/29/26**. TREC-fine is the graveyard. GraphRAG TREC-F **6**.

**Main-table lengths (do not mix):** EventQA **534k**, FC **262k**, SH-QA **197k**, MH-QA **421k**, LME(S*) **355k**, MCC **~103k**, Recsys **1.44M**.

**Eden’s measured substitutes (not Table 3):** ICL retrieve@40 75–100% with top-1 mean **56.6**; Fact MH top-1 **~1%**; EventQA-64k reader 78.4 (wrong length); EventQA-full reader 53 (lose to BM25 74.6); RULER qa1 retrieve 100%@12 (wrong metric). **Zero official overall.**

---

## 4. Adversarial comparison: every serious competitor

### 4.1 HippoRAG-v2 — the memory-agent overall champion

**What it is:** OpenIE triples + NV-Embed-v2 + Personalized PageRank + DSPy fact filter. Construction is **hours** (Table 12: tens of thousands of seconds).  
**Wins:** SH 76, MH 66, LME 50.7, FC-SH 54, AR avg **65.1**, SF avg **29.5**, overall **41.6**.  
**Loses:** MCC 61.4 (graphs scramble ICL labels), EventQA 67.6 vs BM25 74.6 (structure hurts novels), Recsys 10.2, Summ 14.6.  
**Vs Eden:** Eden has no OpenIE, no dense, no PPR. `complete()` is 3 BM25 rounds on `#entity` tags. Calling CLS “hippocampal” next to HippoRAG is unpaid marketing.  
**To beat them overall:** keep BM25/Qwen TTL (you need MCC ~75+), **do not GraphRAG ICL**, match HippoRAG AR (dense+associative on 512-token chunks), **replace their SF with assembly (82/27)**. That is a different product than “better stemmer.”

### 4.2 BM25 — the embarrassing ceiling

**What it is:** LangChain BM25, paper chunk map, k=10, GPT-4o-mini reader. Construction is seconds.  
**Wins:** EventQA **74.6** (best memory-agent), MCC **75.4**, Summ **19.0** (best RAG), overall **41.5**.  
**Lesson the paper states:** RAG beats 4o-mini LC on AR needles; loses TTL and LRU to LC; Mem0-style extract **destroys** TTL.  
**Vs Eden:** Eden is this class with worse documents (2000-char packs, k=40 ICL, fuse that buried gold). If Eden loses to this baseline on the same chunks, CLS is **negative value**. SOTA is **not** matching it.

### 4.3 Dense embedding RAG (Qwen3 / TE3)

Overall **38.0–38.2** — **below** BM25. TE3-L wins Recsys 16.2 and LME 50.3. Qwen3 wins MCC among embedders (78).  
**Vs Eden:** no vectors at all. Adding embeddings without a router will **not** automatically beat HippoRAG; the table already ran that experiment. Hybrid BM25+dense is the missing lane, not a replacement for store-all ICL.

### 4.4 Mem0 — the LoCoMo poster, the MAB disaster

**Table 3 overall 21.1.** MCC **32.4** because LLM extract **drops ICL labels**. EventQA 37.5, FC-SH 18, construction **~20,000× BM25**.  
**Vendor LoCoMo 92.5 / LME 94.4** = managed stack, large k, answerer+judge. Paper OSS J **~66.9**. Independent LME-S **44–74**.  
**Vs Eden:** opposite architecture (lossy extract vs store-all). Copying Mem0 extract into MAB **will lose TTL**. Copying Mem0 Cloud protocol without their extract+k+judge **will not get 92**.  
**What to steal:** typed ADD/UPDATE/DELETE for **facts that are actually facts**; never for exemplars or novels.

### 4.5 Zep / Graphiti — temporal KG that fails the temporal exam that MAB wrote

Table 3: overall 24.0, **FC-SH 7** (worst in the table), FC-MH 3, EventQA 42.5, MCC 62.8.  
Own benches: DMR, LME ~71 (gpt-4o). LoCoMo: Mem0 paper 66 Zep; Zep’s correction **75.14**.  
**The assembly paper’s point:** bi-temporal edges do not help if **assembly** still asks the LLM to pick the fresh value.  
**Vs Eden:** no graph, no validity intervals. `subjectKey` is worse than Graphiti (it **deletes**). Do not build a Zep clone expecting Table 3 SF to move.

### 4.6 Letta / MemGPT — the loop Eden does not have

Overall 28.3. MCC **67.6** (working memory helps ICL more than Mem0). Summ **2.5**.  
Memory is **in the agent**: core blocks, archival search, tools.  
**Vs Eden:** silent system bullets; the coding agent cannot `memory_search`. lastk analogue on LoCoMo **1.3%**. Product TCM dies every Claude hook process.  
**What to steal:** memory as tools + persisted working memory. Not their Table 3 overall.

### 4.7 MIRIX — coordinator + six stores

4o-mini overall 26.2. **4.1-mini overall 37.7**, MH-QA **75** (best memory-agent MH-Doc). Backbone-sensitive (paper: +9.7 when upgraded). Hours of construction.  
**Vs Eden:** `atomize()` is a format detector, not six memories.  
**What to steal:** **competency router** (ICL vs needle vs overwrite vs summary vs dialogue). Not six ontologies.

### 4.8 RAPTOR / GraphRAG / MemoRAG — structure that loses

RAPTOR overall 27, GraphRAG 23.4, MemoRAG 30.9. GraphRAG ∞Bench-Sum **0.4**. EventQA: GraphRAG 34.4, RAPTOR 45.8 vs BM25 74.6.  
**Do not GraphRAG novels.** The paper already killed that path.

### 4.9 Structured assembly (arXiv:2606.01435) — the actual SF SOTA

Not a full memory product. Pipeline: BM25 retrieve k=10 → LLM **extracts candidates** → Python **max(serial)** (CAR = Self-Ask + per-hop max).  

| | 4o-mini @262k | 4o @262k | Table 3 best |
|---|---:|---:|---:|
| FC-SH | **82** | **93** | HippoRAG 54 / GPT-4o LC 60 / GPT-5-mini 78 |
| FC-MH | **27** | **41** | all 4o-mini agents ≤7 / GPT-5-mini 28 |

v2: most of the gain is **separating extraction from answering**, not max() itself (+2 pp executor-only, **0 pp at 262k**). Prior-override (Finland → ice hockey) and serial-drift at long context are the LLM failure modes.  
**Vs Eden:** supersession leaves old facts at 0.45× and `complete()` re-boosts them. Retrieve@24 containing both values is the **failure mode** this paper measures. MH top-1 ~1% is hop-1 sitting in slot 1.  
**This is the SF steal.** Without it, Eden cannot be SOTA on SF, period.

### 4.10 Long-context models — the other SOTA

They win TTL (Claude MCC **89.4**, banking **97**) and LRU (GPT-5-mini summ **56.3**, LRU avg **66.2**). GPT-5-mini FC-SH **78** / MH **28** — reasoning helps MH at 400k. Recsys still ~13–18; memory is not a recsys.  
**A memory company that only does top-k will never beat 60.6 overall.** A memory company that **routes LRU/TTL to long-context or hierarchical summary, and wins AR+SF as a memory layer**, can beat **Claude 49.6**.

### 4.11 LoCoMo vendor club (Mem0, Hindsight, AutoMem, ByteRover, ZeroMemory)

Self-reported 84–96 J. Audit ([locomo-audit](https://github.com/dial481/locomo-audit)): **99/1540 score-corrupting GT errors (6.4%)**; judge accepts **62.81%** of intentionally wrong topical answers. Practical ceiling **~93.6%**. No shared pipeline. EverMemOS, Mem0 issues, Zep scoring fights.  
Eden: retrieve@5 **32–45%** token-AND; cat2 **~10%**; HCM @50 **57%** evidence ceiling; `locomo-judge.ts` **does not exist**.  
**SOTA here is not 92.** SOTA is: independent protocol, beat Zep-corrected **75** and AutoMem **85**, disclose judge. Anything else is marketing.

### 4.12 LongMemEval-V2 + AgentRunbook-C — the 2026 coding-agent exam

Haystacks up to **115M tokens**, 451 questions, web+enterprise **agent trajectories** (not chat). Score = accuracy **and** latency (LAFS).  

| Method | Small | Medium |
|---|---:|---:|
| No retrieval | ~0 | ~0 |
| RAG query→slice | 42.8 | 38.1 |
| + notes | 51.0 | 45.9 |
| AgentRunbook-R | 58.6 | 57.0 |
| Codex | 69.9 | 68.7 |
| **AgentRunbook-C** | **74.9** | **70.1** |

AgentRunbook-C: store trajectories as **files**, coding agent + workflow doc + manifests + helper scripts collects evidence. That is SOTA **agent** memory.  
Eden wrap `coding.ts` is a **bash jail** (execution sandbox), not a memory controller. Hook never observes `PostToolUse`. Extract drops fences and `git `. **Product is anti-LME-V2 by construction.**

---

## 5. Product path (what must be SOTA for a coding-agent company)

Live API: `AgentMemory` via wrap + `packages/cli/src/memory-hook.ts`. `MEMORY_EVENTS` = UserPromptSubmit, SessionStart, PreCompact, Stop, SessionEnd. **Not tools. Not SubagentStop** (plugin lists it; hook ignores it).

**Write failures (vs AgentRunbook / Mem0 / Letta)**

- `please` / `fix the` / `we need to` / fences / `git ` / `bun ` dropped.
- Tool traces never stored. Test failures unremembered.
- Allow-list is SaaS trademarks + copula + `looksNarrative`.
- Cap 2000 JSONL, no lock, last writer wins.
- `subjectKey` deletes `Auth is Clerk` when `Auth is failing`.
- Kinds `preference`/`procedure` exist and are never written.

**Read failures**

- `notesFor(entire window)`, k=6, unlabeled.
- SessionStart = last constraints, not task-relevant rules.
- OpenAI: retrieve-then-observe; Anthropic: observe-then-retrieve.
- `pathCues` drops dotted filenames → **no `auth.ts` key**.
- Prospective = 2 BM25 slots, not PreToolUse.
- Episode TCM is RAM; Claude hook is a new process per event.
- Fail-open: throw → silent amnesia.
- Know inject = encyclopedia silence tests, not repo ADRs.

**Coding-holdout:** written, **never scored**, archive import broken. Locked conversational holdout: **47 miss / 36 junk / 30 losses / 62% multihop miss**. README “coding sidecar: yes” is 28/29 Kai-timezone cases.

A SOTA coding memory looks like AgentRunbook-C’s *idea* applied to Claude Code: files + symbols + tool traces + rules that fire **before the tool**, plus CLS/assembly for facts. Eden implements the inverse: drop the traces, inject 6 lexical bullets.

### 5.1 What `relevant()` actually computes (`src/index.ts`)

This is **not BM25**. There is no term frequency and no length norm. It is binary IDF overlap on a LoCoMo-shaped query bag, then pins written for the whatever-loop.

**Query bag** (`queryHay`, 171–184): tokenize, drop `QUERY_SKIP`, then **inject LoCoMo hay**: `diet` from restaurant words; `child`/`kid` from childhood; `country`/`city`/`town` from where+moved; pets; `running` from shoes; `glass`/`stained` from church windows; `adoption` from summer plans. A `watch` file-watcher question still takes the **movie** bonus path via `noteBonus` (`qf.movie`).

**IDF** (684), Robertson-style, **binary**:

```
idf(x) = ln((N − d + 0.5) / (d + 0.5) + 1)
if d/N < 0.04: idf *= 1.55
score = Σ idf(lex) + min(0.8 * Σ idf(ctx)*w, 9) + (base>0 ? 0.5*sal : 0) + noteBonus
```

If `base === 0`, salience and extras are **zero**. A `sal === 1` rule with no query-term overlap never surfaces. That is the opposite of prospective memory except for the later reserved slots.

**`noteBonus` (40–58)** — product inject still boosts: quoted titles +2, books/movies/songs +1.5, `favorite` +1, speaker labels +3, quantities +1.5, “how” +1.5, intent verbs +3, where +2.5. These are **personal-QA fixtures in the coding sidecar**.

**Reinstatement (696–700):** top-2 scored records that have `ep` spread

```
n += 2.5 * (1 + 1 * sal)   // defaults; up to +5.0
```

onto every other record that already had `base > 0` and the **same episode id**. That delta is larger than most IDF sums. On the **hook**, `ep` is a new uuid every process (`openMemory` per event, 51), so reinstatement **does not fire across turns**. Wrap’s `processMemory()` singleton *does* keep `ep` for the proxy lifetime — wrap memory is accidentally better than the advertised Claude plugin.

**Then, in order:** `fuseOnce` (concatenate up to 5k chars of same-term sentences into a fake `fuse:` id that is **not persisted**) → Jaccard 0.6 dedup → **`pinEnvFact`** (hardcoded CircleCI / GitHub Actions / Buildkite / `staging.example` if the query looks like “set up ci”) → “how did we fix” pin → log-policy pin → prospective reserve.

**Prospective (721–736):** not mixed into the score. After lexical, reserve `min(2, floor(cap/3))` = **2 of 6** slots if cue IDF ≥ `ln(3)*0.5 ≈ 0.549`. Cue kinds: alternatives 1.2, commit/path 1, subject 0.6, leftover stems 0.5. If lexical already filled with Jaccard-similar text, the rule is skipped.

**Empty query** (`notesFor("")`, SessionStart): last k constraints concatenated with last k others on the **eviction-ordered** array, not ranked. After the 2000 cap, that order is pinned-by-`at` then unpinned-by-`at`, so SessionStart can brief **newest unpinned facts**, not rules.

### 5.2 Persist, lock, restart

`persist()` (652–654): `memories.jsonl`, **hard 2000**, not `EDEN_MEMORY_CAP` (that is retrieve k, default 6; `0` falls back to 6). Pin = `kind==constraint` **or** `cues.length>0` **or `sal >= 1`**. `SAL_WEAK = 0.6` is **not pinned**. Comment 413–419 (“salience exempts eviction”) is false for 0.6.

Serialized: `id, text, kind, tags, agent, project, at, ep, ctx, sal`. **Not serialized:** compiled needles, cue list (WeakMap), EpisodeContext, `lastWin`, fused notes, `retrieveText` expansions.

Cues: `WeakMap<MemoryRecord, string[]>` (410–411). Survive restart **only** because `load()` re-runs `deriveCues(text)`. `notesFor` clones records (`{...r, text: retrieveText}`) — the clone misses the WeakMap; they correctly test `cuesOf(r)` on the original. Anything that JSON-roundtrips a record without `compile` runs `retrieveText` on **rules** (`never` → numeral/yes stuffing).

**No file lock.** Hook `events.jsonl` uses `withFileLock`; memory does not. Two UserPromptSubmit processes last-write-wins. Crash mid-`writeFileSync` tears the JSONL; `load()` swallows bad lines. `mode: 0o600` only on **create**.

Ghost APIs: plugin README `GET /forget?id=` / `EDEN_MEMORY_HOST` / `:8787` — **zero code** in current `src/index.ts`. `kind==="digest"` is filtered (661) and never written.

### 5.3 Three inject pipelines (same product, three causal orders)

| | OpenAI wrap `injectBody` | Anthropic `withKnowFactsAnthropic` | Claude hook Submit/PreCompact |
|---|---|---|---|
| Call site | `proxy.ts:176,193` | `anthropic.ts:258` | `memory-hook.ts:74` via `hook.ts:275` |
| Rank blob | **all** messages (`convBlob`) | **system + last 8**, 16k cap | transcript **40** + prompt |
| Order | **notesFor then observe** | **observe then notesFor** | same as OpenAI `inject` |
| This-turn fact in this request? | **No** | **Yes** if extractable | **No** |
| Skip if mark present | skip inject, **still observe** | **return, no observe** | usually no mark in transcript → re-inject every turn |
| Store | `processMemory()` singleton | same | **`openMemory()` per event** — `lastWin` always `[]` |
| Extra | observes `body.system` as **`role: user`** (765–766) | — | Stop/SessionEnd observe-only; SessionStart `notesFor(extra)` |

`inject` catch: `{ return list }` — ranker throw → **silent amnesia**.

`EDEN_KNOW=0` does **not** disable AgentMemory. Tests that “silent chat does not inject” pass because those fixtures fail `extractDurable`, not because memory is off.

`processMemory()` in `*.test.ts` opens a **new random tmpdir per call** (785) — wrap tests cannot persist memory even if they tried. Live OpenAI path is `injectBody`, not `withKnowFacts` (the function the tests call).

PostToolUse (`hook.ts:280+`): stretch/transparent only. **Never `observe`.** Plugin `SubagentStop` is in `hooks.json`; `MEMORY_EVENTS` omits it. Direct `scripts/hook.ts` → `{}`.

### 5.4 Product call sites (the only ones that matter)

| file:line | what |
|---|---|
| `src/index.ts:657–737` | `relevant` |
| `src/index.ts:739–745` | `notesFor` + `retrieveText` |
| `src/index.ts:747–767` | `inject` / `injectBody` |
| `src/index.ts:779, 784–785` | `openMemory` / `processMemory` |
| `packages/cli/src/memory-hook.ts:44,51,69,74` | briefing, open, observe, inject |
| `packages/cli/src/hook.ts:275,363` | Submit/Start/PreCompact vs Stop; **not PostToolUse** |
| `packages/wrap/src/proxy.ts:176,193` | OpenAI `injectBody` |
| `packages/wrap/src/anthropic.ts:258` | Anthropic observe-then-rank |
| `packages/wrap/src/know-inject.ts:54,70–72` | `withKnowFacts` (tests / unused by proxy) vs Anthropic live |

`BrainMemory.retrieve` is **not** on this list. Benches that import it are not the product.

**Env that actually exist:** `EDEN_MEMORY_DIR`, `_AGENT`, `_PROJECT`, `_CAP` (k not store), `EDEN_PROSPECT_SLOTS/MIN`, `EDEN_SAL_BOOST`, `EDEN_CTX_W/CAP`, `EDEN_REINSTATE`, `EDEN_SAL_REINSTATE`. `EDEN_MEMORY_HOST` is dead.

---

## 6. CLS / BrainMemory — why it cannot be SOTA as-is

- Fuse: independently max-normed lanes; cortex **1.05**, semantic **0.6**. Dead semantic hits bury BM25 (already happened on ICL).
- ICL “wins” required **turning CLS off** (no semantic, no complete, no neighbors, k=40, diversify). That is a kNN classifier, not a memory architecture.
- Semantic: copula regex; lookup ignores frames; no `(s,p,o,serial)`.
- Supersession: episode overlap, old fact ×0.45, complete re-inflates. Not LWW.
- `complete()` ≠ PPR. MH top-1 ~1%.
- EXPAND/QUERY_LIGHT were unstemmed keys into a stemmed index (spouse→`spous`). Bench knobs in the product stemmer (`-ship` collateral).
- Rebuild-all ingest. Paper protocol is incremental `c1…cn`.
- No embeddings, no rerank, no summary tree, no recsys profile, no agent loop.
- Official k=10 vs Eden ICL k=40; official 512 vs 2000-char packs.

**Net:** BM25-on-atoms plus flags that disable the story when it hurts the headline.

### 6.1 Fuse inversion (worked numbers)

`scores()` (`src/cls/controller.ts:104–142`): independently min-max each of BM25 `a`, semantic `b`, cortex `c` to 1, then

```
v = a + 0.6*b + 1.05*c + 0.15*(lanes-1)
fused = v * (1 + 0.06 * i/(n-1))   // recency unless disabled
```

Example, n=11, recency on:

- **G** (true BM25 winner, no compiled fact) at i=0: a=1, b=0, c=0 → fused **1.000**
- **B** (max semantic, mediocre BM25) at i=10: a=0.4, b=1, c=0, 2 lanes → (0.4+0.6+0.15)*1.06 = **1.219**

**G loses.** `lookup` is anchor overlap only (`#kai` +2). Query “What timezone is Kai in?” can give the entire semantic lane to “Kai lives in Seattle” while “Never put secrets in the timezone file” never compiles (no copula). Cortex `canon` keys the **first 24 chars** of the body — two chairperson facts collide. Supersession then `fused[old] *= 0.45` instead of zero, so the stale line stays in top-k.

The ICL unit test **disables semantic and complete**. That is the admission this combiner is poison on TTL.

### 6.2 Semantic compile: what never becomes a fact

A sentence is a fact only if: split on `[.!?;]`, length ≥6, not a question, hits the copula/relation list, and has a **typed value** (time, money, weekday, alphanum **code with digit+letter**, number, or `[A-Z][a-z]{2,16}` name). Silent drops:

- “Never console.log in production” / “Always run tests before committing”
- “We decided on sqlite over postgres” (`decided` not in the compile verb list; `chose` is only in CHANGE)
- “The database is postgres” (lowercase slot, no proper name, no digit)
- “became CEO” (`became` not in compile verbs)

`lookup` then **ignores frames and values**. CHANGE includes `now`, `new`, `later`, `longer`, `will be` — chatter plus one shared stem can `supersededBy`. Missing: `rolled back`, `reverted`, `deprecated`, `cut over`.

### 6.3 `complete()` is not a 3-hop graph

Three rounds, hop only on the **single rarest `#` entity**, require a new `#` on the neighbor. Author→spouse→citizen: if the seed episode’s rarest tag is the book title (`#dune`, df=1), hops need that tag — marriage/citizenship episodes do not have it — fallback is **next BM25 rank**, not the chain. Title tokenization (“Our Mutual Friend” → `#our #mutual #friend`) makes this the default. The Belgium unit test uses k=8 on 8 facts and can pass because the gold is already in the BM25 window.

Product wrap **never calls `complete()`**.

---

## 7. The arithmetic of actually being SOTA

Table 3 overall = `(AR + TTL + LRU + SF) / 4`.

| Stack | AR | TTL | LRU | SF | Overall | Beats |
|---|---:|---:|---:|---:|---:|---|
| HippoRAG today | 65.1 | 35.8 | 36.2 | 29.5 | 41.6 | all 4o-mini memory agents |
| BM25 today | 60.5 | 44.5 | 35.6 | 25.5 | 41.5 | Mem0/Zep/Letta/MIRIX-4o |
| 4o-mini LC | 49.2 | 48.6 | 46.2 | 25.0 | 42.2 | HippoRAG by LRU+TTL |
| Claude LC | 59.7 | 53.9 | 62.2 | 22.5 | 49.6 | all memory agents |
| GPT-5-mini LC | 74.4 | 48.6 | 66.2 | 53.0 | 60.6 | everyone |
| **Eden if CLS-only** | ~60 | ~40 | ~20 | ~15 | **~34** | nobody serious |
| **SOTA memory layer (steal)** | **≥65** HippoRAG AR | **≥45** BM25/Qwen TTL | **≥46** LC-class LRU *or concede and don’t average* | **≥54** assembly SF | **≥52** if LRU routed; **≥50** even with RAG LRU ~36 | HippoRAG, BM25, 4o-mini LC, **Claude 49.6** if LRU is routed |
| **vs GPT-5-mini** | need ~74 | ~49 | **~66** | ~53 | **~60** | requires LC or map-reduce on LRU; memory-only will not |

**Implication:** SOTA vs *other memory solutions* is **overall ≥ 50** on Table 3 protocol with 4o-mini (or better backbone disclosed), which is: HippoRAG-class AR + BM25-class TTL + assembly SF + **an LRU strategy that is not BM25**. SOTA vs GPT-5-mini is a **router that uses a long-context/summary model for LRU**, not a better hippocampus comment.

TTL vs Claude 97 banking is the remaining long-context fortress. A linear probe / small classifier on retrieved exemplars is the only RAG-shaped attempt; full-context still wins unless you *are* the context.

---

## 8. Path to SOTA (not to competence)

Order is load-bearing. Skipping to CLS poetry is how you got ICL@40.

### Gate 0 — One scoreboard, official protocol

Four columns, never mixed:

1. **MAB Table 3 protocol** (k=10, paper chunks, reader, 534k/262k/197k/421k, LME judge, InfBench judge, Recsys R@5, **no `label:` strip**).
2. **LoCoMo J** (answerer+judge, k disclosed, independent prompt).
3. **LME-V2** small tier (accuracy + latency).
4. **Coding-miss on `openMemory` / hook inject** (file rule, ADR, flake, version, junk).

Until (1) exists, do not say SOTA. Until (4) exists, do not say product SOTA.

### Gate 1 — Product = the object (coding-agent SOTA)

This is the company. LME-V2 already told you the winner looks like a **file-aware coding agent**, not JSONL BM25.

1. Observe **user, assistant, tools, test exits, git sha**. Kill the `please`/`fix the`/fence gate.
2. Typed store: rule / decision / file_fact / incident / symbol, with `files[]`, `supersedes`, `as_of`.
3. Index: path+symbol+lexical+dense. `auth.ts` is a key.
4. Retrieve from **current turn + open files + pending tool**, labeled, cited.
5. Prospective = **PreToolUse** (commit, `generated/**`).
6. Overwrite = typed slots, not `subjectKey`.
7. Persist session ids across hook processes.
8. `memory_search` / `memory_write` tools (Letta), not only silent bullets.
9. **One** `notesFor`. CLS fusion either lives here or is a bench toy.

Acceptance: coding-holdout on inject path; commit surfaces test rule; ADR survives paraphrase; Node 16→18 newest wins without deleting “CI”; tools persist.

### Gate 2 — Steal HippoRAG AR without stealing HippoRAG TTL tax

- Store-all 512-token chunks for RULER/LME/facts.
- Hybrid BM25 + dense (NV-Embed or Qwen3-Emb).
- Multi-hit fusion for MH-Doc (k=10, not complete-as-PPR).
- **ICL is a separate index:** atomic exemplars, **no** graph, **no** extract, diversity at k=10. Target Table 7 **≥ Qwen3 90/88/86/67/59**, then **≥ BM25 89/89/84/62/53**, then chase Claude with a classifier head on retrieved labels. TREC-F is the SOTA gate.
- EventQA: lexical continuation at **534k**; do not structure the novel. Target **≥ 74.6**.
- Recsys: user-profile object or **drop TTL avg claims**.

If this loses to LangChain BM25 on identical chunks, stop.

### Gate 3 — Steal SF SOTA (assembly), not HippoRAG 54

Obsolete target: HippoRAG 54/5. Live target: **82/27 @262k 4o-mini**.

1. Fact-level chunks with serial.
2. Retrieve k=10.
3. LLM extracts `(s,p,o,serial)` candidates only.
4. Python `max(serial)` per `(s,p)`. Tombstone old rows so the reader cannot see them.
5. FC-MH: CAR / Self-Ask, **max per hop**, return last hop’s value first.
6. Product overwrite uses the same primitive (`max(timestamp)`), not `subjectKey`.

This single gate can lift SF avg from ~25 to **~54**, which is **GPT-5-mini’s SF (53)** and the biggest Table 3 delta available to a memory company.

### Gate 4 — LRU: route or lose SOTA vs Claude

Options that can still be SOTA:

- Hierarchical map-reduce / RAPTOR-like **only for Summ+DetQA**, knowing RAPTOR lost as a *general* agent.
- Long-context call for those two tasks (competency router). Cost is the product decision.
- **Do not** average a 19.0 Summ into a vanity overall and call it SOTA.

Combined with Gate 2–3, routed LRU ≥46 yields overall **≥ 52**, which **beats Claude 49.6** and every memory agent.

### Gate 5 — LoCoMo J after evidence exists

Only when retrieve@20 contains gold for cat1–3, not date-token scatter:

- Store-all **and** typed extract (both).
- Hybrid retrieve k=20–50.
- Answerer constrained to memories; **separate** judge.
- Target: **≥ 75 J** independent (Zep-corrected band), then AutoMem **85**. Do not chase 92 on a 6.4%-dirty key with a 63%-gullible judge.

### Gate 6 — LME-V2 (the 2026 SOTA that matches the product)

Insert trajectories/sessions as files+notes+events. Query via a **coding-agent memory controller** (workflow + manifests), not 6 bullets. Target: beat RAG 42.8 immediately; then AgentRunbook-R 58; then **AgentRunbook-C 75**. This is the only exam where “Eden is a coding-agent memory” can be true.

### Explicitly do not do

- Another whatever-loop on bakeoff rec5.
- More QUERY_LIGHT / `-ship` hacks.
- Mem0 extract on ICL.
- GraphRAG EventQA.
- Quote retrieve@40 as MCC.
- Wire unused `BrainMemory` into the hook to reuse a bench win that required **disabling** CLS.
- Claim 92% LoCoMo.
- Treat GPT-5-mini 60.6 as a BM25 problem.

---

## 9. Acceptance: you may say SOTA when

| Claim | Evidence required |
|---|---|
| **SOTA memory agent (4o-mini Table 3)** | Official overall **> 41.6**, all four avgs published, protocol match. Real target **≥ 50**. |
| **SOTA vs long-context non-reasoning** | Official overall **> 49.6** (Claude). Needs routed LRU + assembly SF. |
| **SOTA selective forgetting** | FC-SH **≥ 82** and FC-MH **≥ 27** at 262k 4o-mini (or beat 2606.01435 on the same setup). |
| **SOTA LoCoMo** | Independent J **≥ 75**, protocol disclosed; 92 only with audit caveats. |
| **SOTA agent-trajectory memory** | LME-V2 LAFS / accuracy **≥ AgentRunbook-C**. |
| **SOTA coding-agent product** | Gate 1 holdout + hook path is the scored path. No dual API. |
| **SOTA CLI-agent memory** | Terminal-Bench 2.1 **Δ** vs locked Codex/Claude Code (k=5), Harbor-verified, tokens reported. |
| **SOTA at 1M chat scale** | BEAM-1M under the paper harness, not a vendor blog. |

Until then, the true position is: **Simple RAG, unofficial metrics, dual API, extract that deletes the job, SF that is 0.45× mute, LoCoMo retrieve in the 30s, coding-miss unmeasured, LME-V2 / BEAM / Terminal-Bench Δ absent.**

---

## 11. 2026 benchmarks Eden should actually use

Vendors still publish LoCoMo / LongMemEval-S / DMR. Those are 2024-sized chat exams, half of them saturated or judge-gamed. The field that is *not* a brochure moved to: **MemoryAgentBench**, **BEAM**, **LongMemEval-V2**, **AMA-Bench / MemoryArena**, and **execution-graded coding Δ**.

Two scoreboards. Do not mix them.

| If you are… | 2026 scoreboard (in order) |
|---|---|
| **Coding-memory company (Eden)** | 1. LME-V2 + latency · 2. Terminal-Bench 2.1 Δ · 3. MAB Table 3 on the **hook** · 4. Locked coding-holdout / AML coding track · 5. AMA-Bench (tool traces) |
| **RAG/chat-memory company (Mem0/Zep)** | 1. MAB Table 3 · 2. LME-M or MAB LME(S*) frozen judge · 3. BEAM-1M · 4. FC-MH @262k · 5. MemoryArena |

### 11.1 MUST RUN

| Bench | Year | What it tests | Metric / scale | 2026 SOTA (honest) | Why Eden |
|---|---|---|---|---|---|
| **MemoryAgentBench** | ICLR 2026 | AR / TTL / LRU / SF after incremental ingest | Mean of 4 avgs. EventQA 534k, FC 262k, SH 197k, MH 421k, k=10 | HippoRAG **41.6** ≈ BM25 **41.5**; GPT-5-mini LC **60.6**; Mem0 **21.1** | Only shared anti-vendor protocol. Run on **`AgentMemory`**, official lengths. [arxiv:2507.05257](https://arxiv.org/abs/2507.05257) |
| **LongMemEval-V2** | 2026 ICML workshop | Web/enterprise **trajectories** → colleague experience. 5 abilities. | Acc + **LAFS** latency. 451 Q, **25M–115M** tokens | AgentRunbook-C **74.9 / 70.1**; Codex ~70; RAG ~40. Frontier LLM no-history **≤14.1%** | Closest public exam to a coding sidecar. Leader is a **file-walking coding agent**. [arxiv:2605.12493](https://arxiv.org/abs/2605.12493) |
| **Terminal-Bench 2.1 Δ** | 2026 | CLI tasks (build/debug/sysadmin). Memory = does inject help the *same* agent | Mean reward **k=5**. Report **Δ accuracy, tokens, $** | Public agent ~83–87%. Memory papers: Proactive Memory **+8.3** Sonnet / **+2.4** Opus. Sentra +5 / −73% $ **unverified** | Execution-graded, wrap-shaped. Absolute % is harness+model, not Eden. |

### 11.2 SHOULD RUN

| Bench | Year | What | SOTA / caveat | Eden fit |
|---|---|---|---|---|
| **BEAM** | ICLR 2026 | One coherent chat @ 128k–**10M**, 10 abilities, 2,000 Q | LIGHT +3.5–12.7% vs paper baselines; Mem0 vendor **64.1 @1M / 48.6 @10M**. Unsaturated; 1M window still degrades | Scale test. Run **1M first**. Content is chat, not repo. [arxiv:2510.27246](https://arxiv.org/abs/2510.27246) |
| **LongMemEval v1 M or S\*** | ICLR 2025 | Chat abilities: extract, multi-session, update, temporal, abstention. 500 Q | Vendor 94%; independent Mem0 **44–74**; MAB S* HippoRAG **50.7**. **S (~115k) fits 2026 windows** → often just long-context | Political chat comparison. Pin **S\*/M**, frozen judge. Do not headline S. |
| **AMA-Bench** | 2026 | Memory over **states/actions/tools**, not chat. Recall, causal, state update | AMA-Agent **57.22** vs MemoRAG/EMem ~46 (Qwen3-32B) | Diagnoses Eden’s missing **PostToolUse**. [arxiv:2602.22769](https://arxiv.org/abs/2602.22769) |
| **MemoryArena** | 2026 | Later **action** must use earlier memory. LoCoMo-saturated agents fail | Small n; conceptually the transfer test | “Memory that changes the next edit.” [arxiv:2602.16313](https://arxiv.org/abs/2602.16313) |
| **π-Bench** | 2026 | Proactive assistant in persistent **workspace** (files, tools, hidden intent). PROC + COMP | 100 tasks, 5 personas | Preference/constraint carry across sessions — closer to Claude Code than LoCoMo. [arxiv:2605.14678](https://arxiv.org/abs/2605.14678) |
| **AML coding track** | 2026 | Unified Add/Search API; coding = reuse debug/project context | Cycle 1 textual MemoraX **58**. Cycle 2 ~20 Sep 2026 | Only public coding-memory board. Not hook inject. |
| **Locked coding-holdout on hook** | internal | Flake / ADR / file rule / version / tool fail, **inject path** | Never scored | Non-negotiable product gate. |
| **FC assembly protocol** | 2026 | Same as MAB FactCon but extract-then-`max(serial)` | **82 / 27** @262k 4o-mini | How to *win* SF, not a second dataset. [arxiv:2606.01435](https://arxiv.org/abs/2606.01435) |
| **MemoryBench ELO** | ICML 2026 | Continual learning from user feedback; 28 datasets | Often **No Memory ≈ Embedder** | Humility: memory can be **zero lift**. |

### 11.3 SHOULD ONCE / TRAP AS SOTA

| Bench | Why it still exists | Why it is a trap |
|---|---|---|
| **LoCoMo-10** | Every vendor quotes it | Saturated (~92 vendor). Gold **6.4%** wrong. Judge accepts **63%** of wrong topical answers. Ceiling **~93.6%**. Full-context+CoT already ~92. ~9–16k tokens. **Regression check only.** |
| **LongMemEval-S (115k)** | Easy to run | Fits in the window. Vendor 94 is not memory. |
| **SWE-bench Verified absolute %** | Famous | Saturated/contaminated (Fable ~95%). Memory is **Δ vs same harness**, n small (one study +10.2 on 49 pairs). SWE-MeM is **training**, not a sidecar bakeoff. |

### 11.4 SKIP / TRAP

| Bench | Reason |
|---|---|
| **DMR (MemGPT/Zep)** | 60-message MSC. Zep 94.8 vs full-context 94.4. **Saturated 2023 chat.** |
| **RULER / ∞Bench / DetectiveQA standalone** | Long-context model exams. Already inside MAB as AR/LRU leaves. 100% RULER retrieve@12 is not SOTA. |
| **HotpotQA / MQuAKE** | RAG / parametric edit. MQuAKE labels 33–76% corrupted (Remastered). |
| **PersonaMem / PrefEval** | Consumer personalization (food/travel). Not ADRs. |
| **HLE** | Model IQ test. Irrelevant to a sidecar. |
| **Letta / Mem0 / Sentra self-boards** | Vendor-defined. Sentra TB 88.31 unverified. |
| **HELMET / LongBench v2** | Grade **models**, not memory products. |

### 11.5 2026-only / watchlist (run if bandwidth)

| Bench | Tests | Note |
|---|---|---|
| **FileGram** | Reconstruct prefs/behavior from **file ops + diffs** | Directly product-shaped; young. |
| **MEMTRACK** | Enterprise state across Slack, Linear, **Git, code, filesystem** | Closest “company graph” exam. |
| **RECON** | Facts **invalidate**; compositional reasoning. Strongest non-oracle **22.4%** | CLS conflict story, not coding. [arxiv:2607.16716](https://arxiv.org/abs/2607.16716) |
| **Evo-Memory** | Test-time evolution on task streams | TTL cousin: learn from prior runs. [arxiv:2511.20857](https://arxiv.org/abs/2511.20857) |
| **SWE-bench Pro** | Harder SWE; still weak as *memory* unless replay/second-attempt | Use for Δ only. |
| **Locomo-Plus** | Beyond-factual cognitive LoCoMo successor | Not a replacement yet. |
| **GiulioDER agent-memory-bench** | Execution-graded Claude Code; no LLM judge | Watch if multi-product numbers appear. |

### 11.6 What 2026 actually decided (stripped of blogs)

- **Chat QA 90+ is table stakes and often fake.** LoCoMo is a regression test. Independent LME is 50–74, not 94.
- **Scale that still hurts:** BEAM 1M/10M. Mem0 drops 92.5 → 64 → 49. Long context ≠ long memory.
- **Academic memory agents:** HippoRAG **41.6** tied with BM25. Extractive SaaS **loses** (Mem0 21, Zep 24).
- **Forgetting:** assembly **82/27**, not HippoRAG 54/5.
- **Agent experience:** file-walking coding agent **~75%** on 25–115M trajectories, RAG **~40%**.
- **CLI agents:** harness ≫ memory. Honest memory claim is **small Δ + token savings**, shrinking on Opus.

### 11.7 Run order for Eden (next 90 days)

1. Freeze **one** API under test (`openMemory` inject/hook). Stop scoring CLS-off MAB as the product.
2. **MAB Table 3 protocol** (k=10, full lengths, 4o-mini reader). Expect ~BM25 if ingest is store-all; if <<41, the adapter is still broken.
3. **LME-V2 Small** even if you lose to RAG 42 — that is the diagnosis (no tool traces / no files).
4. **Terminal-Bench 2.1** same harness ± Eden inject. Publish Δ and tokens. If Δ≈0, inject is theater.
5. Re-score the **internal coding-holdout on the hook**.
6. BEAM-1M and LME-M only after 2–4 exist.
7. LoCoMo J once, frozen harness, never optimize.

**Do not** start another LoCoMo retrieve@5 loop. That exam is over.

---

## 12. Sources folded into this document

- ICLR 2026 MemoryAgentBench Table 3 / 7 / 10 / 12 / 15 (Hu, Wang, McAuley) [arxiv:2507.05257](https://arxiv.org/abs/2507.05257).
- BEAM / LIGHT ICLR 2026 [arxiv:2510.27246](https://arxiv.org/abs/2510.27246).
- Structured assembly SF SOTA [arxiv:2606.01435](https://arxiv.org/abs/2606.01435) (82/27 @262k 4o-mini).
- LongMemEval-V2 [arxiv:2605.12493](https://arxiv.org/abs/2605.12493): AgentRunbook-C 74.9% small.
- AMA-Bench [arxiv:2602.22769](https://arxiv.org/abs/2602.22769); MemoryArena [arxiv:2602.16313](https://arxiv.org/abs/2602.16313); π-Bench [arxiv:2605.14678](https://arxiv.org/abs/2605.14678).
- LoCoMo audit (6.4% GT errors; judge 62.81% false accept).
- Mem0 / Zep / AutoMem / Hindsight vendor vs independent LoCoMo/LME/BEAM.
- SWE-MeM [arxiv:2606.28434](https://arxiv.org/abs/2606.28434); Proactive Memory on Terminal-Bench [arxiv:2607.08716](https://arxiv.org/abs/2607.08716).
- Syke, “The Shape of Memory Benchmarks” (2026) — π-Bench, MEMTRACK, FileGram, SMMBench taxonomy.
- In-repo: `src/index.ts` (`relevant`, persist 2000, inject/observe order), `src/brain-memory.ts`, `src/cls/{controller,episodic,semantic,text}.ts`, `packages/cli/src/memory-hook.ts`, wrap `proxy.ts` / `anthropic.ts` / `know-inject.ts`, plugin hooks.json vs MEMORY_EVENTS.
- Prior probes: product path, bakeoff honesty, MAB capability matrix, CLS autopsy, Table 3 parse, [2026 bench catalog](c71588bf-1552-47ae-8bf9-025f413b674e), [AgentMemory ranking/persist](feadc5c0-f85e-4fde-8622-6fa876ad9193).
