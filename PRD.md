# Eden
## Product Requirements Document — v3.0

**Date:** May 2026 | **Status:** Implementation Complete

---

> *Eden does not return fast results. It returns correct ones.*
> *Every environment Eden ships has been planned, argued over, fact-checked, written, rewritten, statically analysed, security-patched, stress-tested, exploit-scanned, mutation-tested, profiled, polished — and then reviewed by a dedicated intelligence that decides what is worth remembering forever. The user waits. The work is worth waiting for.*

---

## Part I — Vision and Philosophy

### 1.1 What Eden Is

Eden is an AI-native environment generation system. Given a description of what is needed, Eden produces runnable, verified, production-quality code for it. In any language. Conforming to any framework. At any scale of complexity.

Eden covers the full spectrum of AI environments: reinforcement learning training environments, agent sandboxes, LLM agent evaluation benchmarks, tool-use testing environments, multi-agent arenas, agentic task environments, curriculum suites, adversarial red-team environments, simulation environments, and open-ended sandboxes. Any context in which an AI agent or model needs to operate, be trained, or be evaluated is within Eden's scope.

Eden is not a code generator. Code generators produce plausible-looking output and hand it to the user. Eden runs a long, deep, deliberate pipeline whose purpose is to ensure that what it returns is genuinely correct and genuinely good. The pipeline is slow. Thoroughness is the product.

What makes Eden compound in value over time is the **Archivist** — a dedicated agent that runs after every completed job, whether success or failure. Its sole responsibility is deciding what should be remembered, how it should be structured, what it means, and how future jobs should use it. The Archivist learns equally from success and from failure, using contrastive trajectory comparison to extract actionable patterns from both. It is the memory of the system.

### 1.2 Environment Scope — All Kinds

Eden's scope covers every category of AI environment:

**Reinforcement Learning Environments**
- Episodic and continuing tasks
- Sparse/dense reward and goal-conditioned
- Single-agent and multi-agent (cooperative, competitive, mixed)
- Hierarchical RL
- RLVR environments for LLM training
- Curriculum suites

**Agent Sandboxes**
- Open-ended interaction environments for testing LLM agent behaviour
- Tool-use environments (file system, API, code execution, web interaction, database)
- Multi-step task environments
- Collaborative human-agent environments

**Evaluation and Benchmark Environments**
- Capability benchmarks for specific agent skills (planning, long-horizon memory, reasoning, tool use)
- Agent safety evaluation environments
- Multi-task benchmarks
- Fairness and coverage-optimised evaluation suites
- Adversarial robustness benchmarks

**Training Environments for LLM Agents**
- Agentic task environments for RL fine-tuning
- Verifiable-reward environments for reasoning training
- SWE-bench-style code environments
- Instruction-following environments with verifiable correctness

**Adversarial / Red-Team Environments**
- Environments designed to expose agent failure modes
- Exploit surfaces
- Distribution shift vulnerabilities
- Jailbreak resistance
- Goal misgeneralisation

**Simulation and Digital Twin Environments**
- Abstract simulations of real-world systems
- Robotics pre-training environments
- Social simulation environments
- Economic simulation environments

### 1.3 The Problem

Every AI training or evaluation pipeline depends on environments. Environments are treated as static, hand-crafted artefacts. The consequences are severe:

- **Reward hacking is structural and pervasive.** An empirical study of 15,247 training episodes across 15 RL environments and 5 algorithms found automated detection of six reward hacking categories at pervasive rates — 78.4% precision, 81.7% recall. Most hand-crafted environments are never audited for any of them.
- **AI-generated code fails security tests at scale.** 45% of AI-generated code fails security tests without a systematic patching pipeline (2025 Veracode report).
- **No shared intelligence accumulates.** Every team rediscovers the same failure modes. ExpeL (AAAI 2024) demonstrated that agents learn dramatically better from both success and failure trajectory pairs than from either alone — but no system applies this to environment generation.
- **Agent evaluation environments are themselves poorly designed.** As frontier agent benchmarks saturate, the quality of environments used to evaluate agents becomes the critical bottleneck for progress.

### 1.4 Solution Architecture

Eden solves these problems through:

1. **Multi-agent pipeline with adversarial review** — No single agent's output is trusted; every design passes through Planner → Critic → Refiner → Fact Checker before code is written.

2. **Comprehensive testing in hardware-isolated sandbox** — 12 test categories including exploit scan, mutation testing, and edge case stress, all run in Firecracker microVMs.

3. **Dedicated learning agent** — The Archivist learns from every job outcome and compounds system intelligence over time.

4. **Knowledge base with temporal model** — Facts have chronological and transactional validity, enabling "what did Eden know when" queries.

---

## Part II — The Agent Pipeline

Eden's pipeline is a directed graph of specialised agents sharing a central Knowledge Base. Every agent has a narrowly defined role. No agent improvises outside it. The pipeline has explicit feedback loops with typed routing decisions. A job traverses the pipeline until it passes — there is no timeout-based early return.

```
╔═══════════════════════════════════════════════════════════════════════╗
║                         KNOWLEDGE BASE                               ║
║   Episodic │ Semantic (Graph+Vector) │ Procedural │ Exploit Library  ║
║   ← written by agents (provisional) and Archivist (canonical) →      ║
╚═══════════════════════════════════════════════════════════════════════╝
        ↑↓ all pipeline agents read continuously

[REQUEST] → [PLANNER] → [CRITIC] → [REFINER] → [FACT CHECKER]
                ↑ (replan/re-research loops)
                                                      │
                                               [EXECUTOR]
                                                      │
                                        [CODE QUALITY PIPELINE]
                                         Static→Security→Complexity
                                         →Performance→Documentation
                                                      │
                                               [VERIFIER]
                                                      │
                                               [TESTER]
                                            (microVM sandbox)
                ↑ (fundamental flaw)               │
                └───────────────────────────────────┘
                                                      │ (all tests pass)
                                               [ARCHIVIST]
                                      reads full trace, writes KB,
                                      learns from success + failure
                                                      │
                                            [RESULT DELIVERED]
                                                      │
                                        [EVOLUTION ENGINE] (async)
                              Distiller │ Prompt Evolver │ Research Harvester
                              Retrieval Tuner │ Pattern Miner
```

