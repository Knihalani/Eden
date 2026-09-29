# Eden Memory — product plan

**Locked 2026-09-16. Revised 2026-09-19** (50-wave program: SOTA mechanisms + a product that actually helps). This is what we build. Autopsy: `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md`. Competitors: `docs/MEMORY-COMPETITORS.md`. **Builder waves:** `docs/MEMORY-WAVES.md`. **Next wave:** `/memory-wave` (must finish closed; now **M15**). Status: `docs/MEMORY-WAVE-STATUS.md`. Bakeoff retrieve@5 is not this product’s exam. `benchmarks/memory-bakeoff/brain/HYPOTHESES.md` is **superseded**.

Company thesis (`docs/ROADMAP.md`): *the best tool surface is no surface.* Memory obeys the same law. Encode and retrieve without a memory UI. One brain on wrap and hook.

**One sentence:** Eden Memory is the agent’s medial temporal lobe plus sleep: it encodes experience as it happens, consolidates offline, and silently completes the right trace into the next turn. The agent does not manage a memory tool. Nature does not either.

You locked three things: **any agent** (chat, web, coding, ops), **silent inject**, **real replay**. That is Complementary Learning Systems plus rest — not smarter BM25, not Letta, not a coding fork with LoCoMo hay.

---

## 0. Locked product

| Choice | Lock |
|---|---|
| **Who** | Any long-running agent equally: chat, web, coding, ops. One brain. Not a coding fork with LoCoMo hay. |
| **Loop** | **Silent inject.** Automatic encode + retrieve into context. No Letta-style `memory_search` in the default loop. No PreToolUse veto as the product. (A later host adapter may gate tools off the same intention store.) |
| **Sleep** | **Yes.** Session-end / idle replay into schemas, tombstones, gists, **and how-to** (successful traces, dead ends stripped). Required or the biology is a comment. |
| **Objects** | **One** `AgentMemory` on wrap and hook. CLS is this system, not a bench toy with `cortex: false`. `BrainMemory` becomes a thin adapter or dies. |
| **Fail-open** | A broken memory never breaks the agent. Keep `inject` catch → pass-through. Add a metric when it swallows. |
| **Honesty** | No LoCoMo 92, no retrieve@40 as MCC, no dual-API scores. Exam + metric + length + k + backbone + API under test, or it is not a claim. |
| **Bar** | **SOTA vs other solutions**, not competence (tie BM25 41.5). Target MemoryAgentBench overall **≥ 50** on the inject path. |
| **Help** | Next turn more correct *or cheaper* because of inject, **or** inject correctly omitted. Always-on junk is a product failure even if Table 3 moved. Continuity across sessions. Harmed packets gone next time. |

**Silent trade (accepted):** a commit rule can only appear in context; the model can ignore it. Nature’s prospective memory interrupts. Gates are a future host adapter, not this plan’s default.

**Causal order (lock one):** retrieve from **previous** store using **this-turn cue**, then encode this turn. That matches OpenAI wrap today and avoids echoing the current sentence as “memory.” Anthropic’s observe-then-rank is a bug, not a dialect. SessionStart briefs from sleep gists + pinned intentions, not `slice(-k)` of eviction order.

---

## 1. What it is (the animal)

Eden Memory is the agent’s **medial temporal lobe + sleep**, wired as a sidecar. One brain, every host (wrap, Claude hook, later others). Not three objects (`AgentMemory` vs CLS vs HCM). Not a LoCoMo diet expander.

Every turn:

1. **Working memory** holds the live episode (this session, high fidelity, small). Like prefrontal maintenance: what is in play *now*.
2. **Hippocampus** stores the turn as an episode — one-shot, time-stamped, source-stamped, pattern-separated. Store-all at this layer. The hippocampus does not drop `please` or tool output. Encoding is automatic.
3. **Cue-driven recall** (not “search the whole transcript”). The cue is **this turn’s state**: latest user text, recent working-memory, salient open artifacts if the host provides them. Pattern completion fills the rest. That is CA3, not `notesFor(convBlob)`.
4. **Silent inject** of a small, **labeled** packet: episode / fact / intention / gist / how-to. The model never calls `memory_search`. Humans do not query their hippocampus; a cue arrives and the trace completes.

When the session idles or ends:

5. **Replay (sharp-wave ripples).** Offline pass replays tagged episodes into **neocortex**: schemas, `(entity, relation, value, time)`, **procedures** (successful traces, dead ends stripped), tombstones for superseded values, compressed gists. Fast store stays episodic; slow store becomes knowledge. This is the CLS paper, not a comment in `brain-memory.ts`.
6. **Directed forgetting.** Unused traces decay; superseded traces are invalid, not 0.45× muted. Forgetting is the system working.

That is the whole product.

---

## 2. What nature does (the spec, not decoration)

Effective biological memory is **several systems with one controller**, two timescales, and forgetting as a feature.

