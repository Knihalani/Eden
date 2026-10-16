# Eden Memory — 2026 competitor autopsy

> **Superseded: history of the M1–M50 memory waves (September 2026).** The memory program now builds from [memory-ship/](memory-ship/): [ROADMAP.md](memory-ship/ROADMAP.md) orders the work, [DECISIONS.md](memory-ship/DECISIONS.md) wins every conflict, and [PROGRESS.md](memory-ship/PROGRESS.md) says what is done.

**Dated 2026-09-19.** Feeds `docs/MEMORY-PLAN.md` §5. **Not a clone spec.** We take mechanisms that fit Eden’s animal and leave everyone else’s product.

**Name collision:** [two-tech-dev/memorable](https://github.com/two-tech-dev/memorable) and [taecontrol/memorable](https://github.com/taecontrol/memorable) are **MCP GraphRAG products**. They are **not** [memorable.sh](https://www.memorable.sh/). Do not install them.

---

## 0. Integration, not a copy

Eden is silent CLS: `observe` → this-turn `inject` → `sleep`. Competitors are useful as **existence proofs** (how-to can be stored; fail-closed hurts the agent; vendor % lie). They are not a bill of materials.

| Learning | Why it is real | How it lands in *this* product |
|---|---|---|
| Tool experience has **order and outcomes** | Flattened “Tool X result is Y” cannot replay *how* | M2 already observes tools. **M9** keeps `{order, files, exit}` beside the episode. Hippocampus stays store-all. |
| **Sleep** should compress success, not the whole mess | Encode-time LLM extract is Mem0 (MAB 21.1) | **M10** is another lane of the same `sleep()` that already tombstones facts and writes gists. Dead ends stay episodic; they do not become how-to. |
| *How* is not LWW the way *what* is | A worse second fix must not delete a passing one | **M11**: directed forgetting for skill — revisions, omit stale place cells, never invent a missing step. Not a vendor procedure-graph product. |
| Cue-complete, don’t ask the model to search | `memorable recall` / Letta tools are the anti-thesis | **M12**: `[procedure]` in the existing packet via `cueFor` / `notesFor`. Same k. Chat-only: none. |
| Humans need an off switch; agents must not 403 | Memorable fail-closed; Eden fail-open | **M13**: on / read-only / off. Off = inject identity. |
| One brain | Wrap singleton vs hook session already bit us (M5) | **M14**: how-to lives on the memory root like semantic/gists. |
| Memory can be zero lift or **harm** | Proactive Memory Δ; Memorable at least admits no-help runs | **M35** bench annex (NEGATIVE/SAVINGS). **M38** remain-silent. **M47** live wrap+hook HELP.md. |
| Lookup ≠ answer | AutoMem 97% retrieve vs 87% accuracy | **M8** assembly already (unit). Official hops are M21–M22. How-to is the coding-agent form of the same synthesis gap. |
| Public benches miss write precision, forgetting, weeks-long coding | Field has no good exam | **M35 / M43 / M44 / M47–M48**. Do not pretend Table 3 covers them. |

**Compile vs how-to:** DC% compile (`docs/ROADMAP.md`) is a **deterministic program**. How-to in the packet is **guidance** (the model still runs). A later miner may eat how-to; this family does not become compile.

---

## 1. Memorable.sh (YC) — what they built (for contrast)

Homepage + `garrytan/gbrain` `docs/memorable-agents.md` (the only technical integration sheet; Memorable CLI is **closed-source npm** `memorable-cli` 0.5.18, no public repo). We read this as a contrast, not a spec to port.

| Layer | Object | What they actually store / do |
|---|---|---|
| **L1 Traces** | Ordered tool calls | Prompt + files/commands/results **in order**, with **real exit codes**. Empty / read-only sessions refused (`no_decisive_steps` → `rejected.jsonl`). Transcript is not the object. |
| **L2 Workflow synthesis** | Procedure | Strip dead ends. Keep the sequence that reached the goal. Steps + precondition + postcondition + **verify command**. Same trace → same steps (they claim deterministic parse). |
| **L3 Graph assembly** | Shared prefixes | Overlapping steps become composed paths. Identical steps refresh a revision; a **different** approach is a sibling (worse second attempt must not clobber a working first). Recall prefers the revision with the better track record after a trial window. |
| **L4 Retrieval** | Guide, not chunks | Exact → lexical → semantic-on-miss, marketed **~60ms**. Chained plan = ordered procedures **plus named gaps**. |

**Operator surface they got right:**

- Hooks on Claude Code / Codex / Cursor / OpenCode; any other harness `POST /v1/extract` JSON.
- `enable` (write) / `disable` (read-only) / `forget` (recall off). Human consent, not agent consent.
- `doctor` names half-consented states (wired-but-never-fired Codex hooks, receipts never relayed).
- Savings per run, **including runs where memory did not help**.
- Scrub: conversation text stays off the `record` path; prompt + allow-listed tool args may leave. `ingest` **can** send conversation (2 MB).
- `show` wraps the procedure in a **data-not-instructions** guardrail.
- Optional read-only MCP (five tools) — **refuse as default**.
- Embeddings: reuse local if present; else server-side; else **degrade to exact+lexical** (do not fail).

**Operator surface they got wrong for Eden:**

- `memorable recall` before the task is **`memory_search` with a CLI costume**.
- Fail-closed writes/recall. Unset = deny. `forget` kills recall. Name-only traces rejected.
- Closed-source hippocampus. Cannot pin a test to their extractor.
- Cloud extract + `/v1/embed` on lexical miss. Anonymous `mk_` key; gbrain says “no account ⇒ no deletion path.” Statelessness is **their claim, unverified**.
- Dashboard / `memorable graph`. Gated UI is a different rebuild.
- 60ms as a trophy. Eden inject is already sub-millisecond (M6.4 p50 **0.048 ms** / p95 **0.133 ms**). Adding a subprocess in front of inject is a regression.
- Marketing: 100% completion (454/454 on a 3-bug fixture), 98% less context vs a 15,593-token **skill dump**, 40% fewer tool calls. Saturated fixture + skill-dump denominator. Not a negative control.

**Harness capture is unequal (take the honesty, not the matrix):**

| Harness | Capture | Gotcha |
|---|---|---|
| Claude Code | Session-end hook, full tool args | — |
| Codex | Session-end `hooks.json`; **no per-call success flags** | Trust entry goes stale → hooks fail **silently** |
| OpenClaw | Per compaction only; **tool names only** | Extraction refuses as not replayable |
| Other | Manual `ingest` JSON | Conversation text can leak on this path |

---

## 2. Gap vs Eden M1–M14 (what we still owe *this* animal)

M1–M14 closed the how-to spine. The remaining hole is **SOTA mechanisms (M16–M37)** plus a product that **actually helps (M38–M50)**. Memorable proved how-to is load-bearing for coding agents. Filling it does not mean shipping their four-layer product.

| Eden today | Still missing | Wave |
|---|---|---|
| Silent inject, fail-open, any-agent | Keep | — |
| How-to spine (order/exit, sleep success, cue-complete) | Keep (M9–M14 closed) | — |
| M11.4 zero-lift planned | Helped / no-lift / **harmed** | **M35** annex · **M47** HELP.md |
| Always-on junk | Remain-silent | **M38** |
| Weeks-long / multi-session coding | Continuity + holdout | **M44 / M48** |

**Eden is already ahead** on fail-open, silent default, in-process inject (M6.4 **0.048 / 0.133 ms**), no closed-source extract, no dashboard, no MCP in the loop. Do not regress.

---

## 3. Take / leave

| Competitor | Take (into this animal) | Leave (their product) | Wave |
|---|---|---|---|
| **Memorable.sh** | Order/exit on traces; sleep compresses **success**; how-to revisions; aboutness not JSON keys; zero-lift ledger; operator freeze-writes | Recall CLI, MCP, fail-closed, dashboard, cloud extract, closed-source CLI, 60ms SLO, 100%/98% as ship bar, coding-only as the whole brain | M9–M14, **M35 / M47** |
| **Mem0** (MAB **21.1**; vendor LoCoMo 92) | Typed ADD for facts that are facts | Extract on ICL/novels. Chase 92. ADD-only (no tombstone) | Already left. M7 is the anti-Mem0 |
| **Zep / Graphiti** (MAB 24; FC-SH **7**) | Validity intervals as data | KG expecting Table 3 SF to move. Neo4j/FalkorDB | M7/M8 own `(s,p,o,t)` + `max(t)` |
| **Letta / MemGPT** (28.3) | Persisted WM (M5 done) | Memory tools as the loop | Lock |
| **Cognee** | Offline improve from feedback. Forget as a real op | `remember`/`recall` tools. GraphRAG EventQA | Sleep = improve |
| **Supermemory** | Hybrid vector+keyword **only if** product gate still fails | Managed cloud. LongMemEval-**S** as headline | **M33** dense reject-or-add |
| **Honcho** | Async write; dreamer = sleep. Honest that LongMem-S **fits in context** | Dialectic agentic retrieval | No LLM on inject |
| **AutoMem** | Decay of failed rabbit holes. Recall is **lookup, not an LLM** | MCP as the product. Vendor boards | Sleep prune (M10); omit harmed (M47) |
| **LangMem** | How-to as **prompt patch from outcomes** | LangGraph lock-in. Memory manager tools | Pins + English pin/forget (M5 / M43). No separate IntentionStore |
| **Recall (edheltzel)** | Stop-hook capture. SessionStart automatic inject | Mid-session `memory_search` MCP | Silent Start already M7 |
| **agentmemory (rohitg00)** | Auto-capture of tool calls / errors | **50+ MCP tools.** retrieve@5 95.2 | Cite in **M33** reject-in-writing |
| **Mem^p** [arxiv:2508.06433] | Trajectory → script **and** raw trace. Deprecate failures. Skill survives model swap | TravelPlanner as ship bar. Online self-play | M9–M10 |
| **HippoRAG** | Store-all + multi-hit fusion for AR | Graph on ICL. 3 BM25 hops on `#` | M16.2 |
| **MIRIX** | Competency router | Six ontologies | Optional later; not six stores |
| **AgentRunbook** | Trajectories as files + notes + events. LME-V2 exam | Sandbox-as-retriever | Place cells; M15.2 |
| **Proactive Memory / TB** | Memory = **Δ** pts/tokens/$. Always-on can **lose** | Second LLM as memory agent | Skip empty-cue inject. **M32** measures Δ; **M38** owns the gate |
| **two-tech-dev / taecontrol “Memorable”** | — | Entire product | Name collision only |

**Field lesson (AutoMem, June 2026):** retrieval@5 can be 97% while end-to-end accuracy is 87%. First-stage lookup is close to saturated. Remaining work is **synthesis** — M8 assembly for facts, M10–M12 how-to for skill.

**What no public bench measures (M35 / M47–M48):** write precision, directed forgetting, privacy, weeks-long coding, “memory did not help.”

---

## 4. Locked implications (Eden terms)

1. How-to is a **sleep lane**, not an encode-time LLM extract and not a vendor graph.
2. Inject stays **silent**. Cue → `[procedure]` in the same packet. No CLI the model runs.
3. Facts use LWW+tombstone. How-to uses **revisions**. A worse retry must not delete a passing verify.
4. Chat-only hosts mint **zero** how-to and still get facts/gists/rules.
5. Operator: on / read-only / off. Off = inject identity, not 403.
6. No cloud extract. No embedder required.
7. Negative controls are waves.

---

## 5. Pointers

- Product locks: `docs/MEMORY-PLAN.md`
- Builder waves: `docs/MEMORY-WAVES.md` (M1–M50)
- Table 3 autopsy: `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md`
- Memorable product: https://www.memorable.sh/
- Memorable-for-agents (egress + consent): https://github.com/garrytan/gbrain/blob/master/docs/memorable-agents.md
- Mem^p: https://arxiv.org/abs/2508.06433
- AutoMem field guide (why vendor % lie): https://automem.ai/blog/agent-memory-in-2026-an-honest-comparison-of-mem0-zep-letta-and-the-rest