### 2.1 The Planner

**Role:** Eden's research arm. Before committing to any design decision, the Planner reads — literature, Knowledge Base, framework docs — and synthesises a complete, evidence-grounded Environment Design Plan.

**Research loop:** Multi-hop iterative agentic research. Not a single search — the Planner searches, reads, updates its understanding, forms a refined follow-up query, and searches again. Research budget: ~15 web calls. Sources: arXiv, framework documentation, GitHub, conference proceedings, agent evaluation platform catalogues.

**KB queries at job start:**
- Episodic: similar past jobs — what did Tester find? What did Archivist extract from those jobs?
- Semantic graph: what design decisions causally connect to failure modes for this environment type?
- Semantic vector: what is known about reward design / observation space design / framework APIs for this class?
- Procedural: what code patterns and skills exist for this framework and environment class?
- Archivist-written warnings: any specific flags the Archivist left for this environment class?

**The EDP includes a `archivist_warnings` field** — the Planner must explicitly address every Archivist-surfaced warning for this environment class in its design decisions.

**Environment Design Plan schema:**
```json
{
  "meta": {
    "environment_class": "rl_training | rl_eval | agent_sandbox | llm_agent_eval |
                          tool_use | multi_agent | curriculum | adversarial | simulation | custom",
    "observation_modality": "discrete | continuous | image | language | graph | multimodal | custom",
    "novelty_assessment": "standard | variant | novel",
    "design_confidence": 0.0–1.0,
    "research_sources": [...],
    "kb_references": { "episodic": [...], "semantic": [...], "procedural": [...] },
    "archivist_warnings_addressed": [
      { "warning": "...", "how_addressed": "..." }
    ]
  },
  "environment": {
    "observation_space": {
      "type": "Box | Discrete | Tuple | Dict | ...",
      "shape": "tuple of ints",
      "bounds": "low/high values",
      "sufficiency_rationale": "why this observation is sufficient for the task"
    },
    "action_space": {
      "type": "Box | Discrete | MultiDiscrete | ... ",
      "dimensionality": "int",
      "bounds": "low/high values",
      "meaningfulness_rationale": "why each action matters"
    },
    "reward_structure": {
      "type": "dense | sparse | shaped | verifiable | none",
      "components": [
        {
          "name": "string",
          "formula": "string (mathematical expression)",
          "bounds": "[min, max]",
          "rationale": "string"
        }
      ],
      "shaping_approach": "potential_based | subgoal | none",
      "hacking_risk_per_category": {
        "specification_gaming": {"level": "low|med|high", "mitigation": "..."},
        "reward_tampering": {"level": "low|med|high", "mitigation": "..."},
        "proxy_optimisation": {"level": "low|med|high", "mitigation": "..."},
        "objective_misalignment": {"level": "low|med|high", "mitigation": "..."},
        "exploitation_patterns": {"level": "low|med|high", "mitigation": "..."},
        "wireheading": {"level": "low|med|high", "mitigation": "..."}
      }
    },
    "episode_dynamics": {
      "termination_conditions": ["list of conditions"],
      "max_steps": "int",
      "reset_logic": "string",
      "stochasticity": "sources of randomness"
    },
    "difficulty_parameters": {
      "axes": ["list of difficulty dimensions"],
      "defaults": {},
      "ranges": {}
    }
  },
  "output_spec": {
    "language": "python | typescript | ... ",
    "framework": "gymnasium | pettingzoo | ... ",
    "framework_version": "string",
    "interface_contract": "string (e.g., gym.Env)",
    "entry_class": "string"
  },
  "known_risks": [
    {"risk": "string", "severity": "high|med|low", "mitigation": "string"}
  ],
  "design_decisions": [
    {
      "decision": "string",
      "rationale": "string",
      "alternatives": ["list of alternatives considered"]
    }
  ]
}
```

**KB writes (provisional):** Research synthesis → episodic memory, tagged `provisional`. Novel environment patterns or framework facts → proposed to Archivist queue for review. The Planner proposes; the Archivist decides what enters semantic memory canonically.

---

### 2.2 The Critic

**Role:** The Planner's adversary. Finds every flaw before code is written. Has independent web research access and uses it. Routing is the Critic's most consequential output — it can route back to Planner or forward to Refiner.

**Eight critique dimensions:**
1. **Reward pathology risk** — all six reward hacking categories from empirical literature (specification gaming, reward tampering, proxy optimisation, objective misalignment, exploitation patterns, wireheading)
2. **Observation sufficiency** — can an agent solve the task from what it observes?
3. **Action space validity** — are all actions meaningful? Is any single action dominant?
4. **Termination logic** — is at least one termination path reachable from a valid initial state?
5. **Framework API integrity** — every referenced method/class verified against KB framework subgraph; web lookup when uncertain
6. **Difficulty calibration** — is the task learnable? Too easy? Completable within max_steps?
7. **Specification completeness** — any design decisions left ambiguous for the Executor?
8. **KB conflict check** — does this EDP reproduce a pattern the Archivist has flagged as dangerous for this env class?

**Multi-agent debate for high-uncertainty designs:** For EDPs with `design_confidence < 0.7` or `novelty_assessment = "novel"`, the Critic spawns a Devil's Advocate instance with a contrarian prompt framing. Both critiques are synthesised before routing. Heterogeneous multi-agent debate achieves 4–6% accuracy gains and >30% reduction in factual errors on difficult reasoning tasks.

**Routing (three paths, explicit justification required for each):**
- **Approve with notes** → forward to Refiner with inline annotations
- **Targeted replan** → specific sections back to Planner; existing research reused
- **Full re-research** → faulty research foundation; Planner restarts from web search