| In nature | Job | In Eden |
|---|---|---|
| **Working memory** (PFC) | Tiny, current, gates encoding | Session buffer. Cue for retrieve. **Not** `notesFor(entire window)` / 40-message blob. |
| **Episodic** (hippocampus) | Fast, sparse, what/where/when, complete from a fragment | Turn-level episodes: time, source, host, optional place (file/URL/repo). Store-all at this layer. Pattern completion on rare features. |
| **Semantic** (neocortex) | Slow, overlapping, “what is true now” | Built **in replay**, not copula-regex every turn. `(entity, relation, value, valid_from)`. Last-write-wins; old rows tombstoned so the reader cannot see them. |
| **Procedural** (striatum) | How / when-to | Sleep compresses a **successful** tool trace into how-to (files, order, what verified it). Cue-complete injects `[procedure]` the same way it injects `[fact]`. Rules stay `[rule]`. Chat-only hosts mint none. Not a second product, not a recall CLI. |
| **Salience** (amygdala / DA) | What gets replayed | Surprise, correction, explicit remember, failure, decision. Tags for sleep. `sal=0.6` must actually pin or the comment is a lie. |
| **Place / grid** (entorhinal) | Index by location | Optional keys when the host has them (path, URL, ticket). Same brain, not a coding-only index. Dotted filenames are first-class (`auth.ts`). |
| **Sleep replay** (SWR) | Extract gist, supersede, prune | Idle / SessionEnd / Stop job: schemas, tombstones, gists, **how-to**, decay of unused episodes. |

**Not copied:** life-as-searchable-transcript (cortex without hippocampus; fails BEAM).  
**Not copied:** someone else’s memory product (Memorable procedures-as-a-company, Mem0 extract, Letta tools). We take **mechanisms** that fit this animal and implement them on `observe` / `inject` / `sleep`.

Biology’s trick is **two timescales**. Store-all fast. Extract slow, during rest.

---

## 3. Loop (silent)

```
host turn  →  encode episode (always: user, assistant, tools if the host has them)
           →  retrieve from THIS cue (working memory + current user text [+ open artifacts if present])
           →  inject a short labeled block (episode | fact | intention | gist | how-to)
           →  model answers / acts
idle/end   →  replay → schemas, tombstones, gists, how-to
```

Same API for wrap, Claude hook, later hosts:

- `observe(trajectory)`
- `inject(messages)` → ranked labeled notes
- `sleep()`

Hosts without tools still get chat episodes. Hosts with tools **must observe tool results** (that is experience). One store, one retrieve, one replay.

---

## 4. Architecture (one object)

Replace the three-system lie (`AgentMemory` regex + CLS bench + HCM RRF).

```
WorkingMemory     session turns, bounded
EpisodicStore     store-all episodes, sparse keys, time, source, place
SemanticStore     replay-built (s,p,o,t); lookup by key not noun-overlap-only
IntentionStore    **not a separate file.** Pins + English pin/forget (M5 / M43) on the same stores.
HowToStore        sleep-built skill: steps, files, verify, exit, revisions
Controller        cueFor(this turn) → complete → assemble (max valid_from) → format
Sleep             replay job
Persist           one directory, lock, WAL or atomic write
```

**Retrieve assembly (SF SOTA, arXiv:2606.01435):** LLM or schema extracts candidate values from retrieved episodes; **code** picks `max(valid_from)` / `max(serial)`. Do not ask the generator to remember which fact is newer. Tombstone so old values are absent from the inject packet. v2 of that paper: most of the gain is **separating extraction from answering**, not max() itself. Prior-override (Finland → ice hockey) and serial-drift at long context are the LLM failure modes we design against.

**Inject packet (labeled, small, default k≈6–10):**

```
Eden Memory:
- [rule] Always run tests before committing
- [fact] auth.provider = Clerk  (as of 2026-09-10)
- [episode] 2026-09-16 User: the flake is in src/auth.test.ts
- [gist] This repo’s CI is GitHub Actions; Node 18
- [procedure] fix failing auth test → tests/auth/session.test.ts · verify: npm test -- auth
```

No unlabeled slurries. No `two → two 2` on rules. No CircleCI/diet/movie bonuses in the core ranker.

**Integrity (pre-M1 snapshot, retired by M1–M14):**

| Object | Path | Used by | Status |
|---|---|---|---|
| Product `AgentMemory` | `src/index.ts` | wrap, Claude hook, `processMemory()` | **What ships.** Regex extract, JSONL, lexical `notesFor`, k=6 unlabeled bullets. |
| Bench `BrainMemory` | `src/brain-memory.ts` | MAB, bakeoff `BrainProduct` | CLS adapter. MAB often sets **`cortex: false`**. |
| Bakeoff `HcmSys` | `benchmarks/memory-bakeoff/brain/systems.ts` | Sep 8 RESULTS.md | RRF; not current `brain-memory.ts`. |

Evaluating the unused object is how you fake progress. Wave **M1** freezes the inject API; dual-API scoring is dead by **M6.2**.

---

## 5. What we take (and leave) from 2026 SOTA

We do **not** clone a vendor. We take **mechanisms** that fit Plan §0–§3 and leave their product surface. Mapping lives in `docs/MEMORY-COMPETITORS.md` §0.

SOTA among memory agents is **not** “better stemmer.” Arithmetic: Table 3 overall = mean of AR / TTL / LRU / SF. HippoRAG **41.6** ≈ BM25 **41.5**. Claude LC **49.6**. GPT-5-mini **60.6**. Mem0 **21.1**. Assembly paper SF **82/27** @262k 4o-mini (not in Table 3).

