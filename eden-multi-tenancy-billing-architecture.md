# Eden — Multi-Tenancy & Billing Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define how Eden securely, fairly, and profitably serves multiple tenants (individual developers, teams, and enterprises) on shared infrastructure. Covers tenant isolation, resource governance, billing & metering, data residency, onboarding automation, and noisy-neighbor mitigation.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Tenant Isolation Model](#2-tenant-isolation-model)
3. [Organization & User Model](#3-organization--user-model)
4. [Resource Quotas & Rate Limiting](#4-resource-quotas--rate-limiting)
5. [Billing & Metering Architecture](#5-billing--metering-architecture)
6. [Pricing Models](#6-pricing-models)
7. [Tenant-Aware Caching](#7-tenant-aware-caching)
8. [Data Residency & Regional Deployment](#8-data-residency--regional-deployment)
9. [Tenant Onboarding & Provisioning](#9-tenant-onboarding--provisioning)
10. [Noisy Neighbor Mitigation](#10-noisy-neighbor-mitigation)
11. [Operational Tools for Admins](#11-operational-tools-for-admins)
12. [Implementation Roadmap](#12-implementation-roadmap)

---

## 1. Strategic Thesis

Eden is a multi-tenant SaaS platform generating and executing code. Unlike traditional CRUD apps, AI workloads are:

- **Unpredictable:** A single environment generation can consume anywhere from 10K to 10M tokens
- **Bursty:** Batch benchmark runs can flood the system with concurrent jobs
- **Security-sensitive:** Generated code runs in sandboxes with network access
- **Computationally expensive:** LLM inference and sandbox execution are costly

This demands a tenant architecture that is **strictly isolating**, **actively fair**, and **transparently metered**.

**Design Principles:**

| Principle | Enforcement |
|-----------|-------------|
| **Hard Boundaries** | Tenant data is never co-mingled without explicit cryptographic separation |
| **Fair Share** | No single tenant can starve others of resources |
| **Transparent Billing** | Every billable action is traceable to a specific tenant, user, and job |
| **Elastic Limits** | Quotas are soft by default with clear upgrade paths |
| **Self-Service** | Tenants can manage their own users, quotas, and regional preferences |

---

## 2. Tenant Isolation Model

### 2.1 Isolation Spectrum

Eden uses a **hybrid model** tailored to each data type's sensitivity and scale:

| Data Layer | Model | Technology |
|------------|-------|------------|
| **Control Plane** (auth, billing metadata, global KB) | Shared + ACL | PostgreSQL RLS + OPA policies |
| **Orchestration** (jobs, pipelines, queues) | Shared + Tenant ID partitioning | PostgreSQL + Redis (namespaced keys) |
| **Environment Code** | Separate schema | PostgreSQL schema-per-tenant |
| **Observability Data** (traces, metrics, datasets) | Separate schema | PostgreSQL + ClickHouse (separate DB per tenant) |
| **Vector Embeddings** (tenant KB) | Separate collection | Pinecone/Milvus namespace per tenant |
| **Secrets** | Separate Vault paths | HashiCorp Vault (path: `eden/tenants/{id}/*`) |
| **Sandbox Execution** | Shared compute + identity isolation | Kubernetes pods with tenant labels + network policies |
| **Object Storage** (artifacts, exports) | Prefix isolation | S3 with tenant prefix + bucket policies |

### 2.2 Schema-per-Tenant Implementation

```sql
-- On tenant provisioning, create a dedicated schema
CREATE SCHEMA IF NOT EXISTS tenant_550e8400;

-- All tenant tables live in their schema
CREATE TABLE tenant_550e8400.environments (...);
CREATE TABLE tenant_550e8400.benchmarks (...);
CREATE TABLE tenant_550e8400.agent_configs (...);

-- Application routing
SET search_path TO tenant_550e8400, public;
```

**Connection Pooling:**
- PgBouncer maintains separate connection pools per tenant
- Middleware sets `search_path` on connection checkout
- Pool exhaustion for one tenant does not affect others

### 2.3 Cross-Tenant Data Access Matrix

| Resource | Same Org | Same Tenant | Different Tenant | Admin | Global KB |
|----------|----------|-------------|------------------|-------|-----------|
| Environment code | Read | Full | Deny | Read* | Deny |
| Observability traces | Read | Full | Deny | Read* | Deny |
| Benchmark results | Read | Full | Aggregate only | Read* | Read (anonymized) |
| Knowledge patterns | Read | Full | Deny | Read* | Read (global only) |
| Billing data | Read (admins) | Full | Deny | Read* | N/A |

*Admin access requires explicit audit log entry and dual approval for production tenants.

---

## 3. Organization & User Model

### 3.1 Hierarchy

```
Eden Platform
└── Organization (tenant boundary)
    ├── Owner (1)
    ├── Admins (0–N)
    ├── Teams (0–N)
    │   ├── Team Lead
    │   └── Members
    └── Users (0–N)
        ├── Roles (Environment Engineer, Agent Operator, Analyst, Viewer)
        └── Permissions (granular ABAC)
```

### 3.2 Organization Types

| Type | Users | Environments | Concurrent Jobs | Use Case |
|------|-------|--------------|-----------------|----------|
| **Personal** | 1 | 10 | 1 | Individual developers |
| **Team** | 2–20 | 100 | 5 | Small teams |
| **Growth** | 21–100 | 500 | 20 | Mid-size companies |
| **Enterprise** | 100+ | Unlimited | Custom | Large organizations |

### 3.3 Team-Based Access Control

Resources can be scoped to teams:

```json
{
  "environment_id": "env_abc123",
  "org_id": "org_def456",
  "team_id": "team_ghi789",
  "visibility": "team",  // or "organization", "private"
  "shared_with": ["user_jkl012", "user_mno345"]
}
```

- Team-scoped resources are invisible to users outside the team
- Organization admins can audit all team resources
- Owners can break glass and access any resource with full audit trail

---

## 4. Resource Quotas & Rate Limiting

### 4.1 Quota Dimensions

Eden enforces quotas across multiple dimensions simultaneously:

| Dimension | Personal | Team | Growth | Enterprise |
|-----------|----------|------|--------|------------|
| **Users** | 1 | 20 | 100 | Custom |
| **Environments** | 10 | 100 | 500 | Unlimited |
| **Concurrent pipeline jobs** | 1 | 5 | 20 | Custom |
| **LLM tokens / month** | 100K | 2M | 10M | Custom |
| **Sandbox compute hours / month** | 10h | 100h | 500h | Custom |
| **Storage (observability)** | 1GB | 50GB | 250GB | Custom |
| **API requests / minute** | 30 | 300 | 1,500 | Custom |
| **Dataset exports / day** | 5 | 50 | 250 | Custom |

### 4.2 Token Budget Architecture

Token usage is the primary cost driver. Eden implements a **token budget controller**:

```python
class TokenBudgetController:
    """
    Manages per-tenant token budgets with soft and hard limits.
    """

    async def check_budget(self, tenant_id: str, estimated_tokens: int) -> BudgetStatus:
        usage = await self.get_current_month_usage(tenant_id)
        quota = await self.get_quota(tenant_id, "llm_tokens")

        if usage + estimated_tokens > quota.hard_limit:
            raise BudgetExceeded(f"Hard limit exceeded: {usage}/{quota.hard_limit}")

        if usage + estimated_tokens > quota.soft_limit:
            # Allow but notify + downgrade model routing
            await self.notify_tenant(tenant_id, "approaching limit")
            return BudgetStatus.SOFT_EXCEEDED

        return BudgetStatus.OK

    async def track_usage(self, tenant_id: str, actual_tokens: int, model: str):
        # Record in real-time for billing
        await self.metering_stream.emit({
            "tenant_id": tenant_id,
            "event_type": "llm_tokens",
            "quantity": actual_tokens,
            "model": model,
            "timestamp": datetime.utcnow().isoformat()
        })
```

### 4.3 Rate Limiting Architecture

**Three-Tier Rate Limiting:**

| Tier | Scope | Store | Purpose |
|------|-------|-------|---------|
| **Edge** | IP / API key | Cloudflare / AWS WAF | DDoS protection, basic throttling |
| **Gateway** | User / Organization | Redis (sliding window) | Per-tenant fairness, plan enforcement |
| **Service** | Operation type | In-memory (per pod) | Internal backpressure, circuit breaking |

**Sliding Window Algorithm:**

```python
import redis.asyncio as redis

class SlidingWindowRateLimiter:
    def __init__(self, redis: redis.Redis):
        self.redis = redis

    async def is_allowed(self, key: str, limit: int, window: int) -> bool:
        now = time.time()
        window_start = now - window

        pipe = self.redis.pipeline()
        pipe.zremrangebyscore(key, 0, window_start)  # Clean old entries
        pipe.zcard(key)  # Count current entries
        pipe.zadd(key, {str(now): now})  # Add current request
        pipe.expire(key, window)
        results = await pipe.execute()

        current_count = results[1]
        return current_count < limit
```

### 4.4 Concurrent Job Limits

- Each tenant has a dedicated job queue (Redis Stream / RabbitMQ queue)
- Workers pull from tenant queues in round-robin fashion (fair scheduling)
- A tenant's queue depth is capped; new jobs are rejected with `429 Queue Full`
- Enterprise tenants can purchase dedicated worker pools

---

## 5. Billing & Metering Architecture

### 5.1 Event-Driven Metering

Every billable action emits an event to the metering stream:

```json
{
  "event_id": "evt_abc123",
  "event_type": "llm_tokens",
  "tenant_id": "org_def456",
  "user_id": "user_ghi789",
  "job_id": "job_jkl012",
  "timestamp": "2026-05-29T12:00:00Z",
  "quantity": 15420,
  "unit": "tokens",
  "properties": {
    "model": "claude-sonnet-4-20250514",
    "input_tokens": 3420,
    "output_tokens": 12000,
    "pipeline_node": "environment_generation",
    "environment_id": "env_mno345"
  },
  "cost_cents": 46  // Pre-calculated based on model pricing
}
```

**Event Types:**

| Event Type | Unit | Description |
|------------|------|-------------|
| `llm_tokens` | tokens | Input + output tokens across all models |
| `llm_requests` | requests | Number of API calls to LLM providers |
| `sandbox_compute` | seconds | CPU time consumed in sandboxes |
| `sandbox_memory` | GB-seconds | Memory × time in sandboxes |
| `storage_observability` | GB | Trace/metrics/dataset storage |
| `storage_artifacts` | GB | Generated code, exports, attachments |
| `api_requests` | requests | API calls to Eden's REST API |
| `dataset_exports` | exports | Full dataset downloads |
| `benchmark_runs` | runs | Executions of benchmark suites |
| `environment_generations` | generations | Full pipeline runs |

### 5.2 Metering Pipeline

```
Application → Kafka (raw events, 7-day retention)
                  ↓
            Flink / ksqlDB (real-time aggregation)
                  ↓
            ClickHouse (hourly rollups, queryable)
                  ↓
            Billing Engine (daily invoicing)
                  ↓
            Stripe / Lago (invoice generation + payment)
```

**Aggregation Windows:**
- **Real-time:** 1-minute sliding window for quota enforcement
- **Hourly:** Aggregated for tenant dashboards
- **Daily:** Used for invoice line items
- **Monthly:** Final billing cycle

### 5.3 Cost Attribution

Every cost is attributed to:

1. **Tenant** (who pays)
2. **User** (who initiated the action)
3. **Job** (which pipeline execution)
4. **Environment** (which generated artifact)
5. **Model** (which LLM provider)

This enables detailed cost analysis:

```sql
SELECT 
  tenant_id,
  environment_id,
  model,
  SUM(cost_cents) as total_cost,
  SUM(quantity) as total_tokens
FROM metering_events
WHERE date_trunc('month', timestamp) = '2026-05-01'
GROUP BY tenant_id, environment_id, model
ORDER BY total_cost DESC;
```

### 5.4 Billing Engine

**Invoice Generation:**

```python
class BillingEngine:
    async def generate_invoice(self, tenant_id: str, billing_period: str) -> Invoice:
        # 1. Pull aggregated usage
        usage = await self.clickhouse.get_usage(tenant_id, billing_period)

        # 2. Apply plan pricing
        plan = await self.get_plan(tenant_id)
        line_items = []

        for usage_type, quantity in usage.items():
            included = plan.get_included_quantity(usage_type)
            overage = max(0, quantity - included)
            rate = plan.get_overage_rate(usage_type)
            cost = overage * rate

            line_items.append(LineItem(
                description=f"{usage_type} usage",
                quantity=quantity,
                included=included,
                overage=overage,
                rate=rate,
                cost=cost
            ))

        # 3. Add base subscription fee
        line_items.append(LineItem(
            description=f"{plan.name} plan",
            quantity=1,
            cost=plan.base_price_cents
        ))

        # 4. Create invoice
        return Invoice(
            tenant_id=tenant_id,
            period=billing_period,
            line_items=line_items,
            total=sum(item.cost for item in line_items),
            due_date=self.calculate_due_date()
        )
```

### 5.5 Payment Integration

- **Stripe:** Primary payment processor (cards, ACH, wire for enterprise)
- **Usage-based billing:** Stripe Metered Billing for high-volume events
- **Invoicing:** Net-30 for enterprise customers; auto-charge for self-serve
- **Tax:** Stripe Tax for automatic sales tax/VAT calculation
- **Credits:** Pre-purchased credits with volume discounts (enterprise)

---

## 6. Pricing Models

### 6.1 Plan Tiers

| Feature | Personal (Free) | Team ($49/mo) | Growth ($299/mo) | Enterprise (Custom) |
|---------|----------------|---------------|------------------|---------------------|
| Users | 1 | Up to 20 | Up to 100 | Unlimited |
| Environments | 10 | 100 | 500 | Unlimited |
| LLM tokens / mo | 100K | 2M | 10M | Custom |
| Sandbox hours / mo | 10h | 100h | 500h | Custom |
| Storage | 1GB | 50GB | 250GB | Custom |
| Support | Community | Email | Priority | Dedicated Slack |
| SSO | ❌ | ❌ | ✅ | ✅ |
| Audit logs | 7 days | 30 days | 90 days | 1 year |
| Data residency | ❌ | ❌ | ✅ | ✅ |
| Custom models | ❌ | ❌ | ✅ | ✅ |

### 6.2 Overage Pricing

| Resource | Included | Overage Rate |
|----------|----------|--------------|
| LLM tokens | Plan quota | $0.000015 / token (blended) |
| Sandbox compute | Plan quota | $0.05 / minute |
| Storage | Plan quota | $0.10 / GB / month |
| API requests | Plan quota | $0.001 / 1,000 requests |

### 6.3 Enterprise Pricing

- **Annual contracts** with committed usage (discounts up to 40%)
- **Dedicated infrastructure** option (single-tenant deployment)
- **Custom SLA** (99.9% uptime, 15-min support response)
- **Professional services** (onboarding, custom environment templates)
- **Revenue share** option for partners embedding Eden

---

## 7. Tenant-Aware Caching

### 7.1 Cache Hierarchy

| Layer | Scope | Technology | TTL | Use Case |
|-------|-------|------------|-----|----------|
| **CDN** | Global | Cloudflare | 1 hour | Static docs, marketing assets |
| **Application** | Tenant-scoped | Redis | 5 min | User sessions, feature flags |
| **Query** | Tenant-scoped | Redis | 1 min | Repeated API queries |
| **Semantic** | Tenant-scoped | Redis / in-memory | 10 min | Embedding caches |
| **Model Response** | Tenant-scoped | Redis | 1 hour | Exact/same prompt caching |

### 7.2 Cache Key Naming

All cache keys include tenant isolation:

```
eden:{tenant_id}:{resource_type}:{resource_id}:{version}

Examples:
- eden:org_abc:env:env_def:v1.2.3     # Environment code cache
- eden:org_abc:kb:pattern:semantic:hash  # Semantic KB result
- eden:org_abc:user:session:{session_id} # Session data
- eden:org_abc:llm:cache:{prompt_hash}   # LLM response cache
```

### 7.3 Cache Invalidation

| Trigger | Action |
|---------|--------|
| Environment updated | Invalidate `eden:{tenant_id}:env:{env_id}:*` |
| KB entry modified | Invalidate `eden:{tenant_id}:kb:*` |
| User role changed | Invalidate `eden:{tenant_id}:user:{user_id}:*` |
| Plan upgraded | Invalidate `eden:{tenant_id}:quota:*` |
| Tenant deletion | Delete `eden:{tenant_id}:*` (Redis SCAN + DEL) |

---

## 8. Data Residency & Regional Deployment

### 8.1 Region Map

| Region | Location | Compliance |
|--------|----------|------------|
| `us-east` | Virginia, USA | SOC 2, HIPAA |
| `us-west` | Oregon, USA | SOC 2 |
| `eu-west` | Ireland | GDPR |
| `eu-central` | Frankfurt, Germany | GDPR, BSI C5 |
| `ap-southeast` | Singapore | PDPA, SOC 2 |
| `ap-northeast` | Tokyo, Japan | APPI, SOC 2 |

### 8.2 Control Plane / Data Plane Separation

```
Global Control Plane (us-east)
├── Authentication (OAuth, API keys)
├── Billing (Stripe integration)
├── Global KB (read-only replicas)
└── Admin tooling

Regional Data Plane (tenant-selected)
├── Compute (Kubernetes clusters)
├── PostgreSQL (tenant databases)
├── ClickHouse (observability)
├── Vector DB (embeddings)
├── Object Storage (S3 regional)
└── LLM proxy (regional egress)
```

### 8.3 Cross-Region Replication

- **Disaster recovery:** Daily snapshots to a secondary region
- **Read replicas:** Global KB has read replicas in all regions
- **No live replication of tenant data** without explicit opt-in

---

## 9. Tenant Onboarding & Provisioning

### 9.1 Self-Service Onboarding Flow

```
Sign Up → Email verification → Organization creation → Plan selection
  ↓
Region selection → Payment (if paid) → Provisioning → Welcome tutorial
  ↓
Team invitation → First environment generation
```

**Time to first environment:** < 5 minutes for self-serve

### 9.2 Automated Provisioning

```python
class TenantProvisioner:
    async def provision(self, org_id: str, plan: Plan, region: str):
        # 1. Create database schema
        await self.postgres.create_schema(f"tenant_{org_id}")

        # 2. Initialize tables
        await self.postgres.run_migrations(f"tenant_{org_id}")

        # 3. Create Vault path
        await self.vault.enable_engine(f"eden/tenants/{org_id}")

        # 4. Set up Redis namespace
        await self.redis.set(f"eden:{org_id}:initialized", "true")

        # 5. Configure quotas in Redis
        await self.redis.hset(f"eden:{org_id}:quotas", mapping=plan.quotas)

        # 6. Create S3 prefix
        await self.s3.create_prefix(f"eden-tenants/{org_id}/")

        # 7. Deploy regional resources (if dedicated)
        if plan.dedicated:
            await self.k8s.create_namespace(f"eden-{org_id}")
            await self.k8s.apply_resource_limits(f"eden-{org_id}", plan.resources)

        # 8. Seed default KB entries
        await self.kb.seed_global_patterns(org_id)

        # 9. Emit provisioning event
        await self.metering.emit({
            "event_type": "tenant_provisioned",
            "tenant_id": org_id,
            "plan": plan.name,
            "region": region
        })
```

### 9.3 Enterprise Onboarding

- **White-glove setup:** Dedicated solutions engineer
- **Custom contracts:** MSA, DPA, BAA as needed
- **SSO configuration:** SAML/OIDC setup assistance
- **Migration assistance:** Import existing environments from other tools
- **Security review:** Shared security questionnaire, architecture review call

---

## 10. Noisy Neighbor Mitigation

### 10.1 Fair Share Scheduling

Worker nodes use a **weighted fair queuing** algorithm:

```python
class FairShareScheduler:
    def __init__(self):
        self.tenant_weights = {}  # Based on plan tier
        self.tenant_queues = {}

    def select_next_job(self) -> Job:
        # Calculate virtual finish time for each tenant's head job
        candidates = []
        for tenant_id, queue in self.tenant_queues.items():
            if queue:
                job = queue[0]
                weight = self.tenant_weights.get(tenant_id, 1.0)
                virtual_finish = job.virtual_start + (job.estimated_cost / weight)
                candidates.append((virtual_finish, tenant_id, job))

        # Pick the job with earliest virtual finish time
        candidates.sort(key=lambda x: x[0])
        return candidates[0][2]
```

### 10.2 Resource Limits per Tenant

```yaml
# Kubernetes ResourceQuota per tenant namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-abc-limits
  namespace: eden-org-abc
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "50"
```

### 10.3 Auto-Throttling

- **CPU throttling:** cgroup-based when tenant exceeds CPU share
- **Token rate limiting:** Dynamic reduction of API rate limits under load
- **Model routing downgrade:** Route to cheaper/slower models when budget is tight
- **Queue shedding:** Reject new jobs with 429 when queue depth exceeds 10× concurrent limit

### 10.4 Noisy Neighbor Detection

```python
class NoisyNeighborDetector:
    async def detect(self, tenant_id: str, window_minutes: int = 5):
        metrics = await self.get_metrics(tenant_id, window_minutes)

        alerts = []

        # CPU usage > 5x median of all tenants
        if metrics.cpu_usage > self.get_median_cpu() * 5:
            alerts.append("cpu_spike")

        # Error rate > 10%
        if metrics.error_rate > 0.10:
            alerts.append("high_error_rate")

        # Token usage > 2x their historical average
        if metrics.token_usage > self.get_historical_average(tenant_id) * 2:
            alerts.append("token_spike")

        if alerts:
            await self.notify_ops(tenant_id, alerts)
            await self.apply_mitigation(tenant_id, alerts)
```

---

## 11. Operational Tools for Admins

### 11.1 Tenant Admin Dashboard

- **Usage analytics:** Real-time token usage, sandbox hours, storage
- **Cost explorer:** Drill down by user, environment, model, time period
- **Quota management:** View current usage vs limits, request increases
- **Team management:** Invite users, assign roles, deactivate accounts
- **Audit log viewer:** Search and filter all actions in the organization
- **Security settings:** MFA enforcement, SSO config, API key rotation
- **Data exports:** Self-service data portability (GDPR)

### 11.2 Platform Admin Tools

- **Tenant health dashboard:** All tenants, their usage, alerts, support tickets
- **Capacity planning:** Forecast resource needs based on growth trends
- **Billing reconciliation:** Match metering events to Stripe invoices
- **Fraud detection:** Identify abnormal usage patterns (token farming, reselling)
- **Support escalation:** View tenant context for support tickets

---

## 12. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–4)
- [ ] Implement schema-per-tenant PostgreSQL setup
- [ ] Deploy tenant-aware connection pooling (PgBouncer)
- [ ] Build organization & user model with roles
- [ ] Implement Redis-based rate limiting per tenant
- [ ] Deploy basic quota enforcement (hard limits)

### Phase 2: Billing (Weeks 5–8)
- [ ] Build event-driven metering pipeline (Kafka + ClickHouse)
- [ ] Integrate Stripe for subscription and usage-based billing
- [ ] Implement cost attribution (tenant → user → job → model)
- [ ] Build tenant usage dashboard in portal
- [ ] Deploy automatic invoice generation

### Phase 3: Governance (Weeks 9–12)
- [ ] Implement fair-share job scheduling
- [ ] Add noisy neighbor detection and auto-throttling
- [ ] Deploy tenant-aware caching with proper namespacing
- [ ] Build self-service onboarding flow
- [ ] Implement data residency controls (region pinning)

### Phase 4: Enterprise (Weeks 13–16)
- [ ] Add SSO/SAML support
- [ ] Implement dedicated tenant namespaces (Kubernetes)
- [ ] Build enterprise onboarding white-glove flow
- [ ] Add custom contract and invoicing support
- [ ] Deploy professional services tooling

---

*This document should be read alongside [`eden-security-architecture.md`](./eden-security-architecture.md) for security controls and [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) for the core platform architecture.*
