# Eden Architecture

## System Overview

Eden is an AI-native environment generation system. Given a natural language description, it produces runnable, verified, production-quality RL/agent evaluation code through a multi-agent pipeline with dedicated learning components.

The pipeline is deliberately slow and thorough — every environment undergoes planning, adversarial review, fact-checking, code generation, quality analysis, verification, and testing before delivery. The Archivist learns from every job, compounding system intelligence over time.

## Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Orchestration | LangGraph v0.3.x | Graph-based state model, PostgresSaver checkpointing, interrupt support |
| Storage (episodic) | PostgreSQL 16 + JSONB | Required for LangGraph checkpointing; full-text + time-series |
| Storage (graph) | PostgreSQL recursive CTEs | Single-server constraint; depth-2 traversal <10ms on 10K nodes |
| Storage (vector) | Qdrant single-node | 22ms p95 latency, hybrid dense+sparse, single binary |
| Sandbox | Firecracker + BandSox | Hardware-level isolation, ~125ms boot, auto-destroy |
| LLM | OpenRouter | 300+ models, automatic failover, Sonnet for reasoning, Haiku for fast tasks |

### Technology Decision Rationale

**Why LangGraph over raw async/await?**
- Checkpointing built-in — jobs survive infrastructure restarts mid-pipeline
- Conditional routing is a first-class concept, not manual state machine
- Graph visualization for debugging pipeline flows
- Interrupts allow human review at any pipeline stage

**Why PostgreSQL over Neo4j for graph storage?**
- Single-server deployment constraint (quality over horizontal scaling)
- Recursive CTEs handle depth-2 traversal at <10ms on 10K nodes
- Bitemporal model implemented via `valid_at` + `recorded_at` columns
- Single database reduces operational complexity

**Why Firecracker over Docker/runc?**
- November 2025: three CVEs affected all shared-kernel container runtimes simultaneously
- Hardware-level KVM isolation — each sandbox has own kernel, not shared
- ~125ms boot time enables fast VM reuse
- Auto-destroy ensures no state leakage between jobs

**Why Qdrant over pgvector?**
- pgvector lacks hybrid dense+sparse search
- pgvector doesn't support cross-encoder reranking
- Qdrant's metadata filtering is more expressive for complex KB queries

## Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     KNOWLEDGE BASE (4 layers)                  │
│   Episodic │ Semantic (Graph+Vector) │ Procedural │ Exploit    │
└─────────────────────────────────────────────────────────────────┘
        ↑↓ all pipeline agents read continuously

REQUEST → PLANNER → CRITIC → REFINER → FACT CHECKER
                           ↓                    ↓
                      (replan loops)       EXECUTOR
                                              ↓
                                    CODE QUALITY PIPELINE
                                     Static→Security→Complexity
                                     →Performance→Documentation
                                              ↓
                                        VERIFIER → TESTER
                                              ↓
                            (fundamental flaw loops back)
                                              ↓
                                        ARCHIVIST → RESULT
                                              ↓
                              EVOLUTION ENGINE (async)
```

### Pipeline Stage Definitions

| Stage | Purpose | Loop Mechanism | Max Iterations |
|-------|---------|----------------|----------------|
| `planning` | Planner produces EDP | Critic routing back | 3 replan + 2 reresearch |
| `criticizing` | Critic reviews EDP | Targeted/full replan | Hard limit via human_review |
| `refining` | Refiner resolves spec gaps | Critic approval required | 1 per EDP version |
| `fact_checking` | FactChecker verifies claims | Reject → Planner | Unlimited |
| `executing` | Executor writes code | CodeQuality failure | 5 total |
| `code_quality` | 5-pass quality pipeline | Iteration limit | 8 |
| `verifying` | Verifier checks fidelity | Design flaw → Verifier | Escalation at 3 |
| `testing` | Tester runs in sandbox | Fundamental → Planning | 2 for fundamental |
| `archiving` | Archivist learns | None | 1 per job |
| `completed` | Job finished | N/A | N/A |
| `failed` | Job failed | N/A | N/A |
| `human_review` | Manual intervention | N/A | N/A |

### Routing Logic

**Critic Router:**
```
if routing == "approve":
    → "refining"