| Competitor | Take (into this animal) | Leave (their product) |
|---|---|---|
| **HippoRAG-v2** (overall 41.6) | Associative retrieve on store-all chunks for AR (SH/MH/LME). | Their TTL tax (MCC 61.4 — graphs scramble ICL). Do not call 3 BM25 hops on `#` “hippocampal.” |
| **BM25** (41.5) | Store-all for novels/ICL; EventQA target **≥ 74.6** at **534k**. If we lose to LangChain BM25 on identical chunks, stop. | Matching BM25 as the ship bar. Competence is losing. |
| **Dense RAG** (Qwen3/TE3 ~38) | Hybrid lane only if **M33** still loses to identical-chunk BM25 on EventQA/ICL/AR — else reject in writing. | Embeddings as a replacement for store-all ICL. Table already ran that: dense **lost** to BM25 overall. |
| **Mem0** (MAB 21.1; vendor LoCoMo 92) | Typed ADD/UPDATE/DELETE **for facts that are actually facts**. | Extract on ICL/novels (labels die). Chasing Cloud 92 on a dirty key. |
| **Zep / Graphiti** (MAB 24; FC-SH **7**) | Validity intervals as data. | Building a KG expecting Table 3 SF to move. Assembly still has to pick the fresh value. |
| **Memorable.sh** (YC how-to graph) | Keep **order/exit** on traces we already observe. Sleep strips dead ends into how-to. Worse retry must not clobber a passing verify. Match on **aboutness** (place cells), not tool JSON keys. File runs where memory did not help. Operator can freeze writes. | Their company: recall CLI, MCP, fail-closed, dashboard, cloud extract, closed-source hippocampus, 60ms SLO, coding-only as the whole brain. |
| **Letta / MemGPT** (28.3) | Persisted working memory across processes. | Memory tools as the default loop. Silent inject is the lock. |
| **Mem^p** [arxiv:2508.06433] | Trajectory → script + raw trace. Validation / Adjustment / deprecate failures. Procedure survives model swap. | TravelPlanner as ship bar. Online self-play. |
| **AutoMem** | Decay of failed rabbit holes. Recall is lookup, not an LLM. | MCP as the product. Vendor boards. |
| **Proactive Memory / TB** | Memory = **Δ** pts/tokens/$. Always-on can lose. Remain-silent is compatible with fail-open. | Second LLM as memory agent in the default loop. |
| **MIRIX** (4o-mini 26.2; 4.1-mini 37.7) | Competency router (ICL vs needle vs overwrite vs summary vs dialogue). | Six ontologies. |
| **GraphRAG / RAPTOR** | Hierarchical gist **only** for LRU/Summ if routed. | GraphRAG EventQA (34.4 vs BM25 74.6). RAPTOR as a *general* agent (overall 27). |
| **Assembly (arXiv:2606.01435)** | Extract candidates → code `max(serial)` / CAR per hop. Live SF bar **82/27**, not HippoRAG 54/5. | Leaving old facts at 0.45× in top-k. |
| **Long-context (Claude 49.6 / GPT-5-mini 60.6)** | Route LRU/TTL to LC or hierarchical summary when the task is Summ/DetQA. | Pretending top-k RAG beats 60.6 overall. |
| **AgentRunbook-C** (LME-V2 74.9/70.1) | Trajectories as experience; files + notes + events. | JSONL BM25 as a coding-sidecar. Wrap `coding.ts` is a bash jail, not a memory controller. |
| **LoCoMo vendor club** | Independent J protocol, frozen harness, once. Target ≥75 then 85. | Optimize retrieve@5. Gold 6.4% dirty; judge accepts ~63% of wrong topical answers; ceiling ~93.6%. |

**SOTA memory layer (this product’s Table 3 target):**

| Stack | AR | TTL | LRU | SF | Overall |
|---|---:|---:|---:|---:|---:|
| HippoRAG today | 65 | 36 | 36 | 30 | 41.6 |
| BM25 | 61 | 45 | 36 | 26 | 41.5 |
| Claude LC | 60 | 54 | 62 | 23 | 49.6 |
| GPT-5-mini LC | 74 | 49 | 66 | 53 | 60.6 |
| CLS-only as-is (est.) | ~60 | ~40 | ~20 | ~15 | **~34** |
| **This product (target)** | ≥65 store-all+complete | ≥45 episodes, **no extract on ICL** | ≥46 from **sleep gists** (or routed) | ≥54 **assembly 82/27** | **≥50** (beats Claude if LRU routed) |

Path: store-all episodes (TTL) + HippoRAG-class AR + assembly SF + sleep gists for LRU. That **would beat Claude 49.6** without a 400k window. Beating GPT-5-mini 60.6 requires a long-context/summary router for LRU, not a better hippocampus comment.

---

## 6. What the code was (debt M1–M14 retired)

**Historical.** Written as the 2026-09-16 autopsy of `AgentMemory` **before** M1–M14. Do not re-implement these as if they were current. After M14: `cueFor`, lock+atomic, `sal>=0.6` pin, `EDEN_MEMORY` on/read-only/off, SessionStart pins+gists, no ghost `/forget`. Remaining SOTA/help work is M15–M50.

Product path is still `AgentMemory` (`src/index.ts`), wrap `injectBody` / `withKnowFactsAnthropic`, hook `memory-hook.ts`. CLS `BrainMemory` is **not** on that path.