**Loop limits:** 3 targeted replan cycles, 2 re-research cycles maximum. Exhausted without approval → escalate to human review.

**KB writes (provisional):** Critique decisions with full rationale → episodic memory. Proposals for anti-pattern entries → Archivist queue.

---

### 2.3 The Refiner

**Role:** Close every gap between a sound plan and an implementable spec. The Executor should receive a document where every design decision is already made.

**Refinement operations:**
1. **Resolve all EDP ambiguities** — every vague parameter gets a concrete, justified value
2. **Expand reward function to implementation-level pseudocode** — precise formulae, exact bounds, component interaction explicitly resolved
3. **Audit reward shaping for potential-based validity** — if non-PBRS, flag and propose PBRS reformulation (PBRS halves return variance in humanoid tasks while preserving or improving final performance per 2025 empirical results)
4. **Enumerate every reachable edge case with explicit handling spec**
5. **Specify output interface to method-signature level** — class names, parameter types, return types matched exactly to declared framework version
6. **Specify complete seeding and reproducibility strategy**
7. **For agent sandbox / LLM eval environments specifically:** specify observation format expected by LLM agents (token budget, system/user message structure), action format parsed from LLM outputs, evaluation metric computation, and scorer implementation

**Output:** RES (Refined Environment Spec) — implementation-ready document with all design decisions resolved.

**KB writes (provisional):** Resolution patterns for EDP ambiguities → Archivist queue for procedural memory promotion.

---

### 2.4 The Fact Checker

**Role:** Verify every empirical claim in the RES before a line of code is written. The primary defense against hallucinated API calls.

**Verification checklist:**
- Every class, method, constant in the RES — exists in the declared framework version?
- Physics plausibility for physics-based environments
- Reward bounds mathematically achievable given declared dynamics
- All library dependencies mutually compatible in declared versions
- Logical consistency: termination conditions reachable, initial state valid
- For LLM evaluation environments: observation format parseable by frontier models? Action space produceable by models?

Checks against framework knowledge subgraph. Fetches live documentation when the KB entry is uncertain or potentially stale.

**KB writes (provisional):** Every fact-check failure → episodic memory and Archivist queue. "Gymnasium 0.29 does not support X; correct call is Y" is a permanent, retrievable fact once the Archivist confirms and promotes it.

---

### 2.5 The Executor

**Role:** Write complete, runnable code from the verified RES. No design decisions — only implementation.

**Process:**
1. Query procedural memory for structurally similar past implementations (by RES fingerprint). Use as architectural reference only — never copy.
2. Query Archivist's "best practice" and Skill Library entries for this environment class and framework — apply all relevant skills.
3. Generate in structured sections for complex environments: skeleton → state management → observations → actions → reward computation → termination → helpers → integration synthesis pass.
4. Self-review pass: does every RES element have an implementation? Any stubs or TODOs? All edge cases handled?
5. Documentation pass: docstrings for every public method, parameter docs, reward function rationale inline.

**Output modes by environment class:**
- `gymnasium_mode` — Gymnasium-compatible Python, proper `spaces`, dtype-matched arrays
- `pettingzoo_mode` — PettingZoo AEC or Parallel API, agent-indexed obs/actions
- `agent_eval_mode` — agent evaluation harness conforming to AgentBench/TAU-bench/custom spec
- `llm_sandbox_mode` — text-based interactive environment with natural language obs/action interface and verifiable reward
- `tool_env_mode` — tool-use environment with defined tool API surface, sandbox, eval harness
- `custom_python_mode` — arbitrary Python interface per RES contract
- `typescript_mode` — TypeScript with declared interface, proper typing
- `multilanguage_mode` — declared language with Python adapter for standard tooling

**KB writes (provisional):** Self-review catches → Archivist queue. Successful implementations (post-Tester) → proposed for Skill Library promotion.

---

### 2.6 The Code Quality Pipeline

Five sequential automated passes. Each loops back to the Executor until the pass clears. Max 8 iterations per pass.

**Pass 1 — Static Analysis**
Tools: `pylint`, `flake8`, `mypy --strict`, `radon` (complexity metrics). Checks: syntax, types, PEP 8, undefined variables, unreachable code, cyclomatic complexity (flag >10, hard block >15). Loops until zero errors, zero warnings.

**Pass 2 — Security Analysis**
Tools: `bandit`, `semgrep` with security rulesets, `safety` (dependency CVE check). Checks: input validation completeness, RNG security, arbitrary code paths, resource limit enforcement, no known-CVE dependencies. Security violations are mandatory blocks — no progression until cleared.

**Pass 3 — Complexity and Maintainability**
Checks: function length (flag >60 lines), class coupling, code duplication (flag >3 duplicate logical blocks), magic number literals, single-letter variable names outside loop contexts.

**Pass 4 — Performance Profiling**
1,000 steps under random policy. Measures: average step() time, memory per step, peak memory, detects O(n²)+ operations. If step() exceeds target (<10ms non-physics, <50ms physics), Executor prompted to identify and optimise bottleneck. Annotated in quality report.

**Pass 5 — Documentation Quality**
Checks: every public method has docstring, reward function rationale in class docstring, all `__init__` parameters documented with type and description, non-obvious decisions have inline comments, edge case handling documented.

---

### 2.7 The Verifier

**Role:** Fidelity check. Does the generated code match the RES? Every required method, interface contract, reward component, difficulty parameter — present, correctly typed, correctly bounded?

**Checks:**
- Interface compliance: all required methods, correct signatures
- RES fidelity: reward matches pseudocode, termination conditions match spec, difficulty parameters applied
- Completeness: zero stubs, TODOs, placeholders, zero undefined imports

**Escalation:** Same flaw recurring across three Executor revision cycles → escalate to Refiner (the spec may be wrong, not just the code).

**KB writes (provisional):** Verification failure patterns → Archivist queue for procedural memory promotion.

---

### 2.8 The Tester