elif routing == "targeted_replan":
    if critic_replan_count >= 3:
        → "human_review"
    → "planning" (with specific sections)
else:  # full_reresearch
    if critic_reresearch_count >= 2:
        → "human_review"
    → "planning" (from scratch)
```

**Code Quality Router:**
```
if last_report.passed:
    → "verifying"
else:
    if code_quality_iterations >= 8:
        → "human_review"
    → "executing" (with quality report)
```

**Tester Router:**
```
if category == "patch_level":
    if executor_iterations >= 5:
        → "human_review"
    → "executing" (with patch)
elif category == "design_level":
    if executor_iterations >= 3:
        → "human_review"
    → "verifier" (with design note)
elif category == "fundamental":
    → "planning" (with failure analysis)
else:
    → "archiving"
```

## Knowledge Base (4 Layers)

### Layer 1: Episodic Memory (PostgreSQL)

Stores raw, timestamped, immutable job records. All pipeline agents write here during execution.

**Schema:**
```sql
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(255) UNIQUE NOT NULL,
    request JSONB NOT NULL,
    environment_class VARCHAR(50) NOT NULL,
    outcome_tier VARCHAR(20),
    status VARCHAR(50) NOT NULL,
    edp_history JSONB NOT NULL DEFAULT '[]',
    critic_decisions JSONB NOT NULL DEFAULT '[]',
    routing_history JSONB NOT NULL DEFAULT '[]',
    res JSONB,
    fact_check_report JSONB,
    code_history JSONB NOT NULL DEFAULT '[]',
    quality_reports JSONB NOT NULL DEFAULT '[]',
    verifier_report JSONB,
    tester_results JSONB,
    kb_reads JSONB NOT NULL DEFAULT '[]',
    agent_proposals JSONB NOT NULL DEFAULT '[]',
    quality_metrics JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
```

**Indexes:**
- `idx_jobs_job_id` on `job_id`
- `idx_jobs_status` on `status`
- `idx_jobs_outcome` on `outcome_tier`
- `idx_jobs_env_class` on `environment_class`
- `idx_jobs_created` on `created_at DESC`
- `idx_jobs_fts` GIN on `to_tsvector('english', request::text)` for full-text search

**Retrieval scoring (per Generative Agents framework):**
- **Recency**: Exponential decay, half-life 30 days
- **Semantic relevance**: Cosine similarity on embedding
- **Salience**: Gold outcomes and fundamental failures score 3x

### Layer 2: Semantic Memory

**Temporal Knowledge Graph (PostgreSQL):**

Node types and edge types form a causal knowledge model:

**Nodes:**
| Type | Description | Properties |
|------|-------------|------------|
| `EnvironmentClass` | Environment categories | name, description, tags |
| `DesignPattern` | Recurring solution approaches | pattern, rationale, evidence |
| `FailureMode` | Known failure patterns | category, severity, preconditions |
| `BestPractice` | Verified effective approaches | practice, confidence, evidence |
| `Skill` | Reusable code patterns | name, code_template, parameters |
| `FrameworkFact` | API/behavior facts | framework, version, fact |
| `ResearchFinding` | Literature results | source, finding, applicability |
| `Exploit` | Attack patterns | category, probe_code, severity |

**Edges:**
| Type | Meaning | Example |
|------|---------|---------|
| `CAUSES` | Direct causation | `reward_design → reward_hacking` |
| `PREVENTS` | Mitigation | `potential_based_rs → reward_hacking` |
| `ENABLES` | Prerequisite | `dense_reward → learning_stability` |
| `IMPROVES` | Enhancement | `curriculum → task_completion_rate` |
| `CONTRADICTS` | Conflict | `heuristic_A ↔ heuristic_B` |
| `DISCOVERED_IN` | Source | `finding → paper_xyz` |
| `VALIDATED_BY` | Evidence | `practice → job_123` |
| `VALID_FOR` | Applicability | `pattern → env_class_cartpole` |
| `SUPERSEDED_BY` | Update | `old_fact → new_fact` |

**Bitemporal model:**
- `valid_at TIMESTAMPTZ`: When the fact was true in the world
- `recorded_at TIMESTAMPTZ`: When Eden learned the fact

**Vector Search (Qdrant):**
- Collections: `eden_semantic_memory`, `eden_skills`, `eden_exploits`
- Hybrid dense+sparse with Reciprocal Rank Fusion
- Metadata filtering: env_class, framework, outcome_tier
- Cross-encoder reranking for top-k results
- 1536 dimensions, cosine similarity

### Layer 3: Procedural Memory (Skill Library)

Verified code patterns indexed by semantic similarity.

**Schema:**
```sql
CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    code_template TEXT NOT NULL,
    parameters JSONB DEFAULT '{}',
    applicable_env_classes TEXT[] NOT NULL,
    applicable_frameworks TEXT[] NOT NULL,
    quality_metrics JSONB DEFAULT '{}',
    archivist_reviewed BOOLEAN DEFAULT FALSE,
    confidence_score FLOAT DEFAULT 0.5,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Layer 4: Exploit Library

