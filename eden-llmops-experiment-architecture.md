# Eden — LLMOps & Experiment Tracking Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define how Eden manages model artifacts, prompt versioning, experiment tracking, and production monitoring to ensure every environment and agent configuration is reproducible, comparable, and continuously improving.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Architecture Overview](#2-architecture-overview)
3. [Model Artifact Registry](#3-model-artifact-registry)
4. [Prompt Versioning & Management](#4-prompt-versioning--management)
5. [Feature Store for Agent Context](#5-feature-store-for-agent-context)
6. [Experiment Tracking for Agent Pipelines](#6-experiment-tracking-for-agent-pipelines)
7. [Production Model Monitoring](#7-production-model-monitoring)
8. [Training Data Management](#8-training-data-management)
9. [The Eden AI Gateway](#9-the-eden-ai-gateway)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Strategic Thesis

Eden generates environments for AI agents. The quality of those environments depends on the LLMs that generate them, the prompts that guide them, and the configurations that parameterize them. LLMOps in Eden is not a peripheral concern — it is the substrate that makes every environment reproducible, every improvement measurable, and every regression traceable.

The core principle: **Every environment generation is an experiment.** Every prompt change, every model swap, every hyperparameter tweak must be tracked, versioned, and evaluated against a canonical benchmark suite. Without this, Eden cannot know whether today's environments are better than yesterday's.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EDEN LLMOps PLATFORM                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   Artifact   │  │   Prompt     │  │   Feature    │  │  Experiment  │   │
│  │   Registry   │  │   Registry   │  │    Store     │  │   Tracker    │   │
│  │              │  │              │  │              │  │              │   │
│  │ • Model pkgs │  │ • Templates  │  │ • Embeddings │  │ • Configs  │   │
│  │ • LoRA adptrs│  │ • Versions   │  │ • Retrieved  │  │ • Metrics  │   │
│  │ • Checkpoints│  │ • A/B groups │  │   context    │  │ • Lineage  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                  │                 │           │
│         └─────────────────┴──────────────────┴─────────────────┘           │
│                                   │                                         │
│                          ┌────────┴────────┐                               │
│                          │   EDEN AI       │                               │
│                          │   GATEWAY       │                               │
│                          │                 │                               │
│                          │ • Auth/Z        │                               │
│                          │ • Rate limiting │                               │
│                          │ • Cost tracking │                               │
│                          │ • Provider rot│                               │
│                          │ • PII filtering │                             │
│                          └────────┬────────┘                               │
│                                   │                                         │
│         ┌─────────────────────────┼─────────────────────────┐               │
│         ▼                         ▼                         ▼               │
│  ┌──────────────┐        ┌──────────────┐        ┌──────────────┐       │
│  │   OpenRouter │        │   MiniMax    │        │  Self-Hosted │       │
│  │   (Primary)  │        │  (Fallback)  │        │   (vLLM etc) │       │
│  └──────────────┘        └──────────────┘        └──────────────┘       │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │                    PRODUCTION MONITORING                        │     │
│  │  Drift Detection • Hallucination Rate • Token Efficiency        │     │
│  │  Latency Tracking • Cost Attribution • Performance Regression │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Model Artifact Registry

### 3.1 Purpose
Store, version, and retrieve every model artifact used in Eden's pipeline — base models, fine-tuned variants, LoRA adapters, and embedding models.

### 3.2 Data Model

```sql
CREATE TABLE model_artifacts (
    artifact_id         UUID PRIMARY KEY,
    artifact_type       ENUM('base_model', 'lora_adapter', 'embedding_model', 'reward_model', 'judge_model'),
    model_family        VARCHAR(64),           -- e.g., 'claude', 'gpt', 'llama'
    model_version       VARCHAR(64),           -- e.g., 'claude-sonnet-4-20250514'
    provider            VARCHAR(64),           -- 'openrouter', 'anthropic', 'self-hosted'
    storage_uri         VARCHAR(512),          -- s3://eden-artifacts/models/...
    config_hash         VARCHAR(64),           -- SHA-256 of generation config
    training_config     JSONB,                 -- LoRA rank, alpha, target_modules
    parent_artifact_id  UUID REFERENCES model_artifacts(artifact_id),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    metadata            JSONB
);

CREATE TABLE artifact_evaluations (
    evaluation_id       UUID PRIMARY KEY,
    artifact_id         UUID REFERENCES model_artifacts(artifact_id),
    benchmark_suite_id  UUID,
    pass_rate           DECIMAL(5,4),
    avg_latency_ms      INTEGER,
    cost_per_1k_tokens  DECIMAL(10,6),
    hallucination_rate  DECIMAL(5,4),
    evaluated_at        TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.3 Delta Artifact Pattern
Instead of storing full model weights for every fine-tuned variant, Eden stores:
- **Base model reference** (pointer to HuggingFace Hub or API provider)
- **LoRA adapter weights** (typically <1% of base model size)
- **Generation configuration** (temperature, top_p, max_tokens, system prompt hash)
- **Training dataset reference** (pointer to curated dataset in data platform)

This reduces storage costs by ~99% while maintaining full reproducibility.

### 3.4 Integration Points
- **Pipeline nodes** query the registry to resolve `model_family` + `model_version` → concrete API endpoint or local path
- **Experiment tracker** links every environment generation to the exact artifact used
- **Cost optimization layer** queries artifact evaluations to route requests to cheapest model meeting quality threshold

---

## 4. Prompt Versioning & Management

### 4.1 Purpose
Every prompt in Eden — system prompts for the Spec Generator, Designer, Implementer, Reviewer, Archivist — must be versioned, A/B tested, and rollback-capable.

### 4.2 Prompt Registry Schema

```sql
CREATE TABLE prompt_templates (
    prompt_id           UUID PRIMARY KEY,
    prompt_name         VARCHAR(128) NOT NULL,     -- e.g., 'spec_generator_v2'
    agent_scope         VARCHAR(64),               -- 'spec_generator', 'designer', etc.
    version             INTEGER NOT NULL,
    template_text       TEXT NOT NULL,
    template_hash       VARCHAR(64) NOT NULL,      -- SHA-256 for integrity
    variables           JSONB,                      -- { "env_class": "string", "complexity": "int" }
    is_default          BOOLEAN DEFAULT FALSE,
    created_by          UUID,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    metadata            JSONB
);

CREATE TABLE prompt_ab_tests (
    test_id             UUID PRIMARY KEY,
    prompt_name         VARCHAR(128),
    variant_a_id        UUID REFERENCES prompt_templates(prompt_id),
    variant_b_id        UUID REFERENCES prompt_templates(prompt_id),
    traffic_split       DECIMAL(3,2) DEFAULT 0.50,  -- 50/50 default
    success_metric      VARCHAR(64),                -- 'env_pass_rate', 'review_score', 'generation_time'
    start_date          TIMESTAMPTZ,
    end_date            TIMESTAMPTZ,
    winner_id           UUID REFERENCES prompt_templates(prompt_id),
    confidence_level    DECIMAL(3,2)
);
```

### 4.3 Prompt Versioning Strategy
- **Immutable versions:** Once a prompt template is saved, it never changes. New edits create `version + 1`.
- **Default pinning:** Each pipeline node pins to a specific prompt version, not "latest". This ensures reproducibility.
- **Automatic promotion:** When an A/B test reaches statistical significance (p < 0.05), the winning variant becomes the new default.
- **Emergency rollback:** One-click rollback to any previous version if production regressions are detected.

### 4.4 Template Engine
Eden uses **Jinja2** for prompt templating with the following safeguards:
- Strict mode (undefined variables raise errors, not silent omission)
- Max template depth (prevents recursion attacks)
- Output length limits (prevents unbounded prompt expansion)
- PII redaction pass before template rendering

### 4.5 Integration with Pipeline
```python
# eden/llm/prompt_registry.py
class PromptRegistry:
    async def render_prompt(
        self,
        prompt_name: str,
        variables: dict,
        override_version: int | None = None
    ) -> str:
        """Resolve and render a prompt template with variable substitution."""
        version = override_version or await self.get_default_version(prompt_name)
        template = await self.get_template(prompt_name, version)
        
        # Check A/B test enrollment
        ab_variant = await self.check_ab_enrollment(prompt_name)
        if ab_variant:
            template = await self.get_template_by_id(ab_variant)
        
        return jinja2.Template(template.template_text, strict=True).render(**variables)
```

---

## 5. Feature Store for Agent Context

### 5.1 Purpose
Cache and serve retrieved context, embeddings, and computed features that are expensive to recompute — enabling sub-100ms retrieval for repeated patterns.

### 5.2 Three-Tier Storage

| Tier | Storage | Latency | Use Case |
|------|---------|---------|----------|
| L1 (Hot) | Redis | <5ms | Exact embedding cache, frequent retrieved context |
| L2 (Warm) | PostgreSQL + pgvector | <50ms | Semantic similarity cache, tenant-specific features |
| L3 (Cold) | S3 + Iceberg | <500ms | Historical feature archives, training datasets |

### 5.3 Semantic Caching Layer
```python
# eden/llm/semantic_cache.py
class SemanticCache:
    """Cache LLM responses based on embedding similarity, not exact string match."""
    
    async def get(self, query: str, similarity_threshold: float = 0.95) -> str | None:
        query_embedding = await self.embedder.embed(query)
        
        # Search for semantically similar cached queries
        similar = await self.vector_store.similarity_search(
            embedding=query_embedding,
            threshold=similarity_threshold,
            k=1
        )
        
        if similar and similar[0].response_metadata['model_version'] == self.current_model:
            return similar[0].cached_response
        return None
    
    async def set(self, query: str, response: str, ttl_seconds: int = 3600):
        embedding = await self.embedder.embed(query)
        await self.vector_store.store(
            embedding=embedding,
            text=query,
            metadata={
                'cached_response': response,
                'model_version': self.current_model,
                'created_at': datetime.utcnow().isoformat()
            },
            ttl=ttl_seconds
        )
```

### 5.4 Feature Types
- **Embedding features:** Pre-computed embeddings for frequently retrieved knowledge base entries
- **Retrieval features:** Cached RAG context chunks with provenance metadata
- **Computed features:** Expensive intermediate computations (AST complexity scores, dependency graphs)
- **Profile features:** Tenant-specific preferences learned from feedback (coding style, framework preferences)

---

## 6. Experiment Tracking for Agent Pipelines

### 6.1 Purpose
Every environment generation job in Eden is an experiment. Track hyperparameters, configurations, outputs, and metrics for reproducibility and comparison.

### 6.2 Experiment Data Model

```sql
CREATE TABLE experiments (
    experiment_id       UUID PRIMARY KEY,
    experiment_name     VARCHAR(256),
    experiment_type     ENUM('prompt_ab', 'model_comparison', 'pipeline_config', 'feature_flag'),
    pipeline_version    VARCHAR(64),           -- e.g., 'v2.3.1'
    git_commit          VARCHAR(40),
    config_snapshot     JSONB NOT NULL,         -- Full pipeline config at experiment start
    model_artifact_ids  UUID[],                -- Models used
    prompt_ids          UUID[],                -- Prompt versions used
    feature_store_refs  JSONB,                 -- Which feature sets were active
    status              ENUM('running', 'completed', 'failed', 'aborted'),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_by          UUID
);

CREATE TABLE experiment_runs (
    run_id              UUID PRIMARY KEY,
    experiment_id       UUID REFERENCES experiments(experiment_id),
    job_id              UUID,                  -- Link to Eden job
    run_params          JSONB,                 -- Per-run overrides
    metrics             JSONB,                 -- { "env_pass_rate": 0.87, "generation_time_sec": 142 }
    outputs             JSONB,                 -- { "environment_code": "...", "test_results": [...] }
    artifacts           JSONB,                 -- S3 URIs for generated artifacts
    status              VARCHAR(32),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);
```

### 6.3 What Gets Tracked for Every Job
```json
{
  "experiment_id": "exp_...",
  "pipeline_config": {
    "spec_generator": { "model": "claude-sonnet-4", "prompt_version": 12, "temperature": 0.7 },
    "designer": { "model": "gpt-4o", "prompt_version": 8, "temperature": 0.3 },
    "implementer": { "model": "claude-sonnet-4", "prompt_version": 15, "temperature": 0.2 },
    "reviewer": { "model": "gpt-4o", "prompt_version": 6, "temperature": 0.1 },
    "max_iterations": 3,
    "sandbox_config": { "timeout_sec": 300, "memory_limit_mb": 512 }
  },
  "environment_request": {
    "description": "...",
    "env_class": "agent_sandbox",
    "framework": "langchain",
    "complexity": "high"
  },
  "outputs": {
    "environment_id": "env_...",
    "lines_of_code": 1247,
    "test_pass_rate": 0.94,
    "review_score": 8.3,
    "generation_time_sec": 142,
    "total_tokens": 45231,
    "cost_usd": 0.847
  }
}
```

### 6.4 Comparison & Regression Detection
- **Baseline comparison:** Every experiment automatically compares against the current production baseline
- **Statistical significance:** Welch's t-test for continuous metrics, chi-squared for pass/fail rates
- **Regression threshold:** Configurable (default: 5% degradation in any primary metric triggers alert)
- **Auto-rollback:** Option to automatically revert prompt/model defaults if regression detected

---

## 7. Production Model Monitoring

### 7.1 Purpose
Detect when models used in Eden's pipeline degrade in quality, speed, or cost-effectiveness — before users notice.

### 7.2 Monitoring Dimensions

| Dimension | Metric | Detection Method | Alert Threshold |
|-----------|--------|------------------|-----------------|
| **Output Drift** | Response distribution shift | KL divergence vs baseline | >0.1 |
| **Hallucination Rate** | Factual errors in generated code | LLM-as-judge (Claude 3.5 Opus) | >5% |
| **Token Efficiency** | Tokens per line of code | Trend analysis | >20% increase |
| **Latency Degradation** | P95 response time | EWMA with 3-sigma bounds | >2x baseline |
| **Cost Inflation** | Cost per environment | Per-token pricing × volume | >15% MoM |
| **Pass Rate Drift** | Environment test pass rate | CUSUM control chart | <2σ from mean |

### 7.3 LLM-as-Judge Pipeline
```python
# eden/llm/judge.py
class LLMJudge:
    """Uses a stronger model to evaluate outputs of production models."""
    
    async def evaluate_hallucination(
        self,
        generated_code: str,
        spec: str,
        ground_truth: str | None = None
    ) -> dict:
        prompt = f"""
        Evaluate the following generated code for factual correctness against its specification.
        
        Specification: {spec}
        Generated Code: {generated_code}
        
        Rate each category 1-5:
        1. API usage correctness (does it use APIs that exist?)
        2. Logic correctness (does it implement the spec?)
        3. Type safety (are types consistent?)
        4. Dependency correctness (do imported packages exist?)
        
        Return JSON: {{"hallucination_detected": bool, "categories": {{...}}, "confidence": float}}
        """
        
        # Always use the strongest available judge model
        response = await self.client.complete(
            model="claude-3-5-opus-20250514",
            prompt=prompt,
            temperature=0.0,  # Deterministic judging
            max_tokens=1024
        )
        return json.loads(response)
```

### 7.4 Alerting & Escalation
- **Slack/PagerDuty integration** for critical alerts (pass rate drops >10%)
- **Dashboard annotations** for all metric shifts (visible in Grafana)
- **Auto-ticket creation** in Linear/Jira for sustained regressions
- **Weekly digest** of all model performance changes with top-line metrics

---

## 8. Training Data Management

### 8.1 Purpose
Curate high-quality datasets from Eden's production data to continuously fine-tune models, improve prompts, and train specialized judge models.

### 8.2 Data Curation Pipeline

```
Raw Traces (Bronze) → Quality Filtering (Silver) → Curated Datasets (Gold)
     │                        │                            │
     ▼                        ▼                            ▼
S3 / Kafka              Deduplication               Training Pipelines
Parquet files        • Exact match removal       • LoRA fine-tuning
                       • Semantic dedup           • DPO / RLHF
                       • Quality scoring          • Prompt optimization
                       • PII scrubbing
```

### 8.3 Quality Scoring for Data Points
Every raw trace gets a quality score (0-1) based on:
- **Outcome quality:** Did the generated environment pass all tests? (binary)
- **Review score:** What score did the Reviewer agent give? (0-10)
- **User feedback:** Did the user accept/modify/reject? (from observability platform)
- **Diversity bonus:** Does this trace cover an underrepresented pattern? (cosine similarity to existing dataset)
- **Complexity score:** Does it demonstrate non-trivial reasoning? (AST depth, dependency count)

Only traces with `quality_score > 0.7` enter the curated training dataset.

### 8.4 Curriculum Learning Data Curation
Training data is organized into difficulty tiers:
- **Tier 1 (Beginner):** Simple environments, single-file, standard patterns (>50% of data)
- **Tier 2 (Intermediate):** Multi-file environments, framework integration, error handling (~35%)
- **Tier 3 (Advanced):** Complex multi-agent scenarios, adversarial patterns, edge cases (~15%)

Fine-tuning starts with Tier 1, progressively mixing in harder examples — preventing catastrophic forgetting and ensuring stable learning.

### 8.5 Synthetic Data Generation
For underrepresented categories (adversarial environments, rare frameworks), Eden generates synthetic training examples:
- **Paraphrasing:** Rewrite existing specs with different vocabulary and structure
- **Composition:** Combine two simple environments into one complex one
- **Adversarial mutation:** Introduce subtle bugs into correct code and train models to catch them
- **Cross-framework translation:** Translate an environment from one framework to another

---

## 9. The Eden AI Gateway

### 9.1 Purpose
A unified interface between Eden's pipeline and all LLM providers, enforcing security, cost management, and observability at a single chokepoint.

### 9.2 Gateway Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      EDEN AI GATEWAY                        │
├─────────────────────────────────────────────────────────────┤
│  Authentication Layer                                       │
│  • API key validation                                       │
│  • Scoped permission checks                                 │
│  • Tenant isolation verification                            │
├─────────────────────────────────────────────────────────────┤
│  Request Processing                                         │
│  • Prompt PII filtering (regex + NER)                       │
│  • Prompt injection detection (pattern matching + LLM scan) │
│  • Token budget enforcement                                 │
│  • Semantic cache lookup                                    │
├─────────────────────────────────────────────────────────────┤
│  Routing & Load Balancing                                   │
│  • Provider health checks (OpenRouter, MiniMax, self-hosted)│
│  • Cost-aware routing (cheapest model meeting quality bar)  │
│  • Automatic failover on latency spikes or errors            │
│  • Circuit breaker for failing providers                    │
├─────────────────────────────────────────────────────────────┤
│  Observability                                              │
│  • Request/response logging (with PII masking)               │
│  • Token usage tracking per tenant/job                      │
│  • Latency histograms                                       │
│  • Cost attribution                                         │
├─────────────────────────────────────────────────────────────┤
│  Response Processing                                        │
│  • Output validation (JSON schema, length limits)           │
│  • Content filtering (toxicity, code injection)             │
│  • Response caching (exact match + semantic)                │
└─────────────────────────────────────────────────────────────┘
```

### 9.3 Provider Failover Logic
```python
# eden/llm/gateway.py
class AIGateway:
    async def complete(
        self,
        model_request: ModelRequest,
        tenant_id: str,
        job_id: str
    ) -> ModelResponse:
        
        # 1. Check semantic cache
        cached = await self.cache.get(model_request.prompt_hash)
        if cached:
            return cached
        
        # 2. Enforce token budget
        budget = await self.get_tenant_budget(tenant_id)
        if budget.remaining < model_request.estimated_tokens:
            raise BudgetExceededError()
        
        # 3. Route to best provider
        provider = self.select_provider(
            model_request.model_family,
            quality_requirement=model_request.min_quality,
            max_latency_ms=model_request.max_latency
        )
        
        # 4. Execute with circuit breaker
        try:
            response = await self.circuit_breakers[provider].call(
                self.providers[provider].complete,
                model_request
            )
        except ProviderUnavailable:
            # Fallback to next-best provider
            provider = self.select_fallback(provider)
            response = await self.providers[provider].complete(model_request)
        
        # 5. Record metrics
        await self.metrics.record(
            tenant_id=tenant_id,
            job_id=job_id,
            provider=provider,
            model=model_request.model,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            latency_ms=response.latency_ms,
            cost_usd=response.cost
        )
        
        return response
```

### 9.4 Cost-Aware Model Routing
Eden maintains a real-time **Model Performance Matrix**:

| Model | Quality Score | Latency P95 | Cost/1K tokens | Reliability |
|-------|--------------|-------------|----------------|-------------|
| Claude 3.5 Sonnet | 0.94 | 800ms | $0.003 | 99.9% |
| GPT-4o | 0.92 | 600ms | $0.0025 | 99.8% |
| Claude 3.5 Haiku | 0.87 | 200ms | $0.00025 | 99.9% |
| MiniMax-M2.7 | 0.85 | 400ms | $0.00015 | 99.5% |

The gateway routes each request to the cheapest model that meets the quality threshold for that pipeline node:
- **Spec Generator** (needs creativity): Claude 3.5 Sonnet
- **Designer** (needs precision): GPT-4o
- **Implementer** (needs correctness): Claude 3.5 Sonnet
- **Reviewer** (needs strong reasoning): Claude 3.5 Opus (or GPT-4o)
- **Archivist** (can use cheaper): Claude 3.5 Haiku

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-4)
- [ ] Implement model artifact registry (PostgreSQL schema + S3 storage)
- [ ] Build prompt registry with versioning
- [ ] Integrate semantic cache (Redis + pgvector)
- [ ] Basic experiment tracking (config snapshots + metrics)
- [ ] AI Gateway v1 (auth, routing, basic failover)

### Phase 2: Intelligence (Weeks 5-8)
- [ ] A/B testing framework for prompts
- [ ] Automated regression detection
- [ ] LLM-as-judge pipeline for hallucination detection
- [ ] Model performance matrix with cost-aware routing
- [ ] Semantic cache hit rate optimization

### Phase 3: Scale (Weeks 9-12)
- [ ] Training data curation pipeline (Bronze → Silver → Gold)
- [ ] Synthetic data generation for underrepresented categories
- [ ] Curriculum learning data organization
- [ ] Advanced circuit breaker patterns (adaptive thresholds)
- [ ] Full integration with observability platform for feedback loops

---

## Cross-References

| This Document References | For |
|--------------------------|-----|
| [`eden-cost-optimization-architecture.md`](./eden-cost-optimization-architecture.md) | Token optimization, model routing, caching strategies |
| [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) | User feedback integration, trace quality scoring, dataset generation |
| [`eden-cicd-evaluation-architecture.md`](./eden-cicd-evaluation-architecture.md) | Automated evaluation pipelines, regression testing, golden datasets |
| [`eden-data-platform-architecture.md`](./eden-data-platform-architecture.md) | Lakehouse storage, ETL pipelines, data quality frameworks |
| [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) | Core pipeline architecture, node definitions, LangGraph integration |
