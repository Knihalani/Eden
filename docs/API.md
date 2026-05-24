# Eden API Reference

## Base URL

```
http://localhost:8000
```

All endpoints return JSON. All timestamps are ISO 8601 UTC.

---

## Authentication

Currently no authentication required. Production deployment should include API key authentication.

---

## Endpoints

### Health Check

```
GET /health
```

Returns system health status including version and connection states.

**Response `200 OK`:**
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "postgres": "connected",
  "qdrant": "connected",
  "sandbox": "ready"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `healthy` or `degraded` or `unhealthy` |
| `version` | string | Eden API version |
| `postgres` | string | `connected`, `disconnected`, or `error` |
| `qdrant` | string | `connected`, `disconnected`, or `error` |
| `sandbox` | string | `ready`, `initializing`, or `error` |

**Error Response `503 Service Unavailable`:**
```json
{
  "status": "unhealthy",
  "version": "0.1.0",
  "postgres": "disconnected",
  "qdrant": "connected",
  "sandbox": "error",
  "errors": ["PostgreSQL connection failed", "Sandbox initialization failed"]
}
```

---

### Submit Job

```
POST /jobs
```

Submit a new environment generation job. The job runs asynchronously; use the returned `job_id` to check status and retrieve results.

**Request Body:**
```json
{
  "description": "CartPole with potential-based reward shaping",
  "tags": ["rl", "continuous", "gymnasium"],
  "framework": "gymnasium",
  "framework_version": "0.29",
  "difficulty_parameters": {},
  "output_mode": "gymnasium_mode"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `description` | string | Yes | — | Natural language description of the environment |
| `tags` | array[string] | No | `[]` | Optional hints guiding the Planner (e.g., `rl`, `continuous`, `multi-agent`) |
| `framework` | string | No | `"gymnasium"` | Target framework |
| `framework_version` | string | No | `"0.29"` | Framework version |
| `difficulty_parameters` | object | No | `{}` | Difficulty configuration axes |
| `output_mode` | string | No | `"gymnasium_mode"` | Output format mode |

**Output Modes:**

| Mode | Description | Use Case |
|------|-------------|----------|
| `gymnasium_mode` | Gymnasium-compatible Python | RL training/evaluation |
| `pettingzoo_mode` | PettingZoo AEC or Parallel API | Multi-agent environments |
| `llm_sandbox_mode` | Text-based interactive | LLM agent evaluation |
| `agent_eval_mode` | AgentBench/TAU-bench harness | Agent capability benchmarks |
| `tool_env_mode` | Tool-use environment | Tool-use testing |
| `custom_python_mode` | Arbitrary Python interface | Custom requirements |
| `typescript_mode` | TypeScript with typing | Type-safe environments |
| `multilanguage_mode` | Multiple languages | Cross-platform support |

**Response `202 Accepted`:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "planning",
  "message": "Job submitted successfully. Use GET /jobs/{job_id} to check status."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `job_id` | string (UUID) | Unique job identifier |
| `status` | string | Initial pipeline stage |
| `message` | string | Human-readable status message |

**Error Response `422 Validation Error`:**
```json
{
  "detail": [
    {
      "loc": ["body", "description"],
      "msg": "field required",
      "type": "missing"
    }
  ]
}
```

---

### Get Job Status

```
GET /jobs/{job_id}
```

Get the current status of a job. Use this endpoint to poll for completion.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `job_id` | UUID | The job identifier |

**Response `200 OK`:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "testing",
  "current_stage": "testing",
  "outcome_tier": null,
  "created_at": "2026-05-23T10:00:00Z",
  "updated_at": "2026-05-23T10:05:30Z",
  "stage_history": [
    {"stage": "planning", "entered_at": "2026-05-23T10:00:00Z", "exited_at": "2026-05-23T10:00:45Z"},
    {"stage": "criticizing", "entered_at": "2026-05-23T10:00:45Z", "exited_at": "2026-05-23T10:01:30Z"},
    {"stage": "refining", "entered_at": "2026-05-23T10:01:30Z", "exited_at": "2026-05-23T10:02:15Z"},
    {"stage": "fact_checking", "entered_at": "2026-05-23T10:02:15Z", "exited_at": "2026-05-23T10:03:00Z"},
    {"stage": "executing", "entered_at": "2026-05-23T10:03:00Z", "exited_at": "2026-05-23T10:04:00Z"},
    {"stage": "code_quality", "entered_at": "2026-05-23T10:04:00Z", "exited_at": "2026-05-23T10:04:30Z"},
    {"stage": "verifying", "entered_at": "2026-05-23T10:04:30Z", "exited_at": "2026-05-23T10:05:00Z"},
    {"stage": "testing", "entered_at": "2026-05-23T10:05:00Z", "exited_at": null}
  ],
  "executor_iterations": 1,
  "code_quality_iterations": 1,
  "critic_replan_count": 0,
  "critic_reresearch_count": 0
}
```