### 6.1 Ranker (`relevant`, `src/index.ts` ~657–737)

This is **not BM25**. Binary IDF overlap on a LoCoMo-shaped query bag, then pins written for the whatever-loop.

- `queryHay` injects LoCoMo hay: diet, childhood, pets, stained glass, adoption, running-from-shoes. A `watch` file-watcher still takes the **movie** `noteBonus`.
- IDF is Robertson-style but **binary** (no TF, no length norm). If lexical `base === 0`, salience never surfaces. `sal=1` with no query-term overlap is invisible except reserved prospective slots.
- `noteBonus`: quoted titles, books/movies/songs, `favorite`, speaker labels — personal-QA fixtures in the coding sidecar.
- Episode reinstatement: +2.5–5.0 onto same-`ep` records. Hook `openMemory()` per event → new uuid → **reinstatement never fires across turns**. Wrap singleton accidentally keeps `ep`.
- Then: `fuseOnce` (fake `fuse:` id, not persisted) → Jaccard 0.6 → **`pinEnvFact`** (CircleCI / Buildkite / `staging.example`) → prospective reserve 2 of 6 slots.
- Empty query (SessionStart): last k on **eviction-ordered** array, not ranked.

### 6.2 Persist

`persist()` hard cap **2000** JSONL. `EDEN_MEMORY_CAP` is retrieve **k** (default 6), not store size. Pin = `kind==constraint` or cues or `sal >= 1`. `SAL_WEAK = 0.6` is **not pinned** despite the comment. No file lock (hook events.jsonl has one; memory does not). WeakMap cues; ghost README `/forget`. Serialized: `id, text, kind, tags, agent, project, at, ep, ctx, sal`. Not serialized: compiled needles, cue list, EpisodeContext, `lastWin`.

### 6.3 Inject pipelines (M3: one causal order, this-turn cue)

| | OpenAI wrap `injectBody` | Anthropic `withKnowFactsAnthropic` | Claude hook Submit/PreCompact |
|---|---|---|---|
| Rank cue | **`cueFor`** latest user text | **`cueFor`** latest user text | **prompt string** (`inject` of prompt-only) |
| Order | **notesFor then observe** | **notesFor then observe** | same (prompt inject, then observe transcript) |
| This-turn fact in this request? | **No** | **No** | **No** |
| Store | `processMemory()` singleton | same | **`openMemory()` per event** — TCM/`ep` die until M5 |

`inject` catch increments `memoryInjectSwallows` and returns the original list (fail-open). `EDEN_KNOW=0` does **not** disable AgentMemory. PostToolUse / SubagentStop observe tool name + result (M2). Empty cue does not dump last-k (SessionStart `notesFor("")` still does eviction briefing until M7).

Live call sites that matter: `src/index.ts` `cueFor` / `relevant` / `notesFor` / `inject` / `injectBody`; `packages/cli/src/memory-hook.ts`; `packages/cli/src/hook.ts` Submit/Start/PreCompact/PostToolUse; wrap `proxy.ts:176,193`; `anthropic.ts:258`. `BrainMemory.retrieve` is **not** on this list.

### 6.4 CLS fuse (why bench wins are not the product)

`scores()` independently min-max BM25 `a`, semantic `b`, cortex `c`, then `v = a + 0.6b + 1.05c`. Worked: gold BM25 **1.000** loses to a dead semantic hit **1.219**. ICL unit tests **disable** semantic and `complete()`. Semantic compile is copula-only (“Never run tests…” never becomes a fact). `complete()` hops the single rarest `#` — not PPR, not 3-hop. Product wrap **never calls `complete()`**.

### 6.5 Retire or replace

| Debt | Why it dies |
|---|---|
| `extractDurable` drops `please`, `fix the`, fences, `git `, tools | **M2 closed** for ordinary language + tool traces |
| `notesFor(convBlob)` / last-8 vs full-window vs 40-line transcript | **M3 closed:** `cueFor` + hook prompt cue |
| OpenAI retrieve-then-observe vs Anthropic observe-then-rank vs hook new-process | **M3 closed** one order. Persist `session_id` so TCM/`ep` survive hook spawn is **M5** |
| Binary IDF + LoCoMo `queryHay` + `noteBonus` movies | Any-agent core cannot ship personal-QA fixtures |
| `pinEnvFact` CircleCI/Buildkite/`staging.example` | Bakeoff staple in production |
| `pathCues` drops dotted segments | `auth.ts` is a place cell |
| `subjectKey` deletes Clerk when “Auth is failing” | Reconsolidation is typed `(s,p)`, not left-noun |
| Persist 2000 unlocked JSONL; `EDEN_MEMORY_CAP` is k not store; `sal=0.6` not pinned | Lock, atomic write, pin what the comment claims |
| WeakMap cues; ghost `/forget` README | Serialize cues or re-derive honestly; implement or delete README |
| PostToolUse / SubagentStop ignored | Observe tools when the host has them |
| CLS fuse `a+0.6b+1.05c` independently max-normed | A dead semantic hit beats BM25 (1.000 vs 1.219) |
| `complete()` hops rarest `#` only; ICL test disables it | Replay graph + assembly, or don’t call it hippocampus |
| Semantic compile copula-only | Facts come from **sleep**, not “is/was” |
| Dual API scoring | One scoreboard on **inject/hook** |
| HYPOTHESES.md path-to-92 | Anti-goal. Independent LoCoMo J once, after evidence, target ≥75 not 92 |

