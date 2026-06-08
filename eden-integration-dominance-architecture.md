# Eden — Strategic Integration & Dominance Architecture

> **Date:** May 29, 2026
> **Goal:** Make Eden the indispensable layer that every AI agent system integrates with — as environment generator, observability sink, and shared intelligence backbone.

---

## Table of Contents

1. [Strategic Vision](#1-strategic-vision)
2. [Current State Analysis](#2-current-state-analysis)
3. [Integration Target APIs](#3-integration-target-apis)
4. [Architecture: Eden as the Central Nervous System](#4-architecture)
5. [Phase 1: Environment Export — Feed Every Platform](#5-phase-1)
6. [Phase 2: Full Observability — Pipeline Transparency](#6-phase-2)
7. [Phase 3: Data Ingestion — Learn From Everything](#7-phase-3)
8. [Phase 4: Platform Dominance — The Standard Layer](#8-phase-4)
9. [SDK Design: The `eden-sdk`](#9-sdk-design)
10. [Data Schema: Universal Environment Report](#10-universal-schema)
11. [Roadmap & Timeline](#11-roadmap)
12. [Risk & Mitigation](#12-risks)
13. [Summary: Why Eden Wins](#13-summary)
14. [Extended Integration Targets](#14-extended-integration-targets)
15. [Extended Architecture: Cross-Layer Integration](#15-extended-architecture)
16. [Final Strategic Recommendations](#16-final-recommendations)
17. [Platform Features to Build — Beyond Integrations](#17-platform-features-to-build)

---

## 1. Strategic Vision

### The Core Insight

The AI agent ecosystem is fragmenting into specialized layers:

```
ENVIRONMENT GENERATION  ──►  SANDBOX EXECUTION  ──►  EVALUATION  ──►  OBSERVABILITY
      (Eden)                   (Runloop/E2B)         (Langfuse)        (W&B)
                                                       (LangSmith)
                                                       (Maxim AI)
```

**Currently, these layers don't talk to each other.** Every team manually:
1. Writes environments (badly)
2. Deploys them to sandboxes (painfully)
3. Evaluates agents in them (inconsistently)
4. Observes results in a different tool (fragmented)

**Eden's opportunity:** Own the environment generation layer AND become the data backbone that connects all other layers. Eden generates environments → exports them to every evaluation platform → ingests results back → improves future environments via the Archivist.

### The Winning Position

> "Eden is where environments are born, evaluated, and improved. Every agent system in the world generates its test environments here."

```
                     ┌─────────────────────────────────────┐
                     │              EDEN CLOUD              │
                     │  ┌───────────────────────────────┐   │
                     │  │    Environment Generator       │   │
                     │  │    (Pipeline: 17+ agents)      │   │
                     │  └──────────┬───────────────────┘   │
                     │             │                        │
                     │  ┌──────────▼───────────────────┐   │
                     │  │    Archivist / Knowledge Base │   │
                     │  │    (Compounds intelligence)    │   │
                     │  └──────────┬───────────────────┘   │
                     │             │                        │
                     │  ┌──────────▼───────────────────┐   │
                     │  │    Integration Engine         │   │
                     │  │    (Export + Import APIs)     │   │
                     │  └───────────────────────────────┘   │
                     └─────────────────────────────────────┘
                               │           │
              ┌────────────────┼───────────┼──────────────────┐
              │                │           │                   │
     ┌────────▼───┐   ┌───────▼───┐ ┌────▼────┐   ┌─────────▼──┐
     │  Langfuse   │   │ LangSmith │ │ W&B     │   │  Runloop   │
     │  (Eval)     │   │ (Eval)    │ │ (Obs)   │   │ (Sandbox)  │
     └─────────────┘   └───────────┘ └─────────┘   └────────────┘
     ┌─────────────┐   ┌───────────┐
     │  MCP Server │   │  E2B      │
     │  (Proto)    │   │ (Sandbox) │
     └─────────────┘   └───────────┘
```

---

## 2. Current State Analysis

### What Eden Already Has (Strengths to Build On)

| Asset | Description | Integration Value |
|---|---|---|
| **17+ Agent Pipeline** | Planner, Critic, Executor, Verifier, Tester, Adversarial Tester, Optimizer, Archivist, etc. | Each agent produces structured data that can be exported as observability traces |
| **Knowledge Base (KB)** | Episodic memory, semantic vectors, exploit library, skill library | Can ingest external data; can export findings to other platforms |
| **Checkpoint Blobs** | Every pipeline stage writes structured state to PostgreSQL | Already a trace-like format — maps naturally to OpenTelemetry spans |
| **Benchmark Engine** | Can create and run benchmarks against generated environments | Can export benchmark definitions to Langfuse/LangSmith datasets |
| **Sandbox Runner** | Firecracker microVM isolation with NullSandbox fallback | Can deploy environments to Runloop/E2B as alternative backend |
| **PostgreSQL + Qdrant** | Relational + vector storage | Backend for storing integration data, cross-platform references |

### What Eden Needs to Add (Gaps to Fill)

| Gap | Priority | Why |
|---|---|---|
| **OpenTelemetry export** | 🔴 Critical | All major observability platforms support OTel; Eden's pipeline emits nothing |
| **Environment Registry API** | 🔴 Critical | No way for external systems to discover or fetch generated environments |
| **SDK for external agents** | 🔴 Critical | Agents running elsewhere can't send data TO Eden |
| **Langfuse/LangSmith dataset export** | 🟡 High | Users want Eden environments as eval datasets |
| **Runloop/E2B deployment** | 🟡 High | Users want to run Eden environments in multiple sandbox types |
| **Cross-platform eval result ingestion** | 🟡 High | Eden's Archivist needs to learn from eval results everywhere |
| **Webhook system** | 🟡 Medium | Other platforms need real-time notifications when environments are ready |
| **MCP server** | 🟡 Medium | AI assistants (Claude, Cursor) need to trigger environment generation directly |
| **Structured pipeline trace schema** | 🟢 Medium | Internal traces need a standard format for cross-platform export |
| **CLI tool** | 🟢 Medium | Users want to generate environments from the terminal without a browser |
| **IDE extensions** | 🟢 Low | Generate environments from within VSCode/Cursor without leaving editor |
| **Kubernetes deployment** | 🟢 Low | Enterprise self-hosting requires Helm chart |

---

## 3. Integration Target APIs

### 3.1 Langfuse Integration API

**Purpose:** Export environments as evaluation datasets + emit pipeline traces

| Eden Action | Langfuse API | Details |
|---|---|---|
| Create eval dataset from environment | `POST /api/public/datasets` | Create dataset with env description as name |
| Add test cases (env interactions) | `POST /api/public/dataset-items` | Each item = one environment state + expected outcome |
| Emit pipeline agent trace | OTel/Ingestion API | Each agent = span, pipeline run = trace |
| Push quality scores | `POST /api/public/scores` | Quality, test coverage, adversarial robustness scores |
| Get eval results | `GET /api/public/dataset-runs` | Pull results to feed Eden's Archivist |

**Implementation pattern:** One Eden pipeline run → one Langfuse trace with nested spans for each agent. Environment → Langfuse dataset with items for each test case.

### 3.2 LangSmith Integration API

**Purpose:** Export environments as LangSmith datasets + emit run traces

| Eden Action | LangSmith API | Details |
|---|---|---|
| Create dataset | `POST /datasets` | Dataset name = "Eden: {env_description}" |
| Add examples | `POST /examples` | Each example = env spec, expected outputs, test cases |
| Emit pipeline run trace | `POST /runs` | Create run tree: pipeline → agents → sub-tasks |
| Submit quality feedback | `POST /feedback` | Score runs with quality metrics |
| Pull eval experiments | `POST /runs/query` | Get results of agent evals using Eden's datasets |

**Implementation pattern:** Each pipeline agent call → LangSmith run with parent_run_id linking. Environment test cases → LangSmith dataset examples.

### 3.3 W&B Weave Integration

**Purpose:** Emit pipeline traces to W&B + create evaluation datasets

| Eden Action | W&B API | Details |
|---|---|---|
| Initialize weave project | `weave.init("eden-{project}")` | One project per org or environment type |
| Trace pipeline agents | `@weave.op()` decorator | Wrap each agent call to capture inputs/outputs |
| Create evaluation dataset | `weave.Dataset` | From environment test cases and expected outcomes |
| Log quality metrics | `weave.publish()` | Quality scores, test results, adversarial findings |
| Pull runs for Archivist | W&B REST API | Query runs to extract failure patterns |

**Implementation pattern:** W&B already has the deepest Python SDK. Eden can wrap its agent pipeline with Weave decorators for zero-friction tracing.

### 3.4 Runloop Integration

**Purpose:** Deploy Eden-generated environments into Runloop Devboxes for agent execution

| Eden Action | Runloop API | Details |
|---|---|---|
| Create Devbox blueprint | `POST /blueprints` | Eden environment → Runloop Blueprint (Dockerfile-like) |
| Launch Devbox | `POST /devboxes` | Instantiate environment for agent testing |
| Execute agent in env | `POST /devboxes/{id}/exec` | Run agent evaluation inside the environment |
| Run benchmark suite | `POST /benchmarks` | Orchestrate multi-environment agent eval |
| Collect results | `GET /devboxes/{id}/results` | Pull execution results back to Eden |

**Implementation pattern:** Eden generates environment → exports as Runloop Blueprint → Runloop executes agent → results flow back to Eden's Archivist.

### 3.5 Maxim AI Integration

**Purpose:** Bidirectional — export environments as Maxim test runs, ingest simulation results

| Eden Action | Maxim AI API | Details |
|---|---|---|
| Create dataset | `POST /v1/datasets` | Eden environment test cases as Maxim dataset |
| Trigger simulation | `POST /v1/test-runs/simulations` | Run agent simulation in Eden environment |
| Log evaluation data | Logging API | Eden pipeline quality metrics as Maxim traces |
| Pull results | `GET /v1/test-runs/{id}` | Simulation results → Eden Archivist |

---

## 4. Architecture: Eden as the Central Nervous System

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EDEN PLATFORM                              │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Core Pipeline   │  │  Integration Hub  │  │  Archivist/KB    │  │
│  │                  │  │                   │  │                  │  │
│  │  Planner ────────┼──┤  OTel Exporter    │  │  Episodic        │  │
│  │  Executor ───────┼──┤  Langfuse Sync    │  │  Semantic        │  │
│  │  Verifier ───────┼──┤  LangSmith Sync   │  │  Exploit Lib     │  │
│  │  Tester ─────────┼──┤  W&B Weave Sync   │  │  Skill Lib       │  │
│  │  Adversarial ────┼──┤  Runloop Deployer │  │                  │  │
│  │  Archivist ──────┼──┤  E2B Deployer     │  │  Cross-Platform  │  │
│  │                  │  │  MCP Server       │  │  Intelligence    │  │
│  │                  │  │  Webhook Gateway  │  │                  │  │
│  │                  │  │  REST API (ext)   │  │                  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Eden SDK (@eden/sdk)                        │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐  │   │
│  │  │ env       │ │ observe  │ │ ingest   │ │ deploy          │  │   │
│  │  │ .generate │ │ .trace   │ │ .results │ │ .to_runloop     │  │   │
│  │  │ .describe │ │ .metrics │ │ .feedback│ │ .to_e2b         │  │   │
│  │  │ .export   │ │          │ │          │ │                 │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └─────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Integration Hub — Internal Design

```python
# /src/eden/integration/__init__.py

class EdenIntegrationHub:
    """Central integration point connecting Eden to all external platforms."""

    def __init__(self):
        self.exporters: dict[str, EnvironmentExporter] = {
            "langfuse": LangfuseExporter(),
            "langsmith": LangSmithExporter(),
            "wandb": WeaveExporter(),
            "runloop": RunloopDeployer(),
            "e2b": E2BDeployer(),
        }
        self.importers: dict[str, ResultImporter] = {
            "langfuse": LangfuseResultImporter(),
            "langsmith": LangSmithResultImporter(),
            "wandb": WeaveResultImporter(),
            "runloop": RunloopResultImporter(),
            "e2b": E2BResultImporter(),
        }
        self.otel: OpenTelemetryBridge = OpenTelemetryBridge()
        self.mcp: MCPServer = MCPServer()
        self.webhooks: WebhookGateway = WebhookGateway()

    async def on_pipeline_start(self, job_id: str, request: dict):
        """Called when a pipeline run starts."""
        self.otel.start_trace(job_id, "eden.pipeline.run")
        await self.webhooks.dispatch("pipeline.start", {"job_id": job_id})

    async def on_agent_complete(self, job_id: str, agent: str,
                                 inputs: dict, outputs: dict, duration_ms: int):
        """Called when any pipeline agent completes."""
        with self.otel.start_span(f"eden.agent.{agent}") as span:
            span.set_attributes({"job_id": job_id, "duration_ms": duration_ms})
        for exporter in self.exporters.values():
            if exporter.enabled:
                await exporter.export_agent_trace(job_id, agent, inputs, outputs)

    async def on_environment_complete(self, env: EnvironmentReport):
        """Called when an environment is fully generated."""
        for exporter in self.exporters.values():
            if exporter.enabled:
                await exporter.export_environment(env)
        await self.webhooks.dispatch("environment.complete", env.dict())

    async def ingest_external_results(self, platform: str,
                                       results: list[EvalResult]):
        """Ingest evaluation results from external platforms."""
        importer = self.importers.get(platform)
        if importer:
            parsed = await importer.parse(results)
            await self.archivist.ingest_external_findings(parsed)
```

---

## 5. Phase 1: Environment Export — Feed Every Platform

### Goal

Every environment Eden generates is automatically available as:
- A Langfuse evaluation dataset
- A LangSmith dataset with examples
- A W&B Weave dataset
- A Runloop Blueprint (optional)
- An E2B template (optional)
- An MCP-exposed environment (automatically)

### Implementation

#### 5.1 Universal Environment Report Schema

Every generated environment produces a standardized report that all exporters consume:

```python
class EnvironmentReport(BaseModel):
    """Standardized report produced after every successful pipeline run."""

    # Identity
    job_id: str
    description: str
    tags: list[str]
    created_at: datetime

    # The environment itself
    environment_code: str
    language: str
    framework: Optional[str]
    entry_point: str

    # Test suite
    tests: list[TestCase]

    # Quality metrics
    quality_score: float  # 0.0 - 1.0
    quality_report: QualityReport

    # Test results
    test_results: TestResults
    adversarial_findings: list[AdversarialFinding]

    # Metadata for exporters
    suggested_export_targets: list[str]  # ["langfuse", "langsmith", "wandb"]
    export_metadata: dict  # Platform-specific hints
```

#### 5.2 Langfuse Exporter

```python
class LangfuseExporter(EnvironmentExporter):
    """Exports Eden environments as Langfuse evaluation datasets."""

    async def export_environment(self, env: EnvironmentReport):
        # 1. Create dataset (idempotent)
        dataset = await self._create_dataset(
            name=f"eden-{env.job_id[:8]}",
            description=env.description[:500]
        )

        # 2. Add test cases as dataset items
        for test in env.tests:
            await self._create_dataset_item(
                dataset_id=dataset.id,
                input={
                    "environment_code": env.environment_code,
                    "test_input": test.input,
                    "entry_point": env.entry_point,
                },
                expected_output=test.expected_output
            )

        # 3. Add quality scores as dataset metadata
        await self._create_score(
            dataset_id=dataset.id,
            name="eden.quality_score",
            value=env.quality_score
        )

        # 4. Add adversarial findings as comments
        for finding in env.adversarial_findings:
            await self._add_comment(
                dataset_id=dataset.id,
                text=f"Adversarial: {finding.description} (severity: {finding.severity})"
            )
```

#### 5.3 LangSmith Exporter

```python
class LangSmithExporter(EnvironmentExporter):
    """Exports Eden environments as LangSmith datasets."""

    async def export_environment(self, env: EnvironmentReport):
        # 1. Create dataset
        dataset = await self._create_dataset(
            name=f"Eden: {env.description[:80]}",
            description=self._format_dataset_description(env),
        )

        # 2. Create example for each test case
        for test in env.tests:
            await self._create_example(
                dataset_id=dataset.id,
                inputs={
                    "environment_code": env.environment_code,
                    "test_case": test.input,
                    "tags": env.tags,
                },
                outputs={
                    "expected": test.expected_output,
                    "quality_score": env.quality_score,
                }
            )

        # 3. Create a run linking the dataset to Eden's pipeline
        await self._create_run(
            name=f"eden-pipeline-{env.job_id[:8]}",
            inputs={"description": env.description},
            outputs={"environments_count": 1, "quality_score": env.quality_score},
            extra={"tags": env.tags},
        )
```

#### 5.4 Runloop Deployer

```python
class RunloopDeployer(EnvironmentExporter):
    """Deploys Eden-generated environments to Runloop Devboxes."""

    async def export_environment(self, env: EnvironmentReport):
        # 1. Create a Blueprint from the environment
        blueprint = await self._create_blueprint(
            name=f"eden-{env.job_id[:8]}",
            definition=self._env_to_dockerfile(env),
        )

        # 2. Launch a Devbox for verification
        devbox = await self._create_devbox(blueprint_id=blueprint.id)

        # 3. Run a smoke test inside the Devbox
        result = await self._exec_command(
            devbox_id=devbox.id,
            command=f"cd /workspace && python -m pytest tests/ -x -q"
        )

        # 4. Report back to Eden
        return DeployResult(
            platform="runloop",
            resource_id=devbox.id,
            blueprint_id=blueprint.id,
            smoke_test_passed=result.exit_code == 0,
            access_url=devbox.access_url,
        )
```

### Integration Endpoint

```python
# New API endpoint: /environments/{job_id}/export

@router.post("/environments/{job_id}/export")
async def export_environment(
    job_id: str,
    targets: list[str] = Query(...),  # ["langfuse", "langsmith", "wandb", "runloop", "e2b"]
    user: dict = Depends(get_current_user),
):
    """Export a generated environment to one or more external platforms."""
    env = await build_environment_report(job_id)

    results = {}
    for target in targets:
        exporter = integration_hub.exporters.get(target)
        if exporter and exporter.enabled:
            result = await exporter.export_environment(env)
            results[target] = result.dict()

    return {"job_id": job_id, "exports": results}
```

---

## 6. Phase 2: Full Observability — Pipeline Transparency

### Goal

Every Eden pipeline run emits structured observability data that external platforms consume. Users can see Eden's pipeline in their existing observability stack.

### 6.1 OpenTelemetry Bridge

```python
# /src/eden/integration/otel.py

class OpenTelemetryBridge:
    """Bridges Eden's internal pipeline traces to OpenTelemetry.

    This is the single source of truth for observability. All exporters
    (Langfuse, LangSmith, W&B) can consume from OTel, or we can emit
    directly to each platform in parallel.
    """

    tracer: Tracer
    resource: Resource

    def __init__(self, service_name: str = "eden"):
        self.resource = Resource.create({
            "service.name": service_name,
            "service.version": "0.1.0",
        })
        self.tracer = trace.get_tracer(__name__)

        # Configure OTel processors
        span_processors = []

        # Always log to console in debug mode
        if settings.debug:
            span_processors.append(
                BatchSpanProcessor(ConsoleSpanExporter())
            )

        # Export to configured OTel collector
        if settings.otel_endpoint:
            span_processors.append(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=settings.otel_endpoint)
                )
            )

        # Direct exporters to specific platforms (alternative to OTel)
        if settings.langfuse_enabled:
            self.langfuse_exporter = LangfuseSpanExporter(settings.langfuse_config)
        if settings.langsmith_enabled:
            self.langsmith_exporter = LangSmithSpanExporter(settings.langsmith_config)

    def create_pipeline_trace(self, job_id: str, description: str):
        """Create a top-level trace for an entire pipeline run."""
        span = self.tracer.start_span(
            "eden.pipeline.run",
            attributes={
                "job.id": job_id,
                "job.description": description,
                "pipeline.version": "1.0",
            })
        return PipelineTraceContext(job_id, span)

    def create_agent_span(self, parent_context, agent_name: str, inputs: dict):
        """Create a span for a single pipeline agent execution."""
        span = self.tracer.start_span(
            f"eden.agent.{agent_name}",
            context=parent_context,
            attributes={
                "agent.name": agent_name,
                "input.size": len(str(inputs)),
            })
        return AgentSpanContext(agent_name, span)
```

### 6.2 What Becomes Observable

| Pipeline Event | OTel Span | Attributes | Exported To |
|---|---|---|---|
| Pipeline start | `eden.pipeline.run` | job_id, description, tags | All platforms |
| Planner execution | `eden.agent.planner` | floorplan, agents, action_space | All platforms |
| Critic analysis | `eden.agent.critic` | findings, routing_decision | All platforms |
| Executor code gen | `eden.agent.executor` | code_length, language, sections | All platforms |
| Tester execution | `eden.agent.tester` | tests_passed, tests_failed, coverage | All platforms |
| Adversarial testing | `eden.agent.adversarial` | findings_count, severity_distribution | All platforms |
| Verifier check | `eden.agent.verifier` | passed, issues, design_level | All platforms |
| Code quality scan | `eden.agent.code_quality` | score, issues, complexity | All platforms |
| Archivist update | `eden.agent.archivist` | kb_entries_added, patterns_found | All platforms |
| Environment complete | `eden.pipeline.complete` | outcome_tier, quality_score, duration | All platforms |

### 6.3 Langfuse Trace Example

When Eden's pipeline runs, Langfuse sees:

```
Trace: eden-pipeline-abc123
├── Span: eden.agent.planner (duration: 12.3s)
│   ├── Input: {"description": "multi-agent trading environment"}
│   └── Output: {"floorplan": {...}, "action_space": {...}}
├── Span: eden.agent.critic (duration: 8.1s)
│   ├── Input: {"floorplan": {...}}
│   └── Output: {"findings": [...], "routing": "approve"}
├── Span: eden.agent.executor (duration: 45.2s)
│   ├── Input: {"edp": {...}}
│   ├── Output: {"code": "class TradingEnv...", "sections": 5}
│   └── Score: quality=0.92
├── Span: eden.agent.tester (duration: 30.0s)
│   ├── Output: {"tests_passed": 24, "tests_failed": 1}
│   └── Score: test_pass_rate=0.96
├── Span: eden.agent.adversarial (duration: 15.0s)
│   ├── Output: {"findings": [{"type": "reward_hack", "severity": "low"}]}
│   └── Score: exploit_count=1
└── Span: eden.pipeline.complete
    ├── Output: {"outcome_tier": "silver", "quality_score": 0.88}
    └── Status: OK
```

Users click into Langfuse, see their Eden pipeline traces, drill into any agent's inputs/outputs, and view quality scores. **No other environment generator offers this.**

### 6.4 Pipeline Metrics Dashboard (Eden Native)

Beyond external observability, Eden should expose its own metrics:

```
GET /api/v1/metrics/pipeline
{
  "total_runs": 1523,
  "avg_duration_ms": 284000,
  "avg_quality_score": 0.87,
  "outcome_distribution": {
    "platinum": 0.12,
    "gold": 0.34,
    "silver": 0.38,
    "bronze": 0.16
  },
  "agent_latency_p99": {
    "planner": 45000,
    "executor": 120000,
    "tester": 60000,
    "adversarial": 30000
  },
  "failure_modes": [
    {"type": "test_failure", "count": 45, "pct": 0.03},
    {"type": "quality_below_threshold", "count": 28, "pct": 0.02}
  ]
}
```

---

## 7. Phase 3: Data Ingestion — Learn From Everything

### Goal

Eden's Archivist ingests evaluation results from every platform where Eden environments are used, creating a compounding intelligence flywheel.

### 7.1 The Flywheel

```
                    ┌─────────────────────────────────────┐
                    │       Eden generates environment     │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Environment exported to Langfuse,   │
                    │  LangSmith, W&B, Runloop, E2B        │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Agents evaluated in environment     │
                    │  (on any platform)                   │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Eval results pushed BACK to Eden    │
                    │  → passes, failures, edge cases     │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Archivist learns from failures:     │
                    │  - "agents failed at reward hacking" │
                    │  - "environment had blind spot"      │
                    │  - "tests missed edge case"          │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────────┐
                    │  Next environment is better because  │
                    │  Archivist incorporated all lessons  │
                    └─────────────────────────────────────┘
```

### 7.2 External Result Schema

Platforms push results to Eden via a standardized schema:

```python
class ExternalEvalResult(BaseModel):
    """Evaluation result from an external platform."""

    # Source identification
    source_platform: str  # "langfuse", "langsmith", "wandb", "maxim",
                          # "runloop", "e2b"
    source_run_id: str
    source_dataset_id: str

    # Which Eden environment was used
    eden_job_id: str
    eden_environment_hash: str  # Content hash for version tracking

    # The agent that was evaluated
    agent_name: str
    agent_version: Optional[str]

    # Evaluation results
    passed: bool
    scores: dict[str, float]  # Metric name → score (0.0-1.0)

    # Detailed findings
    failures: list[FailureDetail]
    edge_cases_discovered: list[str]

    # Timing
    duration_ms: int
    evaluated_at: datetime

    # Raw data (optional, for Archivist deep analysis)
    raw_traces: Optional[list[dict]]
    raw_logs: Optional[str]


class FailureDetail(BaseModel):
    """A specific failure discovered during agent evaluation."""

    category: str  # "reward_hack", "state_corruption", "termination_bypass", etc.
    description: str
    severity: Literal["critical", "high", "medium", "low"]
    reproducible: bool
    trigger_input: Optional[dict]  # What input triggered the failure
```

### 7.3 Ingestion API

```python
# POST /api/v1/integration/results
# Accepts evaluation results from any platform

@router.post("/integration/results")
async def ingest_external_results(
    results: list[ExternalEvalResult],
    api_key: str = Depends(verify_integration_api_key),
):
    """Ingest evaluation results from external platforms.

    Results are processed by the Archivist to:
    1. Update environment quality scores with external validation
    2. Discover new failure patterns from agent evaluations
    3. Enrich the Knowledge Base with cross-platform findings
    """
    processed = []
    for result in results:
        # 1. Verify the environment exists and matches hash
        env = await verify_environment(result.eden_job_id, result.eden_environment_hash)

        # 2. Log the eval result
        eval_entry = await log_external_eval(result)
        processed.append(eval_entry.id)

        # 3. Feed to Archivist for analysis
        await archivist.ingest_external_finding(result)

        # 4. If critical failure found, create alert
        if any(f.severity == "critical" for f in result.failures):
            await alerting_service.create_alert(
                type="external_critical_failure",
                source=result.source_platform,
                environment_id=result.eden_job_id,
                failures=[f.dict() for f in result.failures if f.severity == "critical"],
            )

    return {"ingested": len(processed), "ids": processed}
```

### 7.4 Platform-Specific Pullers

For platforms that don't push, Eden pulls:

```python
class LangfuseResultImporter(ResultImporter):
    """Pulls evaluation results from Langfuse for Eden environments."""

    async def poll_for_results(self, since: datetime) -> list[ExternalEvalResult]:
        # 1. Query Langfuse for dataset runs on Eden-created datasets
        dataset_runs = await self.client.get_dataset_runs(
            dataset_name_prefix="eden-",
            since=since,
        )

        # 2. For each run, get scores and feedback
        results = []
        for run in dataset_runs:
            scores = await self.client.get_scores(run_id=run.id)
            traces = await self.client.get_traces(dataset_run_id=run.id)

            # 3. Map to Eden's schema
            results.append(self._map_to_eden_schema(run, scores, traces))

        return results

    async def listen_for_webhooks(self):
        """Alternative: receive webhook events from Langfuse."""
        # Langfuse sends webhook when score is created or run completes
        pass
```

### 7.5 The Universal Cross-Platform Archivist

```python
class CrossPlatformArchivist:
    """Extends Eden's Archivist to learn from cross-platform data.

    This is Eden's super-moat: no other platform has access to
    evaluation results from MULTIPLE platforms.
    """

    async def ingest_external_finding(self, result: ExternalEvalResult):
        """Process an external evaluation result."""

        # 1. Extract failure patterns
        for failure in result.failures:
            # Store in episodic memory
            await self.episodic_client.store_external_failure(
                source=result.source_platform,
                environment_id=result.eden_job_id,
                agent_name=result.agent_name,
                failure=failure,
            )

            # Check if this is a new pattern
            similar = await self.semantic_client.search_similar_failures(
                failure.description,
                threshold=0.85,
            )
            if not similar:
                # This is a novel failure pattern!
                await self.exploit_client.register_new_exploit(
                    category=failure.category,
                    description=failure.description,
                    trigger_input=failure.trigger_input,
                    discovered_by=f"{result.source_platform}/{result.agent_name}",
                )
                logger.info(f"New exploit discovered from {result.source_platform}: {failure.description}")

        # 2. Update environment quality score with external validation
        if result.scores:
            await self._update_environment_score(
                environment_id=result.eden_job_id,
                external_scores=result.scores,
                source=result.source_platform,
            )

        # 3. Generate cross-platform insight
        await self._generate_cross_platform_insight(result)

    async def get_cross_platform_insights(self, environment_id: str) -> dict:
        """Get all evaluation results for an environment across all platforms."""
        return {
            "environment_id": environment_id,
            "total_evaluations": await self._count_evaluations(environment_id),
            "platforms": await self._get_platform_distribution(environment_id),
            "failure_modes": await self._get_failure_modes(environment_id),
            "agent_comparison": await self._get_agent_comparison(environment_id),
            "improvement_rate": await self._get_improvement_rate(environment_id),
        }
```

---

## 8. Phase 4: Platform Dominance — The Standard Layer

### Goal

Eden becomes the de facto standard for environment generation across the entire AI ecosystem.

### 8.1 The Eden Registry

A public registry where teams discover, share, and deploy environments:

```python
# GET /api/v1/registry/environments
# Public environment registry (like Docker Hub for AI environments)

class EnvironmentRegistry:
    """Public registry of Eden-generated environments."""

    async def publish_environment(
        self,
        env: EnvironmentReport,
        visibility: Literal["public", "org", "private"] = "org",
    ):
        """Publish an environment to the registry."""
        entry = RegistryEntry(
            id=env.job_id,
            name=self._generate_name(env.description),
            description=env.description[:200],
            tags=env.tags,
            quality_score=env.quality_score,
            language=env.language,
            framework=env.framework,
            test_count=len(env.tests),
            test_pass_rate=self._calculate_pass_rate(env.test_results),
            adversarial_findings=len(env.adversarial_findings),
            download_count=0,
            created_at=datetime.now(timezone.utc),
            published_by=self._get_publisher(),
            visibility=visibility,
            # Export targets
            available_as: {
                "langfuse_dataset": f"https://langfuse.com/dataset/{env.job_id}",
                "langsmith_dataset": f"https://smith.langchain.com/dataset/{env.job_id}",
                "runloop_blueprint": f"https://runloop.ai/blueprint/{env.job_id}",
            },
        )
        await self._store(entry)
        return entry

    async def search(
        self,
        query: str,
        tags: list[str] = None,
        min_quality: float = 0.0,
        max_results: int = 20,
    ) -> list[RegistryEntry]:
        """Search public environments."""
        # Vector search on descriptions + tag filtering
        ...
```

### 8.2 Universal Evaluation Comparison

Eden enables the first cross-platform, cross-agent evaluation comparison:

```
┌───────────────────────────────────────────────────────────────────┐
│                    EDEN EVALUATION COMPARISON                      │
│                                                                   │
│ Environment: Multi-Agent Trading Environment v2                   │
│ Quality Score: 0.92 (Platinum)                                    │
│                                                                   │
│ ┌─────────────┬──────────┬──────────┬──────────┬────────────────┐ │
│ │ Agent       │ Langfuse │ LangSmith│ W&B      │ Runloop        │ │
│ ├─────────────┼──────────┼──────────┼──────────┼────────────────┤ │
│ │ GPT-4 Agent │ 0.87     │ 0.85     │ 0.88     │ 0.86 (avg)    │ │
│ │ Claude-3    │ 0.92     │ 0.91     │ 0.93     │ 0.92 (avg)    │ │
│ │ Custom R1   │ 0.78     │ 0.75     │ 0.80     │ 0.77 (avg)    │ │
│ └─────────────┴──────────┴──────────┴──────────┴────────────────┘ │
│                                                                   │
│ Failure modes discovered across platforms:                        │
│   • reward_hack: 3 platforms (Langfuse, LangSmith, W&B)          │
│   • state_corruption: 2 platforms (Langfuse, Runloop)            │
│   • termination_bypass: 1 platform (LangSmith) — NEW             │
│                                                                   │
│ Insights: Claude-3 is the strongest agent in this environment.    │
│ A reward_hack was found by agents running on 3 different          │
│ evaluation platforms — suggests a systematic environment issue.   │
│ Recommended: Patch reward function in the Executor.               │
└───────────────────────────────────────────────────────────────────┘
```

### 8.3 The Ecosystem Moat

Once Eden achieves critical mass:

1. **Network effects:** More environments → more evaluations → more Archivist learning → better environments
2. **Cross-platform intelligence:** Only Eden sees failures across all platforms simultaneously
3. **Registry lock-in:** Teams publish and discover environments on Eden; moving away means losing access
4. **Quality standard:** Eden's quality pipeline becomes the benchmark; environments without Eden's score are suspect
5. **Integration debt:** Deep integrations with Langfuse, LangSmith, W&B, Runloop, MCP, E2B, and K8s make Eden sticky

---

## 9. SDK Design: The `eden-sdk`

### 9.1 Python SDK

```python
# pip install eden-sdk

from eden import Eden

# Initialize
eden = Eden(api_key="...")

# 1. Generate an environment
env = eden.environments.generate(
    description="A multi-agent trading environment with 3 agents and order-book dynamics",
    tags=["multi-agent", "trading", "simulation"],
)

# 2. Export to evaluation platforms
env.export(to=["langfuse", "langsmith", "wandb"])

# 3. Deploy to sandbox
deployment = env.deploy(to="runloop", blueprint_name="trading-env-v1")
# Or to E2B
deployment = env.deploy(to="e2b", template_name="trading-env-v1")

# 4. Trace an external agent evaluation
with eden.observe.trace(environment_id=env.id) as trace:
    result = my_agent.run(env)
    trace.log(result=result, scores={"accuracy": 0.92})

# 5. Push results back to Eden
eden.ingest.results(
    environment_id=env.id,
    agent_name="my-agent-v2",
    results=[result],
    platform="custom",
)

# 6. Query the Knowledge Base
insights = eden.kb.query("reward hacking in multi-agent trading environments")

# 7. Use MCP to expose environment generation to any AI assistant
# (MCP server runs separately)
```

### 9.2 TypeScript SDK

```typescript
import { Eden } from "@eden/sdk";

const eden = new Eden({ apiKey: "..." });

// Generate environment
const env = await eden.environments.generate({
  description: "A multi-agent trading environment",
  tags: ["multi-agent", "trading"],
});

// Export
await env.export(["langfuse", "langsmith"]);

// Deploy
const deployment = await env.deploy("runloop");

// Observe external agent
const trace = eden.observe.createTrace(env.id);
const result = await myAgent.run(env);
trace.log({ result, scores: { accuracy: 0.92 } });
await trace.flush();

// Ingest results
await eden.ingest.results({
  environmentId: env.id,
  agentName: "my-agent",
  results: [result],
});
```

### 9.3 SDK Architecture

```
eden-sdk/
├── core/
│   ├── client.py          # HTTP client, auth, retry
│   ├── config.py          # Configuration management
│   └── errors.py          # Typed exceptions
├── environments/
│   ├── generate.py        # Environment generation
│   ├── export.py          # Export to platforms
│   └── deploy.py          # Deploy to sandboxes
├── observe/
│   ├── trace.py           # OpenTelemetry-based tracing
│   ├── metrics.py         # Metrics collection
│   └── evaluate.py        # Run evaluations
├── ingest/
│   ├── results.py         # Push eval results
│   ├── feedback.py        # Push feedback/scores
│   └── datasets.py        # Manage datasets
├── kb/
│   ├── query.py           # Knowledge Base queries
│   └── insights.py         # Cross-platform insights
└── integrations/
    ├── langfuse.py        # Langfuse-specific helpers
    ├── langsmith.py       # LangSmith-specific helpers
    ├── wandb.py           # W&B specific helpers
    ├── runloop.py         # Runloop-specific helpers
    ├── e2b.py             # E2B-specific helpers
    ├── vscode.py          # VS Code extension helpers
    └── mcp.py             # MCP client helpers
```

### 9.4 REST API (for non-Python/TS platforms)

```
┌────────────────────────────────────────────────────────────┐
│                   EDEN PUBLIC API                           │
│                                                            │
│ POST   /api/v1/environments/generate                       │
│ GET    /api/v1/environments/{id}                           │
│ POST   /api/v1/environments/{id}/export                   │
│ POST   /api/v1/environments/{id}/deploy                   │
│                                                            │
│ POST   /api/v1/observe/traces                             │
│ POST   /api/v1/observe/metrics                            │
│                                                            │
│ POST   /api/v1/ingest/results                             │
│ POST   /api/v1/ingest/feedback                            │
│ POST   /api/v1/ingest/datasets                            │
│                                                            │
│ GET    /api/v1/kb/query                                    │
│ GET    /api/v1/kb/insights                                │
│ GET    /api/v1/kb/registry                                │
│                                                            │
│ GET    /api/v1/metrics/pipeline                           │
│ GET    /api/v1/metrics/cross-platform                     │
│                                                            │
│ GET    /api/v1/integrations                               │
│ POST   /api/v1/integrations/webhooks                      │
│ GET    /api/v1/integrations/status                        │
└────────────────────────────────────────────────────────────┘
```

---

## 10. Universal Schema: The Environment Report

The `EnvironmentReport` is the canonical data schema that all integrations consume. It must be rich enough to satisfy every platform's requirements.

```python
class EnvironmentReport(BaseModel):
    """Universal environment report — the canonical output of every Eden pipeline run.

    This single schema feeds ALL integration targets (Langfuse, LangSmith, W&B, Runloop,
    E2B, MCP). It is designed to be lossless: no information from the pipeline is discarded.
    """

    # ─── Identity ───────────────────────────────────────────
    job_id: str
    description: str
    tags: list[str]
    created_at: datetime
    duration_ms: int

    # ─── Pipeline Metadata ──────────────────────────────────
    pipeline_version: str
    outcome_tier: Optional[str]  # "platinum", "gold", "silver", "bronze"
    agent_count: int
    total_llm_calls: int
    total_tokens_used: int

    # ─── The Environment ────────────────────────────────────
    environment_code: str
    language: str  # "python", "rust", "typescript", etc.
    framework: Optional[str]  # "gymnasium", "battlecode", custom
    entry_point: str  # How to instantiate the environment
    dependencies: list[str]  # Required packages

    # ─── Docker / Container Info (for sandbox deployment) ──
    dockerfile: Optional[str]  # Generated Dockerfile for sandbox deployment
    requirements: Optional[list[str]]  # Exact package requirements
    base_image: Optional[str]  # Recommended base image

    # ─── Design Spec (EDP) ─────────────────────────────────
    design_spec: EnvironmentDesignSpec

    # ─── Test Suite ─────────────────────────────────────────
    tests: list[TestCase]

    # ─── Quality Metrics ───────────────────────────────────
    quality_score: float  # 0.0 - 1.0
    quality_breakdown: QualityBreakdown

    # ─── Test Results ──────────────────────────────────────
    test_results: TestResults

    # ─── Adversarial Findings ──────────────────────────────
    adversarial_findings: list[AdversarialFinding]

    # ─── Verifier Assessment ───────────────────────────────
    verifier_report: VerifierReport

    # ─── Archivist Summary ─────────────────────────────────
    archivist_summary: ArchivistSummary

    # ─── Integration Targets ──────────────────────────────
    export_formats: dict[str, str]  # "langfuse" → "dataset/abc123"
    deploy_targets: dict[str, str]  # "runloop" → "blueprint/abc123"
    mcp_exposed: bool  # Available via MCP


class EnvironmentDesignSpec(BaseModel):
    """The Environment Design Plan — what was planned vs. what was built."""

    environment_class: str
    observation_modality: str
    action_space_type: str
    agent_count_range: tuple[int, int]
    reward_structure: dict
    termination_conditions: list[str]
    novelty_assessment: str
    design_confidence: float


class QualityBreakdown(BaseModel):
    """Breakdown of the quality score by dimension."""

    overall: float
    code_quality: float  # 0.0 - 1.0
    test_coverage: float
    adversarial_robustness: float
    documentation: float
    performance: float
    security: float


class TestCase(BaseModel):
    """A single test case for the environment."""

    id: str
    name: str
    description: str
    input: dict
    expected_output: Any
    category: str  # "unit", "integration", "functional", "edge_case"
    required: bool  # Must pass for environment to be valid


class TestResults(BaseModel):
    """Results from running the test suite."""

    total: int
    passed: int
    failed: int
    errors: int
    pass_rate: float
    duration_ms: int
    failures: list[TestFailure]


class TestFailure(BaseModel):
    """A single test failure."""

    test_id: str
    test_name: str
    error_message: str
    expected: Any
    actual: Any
    stack_trace: Optional[str]


class AdversarialFinding(BaseModel):
    """A finding from the adversarial tester."""

    type: str  # "reward_hack", "edge_case", "state_corruption", etc.
    severity: Literal["critical", "high", "medium", "low"]
    description: str
    exploit_probe_used: str
    trigger_input: Optional[dict]
    mitigation_suggestion: str


class VerifierReport(BaseModel):
    """Assessment from the Verifier agent."""

    passed: bool
    issues: list[VerifierIssue]
    design_level: bool
    suggestion: Optional[str]


class VerifierIssue(BaseModel):
    """A specific issue found by the Verifier."""

    category: str
    severity: str
    message: str
    line_number: Optional[int]
    suggestion: str


class ArchivistSummary(BaseModel):
    """Summary from the Archivist — what was learned."""

    kb_entries_added: int
    patterns_identified: list[str]
    similar_environments: list[dict]
    cross_references: list[dict]
    novelty_score: float  # How novel is this environment vs. KB history
```

---

## 11. Roadmap & Timeline

### Phase 1: Foundation (30 Days)

| Week | Milestone | Deliverables |
|---|---|---|
| 1-2 | Integration Hub core | `EdenIntegrationHub` class, OpenTelemetry bridge, universal `EnvironmentReport` schema |
| 2 | Export to Langfuse | `LangfuseExporter` — create dataset, add items, push scores |
| 2 | Export to LangSmith | `LangSmithExporter` — create dataset, add examples, push feedback |
| 3 | Pipeline OTel traces | All 17+ agents emit spans with inputs/outputs/attributes |
| 3 | Webhook system | `POST /api/v1/webhooks` — fire events on pipeline start/complete/agent stages |
| 3 | MCP server v1 | Expose 2 tools: `generate_environment`, `list_environments` |
| 4 | Internal dogfood | Eden's own pipeline traces itself via OTel; verify in Langfuse |

### Phase 2: Ingestion + Sandbox Deployment (30 Days)

| Week | Milestone | Deliverables |
|---|---|---|
| 5-6 | Ingestion API | `POST /api/v1/integration/results` with `ExternalEvalResult` schema |
| 6 | Langfuse result puller | `LangfuseResultImporter` — pull dataset run results and scores |
| 6 | LangSmith result puller | `LangSmithResultImporter` — query runs and feedback |
| 6 | Runloop deployer | `RunloopDeployer` — Blueprint creation + Devbox smoke test |
| 7 | E2B deployer | `E2BDeployer` — template creation + sandbox execution |
| 7 | Cross-platform Archivist | `CrossPlatformArchivist` — learn from external eval results |
| 8 | Notification system | Slack Block Kit, Discord embeds, PagerDuty integration |

### Phase 3: SDK + IDE + CLI (30 Days)

| Week | Milestone | Deliverables |
|---|---|---|
| 9 | Python SDK beta | `eden-sdk` with generate/export/deploy/observe/ingest |
| 9 | TypeScript SDK beta | `@eden/sdk` with same capabilities |
| 9 | CLI tool v1 | `eden` CLI with generate, test, export commands |
| 10 | VSCode Extension | Command palette integration, webview dashboard |
| 10 | Environment Registry | Public registry API + web UI for discovering environments |
| 10 | Universal Eval Comparison | Cross-platform evaluation comparison dashboard |
| 11 | Documentation | Integration guides for ALL platforms, SDK docs, CLI reference |
| 11 | Open source SDK + MCP | `eden-sdk` MIT on GitHub; MCP server published |
| 12 | Launch | Public launch with all integrations live |

### Phase 4: Dominance (90+ Days)

| Quarter | Initiative |
|---|---|
| Q3 2026 | **Eden Registry v1** — public environment marketplace with search, quality scores, community contributions |
| Q3 2026 | **Helm Chart** — one-command self-hosted deployment on Kubernetes |
| Q3 2026 | **Enterprise SSO** — self-hosted integration hub with data residency controls |
| Q4 2026 | **Agent-in-the-Loop Debugging** — time-travel debugging for agents in Eden environments via MCP |
| Q4 2026 | **Custom Evaluator SDK** — users write evaluators in Eden that run across all platforms |
| Q1 2027 | **Environment Composition** — compose multiple environments into test suites (like Docker Compose for AI) |
| Q1 2027 | **Cross-Platform Federated Learning** — Archivist learns from evaluations across all customer environments |

---

## 12. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **Platform API changes** — Langfuse/LangSmith break integration | Medium | Medium | Abstract behind integration hub interface; pin API versions; OTel as fallback |
| **Competitors build environment generation** — Maxim/Runloop add gen features | High | Medium | Beat them on integration depth; open-source SDK; registry network effects; invest in platform features |
| **Performance overhead** — OTel tracing slows pipeline | Medium | Medium | Async export with batching; configurable sampling rate; no blocking in hot path |
| **Data privacy** — customers don't want envs exported | High | Medium | Per-platform opt-in; self-hosted integration hub; data residency options |
| **API rate limits** — Langfuse/LangSmith throttle integration | Medium | High | Batched exports; exponential backoff; local caching with periodic sync |
| **MCP protocol changes** — protocol is early-stage | Medium | Medium | Use stable SDK version; fallback to REST API |
| **User confusion** — too many platforms, unclear value | Medium | Low | Opinionated defaults ("auto-export to Langfuse"); clear docs on each integration |
| **Archivist data quality** — external results may be noisy | Medium | Low | Confidence scoring on external data; human review for critical patterns |

---

## 13. Summary: Why Eden Wins

### The Unassailable Position

| Competitor | Eden's Answer |
|---|---|
| **Langfuse** — great at tracing, can't generate environments | Eden generates environments → Langfuse traces them → Eden learns from results |
| **LangSmith** — deep LangChain integration, locked-in | Eden is framework-agnostic + feeds LangSmith datasets |
| **W&B Weave** — unified ML/LLM tracking | Eden's pipeline quality metrics enrich W&B dashboards |
| **Runloop** — great sandboxes, coding agents only | Eden generates ALL environment types → Runloop executes them |
| **E2B** — secure sandboxes, strong MCP support | Eden generates envs → E2B runs them → Eden tracks via OTel |
| **Maxim AI** — agent simulation, static envs | Eden generates NOVEL environments → Maxim simulates in them |

**Eden doesn't compete with these platforms. Eden makes them better.**

The moment Eden integrates with all of them, it becomes:
1. **The default environment source** for every evaluation
2. **The only platform with cross-platform intelligence**
3. **The quality standard** that all environments are measured against
4. **The compounding intelligence layer** that gets stronger with every eval on every platform

**No competitor can replicate this without building Eden's pipeline, Archivist, and integrations simultaneously.**

---

## 14. Extended Integration Targets

### 14.1 E2B Sandbox Integration

**Strategic Rationale:** E2B is the leading open-source sandbox for AI coding agents, with strong MCP support and Firecracker microVM isolation. By integrating with E2B, Eden's environments can be deployed in the sandbox that thousands of agent developers already use.

**Key Differences from Runloop:**
- E2B uses Firecracker microVMs (same as AWS Lambda) for stronger isolation
- E2B templates are Dockerfile-based, not proprietary Blueprints
- E2B has deeper MCP integration — sandboxes can serve as MCP hosts

**Implementation:**

```python
class E2BDeployer(EnvironmentExporter):
    """Deploys Eden-generated environments to E2B sandboxes.

    E2B's template system uses Debian-based Dockerfiles.
    Eden converts the environment into a template, instantiates
    a sandbox, and runs smoke tests.
    """

    async def export_environment(self, env: EnvironmentReport) -> DeployResult:
        # 1. Create template definition
        template_name = f"eden-{env.job_id[:8]}"
        template_def = self._generate_template_definition(env)

        # 2. Build template via E2B CLI/API
        template = await self._create_template(template_name, template_def)

        # 3. Instantiate sandbox
        sandbox = await self._create_sandbox(template.template_id)

        # 4. Run smoke test
        result = await sandbox.run_code(
            # Copy environment code in, run tests
            f"""
            import sys
            sys.path.insert(0, '/workspace')
            {env.environment_code}
            """
        )

        return DeployResult(
            platform="e2b",
            resource_id=sandbox.sandbox_id,
            template_id=template.template_id,
            smoke_test_passed=result.exit_code == 0,
            access_url=f"https://e2b.dev/sandbox/{sandbox.sandbox_id}",
        )

    def _generate_template_definition(self, env: EnvironmentReport) -> dict:
        """Convert Eden environment to E2B template definition."""
        return {
            "name": f"eden-{env.job_id[:8]}",
            "base_image": env.base_image or "debian:12-slim",
            "setup_commands": [
                f"pip install {' '.join(env.dependencies)}",
            ],
            "files": {
                "environment.py": env.environment_code,
                "entrypoint.sh": f"#!/bin/bash\npython {env.entry_point}\n",
            },
            "exposed_ports": [],  # Most AI environments don't expose ports
        }
```

---

### 14.2 MCP (Model Context Protocol) Server

**Strategic Rationale:** MCP is emerging as the standard protocol for AI assistants to interact with external tools. By exposing Eden as an MCP server, **any AI assistant (Claude, Cursor, Copilot, custom agents) can trigger environment generation directly** without writing any code.

**Why this is a game-changer:**
1. A developer is in Claude Desktop planning a project
2. They need a test environment for their agent idea
3. They type: "Generate a multi-agent trading environment to test my RL agent"
4. Claude calls Eden via MCP → environment is generated in seconds
5. Result comes back: quality score, test results, export links
6. Developer clicks to export to Langfuse — done

**Implementation:**

```python
# /src/eden/integration/mcp_server.py
# Uses FastMCP for building the MCP server

from fastmcp import FastMCP

# Create MCP server
mcp = FastMCP("Eden Environment Generator")

@mcp.tool()
async def generate_environment(
    description: str,
    tags: list[str] = [],
    language: str = "python",
) -> dict:
    """Generate an AI agent evaluation environment from a natural language description.

    Args:
        description: Detailed description of the environment to generate
        tags: Optional tags for categorization (e.g., ["multi-agent", "trading"])
        language: Target programming language (default: python)

    Returns:
        dict containing environment details, quality score, and export links
    """
    # Trigger Eden's pipeline
    job = await eden_client.create_job(
        description=description,
        tags=tags,
        language=language,
    )

    # Wait for completion (or return job_id for async follow-up)
    result = await eden_client.wait_for_completion(job.job_id)

    return {
        "job_id": result.job_id,
        "description": result.description,
        "quality_score": result.quality_score,
        "language": result.language,
        "test_pass_rate": result.test_results.pass_rate,
        "adversarial_findings": len(result.adversarial_findings),
        "export_links": result.export_formats,
        "deploy_links": result.deploy_targets,
    }

@mcp.tool()
async def list_environments(
    limit: int = 10,
    tags: list[str] = [],
    min_quality: float = 0.0,
) -> list[dict]:
    """List previously generated environments.

    Args:
        limit: Maximum number of environments to return
        tags: Filter by tags
        min_quality: Minimum quality score filter (0.0-1.0)

    Returns:
        List of environment summaries
    """
    envs = await eden_client.list_environments(
        limit=limit,
        tags=tags,
        min_quality=min_quality,
    )
    return [{
        "job_id": env.job_id,
        "description": env.description[:100],
        "quality_score": env.quality_score,
        "created_at": env.created_at.isoformat(),
    } for env in envs]

@mcp.tool()
async def export_environment(
    job_id: str,
    targets: list[str],
) -> dict:
    """Export a generated environment to external platforms.

    Args:
        job_id: The job ID of the generated environment
        targets: Platforms to export to (e.g., ["langfuse", "langsmith"])

    Returns:
        Export results for each target
    """
    return await eden_client.export_environment(job_id, targets)

@mcp.resource("eden://environments/{job_id}")
async def get_environment(job_id: str) -> str:
    """Get the full environment report as a resource."""
    env = await eden_client.get_environment(job_id)
    return f"""
# Environment: {env.description}

## Quality Score: {env.quality_score:.2f}

### Test Results
- Pass Rate: {env.test_results.pass_rate:.2f}
- Tests: {env.test_results.passed}/{env.test_results.total} passed

### Exports
{env.export_formats}
    """

@mcp.resource("eden://metrics/summary")
async def get_metrics_summary() -> str:
    """Get a summary of Eden pipeline metrics."""
    metrics = await eden_client.get_pipeline_metrics()
    return f"""
# Eden Pipeline Summary

Total runs: {metrics.total_runs}
Avg quality: {metrics.avg_quality_score:.2f}
Avg duration: {metrics.avg_duration_ms}ms
Outcome distribution: {metrics.outcome_distribution}
    """

# Run the server
if __name__ == "__main__":
    # For stdio transport (local AI assistants):
    mcp.run(transport="stdio")

    # For SSE transport (remote/networked):
    # mcp.run(transport="sse", host="0.0.0.0", port=8000)
```

**What AI Assistants See:**

When a user is in Claude Desktop and says "generate a test environment for my agent," Claude calls:
1. `generate_environment(description=...)` → gets environment
2. `export_environment(job_id=..., targets=["langfuse"])` → exports to Langfuse
3. Presents the user with the quality score and export links

**All without the user writing a single line of code.**

---

### 14.3 IDE Extensions — VSCode & Cursor

**Strategic Rationale:** Developers spend most of their time in their IDE. An Eden extension for VSCode/Cursor allows them to generate environments without leaving the editor — reducing friction to zero.

**Implementation (VSCode Extension):**

```typescript
// src/extension.ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Register the "Generate Environment" command
    const generateCommand = vscode.commands.registerCommand(
        'eden.generateEnvironment',
        async () => {
            // Show input for environment description
            const description = await vscode.window.showInputBox({
                prompt: 'Describe the environment you want to generate',
                placeHolder: 'e.g., "multi-agent trading environment with 3 agents and order-book dynamics"',
                validateInput: (text) => text.length < 10 ? 'Please be more descriptive' : null,
            });

            if (!description) return;

            // Show progress
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Eden: Generating environment...',
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {
                    // Cancel the generation
                });

                // Call Eden's API
                const apiKey = await getApiKey(context);
                const result = await callEdenApi('/api/v1/environments/generate', {
                    description,
                    tags: ['vscode-generated'],
                });

                progress.report({ message: 'Environment generated!' });

                // Show results in a webview
                const panel = vscode.window.createWebviewPanel(
                    'edenResult',
                    `Eden: ${result.description.slice(0, 30)}...`,
                    vscode.ViewColumn.Beside,
                    { enableScripts: true }
                );

                panel.webview.html = getResultWebview(result);

                // Ask if user wants to insert code into current file
                const insert = await vscode.window.showInformationMessage(
                    `Eden: Quality score ${result.quality_score.toFixed(2)}. Insert environment code?`,
                    'Insert code',
                    'Preview in editor',
                    'Export to Langfuse'
                );

                if (insert === 'Insert code') {
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, result.environment_code);
                        });
                    }
                } else if (insert === 'Export to Langfuse') {
                    await callEdenApi(`/api/v1/environments/${result.job_id}/export`, {
                        targets: ['langfuse'],
                    });
                    vscode.window.showInformationMessage('Exported to Langfuse!');
                }
            });
        }
    );

    // Register TreeView for recent environments
    const treeProvider = new EdenEnvironmentsProvider(context);
    vscode.window.registerTreeDataProvider('edenEnvironments', treeProvider);

    // Status bar button
    const statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBar.text = "$(rocket) Eden";
    statusBar.command = 'eden.generateEnvironment';
    statusBar.tooltip = 'Generate an AI environment with Eden';
    statusBar.show();

    context.subscriptions.push(generateCommand);
}

function getResultWebview(result: any): string {
    return `<!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: -apple-system, sans-serif; padding: 16px; }
            .score { font-size: 24px; font-weight: bold; }
            .metric { margin: 8px 0; }
            .pass { color: #4caf50; }
            .fail { color: #f44336; }
        </style>
    </head>
    <body>
        <h2>🏗️ Environment Generated</h2>
        <p>${result.description}</p>

        <div class="metric">
            <strong>Quality Score:</strong>
            <span class="score">${(result.quality_score * 100).toFixed(0)}%</span>
        </div>
        <div class="metric">
            <strong>Test Pass Rate:</strong>
            <span class="${result.test_results.pass_rate > 0.8 ? 'pass' : 'fail'}">
                ${(result.test_results.pass_rate * 100).toFixed(0)}%
            </span>
        </div>
        <div class="metric">
            <strong>Language:</strong> ${result.language}
        </div>
        <div class="metric">
            <strong>Job ID:</strong> <code>${result.job_id}</code>
        </div>

        <h3>Exports</h3>
        <ul>
            ${Object.entries(result.export_formats || {})
                .map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`)
                .join('')}
        </ul>
    </body>
    </html>`;
}
```

**Cursor-Specific Integration:**

For Cursor, the extension works out of the box (Cursor is a VSCode fork). Additionally, Eden can provide `.cursor/rules` files:

```markdown
# .cursor/rules/eden-environment-generation.mdc
---
description: When the user asks to generate an AI evaluation environment, use Eden
globs: *.py, *.md, *.yaml
---

When the user needs an AI evaluation environment, testing environment, or agent sandbox:

1. Use the Eden MCP server or API to generate the environment
2. Present the quality score, test results, and export links
3. Ask if they want to:
   - Insert the code into the current file
   - Export to Langfuse/LangSmith for evaluation
   - Deploy to Runloop/E2B for testing
```

---

### 14.4 Kubernetes Deployment — Helm Chart

**Strategic Rationale:** Enterprise customers require self-hosted deployments on their own infrastructure. A Helm chart makes Eden deployable on any Kubernetes cluster with one command.

**Implementation:**

```yaml
# helm/eden/Chart.yaml
apiVersion: v2
name: eden
description: Eden — AI-native environment generation platform
type: application
version: 0.1.0
appVersion: "0.1.0"
dependencies:
  - name: postgresql
    version: "~15.0"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled
  - name: qdrant
    version: "~1.0"
    repository: https://qdrant.github.io/qdrant-helm
    condition: qdrant.enabled
```

```yaml
# helm/eden/values.yaml
# Default values for Eden Helm chart

replicaCount: 2

image:
  repository: edenai/eden
  tag: latest
  pullPolicy: Always

config:
  debug: false
  environment: production

  # JWT secret (MUST be overridden)
  jwtSecret: ""

  # Database
  postgres:
    host: ""
    port: 5432
    database: eden
    username: eden
    existingSecret: ""

  # Vector store
  qdrant:
    host: ""
    port: 6333
    grpcPort: 6334

  # LLM configuration
  llm:
    provider: openrouter
    apiKeyExistingSecret: ""

  # Integration settings
  integrations:
    langfuse:
      enabled: false
    langsmith:
      enabled: false
    wandb:
      enabled: false
    runloop:
      enabled: false
    e2b:
      enabled: false

  # Webhook settings
  webhook:
    secret: ""

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: eden.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: eden-tls
      hosts:
        - eden.example.com

resources:
  limits:
    cpu: 4
    memory: 8Gi
  requests:
    cpu: 2
    memory: 4Gi

# Database migrations run as a Helm pre-install hook
migrations:
  enabled: true
  image:
    repository: edenai/eden-migrations
    tag: latest
```

```yaml
# helm/eden/templates/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "eden.fullname" . }}-migrations
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrations
          image: "{{ .Values.migrations.image.repository }}:{{ .Values.migrations.image.tag }}"
          env:
            - name: POSTGRES_DSN
              valueFrom:
                secretKeyRef:
                  name: {{ include "eden.postgres.secret" . }}
                  key: dsn
          command:
            - alembic
            - upgrade
            - head
```

**Database Migration Pattern (Industry Standard):**

```yaml
# The migration job runs BEFORE the application deploys
# If migration fails, Helm keeps the old version running
# This prevents data inconsistency
```

**User Experience:**

```bash
# One-command deploy
helm repo add eden https://helm.eden.sh
helm install eden eden/eden \
  --set config.jwtSecret="$(openssl rand -base64 32)" \
  --set ingress.hosts[0].host="eden.mycompany.com"

# Or with external databases
helm install eden eden/eden \
  --set postgresql.enabled=false \
  --set config.postgres.host="my-rds.amazonaws.com" \
  --set config.qdrant.host="my-qdrant-cluster.com"
```

---

### 14.5 Notifications & Collaboration

**Strategic Rationale:** Users need to know when environments complete, when quality drops, or when critical adversarial findings surface. Notifications close the loop between environment generation and team awareness.

**Design:**

```python
# /src/eden/integration/notifications.py

class NotificationService:
    """Sends notifications about pipeline events to various channels.

    Supports:
    - Slack (Block Kit)
    - Discord (Embeds)
    - Email (SMTP)
    - PagerDuty (Events API v2)
    - Generic Webhooks (HMAC-signed)
    """

    def __init__(self):
        self.channels: dict[str, NotificationChannel] = {
            "slack": SlackChannel(),
            "discord": DiscordChannel(),
            "email": EmailChannel(),
            "pagerduty": PagerDutyChannel(),
            "webhook": GenericWebhookChannel(),
        }

    async def notify_environment_complete(self, env: EnvironmentReport):
        """Send notification when an environment is generated."""
        title = f"🏗️ Environment Generated: {env.description[:60]}"
        quality_bar = self._quality_bar(env.quality_score)

        message = {
            "title": title,
            "fields": [
                {"name": "Quality Score", "value": f"{quality_bar} {env.quality_score:.2f}", "short": True},
                {"name": "Test Pass Rate", "value": f"{env.test_results.pass_rate:.1%}", "short": True},
                {"name": "Duration", "value": f"{env.duration_ms / 1000:.1f}s", "short": True},
                {"name": "Language", "value": env.language, "short": True},
                {"name": "Adversarial Findings", "value": str(len(env.adversarial_findings)), "short": True},
            ],
            "color": self._severity_color(env.quality_score),
            "actions": [
                {"text": "View in Eden", "url": f"{settings.base_url}/jobs/{env.job_id}"},
                {"text": "Export to Langfuse", "url": env.export_formats.get("langfuse", "")},
            ],
        }

        # Send to all configured channels
        for channel in self.channels.values():
            if channel.enabled:
                await channel.send(message)

    async def notify_critical_finding(self, finding: AdversarialFinding, env: EnvironmentReport):
        """Send alert when a critical adversarial finding is discovered.

        This is routed to PagerDuty for high-severity issues.
        """
        critical_message = {
            "title": f"🚨 Critical Finding: {finding.type}",
            "description": finding.description,
            "severity": "critical",
            "dedup_key": f"eden-{env.job_id}-{finding.type}",
            "actions": [
                {"text": "View Mitigation", "url": f"{settings.base_url}/jobs/{env.job_id}#findings"},
            ],
        }

        # Route to PagerDuty immediately
        await self.channels["pagerduty"].send(critical_message)

        # Also notify Slack with urgent formatting
        await self.channels["slack"].send({
            **critical_message,
            "color": "danger",
        })

    def _quality_bar(self, score: float, width: int = 10) -> str:
        """Generate a visual quality bar: ████████░░"""
        filled = int(score * width)
        return "█" * filled + "░" * (width - filled)
```

**Slack Block Kit Example:**

```python
class SlackChannel(NotificationChannel):
    """Sends notifications to Slack using Block Kit."""

    async def send(self, message: dict):
        blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": message["title"]}
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*{f['name']}:*\n{f['value']}"}
                    for f in message.get("fields", [])
                ]
            },
        ]

        # Add actions if present
        if message.get("actions"):
            blocks.append({
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": a["text"]},
                        "url": a["url"],
                    }
                    for a in message["actions"]
                ]
            })

        await self.webhook_client.send(blocks=blocks)
```

**Slack Notification Example:**

```
┌─────────────────────────────────────────────────────┐
│ 🏗️ Environment Generated: Multi-Agent Trading Env   │
│                                                     │
│ Quality Score: ████████░░ 0.82    Duration: 284.0s  │
│ Test Pass Rate: 96.0%              Language: python  │
│ Adversarial Findings: 1                              │
│                                                     │
│ [View in Eden] [Export to Langfuse]                 │
└─────────────────────────────────────────────────────┘
```

---

## 15. Extended Architecture: Cross-Layer Integration

### The Complete Integration Map

```
                         ┌──────────────────────────────┐
                         │         EDEN CORE             │
                         │  Environment Pipeline (17+)   │
                         └──────────┬───────────────────┘
                                    │
                                    ▼
                         ┌──────────────────────────────┐
                         │      ENVIRONMENT REPORT       │
                         │  (Universal Schema)           │
                         └──────────┬───────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                      │
              ▼                     ▼                      ▼
┌─────────────────────┐  ┌──────────────────┐  ┌────────────────────┐
│   EVALUATION EXPORT │  │ SANDBOX DEPLOY   │  │ DISCOVERY & OSS   │
│                     │  │                  │  │                    │
│ • Langfuse dataset  │  │ • Runloop Devbox │  │ • MCP Server       │
│ • LangSmith dataset │  │ • E2B Sandbox    │  │ • Registry API     │
│ • W&B Weave dataset │  │                  │  │                    │
│ • Maxim AI test run │  │                  │  │                    │
└─────────────────────┘  └──────────────────┘  └────────────────────┘
              │                     │                      │
              │                     │                      │
              ▼                     ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                     DATA INGESTION (Reverse Flow)                │
│                                                                  │
│  Langfuse results ──┐                                            │
│  LangSmith results ──┼──► CrossPlatformArchivist ──► Better Envs │
│  Runloop results ────┘                                            │
│  E2B results ────────┐                                           │
│  Custom (via API) ───┼──► KB augmentation ──► Next pipeline     │
│                       └              is better                   │
└──────────────────────────────────────────────────────────────────┘
```

### The Integration Moat

```
                          ┌──────────────────────┐
                          │    EDEN: Ecosystem    │
                          │    Intelligence Hub   │
                          └──────────────────────┘
                                   ▲
                  ┌────────────────┼────────────────┐
                  │                │                │
         ┌────────┴───┐   ┌───────┴────┐   ┌───────┴────┐
         │ Langfuse   │   │ Runloop    │   │ E2B        │
         │ users      │   │ users      │   │ users      │
         │ (eval)     │   │ (sandbox)  │   │ (sandbox)  │
         └────────────┘   └────────────┘   └────────────┘
                  │                │                │
                  └────────────────┼────────────────┘
                                   │
                          ┌────────▼────────┐
                          │    EDEN: The    │
                          │  Shared Layer   │
                          │  (only one!)    │
                          └─────────────────┘
```

Each platform's user base becomes Eden's potential user base. Each platform's evaluation results improve Eden's Archivist. No single platform can replicate this because they don't have access to each other's data.

---

## 16. Final Strategic Recommendations

### The 5-Way Integration Strategy

| # | Integration | Why It Matters | Effort | Impact | Timeline |
|---|---|---|---|---|---|
| 1 | **Langfuse + LangSmith Export** | Users see Eden traces in their existing eval dashboards | 1 week | 🔴 Critical | Week 1-2 |
| 2 | **MCP Server** | Any AI assistant can trigger environment generation | 3-4 days | 🔴 Critical | Week 3 |
| 3 | **E2B + Runloop Deployers** | Users can run environments in their preferred sandbox | 1 week | 🟡 High | Week 5-6 |
| 4 | **CLI Tool** | Generate environments from the terminal — no browser needed | 4-5 days | 🟡 High | Week 9 |
| 5 | **Notifications System** | Slack, Discord, PagerDuty alerts on pipeline events | 4-5 days | 🟡 Medium | Week 8 |

### The Compounding Advantage

```
Month 1: Environments export to Langfuse, LangSmith
         → Users discover Eden from their existing tools
         → "I already use Langfuse, and Eden exports there? Let me try it."

Month 2: E2B + Runloop deployers, Ingestion API live
         → Users run environments AND send results back
         → Archivist starts learning from cross-platform failures
         → "Eden's environments get better every week."

Month 3: MCP server, CLI tool, VSCode extension live
         → Zero-friction generation from anywhere
         → Terminal + IDE integration makes Eden part of daily workflow
         → "I can generate an environment from Claude, from my editor,
            from my terminal — it's everywhere."

Month 4+: Registry effects, cross-platform intelligence
         → More environments → more evaluations → better Archivist
         → Network effects kick in
         → Competitors can't catch up
```

### The Bottom Line

**Eden doesn't just generate environments. Eden connects the entire AI evaluation ecosystem.**

Langfuse, LangSmith, and W&B are the evaluation dashboards. Runloop and E2B are the sandboxes. Eden is the engine that generates what goes into all of them — AND the brain that learns from everything that comes out.

**Integrate with all of them. Own the shared layer. Become irreplaceable.**

---

## 17. Platform Features to Build — Beyond Integrations

> Integrations get users in the door. **Platform features make them stay.** This section covers the features Eden needs to build — not as integration points with other platforms, but as core capabilities that make Eden indispensable on its own merits.

### 17.1 Pipeline Intelligence & Performance

#### 17.1.1 Pipeline Caching (DAG-Aware)

**Problem:** Eden's pipeline can run 17+ agents. Re-running all of them when only one thing changed is wasteful and slow.

**Solution:** Implement DAG-aware caching that skips agents whose inputs haven't changed.

```python
# /src/eden/pipeline/cache.py

class PipelineCache:
    """DAG-aware cache for the Eden pipeline.

    Cache keys are constructed from the agent's position in the DAG,
    its inputs, and the hash of its upstream dependencies. If nothing
    changed, the cached output is returned without calling the LLM.
    """

    cache_store: Redis | PostgresCache

    def _build_cache_key(self, agent: str, inputs: dict, upstream_hash: str) -> str:
        """Build a deterministic cache key for an agent invocation."""
        content = f"{agent}:{json.dumps(inputs, sort_keys=True)}:{upstream_hash}"
        return f"eden:cache:{hashlib.sha256(content.encode()).hexdigest()}"

    def _build_upstream_hash(self, agent_results: dict[str, str]) -> str:
        """Hash all upstream agent results to detect cascading changes."""
        sorted_results = sorted(agent_results.items())
        combined = "|".join(f"{k}={v}" for k, v in sorted_results)
        return hashlib.sha256(combined.encode()).hexdigest()

    async def get_cached_result(self, agent: str, inputs: dict,
                                 upstream_hash: str) -> Optional[dict]:
        """Get cached result if it exists and is still valid."""
        key = self._build_cache_key(agent, inputs, upstream_hash)
        cached = await self.cache_store.get(key)
        if cached:
            logger.info(f"Cache HIT for {agent}")
            return json.loads(cached)
        logger.info(f"Cache MISS for {agent}")
        return None

    async def set_cached_result(self, agent: str, inputs: dict,
                                 upstream_hash: str, result: dict, ttl: int = 3600):
        """Cache an agent's output for future reuse."""
        key = self._build_cache_key(agent, inputs, upstream_hash)
        await self.cache_store.set(key, json.dumps(result), ex=ttl)
```

**Cache hit rates by agent type (estimated):**

| Agent | Typical Cache Hit Rate | Notes |
|---|---|---|
| Planner | Low (10-20%) | Every new description is different |
| Critic | Medium (40-60%) | Same floorplan → same critique |
| Executor | Low (20-30%) | Code generation varies with spec |
| Tester | High (80-90%) | Same code → same test results |
| Verifier | High (70-85%) | Same code + tests → same verification |
| Adversarial | Medium (50-70%) | Same code → similar exploit surface |
| Archivist | High (90%+) | Same findings → same KB updates |

#### 17.1.2 Parallel Agent Execution

**Problem:** Agents in the pipeline run sequentially. Independent agents should run in parallel.

**Solution:** The pipeline DAG already encodes dependencies. Agents with no dependency on each other can execute concurrently:

```python
# Pipeline DAG showing parallel execution opportunities:

# Independent groups (run in parallel):
# Group 1: Planner → Critic → Executor → Tester
# Group 2: [No dependencies on Group 1 — runs in parallel]
# Group 3: [No dependencies on Group 1 or 2 — runs in parallel]
# Group 4: Verifier (depends on Tester + Code Quality)
# Group 5: Archivist (depends on all above)

# In practice, most agents are sequential (each depends on the previous),
# but key parallelization opportunities exist:
# - Code Quality scan can run in parallel with Tester
# - Adversarial Tester can start once Executor output is stable
```

**Implementation pattern:** Use `asyncio.gather()` or a task scheduler that resolves the DAG and dispatches ready nodes:

```python
class ParallelPipelineExecutor:
    """Executes pipeline agents respecting DAG dependencies with parallelism."""

    async def execute_dag(self, dag: PipelineDAG) -> dict[str, Any]:
        results = {}
        ready = deque(dag.get_root_nodes())  # Nodes with no dependencies

        while ready:
            # Launch all ready nodes in parallel
            tasks = {node: self._execute_node(node, results) for node in ready}
            completed = await asyncio.gather(*tasks.values())

            # Update results and find newly ready nodes
            for node, result in zip(tasks.keys(), completed):
                results[node.name] = result
                dag.mark_completed(node)

            # Find next batch of ready nodes
            ready = deque(dag.get_ready_nodes(results.keys()))

        return results

    async def _execute_node(self, node: PipelineNode,
                             previous_results: dict) -> Any:
        logger.info(f"Executing agent: {node.name}")
        start = time.time()
        result = await node.agent.run(inputs=node.get_inputs(previous_results))
        elapsed = time.time() - start
        logger.info(f"Agent {node.name} completed in {elapsed:.2f}s")
        return result
```

**Estimated speedup:** 1.3x - 1.8x depending on DAG structure (modest, but meaningful for long-running pipelines).

#### 17.1.3 Interactive Pipeline Mode (Human-in-the-Loop)

**Problem:** The pipeline runs entirely autonomously. Users have no way to intervene when an agent makes a questionable decision.

**Solution:** Add checkpoint-based human-in-the-loop (HITL) mode where the pipeline pauses after specific agents and lets users review/approve/reject before proceeding:

```
Pipeline Flow with HITL:

[User describes environment]
        │
        ▼
[Planner generates floorplan] ─── CHECKPOINT: User reviews floorplan
        │                               │
        │  ┌─────────────────────────────┘
        │  │ Approve? Edit? Reject?
        ▼  ▼
[Critic reviews floorplan]
        │
        ▼
[Executor generates code] ─── CHECKPOINT: User reviews generated code
        │                               │
        │  ┌─────────────────────────────┘
        │  │ Approve? Request changes?
        ▼  ▼
[Tester runs test suite]
        │
        ▼
[Verifier + Adversarial] ─── CHECKPOINT: User reviews findings
        │
        ▼
[Environment Complete]
```

**Checkpoint API:**

```python
@router.post("/jobs/{job_id}/checkpoints/{checkpoint_id}/approve")
async def approve_checkpoint(
    job_id: str,
    checkpoint_id: str,
    modifications: Optional[dict] = None,  # User can suggest edits
):
    """Approve a pipeline checkpoint and continue execution.

    Optionally, users can provide modifications:
    - For Planner: modified floorplan or requirements
    - For Executor: modified code or instructions
    """
    checkpoint = await get_checkpoint(job_id, checkpoint_id)
    if modifications:
        await checkpoint.apply_modifications(modifications)
    await checkpoint.resume()
    return {"status": "resumed", "checkpoint_id": checkpoint_id}


@router.post("/jobs/{job_id}/checkpoints/{checkpoint_id}/reject")
async def reject_checkpoint(
    job_id: str,
    checkpoint_id: str,
    feedback: str,
):
    """Reject a pipeline checkpoint and provide feedback for regeneration."""
    checkpoint = await get_checkpoint(job_id, checkpoint_id)
    await checkpoint.reject(feedback)
    return {"status": "rejected", "checkpoint_id": checkpoint_id}
```

#### 17.1.4 Pipeline Versioning & History

**Problem:** Every pipeline run produces a new environment. Users can't compare iterations or track changes over time.

**Solution:** Version the pipeline and environment outputs, exposing a diff interface:

```
GET /api/v1/environments/{id}/versions

{
  "versions": [
    {
      "version": 5,
      "created_at": "2026-05-29T14:30:00Z",
      "quality_score": 0.92,
      "outcome_tier": "platinum",
      "changes": "Improved reward function, added edge case tests",
      "trigger": "user_requested_improvement"
    },
    {
      "version": 4,
      "created_at": "2026-05-28T10:00:00Z",
      "quality_score": 0.85,
      "outcome_tier": "gold",
      "changes": "Fixed termination condition bug",
      "trigger": "adversarial_finding_patch"
    },
    {
      "version": 3,
      "created_at": "2026-05-27T16:45:00Z",
      "quality_score": 0.72,
      "outcome_tier": "silver",
      "changes": "Added multi-agent support",
      "trigger": "user_requested_improvement"
    },
    ...
  ]
}
```

**What users gain:**
- History of how an environment improved over time
- Ability to roll back to a previous version
- Quality score trends per environment
- Understanding of which changes impacted quality most

---

### 17.2 Environment Quality & Debugging

#### 17.2.1 Environment Comparison (Side-by-Side)

**Problem:** Users have multiple environments. No way to compare them.

**Solution:** Comparison view showing two environments side by side:

```
┌─────────────────────────────────────────────────────────────┐
│  Environment Compare: v3 vs v5                              │
│                                                             │
│  Metric          v3 (gold)    v5 (platinum)    Δ           │
│  ─────────────────────────────────────────────────────      │
│  Quality Score   0.85          0.92            +0.07 ▲     │
│  Test Pass Rate  92.0%         98.0%           +6.0% ▲     │
│  Tests           42/48         48/50            +6/+2 ▲     │
│  Adversarial     3 findings    1 finding        -2    ▲     │
│  Code Complexity 8.2           7.1             -1.1   ▲     │
│  Lines of Code   482           521              +39         │
│  LLM Cost        $0.84         $1.12           +$0.28      │
│  Duration        312s          284s             -28s   ▲     │
│                                                             │
│  Code changes:                                              │
│  ┌────────────────────┬──────────────────────────────────┐  │
│  │ v3: environment.py │ v5: environment.py               │  │
│  │                    │                                  │  │
│  │ def reset():       │ def reset():                     │  │
│  │     self.balances  │     self.balances = [10000]*3    │  │
│  │     = [10000]*3    │     self.history.append({...})   │  │
│  └────────────────────┴──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

#### 17.2.2 Quality Score Explainability

**Problem:** Users see a quality score but don't know WHY it's that value. This erodes trust.

**Solution:** Break down every quality score with an explanation:

```python
class QualityExplanation(BaseModel):
    """Human-readable explanation of an environment's quality score."""

    overall_score: float
    breakdown: dict[str, float]

    explanations: list[ScoreFactor]  # Ordered by impact

    top_improvements: list[str]  # "What to fix first"
    top_strengths: list[str]    # "What's working well"


class ScoreFactor(BaseModel):
    """A single factor contributing to the quality score."""

    metric: str                  # "test_coverage"
    impact: float                # -0.12 (how much it pulled score down)
    detail: str                  # "Only 68% of code paths are tested"
    suggestion: str              # "Add tests for edge cases in handle_trade()"
    severity: str                # "high", "medium", "low"
```

**Display in UI:**

```
Quality Score: 0.82 ────████████░░──

What's hurting the score:
  • Test Coverage (−0.12): Only 68% coverage. Add tests for handle_trade()
  • Code Quality (−0.05): 3 functions have cyclomatic complexity > 15
  • Documentation (−0.03): Missing docstrings in 4 public methods

What's helping the score:
  • Adversarial Robustness (+0.08): Passed 9/10 exploit probes
  • Performance (+0.04): Environment resets in <50ms

Top recommendations:
  1. Add tests for edge cases in handle_trade() — biggest impact
  2. Refactor validate_order() to reduce complexity from 18 to <10
  3. Add docstrings to OrderBook, TradeExecutor, and Portfolio classes
```

#### 17.2.3 In-Browser Environment Testing

**Problem:** Users can't interact with generated environments without downloading and running them.

**Solution:** An in-browser sandbox (using Pyodide/WebAssembly or a secure backend sandbox) where users can run the environment directly:

```
┌─────────────────────────────────────────────────────────────┐
│  Environment: Multi-Agent Trading (v5)                      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Code                         │  Output              │   │
│  │                                │                      │   │
│  │  from trading_env import      │  >>> env = TradingEnv│   │
│  │      TradingEnv               │  >>> obs = env.reset │   │
│  │                                │  Market: BULLISH     │   │
│  │  env = TradingEnv()           │  Portfolio:          │   │
│  │  obs = env.reset()            │    Agent 1: $10,000  │   │
│  │  action = {                   │    Agent 2: $10,000  │   │
│  │      "agent_1": {"buy": 100}, │    Agent 3: $10,000  │   │
│  │      "agent_2": {"sell": 50}, │                      │   │
│  │      "agent_3": {"hold": 0}   │  >>> env.step(action)│   │
│  │  }                            │  Agent 1 bought 100  │   │
│  │  obs, reward, done, info      │  Agent 2 sold 50     │   │
│  │      = env.step(action)       │  Reward: +1,245.50   │   │
│  │                                │                      │   │
│  │  [▶ Run] [↺ Reset] [📋 Copy]  │                      │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### 17.2.4 Code Preview with Syntax Highlighting

The portal already has some code display. Enhance it with:

- Line-by-line quality annotations (why each section scored how it did)
- Clickable test coverage gaps
- Adversarial finding inline markers
- One-click "fix this" for common issues
- Collapsible sections (imports, helper classes, core logic)

---

### 17.3 Developer Experience (DX)

#### 17.3.1 CLI Tool (`eden`)

The most impactful DX investment. A CLI that matches the power of the web portal from the terminal.

**Design:**

```
eden — AI-native environment generation from the command line

USAGE:
  eden [command] [options]

COMMANDS:
  generate      Generate a new environment from a description
    --desc, -d    Description of the environment (or use stdin)
    --tags, -t    Comma-separated tags
    --lang, -l    Target language (default: python)
    --output, -o  Output directory (default: ./eden-output)
    --wait, -w    Wait for completion (default: true)
    --quality     Minimum quality score to accept (fail if below)

  export        Export an environment to evaluation platforms
    --target, -t  Platform(s): langfuse, langsmith, wandb, runloop, e2b
    --job, -j     Job ID to export
    --all         Export to all configured platforms

  deploy        Deploy environment to a sandbox
    --target, -t  Sandbox: runloop, e2b
    --job, -j     Job ID to deploy

  list, ls      List generated environments
    --limit, -l   Max results (default: 10)
    --tags, -t    Filter by tags
    --min-quality Filter by minimum quality score

  compare       Compare two environments
    --a, --b      Job IDs to compare

  test          Test an environment locally
    --job, -j     Job ID to test
    --local       Run tests locally (requires Python)

  config        Configure Eden CLI
    init          Initialize with API key
    show          Show current configuration
    set           Set a configuration value

  status        Show pipeline and account status
    --json        Output as JSON (for scripting)

EXAMPLES:
  eden generate -d "multi-agent trading env with order-book" -t "trading,multi-agent"
  eden generate -d "$(cat spec.txt)" -t ci-generated --quality 0.8
  eden export -j abc123 -t langfuse,langsmith
  eden list --min-quality 0.9 --limit 20
  eden compare --a abc123 --b def456
  eden config init
```

**CLI UX principles:**

1. **Zero-config for basic use:** `eden generate -d "my env"` just works
2. **Piped input:** `cat spec.md | eden generate`
3. **Rich output:** Colored output with spinners, progress bars, quality scores displayed as bars
4. **JSON mode:** `--json` flag for scripting
5. **Config file:** `~/.eden/config.yaml` (YAML for human readability)
6. **Auto-completion:** `eden completion` generates bash/zsh completions

**Implementation plan:**

| Step | What | Time |
|---|---|---|
| 1 | Skeleton with `generate`, `list`, `config` commands | 2 days |
| 2 | `export`, `deploy` commands | 1 day |
| 3 | `compare`, `test` commands | 1 day |
| 4 | Rich output, spinners, JSON mode | 1 day |
| 5 | Auto-completion, documentation | 1 day |

#### 17.3.2 Local Development Mode

**Problem:** Every environment generation requires a round-trip to the cloud. Users can't iterate quickly.

**Solution:** A local mode where the pipeline runs on the user's machine:

```
# After running `eden config init`:
eden generate -d "simple gridworld" --local

# This runs a local Eden pipeline using:
# - SQLite instead of PostgreSQL (for state)
# - Local embeddings model (sentence-transformers) instead of Qdrant
# - User's configured LLM provider (OpenRouter, etc.)
# - File-based KB instead of PostgreSQL

# Output: ./eden-output/simple-gridworld-abc123/
#   - environment.py
#   - tests.py
#   - requirements.txt
#   - report.json (full EnvironmentReport)
```

**Local mode limitations:**
- No parallel agent execution (sequential only)
- Limited KB (recent 100 entries cached locally)
- No adversarial tester (too expensive locally)
- Quality scores may vary from cloud mode

#### 17.3.3 Environment Templates & Starter Kits

**Problem:** Every generation starts from scratch. Common patterns should be reusable.

**Solution:** A template system:

```
eden generate -t "multi-agent-trading" --vars "agents=3,order_book=limit"
eden generate -t "gridworld" --vars "size=10x10,obstacles=random"
eden generate -t "custom" -d "my custom env"  # Full pipeline

# Built-in templates:
# - gridworld: Classic gridworld with customizable size and obstacles
# - trading: Multi-agent trading with configurable order book
# - chatbot: Dialog evaluation environment
# - tool-use: Function-calling test environment
# - rag: RAG pipeline evaluation environment
# - agent-benchmark: SWE-bench style code task environment
```

**Template format:**

```yaml
# /templates/multi-agent-trading/template.yaml
name: multi-agent-trading
description: Multi-agent trading environment with configurable order book
version: 1.0.0

variables:
  agents:
    type: integer
    default: 2
    min: 1
    max: 10
    description: Number of trading agents
  order_book:
    type: string
    default: limit
    enum: [limit, market, hybrid]
    description: Type of order book

pipeline_hints:
  skip_planner: true  # Template has a fixed floorplan
  skip_critic: true
  executor_prompt_template: |
    Generate a multi-agent trading environment with {agents} agents
    using a {order_book} order book. The environment should...

quality_expectations:
  min_score: 0.75
  critical_checks:
    - All agents must have unique IDs
    - Order book must support {order_book} orders
    - Environment must support at least {agents} concurrent agents
```

#### 17.3.4 Import Existing Environments

**Problem:** Users have existing environments written by hand. They can't benefit from Eden's pipeline without rewriting everything.

**Solution:** An `import` command that reverse-engineers existing code:

```
eden import ./my_environment.py --name "my-env" --framework gymnasium

# This:
# 1. Analyzes the code to understand the environment structure
# 2. Generates tests by running the environment and recording interactions
# 3. Runs the adversarial tester on the existing code
# 4. Produces a quality report for the existing environment
# 5. Generates an EnvironmentReport with improvement suggestions
# 6. Optionally creates an Eden job that improves the environment
```

**Reverse-engineering capabilities:**

| Code Pattern | Eden Detects |
|---|---|
| `class MyEnv:` with `reset()`/`step()` | RL environment structure |
| `def reset(): return observation` | Observation space |
| `def step(action): return obs, reward, done, info` | Action/observation spaces |
| `@dataclass` config classes | Configuration structure |
| `import gymnasium` | Gymnasium compatibility |
| `import numpy as np` | Numerical observation space |
| `if __name__ == '__main__':` | Entry point detection |
| `try/except` blocks | Error handling coverage |

---

### 17.4 Team Collaboration

#### 17.4.1 Shared Workspaces

**Problem:** Every user has their own view of environments. Teams can't share or discover each other's environments.

**Solution:** Org-level workspaces where all team members see shared environments:

```
/org/{org_id}/environments
├── shared/                    # Everyone in org sees these
│   ├── trading-env-v3         # Quality: 0.92 | by @alice
│   ├── gridworld-baseline     # Quality: 0.88 | by @bob
│   └── rag-eval-suite         # Quality: 0.85 | by @charlie
├── team-ml/                   # ML team only
│   ├── rl-training-env        # Quality: 0.91 | by @alice
│   └── reward-model-env       # Quality: 0.79 | by @dave
└── personal/                  # Private to each user
    ├── @alice/
    │   └── experimental-v1    # Quality: 0.45 | WIP
    └── @bob/
        └── sandbox-test       # Quality: 0.62 | WIP
```

**Workspace features:**
- Browse all environments in the org
- Filter by creator, quality, tags, language
- Fork an existing environment as a starting point
- Star/bookmark frequently used environments
- Activity feed showing new environments, quality changes, comments

#### 17.4.2 Environment Review & Approval Workflows

**Problem:** Teams need a process for reviewing environments before they become shared standards.

**Solution:** A lightweight review workflow:

```
Status flow:

[Draft] ──► [Submitted for Review] ──► [Approved] ──► [Published]
                │                              │
                ▼                              ▼
            [Rejected]                    [Archived]
         (with feedback)              (withdrawn from use)
```

**Review features:**
- Request review from specific team members
- Reviewer sees quality metrics, adversarial findings, code diff
- Comments attach to specific lines of code
- Approval requires configurable number of reviewers
- Approved environments get a badge: "Org Standard: Trading Env v3"
- Webhook/Slack notification on review requests

```python
# POST /api/v1/environments/{id}/review/submit
{
    "reviewers": ["user_id_1", "user_id_2"],
    "notes": "Please review the reward function changes",
    "required_approvals": 2
}

# POST /api/v1/environments/{id}/review/approve
{
    "reviewer_id": "user_id_1",
    "comment": "LGTM. Reward function looks solid."
}

# POST /api/v1/environments/{id}/review/reject
{
    "reviewer_id": "user_id_2",
    "reason": "Adversarial test for reward hacking failed",
    "suggestions": "Consider adding reward shaping penalty"
}
```

#### 17.4.3 Team Permissions & Roles

```
Roles in an org:

| Role | Environments | Settings | Billing | Members | Integrations |
|---|---|---|---|---|---|
| Admin | Full control | Full | Full | Manage | Manage |
| Developer | Create, edit, export | View | View | View | View |
| Reviewer | View, comment, approve | View | None | View | View |
| Viewer | View only | None | None | View | None |
| External | View shared links only | None | None | None | None |
```

---

### 17.5 Security & Governance

#### 17.5.1 Role-Based Access Control (RBAC)

**Problem:** Currently no permission model. Any authenticated user can access anything.

**Solution:** Fine-grained RBAC:

```python
# Permission model
PERMISSIONS = {
    "environment:create": ["admin", "developer"],
    "environment:read": ["admin", "developer", "reviewer", "viewer"],
    "environment:edit": ["admin", "developer"],
    "environment:delete": ["admin"],
    "environment:export": ["admin", "developer"],
    "environment:deploy": ["admin", "developer"],
    "environment:approve": ["admin", "reviewer"],
    "org:settings:read": ["admin", "developer"],
    "org:settings:edit": ["admin"],
    "org:billing:read": ["admin"],
    "org:billing:edit": ["admin"],
    "org:members:manage": ["admin"],
    "integration:manage": ["admin"],
    "kb:query": ["admin", "developer", "reviewer"],
    "kb:edit": ["admin"],
    "audit:read": ["admin"],
}
```

#### 17.5.2 Environment Compliance Scanning

**Problem:** Generated environments may have compliance issues (license violations, prohibited dependencies, data handling issues).

**Solution:** Compliance scanning as part of the pipeline:

```
Compliance scan results:

✓ License check: All dependencies are MIT/BSD/Apache-2.0 compatible
✓ Dependency scan: 0 known CVEs in 12 dependencies
✗ Data handling: Environment logs user actions — add GDPR notice
✓ Output validation: No PII patterns detected in environment code
✓ Network policy: Environment has no egress (safe for sandboxing)
```

**Scanner modules:**

| Scanner | What It Checks |
|---|---|
| License Scanner | All dependencies have compatible licenses |
| Vulnerability Scanner | Check dependencies against CVE database |
| PII Scanner | Detect hardcoded credentials, emails, API keys |
| Network Scanner | Ensure environment doesn't make unexpected connections |
| Data Flow Scanner | Check how user data is handled and stored |
| Code Quality Scanner | Detect unsafe eval(), exec(), shell=True usage |

#### 17.5.3 Audit Trails

**Problem:** No record of who did what and when. Compliance and debugging suffer.

**Solution:** Immutable audit log for all operations:

```
GET /api/v1/org/{org_id}/audit?limit=10

[
  {
    "timestamp": "2026-05-29T14:30:00Z",
    "actor": "alice@example.com",
    "action": "environment.export",
    "resource": "job_abc123",
    "details": {"targets": ["langfuse", "langsmith"]},
    "ip_address": "203.0.113.42"
  },
  {
    "timestamp": "2026-05-29T14:28:00Z",
    "actor": "bob@example.com",
    "action": "environment.approve",
    "resource": "job_def456",
    "details": {"review_id": "rev_789", "comment": "LGTM"}
  },
  {
    "timestamp": "2026-05-29T14:25:00Z",
    "actor": "charlie@example.com",
    "action": "org.settings.update",
    "resource": "org_42",
    "details": {"changed": ["sso_enabled", "max_env_quality_threshold"]}
  }
]
```

#### 17.5.4 Data Residency Controls

**Problem:** Enterprise customers require data to stay in specific geographic regions.

**Solution:** Regional deployment options:

```
Available regions:
  - US East (us-east-1)
  - EU Central (eu-central-1) — GDPR compliant
  - Asia Pacific (ap-southeast-1)

Data is pinned to the selected region:
  - All PostgreSQL data stays in-region
  - All Qdrant vector embeddings stay in-region
  - All environment code and reports stay in-region
  - Export targets must be in-region or explicitly approved

Region is configured at org creation and cannot be changed.
```

---

### 17.6 Analytics & Insights

#### 17.6.1 Pipeline Performance Dashboard

```
┌─────────────────────────────────────────────────────────────────────┐
│  Pipeline Performance                          Last 30 days          │
│                                                                     │
│  Total Runs: 1,523                              Avg Duration: 284s  │
│  Avg Quality: 0.87                              Total Cost: $2,847  │
│                                                                     │
│  Quality Trend ────────────────────────────────                      │
│  0.90 ┤                                    ╱╲                       │
│  0.85 ┤     ╱╲    ╱╲    ╱╲    ╱╲      ╱──╲ ╱                        │
│  0.80 ┤    ╱  ╲  ╱  ╲  ╱  ╲  ╱  ╲    ╱    ╲                         │
│  0.75 ┤───╱    ╲╱    ╲╱    ╲╱    ╲──╱      ╲────                     │
│      └──────────────────────────────────────────                     │
│        05/01  05/05  05/10  05/15  05/20  05/25                      │
│                                                                     │
│  Agent Latency (p99)                      Agent Cost (avg)          │
│  ┌──────────────────────┐                ┌──────────────────────┐   │
│  │ Planner   12.3s ████ │                │ Planner   $0.12 ████ │   │
│  │ Executor  45.2s ████████████████       │ Executor  $0.45 █████████  │   │
│  │ Tester    30.0s ██████████             │ Tester    $0.18 ██████ │   │
│  │ Advers.   15.0s █████                 │ Advers.   $0.35 ███████████ │   │
│  └──────────────────────┘                └──────────────────────┘   │
│                                                                     │
│  Outcome Distribution:  ■ Platinum 12%  ■ Gold 34%                  │
│                         ■ Silver  38%  ■ Bronze 16%                 │
│                                                                     │
│  Common Failure Modes:                                              │
│  • test_failure: 45 occurrences (30% of failures)                   │
│  • quality_below_threshold: 28 occurrences (19%)                    │
│  • pipeline_timeout: 15 occurrences (10%)                           │
│  • llm_rate_limit: 12 occurrences (8%)                              │
│  • adversarial_critical: 8 occurrences (5%)                         │
└─────────────────────────────────────────────────────────────────────┘
```

#### 17.6.2 Quality Score Trends

```
GET /api/v1/metrics/quality-trends?period=90d&org=org_42

{
  "org_id": "org_42",
  "period_days": 90,
  "trend": "+0.08",  // Quality improving
  "avg_quality": 0.87,
  "total_environments": 523,
  "quality_by_language": {
    "python": 0.88,
    "typescript": 0.82,
    "rust": 0.91,
    "go": 0.79
  },
  "quality_by_framework": {
    "gymnasium": 0.91,
    "custom": 0.83,
    "battlecode": 0.87
  },
  "top_improvers": [
    {"user": "alice", "improvement": "+0.15", "environments": 42},
    {"user": "bob", "improvement": "+0.11", "environments": 38}
  ],
  "quality_over_time": [
    {"date": "2026-03-01", "avg": 0.79, "count": 45},
    {"date": "2026-04-01", "avg": 0.83, "count": 52},
    {"date": "2026-05-01", "avg": 0.87, "count": 48},
    {"date": "2026-05-29", "avg": 0.87, "count": 23}
  ]
}
```

#### 17.6.3 Cost Tracking & Budgeting

**Problem:** Users don't know what they're spending on LLM calls per environment.

**Solution:** Cost breakdown per environment and per org:

```
Environment Cost Breakdown: trading-env-v5

Agent           LLM Calls    Tokens (I/O)      Cost
────────────────────────────────────────────────────
Planner         3            12,400 / 3,200    $0.12
Critic          2            8,100 / 1,500     $0.08
Executor        5            45,200 / 12,800   $0.45
Tester          1            2,100 / 800       $0.02
Verifier        1            3,400 / 1,100     $0.03
Adversarial     4            38,200 / 9,400    $0.35
Optimizer       2            18,200 / 4,100    $0.18
────────────────────────────────────────────────────
Total           18           127,600 / 32,900  $1.23

Org Monthly Cost: $2,847
│
├── Environment Generation: $2,104 (74%)
├── Knowledge Base Queries: $423 (15%)
├── API Integrations:       $212 (7%)
└── Other:                  $108 (4%)

Budget: $5,000/month → Used: 57%
```

---

### 17.7 Knowledge Base & Storage

#### 17.7.1 KB Versioning & History

**Problem:** The Knowledge Base accumulates entries over time. Users can't see what changed or roll back.

**Solution:** Versioned KB with change tracking:

```
KB Version History:
v42 — 2026-05-29 (current)
  + Added 3 exploit patterns from adversarial tests
  + Linked 2 environments as "similar"
  - Pruned 5 stale entries (last accessed >90 days ago)

v41 — 2026-05-28
  + Added 1 cross-platform finding from Langfuse
  + Updated quality correlation score for trading envs

v40 — 2026-05-27
  + Imported 12 episode memories from benchmark runs
  - Pruned 8 entries (validated as duplicates)

API:
GET  /api/v1/kb/versions              # List versions
GET  /api/v1/kb/versions/v41/diff     # Show changes
POST /api/v1/kb/versions/v40/restore  # Rollback
```

#### 17.7.2 KB Export/Import

```
# Export KB for backup or migration
eden kb export --format json --output kb-backup-2026-05-29.json
eden kb export --format yaml --output kb-backup-2026-05-29.yaml

# Import KB (merge with existing)
eden kb import ./kb-backup.json --mode merge
eden kb import ./kb-from-other-org.yaml --mode replace

# Share specific KB entries
eden kb share --entries exploit_123,pattern_456 \
  --with "partner-org" --expires 7d
```

#### 17.7.3 Automatic KB Pruning

**Problem:** KB grows unbounded. Old entries degrade search quality.

**Solution:** Automatic pruning with configurable retention:

```python
class KBPruningPolicy(BaseModel):
    """Policy for automatic KB pruning."""

    # Retention by entry type
    episodic_retention_days: int = 30      # Episode memories expire fast
    semantic_retention_days: int = 90      # Semantic patterns last longer
    exploit_retention_days: int = 365      # Exploits kept for a year
    skill_retention_days: int = 365        # Skills retained long-term

    # Pruning triggers
    prune_when_size_exceeds_mb: int = 500  # Start pruning at 500MB
    prune_when_accuracy_drops_below: float = 0.85  # Prune to improve search

    # Manual overrides
    pinned_entries: list[str] = []         # Never prune these
    excluded_patterns: list[str] = []      # Never prune matching entries
```

---

### 17.8 Frontend / Portal Enhancements

#### 17.8.1 Real-Time Pipeline Visualization

**Problem:** Users wait minutes for pipelines with no visibility into progress.

**Solution:** A real-time DAG viewer showing which agents are running, completed, or waiting:

```


Agent Legend: [▶ Running] [✓ Done] [⏳ Waiting] [✗ Failed]

Pipeline: Multi-Agent Trading Environment (job_abc123) — 67% complete
Estimated time remaining: 1m 42s

                        ┌──────────┐
                 ┌──────│ Planner  │◄────── User Description
                 │      │  ✓ Done  │
                 │      └──────────┘
                 │           │
                 │           ▼
                 │      ┌──────────┐
                 │      │  Critic  │
                 │      │  ✓ Done  │
                 │      └──────────┘
                 │           │
                 │           ▼
                 │      ┌──────────┐
                 │      │ Executor │◄─── Currently running (32.4s)
                 │      │  ▶ 68%   │
                 │      └──────────┘
                 │         /    \
                 │        ▼      ▼
                 │  ┌────────┐ ┌────────────┐
                 │  │ Tester │ │ Code Qual. │◄─── Waiting
                 │  │ ⏳     │ │ ⏳         │
                 │  └────────┘ └────────────┘
                 │        │         │
                 │        ▼         ▼
                 │  ┌────────┐ ┌────────────┐
                 │  │Verifier│ │Adversarial │◄─── Waiting
                 │  │ ⏳     │ │ ⏳         │
                 │  └────────┘ └────────────┘
                 │        │         │
                 │        ▼         ▼
                 │  ┌─────────────────────┐
                 │  │    Archivist        │◄─── Waiting
                 │  │    ⏳               │
                 │  └─────────────────────┘
                 │           │
                 │           ▼
                 │  ┌─────────────────────┐
                 │  │  Environment Ready  │◄─── Next
                 │  └─────────────────────┘
```

**Implementation:** Server-sent events (SSE) from the backend, React flow visualization on the frontend.

#### 17.8.2 Pipeline Trace Explorer

**Problem:** Users want to inspect what each agent produced, not just the final environment.

**Solution:** A trace inspector that shows every agent's input, output, and intermediate state:

```
Pipeline Trace: job_abc123
─────────────────────────────────────────────────

Agent: Executor
─────────────────────────────────────────────────
Input Prompt (truncated):
  Generate a multi-agent trading environment with 3 agents and
  a limit order book. The environment should...

Output:
  ┌─────────────────────────────────────────────┐
  │ class TradingEnv:                           │
  │     def __init__(self, num_agents=3, ...):  │
  │         self.order_book = LimitOrderBook()  │
  │         self.agents = [Agent(i) for i ...]  │
  │     def reset(self):                        │
  │         ...                                 │
  │     def step(self, actions):                │
  │         ...                                 │
  └─────────────────────────────────────────────┘

LLM Call Details:
  • Model: openrouter/claude-3-opus
  • Tokens: 45,200 in / 12,800 out
  • Duration: 32.4s
  • Cost: $0.45

Quality Assessment:
  • Code structure: 8/10
  • Imports: All valid
  • Entry point: clear
  • Docstrings: 3/5 public methods documented
```

#### 17.8.3 Onboarding Wizard

**Problem:** New users are overwhelmed by Eden's capabilities. They don't know where to start.

**Solution:** A guided onboarding flow:

```
Step 1/4: Welcome to Eden 🏗️
  "I'll help you generate your first environment in 2 minutes."

Step 2/4: Describe your environment
  [Input box with examples]
  "Try: 'a simple gridworld for testing a reinforcement learning agent'"

Step 3/4: Watch it generate
  [Live pipeline visualization]
  "Eden's 17 agents are working together..."

Step 4/4: Explore your result
  [Show quality score, test results, export options]
  "Your environment is ready! Here's what you can do next:"
  • Export to Langfuse for evaluation
  • Download and run locally
  • Improve the quality with one click
  • View the full pipeline trace
```

**Progressive disclosure:**
- Day 1: Generate + Download (80% of users)
- Week 1: Export + Compare (40% of users)
- Month 1: Templates + CLI + Integration (20% of users)
- Power users: Pipeline customization + KB querying (5% of users)

---

### 17.9 Feature Priority Matrix

| Feature | Effort | Impact | Risk | User Visibility | Priority |
|---|---|---|---|---|---|
| **CLI tool** | 5-7 days | High | Low | High | 🥇 Immediate |
| **Quality score explainability** | 3-4 days | High | Low | High | 🥇 Immediate |
| **Real-time pipeline viz** | 5-7 days | High | Low | High | 🥇 Immediate |
| **Pipeline caching** | 4-5 days | Medium | Medium | Low (invisible) | 🥈 Next |
| **In-browser env testing** | 5-7 days | High | Medium | High | 🥈 Next |
| **RBAC & permissions** | 4-5 days | High | Medium | Medium | 🥈 Next |
| **Onboarding wizard** | 3-4 days | High | Low | High | 🥈 Next |
| **Template system** | 5-7 days | Medium | Low | High | 🥈 Next |
| **HITL checkpoints** | 5-7 days | High | Medium | Medium | 🥈 Next |
| **Analytics dashboard** | 7-10 days | Medium | Low | Medium | 🥉 Soon |
| **Environment comparison** | 3-4 days | Medium | Low | High | 🥉 Soon |
| **Review workflows** | 5-7 days | Medium | Low | Medium | 🥉 Soon |
| **KB versioning** | 3-4 days | Low | Low | Low (invisible) | 🥉 Soon |
| **Import existing envs** | 7-10 days | High | High | High | 🥉 Soon |
| **Compliance scanning** | 5-7 days | Medium | Low | Low | 🥉 Soon |
| **Cost tracking** | 3-4 days | Medium | Low | Medium | 🥉 Soon |
| **Pipeline trace explorer** | 5-7 days | Medium | Low | High | 🥉 Soon |
| **Local dev mode** | 7-10 days | High | High | High | 🏁 Later |
| **Data residency** | 5-7 days | Medium | Medium | Low | 🏁 Later |
| **Audit trails** | 2-3 days | Medium | Low | Low (legal) | 🏁 Later |

### 17.10 Summary: The Platform Flywheel

Integrations get users in the door. Platform features make them stay. The combination creates a powerful flywheel:

```
                     ┌─────────────────────────────────────┐
                     │       Platform Features make         │
                     │       Eden indispensable daily       │
                     └────────────────┬────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
        ▼                             ▼                             ▼
┌──────────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│ Integrations     │     │ Pipeline Quality      │     │ Developer          │
│ bring users in   │◄────│ keeps users trusting  │────►│ Experience keeps   │
│                  │     │                      │     │ users productive   │
└──────────────────┘     └──────────────────────┘     └────────────────────┘
        │                             │                             │
        └─────────────────────────────┼─────────────────────────────┘
                                      │
                                      ▼
                     ┌─────────────────────────────────────┐
                     │  Users stay → more environments →    │
                     │  better Archivist → better platform  │
                     │  → word of mouth → more users        │
                     └─────────────────────────────────────┘
```

**The winning combination:**

1. **Integrations** (this doc, Sections 1-16) make Eden the obvious choice because it works with everything
2. **Platform Features** (Section 17) make Eden the daily habit because it's where environments are managed, debugged, and improved

Neither alone is enough. Together, they're unbeatable.

---

## Appendix A: Configuration

```python
# Settings for the integration hub and platform features
class IntegrationSettings(BaseModel):
    """Configuration for Eden's integration hub."""

    # OpenTelemetry
    otel_enabled: bool = True
    otel_endpoint: Optional[str] = None  # Collector endpoint
    otel_sampling_rate: float = 1.0  # 0.0 - 1.0

    # Langfuse
    langfuse_enabled: bool = False
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "https://cloud.langfuse.com"

    # LangSmith
    langsmith_enabled: bool = False
    langsmith_api_key: str = ""
    langsmith_project: str = "eden"
    langsmith_endpoint: str = "https://api.smith.langchain.com"

    # W&B Weave
    wandb_enabled: bool = False
    wandb_api_key: str = ""
    wandb_project: str = "eden-environments"
    wandb_entity: str = ""

    # Runloop
    runloop_enabled: bool = False
    runloop_api_key: str = ""
    runloop_default_blueprint: str = "eden-base"

    # E2B
    e2b_enabled: bool = False
    e2b_api_key: str = ""

    # MCP
    mcp_enabled: bool = True
    mcp_transport: str = "stdio"  # stdio or sse
    mcp_port: int = 8000

    # Notification Channels
    slack_webhook_url: Optional[str] = None
    discord_webhook_url: Optional[str] = None
    pagerduty_routing_key: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: int = 587

    # Webhook
    webhook_secret: str = ""
    webhook_endpoints: list[str] = []  # URLs to notify on pipeline events

    # Ingestion
    ingestion_enabled: bool = True
    ingestion_poll_interval_seconds: int = 300
    ingestion_max_results_per_poll: int = 1000

    # Platform features
    pipeline_cache_enabled: bool = True
    pipeline_cache_ttl_seconds: int = 3600
    rbac_enabled: bool = False
    audit_log_enabled: bool = True
    local_mode_enabled: bool = False
    hitl_checkpoints_enabled: bool = False
    compliance_scanning_enabled: bool = False
    cost_tracking_enabled: bool = True
```

## Appendix B: Migration Path for Existing Users

```python
# How existing users opt in (zero-code-change path)

# 1. Set environment variables
export EDEN_LANGFUSE_ENABLED=true
export EDEN_LANGFUSE_PUBLIC_KEY=pk-...
export EDEN_LANGFUSE_SECRET_KEY=sk-...

# 2. Next pipeline run automatically creates:
#    - Langfuse trace with all agent spans
#    - Langfuse dataset with environment test cases
#    - Quality scores pushed to Langfuse
#    - MCP-exposed environment
#    - Webhook notifications to all configured channels

# 3. For agent sandbox deployment (optional):
export EDEN_RUNLOOP_ENABLED=true
export EDEN_RUNLOOP_API_KEY=rl-...

# 4. For CLI usage:
pip install eden-cli
eden config init --api-key sk-...

# 5. For IDE integration:
#    Install "Eden" from VSCode Marketplace
```

## Appendix C: Implementation Priority Matrix

| Feature | Effort | Impact | Risk | Priority |
|---|---|---|---|---|
| MCP server (tools + resources) | 3-4 days | High | Medium | 🥇 Immediate |
| E2B deployer | 3-4 days | Medium | Low | 🥈 Next |
| Notification system | 4-5 days | Medium | Low | 🥈 Next |
| CLI tool | 5-7 days | High | Low | 🥇 Immediate |
| Quality score explainability | 3-4 days | High | Low | 🥇 Immediate |
| Pipeline real-time viz | 5-7 days | High | Low | 🥇 Immediate |
| VSCode extension | 5-7 days | Medium | Low | 🥉 Soon |
| Helm chart | 4-5 days | Medium (Enterprise) | Low | 🥉 Soon |

---


## 18. Eden Architecture Companion Documents

The core Eden platform architecture is documented above. The following companion documents provide deep, detailed specifications for every major subsystem and cross-cutting concern. Together they form the complete architectural specification for Eden as a production-grade platform.

| # | Document | What It Covers | Priority |
|---|----------|---------------|----------|
| 1 | **[`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md)** | User-facing observability platform, unified trace model, dataset generation engine, insights engine (6 detectors), dual-layer knowledge base (global + tenant), zero-friction SDK (`@eden.trace_agent`, `eden.wrap_environment`), feedback flywheel | 🔴 Critical |
| 2 | **[`eden-security-architecture.md`](./eden-security-architecture.md)** | Authentication (OAuth/OIDC, API keys, machine identity), authorization (OPA/ABAC), data isolation (RLS, schema-per-tenant, envelope encryption), secrets management (Vault dynamic secrets), audit logging (immutable, compliance-mapped), prompt injection defense (4-layer), sandboxing (gVisor/Firecracker/Kata), supply chain security (SBOM, SLSA, code signing), network security, incident response | 🔴 Critical |
| 3 | **[`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md)** | Tenant isolation models (hybrid), organization & user hierarchy, resource quotas & token budgets, rate limiting (3-tier), event-driven billing & metering (Kafka → ClickHouse → Stripe), pricing models (4 tiers + enterprise), tenant-aware caching, data residency (6 regions), self-service onboarding, noisy neighbor mitigation (fair-share scheduling) | 🔴 Critical |
| 4 | **[`eden-sdk-integration-architecture.md`](./eden-sdk-integration-architecture.md)** | Python & TypeScript SDK design (async-first, streaming-first, Pydantic-typed), CLI tool (`eden` commands), plugin architecture (entry points), IDE integrations (VS Code LSP, JetBrains), documentation strategy (interactive playgrounds, tutorials), error handling (structured, request IDs), versioning (SemVer, feature flags), framework integrations (LangChain, OpenAI, Gymnasium) | 🟡 High |
| 5 | **[`eden-cicd-evaluation-architecture.md`](./eden-cicd-evaluation-architecture.md)** | Automated evaluation pipelines (6 stages), golden datasets & benchmark suites, canary deployments (shadow mode, traffic splitting, A/B), human-in-the-loop review gates (risk classifier), security scanning (SAST + hallucinated dependency detection), 3-tier versioning (code/model/prompt), automatic rollback triggers, GitHub/GitLab/Jenkins integration, continuous feedback loop | 🟡 High |
| 6 | **[`eden-cost-optimization-architecture.md`](./eden-cost-optimization-architecture.md)** | Intelligent model routing (T1–T4 tiers with quality validation), multi-layer caching (exact → semantic → provider → sub-component), token optimization (compression, context window management), request coalescing & deduplication, compute optimization (sandbox right-sizing, spot instances), granular cost attribution (5 dimensions), budget enforcement with auto-mitigation | 🟡 High |
| 7 | **[`eden-realtime-streaming-architecture.md`](./eden-realtime-streaming-architecture.md)** | Protocol selection (SSE/WebSocket/gRPC), event sourcing for agent traces, pipeline streaming, real-time dashboards (edge fanout), stream processing (Kafka → Flink/ksqlDB), backpressure & circuit breakers, connection management at scale (1M+ concurrent), ordered delivery guarantees (partitioning + idempotency), event schema taxonomy | 🟢 Medium |

**Reading Order:**
- Start with this document for the strategic vision and integration targets
- Read documents 1–3 for the core platform foundation (observability, security, multi-tenancy)
- Read documents 4–5 for developer experience and operational workflows
| 8 | **[`eden-realtime-streaming-architecture.md`](./eden-realtime-streaming-architecture.md)** | SSE/WebSocket streaming, event sourcing, real-time dashboards, stream processing (Kafka → Flink), backpressure, connection management at scale, ordered delivery | Medium |
| 9 | **[`eden-llmops-experiment-architecture.md`](./eden-llmops-experiment-architecture.md)** | Model artifact registry (delta artifacts), prompt versioning & A/B testing, semantic cache, feature store, experiment tracking, LLM-as-judge, AI gateway with cost-aware routing | High |
| 10 | **[`eden-api-developer-platform-architecture.md`](./eden-api-developer-platform-architecture.md)** | REST + SSE API design, date-based versioning, webhooks with HMAC signatures, Python/TypeScript SDKs (async-first), CLI with interactive prompts, API gateway, OpenAPI docs | Critical |
| 11 | **[`eden-data-platform-architecture.md`](./eden-data-platform-architecture.md)** | Lakehouse (Iceberg/Hudi), Bronze/Silver/Gold ETL via dbt, Great Expectations + Soda Core, ClickHouse analytics, tiered storage (hot/warm/cold), GDPR right-to-be-forgotten, OpenLineage lineage | Critical |
| 12 | **[`eden-multi-agent-orchestration-architecture.md`](./eden-multi-agent-orchestration-architecture.md)** | Communication patterns (message passing, shared state, blackboard), agent hierarchies, tool use frameworks, state management with checkpointing, memory tiers, planning/reflection, coordination protocols | High |

**Reading Order:**
- Start with this document for the strategic vision and integration targets
- Read documents 1–3 for the core platform foundation (observability, security, multi-tenancy)
- Read documents 4, 9–10 for developer experience, APIs, and SDKs
- Read documents 5, 12 for operational workflows and multi-agent orchestration
- Read documents 6–8 for advanced optimization, real-time, and cost management
- Read document 11 for the data platform that underpins everything
- See [`eden-master-architecture-index.md`](./eden-master-architecture-index.md) for a unified roadmap tying all documents together