**Status Values:**

| Status | Description |
|--------|-------------|
| `planning` | Planner is researching and generating EDP |
| `criticizing` | Critic is reviewing the EDP |
| `refining` | Refiner is resolving spec gaps |
| `fact_checking` | Fact Checker is verifying claims |
| `executing` | Executor is generating code |
| `code_quality` | Code Quality Pipeline is running |
| `verifying` | Verifier is checking fidelity |
| `testing` | Tester is running tests in sandbox |
| `archiving` | Archivist is learning from the job |
| `completed` | Job finished successfully |
| `failed` | Job failed |
| `cancelled` | Job was cancelled |
| `human_review` | Escalated for manual intervention |

**Error Response `404 Not Found`:**
```json
{
  "detail": "Job not found"
}
```

---

### Get Job Result

```
GET /jobs/{job_id}/result
```

Get the completed job result. Returns 202 if job is not yet complete.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `job_id` | UUID | The job identifier |

**Response `200 OK`:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "outcome_tier": "Gold",
  "environment_code": "class CartPoleShaped(gym.Env):\n    \"\"\"...",
  "test_results": {
    "passed": true,
    "categories": {
      "instantiation": true,
      "reset_integrity": true,
      "step_validity": true,
      "termination_reachability": true,
      "reward_non_degeneracy": true,
      "reproducibility": true,
      "exploit_scan": true,
      "mutation_testing": true,
      "edge_case_stress": true,
      "performance_validation": true,
      "curriculum_coherence": null,
      "documentation_smoke_test": true
    }
  },
  "quality_report": {
    "static_analysis": {"passed": true, "warnings": 0},
    "security_analysis": {"passed": true, "issues": 0},
    "complexity": {"passed": true, "score": "A"},
    "performance": {"passed": true, "avg_step_ms": 0.45},
    "documentation": {"passed": true, "coverage": 100}
  },
  "archivist_summary": {
    "outcome_tier": "Gold",
    "extraction_results": {
      "best_practices": [],
      "skills": [],
      "prevention_rules": [],
      "exploit_probes": []
    },
    "forward_annotations": []
  }
}
```

**Outcome Tier Definitions:**

| Tier | Criteria |
|------|----------|
| `Gold` | First attempt success, ≤2 Code Quality iterations, no replan cycles |
| `Silver` | Passed all tests, normal iteration profile |
| `Bronze` | Passed but required above-average iterations or one replan |
| `Partial` | Passed but with flagged quality concerns or borderline probe results |
| `Failed` | Fundamental failure requiring restart, or exhausted iteration limits |

**Test Category Results:**

| Category | Type | Description |
|----------|------|-------------|
| `instantiation` | boolean | 20 seeds × difficulty extremes, no errors |
| `reset_integrity` | boolean | 50 seeds, correct dtype/bounds, no leakage |
| `step_validity` | boolean | 10,000 random steps, no exceptions |
| `termination_reachability` | boolean | At least one episode terminates within max_steps |
| `reward_non_degeneracy` | boolean | Non-constant reward across 1,000 random steps |
| `reproducibility` | boolean | Byte-identical trajectories across seeds |
| `exploit_scan` | boolean | No exploit achieves >90th percentile without completion |
| `mutation_testing` | boolean | >70% of 20 reward mutants detected |
| `edge_case_stress` | boolean | Correct handling of boundary inputs |
| `performance_validation` | boolean | Meets declared timing/memory targets |
| `curriculum_coherence` | boolean\|null | Monotonic difficulty increase (if curriculum) |
| `documentation_smoke_test` | boolean | All docstring examples execute |

**Quality Report Fields:**

| Pass | Fields |
|------|--------|
| `static_analysis` | `passed`, `warnings`, `errors` |
| `security_analysis` | `passed`, `issues`, `critical_issues` |
| `complexity` | `passed`, `score` (A-F), `violations` |
| `performance` | `passed`, `avg_step_ms`, `peak_memory_mb` |
| `documentation` | `passed`, `coverage` (0-100%) |

**Response `202 Accepted` (Job Not Complete):**
```json
{
  "detail": "Job not yet completed. Current status: testing"
}
```

**Error Response `404 Not Found`:**
```json
{
  "detail": "Job not found"
}
```

---

### Get Job Trace

```
GET /jobs/{job_id}/trace
```

Get the full job trace for debugging and analysis. This contains the complete pipeline history including all EDP iterations, critic decisions, routing events, and agent reasoning.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `job_id` | UUID | The job identifier |

**Response `200 OK`:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "trace": {
    "request": {
      "description": "CartPole with potential-based reward shaping",
      "tags": ["rl", "gymnasium"],
      "framework": "gymnasium",
      "framework_version": "0.29"
    },
    "edp_history": [
      {
        "meta": {
          "environment_class": "rl_training",
          "observation_modality": "discrete",
          "novelty_assessment": "standard",
          "design_confidence": 0.85
        },
        "environment": {...},
        "output_spec": {...},
        "known_risks": [],
        "design_decisions": []
      }
    ],
    "critic_decisions": [
      {
        "routing": "approve",
        "critique": {
          "reward_pathology_risk": {"passed": true},
          "observation_sufficiency": {"passed": true},
          "action_space_validity": {"passed": true},
          "termination_logic": {"passed": true},
          "framework_api_integrity": {"passed": true},
          "difficulty_calibration": {"passed": true},
          "specification_completeness": {"passed": true},
          "kb_conflict_check": {"passed": true}
        }
      }
    ],
    "routing_history": [
      {"from": "critic", "to": "refining", "reason": "approve"}
    ],
    "res": {...},
    "fact_check_report": {"passed": true},
    "code_history": ["class CartPoleShaped..."],
    "quality_reports": [
      {"pass": "static", "passed": true},
      {"pass": "security", "passed": true}
    ],
    "verifier_report": {"passed": true},
    "tester_results": {"passed": true},
    "kb_reads": [...],
    "agent_proposals": [...],
    "archivist_summary": {...}
  },
  "message": "Full trace retrieved from checkpoint storage"
}
```