Keep: fail-open inject; secret redaction; wrap/hook as silent surfaces; “best tool surface is no surface.”

---

## 7. What “done” looks like

You can say it is the product when **Wave M50** has closed. That wave’s walkthrough (wrap **and** hook) plus Plan §0/§1/§3 must hold in production callers, not in a bench adapter — **and** the official inject scoreboard must be filed (Plan §9.2) — **and** a help ledger shows memory aiding real wrap/hook sessions (helped > harmed, junk silent, continuity across sessions). M37 is the first official re-bench, not ship. M20 is SF candidates, not ship.

- **One object** on wrap and hook. CLS is not a bench toy with cortex off.
- **Encode** does not drop ordinary agent language or tool traces when the host has them. ICL exemplars and narrative chunks are **store-all** (no `extractDurable` tax). Trajectories persist as **files**. Traces keep **order / files / exit**.
- **Retrieve** is cue-to-current-turn, k small, types labeled (rule vs fact vs episode vs gist vs **procedure**). Unrelated cues **omit the packet**.
- **Sleep** actually rewrites the store: newest fact wins and the old value is gone (code `max(serial)`, losers absent from the packet); a gist exists for LRU-class questions; a **successful tool run can become how-to**; experience files remain after replay; incremental sleep during long sessions; JSONL is not the only intelligence.
- **Continuity:** a new session in the same project still has sqlite and Clerk. Subagents inherit parent knowledge. “forget postgres” / “always sqlite” work in English.
- **Any-agent**: a chat agent, a coding agent, and a web agent share the same code paths; chat-only mints **zero** procedures and still works; domain-specific hay (`diet`, CircleCI pins) is gone from the core.
- **Operator**: on / read-only / off. Off fail-opens. Import existing transcripts. No cloud extract. No MCP in the default loop. First hour works without reading MEMORY-WAVES.md.
- **Help:** next turn more correct or cheaper because of inject, or inject correctly omitted. Harmed packets are gone next time. A developer would notice if the coding holdout failed.
- **SOTA path** follows from this, it is not a separate costume: store-all episodes (TTL/ICL/needles), replayed KB + `max(time)` (forgetting), gists from sleep (LRU), procedures from traces (coding/web/ops how-to), file/URL keys when present (LME-V2 / coding). You win by being a real CLS, not by k=40.

**What it is not**

- Not Mem0 (lossy extract, no hippocampus).
- Not Zep (graph without assembly — FC-SH **7%**).
- Not Memorable.sh (procedure product with MCP/fail-closed/cloud extract; coding-only as the whole brain).
- Not today’s Eden (regex allow-list, `notesFor(entire window)`, three inject orders, no sleep, LoCoMo bonuses in the ranker).
- Not “a better stemmer.”
- Not a second brain for benches.
- Not gated UI rebuild (`apps/web/REBUILD.md` stays one phase at a time, separate).
- Not default PreToolUse / memory tools (not the product; M50 may reject them with evidence).

---

## 8. Build waves

**Builder spec (file:line, Report §§, Done-when):** `docs/MEMORY-WAVES.md`. Competitor autopsy: `docs/MEMORY-COMPETITORS.md`.

**50 waves × 4 parallel parts = 200 parts.** Same B/T/O/D types as `docs/ROADMAP.md` §4. Inside a wave, all four parts run at once on disjoint files (or a named line-range in `src/index.ts`). Cross-wave only. Do not optimize LoCoMo retrieve@5. Skipping to CLS poetry is how ICL@40 happened. Mixing ICL extract with SF hops is how M8 “assembly” still scored FC-MH 7. A Table 3 cell without remain-silent / continuity / a help ledger is not a product.

```
M1 check  →  M2 encode ∥ M3 cue ∥ M4 hay ∥ M5 persist
          →  M6 check  →  M7 sleep  →  M8 assembly
          →  M9–M14 how-to spine
          →  M15 check (official exams)
          →  M16 evidence lock
          →  M17 encode lanes
          →  M18 chunks ∥ M19 ICL
          →  M20–M22 SF (candidates → code-pick → CAR hops)
          →  M23–M26 experience files + LME re-exam
          →  M27–M31 AR / LRU / Recsys
          →  M32 TB Δ (measure)  →  M33 router  →  M34 quality
          →  M35 negative annex  →  M36 probe/walkthrough
          →  M37 SOTA re-bench (checkpoint; command stays)
          →  M38–M49 help path (silence, diversity, provenance, pathCues,
             incremental sleep, pin/forget, identity proof, subagents, import,
             help ledger, live coding holdout, first session)
          →  M50 ship: §7 + scoreboard + HELP.md
```