**Role:** Ground truth. Actually runs the code. Trusts nothing claimed upstream. Runs in a **Firecracker microVM sandbox** — hardware-level kernel isolation, own kernel per sandbox, auto-destroy after each run. Shared-kernel containers are insufficient for untrusted LLM-generated code at production scale.

**Twelve test categories:**

1. **Instantiation** — 20 seeds × all difficulty parameter extreme combinations. No errors.

2. **Reset integrity** — 50 seeds. Observations match declared space dtype and bounds. No state leakage between resets. Mid-episode reset handled correctly.

3. **Step validity** — 10,000 random-action steps, 5 episodes. No exceptions. All observations and rewards within declared bounds. Terminal flags consistent with episode logic.

4. **Termination reachability** — goal-directed scripted policy. At least one episode terminates within max_steps across 10 attempts. Task is solvable.

5. **Reward non-degeneracy** — reward non-constant across 1,000 random steps. At least two distinct actions from same state produce different rewards or next-state distributions. Observed range spans ≥20% of declared range.

6. **Reproducibility** — identical seeds produce byte-identical trajectories, 5 seeds × 100 steps.

7. **Exploit scan** — full applicable Exploit Library applied. All six reward hacking categories probed. Any probe achieving >90th-percentile reward without task completion → formal exploit finding.

8. **Mutation testing** — 20 reward function mutants generated. Quality test suite should detect >70% of mutants. If <70% detected → insufficient reward signal differentiation, flagged as design quality issue.

9. **Edge case stress** — zero/max actions, boundary state inputs, immediate termination (step 1), very long episodes (10× max_steps), adversarial seeds retrieved from KB historical records.

10. **Performance validation** — 10,000 steps timed. Memory profiled across 1,000 episodes (leak detection). Results vs. declared targets.

11. **Curriculum coherence** (if curriculum suite) — difficulty monotonically increases across sequence, common interface across all suite members, smooth difficulty parameter transitions.

12. **Documentation smoke test** — all docstring examples execute without error. Quality report values match measured properties.

**Routing on failure:**
- **Patch-level** (localised error) → Executor with specific failure trace
- **Design-level** (structural implementation problem) → Verifier + Executor
- **Fundamental** (intrinsic design flaw not fixable at implementation level) → **Planner** with complete failure analysis; Archivist simultaneously invoked for early extraction

**Iteration limits:** 5 Executor cycles for patch-level, 3 for design-level, 2 for fundamental. Exhausted → flag for human review. Eden does not deliver a failing environment.

**KB writes (provisional):** All results — per-category, per-probe, performance metrics — queued for Archivist extraction.

---

### 2.9 The Archivist *(dedicated learning agent)*

The Archivist is a dedicated agent whose entire purpose is memory and learning. It runs on every completed job — successful or not. It reads the full job trace and converts it into durable, structured, retrievable knowledge. It is the only agent whose primary job is learning rather than generating.

The Archivist's theoretical basis:

**ExpeL methodology (AAAI 2024):** Agents learn best from comparing successful and failed trajectories for similar tasks. Two learning modes: (1) comparing failed vs. successful trajectories for the same environment class to identify the specific decisions that made the difference, and (2) identifying patterns within sets of successful trajectories to extract generalisable best practices. Research shows failure-derived heuristics excel on planning tasks (+14.3% over baseline) while success-derived heuristics excel on execution tasks (+9.0%) — both are essential.

**Voyager Skill Library:** Successful, verified procedures are stored as reusable, parameterisable skills indexed by natural language descriptions, retrieved by semantic similarity. Skills compound the system's capabilities without catastrophic forgetting.

**AUDN write protocol:** Every semantic memory write applies one of: Add (new fact, no conflict), Update (existing fact gets revised evidence or confidence), Delete (fact superseded or invalidated), None (no write needed). Prevents KB pollution.

**Archivist process — runs on every job:**

**Step 1 — Full trace ingestion.** Complete job trace: request, all EDPs (every iteration), all Critic decisions with rationale, all routing events, RES, Code Quality Pipeline results per pass per iteration, Verifier report, complete Tester results including individual probe outcomes, all performance measurements. The Archivist reads all of it.

**Step 2 — Outcome classification.** The Archivist assigns an outcome tier:
- **Gold** — passed all Tester categories on first Executor attempt; ≤2 Code Quality iterations; no Critic routing loops
- **Silver** — passed all Tester categories; normal iteration profile
- **Bronze** — passed but required above-average iterations or one replan cycle
- **Partial** — passed but with flagged quality concerns or borderline probe results
- **Failed** — fundamental failure requiring Planner restart; or exhausted iteration limits

**Step 3 — Success extraction (Gold and Silver jobs).**

*Contrastive pattern analysis:* The Archivist retrieves the most similar past jobs of lower outcome tier (Bronze or below) for the same environment class. It compares the two traces side-by-side using the ExpeL methodology: what design decisions did the Gold job make that the lower-tier jobs did not? What did the Critic catch in the Gold job's replan that was absent from failed jobs? What did the Executor do differently? The contrastive comparison produces specific, actionable insights rather than generic observations.

*Best practice extraction:* Generalisable patterns are written to semantic memory as best practices: "For discrete navigation environments with sparse reward, combining step penalty + terminal bonus + potential-based distance shaping consistently produces Gold outcomes and clean exploit scans across N validating episodes." Each practice has: description, applicable environment classes, supporting episode IDs, confidence score, and an `IMPROVES` edge to the relevant quality metric.

*Skill extraction (Voyager-style):* If the implementation contains a reusable pattern — a well-designed reward component, a clean observation normalisation approach, an elegant curriculum progression strategy — the Archivist abstracts it into a named, parameterisable Skill Library entry: natural language description, parameterisable code, applicable environment classes and frameworks, quality metrics from validating jobs. Future Executors retrieve these by semantic similarity to their current RES.