**Error Response `404 Not Found`:**
```json
{
  "detail": "Job not found"
}
```

---

### Cancel Job

```
POST /jobs/{job_id}/cancel
```

Cancel an in-progress job. Jobs that have already completed, failed, or reached human_review cannot be cancelled.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `job_id` | UUID | The job identifier |

**Response `200 OK`:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled",
  "message": "Job cancelled successfully"
}
```

**Error Response `400 Bad Request`:**
```json
{
  "detail": "Cannot cancel job with status: completed"
}
```

| Status | Can Cancel? |
|--------|-------------|
| `planning` through `archiving` | Yes |
| `completed` | No |
| `failed` | No |
| `cancelled` | No |
| `human_review` | No |

**Error Response `404 Not Found`:**
```json
{
  "detail": "Job not found"
}
```

---

### Query Knowledge Base

```
GET /kb/query
```

Direct KB queries for debugging and analysis.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Natural language search query |
| `collection` | string | `"all"` | Collection to search: `all`, `episodic`, `semantic`, `skills`, `exploits` |
| `limit` | integer | `20` | Maximum results (1-100) |

**Response `200 OK`:**
```json
{
  "query": "CartPole reward shaping",
  "collection": "all",
  "limit": 20,
  "results": [
    {
      "type": "skill",
      "id": "uuid",
      "description": "Potential-based reward shaping for discrete navigation",
      "score": 0.92,
      "metadata": {
        "applicable_env_classes": ["rl_training"],
        "applicable_frameworks": ["gymnasium"]
      }
    }
  ],
  "total": 1,
  "message": "KB query completed successfully"
}
```

**Collection Options:**

| Collection | Description | Search Method |
|------------|-------------|---------------|
| `all` | Search all collections | Hybrid (episodic + semantic + procedural + exploits) |
| `episodic` | Job records and traces | Full-text + vector similarity |
| `semantic` | Knowledge graph facts | Vector similarity + graph traversal |
| `skills` | Skill Library entries | Vector similarity on code embeddings |
| `exploits` | Exploit Library probes | Vector similarity on probe descriptions |

---

### List Jobs

```
GET /jobs
```

List jobs with optional filtering.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | null | Filter by status |
| `outcome_tier` | string | null | Filter by outcome tier |
| `limit` | integer | `20` | Max results (1-100) |
| `offset` | integer | `0` | Pagination offset |

**Response `200 OK`:**
```json
{
  "jobs": [
    {
      "job_id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed",
      "outcome_tier": "Gold",
      "created_at": "2026-05-23T10:00:00Z",
      "updated_at": "2026-05-23T10:15:00Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

## Error Responses

### 400 Bad Request

The request was malformed or invalid.

```json
{
  "detail": "Cannot cancel job with status: completed"
}
```

### 404 Not Found

The requested resource does not exist.

```json
{
  "detail": "Job not found"
}
```

### 422 Validation Error

The request body failed validation.

```json
{
  "detail": [
    {
      "loc": ["body", "description"],
      "msg": "field required",
      "type": "missing"
    }
  ]
}
```

### 202 Accepted (Job Not Complete)

The result is not yet available.

```json
{
  "detail": "Job not yet completed. Current status: testing"
}
```

### 500 Internal Server Error

An unexpected error occurred.

```json
{
  "detail": "Internal server error",
  "trace_id": "abc123"
}
```

---

## OpenAPI Documentation

- **Swagger UI**: `GET /docs` — Interactive API documentation
- **ReDoc**: `GET /redoc` — Alternative documentation view
- **OpenAPI Schema**: `GET /openapi.json` — Raw OpenAPI 3.0 schema

---

## Rate Limiting

Currently no rate limiting. Production deployment should implement per-API-key rate limits.

Recommended limits:
| Endpoint | Limit |
|----------|-------|
| `POST /jobs` | 10 per minute |
| `GET /jobs/{id}` | 60 per minute |
| `GET /kb/query` | 30 per minute |

---

## Webhooks (Future)

Future version will support webhooks for job completion notifications:

```
POST /webhooks
```

```json
{
  "url": "https://your-endpoint.com/eden-callback",
  "events": ["job.completed", "job.failed"],
  "secret": "your-webhook-secret"
}
```

---

## Client Libraries

### Python

```python
from eden.api.client import EdenClient

client = EdenClient(base_url="http://localhost:8000")

# Submit job
job = client.submit_job(
    description="CartPole with reward shaping",
    tags=["rl", "gymnasium"],
    framework="gymnasium"
)

# Poll for completion
while job.status not in ("completed", "failed", "cancelled"):
    job = client.get_job(job.job_id)
    time.sleep(5)

# Get result
result = client.get_result(job.job_id)
```

### TypeScript

```typescript
import { EdenClient } from '@eden/sdk';

const client = new EdenClient({ baseUrl: 'http://localhost:8000' });

const job = await client.jobs.submit({
  description: 'CartPole with reward shaping',
  tags: ['rl', 'gymnasium'],
  framework: 'gymnasium'
});
```

---

## Document Information

| Field | Value |
|-------|-------|
| Version | 1.0 |
| Last Updated | May 2026 |
| OpenAPI Version | 3.0.0 |