| Wave | Kind | Four parallel parts | Closes when |
|---|---|---|---|
| **M1** | check | Freeze inject API · protocol sheet · characterization (red OK) · latency/swallow baselines | Dual-API banned in new benches; Table 3 lengths locked; bugs pinned |
| **M2** | debug | `extractDurable` · hook PostToolUse observe · wrap tool observe · AMA/tool-trace fixture | `please`/tools stored |
| **M3** | debug | `cueFor(this turn)` · Anthropic retrieve-then-observe · hook prompt cue · packet-identity tests | One causal order |
| **M4** | debug | Kill `queryHay` · kill `noteBonus`/`pinEnvFact` · `auth.ts` + Clerk subject · ranker tests | Hay gone from default |
| **M5** | debug | lock+atomic+store cap · session dir/`ep` · pin `sal=0.6` · ghost `/forget` | Hook processes share memory |
| **M6** | check | hook holdout run · dual-API CI · fail-open struggle · remeasure vs M1.4 | RESULTS on **inject**, no ranker features |
| **M7** | debug | `sleep()` triggers · Semantic LWW+tombstone · gists+SessionStart · sleep tests | Old value absent from packet |
| **M8** | debug | `assemble` max(t) · fuse rewrite · complete/CAR · labeled packet | MH top-1 last hop |
| **M9** | debug | wrap/hook keep order/exit · HowToStore shell · tests | Experience is structured, not only prose |
| **M10** | debug | sleep writes how-to · revisions · stale prune · tests | Failing verify does not become skill |
| **M11** | debug | do not invent missing steps · omit stale place · tests | How-to forgetting; no vendor graph product |
| **M12** | debug | `[procedure]` on existing inject · aboutness · no tools | Cue completes how-to; chat-only unchanged |
| **M13** | debug | on/read-only/off · scrub · doctor · tests | Disable cannot 500 the host |
| **M14** | debug | how-to on memory root · wrap write / hook inject · tests | One `AgentMemory`, not a second store |
| **M15** | check | MAB Table 3 inject · LME-V2 Small · TB 2.1 Δ · protocol auditor | Four artifacts; no claims yet |
| **M16** | check | M15-EVIDENCE.md · lane types · extract/hop red pins | Scoreboard frozen; no retune |
| **M17** | debug | observe kinds · persist kind · flip extract pin · no SF regression pin | ICL/narrative store-all |
| **M18** | debug | chunk store · narrative retrieve · EventQA re-run · anti-GraphRAG | EventQA vs BM25 74.6 |
| **M19** | debug | ICL index · ICL lane · MCC re-run · no label-strip | TREC-F is the MCC gate |
| **M20** | debug | SF candidates · prior-override fixture · labeled packet · kind firewall | Copula-only extract is dead |
| **M21** | debug | code-pick max(serial) · sleep tombstone · FC-SH re-run · flip override | FC-SH vs 54→82 |
| **M22** | debug | CAR hops · last hop first · FC-MH re-run · flip M16.4 | FC-MH vs 7→27 |
| **M23** | debug | ExperienceStore · observe files · fail-open · tests | Trajectories are files |
| **M24** | debug | cue→files · packet merge · gold_in_packet · no memory_search | Silent slices |
| **M25** | debug | sleep replay files · how-to from success · screenshot policy · tests | Rest without deleting files |
| **M26** | check | LME runner honesty · acc+gold_in_packet · latency · vs 42.8/74.9 | Official Small on inject |
| **M27** | debug | multi-hit fusion · SH 197k · ICL isolation · vs BM25 | SH number |
| **M28** | debug | MH hops · MH 421k · AR avg · tests | AR avg if four leaves |
| **M29** | debug | gist retrieve · Summ re-run · packet cap · tests | Summ vs 19 |
| **M30** | debug | DetQA · re-run · router stub · LRU avg | LRU strategy scored |
| **M31** | debug | Recsys encode · re-run · TTL avg · movies≠facts | TTL avg if MCC+Rec |
| **M32** | check | Harbor completes · Δ RESULTS · remain-silent **count** · no 89-board claim | TB Δ filed. Gate is M38 |
| **M33** | debug | router on inject · dense reject-or-add · isolation · holdout | One controller |
| **M34** | optimize | WAL · retrieve loop · packet budget · BASELINE | vs M6.4 |
| **M35** | check | NEGATIVE · SAVINGS · leftover identity · fail-open+schema | **Four** annex artifacts. Live HELP.md is M47 |
| **M36** | debug | hostile probe · walkthrough 1–10 · suite ×3 · audit | Re-probe zero |
| **M37** | check | walkthrough still green · Table 3 four avgs+overall · LME+TB · honest claims | Scoreboard filed. Command **stays** |
| **M38** | debug | aboutness gate (Start exempt) · hosts honor omit · silence holdout · tests | Math omits packet; Start still briefs |
| **M39** | debug | near-dup suppress · lane mix floors · ICL gold kept · packet tests | Packet is 10 different traces |
| **M40** | debug | ages in labels · assembly agrees · optional log · scrub | Dated notes; losers stay absent |
| **M41** | debug | hook pathCues · wrap last-user · no cue rewrite · order tests | Open files are keys, not bodies |
| **M42** | debug | idle sleep · time-capped · Stop still full · tests | Rest during the day; no mid-task tombstone |
| **M43** | debug | forget utterances · pin utterances · read-only no-op · tests | Steer in English; “don’t forget to…” is not a tombstone |
| **M44** | debug | two-session proof · Start briefing · wrap singleton · tests | New session still knows sqlite (layout is M5/M14) |
| **M45** | debug | child reads root · failed child isolation · tests | Subagents inherit; cannot prune parent |
| **M46** | debug | `eden memory import` · kind split · doctor · tests | Day-1 can have a hippocampus; M38 still wins |
| **M47** | check | HELP.md from wrap+hook · wire omit harmed · token Δ · CI no-control ban | Helped / no-lift / harmed counted |
| **M48** | check | holdout body · multi-session section · silence section · dual-API ban | Developer-facing WIN or honest LOSS |
| **M49** | debug | setup default on · latency budget · one-session script · docs | First hour works without this file |
| **M50** | ship | verify completeness · scoreboard · help ledger · honest claims | **Plan §7 + scoreboard + HELP.md.** Command deleted |