*Quality fingerprint:* A compact representation of the EDP + RES + quality metrics stored in semantic memory as a positive exemplar. Future Planners retrieve Gold fingerprints as concrete evidence of what works for this environment class.

**Step 4 — Failure extraction (Bronze, Partial, Failed jobs).**

*Root cause identification:* Where in the pipeline was the flaw introduced? Each stage is checked: Planner research gap? Critic approval of a flawed plan? Refiner underspecification? Executor generation error? Fact Checker miss? Framework fact absent from KB?

*Causal chain reconstruction:* The Archivist traces the full decision chain from the EDP to the failure. Each link becomes a graph edge: `design_decision → intermediate_state → failure_mode`. The causal graph is queryable by any node — future Planners can ask "what decisions have caused this failure mode before?"

*Prevention rule:* A structured entry in semantic memory: "When a user requests [environment class] with [characteristic X], and the EDP includes [decision Y], this produces [failure mode Z] with [confidence N/M]. Recommended alternative: [A]." Each rule has evidence citations and an auto-expiring confidence if not validated by subsequent jobs.

*Retrieval gap analysis:* Did the relevant information exist in the KB but fail to be retrieved? If yes, flag to Retrieval Tuner with the specific query that should have returned this result. If no — the knowledge genuinely didn't exist — the Archivist creates it.

**Step 5 — Exploit Library maintenance.** For every novel exploit the Tester discovered, the Archivist abstracts it into a new parameterisable probe script: category, applicable environment classes, applicable reward structure types, probe code (parameterisable), structural preconditions that make this exploit possible, severity, discovery episode, and an Archivist rationale explaining the generalisation. Probe added to Exploit Library.

**Step 6 — Contradiction resolution.** If any newly extracted fact contradicts an existing semantic memory entry, the Archivist creates a `CONTRADICTS` edge and resolves it: which entry has more supporting evidence? Which is more recent? Is the contradiction real or context-dependent? Resolution: supersede, coexist with documented applicability conditions, or flag for Research Harvester investigation.

**Step 7 — Forward annotations for future agents.** Targeted warnings and notes written to semantic memory, indexed by environment class, reward structure type, and framework version, for direct surfacing to specific future agents:

- "Planner warning [env_class X]: when this environment class is requested, watch for [specific pitfall]"
- "Critic priority [reward_type Y]: for this reward structure, prioritise checking [exploit category]"
- "Executor note [framework Z, env_class X]: these code patterns have validated well; avoid [anti-pattern]"
- "Tester priority [env_class X]: these exploit probes have the highest discovery rate for this class"

**Step 8 — KB health maintenance.** Ongoing hygiene:
- Mark semantic entries as `stale` when a framework update invalidates them
- Upgrade confidence scores on entries validated by multiple subsequent jobs
- Demote confidence on entries not retrieved or retrieved but not used in agent reasoning
- Archive raw episodic traces older than 90 days where learnings are fully promoted to semantic memory (Gold and fundamental-failure episodes are never archived)

**Write ownership model:**

Agents write `provisional` to episodic memory and propose semantic/procedural writes via a queue. The Archivist is the sole writer of `canonical` semantic and procedural memory. This maintains KB integrity — agents cannot pollute long-term memory with low-confidence inferences. The Archivist uses AUDN to decide what actually enters the durable knowledge store.

---

## Part III — The Evolution Engine

Asynchronous background processes running continuously, independent of jobs. They do not block jobs. They process the Archivist's raw output at scale and feed improvements back into every system component.

### 3.1 The Distiller

Nightly batch process. Clusters episodic memory by environment class, reward structure type, and outcome. For clusters with ≥5 jobs showing a consistent pattern: generates a semantic fact with confidence score and evidence citations. For clusters with contradictory patterns: generates conditional facts ("X is true when Y, not when Z") or flags for Research Harvester.

Specifically mines for **cross-job success patterns** the per-job Archivist may miss: "Across 47 discrete navigation environments built over 3 months, Gold outcomes shared three structural reward properties: [X, Y, Z] — present in 89% of Gold, 23% of Silver, 6% of Bronze."

### 3.2 The Prompt Evolver

Per agent, per 50-job rolling window. If downstream quality metrics degrade: retrieve 10 failure cases where this agent was active, generate structured failure analysis, propose 3 candidate improved prompts, A/B test on next 20 jobs, promote winner.

Also runs on improvement: when quality metrics improve significantly, the Prompt Evolver identifies what changed and reinforces it. Improvement is a signal worth understanding, not just ignoring.

Research basis: GEPA (ICLR 2026) — reflection-based prompt evolution outperforms RL-based approaches by 6% average (up to 20% on specific tasks) with 35× fewer rollouts.

Scope: all agent system prompts, KB retrieval query templates, Archivist extraction prompts, Tester probe analysis prompts.

### 3.3 The Research Harvester

Weekly crawl: arXiv (RL, multi-agent, environments, benchmarks, curriculum learning, reward design, agent evaluation, LLM training), framework release notes (Gymnasium, PettingZoo, MuJoCo, Brax, Isaac Lab), conference proceedings (NeurIPS, ICML, ICLR, IROS, ACL agent evaluation tracks), agent evaluation platform updates (OpenReward, AgentBench, WebArena, SWE-bench, TAU-bench, ComplexMCP).

Extracted findings → proposed to Archivist (running in batch mode) for AUDN validation before promotion to semantic memory. Framework changes trigger targeted `VALID_UNTIL` updates on superseded KB entries and `SUCCEEDED_BY` edges to new entries.

### 3.4 The Retrieval Tuner

Every KB retrieval tagged with agent ID, job ID, and query. After job completion, the Archivist's trace identifies which retrieved items appeared in agent reasoning. Queries that consistently retrieve irrelevant items → retrieval strategy adjusted (embedding model, similarity threshold, metadata filters, hybrid search weighting). Queries that consistently retrieve relevant items → strategy reinforced.

Active at 200 completed jobs. Logging from day one.

### 3.5 The Pattern Miner

