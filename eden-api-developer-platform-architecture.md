# Eden — API & Developer Platform Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define the public API surface, SDK design, webhook architecture, and developer experience patterns that make Eden the easiest platform to integrate for environment generation and agent evaluation.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Protocol Selection](#2-protocol-selection)
3. [API Versioning Strategy](#3-api-versioning-strategy)
4. [REST API Design](#4-rest-api-design)
5. [Streaming Architecture](#5-streaming-architecture)
6. [Webhook System](#6-webhook-system)
7. [SDK Design](#7-sdk-design)
8. [CLI Design](#8-cli-design)
9. [API Gateway](#9-api-gateway)
10. [Documentation & Developer Experience](#10-documentation--developer-experience)
11. [Implementation Roadmap](#11-implementation-roadmap)

---

## 1. Strategic Thesis

Eden is a developer platform first. The quality of the API and SDK determines whether developers build on Eden or abandon it for a competitor. Every design decision prioritizes:

1. **Predictability:** The API behaves exactly as documented. No surprises.
2. **Ergonomics:** The SDK feels native to the language (idiomatic Python, idiomatic TypeScript).
3. **Observability:** Every request is traceable. Every error is actionable.
4. **Resilience:** The SDK handles retries, backoff, and failover automatically.
5. **Composability:** Eden primitives compose cleanly into larger workflows.

---

## 2. Protocol Selection

### 2.1 Public API: REST + Server-Sent Events (SSE)

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Base Protocol** | HTTP/3 over REST | Broad compatibility, CDN-friendly, excellent tooling |
| **Streaming** | SSE (`text/event-stream`) | Standard HTTP, auto-reconnect, works through corporate proxies and CDNs |
| **Real-time** | SSE for server→client, POST for client→server | Unidirectional streaming is sufficient for Eden's use case (job progress, trace logs) |
| **Internal** | gRPC (Protobuf) | Binary serialization, full-duplex, schema evolution for service-to-service |

### 2.2 Why Not WebSockets
- WebSockets require persistent connections that break through corporate proxies and load balancers
- SSE auto-reconnects with `Last-Event-ID` for gapless resumption
- Eden's streaming is unidirectional (server→client progress updates) — SSE is purpose-built for this
- No need for bidirectional real-time chat in the core API

### 2.3 Why Not GraphQL for Core
- GraphQL adds complexity for simple CRUD operations (job creation, status checks)
- Better suited for the dashboard/admin API (complex data fetching)
- Core API is resource-oriented: `POST /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/stream`

---

## 3. API Versioning Strategy

### 3.1 Date-Based Versioning
Following Stripe's proven model:

```
X-API-Version: 2026-05-29
```

- **Header-based:** Not in the URL path. Clean, bookmarkable URLs.
- **Date-stamped:** Pin integrations to a specific date. Breaking changes only affect new dates.
- **Backward compatible:** Old versions continue working indefinitely.
- **Model-pinned:** API surface is stable. New models are added via `/models` endpoint, not API version bumps.

### 3.2 Version Lifecycle

```
Release → Beta (2 weeks) → GA → Stable (12 months) → Deprecated (6 months) → Sunset
```

- **Beta:** Available but not documented in default docs. Subject to change.
- **GA:** Fully documented, SLAs apply.
- **Stable:** Default for new integrations.
- **Deprecated:** Still works, but warnings in SDKs and docs. Migration guide published.
- **Sunset:** Returns 410 Gone with link to migration guide.

### 3.3 Breaking Change Policy
A change is "breaking" if it:
- Removes a field from a response (unless marked `nullable` and already returning `null`)
- Changes the type of an existing field
- Removes an endpoint or HTTP method
- Changes error status codes for existing error conditions
- Changes rate limit behavior

Non-breaking (safe) changes:
- Adding new optional fields to responses
- Adding new endpoints
- Adding new enum values (SDKs must handle unknown values gracefully)
- Relaxing validation rules

---

## 4. REST API Design

### 4.1 Base URL & Authentication

```
Production:  https://api.eden.ai/v1/
Staging:     https://api.staging.eden.ai/v1/
Sandbox:     https://api.sandbox.eden.ai/v1/  (free, isolated, auto-reset)
```

Authentication via `Authorization: Bearer <api_key>` header. API keys are scoped (see Section 9).

### 4.2 Resource Structure

```
POST   /v1/jobs                          # Create environment generation job
GET    /v1/jobs/{job_id}                  # Get job status and metadata
GET    /v1/jobs/{job_id}/stream           # SSE stream of job progress
DELETE /v1/jobs/{job_id}                  # Cancel a running job
GET    /v1/jobs/{job_id}/artifacts        # List generated artifacts
GET    /v1/jobs/{job_id}/artifacts/{id}   # Download specific artifact

POST   /v1/environments                  # Register an environment
GET    /v1/environments/{env_id}          # Get environment metadata
POST   /v1/environments/{env_id}/run     # Run an agent in an environment
GET    /v1/environments/{env_id}/runs      # List runs
GET    /v1/environments/{env_id}/runs/{id} # Get run details with traces

POST   /v1/benchmarks                    # Create a benchmark suite
GET    /v1/benchmarks/{id}               # Get benchmark definition
POST   /v1/benchmarks/{id}/execute       # Run benchmark
GET    /v1/benchmarks/{id}/results       # Get benchmark results

POST   /v1/datasets                      # Create a dataset from traces
GET    /v1/datasets/{id}                  # Get dataset metadata
GET    /v1/datasets/{id}/download         # Download dataset

GET    /v1/observability/traces           # List traces (cursor pagination)
GET    /v1/observability/traces/{id}      # Get single trace with spans
GET    /v1/observability/metrics          # Time-series metrics
GET    /v1/observability/insights         # Generated insights

GET    /v1/models                         # List available models
GET    /v1/models/{id}/pricing            # Get pricing for a model
```

### 4.3 Request/Response Patterns

#### Standard Envelope
Every response wraps data in a consistent envelope:

```json
{
  "object": "job",
  "id": "job_2vPqN9LkXjR4",
  "data": { ... },
  "meta": {
    "request_id": "req_8fJ2mL9kPqR3",
    "timestamp": "2026-05-29T14:32:01Z",
    "api_version": "2026-05-29"
  }
}
```

#### Error Format
```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "environment_class_unsupported",
    "message": "The environment class 'rl_training' is not supported. Supported classes: agent_sandbox, llm_agent_eval, tool_use, multi_agent, adversarial, simulation, custom.",
    "param": "environment_class",
    "request_id": "req_8fJ2mL9kPqR3"
  }
}
```

Error types:
- `invalid_request_error` — Bad request (400)
- `authentication_error` — Invalid API key (401)
- `permission_error` — Insufficient permissions (403)
- `not_found_error` — Resource not found (404)
- `rate_limit_error` — Rate limit exceeded (429)
- `internal_error` — Server error (500)
- `timeout_error` — Request timeout (504)

### 4.4 Idempotency
All mutating endpoints support idempotency:

```
Idempotency-Key: <uuid>
```

- The same key + endpoint + payload returns the same response for 24 hours
- Keys are automatically purged after 24 hours
- Duplicate requests with the same key return the cached response (not re-executed)

---

## 5. Streaming Architecture

### 5.1 SSE Event Types

```
GET /v1/jobs/{job_id}/stream
Accept: text/event-stream
```

Event stream format:

```
event: job.status
data: {"status": "running", "stage": "designing", "progress": 0.25}

event: job.stage_complete
data: {"stage": "spec_generation", "duration_sec": 12.4, "output_summary": "Generated 3-file spec"}

event: job.agent_action
data: {"agent": "designer", "action": "writing_file", "file": "environment.py", "lines": 47}

event: job.agent_thought
data: {"agent": "reviewer", "thought": "Checking for race conditions in the state manager..."}

event: job.error
data: {"stage": "implementation", "error_type": "syntax_error", "message": "Unexpected indent at line 142", "recoverable": true}

event: job.complete
data: {"status": "completed", "artifacts": ["env_abc123"], "metrics": {"total_time_sec": 142, "total_tokens": 45231}}
```

### 5.2 Reconnection & Gapless Resume
```
GET /v1/jobs/{job_id}/stream?after_event=evt_456
```

- Clients disconnected for <30s: auto-reconnect, server buffers events
- Clients disconnected for >30s: use `?after_event={last_seen_id}` to resume from gap
- Events stored in Redis Streams for 1 hour (configurable)

### 5.3 SDK Streaming Interface

```python
# Python SDK
import eden

client = eden.Client(api_key="sk_...")

job = client.jobs.create(
    description="Create a multi-tool agent sandbox with memory",
    environment_class="agent_sandbox"
)

for event in client.jobs.stream(job.id):
    if event.type == "job.stage_complete":
        print(f"✓ {event.stage} complete ({event.duration_sec}s)")
    elif event.type == "job.agent_action":
        print(f"  {event.agent}: {event.action}")
    elif event.type == "job.error" and not event.recoverable:
        print(f"✗ Fatal error: {event.message}")
        break
    elif event.type == "job.complete":
        print(f"✓ Job complete! Artifacts: {event.artifacts}")
```

```typescript
// TypeScript SDK
import { EdenClient } from '@eden/sdk';

const client = new EdenClient({ apiKey: 'sk_...' });

const job = await client.jobs.create({
  description: 'Create a multi-tool agent sandbox with memory',
  environmentClass: 'agent_sandbox'
});

const stream = client.jobs.stream(job.id);

for await (const event of stream) {
  switch (event.type) {
    case 'job.stage_complete':
      console.log(`✓ ${event.stage} complete (${event.durationSec}s)`);
      break;
    case 'job.error':
      if (!event.recoverable) {
        console.error(`✗ Fatal error: ${event.message}`);
        stream.cancel();
      }
      break;
    case 'job.complete':
      console.log(`✓ Job complete! Artifacts: ${event.artifacts}`);
      break;
  }
}
```

---

## 6. Webhook System

### 6.1 Purpose
Notify external systems when async jobs complete, benchmarks finish, or insights are generated — without polling.

### 6.2 Webhook Event Types

| Event Type | Description | Payload Size |
|------------|-------------|--------------|
| `job.completed` | Environment generation finished | ~2KB (metadata + artifact IDs) |
| `job.failed` | Job failed with error details | ~1KB |
| `benchmark.completed` | Benchmark run finished | ~5KB (summary metrics) |
| `insight.generated` | New insight from observability | ~3KB |
| `dataset.ready` | Dataset export completed | ~1KB (download URL) |

### 6.3 Webhook Payload Structure

```json
{
  "id": "evt_2vPqN9LkXjR4",
  "object": "event",
  "type": "job.completed",
  "created_at": "2026-05-29T14:32:01Z",
  "api_version": "2026-05-29",
  "data": {
    "object": "job",
    "id": "job_8fJ2mL9kPqR3",
    "status": "completed",
    "artifacts": ["env_abc123"],
    "metrics": {
      "total_time_sec": 142,
      "total_tokens": 45231,
      "cost_usd": 0.847
    }
  }
}
```

### 6.4 Delivery Guarantees
- **At-least-once delivery:** Webhooks may be delivered multiple times. Consumers must handle idempotency via `evt_` ID.
- **Retry schedule:** 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s (10 attempts over ~17 minutes)
- **Dead letter queue:** After 10 failures, events moved to DLQ for manual inspection
- **Signature verification:** Every webhook signed with HMAC-SHA256:
  ```
  X-Eden-Signature: t=1716993121,v1=sha256=...
  ```

### 6.5 Webhook Registration

```python
# Register a webhook endpoint
client.webhooks.create(
    url="https://my-app.com/webhooks/eden",
    events=["job.completed", "job.failed", "benchmark.completed"],
    secret="whsec_..."  # For signature verification
)
```

---

## 7. SDK Design

### 7.1 Python SDK: `eden-py`

#### Installation
```bash
pip install eden
```

#### Core Philosophy
- **Async-first:** All I/O operations are async. Sync wrappers provided for convenience.
- **Type-safe:** Full type hints, `mypy` compatible, Pydantic models for all API objects.
- **Auto-retry:** Exponential backoff with jitter for 5xx and rate limit errors.
- **Resource-oriented:** API mapped to Python classes: `client.jobs.create()`, `client.environments.run()`.

#### Code Example
```python
import asyncio
import eden

async def main():
    client = eden.AsyncClient(api_key="sk_...")
    
    # Create and stream a job
    job = await client.jobs.create(
        description="Create a tool-use evaluation environment",
        environment_class="tool_use",
        framework="langchain",
        complexity="medium"
    )
    
    async for event in client.jobs.stream(job.id):
        print(f"[{event.stage}] {event.status}")
    
    # Get the generated environment
    env = await client.environments.get(job.artifacts[0])
    
    # Run an agent in the environment with full observability
    run = await client.environments.run(
        env.id,
        agent=eden.AgentConfig(
            model="claude-sonnet-4",
            system_prompt="You are a helpful assistant...",
            tools=["search", "calculator"]
        ),
        trace=True  # Enable full trace collection
    )
    
    # Get traces and insights
    traces = await client.observability.traces.list(run_id=run.id)
    insights = await client.observability.insights.generate(run_id=run.id)
    
    print(f"Agent completed in {run.duration_ms}ms")
    print(f"Insight: {insights.summary}")

asyncio.run(main())
```

#### Context Manager for Auto-Cleanup
```python
async with eden.AsyncClient(api_key="sk_...") as client:
    job = await client.jobs.create(...)
    # Client session auto-closed on exit
```

### 7.2 TypeScript SDK: `@eden/sdk`

#### Installation
```bash
npm install @eden/sdk
```

#### Core Philosophy
- **Promise-based:** Modern async/await throughout.
- **Tree-shakeable:** Import only what you need (`import { JobsAPI } from '@eden/sdk/jobs'`).
- **Runtime validation:** Zod schemas for response validation (catches API drift).
- **Streaming iterators:** Native async generators for SSE streams.

#### Code Example
```typescript
import { EdenClient } from '@eden/sdk';

const client = new EdenClient({
  apiKey: process.env.EDEN_API_KEY,
  maxRetries: 3,
  timeout: 300_000  // 5 minutes for long-running jobs
});

async function generateEnvironment() {
  // Create job with streaming
  const job = await client.jobs.create({
    description: 'Create a multi-agent negotiation environment',
    environmentClass: 'multi_agent',
    framework: 'langgraph'
  });
  
  const stream = client.jobs.stream(job.id);
  
  for await (const event of stream) {
    if (event.type === 'job.complete') {
      console.log('Environment generated:', event.artifacts);
    }
  }
  
  // Register webhook for future jobs
  await client.webhooks.create({
    url: 'https://my-app.com/webhooks/eden',
    events: ['job.completed'],
    secret: process.env.WEBHOOK_SECRET!
  });
}
```

### 7.3 Auto-Instrumentation
```python
# Automatically trace any OpenAI/Anthropic/LangChain call
import eden
from eden.trace import auto_instrument

auto_instrument()  # One-line setup

# All subsequent LLM calls are automatically traced
# and sent to Eden's observability platform
import openai
response = openai.chat.completions.create(...)  # Traced automatically
```

---

## 8. CLI Design

### 8.1 Installation
```bash
pip install eden[cli]
# or
npm install -g @eden/cli
```

### 8.2 Command Structure
```
eden
├── auth
│   ├── login          # OAuth login
│   ├── logout         # Clear credentials
│   └── whoami         # Show current user
├── jobs
│   ├── create         # Create a new job
│   ├── list           # List recent jobs
│   ├── get            # Get job details
│   ├── stream         # Stream job progress
│   ├── logs           # Get job logs
│   └── cancel         # Cancel a running job
├── environments
│   ├── list           # List environments
│   ├── get            # Get environment details
│   ├── run            # Run an agent in an environment
│   ├── test           # Run environment test suite
│   └── export         # Export environment to local directory
├── benchmarks
│   ├── create         # Define a benchmark suite
│   ├── list           # List benchmarks
│   ├── run            # Execute a benchmark
│   └── compare        # Compare two benchmark runs
├── observability
│   ├── traces         # Query traces
│   ├── insights       # View generated insights
│   ├── datasets       # Manage datasets
│   └── dashboard      # Open browser dashboard
├── config
│   ├── get            # Get config value
│   ├── set            # Set config value
│   └── list           # List all config
└── models
    ├── list           # List available models
    └── pricing        # Show model pricing
```

### 8.3 Interactive Experience
```bash
$ eden jobs create
? Describe the environment you need: multi-tool agent sandbox with memory and dynamic tool discovery
? Environment class: agent_sandbox
? Framework: langchain
? Complexity: medium
? Auto-run tests after generation? Yes
✓ Job created: job_8fJ2mL9kPqR3
✓ Streaming progress...
  [spec_generator] ✓ Complete (12s)
  [designer]     ✓ Complete (28s)
  [implementer]  ✓ Complete (45s)
  [reviewer]     ✓ Complete (18s)
  [tests]        ✓ 47/47 passed
✓ Environment ready: env_abc123

$ eden environments export env_abc123 --dir ./my-env
✓ Exported 12 files to ./my-env/
```

### 8.4 Configuration
```bash
# Global config
$ eden config set api_key sk_...
$ eden config set default_model claude-sonnet-4
$ eden config set organization org_...

# Project-level config (.eden.yaml)
$ cat .eden.yaml
organization: org_abc123
default_environment_class: agent_sandbox
observability:
  auto_trace: true
  trace_level: detailed
webhooks:
  url: https://my-app.com/webhooks/eden
```

---

## 9. API Gateway

### 9.1 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      API GATEWAY                             │
├──────────────────────────────────────────────────────────────┤
│  Authentication                                              │
│  • API key extraction & validation                          │
│  • Tenant resolution from key                               │
│  • JWT token validation (for dashboard sessions)              │
├──────────────────────────────────────────────────────────────┤
│  Rate Limiting                                               │
│  • Token bucket per tenant (requests/sec, tokens/min)         │
│  • Burst allowance for interactive use                       │
│  • Different tiers: Free, Pro, Enterprise                  │
├──────────────────────────────────────────────────────────────┤
│  Request Transformation                                      │
│  • Version header injection                                │
│  • Request ID propagation (X-Request-ID)                     │
│  • PII redaction (pre-logging)                             │
├──────────────────────────────────────────────────────────────┤
│  Routing                                                     │
│  • Path-based routing to internal services                  │
│  • Canary traffic splitting (for new API versions)          │
│  • Health check-based failover                              │
├──────────────────────────────────────────────────────────────┤
│  Observability                                               │
│  • Request/response logging (with PII masking)               │
│  • Latency histograms (P50, P95, P99)                        │
│  • Error rate tracking per endpoint                         │
│  • Token usage attribution per tenant                      │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 Rate Limit Tiers

| Tier | Jobs/min | Tokens/min | Concurrent Jobs | Concurrent Streams |
|------|----------|------------|-----------------|-------------------|
| Free | 1 | 10K | 1 | 1 |
| Pro | 10 | 100K | 5 | 10 |
| Enterprise | Custom | Custom | Custom | Custom |

Rate limit headers on every response:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1716993600
X-RateLimit-Token-Limit: 100000
X-RateLimit-Token-Remaining: 84321
```

### 9.3 API Key Scopes
API keys can be restricted by:
- **Endpoints:** `jobs:write`, `jobs:read`, `environments:*`, `observability:read`
- **Models:** Only specific model families
- **Environments:** Only specific environment classes
- **IP allowlist:** Restrict to specific IP ranges
- **Expiration:** Time-limited keys for CI/CD

```python
# Create a scoped key for CI/CD
cclient.api_keys.create(
    name="ci-cd-key",
    scopes=["jobs:write", "jobs:read", "benchmarks:write"],
    expires_at="2026-06-29T00:00:00Z",
    ip_allowlist=["192.168.1.0/24"]
)
```

---

## 10. Documentation & Developer Experience

### 10.1 Documentation Layers

| Layer | Content | Format |
|-------|---------|--------|
| **API Reference** | Every endpoint, parameter, response | Auto-generated OpenAPI + interactive playground |
| **SDK Reference** | Every class, method, type | Auto-generated from docstrings + type hints |
| **Guides** | Tutorials, how-tos, common patterns | Markdown + interactive code sandboxes |
| **Cookbook** | Copy-paste examples for common tasks | Jupyter notebooks + GitHub repo |
| **Changelog** | Every change, migration guides | RSS feed + email newsletter |

### 10.2 OpenAPI Specification
- Auto-generated from FastAPI route decorators
- Published at `https://api.eden.ai/openapi.json`
- Interactive docs at `https://docs.eden.ai/api`
- SDKs auto-generated from OpenAPI spec (using OpenAPI Generator)

### 10.3 Interactive Playground
- In-browser API explorer with real request/response
- Pre-filled examples for every endpoint
- Environment variable injection for API keys
- Copy-as-curl, copy-as-python, copy-as-typescript

### 10.4 Developer Onboarding
```
1. Sign up → Instant sandbox API key
2. First request in 30 seconds (interactive tutorial)
3. Run first environment generation (guided wizard)
4. Export and run locally (CLI walkthrough)
5. Set up observability (one-line auto_instrument())
6. Join Discord community
```

### 10.5 Status Page
- `status.eden.ai` — real-time system status
- Historical uptime graphs
- Incident history with post-mortems
- Subscribe to alerts (email, Slack, webhook)

---

## 11. Implementation Roadmap

### Phase 1: Core API (Weeks 1-4)
- [ ] REST API for jobs, environments, benchmarks (FastAPI)
- [ ] SSE streaming for job progress
- [ ] API key authentication + basic rate limiting
- [ ] Python SDK v1 (async + sync)
- [ ] OpenAPI spec generation + interactive docs

### Phase 2: Developer Experience (Weeks 5-8)
- [ ] TypeScript SDK v1
- [ ] CLI with interactive prompts
- [ ] Webhook system with signature verification
- [ ] Auto-instrumentation for OpenAI/Anthropic
- [ ] Cursor-based pagination for all list endpoints

### Phase 3: Enterprise (Weeks 9-12)
- [ ] Scoped API keys with permission system
- [ ] Advanced rate limiting (token budgets)
- [ ] gRPC internal API for service-to-service
- [ ] Webhook retry logic + dead letter queue
- [ ] Sandbox environment for testing
- [ ] Full SDK reference auto-generation

---

## Cross-References

| This Document References | For |
|--------------------------|-----|
| [`eden-realtime-streaming-architecture.md`](./eden-realtime-streaming-architecture.md) | Low-level SSE implementation, WebSocket internals, stream processing |
| [`eden-security-architecture.md`](./eden-security-architecture.md) | API key management, authentication, PII filtering, request signing |
| [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md) | Tenant isolation, rate limiting tiers, usage-based pricing |
| [`eden-sdk-integration-architecture.md`](./eden-sdk-integration-architecture.md) | Deeper SDK design patterns, plugin architecture, IDE integrations |
| [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) | Core platform architecture, pipeline nodes, job execution model |