**First slice if we build next:** run **`/memory-wave`** (now Wave **M15**). Each run closes one wave and **fixes every finding**. After M50 the command ships a product that actually helps (Plan §7 on wrap+hook, official inject scoreboard, **and** a help ledger), then deletes itself. M37 does not delete the command.

Report gates: M1 ↔ Gate 0; M2–M5 ↔ Gate 1 minus PreToolUse; M7–M8 ↔ Gates 2–3; M9–M14 ↔ striatum/how-to; M15–M16 ↔ evidence; M17–M33 ↔ SOTA mechanisms; M35–M36 ↔ negative+adversarial; M37 ↔ scoreboard checkpoint; M38–M49 ↔ **help**; M50 ↔ **ship**.

---

## 9. SOTA scoreboard this plan is aiming at

Competence = tie BM25 **41.5**. **This plan is SOTA**, not competence.

If a claim cannot name **exam + metric + length + k + backbone + API under test**, it is not a claim.

**Forbidden comparisons:** retrieve@40 ICL vs Table 7 MCC @ k=10; EventQA-64k vs Table 3 EventQA-**534k**; Fact 6k vs Table 3 **262k**; `goldHit` retrieve@5 vs Mem0 Cloud 92.5 J; HCM bakeoff vs current CLS; `BrainMemory.retrieve` vs what Claude Code sees; GPT-5-mini 60.6 vs JSONL BM25 without saying so.

### 9.1 Two leagues (same brain, not two products)

**Coding-memory league (primary, any-agent still runs these where they apply):**

1. LongMemEval-V2 + latency — AgentRunbook-C **74.9 / 70.1**; RAG ~40. File/trajectory experience. [arxiv:2605.12493]
2. Terminal-Bench 2.1 **Δ vs locked harness** (k=5, tokens). Memory = +pts / −$. Proactive Memory +8.3 Sonnet / +2.4 Opus.
3. MemoryAgentBench Table 3 on **inject**, k=10, official lengths (EventQA **534k**, FC **262k**, SH-QA **197k**, MH-QA **421k**). HippoRAG **41.6**. Target **> 41.6**, real bar **≥ 50**. [arxiv:2507.05257]
4. Locked product holdout on hook: flake, ADR, file rule, version, junk. HELP.md helped/no-lift/harmed (M47–M48). Never `BrainMemory.retrieve` as the gate.
5. AMA-Bench — tool traces. Diagnoses Wave **M2**. [arxiv:2602.22769]

**Chat/RAG league (same brain):**

- LME-M or MAB LME(S*) frozen judge (not 115k-S as headline).
- BEAM-1M (unsaturated scale). Mem0 vendor 64.1 @1M / 48.6 @10M. [arxiv:2510.27246]
- LoCoMo J **once**, frozen harness, independent protocol. Target ≥75 independent, then AutoMem ~85, not 92.

### 9.2 You may say SOTA when

| Claim | Evidence required |
|---|---|
| **SOTA memory agent (4o-mini Table 3)** | Official overall **> 41.6**, all four avgs published, protocol match. Real target **≥ 50**. |
| **SOTA vs long-context non-reasoning** | Official overall **> 49.6** (Claude). Needs routed LRU + assembly SF. |
| **SOTA selective forgetting** | FC-SH **≥ 82** and FC-MH **≥ 27** at 262k 4o-mini. |
| **SOTA LoCoMo** | Independent J **≥ 75**, protocol disclosed; 92 only with audit caveats. |
| **SOTA agent-trajectory memory** | LME-V2 accuracy **≥ AgentRunbook-C**. |
| **SOTA coding-agent product** | Hook inject is the scored path. No dual API. HELP.md helped > harmed. Live coding holdout WIN or honest LOSS named. Junk silent. |
| **SOTA CLI-agent memory** | Terminal-Bench 2.1 **Δ** vs locked harness (k=5), tokens reported. |
| **SOTA at 1M chat scale** | BEAM-1M under the paper harness. |
| **Actually helps** | Next turn more correct or cheaper, or inject omitted. Continuity across sessions. Harmed packets gone next time. First session works without reading MEMORY-WAVES.md. |

Until then, the true position is: Simple RAG, unofficial metrics, dual API, extract that deletes the job, SF that is 0.45× mute, LoCoMo retrieve in the 30s, coding-miss unmeasured, LME-V2 / BEAM / Terminal-Bench Δ absent.

### 9.3 MUST / SHOULD / SKIP (90-day run order)

**MUST:** MAB Table 3 on `AgentMemory` inject; LME-V2 Small (even a loss diagnoses missing tools/files); Terminal-Bench 2.1 Δ; internal coding-holdout on hook.

**SHOULD:** BEAM-1M; LME-M or S* frozen judge; AMA-Bench; MemoryArena; π-Bench; AML coding track; FC assembly protocol 82/27; MemoryBench ELO (humility: memory can be zero lift).