Monthly deep cross-job analysis. Complex graph queries across semantic memory:
- "Which design decisions appear in >80% of Gold outcomes across all environment classes?"
- "Which reward structure types have the highest exploit scan failure rates?"
- "Which framework versions have the highest fact-check failure rates?"
- "What Critic routing decisions most reliably predict downstream Tester fundamental failures?"
- "Which Archivist-extracted Skill Library entries are most frequently retrieved and used?"

Produces a monthly intelligence report written to semantic memory. The Planner is configured to retrieve the most recent Pattern Miner report relevant to the current environment class at job start.

---

## Part IV — The Knowledge Base

### 4.1 Architecture

Four layers with distinct data models and retrieval mechanisms.

**Layer 1: Episodic Memory**
Raw, timestamped, immutable job records. PostgreSQL + JSONB. Full-text search on prose fields via tsvector. Time-series indexing on quality metrics. Retrieval scored by three factors per Generative Agents framework: recency, semantic relevance to current context, and salience (Gold outcomes and fundamental failures score high on salience). All four properties of valid episodic memory per the 2025 position paper: long-term storage, explicit reasoning support, instance-specific details, and contextual binding (who/when/where/why bound to content).

**Layer 2: Semantic Memory — Temporal Knowledge Graph**
Implementation: Zep/Graphiti temporal knowledge graph. Benchmarks: 94.8% on Deep Memory Retrieval, 18.5% improvement on LongMemEval with 90% latency reduction. Chosen because temporal knowledge graphs preserve how facts changed over time — critical when framework APIs change and environment design knowledge evolves.

Bitemporal model: every fact has chronological validity (when it was true in the world) and transactional validity (when Eden learned it). Enables: "What was Eden's understanding of Gymnasium 0.28 reward spaces before the 0.29 release?" — essential for auditing past decisions.

AUDN write protocol on every semantic write. Retrieval via Qdrant (hybrid dense+sparse, cross-encoder reranking, metadata filtering) run parallel to graph traversal. The 2026 Mem0 research reports 91% latency reduction and >90% token cost reduction vs. full-context retrieval, averaging ~7,000 retrieval tokens vs. 25,000+ for comparable full-context.

Graph node types: `EnvironmentClass`, `DesignPattern`, `FailureMode`, `BestPractice`, `Skill`, `FrameworkFact`, `ResearchFinding`, `Exploit`.

Graph edge types: `CAUSES`, `PREVENTS`, `ENABLES`, `IMPROVES`, `CONTRADICTS`, `DISCOVERED_IN`, `VALIDATED_BY`, `VALID_FOR`, `SUPERSEDED_BY`.

**Layer 3: Procedural Memory**
Skill Library (Voyager-style): verified code patterns with natural language descriptions, parameterisable implementations, applicable environment classes and frameworks, quality metrics from validating jobs. Prompt store: all agent prompts versioned with performance metrics per 50-job window.

**Layer 4: Exploit Library**
Parameterisable adversarial probe scripts. Each entry: category, applicable environment classes, applicable reward types, probe code, structural preconditions, severity, discovery episode, Archivist generalisation rationale. Queried by Tester at job start to retrieve all applicable probes for the current environment's class and reward structure.

### 4.2 Who Writes What

**Provisional writes (during jobs, by agents):**
Agents write research synthesis, framework fact failures, and implementation notes directly to episodic memory tagged `provisional`. Agents may propose semantic/procedural memory writes via a proposal queue. Proposals are not live until Archivist review.

**Canonical writes (post-job, by Archivist):**
Only the Archivist writes to semantic and procedural memory with `canonical` status, using AUDN. This is the KB integrity guarantee — agents cannot pollute long-term memory with hallucinated or low-confidence inferences.

**Batch writes (Evolution Engine, via Archivist batch mode):**
Distiller, Pattern Miner, Research Harvester all propose; Archivist batch process validates and commits using AUDN.

---

## Part V — Technical Architecture

### 5.1 Orchestration

**LangGraph with PostgresSaver checkpointing.** LangGraph's graph-based architecture enables the cyclic processes, conditional routing, and persistent state Eden requires. v1.1 (December 2025) added model retry middleware with exponential backoff. Production consensus: PostgresSaver for production — MemorySaver loses state on process restart, unacceptable for a pipeline running 30–90 minutes per job.

Job state is persisted at every node transition. Jobs survive infrastructure restarts mid-pipeline.

**State schema (typed):**
```python
class EdenJobState(TypedDict):
    job_id: str
    request: dict
    edp_history: list[dict]          # all EDP iterations
    critic_decisions: list           # full decision history with rationale
    routing_history: list            # every routing event with timestamp
    res: Optional[dict]
    fact_check_report: Optional[dict]
    code_history: list[str]          # all code iterations
    quality_reports: list            # per-pass, per-iteration
    verifier_report: Optional[dict]
    tester_results: Optional[dict]
    kb_reads: list                   # all queries + results (for Archivist)
    agent_proposals: list            # proposed KB writes (for Archivist)
    outcome_tier: Optional[str]      # set by Archivist
    archivist_summary: Optional[dict]
```

### 5.2 LLM Routing Per Agent

| Agent | Model | Avg calls/job | Notes |
|---|---|---|---|
| Planner | Claude Sonnet 4 | 4–8 | Multi-hop research iterations |
| Critic | Claude Sonnet 4 | 3–6 | +3–4 calls for Devil's Advocate on novel envs |
| Refiner | Claude Sonnet 4 | 2–3 | |
| Fact Checker | Claude Sonnet 4 | 2–4 | Live doc fetches add calls |
| Executor | Claude Sonnet 4 | 3–8 | Sectional generation for complex envs |
| Code Quality Pipeline | Claude Haiku 4.5 | 2–6 per pass | Per-iteration |
| Verifier | Claude Haiku 4.5 | 1–2 | |
| Tester | Claude Haiku 4.5 | 2–4 | Result analysis + probe interpretation |
| **Archivist** | **Claude Sonnet 4** | **5–15** | **Reasoning-heavy; every job; justified by compound value** |
| Distiller | Claude Haiku 4.5 | N/nightly | Batch at scale |
| Prompt Evolver | Claude Sonnet 4 | Periodic | Failure + success analysis |
| Pattern Miner | Claude Sonnet 4 | Monthly | Deep cross-job analysis |