Parameterisable adversarial probe scripts.

**Schema:**
```sql
CREATE TABLE exploits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(100) NOT NULL,
    name TEXT NOT NULL,
    applicable_env_classes TEXT[] NOT NULL,
    applicable_reward_types TEXT[] NOT NULL,
    probe_code TEXT NOT NULL,
    structural_preconditions JSONB DEFAULT '{}',
    discovery_episode_id UUID REFERENCES jobs(id),
    archivist_rationale TEXT,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Agent Architecture

### Planner

**Role:** Research arm, produces Environment Design Plan (EDP)

**System Prompt Strategy:**
- Zero-shot for standard environments
- Retrieve similar past EDPs as in-context examples for novel classes
- Address all `archivist_warnings` for the environment class explicitly

**KB Queries at Job Start:**
1. Episodic: Top 5 similar past jobs by full-text + vector similarity
2. Semantic graph: Design decisions that caused failures for this env class
3. Semantic vector: Framework API facts, reward design patterns
4. Procedural: Skill Library entries for this framework and env class
5. Forward annotations: Planner-specific warnings for this env class

**Output:** EDP JSON per schema with evidence citations

**LLM Configuration:**
- Model: reasoning slot (anthropic/claude-sonnet-4.6)
- Max tokens: 50,000
- Max turns: 8

### Critic

**Role:** Adversarial review across 8 dimensions

**8 Critique Dimensions:**
1. Reward pathology risk — all 6 reward hacking categories
2. Observation sufficiency — can agent solve from observed state?
3. Action space validity — meaningful actions? Any dominant action?
4. Termination logic — at least one path reachable from valid initial?
5. Framework API integrity — every method/class verified
6. Difficulty calibration — learnable? Completable within max_steps?
7. Specification completeness — ambiguities for Executor?
8. KB conflict check — conflicts with Archivist-flagged patterns?

**Devil's Advocate (Layer 2 Enhancement):**
- Spawned when `design_confidence < 0.7` or `novelty_assessment = "novel"`
- Contrarian prompt framing
- Both critiques synthesised before routing decision

**Routing:**
- `approve` → Refiner (with inline annotations)
- `targeted_replan` → Planner (specific sections, research reused)
- `full_reresearch` → Planner (from scratch)

**LLM Configuration:**
- Model: reasoning slot
- Max tokens: 30,000
- Max turns: 6

### Refiner

**Role:** Close gaps between sound plan and implementable spec

**Operations:**
1. Resolve all EDP ambiguities → concrete, justified values
2. Expand reward function → implementation-level pseudocode
3. Audit reward shaping for potential-based validity
4. Enumerate every reachable edge case with handling spec
5. Specify output interface to method-signature level
6. Specify complete seeding/reproducibility strategy
7. For LLM eval: specify observation/action format, scorer

**LLM Configuration:**
- Model: reasoning slot
- Max tokens: 25,000
- Max turns: 5

### Fact Checker

**Role:** Verify every empirical claim before code is written

**Verification Checklist:**
- Framework method/class existence for declared version
- Physics plausibility (for physics-based environments)
- Reward bounds mathematically achievable
- Library dependencies mutually compatible
- Logical consistency: termination reachable, initial state valid
- For LLM eval: observation format parseable, action space producible

**LLM Configuration:**
- Model: reasoning slot
- Max tokens: 25,000
- Max turns: 4

### Executor

**Role:** Write complete, runnable code from verified RES

**Output Modes:**
| Mode | Description |
|------|-------------|
| `gymnasium_mode` | Gymnasium-compatible Python, proper spaces, dtype arrays |
| `pettingzoo_mode` | PettingZoo AEC or Parallel API, agent-indexed |
| `llm_sandbox_mode` | Text-based interactive, natural language interface |
| `agent_eval_mode` | AgentBench/TAU-bench/custom harness |
| `tool_env_mode` | Tool-use environment with defined API surface |
| `custom_python_mode` | Arbitrary Python per RES contract |
| `typescript_mode` | TypeScript with proper typing |
| `multilanguage_mode` | Declared language + Python adapter |

**Process:**
1. Query Skill Library for structurally similar implementations
2. Query Archivist's best practices for this env class/framework
3. Generate in structured sections (complex envs): skeleton → state → obs → actions → reward → termination → helpers → synthesis
4. Self-review: every RES element implemented, no stubs
5. Documentation pass: docstrings, parameter docs, inline rationale

**LLM Configuration:**
- Model: reasoning slot
- Max tokens: 15,000
- Max turns: 6

### Code Quality Pipeline

Five sequential automated passes. Each loops back to Executor until pass clears.

**Pass 1 — Static Analysis:**
| Tool | Checks |
|------|--------|
| `pylint` | Code style, undefined vars, unused imports |
| `flake8` | PEP 8 compliance |
| `mypy --strict` | Type correctness |
| `radon` | Cyclomatic complexity (flag >10, block >15) |

**Pass 2 — Security Analysis:**
| Tool | Checks |
|------|--------|
| `bandit` | Common vulnerability patterns |
| `semgrep` | Security rulesets (OWASP, CWE) |
| `safety` | Dependency CVE scanning |

**Pass 3 — Complexity and Maintainability:**
- Function length: flag >60 lines
- Class coupling: flag >5 dependencies
- Duplication: flag >3 duplicate logical blocks
- Magic numbers: flag non-constant literals
- Variable names: flag single-letter outside loop contexts

**Pass 4 — Performance Profiling:**
- 1,000 steps under random policy
- Measures: avg step() time, memory per step, peak memory
- Detects: O(n²)+ operations
- Targets: <10ms non-physics, <50ms physics

**Pass 5 — Documentation Quality:**
- All public methods have docstrings
- Reward function rationale in class docstring
- All `__init__` parameters documented
- Non-obvious decisions have inline comments
- Edge case handling documented

**LLM Configuration:**
- Model: extraction slot (claude-haiku-4)
- Max tokens: 10,000
- Max turns: 4

### Verifier

**Role:** Fidelity check — does code match RES?

**Checks:**
- Interface compliance: required methods, correct signatures
- RES fidelity: reward matches pseudocode, termination matches spec
- Completeness: zero stubs, TODOs, placeholders, undefined imports

**Escalation:** Same flaw 3+ Executor cycles → escalate to Refiner

**LLM Configuration:**
- Model: extraction slot
- Max tokens: 10,000
- Max turns: 3

### Tester

**Role:** Ground truth — runs code in Firecracker sandbox

**12 Test Categories:**

| Category | Description | Pass Criteria |
|----------|-------------|---------------|
| Instantiation | 20 seeds × difficulty extremes | No errors |
| Reset integrity | 50 seeds, observation validation | Correct dtype/bounds, no leakage |
| Step validity | 10,000 random steps, 5 episodes | No exceptions, bounds maintained |
| Termination reachability | Scripted policy, 10 attempts | At least one terminates within max_steps |
| Reward non-degeneracy | 1,000 random steps | Non-constant, 2+ distinct rewards |
| Reproducibility | 5 seeds × 100 steps | Byte-identical trajectories |
| Exploit scan | Full Exploit Library probes | No probe achieves >90th percentile without completion |
| Mutation testing | 20 reward mutants | >70% detected by test suite |
| Edge case stress | Boundary inputs, long episodes | Correct handling |
| Performance validation | 10,000 steps timed, memory profiled | Meets declared targets |
| Curriculum coherence | (if curriculum suite) | Monotonic difficulty increase |
| Documentation smoke test | All docstring examples | Execute without error |

**Routing on Failure:**
- `patch_level` → Executor (specific failure trace)
- `design_level` → Verifier + Executor
- `fundamental` → Planner (complete failure analysis)

**LLM Configuration:**
- Model: extraction slot
- Max tokens: 10,000
- Max turns: 5

### Archivist (Dedicated Learning Agent)

**Role:** Learn from every job outcome, write canonical KB entries

**Process per job:**
1. Full trace ingestion (complete job trace)
2. Outcome classification (Gold/Silver/Bronze/Partial/Failed)
3. Success extraction (contrastive analysis, best practices, skills)
4. Failure extraction (root cause, causal chain, prevention rules)
5. Exploit Library maintenance
6. Contradiction resolution
7. Forward annotations for future agents
8. KB health maintenance

**Write Ownership:**
- Agents write `provisional` → episodic
- Archivist writes `canonical` → semantic + procedural (via AUDN)

**LLM Configuration:**
- Model: reasoning slot
- Max tokens: 60,000
- Max turns: 20

## State Management

**EdenJobState Schema:**
```python
class EdenJobState(TypedDict):
    # Job identity
    job_id: str
    request: dict

    # Pipeline history (append-only, preserved for Archivist)
    edp_history: Annotated[list[dict], operator.add]
    critic_decisions: Annotated[list[dict], operator.add]
    routing_history: Annotated[list[dict], operator.add]

    # Current working state
    res: Optional[dict]
    fact_check_report: Optional[dict]
    code_history: Annotated[list[str], operator.add]

    # Quality tracking (per-pass, per-iteration)
    quality_reports: Annotated[list[dict], operator.add]

    # Verification & testing
    verifier_report: Optional[dict]
    tester_results: Optional[dict]

    # KB provenance (for Archivist analysis)
    kb_reads: Annotated[list[dict], operator.add]
    agent_proposals: Annotated[list[dict], operator.add]

    # Outcome (set by Archivist)
    outcome_tier: Optional[str]
    archivist_summary: Optional[dict]

    # Iteration tracking
    executor_iterations: int
    code_quality_iterations: int
    critic_replan_count: int
    critic_reresearch_count: int

    # Routing context
    current_stage: str
    routing_target: Optional[str]
    routing_reason: Optional[str]