**ONCE / TRAP:** LoCoMo-10 (regression only); LongMemEval-S 115k (fits the window); SWE-Verified absolute % (memory is Δ).

**SKIP:** DMR (saturated 2023 chat); RULER/∞Bench standalone (already MAB leaves); Hotpot/MQuAKE; PersonaMem; HLE; vendor self-boards; HELMET/LongBench v2 (grade models).

**Watchlist:** FileGram, MEMTRACK, RECON, Evo-Memory, Locomo-Plus.

**90 days:** (1) freeze one API under test; (2) MAB Table 3 protocol; (3) LME-V2 Small; (4) TB 2.1 Δ; (5) recode holdout on hook; (6) BEAM-1M / LME-M only after 2–4; (7) LoCoMo J once, never optimize.

Detail: `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md` §§0–4, 7–9, 11.

---

## 10. Anti-goals

- Another whatever-loop on bakeoff rec5.
- QUERY_LIGHT / `-ship` / LoCoMo hay in the core.
- Mem0 extract on ICL / novels.
- GraphRAG EventQA.
- Quote retrieve@40 as MCC or gold-in-24 as selective forgetting.
- Wire unused `BrainMemory` into the hook to reuse a bench win that required disabling CLS.
- Claim LoCoMo 92.
- Treat GPT-5-mini 60.6 as a BM25 problem.
- Gated UI rebuild phases (landing/account) as part of this plan — `apps/web/REBUILD.md` stays one phase at a time, separate.
- Default PreToolUse / memory tools (unlocked later, not the lock).
- Reimplementing memorable.sh (or Mem0, Letta, Zep) under an Eden name.
- `memorable-cli`, Memorable MCP, `memory_search`, or cloud extract as the hippocampus.
- Fail-closed writes that 403 the host. Consent is operator on/read-only/off.
- Putting a 60ms CLI recall in front of inject.
- Merging HowToStore into compile/DC% this family (guidance ≠ compiled program).
- Changing the locked whatever harness.
- Pushing git unless asked. Remote stays `KaiavN/Eden`.

---

## 11. Verification

Full Done-whens live in `docs/MEMORY-WAVES.md`. Summary:

| Wave | Gate |
|---|---|
| M1 | Inject API freeze; protocol sheet; characterization; baselines |
| M2 | Wrap + hook store tools; no `please` drop |
| M3 | Cue = this turn; one observe/inject order |
| M4 | Hay gone; `auth.ts`; failing-is does not delete Clerk |
| M5 | File lock; session `ep`; fail-open preserved |
| M6 | Holdout RESULTS on hook inject; dual-API CI |
| M7 | Sleep tombstones; gist on SessionStart |
| M8 | MH top-1 on inject is last hop; labeled packet |
| M9 | Structured experience: order/exit kept; HowToStore shell |
| M10 | Sleep writes how-to; revisions; no promote on fail |
| M11 | How-to integrity: no invented steps; omit stale place |
| M12 | Cue completes `[procedure]` on existing inject; no memory tools |
| M13 | Honest off / read-only; scrub; doctor |
| M14 | How-to on the same memory root wrap+hook already share |
| M15 | Official MAB / LME-V2 Small / TB 2.1 Δ + protocol auditor |
| M16 | M15-EVIDENCE.md; lanes; extract/hop pins red |
| M17–M19 | Store-all: encode kinds, EventQA chunks, ICL atoms |
| M20–M22 | SF: candidates, max(serial), CAR hops |
| M23–M26 | Experience files + LME re-exam |
| M27–M31 | AR SH/MH, LRU, Recsys |
| M32–M34 | TB Δ, router, persist/packet quality |
| M35–M36 | Negative + adversarial walkthrough |
| M37 | Official inject scoreboard. Command stays |
| M38–M41 | Remain-silent (Start exempt), diverse packet, provenance, host pathCues |
| M42–M46 | Incremental sleep, pin/forget, identity proof, subagents, import |
| M47–M49 | Help ledger (wrap+hook), live coding holdout, first session |
| M50 | **Product that actually helps.** Plan §7 + scoreboard + HELP.md. Leftovers none. `/memory-wave` deleted |

A broken Eden never breaks the agent. Memory miss is visible in logs, not a thrown request.

---

## 12. Pointers

- Scoreboard & competitor autopsy: `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md`
- 2026 competitors (integrate, do not clone): `docs/MEMORY-COMPETITORS.md`
- Bakeoff (retrieve@5, not this product’s exam): `benchmarks/memory-bakeoff/`
- Superseded LoCoMo-92 hypotheses: `benchmarks/memory-bakeoff/brain/HYPOTHESES.md`
- Builder waves (50×4, parallel parts): `docs/MEMORY-WAVES.md`
- Company roadmap (compile/DC% + Arc 9): `docs/ROADMAP.md`
- UI rebuild (unrelated): `apps/web/REBUILD.md`
- Product internals: `src/index.ts` (`relevant`, persist, inject), `packages/cli/src/memory-hook.ts`, wrap `proxy.ts` / `anthropic.ts`
- CLS (bench, to be absorbed): `src/brain-memory.ts`, `src/cls/{controller,episodic,semantic,text}.ts`
