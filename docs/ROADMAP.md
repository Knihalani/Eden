# Eden Implementation Roadmap

## Table of Contents

1. [Overview](#1-overview)
2. [Phase A: Foundation](#2-phase-a-foundation)
3. [Phase B: Layer 1 Agents](#3-phase-b-layer-1-agents)
4. [Phase C: Evolution Engine](#4-phase-c-evolution-engine)
5. [Phase D: Documentation](#5-phase-d-documentation)
6. [Phase E: Integration & Hardening](#6-phase-e-integration--hardening)
7. [Phase F: Layer 2 Enhancements](#7-phase-f-layer-2-enhancements)
8. [Metrics & Quality Gates](#8-metrics--quality-gates)
9. [Implementation References](#9-implementation-references)

---

## 1. Overview

### System Context

Eden is an AI-native environment generation system. The pipeline transforms natural language descriptions into runnable, verified, production-quality RL/agent evaluation code through a multi-agent pipeline with dedicated learning components.

**Pipeline Flow:**
```
REQUEST → PLANNER → CRITIC → REFINER → FACT CHECKER → EXECUTOR → CODE QUALITY → VERIFIER → TESTER → ARCHIVIST → RESULT
                                                         ↑___________↓                  ↑____________|
```

### Implementation Status Summary

| Phase | Items | Complete | In Progress | Planned |
|-------|-------|----------|--------------|---------|
| A: Foundation | 6 | 6 | 0 | 0 |
| B: Layer 1 Agents | 9 | 9 | 0 | 0 |
| C: Evolution Engine | 5 | 5 | 0 | 0 |
| D: Documentation | 3 | 3 | 0 | 0 |
| E: Integration | 4 | 0 | 0 | 4 |
| F: Layer 2 | 4 | 4 | 0 | 0 |
| **Total** | **31** | **27** | **0** | **4** |

### What "Complete" Means

All Phase A-D items are **implemented as functional components**. The architecture is in place, the pipeline is wired, and each agent has a defined role with system prompts. The implementation is structured for correctness:

- System prompts define the agent's role, inputs, outputs, and process
- State updates return the correct fields per the EdenJobState schema
- Router functions handle conditional branching correctly
- Storage clients are properly structured for async operations

The remaining work (Phases E-F) is **integration and enhancement** — wiring components to external services, executing real tools, and adding Layer 2 capabilities.

---

## 2. Phase A: Foundation

### A.1 Project Scaffolding

**Purpose:** Establish the project structure, tooling, and development environment.

**Components:**

| Component | Implementation | File | Description |
|-----------|---------------|------|-------------|
| Package layout | ✓ | `src/eden/` | Standard Python package with `__init__.py` |
| Dependencies | ✓ | `pyproject.toml` | Core deps: fastapi, langgraph, asyncpg, qdrant-client, openai |
| Dev dependencies | ✓ | `pyproject.toml` | pytest, mypy, ruff, bandit |
| Type checking | ✓ | `mypy.ini` or pyproject | Strict mode configured |
| Linting | ✓ | `ruff.toml` or pyproject | Rules configured, autoformat on save |
| Settings | ✓ | `src/eden/config.py` | Pydantic BaseSettings for env vars |

**Verification:**
```bash
python -c "import eden; print('Package OK')"
mypy src/eden  # 0 errors
ruff check src/eden  # 0 errors
```

---

### A.2 Storage Layer

**Purpose:** Establish PostgreSQL and Qdrant infrastructure for the Knowledge Base.

#### PostgreSQL (`src/eden/storage/postgres.py`)

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| `ConnectionConfig` | Dataclass for database configuration | — |
| `PostgresClient` | Async PostgreSQL client with connection pooling | `initialize()`, `close()`, `acquire()`, `transaction()`, `execute()`, `fetch()`, `fetchrow()`, `fetchval()` |

**Singletons:**
```python
_postgres_client: Optional[PostgresClient] = None

async def get_postgres_client() -> PostgresClient
async def close_postgres_client() -> None
```

#### Database Schema (`migrations/001_kb_schema.sql`)

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `jobs` | Main job records with full pipeline state | job_id, request (JSONB), edp_history (JSONB), code_history (JSONB), outcome_tier, status |
| `graph_entities` | Temporal knowledge graph nodes | entity_type, name, properties (JSONB), valid_at, recorded_at, embedding (vector) |
| `entity_links` | KG edges with bitemporal model | source_id, target_id, edge_type, valid_at, recorded_at |
| `skills` | Skill Library entries | name, description, code_template, applicable_env_classes, applicable_frameworks, embedding |
| `exploits` | Exploit Library probes | category, name, probe_code, applicable_env_classes, applicable_reward_types, embedding |
| `checkpoint_blobs` | LangGraph state offloading | job_id, field, value (JSONB) |
| `prompt_versions` | Prompt versioning for Prompt Evolver | agent, version, system_prompt, quality_metrics, active |

**Indexes:** Full-text search (tsvector), vector indexes (ivfflat), GIN indexes on JSONB columns, standard B-tree indexes on foreign keys and timestamps.

#### Qdrant (`src/eden/storage/qdrant.py`)

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| `SearchResult` | Single search result | id, score, payload |
| `QdrantClientWrapper` | Full Qdrant client with hybrid search | `initialize_collections()`, `search()`, `search_hybrid()`, `upsert()`, `delete()`, `count()` |

**Collections Initialized:**
- `eden_semantic_memory`: 1536 dim, cosine — for EDPs, patterns, graph entities
- `eden_skills`: 1536 dim, cosine — for Skill Library code embeddings
- `eden_exploits`: 1536 dim, cosine — for Exploit Library probe embeddings

**Filter Operators:** `$eq`, `$ne`, `$in` — supports metadata filtering on all collections.

---

### A.3 LLM Integration

**Purpose:** Provide reliable LLM access with OpenRouter, including retry logic and cost tracking.

#### OpenRouter Client (`src/eden/llm/client.py`)

| Class | Purpose |
|-------|---------|
| `CircuitBreaker` | Per-agent circuit breaker with failure tracking |
| `OpenRouterClient` | Main client with retry, circuit breaker, cost tracking |

**Model Slots:**
| Slot | Primary Model | Fallback Models | Max Tokens |
|------|---------------|-----------------|------------|
| `reasoning` | `anthropic/claude-sonnet-4.6` | deepseek/deepseek-v3, google/gemini-2.5-pro-preview | 8192 |
| `code` | `qwen/qwen3-coder:free` | deepseek/deepseek-v4-flash:free | 8192 |
| `fast` | `deepseek/deepseek-v4-flash:free` | google/gemma-4-27b-it:free | 4096 |
| `extraction` | `claude-haiku-4` | deepseek/deepseek-v3 | 2048 |

**Agent Configuration (from config.py):**
| Agent | Token Budget | Max Turns |
|-------|-------------|-----------|
| Planner | 50,000 | 8 |
| Critic | 30,000 | 6 |
| Refiner | 25,000 | 5 |
| Fact Checker | 25,000 | 4 |
| Executor | 15,000 | 6 |
| Code Quality | 10,000 | 4 |
| Verifier | 10,000 | 3 |
| Tester | 10,000 | 5 |
| Archivist | 60,000 | 20 |

**Circuit Breaker Configuration:**
- Failure threshold: 5 consecutive failures
- Recovery timeout: 60 seconds
- Half-open probe: 1 request after timeout
- Open after 3 failures in half-open: 5 minutes

---

### A.4 LangGraph Pipeline

**Purpose:** Orchestrate the multi-agent pipeline with state management and conditional routing.

#### State (`src/eden/pipeline/state.py`)

**EdenJobState TypedDict:**
```python
class EdenJobState(TypedDict):
    # Job identity
    job_id: str
    request: dict

    # Pipeline history (append-only lists)
    edp_history: Annotated[list[dict], operator.add]
    critic_decisions: Annotated[list[dict], operator.add]
    routing_history: Annotated[list[dict], operator.add]

    # Current working state
    res: Optional[dict]
    fact_check_report: Optional[dict]
    code_history: Annotated[list[str], operator.add]

    # Quality tracking
    quality_reports: Annotated[list[dict], operator.add]

    # Verification & testing
    verifier_report: Optional[dict]
    tester_results: Optional[dict]

    # KB provenance (for Archivist)
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

**create_initial_state(job_id, request) → EdenJobState:**
- Initializes all append-only lists to `[]`
- Sets all counters to `0`
- Sets `current_stage = "planning"`
- Sets `outcome_tier = None`, `archivist_summary = None`

#### Graph (`src/eden/pipeline/graph.py`)

**Graph Structure:**
```
planner → critic → refiner → fact_checker → executor → code_quality
                                                              ↓
                                                        verifier → tester
                                                              ↓
                                                    (fundamental) ↓
                                                           archivist → END
```

**Nodes:** `planner`, `critic`, `refiner`, `fact_checker`, `executor`, `code_quality`, `verifier`, `tester`, `archivist`

#### Route Functions

**critic_router(state) → str:**
- `approve` → `"refining"`
- `targeted_replan` with `critic_replan_count < 3` → `"planning"`
- `targeted_replan` with `critic_replan_count >= 3` → `"human_review"`
- `full_reresearch` with `critic_reresearch_count < 2` → `"planning"`
- `full_reresearch` with `critic_reresearch_count >= 2` → `"human_review"`

**code_quality_router(state) → str:**
- `last_report.passed == true` → `"verifying"`
- `last_report.passed == false` with `code_quality_iterations < 8` → `"executing"`
- `last_report.passed == false` with `code_quality_iterations >= 8` → `"human_review"`

**verifier_router(state) → str:**
- `report.passed == true` → `"testing"`
- `report.passed == false` with `executor_iterations < 5` → `"executing"`
- `report.passed == false` with `executor_iterations >= 5` and `design_level == true` → `"verifier"` (escalation)
- `report.passed == false` with `executor_iterations >= 5` → `"human_review"`

**tester_router(state) → str:**
- `category == "passed"` → `"archiving"`
- `category == "patch_level"` with `executor_iterations < 5` → `"executing"`
- `category == "patch_level"` with `executor_iterations >= 5` → `"human_review"`
- `category == "design_level"` with `executor_iterations < 3` → `"verifier"`
- `category == "design_level"` with `executor_iterations >= 3` → `"human_review"`
- `category == "fundamental"` → `"planning"` (loops back to Planner)

---

### A.5 API

**Purpose:** Provide job submission, status polling, result retrieval, and KB query endpoints.

#### Application (`src/eden/api/app.py`)

**Pydantic Schemas:**

| Schema | Fields | Purpose |
|--------|--------|---------|
| `JobRequest` | description, tags, framework, framework_version, difficulty_parameters, output_mode | Job submission |
| `JobResponse` | job_id, status, message | Submit response |
| `JobStatusResponse` | job_id, status, current_stage, outcome_tier, created_at, updated_at, stage_history | Status polling |
| `JobResultResponse` | job_id, status, outcome_tier, environment_code, test_results, quality_report, archivist_summary | Final result |
| `HealthResponse` | status, version, postgres, qdrant, sandbox | Health check |

**API Endpoints:**

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/health` | `health_check()` | System health + KB connections |
| POST | `/jobs` | `submit_job()` | Submit new job, returns job_id |
| GET | `/jobs/{job_id}` | `get_job_status()` | Poll job status |
| GET | `/jobs/{job_id}/result` | `get_job_result()` | Get completed result |
| GET | `/jobs/{job_id}/trace` | `get_job_trace()` | Get full pipeline trace |
| POST | `/jobs/{job_id}/cancel` | `cancel_job()` | Cancel in-progress job |
| GET | `/kb/query` | `query_kb()` | Direct KB queries |

**Lifespan:**
- Startup: `initialize_kb()` + `compile_eden_graph()`
- Shutdown: `close_postgres_client()`

---

### A.6 Sandbox

**Purpose:** Provide hardware-isolated code execution for the Tester agent using Firecracker microVMs.

#### Sandbox Architecture (`src/eden/sandbox/runner.py`)

**Classes:**

| Class | Purpose |
|-------|---------|
| `SandboxRunner` | Full Firecracker integration via BandSox SDK |
| `NullSandboxRunner` | Development fallback with basic process isolation |

**SandboxRunner:**
```python
class SandboxRunner:
    def __init__(
        self,
        memory_mb: int = 512,
        cpu_count: int = 2,
        snapshot_pool_size: int = 10,
        max_concurrent: int = 100,
    ):
        self._vm_pool: dict = {}      # Pre-created VM pool
        self._active_vms: dict = {}    # Currently executing VMs

    async def initialize(self) -> None:
        """Initialize BandSox connection, create snapshot pool."""

    async def run_tests(
        self,
        code: str,
        test_suite: str,
        exploit_probes: list[dict],
        timeout: int = 300,
    ) -> TestResult:
        """Run tests in isolated microVM."""

    async def execute_code(
        self,
        code: str,
        input_data: dict,
        timeout: int = 60,
    ) -> dict:
        """Execute code with structured I/O."""

    async def verify_isolation(self) -> bool:
        """Verify sandbox isolation properties."""

    async def destroy(self) -> None:
        """Clean up all VMs."""
```

**TestResult:**
```python
@dataclass
class TestResult:
    success: bool
    test_count: int
    passed: int
    failed: int
    errors: int
    output: str
    exploit_findings: list[dict]
    mutation_score: Optional[float] = None
```

**Configuration (from config.py):**
| Setting | Default | Description |
|---------|---------|-------------|
| `sandbox_memory_mb` | 512 | VM memory |
| `sandbox_cpu_count` | 2 | VCPUs per VM |
| `sandbox_snapshot_pool_size` | 10 | Pre-created VMs in pool |
| `sandbox_max_concurrent` | 100 | Max concurrent VMs |
| `firecracker_jailer_path` | `/usr/local/bin/jailer` | Jailer binary path |
| `firecracker_kernel_path` | `./vmlinux` | Kernel image path |
| `firecracker_rootfs_path` | `./rootfs.ext4` | Root filesystem path |

**get_sandbox_runner() → SandboxRunner:**
- Attempts to initialize `SandboxRunner` with config
- Falls back to `NullSandboxRunner` if Firecracker unavailable

---

## 3. Phase B: Layer 1 Agents

### B.1 Planner

**Purpose:** Research arm — produces Environment Design Plan (EDP) from natural language request.

#### Agent (`src/eden/agents/planner/agent.py`)

```python
class PlannerAgent:
    SYSTEM_PROMPT = """You are the Planner for Eden...

    Your role is to research and produce a complete Environment Design Plan (EDP).
    You have access to:
    - Episodic memory (past job outcomes)
    - Semantic memory (design patterns, failure modes, best practices)
    - Procedural memory (skill library, code patterns)
    - Web search for literature and framework documentation

    Produce a complete EDP addressing ALL of:
    1. ENVIRONMENT CLASS — flexible, choose what fits best
    2. OBSERVATION MODALITY — discrete, continuous, image, language, etc.
    3. NOVELTY ASSESSMENT — standard, variant, novel
    4. DESIGN CONFIDENCE — 0.0-1.0
    5. ENVIRONMENT — observation_space, action_space, reward_structure, episode_dynamics
    6. OUTPUT_SPEC — language, framework, interface_contract
    7. KNOWN_RISKS — specific risks with severity and mitigations
    8. DESIGN_DECISIONS — each decision with rationale and alternatives

    CRITICAL: Address all archivist_warnings for this environment class.
    """

    async def run(self, state: dict) -> dict:
        """Run Planner: query KB, research, produce EDP."""
        # 1. Build KB context from kb_reads
        # 2. Construct planning prompt
        # 3. Call LLM with slot="reasoning"
        # 4. Parse EDP from response
        # 5. Return {edp, edp_history: [edp], current_stage: "criticizing"}
```

**EDP Schema:**
```json
{
  "meta": {
    "environment_class": "rl_training | rl_eval | agent_sandbox | llm_agent_eval | tool_use | multi_agent | curriculum | adversarial | simulation | custom",
    "observation_modality": "discrete | continuous | image | language | graph | multimodal | custom",
    "novelty_assessment": "standard | variant | novel",
    "design_confidence": 0.0-1.0,
    "research_sources": ["..."],
    "kb_references": { "episodic": [], "semantic": [], "procedural": [] },
    "archivist_warnings_addressed": [{ "warning": "...", "how_addressed": "..." }]
  },
  "environment": {
    "observation_space": { "type": "", "shape": "", "bounds": "", "sufficiency_rationale": "" },
    "action_space": { "type": "", "dimensionality": "", "bounds": "", "meaningfulness_rationale": "" },
    "reward_structure": {
      "type": "dense | sparse | shaped | verifiable | none",
      "components": [{ "name": "", "formula": "", "bounds": "", "rationale": "" }],
      "shaping_approach": "potential_based | subgoal | none",
      "hacking_risk_per_category": { "specification_gaming": {"level": "low|med|high", "mitigation": ""}, ... }
    },
    "episode_dynamics": { "termination_conditions": [], "max_steps": "", "reset_logic": "", "stochasticity": "" },
    "difficulty_parameters": { "axes": [], "defaults": {}, "ranges": {} }
  },
  "output_spec": { "language": "", "framework": "", "framework_version": "", "interface_contract": "", "entry_class": "" },
  "known_risks": [{ "risk": "", "severity": "", "mitigation": "" }],
  "design_decisions": [{ "decision": "", "rationale": "", "alternatives": [] }]
}
```

**Process:**
1. Query episodic for similar jobs
2. Query semantic graph for failure patterns
3. Query semantic vector for design patterns
4. Query procedural for skill library entries
5. Query exploits for known attack patterns
6. Multi-hop web research (~15 calls)
7. Synthesize EDP with evidence citations

---

### B.2 Critic

**Purpose:** Adversarial review — finds every flaw in EDP before code is written.

#### Agent (`src/eden/agents/critic/agent.py`)

```python
class CriticAgent:
    SYSTEM_PROMPT = """You are the Critic for Eden...

    You must evaluate the EDP across 8 dimensions:
    1. REWARD PATHOLOGY RISK — 6 categories (specification_gaming, reward_tampering, proxy_optimization, objective_misalignment, exploitation_patterns, wireheading)
    2. OBSERVATION SUFFICIENCY — can agent solve from observed state?
    3. ACTION SPACE VALIDITY — all actions meaningful? Any dominant?
    4. TERMINATION LOGIC — at least one path reachable from valid initial?
    5. FRAMEWORK API INTEGRITY — every method/class verified in declared version
    6. DIFFICULTY CALIBRATION — learnable? Completable within max_steps?
    7. SPECIFICATION COMPLETENESS — ambiguities for Executor?
    8. KB CONFLICT CHECK — conflicts with Archivist-flagged patterns?

    Output: CRITIQUE with overall assessment, per-dimension scores, routing recommendation.
    """

    async def run(self, state: dict) -> dict:
        """Run Critic: evaluate EDP, produce critique with routing."""
        # 1. Get EDP from edp_history[-1]
        # 2. Check needs_devil_advocate (novelty=="novel" or confidence < 0.7)
        # 3. Build critique prompt
        # 4. Call LLM with slot="reasoning"
        # 5. Parse critique
        # 6. Update routing (increment replan/reresearch counts)
        # 7. Return {critic_decisions: [critique], routing_history, current_stage}
```

**Routing:**
- `approve` → forward to Refiner with annotations
- `targeted_replan` → specific sections back to Planner (reuses research)
- `full_reresearch` → Planner restarts from web search

**Loop Limits:** 3 targeted replan max, 2 full reresearch max → then `human_review`

#### Devil's Advocate (`DevilAdvocateAgent`)

For novel/low-confidence EDPs (novelty="novel" or design_confidence < 0.7), a Devil's Advocate provides contrarian review:

```python
class DevilAdvocateAgent:
    SYSTEM_PROMPT = """You are a Devil's Advocate...

    Your role is to argue AGAINST the proposed EDP.
    Consider:
    - What if reward is hackable in ways not considered?
    - What if difficulty is miscalibrated?
    - What if framework APIs change?
    - What if similar past jobs failed for reasons not addressed?
    """
```

---

### B.3 Refiner

**Purpose:** Close gaps between sound plan and implementable spec — produces RES.

#### Agent (`src/eden/agents/refiner/agent.py`)

```python
class RefinerAgent:
    SYSTEM_PROMPT = """You are the Refiner for Eden...

    Your role is to produce a Refined Environment Spec (RES) — implementation-ready.

    For the RES, you must:
    1. RESOLVE ALL AMBIGUITIES — concrete, justified values
    2. EXPAND REWARD FUNCTION TO PSEUDOCODE — precise formulae, exact bounds
    3. AUDIT REWARD SHAPING — flag non-PBRS, propose PBRS reformulation
    4. ENUMERATE EDGE CASES — explicit handling specs
    5. SPECIFY OUTPUT INTERFACE — class names, parameter types, return types
    6. SPECIFY SEEDING STRATEGY — reproducibility for all randomness
    7. FOR LLM EVAL ENVIRONMENTS — obs/action format, scorer implementation

    Output the complete RES as structured JSON.
    """

    async def run(self, state: dict) -> dict:
        """Run Refiner: take EDP, produce RES."""
        # Returns {res: parsed_res, current_stage: "fact_checking"}
```

---

### B.4 Fact Checker

**Purpose:** Verify every empirical claim in the RES before code is written.

#### Agent (`src/eden/agents/fact_checker/agent.py`)

```python
class FactCheckerAgent:
    SYSTEM_PROMPT = """You are the Fact Checker for Eden...

    Verify every empirical claim in the RES:
    1. FRAMEWORK API INTEGRITY — every class, method, constant exists in declared version
    2. PHYSICS PLAUSIBILITY — timestep reasonable, mass/inertia in realistic ranges
    3. REWARD BOUNDS — mathematically achievable given dynamics
    4. DEPENDENCY COMPATIBILITY — all libraries mutually compatible
    5. LOGICAL CONSISTENCY — termination reachable, initial state valid
    6. LLM EVAL FORMAT — obs parseable, action producible

    Output: verification report with pass/fail and blockers.
    """
```

#### FrameworkVerifier

Verifies framework APIs against known documentation:

```python
class FrameworkVerifier:
    KNOWN_APIS = {
        "gymnasium": {
            "0.29": {
                "classes": ["Env", "Wrapper", "TimeLimit", "Monitor"],
                "methods": { "Env": ["reset", "step", "close", "seed", "render"] },
                "spaces": ["Box", "Discrete", "Tuple", "Dict", "MultiBinary", "MultiDiscrete"],
            },
        },
        "pettingzoo": {
            "1.24": { ... },
        },
    }
```

---

### B.5 Executor

**Purpose:** Write complete, runnable code from the verified RES.

#### Agent (`src/eden/agents/executor/agent.py`)

**Output Modes:**

```python
OUTPUT_MODES = {
    "gymnasium_mode": """# Gymnasium-compatible environment
import gymnasium as gym
from gymnasium import spaces
import numpy as np

class {class_name}(gym.Env):
    metadata = {'render_modes': [], 'render_fps': 30}

    def __init__(self, {init_params}):
        super().__init__()
        {space_definitions}

    def reset(self, seed=None, options=None):
        {reset_body}
        return self.observation, {{}}

    def step(self, action):
        {step_body}
        return self.observation, self.reward, terminated, truncated, {{}}

    def close(self):
        {close_body}
    """,
    "pettingzoo_mode": """...""",
    "llm_sandbox_mode": """...""",
}
```

**Executor Process:**
1. Query Skill Library for similar implementations
2. Query best practices for this env class/framework
3. Generate in structured sections (complex envs): skeleton → state → obs → actions → reward → termination → helpers → synthesis
4. Self-review: every RES element implemented, no stubs, all edge cases
5. Documentation: docstrings, inline rationale

---

### B.6 Code Quality Pipeline

**Purpose:** Automated 5-pass quality checking before testing.

#### Node (`src/eden/pipeline/nodes/code_quality.py`)

**5 Passes:**

| Pass | Tools | Checks |
|------|-------|--------|
| 1. Static Analysis | pylint, flake8, mypy --strict, radon | Syntax, types, PEP 8, undefined vars, cyclomatic complexity |
| 2. Security Analysis | bandit, semgrep, safety | Vulnerability patterns, OWASP/CWE rules, CVE scanning |
| 3. Complexity | Custom checks | Function length >60 lines, class coupling, duplication, magic numbers |
| 4. Performance | Timed execution (1000 steps) | step() time <10ms non-physics / <50ms physics, memory leaks |
| 5. Documentation | Custom checks | Docstrings, parameter docs, inline comments |

**Loop until clear:** Max 8 iterations per pass.

---

### B.7 Verifier

**Purpose:** Fidelity check — does generated code match RES?

#### Agent (`src/eden/agents/verifier/agent.py`)

```python
class VerifierAgent:
    SYSTEM_PROMPT = """You are the Verifier for Eden...

    Checks:
    1. INTERFACE COMPLIANCE — all required methods, correct signatures
    2. RES FIDELITY — reward matches pseudocode, termination matches spec
    3. COMPLETENESS — zero stubs, TODOs, placeholders, undefined imports

    Output: verification report with issues and design_level flag.
    """
```

**Escalation:** Same flaw 3x → escalate to Refiner (spec may be wrong, not just code).

---

### B.8 Tester

**Purpose:** Ground truth — runs code in Firecracker sandbox.

#### Agent (`src/eden/agents/tester/agent.py`)

**12 Test Categories:**

| # | Category | Description |
|---|----------|-------------|
| 1 | Instantiation | 20 seeds × difficulty extremes, no errors |
| 2 | Reset Integrity | 50 seeds, obs dtype/bounds match, no state leakage |
| 3 | Step Validity | 10,000 random steps, no exceptions, bounds maintained |
| 4 | Termination Reachability | Scripted policy, at least 1 terminates within max_steps |
| 5 | Reward Non-Degeneracy | 1,000 random steps, non-constant reward |
| 6 | Reproducibility | 5 seeds × 100 steps, byte-identical trajectories |
| 7 | Exploit Scan | All applicable Exploit Library probes |
| 8 | Mutation Testing | 20 reward mutants, >70% detected by test suite |
| 9 | Edge Case Stress | Zero/max actions, boundary states, immediate termination |
| 10 | Performance Validation | 10,000 steps timed, memory profiled |
| 11 | Curriculum Coherence | Difficulty increases, common interface (if curriculum) |
| 12 | Documentation Smoke Test | All docstring examples execute |

**Routing on Failure:**
| Category | Next Step | Iteration Limit |
|----------|-----------|-----------------|
| patch_level | Executor | 5 |
| design_level | Verifier | 3 |
| fundamental | Planner | 2 |

---

### B.9 Archivist

**Purpose:** Dedicated learning agent — runs post every job, writes canonical KB entries.

#### Agent (`src/eden/agents/archivist/agent.py`)

**Outcome Tiers:**

| Tier | Definition |
|------|------------|
| Gold | ≤2 Code Quality iterations, no Critic routing, first attempt pass |
| Silver | Passed all tests, normal iteration profile |
| Bronze | Passed with above-average iterations or one replan |
| Partial | Passed with quality concerns or borderline probes |
| Failed | Fundamental failure or exhausted limits |

**8-Step Process:**
1. **Full trace ingestion** — request, all EDPs, Critic decisions, routing, RES, Code Quality results, Verifier report, Tester results, performance metrics
2. **Outcome classification** — assign tier based on pipeline profile
3. **Success extraction** — contrastive pattern analysis (ExPeL), best practices, skills, quality fingerprints
4. **Failure extraction** — root cause, causal chain, prevention rules, retrieval gap analysis
5. **Exploit Library maintenance** — abstract novel exploits into parameterizable probes
6. **Contradiction resolution** — check for KB conflicts, create CONTRADICTS edges
7. **Forward annotations** — warnings/notes for future agents, indexed by env class
8. **KB health maintenance** — mark stale, upgrade/downgrade confidence, archive old traces

#### AUDN Protocol

```python
class AUDNProtocol:
    ADD = "ADD"       # New fact, no conflict
    UPDATE = "UPDATE"  # Revised evidence, more recent/better
    DELETE = "DELETE"  # Superseded or invalidated
    NONE = "NONE"     # Duplicate or no new information
    CONFLICT = "CONFLICT"  # Requires resolution

    def evaluate(self, proposed: dict, existing: list[dict]) -> str:
        """Evaluate proposed fact against existing entries."""
```

#### CausationTracker

```python
class CausationTracker:
    def trace_causes(self, failure: dict, edp_history: list, test_results: dict) -> list[dict]:
        """Reconstruct causal chain: design_decision → intermediate_state → failure_mode."""

    def build_prevention_rule(self, env_class, characteristic, edp_decision,
                             failure_mode, confidence, alternative) -> dict:
        """Build structured prevention rule for semantic memory."""
```

---

## 4. Phase C: Evolution Engine

**Purpose:** Async background processes that improve every system component over time.

### C.1 Distiller

**Schedule:** Nightly batch

**Process:**
1. Query episodic for jobs from last 30 days
2. Cluster by environment_class, reward_structure_type, outcome
3. For clusters with ≥5 jobs showing consistent pattern → generate semantic fact with confidence
4. For contradictory clusters → generate conditional facts or flag for Research Harvester

### C.2 Prompt Evolver

**Schedule:** Per agent, per 50-job rolling window

**Process:**
1. For each agent, check quality metrics over last 50 jobs
2. If quality degraded or improved significantly:
   - Retrieve 10 failure/success cases
   - Generate 3 candidate improved prompts
   - A/B test on next 20 jobs
   - Promote winner, log improvement delta

### C.3 Research Harvester

**Schedule:** Weekly

**Process:**
1. Crawl arXiv (RL, multi-agent, environments, benchmarks, reward design, LLM training)
2. Crawl framework release notes (Gymnasium, PettingZoo, MuJoCo, Isaac Lab)
3. Crawl conference proceedings (NeurIPS, ICML, ICLR, ACL)
4. Crawl agent eval platforms (AgentBench, TAU-bench, WebArena, SWE-bench)
5. Propose findings to Archivist batch queue
6. Update VALID_UNTIL on superseded KB entries when framework changes detected

### C.4 Retrieval Tuner

**Schedule:** Active at 200 completed jobs

**Process:**
1. Every KB retrieval tagged: agent ID, job ID, query
2. After job completion: identify which retrieved items appeared in agent reasoning
3. Queries consistently retrieving irrelevant items → adjust strategy
4. Queries consistently retrieving relevant items → reinforce strategy

### C.5 Pattern Miner

**Schedule:** Monthly

**Process:**
1. Run complex graph queries across semantic memory:
   - Design decisions in >80% of Gold outcomes
   - Reward structure types with highest exploit scan failure rates
   - Framework versions with highest fact-check failure rates
   - Critic routing decisions predicting Tester fundamental failures
   - Most retrieved/used Skill Library entries
2. Produce monthly intelligence report → written to semantic memory
3. Planner retrieves most recent Pattern Miner report at job start

---

## 6. Phase E: Integration & Hardening

### E.1 End-to-End Testing

| Test | Description | Priority |
|------|-------------|----------|
| Synthetic job through pipeline | Submit job, verify all 9 stages execute | P0 |
| Checkpoint/restore verification | Kill API mid-job, restart, verify state restored | P0 |
| KB writes verification | Submit job, verify Archivist writes to semantic memory | P0 |
| Sandbox isolation verification | Run penetration tests against sandbox | P0 |

### E.2 Performance Optimization

| Metric | Target | Method |
|--------|--------|--------|
| KB retrieval p50 | <50ms | Benchmark KB clients |
| KB retrieval p95 | <200ms | Benchmark KB clients |
| Sandbox cold start | <200ms | Benchmark VM boot time |
| Step() non-physics | <10ms | Benchmark in sandbox |
| Step() physics | <50ms | Benchmark in sandbox |

### E.3 Monitoring & Observability

| Metric | Implementation |
|--------|----------------|
| Job completion time | Add to API response, Prometheus counter |
| Cost per job | LLM client already tracks |
| KB retrieval latency | Add instrumentation to KB clients |
| Code Quality iteration counts | In state, add to metrics |
| Critic routing rate | In routing_history, add to metrics |
| Tester fundamental failure rate | In tester_results, add to metrics |

### E.4 Security Hardening

| Item | Description |
|------|-------------|
| Sandbox penetration testing | Red team testing of isolation |
| KB access control audit | Review who can read/write KB |
| API authentication | Add API key support |
| Rate limiting | Per-key limits on job submission |

---

## 7. Phase F: Layer 2 Enhancements

### F.1 Critic — Devil's Advocate Integration

When novelty="novel" or design_confidence < 0.7:
1. Spawn Devil's Advocate with contrarian prompt
2. Both critiques synthesized before routing decision
3. Increases accuracy by 4-6% on difficult reasoning tasks

### F.2 Planner — Multi-Hop Research Enhancement

Iterative agentic research:
1. Initial broad search
2. Read top results, update understanding
3. Form refined follow-up query
4. Repeat until research budget (~15 calls) exhausted

### F.3 Executor — Multi-Section Generation

For complex environments, structured generation in passes:
1. Skeleton: class structure, required methods, type annotations
2. State management: observation/action/reward space definitions
3. Core implementation: step(), reset(), utility methods
4. Reward computation: all reward components
5. Termination: all conditions handled
6. Helpers: utility functions
7. Integration synthesis: final wiring, tests

### F.4 Archivist — Full ExPeL Contrastive Analysis

- Compare failed vs successful trajectories for same env class
- Failure-derived heuristics: +14.3% on planning tasks
- Success-derived heuristics: +9.0% on execution tasks

---

## 8. Metrics & Quality Gates

### Quality Metrics

| Metric | 3 Month Target | 12 Month Target |
|--------|----------------|-----------------|
| Test pass rate (first Executor attempt) | >75% | >90% |
| Fundamental failure rate | <10% | <2% |
| Exploit scan clean rate | >85% | >95% |
| Framework compatibility rate | >98% | >98% |
| Gold outcome rate | >40% | >60% |

### Self-Improvement Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| KB leverage rate | Fraction of jobs using Archivist-canonical entries | Increasing |
| Routing rate trend | Critic replan + Tester routing rates | Declining |
| Repeat failure rate | Same failure mode consecutive for same env class | → 0 |
| Skill Library reuse rate | Fraction of jobs retrieving/using Skill entries | Increasing |
| Archivist extraction durability | Canonical writes still used after 30 jobs | >80% |
| Prompt Evolver improvement delta | Mean quality improvement per cycle | Positive |

### System Metrics

| Metric | Target |
|--------|--------|
| Job completion time (simple) | <15 min |
| Job completion time (complex) | <90 min |
| Cost per job (actual vs model) | Within 20% |
| KB retrieval p50 | <50ms |
| KB retrieval p95 | <200ms |
| Sandbox cold start | <200ms |

---

## 9. Implementation References

### Key Files

| File | Purpose |
|------|---------|
| `src/eden/pipeline/state.py` | EdenJobState TypedDict |
| `src/eden/pipeline/graph.py` | Pipeline graph + routers |
| `src/eden/agents/*/agent.py` | Agent implementations |
| `src/eden/pipeline/nodes/*.py` | Pipeline node wrappers |
| `src/eden/storage/postgres.py` | PostgreSQL client |
| `src/eden/storage/qdrant.py` | Qdrant client |
| `src/eden/llm/client.py` | OpenRouter client |
| `src/eden/kb/*/client.py` | KB client implementations |
| `src/eden/api/app.py` | FastAPI application |
| `src/eden/sandbox/runner.py` | Sandbox runner |
| `migrations/001_kb_schema.sql` | PostgreSQL schema |
| `docker/docker-compose.yml` | Infrastructure services |

### Dependency Order

```
Phase A (Foundation) — Sequential
A.1 scaffolding
A.2 storage layer
A.3 LLM integration
A.4 LangGraph pipeline
A.5 API
A.6 sandbox

Phase B (Agents) — Can parallelize across agents
[depends on A complete]

Phase C (Evolution Engine) — Can parallelize
[depends on B complete]

Phase E (Integration) — After A-D complete
Phase F (Enhancement) — After B complete
```

---

## Document Information

| Field | Value |
|-------|-------|
| Version | 4.0 |
| Last Updated | May 2026 |
| Status | Implementation skeleton complete, integration pending |
| Owner | Eden Engineering |