### 5.3 Sandbox

**Tester execution in Firecracker microVMs.** Hardware-level isolation using KVM — each sandbox has its own kernel. Boot time: ~150ms. Auto-destroy post-run. Network isolated. Filesystem: generated code only. No access to Eden infrastructure, KB, or internet from sandbox.

Three runc CVEs (November 2025) affected all shared-kernel container runtimes simultaneously. MicroVMs are the correct isolation level for executing untrusted generated code.

### 5.4 Storage Stack

| Component | Technology | Rationale |
|---|---|---|
| Episodic memory / job state | PostgreSQL (Supabase) + JSONB | Structured queries, time-series, full-text, LangGraph checkpointing |
| Semantic graph | Neo4j Aura + Graphiti | Temporal KG, causal edges, bitemporal model |
| Semantic vector | Qdrant Cloud | Hybrid dense+sparse, metadata filtering, <100ms retrieval |
| Procedural / Skill Library | Qdrant + S3 | Vector search on code embeddings, object store for artefacts |
| Exploit Library | PostgreSQL + Qdrant index | Structured querying + semantic probe retrieval |
| Prompt store | PostgreSQL | Versioned, performance-tracked per 50-job window |
| Sandbox execution | Firecracker microVMs | Hardware-level isolation |

### 5.5 Cost Model

| Job Type | LLM Cost | Infra | Total | Target Price |
|---|---|---|---|---|
| Simple (discrete, standard) | $0.50–0.80 | $0.05 | $0.55–0.85 | $5–8 |
| Standard (continuous, physics) | $1.00–1.80 | $0.12 | $1.12–1.92 | $10–18 |
| Complex (multi-agent, novel) | $2.50–4.50 | $0.30 | $2.80–4.80 | $25–45 |
| LLM Agent Eval Environment | $1.80–3.50 | $0.20 | $2.00–3.70 | $18–35 |
| Curriculum Suite (5+ envs) | $5.00–9.00 | $0.60 | $5.60–9.60 | $50–90 |

Archivist adds ~$0.40–1.00 per job over direct-generation estimates. This is the cost of memory — it compounds positively across every future job by reducing iteration cycles in later jobs. Target gross margin: 65–80% at scale. Margin grows as KB quality accumulates.

---

## Part VI — Seed Corpus

### Research (~250 documents)
- UED: PAIRED, PLR, POET, CENIE, AutoEnv, OpenReward
- Reward: PBRS papers (2017–2026), reward hacking empirical study, ARA, FDSP
- Curriculum: SPEED-RL, AgentScaler, PERM, proximal curriculum, difficulty calibration
- Agent evaluation: AgentBench, TAU-bench, WebArena, SWE-bench, TextQuests, ComplexMCP, ToolEmu
- Memory systems: ExpeL, Voyager, Reflexion, MAR, Graphiti paper, Mem0 ECAI 2025, ProcMEM
- Code quality: LLMLOOP, CoverUp, mutation testing with LLMs, GEPA
- Framework docs: Gymnasium 0.26–0.29, PettingZoo 1.22–1.24, MuJoCo 2/3, Brax, Isaac Lab

### Failure Modes (~45 curated)
- 6 reward hacking categories × 5 specific patterns each = 30 RL failure modes
- 8 agent sandbox failure modes (context leakage, tool abuse, observation gaming, etc.)
- 7 LLM evaluation environment failure modes (benchmark contamination, scorer gaming, difficulty miscalibration, verifier bypass, etc.)

### Exploit Library (~25 hand-written probes)
- 6 base (one per reward hacking category)
- 5 continuous control specific
- 5 text/language environment specific
- 4 multi-agent (collusion, freeloading, communication exploit, attention gaming)
- 3 LLM agent evaluation specific (scorer gaming, context window abuse, chain-of-thought manipulation)
- 2 curriculum gaming (performing well on easy tasks to avoid harder ones)

### Skill Library (~20 reference implementations)
- 4 RL discrete, 4 RL continuous, 3 text/language, 3 multi-agent, 3 agent evaluation harnesses, 3 benchmark/curriculum suites. All hand-written, fully tested, Archivist-reviewed.

---

## Part VII — Metrics

### Quality (should improve monotonically as KB grows)
- **Test pass rate (first Executor attempt):** >75% at 3mo, >90% at 12mo
- **Fundamental failure rate:** <10% at 3mo, <2% at 12mo
- **Exploit scan clean rate:** >85% at launch, >95% at 12mo
- **Framework compatibility rate:** >98% from day one
- **Gold outcome rate:** >40% at 6mo, >60% at 12mo

### Self-Improvement (the compound)
- **KB leverage rate:** fraction of jobs where Archivist-canonical entries appear in agent reasoning traces
- **Routing rate trend:** Critic replan rate + Tester routing rate over time (should decline monotonically)
- **Repeat failure rate:** same failure mode in consecutive jobs for same env class (should approach zero)
- **Skill Library reuse rate:** fraction of jobs where Executor retrieves and uses a Skill Library entry
- **Archivist extraction durability:** fraction of Archivist-proposed canonical writes still used and uncontradicted after 30 subsequent jobs
- **Prompt Evolver improvement delta:** mean quality metric improvement per evolution cycle (should be positive)

### System
- Median job completion time (end-to-end including Archivist)
- Cost per job (actual vs. model)
- KB retrieval latency (p50, p95)
- Sandbox cold start latency

---

## Appendices

### A. EDP Schema Reference

Complete field definitions for the Environment Design Plan:

