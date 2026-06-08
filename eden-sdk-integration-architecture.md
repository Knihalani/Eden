# Eden — SDK & Developer Experience Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define the developer experience (DX) strategy for Eden, covering client SDKs, CLI tooling, IDE integrations, plugin architecture, documentation, error handling, and versioning. Great DX is a competitive moat — it determines whether developers adopt, stay, and advocate for Eden.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [SDK Philosophy & Design Principles](#2-sdk-philosophy--design-principles)
3. [Python SDK](#3-python-sdk)
4. [TypeScript / JavaScript SDK](#4-typescript--javascript-sdk)
5. [CLI Design](#5-cli-design)
6. [Plugin & Extension Architecture](#6-plugin--extension-architecture)
7. [IDE Integrations](#7-ide-integrations)
8. [Documentation Strategy](#8-documentation-strategy)
9. [Error Handling & Debugging](#9-error-handling--debugging)
10. [Versioning & Compatibility](#10-versioning--compatibility)
11. [Integration Patterns](#11-integration-patterns)
12. [Implementation Roadmap](#12-implementation-roadmap)

---

## 1. Strategic Thesis

Eden generates environments and evaluates agents. The value is only realized when developers can **easily integrate** Eden into their existing workflows. This means:

- **Zero-config defaults** that work out of the box
- **Progressive disclosure** — simple for beginners, powerful for experts
- **Familiar patterns** — idiomatic Python and TypeScript that feel native
- **Observable internals** — every action is traceable and debuggable
- **Fast feedback loops** — changes are reflected immediately

**Competitive Benchmarks:**

| Platform | What They Do Well | Eden's Opportunity |
|----------|-------------------|-------------------|
| **Stripe** | Consistent, predictable APIs; excellent error messages | Match their API consistency |
| **Vercel AI SDK** | Streaming-first, type-safe, composable | Match their streaming DX |
| **OpenAI** | Simple client, good documentation | Exceed their observability |
| **LangChain** | Modular, plugin-heavy architecture | Simplify their complexity |
| **Twilio** | Progressive disclosure, tutorial depth | Match their onboarding |

---

## 2. SDK Philosophy & Design Principles

### 2.1 Core Principles

| Principle | Description |
|-----------|-------------|
| **Async-first** | All I/O operations are async by default; sync wrappers for convenience |
| **Streaming-first** | All generation operations support streaming; non-streaming is a wrapper |
| **Type-safe** | Full TypeScript types; Python type hints (Pydantic models) |
| **Fail-fast** | Errors are raised immediately with structured context |
| **Idempotent** | Retrying the same operation produces the same result (where possible) |
| **Composable** | Low-level primitives compose into high-level workflows |
| **Zero-config** | Works with `eden = Eden()`; configuration is optional and additive |

### 2.2 API-First Design

Eden is designed API-first:

1. OpenAPI 3.1 spec is the source of truth
2. SDKs are auto-generated from the spec (using Fern, OpenAPI Generator, or custom tooling)
3. Documentation is auto-generated from the spec
4. SDKs include hand-written convenience layers on top of generated code

### 2.3 Configuration Hierarchy

```
Priority (highest → lowest):
1. Constructor arguments → eden = Eden(api_key="...", base_url="...")
2. Environment variables → EDEN_API_KEY, EDEN_BASE_URL
3. Config file → ~/.eden/config.toml or ./eden.toml
4. Default values → https://api.eden.dev/v1
```

**Config File Format:**

```toml
# ~/.eden/config.toml
api_key = "sk-..."
base_url = "https://api.eden.dev/v1"
default_org = "org_abc123"

[observability]
enabled = true
auto_trace = true
trace_sample_rate = 1.0

[sandbox]
default_timeout = 300
memory_limit = "512Mi"
```

---

## 3. Python SDK

### 3.1 Installation

```bash
# Core SDK
pip install eden-ai

# With observability extras
pip install eden-ai[observability]

# With all integrations
pip install eden-ai[all]
```

### 3.2 Core Client

```python
import asyncio
from eden import Eden

# Zero-config initialization (reads from env or ~/.eden/config.toml)
eden = Eden()

# Or explicit configuration
eden = Eden(
    api_key="sk-...",
    base_url="https://api.eden.dev/v1",
    default_org="org_abc123",
    timeout=60,
    max_retries=3,
)

# Context manager for automatic cleanup
async with Eden() as eden:
    env = await eden.environments.create(description="...")
```

### 3.3 Environment Generation

```python
# Simple generation (blocking-style for scripts)
environment = await eden.environments.create(
    description="Multi-agent negotiation environment",
    framework="gymnasium",
    language="python",
)
print(environment.code)

# Streaming generation (real-time feedback)
async for chunk in eden.environments.create_stream(
    description="Multi-agent negotiation environment",
):
    print(chunk.stage, chunk.status, chunk.message)
    # Output:
    # design in_progress "Analyzing requirements..."
    # design completed "Design document ready"
    # generate in_progress "Writing code..."
    # generate completed "Code generated"
    # validate in_progress "Running tests..."
    # validate completed "All tests passed"
```

### 3.4 Agent Observability

```python
from eden import trace_agent

@trace_agent(
    environment_id="env_abc123",
    tags=["production", "customer-support"],
)
async def my_agent(user_query: str) -> str:
    # This function is automatically traced
    # All LLM calls, tool usage, and reasoning steps are captured
    response = await llm.chat.completions.create(...)
    return response.choices[0].message.content

# The trace is automatically sent to Eden's observability platform
# and can be viewed in the portal
```

### 3.5 Environment Wrapping

```python
import eden
import gymnasium as gym

# Wrap any environment for automatic observability
env = eden.wrap_environment(
    gym.make("CartPole-v1"),
    environment_id="env_abc123",
    auto_trace=True,
)

obs, info = env.reset()
for _ in range(1000):
    action = agent.act(obs)
    obs, reward, terminated, truncated, info = env.step(action)
    # Every step is traced: obs, action, reward, info
    if terminated or truncated:
        break
```

### 3.6 Benchmark Execution

```python
# Run a benchmark suite
results = await eden.benchmarks.execute(
    benchmark_id="bench_abc123",
    agent_config={"model": "gpt-4o", "temperature": 0.2},
)

print(results.score)           # 0.87
print(results.passed_tests)  # 42
print(results.failed_tests)   # 3
print(results.metrics)        # Detailed per-task metrics
```

### 3.7 Dataset Operations

```python
# Export traces as a dataset
dataset = await eden.datasets.create_from_traces(
    name="failure-cases-june",
    filter={
        "environment_id": "env_abc123",
        "status": "failed",
        "date_range": ["2026-06-01", "2026-06-30"],
    },
)

# Use the dataset for fine-tuning or evaluation
await eden.datasets.use_for_finetuning(dataset.id, model="gpt-4o")
```

### 3.8 Type Safety with Pydantic

```python
from eden.models import Environment, BenchmarkResult, Trace

# All models are Pydantic v2 with full validation
env = Environment.model_validate_json(response_body)

# IDE autocomplete works for all nested fields
print(env.code)                    # str
print(env.tests[0].name)          # str
print(env.provenance.model)        # str
print(env.provenance.prompt_hash)  # str
```

---

## 4. TypeScript / JavaScript SDK

### 4.1 Installation

```bash
# npm
npm install @eden-ai/sdk

# With streaming support (included by default)
npm install @eden-ai/sdk

# For Next.js / React
npm install @eden-ai/react  # React hooks and components
```

### 4.2 Core Client

```typescript
import { Eden } from "@eden-ai/sdk";

// Zero-config initialization
const eden = new Eden();

// Explicit configuration
const eden = new Eden({
  apiKey: process.env.EDEN_API_KEY,
  baseURL: "https://api.eden.dev/v1",
  defaultOrg: "org_abc123",
  timeout: 60000,
  maxRetries: 3,
});
```

### 4.3 Streaming with AsyncIterable

```typescript
// Streaming is the primary interface
const stream = await eden.environments.createStream({
  description: "Multi-agent negotiation environment",
  framework: "gymnasium",
});

for await (const chunk of stream) {
  console.log(chunk.stage, chunk.status, chunk.message);
}
```

### 4.4 React Hooks

```typescript
import { useEnvironmentGeneration, useAgentTracing } from "@eden-ai/react";

function EnvironmentGenerator() {
  const { generate, stream, isGenerating, error } = useEnvironmentGeneration();

  const handleGenerate = async () => {
    await generate({
      description: "Tool-use environment with web search",
      framework: "custom",
    });
  };

  return (
    <div>
      <button onClick={handleGenerate} disabled={isGenerating}>
        {isGenerating ? "Generating..." : "Generate Environment"}
      </button>
      {stream && (
        <PipelineViewer stages={stream.stages} />
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  );
}
```

### 4.5 Next.js Integration

```typescript
// app/api/generate/route.ts
import { Eden } from "@eden-ai/sdk";
import { EdenAIStream, StreamingTextResponse } from "@eden-ai/sdk/streams";

export async function POST(req: Request) {
  const { description } = await req.json();

  const eden = new Eden();
  const stream = await eden.environments.createStream({ description });

  // Convert Eden stream to Vercel AI SDK compatible stream
  const aiStream = EdenAIStream(stream);
  return new StreamingTextResponse(aiStream);
}
```

---

## 5. CLI Design

### 5.1 Command Structure

```
eden <resource> <action> [flags]

Resources:
  environment    Manage generated environments
  benchmark      Run and manage benchmarks
  agent          Deploy and monitor agents
  dataset        Create and manage datasets
  job            View pipeline job status
  trace          View and export traces
  organization   Manage org settings
  config         Configure the CLI

Global Flags:
  --api-key      Override API key
  --org          Target organization
  --format       Output format: json, yaml, table (default: table)
  --quiet        Suppress non-essential output
  --verbose      Show debug information
  --no-color     Disable colored output
```

### 5.2 Environment Generation

```bash
# Interactive generation
eden environment create
# ? Description: Multi-agent negotiation environment
# ? Framework: [Use arrows to move, type to filter]
#   > gymnasium
#     custom
# ? Language: python
# Generating... ████████████████████ 100%
# Environment created: env_abc123

# Non-interactive (CI/CD friendly)
eden environment create \
  --description "Multi-agent negotiation environment" \
  --framework gymnasium \
  --language python \
  --output ./my-env/

# Watch generation progress
eden job watch job_def456
# [12:00:05] design      → in_progress  Analyzing requirements...
# [12:00:12] design      → completed    Design document ready
# [12:00:15] generate    → in_progress  Writing code...
# [12:00:45] generate    → completed    3 files generated
# [12:00:48] validate    → in_progress  Running test suite...
# [12:01:02] validate    → completed    42/42 tests passed
```

### 5.3 Benchmark Execution

```bash
# Run a benchmark
eden benchmark run bench_abc123 \
  --agent-model gpt-4o \
  --agent-temperature 0.2 \
  --parallel 5 \
  --output results.json

# Compare two runs
eden benchmark compare \
  bench_run_abc123 \
  bench_run_def456 \
  --format table

# +----------------+----------+----------+----------+
# | Metric         | Baseline | Current  | Δ        |
# +----------------+----------+----------+----------+
# | Success Rate   | 82.3%    | 89.1%    | +6.8% ✅ |
# | Avg Latency    | 1.2s     | 0.9s     | -0.3s ✅ |
# | Token Usage    | 15,420   | 12,100   | -3,320 ✅ |
# | Error Rate     | 3.1%     | 1.8%     | -1.3% ✅ |
# +----------------+----------+----------+----------+
```

### 5.4 Agent Tracing

```bash
# Trace a local agent script
eden trace run ./my_agent.py \
  --environment env_abc123 \
  --output ./trace.json

# View trace in browser
eden trace view trace_ghi789
# Opening https://portal.eden.dev/traces/trace_ghi789...

# Export traces as dataset
eden dataset create-from-traces \
  --filter "environment_id=env_abc123,status=failed" \
  --name "failure-cases"
```

### 5.5 Configuration

```bash
# Interactive login
eden login
# ? Email: dev@company.com
# ? Password: ********
# ✓ Authenticated as dev@company.com
# ? Default organization: org_abc123 (MyOrg)
# ✓ Configuration saved to ~/.eden/config.toml

# View current config
eden config show

# Set a value
eden config set default_org org_def456

# Switch organization
eden org switch org_def456
```

### 5.6 CLI Implementation Stack

| Component | Technology |
|-----------|------------|
| CLI framework | Python Click / TypeScript Commander.js |
| Interactive prompts | InquirerPy / Inquirer.js |
| Progress bars | Rich (Python) / Ora (TypeScript) |
| Output formatting | tabulate / cli-table3 |
| Configuration | Pydantic Settings / cosmiconfig |
| Authentication | OS keychain integration |

---

## 6. Plugin & Extension Architecture

### 6.1 Plugin Types

| Type | Description | Example |
|------|-------------|---------|
| **Model Provider** | Add support for a new LLM | Add Google Gemini, local vLLM |
| **Environment Framework** | Support a new framework type | Add PettingZoo, Unity ML-Agents |
| **Tool** | Add a tool agents can use | Add Slack notification, Jira ticket creation |
| **Validator** | Custom validation logic | Add company-specific security linting |
| **Exporter** | Custom export format | Add CSV, Parquet, HuggingFace dataset |
| **Notifier** | Custom alert destination | Add PagerDuty, Slack webhook |

### 6.2 Plugin Registration

```python
# my_eden_plugin/validators.py
from eden.plugins import ValidatorPlugin

class SecurityLinterValidator(ValidatorPlugin):
    name = "security-linter"
    version = "1.0.0"

    async def validate(self, code: str, context: dict) -> ValidationResult:
        # Run custom security checks
        issues = await run_security_scan(code)
        return ValidationResult(
            passed=len(issues) == 0,
            issues=issues,
            severity="error" if issues else "info",
        )

# Register in pyproject.toml
# [project.entry-points."eden.plugins.validators"]
# security-linter = "my_eden_plugin.validators:SecurityLinterValidator"
```

### 6.3 Plugin Discovery

```python
# Eden discovers plugins at startup
import importlib.metadata

plugins = []
for entry_point in importlib.metadata.entry_points().select(group="eden.plugins.validators"):
    plugin_class = entry_point.load()
    plugins.append(plugin_class())
```

---

## 7. IDE Integrations

### 7.1 VS Code Extension

**Features:**
- **Environment explorer:** Tree view of all environments in the sidebar
- **Live pipeline viewer:** Watch generation progress in a webview panel
- **Trace inspector:** View traces inline with code
- **Autocomplete:** Environment IDs, benchmark IDs, and configuration keys
- **Hover information:** Hover over `eden.environments.create()` to see docs
- **Diagnostics:** Warnings for deprecated API usage or missing required fields
- **Command Palette:** `Eden: Generate Environment`, `Eden: Run Benchmark`

**Extension Architecture:**

```
VS Code Extension
├── Language Server Protocol (LSP) client
│   └── Connects to Eden LSP server for autocomplete, diagnostics
├── Webview panels
│   ├── Pipeline viewer (React-based)
│   ├── Trace inspector (React-based)
│   └── Benchmark results (React-based)
├── Tree data providers
│   ├── Environment explorer
│   ├── Benchmark explorer
│   └── Dataset explorer
└── Commands
    ├── Generate environment from selection
    ├── Run benchmark on current file
    └── Export trace as dataset
```

### 7.2 Language Server Protocol (LSP)

**Capabilities:**
- **Autocomplete:** Complete environment descriptions from natural language
- **Hover:** Show documentation for Eden SDK methods
- **Diagnostics:** Type-check Eden configuration files (eden.toml)
- **Go to definition:** Navigate from environment ID to its definition
- **Code actions:** "Generate tests for this environment", "Wrap with trace_agent"

### 7.3 JetBrains Plugin

- Similar feature parity to VS Code extension
- Native Kotlin-based UI components
- Integration with PyCharm's test runner for Eden benchmarks

---

## 8. Documentation Strategy

### 8.1 Documentation Architecture

| Layer | Format | Tooling | Audience |
|-------|--------|---------|----------|
| **API Reference** | OpenAPI + Markdown | Fern / Redoc | All developers |
| **SDK Reference** | Auto-generated from code | Sphinx / TypeDoc | SDK users |
| **Guides** | Markdown | Docusaurus / MkDocs | All developers |
| **Tutorials** | Interactive notebooks | Jupyter, Google Colab | New users |
| **Cookbook** | Code snippets | GitHub repo | Experienced users |
| **Changelog** | Markdown | GitHub Releases | All developers |

### 8.2 Interactive Documentation

- **Live API playground:** Test API endpoints directly from the docs with your API key
- **Embedded REPL:** Run Python/TypeScript snippets in the browser (using Pyodide / WebContainers)
- **Pipeline visualizer:** Interactive diagram showing how a description becomes an environment
- **Trace explorer:** Public demo traces that users can explore

### 8.3 Tutorial Curriculum

| Tutorial | Time | Learning Outcome |
|----------|------|-----------------|
| **Getting Started** | 5 min | Generate your first environment |
| **Tracing Your Agent** | 10 min | Integrate `@trace_agent` and view traces |
| **Running Benchmarks** | 15 min | Create and run a benchmark suite |
| **From Production to Dataset** | 20 min | Export failed traces as a dataset |
| **Custom Validators** | 30 min | Write a plugin that enforces company standards |
| **CI/CD Integration** | 25 min | Automate environment regression testing |

---

## 9. Error Handling & Debugging

### 9.1 Error Taxonomy

```python
class EdenError(Exception):
    """Base class for all Eden errors."""
    request_id: str
    error_code: str
    status_code: int
    docs_url: str

class AuthenticationError(EdenError):
    """API key invalid, expired, or missing required scopes."""
    status_code = 401

class RateLimitError(EdenError):
    """Quota exceeded or rate limit hit."""
    status_code = 429
    retry_after: int  # Seconds until next request is allowed

class ValidationError(EdenError):
    """Input validation failed."""
    status_code = 422
    field_errors: dict  # {field: [error_messages]}

class SandboxTimeoutError(EdenError):
    """Code execution exceeded time limit."""
    status_code = 504
    timeout_seconds: int

class PipelineError(EdenError):
    """Pipeline execution failed at a specific node."""
    status_code = 500
    failed_node: str
    node_logs: str
```

### 9.2 Error Messages

```python
# Bad
raise Exception("Request failed")

# Good
raise RateLimitError(
    message="You have exceeded your monthly token quota of 100,000 tokens. "
            "Current usage: 102,340 tokens. Your quota resets on July 1, 2026.",
    request_id="req_abc123",
    error_code="quota_exceeded.llm_tokens",
    status_code=429,
    retry_after=3600,
    docs_url="https://docs.eden.dev/errors/quota-exceeded",
    suggestion="Upgrade to the Team plan for 2M tokens/month at https://portal.eden.dev/billing",
)
```

### 9.3 Request ID Propagation

Every request gets a unique `X-Request-ID` that propagates through the entire system:

```
Client → API Gateway → Pipeline Node → Sandbox → LLM Provider
   ↓         ↓            ↓            ↓           ↓
req_abc   req_abc      req_abc     req_abc    req_abc
```

Users include the request ID in support tickets for instant context retrieval.

### 9.4 Debug Mode

```python
eden = Eden(debug=True)
# Enables:
# - Full HTTP request/response logging
# - Detailed timing breakdowns (DNS, connect, TLS, TTFB, download)
# - Raw LLM prompts and completions (if permissions allow)
# - Sandbox stdout/stderr capture
```

---

## 10. Versioning & Compatibility

### 10.1 API Versioning

- URL-based versioning: `/v1/`, `/v2/`
- Current version: `v1`
- Deprecation policy: 6-month notice, 12-month support window
- Sunsets are announced via:
  - Email to org admins
  - SDK deprecation warnings
  - Documentation banners
  - API response headers: `Sunset: 2027-01-01`

### 10.2 SDK Versioning

- Semantic Versioning (SemVer): `MAJOR.MINOR.PATCH`
- Auto-update checks: SDK checks for new versions weekly
- Deprecation warnings: Runtime warnings for deprecated methods
- Migration guides: Step-by-step guides for major version bumps

### 10.3 Compatibility Matrix

| SDK Version | API Version | Supported Until |
|-------------|-------------|-----------------|
| Python 1.x | v1 | Current |
| TypeScript 1.x | v1 | Current |
| Python 0.x | v1 | Deprecated, EOL 2026-12-31 |

### 10.4 Feature Flags

New features are rolled out via feature flags:

```python
# Check if feature is available
if eden.features.is_enabled("semantic_caching", org_id="org_abc123"):
    # Use semantic caching
else:
    # Fallback to exact match caching
```

- Features are opt-in during beta
- Gradual rollout: 1% → 10% → 50% → 100% of tenants
- Instant rollback if issues are detected

---

## 11. Integration Patterns

### 11.1 CI/CD Integration

```yaml
# .github/workflows/eden-regression.yml
name: Eden Regression Tests

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: eden-ai/setup-eden@v1
        with:
          api-key: ${{ secrets.EDEN_API_KEY }}

      - name: Run benchmarks
        run: eden benchmark run bench_abc123 --fail-on-regression

      - name: Check for new failure patterns
        run: eden insights check --since last-deployment
```

### 11.2 Framework Integrations

| Framework | Integration | How |
|-----------|-------------|-----|
| **LangChain** | `EdenTracer` callback handler | Captures all LangChain steps as traces |
| **LangGraph** | `EdenPersistenceSaver` | Saves state to Eden's checkpoint store |
| **OpenAI** | Drop-in `eden.patch_openai()` | Auto-traces all OpenAI API calls |
| **Anthropic** | Drop-in `eden.patch_anthropic()` | Auto-traces all Anthropic API calls |
| **Gymnasium** | `eden.wrap_environment()` | Auto-traces all env interactions |
| **PettingZoo** | `eden.wrap_environment()` | Auto-traces multi-agent interactions |
| **CrewAI** | `EdenCrewObserver` | Captures crew execution as traces |
| **AutoGen** | `EdenAgentObserver` | Captures agent conversations as traces |

### 11.3 Webhook Integration

```python
# Configure webhook for pipeline events
await eden.webhooks.create(
    url="https://my-app.com/eden-webhook",
    events=[
        "environment.generation.completed",
        "environment.generation.failed",
        "benchmark.run.completed",
        "dataset.created",
    ],
    secret="whsec_...",  # For HMAC signature verification
)
```

---

## 12. Implementation Roadmap

### Phase 1: Core SDK (Weeks 1–6)
- [ ] Auto-generate Python SDK from OpenAPI spec
- [ ] Auto-generate TypeScript SDK from OpenAPI spec
- [ ] Implement `eden.environments.create()` and streaming
- [ ] Implement `eden.benchmarks.execute()`
- [ ] Build `@trace_agent` decorator (Python) and equivalent (TS)
- [ ] Write 10 getting-started tutorials

### Phase 2: CLI & Tooling (Weeks 7–10)
- [ ] Build `eden` CLI in Python (Click)
- [ ] Implement `environment create`, `benchmark run`, `trace view`
- [ ] Add interactive prompts and progress bars
- [ ] Build `eden login` with OS keychain integration
- [ ] Write shell completion scripts (bash, zsh, fish)

### Phase 3: IDE & Plugins (Weeks 11–14)
- [ ] Build VS Code extension with environment explorer
- [ ] Implement LSP server for autocomplete and diagnostics
- [ ] Build plugin architecture with entry points
- [ ] Create 3 reference plugins (validator, exporter, notifier)
- [ ] Write plugin development guide

### Phase 4: Polish & Ecosystem (Weeks 15–18)
- [ ] Build React hooks package (`@eden-ai/react`)
- [ ] Add framework integrations (LangChain, OpenAI, Gymnasium)
- [ ] Build interactive documentation with live playground
- [ ] Launch GitHub Copilot extension for Eden prompts
- [ ] Create community plugin registry

---

*This document should be read alongside [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) for the core platform and [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) for the observability SDK features.*
