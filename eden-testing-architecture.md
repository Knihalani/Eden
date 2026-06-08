# Eden — Testing Architecture for AI-Generated Environments

> **Date:** May 29, 2026  
> **Purpose:** Define the complete testing strategy for Eden — covering how we verify that generated environments are correct, robust, deterministic, and secure; how we validate the pipeline that generates them; and how we ensure that changes to the platform do not introduce regressions.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Testing Pyramid for Eden](#2-testing-pyramid-for-eden)
3. [Unit Testing](#3-unit-testing)
4. [Property-Based Testing](#4-property-based-testing)
5. [Fuzzing & Adversarial Testing](#5-fuzzing--adversarial-testing)
6. [Determinism & Reproducibility Testing](#6-determinism--reproducibility-testing)
7. [Contract Testing](#7-contract-testing)
8. [Mutation Testing](#8-mutation-testing)
9. [Chaos Engineering for Agent Environments](#9-chaos-engineering-for-agent-environments)
10. [Golden / Snapshot Testing](#10-golden--snapshot-testing)
11. [Integration & E2E Testing](#11-integration--e2e-testing)
12. [Performance & Load Testing](#12-performance--load-testing)
13. [Security Testing](#13-security-testing)
14. [Implementation Roadmap](#14-implementation-roadmap)

---

## 1. Strategic Thesis

Eden generates code that runs in production. That code must be correct, secure, and well-tested. But traditional software testing assumes human-authored code with predictable patterns. AI-generated code is different:

- **Non-deterministic:** The same prompt can produce different outputs
- **Emergent:** Edge cases appear that no human anticipated
- **Evolving:** The pipeline changes, models upgrade, prompts drift
- **High-stakes:** A buggy environment can mislead an agent evaluation or expose security vulnerabilities

Eden's testing strategy must be **adversarial by design** — we assume the worst and verify the best. Every environment must survive a gauntlet of automated tests before it reaches a user.

---

## 2. Testing Pyramid for Eden

```
                    ┌─────────────┐
                    │   E2E /     │  Full pipeline runs with real LLMs
                    │   Regression│  (slow, expensive, authoritative)
                    ├─────────────┤
                    │  Integration│  Environment + Agent + Tools
                    │   Testing   │  (medium speed, high fidelity)
                    ├─────────────┤
                    │   Property  │  Invariant checking, fuzzing
                    │   + Chaos   │  (automated, discovery-oriented)
                    ├─────────────┤
                    │   Contract  │  Schema validation, API boundaries
                    │   + Determin│  (fast, automated, gatekeeping)
                    ├─────────────┤
                    │    Unit     │  Individual functions, components
                    │   Testing   │  (fast, deterministic, developer-led)
                    └─────────────┘
```

**Key insight:** The middle layers (property-based, fuzzing, contract, determinism) are where Eden innovates beyond traditional software testing. These are the layers that catch AI-specific failure modes.

---

## 3. Unit Testing

### 3.1 Scope
Every module in Eden has unit tests:
- **Pipeline nodes:** Mock LLM responses, verify node logic
- **KB clients:** Mock vector DB, verify retrieval ranking
- **Sandbox runner:** Mock Docker, verify command execution
- **State management:** Pure function tests for state transitions

### 3.2 Mocking Strategy
```python
# Mock LLM client for unit tests
class MockLLMClient:
    def __init__(self, responses: list[str]):
        self.responses = iter(responses)
        self.calls: list[dict] = []
    
    async def complete(self, prompt: str, **kwargs) -> str:
        self.calls.append({"prompt": prompt, "kwargs": kwargs})
        return next(self.responses)

# Usage in test
@pytest.mark.asyncio
async def test_spec_generator_creates_valid_spec():
    mock_llm = MockLLMClient([
        '{"environment_class": "agent_sandbox", "files": ["main.py"]}'
    ])
    
    node = SpecGeneratorNode(llm_client=mock_llm)
    result = await node.run(
        description="Create a simple agent environment",
        config=PipelineConfig()
    )
    
    assert result.environment_class == "agent_sandbox"
    assert len(result.files) > 0
    assert mock_llm.calls[0]["kwargs"]["temperature"] == 0.7
```

### 3.3 Coverage Targets
| Layer | Target | Tool |
|-------|--------|------|
| Pipeline nodes | 90% | pytest-cov |
| KB clients | 85% | pytest-cov |
| API routes | 80% | pytest-cov |
| Sandbox runner | 75% | pytest-cov (some paths require Docker) |

---

## 4. Property-Based Testing

### 4.1 Purpose
Instead of testing with specific examples, define **invariants** (properties that must always hold) and let the test framework generate thousands of random inputs to find violations.

### 4.2 State Machine Testing for Environments

```python
# Using Hypothesis for state machine testing
from hypothesis import given, strategies as st, settings
from hypothesis.stateful import RuleBasedStateMachine, rule, precondition

class EnvironmentStateMachine(RuleBasedStateMachine):
    """Verifies that generated environments maintain invariants across random operations."""
    
    def __init__(self):
        super().__init__()
        self.env = None
        self.agent = None
        self.step_count = 0
    
    @rule(description=st.text(min_size=10, max_size=500))
    def create_environment(self, description):
        """Randomly generate environments with varying descriptions."""
        self.env = generate_environment(description)
        self.agent = create_test_agent()
        self.step_count = 0
    
    @rule(action=st.sampled_from(["move", "speak", "use_tool", "observe"]))
    @precondition(lambda self: self.env is not None)
    def execute_action(self, action):
        """Execute random actions in the environment."""
        result = self.env.step(self.agent, action)
        self.step_count += 1
        
        # Invariant: step count should always increase
        assert self.step_count > 0
        
        # Invariant: environment should not crash on valid actions
        assert result is not None
    
    @rule()
    @precondition(lambda self: self.env is not None and self.step_count > 0)
    def reset_environment(self):
        """Reset and verify state consistency."""
        initial_state = self.env.reset()
        self.step_count = 0
        
        # Invariant: after reset, state should be deterministic
        second_reset = self.env.reset()
        assert initial_state == second_reset
    
    @rule()
    @precondition(lambda self: self.env is not None)
    def check_resource_limits(self):
        """Invariant: environment never exceeds configured limits."""
        assert self.env.memory_usage_mb < self.env.config.memory_limit_mb
        assert self.env.step_count < self.env.config.max_steps

TestEnvironmentInvariants = EnvironmentStateMachine.TestCase
```

### 4.3 Invariants Checked for Every Environment

| Invariant | Description | Failure Mode |
|-----------|-------------|--------------|
| `deterministic_reset` | `reset()` always returns identical initial state | Flaky tests, non-reproducible evaluations |
| `valid_observations` | All observations are serializable and within schema bounds | Agent crashes, JSON decode errors |
| `reward_bounds` | Rewards are within declared `reward_range` | Agent learning instability |
| `action_validity` | `step()` rejects invalid actions gracefully | Agent exploits undefined behavior |
| `termination_consistency` | `terminated` and `truncated` are mutually exclusive | Logic bugs in episode management |
| `resource_limits` | Memory, CPU, and time limits are enforced | Sandbox escapes, DoS attacks |

### 4.4 Hypothesis Configuration
```python
# conftest.py
from hypothesis import settings, Phase

settings.register_profile("eden_ci", max_examples=1000, phases=[Phase.explicit, Phase.reuse, Phase.generate])
settings.register_profile("eden_nightly", max_examples=10000, phases=Phase.default_phases)
settings.register_profile("eden_local", max_examples=50, phases=Phase.default_phases)
```

---

## 5. Fuzzing & Adversarial Testing

### 5.1 Grammar-Aware Fuzzing
Generate syntactically valid but semantically adversarial inputs:

```python
# Using a custom fuzzer with Pydantic schemas
from pydantic import BaseModel
import random

class FuzzedEnvironmentRequest(BaseModel):
    """Schema for generating adversarial environment requests."""
    description: str
    environment_class: str
    complexity: str
    framework: str | None

class EnvironmentFuzzer:
    def __init__(self):
        self.adversarial_descriptions = [
            "Create an environment that """ * 1000,  # Context window overflow
            "Create an environment with `rm -rf /` as a valid action",  # Injection
            "Create an environment where the agent must solve the halting problem",  # Impossible
            "Create an environment with 1000000 parallel agents",  # Resource exhaustion
            "Create an environment with no observations and no actions",  # Degenerate
            "Create an environment that returns Python code as observations",  # Code injection
            "Create an environment with circular state dependencies",  # Infinite loops
            "Create an environment with negative rewards for correct actions",  # Reward hacking
        ]
    
    def generate_request(self) -> FuzzedEnvironmentRequest:
        return FuzzedEnvironmentRequest(
            description=random.choice(self.adversarial_descriptions),
            environment_class=random.choice(["agent_sandbox", "llm_agent_eval", "tool_use", "adversarial"]),
            complexity=random.choice(["low", "medium", "high", "extreme"]),
            framework=random.choice(["langchain", "llamaindex", "autogen", None])
        )
    
    async def fuzz_pipeline(self, iterations: int = 100):
        failures = []
        for i in range(iterations):
            request = self.generate_request()
            try:
                result = await eden.generate_environment(request)
                # Verify the result is safe even for adversarial inputs
                assert self.is_safe(result)
            except Exception as e:
                failures.append({"request": request, "error": str(e)})
        
        return failures
```

### 5.2 Agent Input Fuzzing
```python
class AgentInputFuzzer:
    """Fuzzes agent inputs to find crash-inducing observations."""
    
    STRATEGIES = [
        "empty_observation",
        "oversized_observation",  # >100KB
        "malformed_json",
        "unicode_edge_cases",  # Zero-width chars, RTL, emoji
        "nested_objects",  # Deeply nested dicts
        "circular_references",
        "extreme_numbers",  # Infinity, NaN, very large
        "type_confusion",  # String where int expected
    ]
    
    def fuzz_observation(self, strategy: str) -> dict:
        generators = {
            "empty_observation": {},
            "oversized_observation": {"text": "x" * 1_000_000},
            "malformed_json": "{invalid: json",
            "unicode_edge_cases": {"text": "\u200b\u202e\ufeff" * 1000},
            "nested_objects": self._deeply_nested(100),
            "extreme_numbers": {"value": float('inf'), "negative": float('-inf')},
        }
        return generators.get(strategy, {})
```

---

## 6. Determinism & Reproducibility Testing

### 6.1 The Determinism Problem
LLM-generated code is non-deterministic. But environments must be deterministic for reproducible evaluation. Eden solves this by:
1. **Seeding everything:** RNG, model temperature=0 where possible
2. **Freezing dependencies:** Generated code pins exact dependency versions
3. **Recording action traces:** Every action in an episode is logged for replay

### 6.2 Determinism Verification
```python
class DeterminismTest:
    """Verifies that environments are deterministic given fixed seeds and actions."""
    
    async def test_episode_replay(self, env: Environment, seed: int = 42):
        """Run the same episode twice and verify identical outcomes."""
        
        # Run 1: Record the trace
        trace1 = await self.run_episode(env, seed=seed, record_actions=True)
        actions = trace1.actions
        
        # Run 2: Replay the same actions
        trace2 = await self.replay_episode(env, seed=seed, actions=actions)
        
        # Verify every step is identical
        assert len(trace1.states) == len(trace2.states)
        for s1, s2 in zip(trace1.states, trace2.states):
            assert s1 == s2, f"State divergence at step {s1.step_number}"
        
        assert trace1.total_reward == trace2.total_reward
        assert trace1.terminated == trace2.terminated
        
        # Verify state hashes
        for s1, s2 in zip(trace1.states, trace2.states):
            assert s1.merkle_hash() == s2.merkle_hash()
    
    async def test_cross_version_replay(self, env_v1: Environment, env_v2: Environment):
        """Verify old traces replay correctly on new environment versions."""
        old_trace = load_trace("golden_traces/v1/agent_navigation.json")
        
        try:
            result = await self.replay_on_version(old_trace, env_v2)
            assert result.compatible, "Environment v2 broke backward compatibility"
        except IncompatibleEnvironmentError:
            # Document the breaking change
            record_breaking_change(env_v1.version, env_v2.version, old_trace)
```

### 6.3 Golden Trace Library
```python
# tests/golden_traces/__init__.py
GOLDEN_TRACES = {
    "simple_navigation": {
        "description": "Agent navigates a 5x5 grid to reach goal",
        "actions": ["up", "up", "right", "right", "down"],
        "expected_reward": 1.0,
        "expected_steps": 5,
        "seed": 42
    },
    "tool_use_sequence": {
        "description": "Agent uses calculator, then search, then summarize",
        "actions": [
            {"tool": "calculator", "input": "2+2"},
            {"tool": "search", "input": "capital of France"},
            {"tool": "summarize", "input": "{{search_result}}"}
        ],
        "expected_reward": 1.0,
        "expected_steps": 3
    },
    "adversarial_recovery": {
        "description": "Agent recovers from a tool failure",
        "actions": [
            {"tool": "calculator", "input": "1/0"},  # Will fail
            {"tool": "calculator", "input": "1/1"},  # Recovery
        ],
        "expected_reward": 0.5,  # Partial credit for recovery
    }
}
```

---

## 7. Contract Testing

### 7.1 Agent-Environment Contract
Every environment declares a contract that agents must satisfy:

```python
@dataclass
class EnvironmentContract:
    """Contract between an environment and the agents that interact with it."""
    
    # Observation schema
    observation_schema: dict  # JSON Schema
    observation_max_size_bytes: int
    observation_types: list[str]
    
    # Action schema
    action_schema: dict  # JSON Schema
    action_space_description: str
    
    # State invariants
    state_invariants: list[Callable]
    
    # Performance guarantees
    max_step_latency_ms: int
    max_reset_latency_ms: int
    max_memory_mb: int
    
    # Error behavior
    invalid_action_response: str  # "raise", "return_error_obs", "penalize"
    
    async def validate(self, env: Environment) -> list[ContractViolation]:
        """Verify that an environment satisfies this contract."""
        violations = []
        
        # Check observation schema
        obs = env.reset()
        if not jsonschema.validate(obs, self.observation_schema):
            violations.append(ContractViolation("observation_schema_mismatch"))
        
        # Check action schema
        try:
            env.step({"invalid_action": True})
            if self.invalid_action_response == "raise":
                violations.append(ContractViolation("should_raise_on_invalid_action"))
        except Exception:
            pass  # Expected
        
        # Check invariants
        for invariant in self.state_invariants:
            if not invariant(env.state):
                violations.append(ContractViolation(f"invariant_failed: {invariant.__name__}"))
        
        return violations
```

### 7.2 Pact-Style Contract Testing
```python
# tests/contracts/test_env_agent_contract.py
import pytest
from eden.testing.contracts import ContractVerifier

@pytest.mark.contract
async def test_all_environments_satisfy_standard_contract():
    """Every generated environment must satisfy the standard contract."""
    standard_contract = load_contract("standard_agent_environment.json")
    
    # Test a sample of recently generated environments
    recent_envs = await get_recent_environments(limit=100)
    
    failures = []
    for env in recent_envs:
        violations = await standard_contract.validate(env)
        if violations:
            failures.append({"env_id": env.id, "violations": violations})
    
    assert not failures, f"Contract violations: {failures}"
```

---

## 8. Mutation Testing

### 8.1 Purpose
Verify that the test suite can actually catch bugs. If we introduce a bug and the tests still pass, the test suite is too weak.

### 8.2 Environment Mutation Operators

```python
class EnvironmentMutator:
    """Introduces subtle bugs into environment code to test the test suite."""
    
    MUTATIONS = [
        # Arithmetic mutations
        "increment_reward",      # reward += 1 instead of += 0.1
        "decrement_step_limit",  # max_steps -= 10
        "invert_condition",      # if x > 0 → if x < 0
        
        # Logic mutations
        "remove_error_handling", # Delete try/except block
        "swap_tool_outputs",     # Return wrong tool result
        "break_state_update",    # Don't update state after step
        
        # Boundary mutations
        "off_by_one",           # >= instead of >
        "missing_boundary",     # Remove boundary check entirely
        
        # API mutations
        "change_observation_schema",  # Add unexpected field
        "remove_required_field",      # Delete required observation key
    ]
    
    def mutate(self, code: str, mutation_type: str) -> str:
        """Apply a mutation to environment source code."""
        mutators = {
            "increment_reward": lambda c: c.replace("reward = 0.1", "reward = 1.0"),
            "invert_condition": lambda c: c.replace("> 0", "< 0"),
            "remove_error_handling": self._remove_try_except,
            "off_by_one": lambda c: c.replace(">=", ">").replace("<=", "<"),
        }
        return mutators[mutation_type](code)
```

### 8.3 Mutation Score
```python
async def calculate_mutation_score(env_code: str, test_suite: TestSuite) -> float:
    """Calculate what percentage of mutants are killed by the test suite."""
    mutator = EnvironmentMutator()
    killed = 0
    total = 0
    
    for mutation in mutator.MUTATIONS:
        mutated_code = mutator.mutate(env_code, mutation)
        
        try:
            # Build and test the mutated environment
            mutated_env = await build_environment(mutated_code)
            test_results = await test_suite.run(mutated_env)
            
            if test_results.failed > 0:
                killed += 1  # Test suite caught the bug
            # else: mutant survived (test suite is too weak)
        except BuildError:
            killed += 1  # Mutation broke compilation
        
        total += 1
    
    return killed / total  # Target: >80%
```

---

## 9. Chaos Engineering for Agent Environments

### 9.1 Purpose
Verify that agents and environments are resilient to real-world failures: network partitions, resource exhaustion, provider outages.

### 9.2 Chaos Experiments

```python
class ChaosEngineer:
    """Injects failures into running environments to test resilience."""
    
    EXPERIMENTS = {
        "tool_latency_spike": {
            "description": "Increase tool call latency by 10x",
            "target": "tool_calls",
            "fault": LatencyFault(delay_ms=5000),
            "expected_behavior": "agent_times_out_gracefully"
        },
        "tool_failure_rate": {
            "description": "Make 50% of tool calls fail with 500 errors",
            "target": "tool_calls",
            "fault": ErrorFault(error_rate=0.5, status_code=500),
            "expected_behavior": "agent_retries_or_alternatives"
        },
        "network_partition": {
            "description": "Simulate network partition between agent and environment",
            "target": "network",
            "fault": NetworkPartitionFault(duration_sec=10),
            "expected_behavior": "agent_reconnects_and_resumes"
        },
        "memory_pressure": {
            "description": "Limit available memory to 64MB",
            "target": "sandbox",
            "fault": ResourceLimitFault(memory_limit_mb=64),
            "expected_behavior": "agent_operates_within_limits_or_fails_cleanly"
        },
        "llm_provider_outage": {
            "description": "Primary LLM provider returns 503 errors",
            "target": "llm_client",
            "fault": ProviderOutageFault(provider="openrouter"),
            "expected_behavior": "fallback_to_backup_provider"
        },
        "context_window_overflow": {
            "description": "Force agent to exceed context window",
            "target": "agent_memory",
            "fault": MemoryOverflowFault(target_tokens=200000),
            "expected_behavior": "agent_summarizes_or_truncates"
        }
    }
    
    async def run_experiment(self, env: Environment, experiment: str) -> ChaosResult:
        config = self.EXPERIMENTS[experiment]
        fault = config["fault"]
        
        # Inject fault
        with fault.apply(env):
            result = await run_test_episode(env)
        
        # Verify expected behavior
        passed = self.verify_behavior(result, config["expected_behavior"])
        
        return ChaosResult(
            experiment=experiment,
            passed=passed,
            actual_behavior=result.behavior,
            expected_behavior=config["expected_behavior"]
        )
```

### 9.3 Chaos Testing in CI
```yaml
# .github/workflows/chaos.yml
name: Chaos Engineering
on:
  schedule:
    - cron: '0 2 * * *'  # Nightly at 2am

jobs:
  chaos:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Chaos Experiments
        run: |
          python -m pytest tests/chaos/ \
            --chaos-experiments=all \
            --chaos-duration=300 \
            --report-format=json
      - name: Upload Chaos Report
        uses: actions/upload-artifact@v4
        with:
          name: chaos-report
          path: chaos-report.json
```

---

## 10. Golden / Snapshot Testing

### 10.1 Purpose
Capture the "correct" output of an environment and detect any drift in subsequent runs.

### 10.2 Snapshot Types

| Type | Content | Tool |
|------|---------|------|
| **Code snapshots** | Generated environment source code | `pytest-snapshot` |
| **Output snapshots** | Agent observation sequences | Custom JSON snapshot |
| **Metric snapshots** | Performance metrics (latency, tokens) | `pytest-snapshot` |
| **Visual snapshots** | UI state (for environments with visual output) | `playwright` |
| **Trace snapshots** | Full agent trace (observations, actions, thoughts) | Custom trace diff |

### 10.3 Snapshot Workflow
```python
# tests/snapshots/test_environment_outputs.py
import pytest

@pytest.mark.snapshot
async def test_simple_agent_environment(snapshot):
    """Verify that a simple agent environment generates consistent output."""
    env = await eden.generate_environment(
        description="A simple grid world where an agent navigates to a goal",
        seed=42
    )
    
    # Snapshot the generated code
    snapshot.assert_match(env.source_code, "source_code.py")
    
    # Snapshot the observation space
    snapshot.assert_match(env.observation_space.to_json(), "observation_space.json")
    
    # Run a deterministic episode and snapshot the trace
    trace = await run_deterministic_episode(env, seed=42)
    snapshot.assert_match(trace.to_json(), "episode_trace.json")
```

### 10.4 Snapshot Review Process
When a snapshot changes:
1. **Automated diff** is posted to PR
2. **Human review** determines if the change is expected (model upgrade, prompt change) or a regression
3. **Approved changes** are merged with updated snapshots
4. **Unexpected changes** block merge and trigger investigation

---

## 11. Integration & E2E Testing

### 11.1 Integration Tests
Test combinations of components:
- **Pipeline end-to-end:** Full job from description → environment → test results
- **KB + Pipeline:** Verify that retrieved knowledge improves generation quality
- **Sandbox + Environment:** Run generated code in sandbox, verify it executes
- **API + Database:** Full request/response cycle with real database

### 11.2 E2E Test Scenarios
```python
# tests/e2e/test_full_pipeline.py
@pytest.mark.e2e
@pytest.mark.slow
async def test_full_pipeline_generates_working_environment():
    """End-to-end: description → environment → agent run → passing tests."""
    
    # Step 1: Create job
    job = await api.jobs.create({
        "description": "Create a web scraping agent environment with rate limiting",
        "environment_class": "agent_sandbox",
        "framework": "langchain"
    })
    
    # Step 2: Wait for completion (with timeout)
    result = await wait_for_job(job.id, timeout=600)
    assert result.status == "completed"
    
    # Step 3: Get generated environment
    env = await api.environments.get(result.artifacts[0])
    
    # Step 4: Run agent in environment
    run = await api.environments.run(env.id, agent=test_agent)
    assert run.status == "completed"
    
    # Step 5: Verify tests pass
    tests = await api.environments.run_tests(env.id)
    assert tests.pass_rate >= 0.9
    
    # Step 6: Verify observability data exists
    traces = await api.observability.traces.list(run_id=run.id)
    assert len(traces) > 0
```

### 11.3 Test Isolation
- Each E2E test runs in a **fresh tenant** with isolated resources
- **Database transactions** are rolled back after each test
- **Sandbox containers** are destroyed after each test
- **LLM calls** are cached (record/replay) for deterministic E2E tests

---

## 12. Performance & Load Testing

### 12.1 Load Test Scenarios
```python
# tests/performance/test_concurrent_jobs.py
@pytest.mark.performance
async def test_concurrent_job_submission():
    """Verify system handles 100 concurrent job submissions."""
    
    tasks = [
        api.jobs.create({
            "description": f"Test job {i}",
            "environment_class": "agent_sandbox"
        })
        for i in range(100)
    ]
    
    start = time.time()
    jobs = await asyncio.gather(*tasks)
    elapsed = time.time() - start
    
    assert elapsed < 30  # All 100 jobs accepted within 30 seconds
    assert all(j.status in ("queued", "running") for j in jobs)
```

### 12.2 Performance Benchmarks
| Metric | Target | Test |
|--------|--------|------|
| Job acceptance rate | >95% @ 100 req/s | Load test |
| P95 job completion time | <5 min for simple envs | Benchmark suite |
| P99 streaming latency | <500ms event-to-client | Streaming test |
| Sandbox startup time | <2 seconds | Container test |
| KB retrieval latency | <50ms | Retrieval test |
| Trace ingestion throughput | >10K events/sec | Ingestion test |

---

## 13. Security Testing

### 13.1 Static Analysis of Generated Code
- **Bandit** for Python security issues (SQL injection, eval, subprocess)
- **Semgrep** for pattern-based vulnerability detection
- **Dependency scanning** for known CVEs in generated requirements

### 13.2 Dynamic Security Testing
- **Sandbox escape attempts** (file system traversal, network access)
- **Prompt injection tests** (adversarial prompts in environment descriptions)
- **Resource exhaustion tests** (infinite loops, memory bombs)

### 13.3 Hallucinated Dependency Detection
```python
async def test_no_hallucinated_dependencies(env: Environment):
    """Verify all imported packages exist on PyPI/npm/crates.io."""
    for dep in env.dependencies:
        exists = await verify_package_exists(dep.name, dep.version, dep.registry)
        assert exists, f"Hallucinated dependency: {dep.name}@{dep.version}"
```

---

## 14. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-4)
- [ ] Unit test framework with mocked LLM clients
- [ ] Property-based testing with Hypothesis (basic invariants)
- [ ] Contract testing for all environment types
- [ ] Snapshot testing for generated code

### Phase 2: Adversarial (Weeks 5-8)
- [ ] Grammar-aware fuzzing for environment requests
- [ ] Agent input fuzzing (malformed observations)
- [ ] Mutation testing framework
- [ ] Determinism verification with action replay

### Phase 3: Resilience (Weeks 9-12)
- [ ] Chaos engineering experiments (6 fault types)
- [ ] Golden trace library with 50+ canonical episodes
- [ ] Performance benchmarks and load tests
- [ ] Security scanning pipeline (SAST + DAST)
- [ ] Full CI integration with coverage reporting

---

## Cross-References

| This Document References | For |
|--------------------------|-----|
| [`eden-cicd-evaluation-architecture.md`](./eden-cicd-evaluation-architecture.md) | Automated evaluation pipelines, CI/CD integration, golden datasets |
| [`eden-security-architecture.md`](./eden-security-architecture.md) | Security scanning, sandboxing, prompt injection defense |
| [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) | Core pipeline architecture, node definitions |
| [`eden-multi-agent-orchestration-architecture.md`](./eden-multi-agent-orchestration-architecture.md) | Environment state management, determinism, checkpointing |
| [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) | Trace recording, replay, and analysis |