**meta:**
- `environment_class`: One of the defined classes, or custom if none fit
- `observation_modality`: How the agent perceives the environment
- `novelty_assessment`: standard/variant/novel — affects research depth
- `design_confidence`: 0.0-1.0 — affects Devil's Advocate spawning
- `research_sources`: List of sources cited in design decisions
- `kb_references`: Links to relevant KB entries (episodic, semantic, procedural)
- `archivist_warnings_addressed`: How each warning was handled

**environment.observation_space:**
- `type`: Gymnasium space type (Box, Discrete, Tuple, Dict)
- `shape`: Tuple of integers
- `bounds`: low/high values as list or value
- `sufficiency_rationale`: Why this observation is sufficient for the task

**environment.action_space:**
- `type`: Gymnasium space type
- `dimensionality`: Number of action dimensions
- `bounds`: low/high values
- `meaningfulness_rationale`: Why each action matters to the task

**environment.reward_structure:**
- `type`: dense/sparse/shaped/verifiable/none
- `components`: Array of {name, formula, bounds, rationale}
- `shaping_approach`: potential_based/subgoal/none
- `hacking_risk_per_category`: Risk levels and mitigations for all six categories

**environment.episode_dynamics:**
- `termination_conditions`: Array of conditions that end an episode
- `max_steps`: Maximum steps per episode
- `reset_logic`: How reset() initializes the environment
- `stochasticity`: Sources and handling of randomness

**environment.difficulty_parameters:**
- `axes`: Array of difficulty dimensions
- `defaults`: Default values for each axis
- `ranges`: Valid ranges for each axis

**output_spec:**
- `language`: Implementation language
- `framework`: Target framework
- `framework_version`: Specific version
- `interface_contract`: Expected interface (e.g., gym.Env)
- `entry_class`: Class name for the environment

### B. Outcome Tier Definitions

| Tier | Definition | Pipeline Profile |
|------|------------|-------------------|
| **Gold** | Passed all Tester categories on first Executor attempt; ≤2 Code Quality iterations; no Critic routing loops | Optimal: no iteration overhead |
| **Silver** | Passed all Tester categories; normal iteration profile | Expected: some iteration normal |
| **Bronze** | Passed but required above-average iterations or one Critic replan | Suboptimal: extra iteration overhead |
| **Partial** | Passed but with flagged quality concerns or borderline probe results | Concerning: may need attention |
| **Failed** | Fundamental failure requiring Planner restart; or exhausted iteration limits | Problematic: pipeline couldn't resolve |

### C. Test Category Reference

Full specification for each of the 12 Tester categories:

**C.1 Instantiation**
- 20 seeds × all difficulty parameter extreme combinations
- Pass: zero exceptions, zero import errors
- Fail: any import error, any constructor error

**C.2 Reset Integrity**
- 50 seeds, verify 5 observations per seed
- Pass: dtype matches declared, bounds match declared, no state leakage
- Fail: observation out of bounds, state leaking between resets

**C.3 Step Validity**
- 10,000 random-action steps, 5 episodes
- Pass: no exceptions, all obs/rewards within bounds, terminal flags consistent
- Fail: exception raised, out-of-bounds values, inconsistent terminal flags

**C.4 Termination Reachability**
- Scripted policy (e.g., random with bias toward goal)
- 10 attempts, must terminate at least once within max_steps
- Pass: at least one successful termination
- Fail: zero terminations in all attempts

**C.5 Reward Non-Degeneracy**
- 1,000 random steps, collect reward distribution
- Pass: non-constant reward, 2+ distinct rewards or next-state distributions, observed range spans ≥20% of declared range
- Fail: constant reward, degenerate reward signal

**C.6 Reproducibility**
- 5 seeds × 100 steps, compare trajectories
- Pass: byte-identical observations and rewards across identical seeds
- Fail: trajectory diverges for identical seeds

**C.7 Exploit Scan**
- Retrieve all applicable probes from Exploit Library
- Run each probe with 100 seeds
- Pass: no probe achieves >90th percentile reward without task completion
- Fail: any probe achieves exploit-level reward without valid completion

**C.8 Mutation Testing**
- Generate 20 reward function mutants (small perturbations to reward formula)
- Run test suite on all mutants
- Pass: >70% of mutants detected by test suite
- Fail: <70% detection rate indicates insufficient reward signal differentiation

**C.9 Edge Case Stress**
- Test: zero action, max action, boundary states, step 1 termination, 10× max_steps
- Pass: all edge cases handled correctly with appropriate behavior
- Fail: unhandled edge case, exception, or incorrect behavior

**C.10 Performance Validation**
- 10,000 steps timed, memory profiled across 1,000 episodes
- Pass: step time meets target (<10ms non-physics, <50ms physics), no memory leaks
- Fail: step time exceeds target, memory leak detected

**C.11 Curriculum Coherence** (if curriculum suite)
- Verify: difficulty monotonically increases, common interface, smooth transitions
- Pass: all curriculum properties verified
- Fail: any curriculum property violated

**C.12 Documentation Smoke Test**
- Extract all docstring examples
- Execute each example
- Pass: all examples execute without error
- Fail: any example raises exception

### D. AUDN Protocol Details

**When to use each decision:**

| Decision | Condition |
|----------|-----------|
| `ADD` | Proposed fact is new, valid, and non-duplicate of existing entry |
| `UPDATE` | Proposed fact is more recent or has better evidence than existing |
| `DELETE` | Existing fact is contradicted by newer evidence or is stale |
| `NONE` | Proposed fact is duplicate or provides no new information |
| `CONFLICT` | Proposed fact contradicts existing fact and neither is clearly superior |

**Evaluation procedure:**
1. Check for temporal ordering (bitemporal model: valid_at vs recorded_at)
2. Check for evidence quality (supporting episode count)
3. Check for contradictions (same subject, incompatible predicate values)
4. Check for duplicates (same subject, same predicate, similar value)
5. Return recommended action

---

**Document version:** 3.0 | **Owner:** Eden founding team | **Date:** May 2026