```

**Checkpointing Strategy:**
- PostgresSaver configured with async writes
- Checkpoint at every node transition
- Jobs survive process restart mid-pipeline

## AUDN Protocol

AUDN prevents KB pollution by ensuring only high-confidence, non-contradictory facts enter canonical semantic memory.

| Decision | When |
|----------|------|
| `ADD` | New fact, no conflict, valid |
| `UPDATE` | Revised evidence, more recent/better |
| `DELETE` | Fact superseded or invalidated |
| `NONE` | No new information, duplicate |
| `CONFLICT` | Requires Archivist resolution |

**Evaluation Logic:**
1. Check for contradictions with existing entries
2. Check temporal ordering (bitemporal model)
3. Check for duplicates
4. Return recommended action

## Sandbox Architecture

**Firecracker via BandSox SDK:**

Security model:
- Hardware-level kernel isolation (KVM)
- ~125ms boot time
- Vsock for fast host-guest communication
- Auto-destroy post-run
- Snapshot pools for fast VM reuse

**Security Properties:**
- Jailer process sandboxes each Firecracker VMM
- seccomp filter restricts syscalls to 24 allowed
- No network access from sandbox
- Hardware CPU/memory/disk hard-partitioned
- Each VM has own kernel, not shared

**Snapshot Pool:**
- Pre-created VM images with dependencies
- Pool size: 10 VMs (configurable)
- Cold start: ~125ms from pool
- Auto-cleanup after each job

## Evolution Engine (Async)

Components running continuously, independent of jobs.

| Component | Schedule | Function |
|-----------|----------|----------|
| Distiller | Nightly | Cluster episodic by env class, extract patterns |
| Prompt Evolver | Per 50-job window | A/B test prompt improvements |
| Research Harvester | Weekly | Crawl arXiv, framework docs, conferences |
| Retrieval Tuner | Active at 200 jobs | Adjust retrieval strategy based on relevance |
| Pattern Miner | Monthly | Deep cross-job analysis, intelligence reports |

## File Manifest

```
eden/
├── src/eden/
│   ├── api/
│   │   └── app.py              # FastAPI app
│   ├── pipeline/
│   │   ├── state.py           # EdenJobState TypedDict
│   │   ├── graph.py          # Pipeline graph definition
│   │   └── nodes/
│   │       ├── planner.py
│   │       ├── critic.py
│   │       ├── refiner.py
│   │       ├── fact_checker.py
│   │       ├── executor.py
│   │       ├── code_quality.py
│   │       ├── verifier.py
│   │       ├── tester.py
│   │       └── archivist.py
│   ├── agents/
│   │   ├── planner/
│   │   ├── critic/
│   │   ├── refiner/
│   │   ├── fact_checker/
│   │   ├── executor/
│   │   ├── verifier/
│   │   ├── tester/
│   │   ├── archivist/
│   │   └── evolution/
│   │       └── components.py
│   ├── kb/
│   │   ├── episodic/
│   │   │   └── client.py
│   │   ├── semantic/
│   │   │   ├── graph_client.py
│   │   │   └── vector_client.py
│   │   ├── procedural/
│   │   │   └── client.py
│   │   ├── exploit/
│   │   │   └── client.py
│   │   └── shared/
│   │       └── audit.py       # AUDN protocol
│   ├── sandbox/
│   │   └── runner.py         # BandSox + Firecracker
│   ├── storage/
│   │   ├── postgres.py
│   │   └── qdrant.py
│   ├── llm/
│   │   └── client.py          # OpenRouter client
│   └── config.py
├── migrations/
│   └── 001_kb_schema.sql
├── docker/
│   └── docker-compose.yml
├── tests/
│   └── unit/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── ROADMAP.md
│   └── DEVELOPMENT.md
└── PRD.md
```

## Error Handling

### Pipeline Errors

| Error Type | Handling | Recovery |
|------------|----------|----------|
| LLM API timeout | Retry 3x with exponential backoff | Route to human_review if exhausted |
| KB read failure | Log, continue with reduced context | Skip retrieval, use defaults |
| KB write failure | Retry 2x, then fail job | Mark job as failed |
| Sandbox boot failure | Retry pool (3x), then create new | If all fail, route to human_review |
| Sandbox execution timeout | Kill after 30min, fail test category | Increment failure count |
| Checkpoint write failure | Log critical, attempt continue | If state lost, fail job |

### LLM Circuit Breaker

- 5 consecutive failures → open circuit for 60s
- Half-open: 1 probe request after 60s
- Success → close circuit; 3 failures → open for 5min

## Scaling Considerations

**Single-Server Constraint:**
- All storage local (PostgreSQL, Qdrant)
- Horizontal scaling not supported
- Quality over horizontal scalability

**Concurrency Limits:**
- Max 3 concurrent jobs (memory bound)
- Sandbox pool: 10 VMs
- LLM rate limiting via OpenRouter

**Performance Targets:**
| Metric | Target |
|--------|--------|
| KB retrieval p50 | <50ms |
| KB retrieval p95 | <200ms |
| Sandbox cold start | <200ms from pool |
| Step() non-physics | <10ms |
| Step() physics | <50ms |
| Job completion (simple) | <15min |
| Job completion (complex) | <90min |

## Monitoring

**Metrics to Track:**
- Job completion time (median, p95)
- Cost per job (actual vs model)
- KB retrieval latency (p50, p95)
- Sandbox cold start latency
- Code Quality iteration counts
- Critic routing rate (approve/replan/reresearch)
- Tester fundamental failure rate
- Gold outcome rate (rolling 30-day)

**Logging:**
- Structured JSON logs
- Log levels: DEBUG, INFO, WARNING, ERROR, CRITICAL
- Trace ID for every job (correlates all logs)
- Agent reasoning traces at DEBUG level