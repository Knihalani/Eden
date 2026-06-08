# Eden — Cost Optimization & Model Routing Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define how Eden minimizes LLM and infrastructure costs without degrading environment quality. Covers intelligent model routing, multi-layer caching, token optimization, request coalescing, compute efficiency, and granular cost attribution. In a platform where every environment generation can cost $0.50–$50, cost optimization is a core product capability, not an afterthought.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Cost Landscape](#2-cost-landscape)
3. [Intelligent Model Routing](#3-intelligent-model-routing)
4. [Multi-Layer Caching](#4-multi-layer-caching)
5. [Token Optimization](#5-token-optimization)
6. [Request Coalescing & Deduplication](#6-request-coalescing--deduplication)
7. [Compute Optimization](#7-compute-optimization)
8. [Cost Attribution & Budgeting](#8-cost-attribution--budgeting)
9. [Pricing Strategy](#9-pricing-strategy)
10. [Cost Monitoring & Alerting](#10-cost-monitoring--alerting)
11. [Implementation Roadmap](#11-implementation-roadmap)

---

## 1. Strategic Thesis

Eden's pipeline is expensive by design. A single environment generation involves:

- **Design phase:** 2–5 LLM calls for analysis, specification, and architecture
- **Generation phase:** 3–10 LLM calls for code, tests, and documentation
- **Validation phase:** Sandbox execution + 1–3 LLM calls for review
- **Archivist phase:** Embedding generation + knowledge base updates

At frontier model prices ($3–$15 per million tokens), a complex environment can cost **$10–$50 to generate**. For a platform serving thousands of generations per day, unoptimized costs would make the business unsustainable.

**Core Principles:**

| Principle | Description |
|-----------|-------------|
| **Right Model, Right Task** | Use the cheapest model that can reliably complete each sub-task |
| **Cache Everything Possible** | Identical or semantically similar requests should never hit the LLM twice |
| **Minimize Tokens** | Compress prompts, truncate context, avoid redundant system messages |
| **Batch Aggressively** | Group independent operations into single API calls |
| **Measure Continuously** | Every cost center is tracked, attributed, and optimized |

**Target Metrics:**

| Metric | Current Baseline | 6-Month Target | 12-Month Target |
|--------|---------------|--------------|-----------------|
| Avg cost per environment | $12.00 | $7.00 | $4.00 |
| Cache hit rate | 5% | 25% | 45% |
| Model routing accuracy | N/A | 90% | 95% |
| Token waste (redundant) | 30% | 15% | 8% |
| Fallback rate (cheap→expensive) | N/A | < 10% | < 5% |

---

## 2. Cost Landscape

### 2.1 Cost Breakdown by Pipeline Phase

| Phase | % of Total Cost | Primary Cost Driver | Optimization Lever |
|-------|----------------|--------------------|--------------------|
| **Design** | 15% | Specification generation, novelty assessment | Smaller model for analysis |
| **Generate** | 45% | Code generation, test generation | Caching, prompt compression |
| **Validate** | 20% | Test execution, code review LLM calls | Sandbox reuse, smaller review model |
| **Archivist** | 10% | Embedding generation, KB updates | Batch embeddings, deduplication |
| **Overhead** | 10% | Orchestration, retries, error handling | Better routing, circuit breakers |

### 2.2 Cost Breakdown by Resource

| Resource | % of Total | Optimization Strategy |
|----------|-----------|----------------------|
| **LLM tokens (input)** | 35% | Semantic caching, prompt compression |
| **LLM tokens (output)** | 30% | Model routing, smaller models for simple tasks |
| **LLM API overhead** | 10% | Batching, connection pooling |
| **Sandbox compute** | 15% | Spot instances, resource right-sizing |
| **Storage (observability)** | 5% | Tiered storage, compression |
| **Vector DB operations** | 3% | Batch writes, approximate search |
| **Other** | 2% | — |

---

## 3. Intelligent Model Routing

### 3.1 Routing Architecture

```
Incoming Request
       │
       ▼
┌──────────────────┐
│  Intent          │  Classify the task complexity
│  Classifier      │  (lightweight model or heuristic)
└────────┬─────────┘
         │
    ┌────┴────┬────────┬────────┐
    ▼         ▼        ▼        ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
│ Tier 1│ │ Tier 2│ │ Tier 3│ │ Tier 4│
│ Fast  │ │ Smart │ │Expert │ │Custom │
│Cheap  │ │       │ │       │ │       │
│$0.15/M│ │ $1/M  │ │ $5/M  │ │  $$$  │
└───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘
    │         │         │         │
    └─────────┴─────────┴─────────┘
              │
              ▼
       ┌──────────────┐
       │  Quality     │  Did the cheap model succeed?
       │  Validator   │  If not, escalate to next tier
       └──────────────┘
```

### 3.2 Tier Definitions

| Tier | Models | Use Cases | Cost (per 1M tokens) | Fallback If Fails |
|------|--------|-----------|----------------------|-------------------|
| **T1** | GPT-4o-mini, Claude Haiku | Classification, extraction, simple formatting | $0.15–$0.50 | → T2 |
| **T2** | GPT-4o, Claude Sonnet | Code generation, test writing, standard reasoning | $1.00–$3.00 | → T3 |
| **T3** | Claude Opus, GPT-4.5 | Complex architecture, novel patterns, adversarial design | $5.00–$15.00 | → T4 |
| **T4** | Custom fine-tuned, self-hosted | Proprietary requirements, compliance, offline | Variable | Human review |

### 3.3 Task Classification

```python
class TaskClassifier:
    """
    Classifies pipeline tasks to determine the optimal model tier.
    """

    async def classify(self, task: PipelineTask) -> ModelTier:
        # Heuristic-based fast path (no LLM call)
        if task.type in ("classification", "formatting", "extraction"):
            return ModelTier.T1

        if task.type == "code_generation" and task.complexity_score < 0.3:
            return ModelTier.T1

        if task.type == "code_review" and not task.requires_novelty:
            return ModelTier.T2

        # LLM-based classification for ambiguous cases
        classification = await self.classifier_llm.classify(
            prompt=task.description,
            criteria=["complexity", "novelty", "reasoning_depth", "domain_expertise"]
        )

        if classification.complexity < 0.4 and classification.novelty < 0.3:
            return ModelTier.T1
        elif classification.complexity < 0.7:
            return ModelTier.T2
        elif classification.complexity < 0.9:
            return ModelTier.T3
        else:
            return ModelTier.T4
```

### 3.4 Quality Validation & Fallback

Every T1/T2 response is validated before acceptance:

```python
class QualityValidator:
    async def validate(self, response: LLMResponse, task: PipelineTask) -> ValidationResult:
        # Check 1: Parseability (for code)
        if task.output_type == "code":
            try:
                ast.parse(response.content)
            except SyntaxError:
                return ValidationResult(passed=False, reason="syntax_error")

        # Check 2: Completeness heuristic
        if len(response.content) < task.expected_min_length:
            return ValidationResult(passed=False, reason="incomplete")

        # Check 3: Style/format compliance
        if task.required_format and not self.matches_format(response.content, task.required_format):
            return ValidationResult(passed=False, reason="format_mismatch")

        # Check 4: Semantic quality (lightweight LLM judge)
        if task.requires_quality_check:
            quality_score = await self.judge_llm.score(
                task=task.description,
                output=response.content
            )
            if quality_score < 0.7:
                return ValidationResult(passed=False, reason=f"quality_score_{quality_score}")

        return ValidationResult(passed=True)
```

**Fallback Chain:**

```
Request → T1 → Validate → Pass: Use T1 response
                │
                └─ Fail → T2 → Validate → Pass: Use T2 response
                                │
                                └─ Fail → T3 → Validate → Pass: Use T3 response
                                                │
                                                └─ Fail → T4 / Human
```

### 3.5 Routing Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| T1 success rate | > 70% | % of tasks that pass validation at T1 |
| T1 + T2 coverage | > 95% | % of tasks that pass by T2 |
| Avg tokens saved | > 40% | vs always using T3 |
| Fallback latency impact | < 200ms | Additional time for fallback chain |

---

## 4. Multi-Layer Caching

### 4.1 Cache Architecture

```
Request
  │
  ├──▶ L1: Exact Match Cache (Redis) — nanosecond lookup
  │     └── Key: hash(normalized_prompt + model + temperature)
  │
  ├──▶ L2: Semantic Cache (Redis + Vector DB) — millisecond lookup
  │     └── Key: embedding(normalized_prompt)
  │     └── Threshold: cosine similarity > 0.95
  │
  ├──▶ L3: Prompt Cache (LLM Provider) — free for cached prefix
  │     └── Supported by: Anthropic, OpenAI (beta)
  │
  └──▶ L4: Sub-component Cache — reuse code modules
        └── Key: hash(function_signature + docstring)
```

### 4.2 L1: Exact Match Cache

```python
class ExactMatchCache:
    def __init__(self, redis: Redis):
        self.redis = redis

    def _make_key(self, prompt: str, model: str, temperature: float, max_tokens: int) -> str:
        normalized = self.normalize(prompt)
        content_hash = hashlib.sha256(normalized.encode()).hexdigest()
        return f"eden:cache:exact:{model}:{temperature}:{max_tokens}:{content_hash}"

    async def get(self, prompt: str, model: str, temperature: float, max_tokens: int) -> Optional[str]:
        key = self._make_key(prompt, model, temperature, max_tokens)
        cached = await self.redis.get(key)
        if cached:
            await self.redis.incr("eden:metrics:exact_cache_hits")
            return json.loads(cached)
        return None

    async def set(self, prompt: str, model: str, temperature: float, max_tokens: int, response: str, ttl: int = 3600):
        key = self._make_key(prompt, model, temperature, max_tokens)
        await self.redis.setex(key, ttl, json.dumps(response))
```

### 4.3 L2: Semantic Cache

```python
class SemanticCache:
    def __init__(self, redis: Redis, vector_db: VectorDB):
        self.redis = redis
        self.vector_db = vector_db

    async def get(self, prompt: str, model: str, similarity_threshold: float = 0.95) -> Optional[str]:
        embedding = await self.embed(prompt)

        # Query vector DB for similar prompts
        results = await self.vector_db.search(
            embedding=embedding,
            filter={"model": model},
            top_k=3
        )

        for result in results:
            if result.similarity >= similarity_threshold:
                # Verify with exact match on normalized text
                normalized_input = self.normalize(prompt)
                normalized_cached = self.normalize(result.metadata["prompt"])
                if self.is_equivalent(normalized_input, normalized_cached):
                    await self.redis.incr("eden:metrics:semantic_cache_hits")
                    return result.metadata["response"]

        return None

    async def set(self, prompt: str, model: str, response: str):
        embedding = await self.embed(prompt)
        await self.vector_db.insert(
            embedding=embedding,
            metadata={
                "prompt": prompt,
                "model": model,
                "response": response,
                "timestamp": datetime.utcnow().isoformat()
            }
        )
```

### 4.4 L3: LLM Provider Prompt Caching

Modern providers support prompt caching:

- **Anthropic:** Cache system prompts and long context documents. Cached tokens are 10% of standard price.
- **OpenAI:** Context caching (beta) for repeated prefixes.
- **Self-hosted:** vLLM prefix caching for repeated system prompts.

**Eden Optimization:**
- All pipeline nodes share a common system prompt prefix → cached once
- Long context documents (environment specs, previous versions) are placed at the start of the prompt
- Cache-aware prompt construction reorders content to maximize prefix overlap

### 4.5 L4: Sub-Component Cache

For code generation, individual functions/modules can be cached independently:

```python
class SubComponentCache:
    """Cache individual functions/classes extracted from generated code."""

    async def cache_module(self, code: str, environment_id: str):
        tree = ast.parse(code)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                signature = self.extract_signature(node)
                key = f"eden:cache:module:{environment_id}:{hash(signature)}"

                # Store with TTL based on modification frequency
                await self.redis.setex(key, 86400, ast.unparse(node))
```

### 4.6 Cache Metrics

| Cache Layer | Target Hit Rate | Avg Latency Savings | Storage Cost |
|-------------|-----------------|---------------------|--------------|
| L1 Exact Match | 15% | 100% (no LLM call) | Very low |
| L2 Semantic | 20% | 100% (no LLM call) | Medium (vectors) |
| L3 Provider | 25% | 90% (cached prefix) | Included in provider cost |
| L4 Sub-component | 10% | 30% (partial reuse) | Low |
| **Combined** | **45%+** | **50–70% avg savings** | **Low overall** |

---

## 5. Token Optimization

### 5.1 Prompt Compression

```python
class PromptCompressor:
    """Compress prompts while preserving semantic content."""

    def compress(self, prompt: str, max_tokens: int) -> str:
        current_tokens = self.estimate_tokens(prompt)
        if current_tokens <= max_tokens:
            return prompt

        # Strategy 1: Remove redundant whitespace/comments
        prompt = self.minimize_whitespace(prompt)

        # Strategy 2: Summarize long context sections
        prompt = self.summarize_sections(prompt, max_tokens)

        # Strategy 3: Truncate with semantic preservation
        prompt = self.semantic_truncate(prompt, max_tokens)

        return prompt

    def summarize_sections(self, prompt: str, max_tokens: int) -> str:
        # Extract code examples — keep them intact
        # Summarize natural language sections using a small model
        sections = self.parse_sections(prompt)
        for section in sections:
            if section.type == "text" and self.estimate_tokens(section.content) > 200:
                section.content = self.summarizer.summarize(section.content, max_length=150)
        return self.reconstruct(sections)
```

### 5.2 Context Window Management

```python
class ContextWindowManager:
    """Intelligently manages what stays in the context window."""

    def build_prompt(self, system_prompt: str, history: list[Message], new_message: str, max_tokens: int) -> str:
        # Always keep system prompt
        reserved = self.estimate_tokens(system_prompt)
        available = max_tokens - reserved

        # Prioritize history by relevance
        scored_history = [
            (msg, self.score_relevance(msg, new_message))
            for msg in history
        ]
        scored_history.sort(key=lambda x: x[1], reverse=True)

        # Add messages until we hit the limit
        selected = []
        current_tokens = self.estimate_tokens(new_message)
        for msg, score in scored_history:
            msg_tokens = self.estimate_tokens(msg.content)
            if current_tokens + msg_tokens <= available:
                selected.append(msg)
                current_tokens += msg_tokens

        # Reconstruct prompt with selected history
        return self.format_prompt(system_prompt, selected, new_message)
```

### 5.3 System Prompt Deduplication

Across pipeline nodes, system prompts are often identical. Eden:

1. Maintains a registry of system prompt templates
2. Assigns each a unique hash
3. Reuses the same hash across nodes instead of repeating the text
4. Expands the hash to the full prompt only at the final API call stage

---

## 6. Request Coalescing & Deduplication

### 6.1 Request Coalescing

When multiple identical or near-identical requests arrive within a short window:

```python
class RequestCoalescer:
    def __init__(self):
        self.inflight = {}  # key -> Future
        self.lock = asyncio.Lock()

    async def execute(self, prompt: str, model: str) -> str:
        key = self.make_key(prompt, model)

        async with self.lock:
            if key in self.inflight:
                # Wait for the existing request to complete
                return await self.inflight[key]

            # Create a future for this request
            future = asyncio.Future()
            self.inflight[key] = future

        try:
            result = await self.llm.call(prompt, model)
            future.set_result(result)
            return result
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            async with self.lock:
                del self.inflight[key]
```

**Coalescing Window:** 100ms for exact match, 50ms for semantic match.

### 6.2 Deduplication in Agent Loops

Agentic systems often make redundant tool calls. Eden detects and prevents:

```python
class AgentDeduplicator:
    def __init__(self):
        self.recent_calls = deque(maxlen=100)

    def is_redundant(self, tool_call: ToolCall) -> bool:
        # Check if same tool with same arguments was called recently
        for recent in self.recent_calls:
            if (recent.tool_name == tool_call.tool_name and
                recent.arguments == tool_call.arguments and
                time.time() - recent.timestamp < 5):
                return True
        return False
```

---

## 7. Compute Optimization

### 7.1 Sandbox Resource Right-Sizing

| Environment Type | Default CPU | Default Memory | Auto-Scaled To |
|-----------------|-------------|----------------|----------------|
| Simple (single agent) | 0.5 cores | 256MB | Based on actual usage |
| Standard (multi-step) | 1 core | 512MB | Based on actual usage |
| Complex (multi-agent) | 2 cores | 1GB | Based on actual usage |
| Adversarial (heavy) | 4 cores | 2GB | Based on actual usage |

**Auto-scaling:** After 3 runs, Eden adjusts resource limits based on observed usage (p95 + 20% headroom).

### 7.2 Spot/Preemptible Instances

- Batch workloads (dataset generation, bulk benchmark runs) use spot instances
- Checkpoint state every 30 seconds for long-running jobs
- On preemption: automatically restart from checkpoint on standard instance
- Cost savings: 60–90% vs on-demand for batch workloads

### 7.3 Continuous Batching (Self-Hosted)

For self-hosted models (vLLM, TensorRT-LLM):

- Requests are dynamically batched to maximize GPU utilization
- Batch size adapts based on request arrival rate and token budget
- PagedAttention (vLLM) enables efficient KV cache management
- Target GPU utilization: > 85%

---

## 8. Cost Attribution & Budgeting

### 8.1 Granular Cost Tracking

Every cost is attributed at 5 dimensions:

```json
{
  "cost_event": {
    "tenant_id": "org_abc123",
    "user_id": "user_def456",
    "job_id": "job_ghi789",
    "environment_id": "env_jkl012",
    "model": "claude-sonnet-4-20250514",
    "pipeline_node": "environment_generation",
    "cost_type": "llm_tokens",
    "input_tokens": 3420,
    "output_tokens": 12000,
    "input_cost_cents": 10.26,
    "output_cost_cents": 36.00,
    "total_cost_cents": 46.26,
    "timestamp": "2026-05-29T12:00:00Z",
    "cache_hit": false,
    "model_tier": "T2"
  }
}
```

### 8.2 Real-Time Budget Enforcement

```python
class BudgetEnforcer:
    async def check_and_track(self, tenant_id: str, estimated_cost: float) -> BudgetStatus:
        # Get current usage from Redis (real-time)
        current = await self.redis.get(f"eden:budget:{tenant_id}:current_month")
        limit = await self.get_limit(tenant_id)

        if current + estimated_cost > limit.hard_limit:
            raise BudgetExceeded(f"Hard limit reached: {current}/{limit.hard_limit}")

        if current + estimated_cost > limit.soft_limit:
            # Allow but apply mitigations
            await self.apply_mitigations(tenant_id)
            return BudgetStatus.SOFT_LIMIT

        return BudgetStatus.OK

    async def apply_mitigations(self, tenant_id: str):
        # 1. Downgrade model routing
        await self.routing.set_max_tier(tenant_id, ModelTier.T2)

        # 2. Reduce cache TTL to maximize hits
        await self.cache.set_aggressive_mode(tenant_id)

        # 3. Notify tenant
        await self.notifications.send(
            tenant_id,
            "You've reached 80% of your monthly token budget. Consider upgrading your plan."
        )
```

---

## 9. Pricing Strategy

### 9.1 Cost Pass-Through Optimization

Eden's pricing must cover:

| Cost Category | % of Revenue | Mitigation |
|--------------|-------------|------------|
| LLM provider costs | 35–45% | Routing, caching, batching |
| Infrastructure (compute, storage) | 20–25% | Spot instances, right-sizing |
| Engineering & operations | 20–25% | — |
| Sales & marketing | 10–15% | — |
| Profit margin | 15–25% | — |

### 9.2 Pricing Tiers

See [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md) for full pricing details. Key cost-related aspects:

- **Token pooling:** Team plans share token quotas across users (reduces waste)
- **Rollover:** Unused tokens roll over for 1 month (reduces churn)
- **Volume discounts:** Pre-purchased credits at 20–40% discount
- **Custom models:** Enterprise customers can bring their own API keys (Eden charges platform fee only)

---

## 10. Cost Monitoring & Alerting

### 10.1 Dashboards

**Tenant Cost Dashboard:**
- Current month spend vs budget
- Spend by pipeline phase (design, generate, validate, archivist)
- Spend by model tier (T1, T2, T3, T4)
- Cache hit rates and savings
- Cost per environment (trend over time)
- Cost per benchmark run

**Platform Cost Dashboard:**
- Total platform burn rate
- Cost per tenant (identify high-cost tenants)
- Model provider cost breakdown
- Infrastructure cost by region
- Optimization opportunity alerts

### 10.2 Alerts

| Alert | Condition | Action |
|-------|-----------|--------|
| **Budget warning** | Tenant at 80% of monthly quota | Email + downgrade routing |
| **Cost spike** | Hourly cost > 3x rolling average | Page on-call + investigate |
| **Cache degradation** | Hit rate drops > 10% in 1 hour | Investigate cache invalidation |
| **Fallback spike** | Fallback rate > 15% | Alert ML team to improve classifier |
| **Token waste** | Avg prompt size > 1.5x expected | Review prompt templates |

---

## 11. Implementation Roadmap

### Phase 1: Quick Wins (Weeks 1–4)
- [ ] Deploy exact-match caching (Redis) for all LLM calls
- [ ] Implement model routing with T1/T2/T3 tiers
- [ ] Add quality validation and fallback chain
- [ ] Track granular cost per tenant/job/model
- [ ] Add prompt compression (whitespace removal, truncation)

### Phase 2: Intelligence (Weeks 5–8)
- [ ] Build semantic cache (vector DB + similarity search)
- [ ] Implement request coalescing
- [ ] Deploy task classifier (heuristic + lightweight LLM)
- [ ] Add sub-component caching for code generation
- [ ] Build cost monitoring dashboards

### Phase 3: Optimization (Weeks 9–12)
- [ ] Implement context window management with relevance scoring
- [ ] Add LLM provider prompt caching integration
- [ ] Deploy sandbox auto-scaling based on observed usage
- [ ] Build budget enforcement with automatic mitigations
- [ ] Add spot instance orchestration for batch workloads

### Phase 4: Advanced (Weeks 13–16)
- [ ] Implement custom fine-tuned models for common tasks
- [ ] Build predictive cost estimation before job submission
- [ ] Add multi-tenant cache sharing for common patterns
- [ ] Implement continuous batching for self-hosted models
- [ ] Launch cost optimization recommendations engine

---

*This document should be read alongside [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md) for billing integration and [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) for how cost optimization fits into the pipeline.*
