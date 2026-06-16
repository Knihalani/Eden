# Eden Agent CLI — Development Roadmap

**Version:** 1.0
**Date:** June 6, 2026
**Total Duration:** 12 weeks (3 months)
**Team Size Assumption:** 2–3 engineers

---

## Roadmap Overview

```
Week:  1    2    3    4    5    6    7    8    9   10   11   12
       ├─Phase 1──┤├Phase 2─┤├P3─┤├─Phase 4──┤├P5─┤├─Phase 6──┤├P7┤├─Phase 8──┤
       Fork & Core   KB Integ  Obs  Pipeline   PR   Integrate   Auto  Test &
       + Branding    + Context      + TUI UI         /eden       Gates Polish

Milestones:
  M1 (Week 2):  Launchable Eden TUI with basic chat + Eden config
  M2 (Week 4):  KB-aware coding agent with context injection
  M3 (Week 5):  Observability-informed reasoning
  M4 (Week 7):  Full pipeline integration + test runner
  M5 (Week 8):  PR workflow functional
  M6 (Week 10): /integrate-eden working end-to-end
  M7 (Week 11): Autonomy model complete
  M8 (Week 12): Production-ready release candidate
```

---

## Phase 1: Fork & Core Setup (Weeks 1–2)

**Goal:** Fork Aider, establish the Eden identity, wire up config/auth/API client, and get a launchable TUI that can chat with an LLM using Eden's model routing.

### Week 1: Fork, Branding & Config Foundation

#### 1.1 Fork Aider Repository
- [ ] Clone Aider at latest stable release tag (e.g., `v0.60.0`)
- [ ] Create new repo `eden-ai/eden-cli` (or `eden-ai/eden-agent-cli`)
- [ ] Add upstream remote for future rebases: `git remote add upstream https://github.com/Aider-AI/aider.git`
- [ ] Verify Aider's test suite passes on the fork before any changes
- [ ] Run `pytest tests/` and document pass/fail count as baseline
- **Acceptance:** Fork builds, tests pass, clean baseline established

#### 1.2 Eden Branding
- [ ] Replace all `aider` references in CLI help text with `eden`
- [ ] Update `__version__` to `0.1.0-eden`
- [ ] Update `setup.py`/`pyproject.toml`:
  - Package name: `eden-agent-cli`
  - Description: "Eden Agent CLI — AI-native agent development"
  - Entry point: `eden` (not `aider`)
  - License: Apache 2.0 (compatible)
- [ ] Update README.md with Eden branding and quickstart
- [ ] Replace Aider ASCII art banner with Eden banner
- **Acceptance:** `eden --help` shows Eden branding, `eden --version` shows `0.1.0-eden`

#### 1.3 Eden Configuration System
- [ ] Create `eden/config.py`:
  - Load from `~/.eden/config.yaml` (global) and `./.eden/config.yaml` (project)
  - Load from env vars: `EDEN_API_KEY`, `EDEN_DEFAULT_ORG`, `EDEN_BASE_URL`, `EDEN_MODEL`, `EDEN_AUTONOMY`
  - Load from CLI flags: `--api-key`, `--org`, `--base-url`, `--model`, `--autonomous`
  - Config priority: CLI flags > project config > global config > env vars > defaults
  - Full schema per spec (model, autonomy, pr, kb, observability, pipeline sections)
- [ ] Create default config template: `eden/config_defaults.yaml`
- [ ] Add `eden config init` to scaffold `.eden/config.yaml` in current directory
- **Acceptance:** `eden config show` displays merged config from all sources

#### 1.4 Multi-Tenant Auth Layer
- [ ] Create `eden/auth.py`:
  - Validate API key against Eden server (`GET /v1/auth/validate`)
  - Cache org membership and permissions
  - Support token refresh for long-running sessions
- [ ] Add `eden login` command (reuse logic from `src/eden/cli/commands/config_cmd.py`)
- [ ] Add `eden logout` command
- [ ] Surface auth errors gracefully (expired key, invalid org, network down)
- **Acceptance:** `eden login --api-key xxx --org yyy` validates and saves config

### Week 2: API Client & Model Routing

#### 1.5 Eden API Client
- [ ] Create `eden/client.py`:
  - Wrap `httpx.AsyncClient` with Eden-specific auth headers (`X-Org-Api-Key`, `X-Org-Id`)
  - Base URL from config
  - Timeout and retry configuration
  - Methods:
    - `query_kb(query, scope, limit)` → `KBResult`
    - `get_observability_context(agent_id, limit)` → `ObservabilityContext`
    - `get_traces(limit, filters)` → `list[Trace]`
    - `get_trace_tree(trace_id)` → `TraceTree`
    - `submit_job(description, spec_id)` → `Job`
    - `get_job(job_id)` → `Job`
    - `stream_job(job_id)` → `AsyncIterator[Event]`
    - `get_benchmarks()` → `list[Benchmark]`
    - `create_pr_metadata(changes)` → `PRMetadata`
- [ ] Add `eden/client_models.py`:
  - Pydantic models for all API responses: `KBResult`, `Trace`, `TraceTree`, `Job`, `ObservabilityContext`
  - Reuse models from `src/eden/sdk/models.py` where possible
- [ ] Add connection health check on startup
- [ ] Add offline mode fallback (warn, continue without Eden features)
- **Acceptance:** `eden` starts, connects to Eden API, shows connection status in banner

#### 1.6 Model Routing Integration
- [ ] Create `eden/model_router.py`:
  - Map Eden model slots to LiteLLM model names:
    - `reasoning` → `anthropic/claude-sonnet-4` (configurable)
    - `fast` → `deepseek/deepseek-v4-flash:free` (configurable)
    - `code` → `qwen/qwen3-coder:free` (configurable)
    - `fallback` → `meta-llama/llama-3.3-70b-instruct` (configurable)
  - Route based on task type (coding → code slot, planning → reasoning slot, etc.)
- [ ] Modify `aider/models.py`:
  - Add `EdenModelSettings` with slot-aware model selection
  - Integrate `eden/model_router.py` into model initialization
  - Default to OpenRouter as LLM provider (matches existing Eden setup)
- [ ] Add `eden/model-settings.yml` with Eden's model configurations
- [ ] Preserve Aider's existing model selection for non-Eden use cases
- **Acceptance:** `eden --model reasoning` uses claude-sonnet-4, `eden --model fast` uses deepseek-flash

#### 1.7 Entry Point Routing (Backward Compatibility)
- [ ] Modify `main.py` entry point:
  - If first arg is a known thin CLI command (`generate`, `environment`, `job`, `benchmark`, `ci`, `trace`, `config`, `security`, `review`, `canary`), delegate to existing Click CLI
  - Otherwise, launch interactive TUI (Aider fork)
- [ ] Test all existing thin CLI commands still work:
  - `eden generate --description "test"`
  - `eden environment list`
  - `eden job list`
  - `eden config show`
  - `eden config login`
- **Acceptance:** All existing CLI commands pass regression tests

#### 1.8 Launch Banner & First-Run Experience
- [ ] Create Eden launch banner:
  ```
  Eden Agent CLI — AI-native agent development

  Detected: Python project with {framework}
  Indexed: {file_count} files, {line_count} lines

  ✓ Knowledge base: {connected/not configured}
  ✓ Observability: {connected/not configured}
  ✓ Eval harness: {configured/not configured}

  Ready. Type a message or try /help
  > _
  ```
- [ ] First-run detection: if no `~/.eden/config.yaml` exists, prompt for setup
- [ ] First-run detection: if no `.eden/config.yaml` in CWD, offer to create one
- **Acceptance:** `eden` in a new directory shows helpful first-run banner

#### M1 Milestone Check (End of Week 2)
- [ ] `eden` launches interactive TUI in any directory
- [ ] Chat works with LLM (via OpenRouter)
- [ ] Eden config loads from all sources
- [ ] Eden API connects and validates auth
- [ ] All legacy CLI commands still work
- [ ] All Aider tests still pass (no regressions)

---

## Phase 2: Knowledge Base Integration (Weeks 3–4)

**Goal:** The coding agent draws on both global and tenant knowledge bases during every reasoning step.

### Week 3: KB Context Provider

#### 2.1 Global KB Context Provider
- [ ] Create `eden/kb_context.py`:
  - `KBContextProvider` class with methods:
    - `get_global_context(query, budget_tokens)` → formatted string
    - `get_tenant_context(query, budget_tokens)` → formatted string
    - `get_combined_context(query, budget_tokens)` → formatted string
  - Query Eden API: `GET /v1/kb/query?query={q}&scope=global&limit={n}`
  - Format results into structured sections: entry title, content, confidence, source
  - Token budget management: truncate/summarize to fit within budget
  - Caching: cache results for 5 minutes to avoid redundant API calls
- [ ] Create `eden/kb_formatter.py`:
  - Format KB entries for LLM consumption (not raw JSON)
  - Group by type: best_practices, failure_modes, exploits, skills, framework_facts
  - Include confidence scores and provenance
- **Acceptance:** `KBContextProvider.get_global_context("reward shaping")` returns formatted, budget-compliant text

#### 2.2 Tenant KB Context Provider
- [ ] Extend `KBContextProvider` with tenant-scoped queries:
  - `get_tenant_context()` queries `GET /v1/kb/query?scope=tenant`
  - Returns: code patterns, quality standards, team conventions, custom probes
- [ ] Add agent-specific context filtering:
  - Detect agent ID from project (via `.eden/config.yaml` or codebase analysis)
  - Filter tenant results to this agent's history
- **Acceptance:** Tenant KB returns agent-specific patterns and standards

#### 2.3 Context Injection into Coder
- [ ] Create `eden/coders/eden_coder.py`:
  - Subclass `EditBlockCoder` (default edit format)
  - `edit_format = "eden"` (registers with `Coder.create()` factory)
  - Add attributes: `eden_client`, `eden_kb_context`, `eden_config`
  - Override `format_messages()`:
    - Call `super().format_messages(messages)` first
    - Build Eden context sections: `[GLOBAL KNOWLEDGE]`, `[TENANT CONTEXT]`
    - Insert as system message after the base system prompt
    - Respect token budget (don't exceed model's remaining context)
  - Override `run()`:
    - Add pipeline suggestion triggers (detect "test my agent", "evaluate", etc.)
    - Log interaction to tenant KB for future retrieval
- [ ] Register `EdenCoder` in `coders/__init__.py`
- [ ] Add fallback: if Eden API unavailable, skip context injection gracefully
- **Acceptance:** LLM responses reference KB knowledge when relevant (verify in chat output)

#### 2.4 Auto-Query Triggers
- [ ] Implement `_build_kb_query()` in `EdenCoder`:
  - Extract key concepts from user's message
  - Extract key concepts from repo map context
  - Combine into a focused KB query
- [ ] Implement auto-query logic:
  - Query KB on first message in a session
  - Query KB when user mentions errors, failures, performance issues
  - Query KB when discussing architecture or design decisions
  - Don't re-query if last query was &lt;5 minutes ago (cache)
- **Acceptance:** KB context auto-appears when user discusses relevant topics

### Week 4: KB Commands & Token Budget

#### 2.5 `/eden-kb` Slash Command
- [ ] Create `eden/commands/eden_commands.py`:
  - `cmd_eden_kb(args)`:
    - `eden-kb query <text>` — search both KBs, display formatted results
    - `eden-kb query --global <text>` — search global KB only
    - `eden-kb query --tenant <text>` — search tenant KB only
    - `eden-kb stats` — show KB health (entry count, freshness, retrieval hit rate)
  - Display results in rich table format (entry type, title, confidence, snippet)
- [ ] Register commands in `commands.py` (just add import)
- **Acceptance:** `/eden-kb query "reward shaping"` returns relevant results from both KBs

#### 2.6 Token Budget Management
- [ ] Implement progressive context pruning:
  - Default budget: 4000 tokens for KB context (configurable)
  - If total KB results exceed budget: summarize, truncate, or drop lowest-confidence entries
  - Priority order: tenant context > global best practices > global failure modes > framework facts
  - Reserve 20% of budget for observability context (Phase 3)
- [ ] Add `/eden-tokens` command showing context breakdown:
  ```
  Context Breakdown:
    System prompt:     850 tokens
    Repo map:         1,200 tokens
    File contents:    4,500 tokens
    Global KB:          600 tokens
    Tenant KB:          400 tokens
    Observability:      300 tokens
    Chat history:     2,100 tokens
    ─────────────────────────
    Total:           9,950 / 200,000 tokens (5.0%)
  ```
- **Acceptance:** Token budget never exceeded; `/eden-tokens` shows accurate breakdown

#### 2.7 Integration Tests for KB
- [ ] Write unit tests for `KBContextProvider`:
  - Mock Eden API, test query formatting
  - Test token budget management (truncation, summarization)
  - Test caching behavior
  - Test error handling (API down, auth failure)
- [ ] Write integration test: end-to-end chat with KB context injection
- [ ] Write regression test: verify Aider's existing context still works alongside KB
- **Acceptance:** All KB tests pass; no Aider test regressions

#### M2 Milestone Check (End of Week 4)
- [ ] `/eden-kb query "topic"` returns formatted results from both KBs
- [ ] KB context auto-injects into LLM messages for relevant queries
- [ ] Token budget respected — never exceeds configured limit
- [ ] `/eden-tokens` shows accurate breakdown including KB context
- [ ] All Aider tests still pass

---

## Phase 3: Observability Context Provider (Week 5)

**Goal:** The coding agent reads telemetry data (traces, errors, latency, costs) and uses it to inform reasoning.

### 3.1 Observability Context Provider
- [ ] Create `eden/observability_context.py`:
  - `ObservabilityContextProvider` class:
    - `get_context(agent_id, limit)` → formatted string
    - Query Eden API: `GET /orgs/{org_id}/observability/traces?limit={n}`
    - For each trace, summarize: duration, outcome, error count, tool calls, cost
    - Compute aggregates: p50/p95/p99 latency, error rate, cost trend
    - Format as structured section for LLM consumption
  - Caching: cache for 10 minutes (observability data changes slowly)
- [ ] Implement trace summarization:
  - Don't include raw trace JSON — summarize into human-readable text
  - Example: "Last 20 traces: 85% success rate, p95 latency 2.3s, avg cost $0.45/trace. Most common failure: tool timeout in search_tool (4 occurrences)."
- **Acceptance:** `ObservabilityContextProvider.get_context()` returns formatted, budget-compliant text

### 3.2 Context Injection
- [ ] Extend `EdenCoder._build_eden_context_message()`:
  - Add `[OBSERVABILITY CONTEXT]` section after KB sections
  - Include: recent traces, error distribution, latency percentiles, cost trends
  - Include portal URL for detailed viewing: `{base_url}/portal/{org_id}/observability`
- [ ] Token budget: allocate remaining budget after KB (default ~2000 tokens for observability)
- **Acceptance:** LLM references observability data in responses when relevant

### 3.3 `/eden-traces` Slash Command
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_eden_traces(args)`:
    - `eden-traces` — list last 20 traces with summary table
    - `eden-traces --limit N` — list last N traces
    - `eden-traces --agent-id <id>` — filter by agent
    - `eden-traces --realm <env|prod>` — filter by realm
    - `eden-traces show <trace_id>` — show detailed trace with ASCII span tree
    - `eden-traces compare <id1> <id2>` — compare two traces
  - Display as rich table: trace_id (short), realm, duration, outcome, spans, cost
- [ ] Add portal URL references: "View full trace at `{portal_url}/traces/{trace_id}`"
- **Acceptance:** `/eden-traces` shows real trace data from Eden API

### 3.4 Tests for Observability
- [ ] Unit tests: mock Eden API, test trace summarization
- [ ] Unit tests: test latency percentile computation
- [ ] Unit tests: test cost trend calculation
- [ ] Integration test: verify observability context appears in LLM messages
- **Acceptance:** All observability tests pass

#### M3 Milestone Check (End of Week 5)
- [ ] `/eden-traces` displays real trace data
- [ ] Observability context auto-injects into LLM messages
- [ ] LLM references trace data, latency patterns, and error distributions in responses
- [ ] Portal URLs are included inline for detailed viewing

---

## Phase 4: Pipeline Integration (Weeks 6–7)

**Goal:** Users can run Eden's evaluation pipeline against their agent directly from the CLI, with rich progress display.

### Week 6: Pipeline Invoker & Progress Display

#### 4.1 Pipeline Invoker
- [ ] Create `eden/pipeline_invoker.py`:
  - `PipelineInvoker` class:
    - `submit_job(description, spec_file=None)` → `Job`
    - `poll_job(job_id, callback)` → final `Job` status
    - `stream_job(job_id, callback)` → async stream of events
    - `format_results(job)` → formatted summary string
  - Use Eden API: `POST /v1/jobs` to submit, `GET /v1/jobs/{id}` to poll
  - Support both `--wait` (polling) and streaming modes
  - Handle timeouts (default 1800s), cancellations, and failures
- **Acceptance:** `PipelineInvoker.submit_job("test env")` creates a job and returns job ID

#### 4.2 Progress Display Widget
- [ ] Create `eden/progress_display.py`:
  - ASCII progress bar with stage indicators:
    ```
    ┌─ Eden Pipeline ──────────────────────────────────────────────┐
    │ Job: job_abc123  │  Status: running                          │
    │                                                              │
    │  ✅ Planner        ─── EDP generated (3 iterations)          │
    │  ✅ Critic          ─── Approved with notes                  │
    │  🔄 Executor        ─── Generating code (pass 2/3)          │
    │  ⏳ Code Quality    ─── Waiting                              │
    │                                                              │
    │  [████████████░░░░░░░░░░] 58%  │  ETA: ~4 min              │
    │  Cost so far: $1.23           │  LLM calls: 14              │
    └──────────────────────────────────────────────────────────────┘
    ```
  - Real-time updates via polling or SSE stream
  - Stage mapping from job status to pipeline stages (Planner, Critic, Executor, etc.)
  - ETA estimation based on average job duration for this environment class
  - Cost tracking from telemetry data
- **Acceptance:** Progress display updates in real-time during pipeline job

#### 4.3 `/eden-pipeline` Slash Command
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_eden_pipeline(args)`:
    - `eden-pipeline --description "Multi-agent negotiation"` — submit job
    - `eden-pipeline --spec-file ./spec.yaml` — submit with pre-built spec
    - `eden-pipeline --no-wait` — fire and forget
  - Show progress display while waiting
  - On completion: show summary, offer to download code, open in portal
- **Acceptance:** `/eden-pipeline -d "test env"` submits job and shows progress

### Week 7: Test Runner & Benchmark Commands

#### 4.4 `/eden-test` Slash Command
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_eden_test(args)`:
    - `eden-test` — run quick evaluation (3 most relevant categories)
    - `eden-test --full` — run all 12 test categories
    - `eden-test --focus <category>` — run specific category
    - `eden-test --agent-code ./agent.py` — specify agent code file
  - Workflow:
    1. Check if eval harness exists (`.eden/eval-harness.yaml`)
    2. If not, create a basic one on the fly from codebase analysis
    3. Submit evaluation job to Eden pipeline
    4. Show progress display
    5. On completion: parse and display results
    6. If failures: offer to analyze root cause using KB context
- [ ] Create `eden/eval_runner.py`:
  - `EvalRunner` class:
    - `check_harness()` → bool (does harness exist?)
    - `create_quick_harness(agent_code_path)` → spec dict
    - `run_evaluation(harness, categories)` → Job
    - `parse_results(job)` → `EvalResults`
    - `format_results(results)` → formatted string
  - Map test categories to Eden's 12 categories (from PRD)
  - Generate spec from agent code analysis (entry point, I/O contract)
- **Acceptance:** `/eden-test --quick` runs evaluation and displays pass/fail summary

#### 4.5 `/eden-bench` Slash Command
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_eden_bench(args)`:
    - `eden-bench create --name "latency" --criteria '{"max_latency_ms": 1000}'`
    - `eden-bench run <benchmark_id>`
    - `eden-bench compare <baseline_id> <current_id>`
    - `eden-bench history`
  - Delegate to Eden API: `POST /v1/benchmarks`, `GET /v1/benchmarks/{id}`
- **Acceptance:** `/eden-bench history` shows past benchmark runs

#### 4.6 `/eden-explain` Slash Command
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_eden_explain(args)`:
    - `eden-explain <trace_id>` — analyze trace using KB
    - `eden-explain "my agent keeps timing out"` — analyze issue description
  - Workflow:
    1. If trace_id: fetch trace from observability API
    2. Query global KB for matching failure modes
    3. Query tenant KB for historical occurrences
    4. Generate root cause analysis with LLM
    5. Present: explanation, fix suggestions, prevention strategies
- **Acceptance:** `/eden-explain trace_abc123` returns structured root cause analysis

#### 4.7 Automatic Pipeline Suggestions
- [ ] Implement trigger detection in `EdenCoder.run()`:
  - "test my agent", "evaluate", "benchmark", "score" → suggest `/eden-test`
  - "improve", "what's wrong", "optimize" → suggest `/eden-improve`
  - "environment for", "eval for", "test environment" → suggest `/eden-pipeline`
  - After `/integrate-eden` completes → suggest `/eden-test --quick`
- [ ] Suggestions are non-intrusive (one line, dismissible)
- [ ] Respect `pipeline.auto_suggest: false` config to disable
- **Acceptance:** Typing "test my agent" shows suggestion line

#### M4 Milestone Check (End of Week 7)
- [ ] `/eden-pipeline -d "desc"` submits job with real-time progress
- [ ] `/eden-test --quick` runs evaluation and shows results
- [ ] `/eden-bench` commands work (create, run, history)
- [ ] `/eden-explain` analyzes failures using KB context
- [ ] Automatic pipeline suggestions trigger on relevant input

---

## Phase 5: PR Workflow (Week 8)

**Goal:** Users can create pull requests directly from the CLI with structured bodies containing Eden context.

### 5.1 PR Manager
- [ ] Create `eden/pr_manager.py`:
  - `PRManager` class:
    - `create_branch(name)` → branch name (with Eden prefix)
    - `commit_changes(message, eden_context)` → commit SHA
    - `push_branch(branch, remote)` → bool
    - `create_pr(title, body, base, head, draft, reviewers, labels)` → PR URL
  - Support platforms:
    - GitHub: via `PyGithub` library
    - GitLab: via `python-gitlab` library
    - Bitbucket: via `httpx` direct API calls
  - Auto-detect platform from git remote URL
  - Store PR metadata in commit body (KB entries used, traces referenced)
- **Acceptance:** `PRManager.create_pr()` creates a real PR on GitHub

### 5.2 PR Body Template
- [ ] Implement structured PR body generation:
  ```markdown
  ## Summary
  {auto-generated from commit messages and chat history}

  ## Eden Context
  - **Knowledge used:** {KB entries referenced during this session}
  - **Observability data:** {traces/metrics analyzed}
  - **Best practices applied:** {from global KB}

  ## Changes
  {structured list of files changed with rationale}

  ## Test Results
  {Eden evaluation results if /eden-test was run}

  ## Checklist
  - [ ] Code follows team conventions
  - [ ] Tests pass
  - [ ] No new security issues
  - [ ] Documentation updated
  ```
- [ ] Track KB references and observability data used during the session
- **Acceptance:** PR body includes Eden context sections with real data

### 5.3 `/eden-pr` Slash Command
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_eden_pr(args)`:
    - `eden-pr` — create PR with auto-generated title and body
    - `eden-pr --title "Fix latency"` — custom title
    - `eden-pr --draft` — create as draft
    - `eden-pr --remote fork` — push to fork remote
  - Workflow:
    1. Ensure all changes are committed (prompt if not)
    2. Create feature branch with Eden prefix (`eden/{description-slug}`)
    3. Push to configured remote
    4. Create PR via platform API
    5. Display PR URL
- [ ] Add PR config to `.eden/config.yaml`:
  - `pr.platform`, `pr.remote`, `pr.base_branch`, `pr.branch_prefix`
  - `pr.auto_push`, `pr.draft_by_default`, `pr.default_reviewers`, `pr.default_labels`
  - `pr.commit_prefix`, `pr.auto_commit`
- **Acceptance:** `/eden-pr` creates a real PR with structured body

### 5.4 Commit Message Enhancement
- [ ] Override Aider's commit message generation:
  - Include Eden context metadata in commit body
  - Prefix with configurable prefix (default: `eden:`)
  - Auto-generate from chat context (what changed and why)
- [ ] Add `auto_commit` config option (default: true, like Aider)
- **Acceptance:** Commit messages include Eden context metadata

### 5.5 Tests for PR Workflow
- [ ] Unit tests: mock GitHub/GitLab API, test PR creation
- [ ] Unit tests: test PR body template generation
- [ ] Unit tests: test branch naming and prefix logic
- [ ] Integration test: end-to-end edit → commit → PR flow
- **Acceptance:** All PR workflow tests pass

#### M5 Milestone Check (End of Week 8)
- [ ] `/eden-pr` creates real PRs on GitHub/GitLab
- [ ] PR bodies include Eden context (KB, observability, test results)
- [ ] Commit messages include Eden metadata
- [ ] Branch management with Eden prefix works

---

## Phase 6: `/integrate-eden` Command (Weeks 9–10)

**Goal:** The signature command — auto-analyzes a user's agent codebase and integrates Eden SDK + eval harness.

### Week 9: Codebase Analyzer & SDK Integration

#### 6.1 Framework Detector
- [ ] Create `eden/framework_detector.py`:
  - `FrameworkDetector` class:
    - `detect(project_path)` → `DetectionResult`
    - Returns: language, framework, entry_points, dependencies, has_tests, has_ci
  - Detection logic:
    - Python: check imports for `langchain`, `crewai`, `autogen`, `llama_index`, `openai`, `anthropic`
    - TypeScript: check `package.json` for framework deps
    - Entry points: find files with `if __name__ == "__main__"`, `app = FastAPI()`, `main()` functions
    - Existing instrumentation: check for `opentelemetry`, `tracing`, `logging` setup
    - Test infrastructure: check for `pytest.ini`, `jest.config`, `tests/` directory
    - CI/CD: check for `.github/workflows/`, `Jenkinsfile`, `.gitlab-ci.yml`
- [ ] Create `eden/framework_models.py`:
  - `DetectionResult(language, framework, entry_points, deps, has_tests, has_ci)`
  - `Framework` enum: `langchain`, `crewai`, `autogen`, `llama_index`, `openai_sdk`, `anthropic_sdk`, `custom`, `unknown`
- **Acceptance:** `FrameworkDetector.detect("./my-langchain-agent")` correctly identifies LangChain

#### 6.2 SDK Integration Generator
- [ ] Create `eden/sdk_integrator.py`:
  - `SDKIntegrator` class:
    - `generate_integration(detection_result, config)` → `list[FileChange]`
  - For Python agents:
    - Add `eden-sdk` to `requirements.txt` or `pyproject.toml`
    - Create `.eden/config.yaml` with project settings
    - Add auto-instrumentation decorator to entry points:
      ```python
      from eden_sdk import trace_agent

      @trace_agent(agent_id="my-agent", org_id="...")
      def run_agent(input):
          ...
      ```
    - Add telemetry export configuration
    - Create `.env.example` with `EDEN_API_KEY`, `EDEN_ORG_ID`, `EDEN_BASE_URL`
  - For TypeScript agents:
    - Add `@eden/sdk` to `package.json`
    - Similar decorator/wrapper pattern
- [ ] File changes are presented as diffs for user review
- **Acceptance:** SDK integration generates valid code for LangChain, CrewAI, and custom agents

#### 6.3 Eval Harness Generator
- [ ] Create `eden/eval_harness.py`:
  - `EvalHarnessGenerator` class:
    - `generate_harness(detection_result, agent_spec)` → `list[FileChange]`
  - Analyze agent's I/O contract:
    - Input format (text, JSON, structured messages)
    - Output format (text, JSON, tool calls)
    - Expected behavior description (from user prompt or code analysis)
  - Generate `eden-eval.yaml`:
    ```yaml
    agent:
      name: "my-agent"
      entry_point: "agent.py:run_agent"
      input_format: "text"
      output_format: "text"

    evaluation:
      categories:
        - instantiation
        - step_validity
        - reward_non_degeneracy
      custom_criteria:
        - name: "response_quality"
          description: "Agent responses are coherent and helpful"
    ```
  - Generate test harness wrapper: `tests/eden_eval_harness.py`
  - Generate baseline benchmark config
- **Acceptance:** Generated harness is valid and can be submitted to Eden pipeline

### Week 10: CI Integration & Command Assembly

#### 6.4 CI Integration Generator
- [ ] Create `eden/ci_generator.py`:
  - `CIGenerator` class:
    - `generate_github_action(config)` → `FileChange`
    - `generate_gitlab_ci(config)` → `FileChange`
  - GitHub Action: `.github/workflows/eden-eval.yml`
    ```yaml
    name: Eden Evaluation
    on: [pull_request]
    jobs:
      eval:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - uses: eden-ai/eden-eval-action@v1
            with:
              api-key: ${{ secrets.EDEN_API_KEY }}
              org-id: ${{ secrets.EDEN_ORG_ID }}
    ```
  - GitLab CI: `.gitlab-ci.yml` (similar)
- [ ] Make CI generation optional (ask user during `/integrate-eden`)
- **Acceptance:** Generated GitHub Action is valid YAML and would work

#### 6.5 `/integrate-eden` Command Assembly
- [ ] Implement in `eden/commands/eden_commands.py`:
  - `cmd_integrate_eden(args)`:
    - `eden-integrate-eden` — full integration
    - `eden-integrate-eden --skip-ci` — skip CI generation
    - `eden-integrate-eden --skip-eval` — skip eval harness
  - Workflow:
    1. Detect framework (`FrameworkDetector`)
    2. Generate SDK integration (`SDKIntegrator`)
    3. Generate eval harness (`EvalHarnessGenerator`)
    4. Generate CI config (`CIGenerator`) — ask user first
    5. Present all changes as diffs for review
    6. Apply changes (respect autonomy mode)
    7. Offer to run `/eden-test --quick` to establish baseline
- [ ] Create `eden/integrator.py` — orchestrates the full integration flow
- **Acceptance:** `/integrate-eden` on a LangChain project produces valid, runnable integration

#### 6.6 Tests for Integration
- [ ] Unit tests: test framework detection on sample projects (LangChain, CrewAI, custom)
- [ ] Unit tests: test SDK integration generation for Python and TypeScript
- [ ] Unit tests: test eval harness generation
- [ ] Unit tests: test CI config generation
- [ ] Integration test: run `/integrate-eden` on a real sample project
- [ ] Create sample test projects in `tests/fixtures/`:
  - `sample-langchain-agent/`
  - `sample-crewai-agent/`
  - `sample-custom-agent/`
- **Acceptance:** All integration tests pass; sample projects integrate successfully

#### M6 Milestone Check (End of Week 10)
- [ ] `/integrate-eden` detects framework correctly
- [ ] SDK integration generates valid instrumentation code
- [ ] Eval harness is generated and can be submitted to pipeline
- [ ] CI config is generated (GitHub Actions, GitLab CI)
- [ ] Full flow works: `/integrate-eden` → `/eden-test --quick` → `/eden-pr`

---

## Phase 7: Autonomy Model (Week 11)

**Goal:** Configurable autonomy levels with approval gates and safety guardrails.

### 7.1 Autonomy Configuration
- [ ] Create `eden/autonomy.py`:
  - `AutonomyManager` class:
    - `should_approve(action_type)` → bool
    - `request_approval(action_type, description)` → bool
    - `get_mode()` → `AutonomyMode`
  - Action types: `file_edit`, `test_run`, `pr_create`, `pipeline_invoke`, `kb_write`, `shell_command`, `destructive`
  - Mode mapping per spec:
    - `approval`: require approval for all significant actions
    - `semi-autonomous`: auto-approve file edits and tests, require approval for PRs and pipelines
    - `autonomous`: auto-approve everything
  - Per-action overrides from config
- **Acceptance:** `AutonomyManager.should_approve("pr_create")` returns correct value for each mode

### 7.2 Approval Gate UI
- [ ] Override Aider's `confirm_ask()` in `EdenIO`:
  - For file edits: "Apply this change? [y/n/d(etails)]"
  - For test runs: "Run evaluation? [y/n]"
  - For PR creation: "Create PR on {platform}? [y/n/d(etails)]"
  - For pipeline invocation: "Run Eden pipeline? [y/n]"
  - Details: show what will be changed/run/created
- [ ] Support `--autonomous` and `--semi-autonomous` CLI flags
- [ ] Support per-action config overrides
- **Acceptance:** Approval gates work correctly in all three modes

### 7.3 Safety Guardrails
- [ ] Implement safety checks (always active regardless of mode):
  - Never push to `main`/`master` without explicit confirmation
  - Never delete files without confirmation
  - Never modify `.env`, `.env.*`, `secrets.*`, `*.key`, `*.pem` files
  - Never run shell commands in autonomous mode that contain `rm -rf`, `sudo`, `curl | bash`
  - Always create a feature branch before making changes
  - Rate-limit pipeline invocations (max 5 per hour)
- [ ] Add secret detection:
  - Scan file changes for API keys, tokens, passwords before committing
  - Block commit if secrets detected (with override option)
- **Acceptance:** Safety guardrails block dangerous operations correctly

### 7.4 `/undo` for Eden Actions
- [ ] Extend Aider's `/undo` to cover Eden actions:
  - Pipeline invocations: cancel running job
  - PR creation: close PR (if created in this session)
  - KB writes: N/A (read-only from CLI)
- [ ] Track all Eden actions in session for undo support
- **Acceptance:** `/undo` reverts last Eden action (edit, commit, PR)

### 7.5 Tests for Autonomy
- [ ] Unit tests: test autonomy mode switching
- [ ] Unit tests: test per-action overrides
- [ ] Unit tests: test safety guardrails (secret detection, branch protection)
- [ ] Unit tests: test approval gate UI (mock user responses)
- [ ] Integration test: end-to-end flow in each autonomy mode
- **Acceptance:** All autonomy tests pass

#### M7 Milestone Check (End of Week 11)
- [ ] Three autonomy modes work correctly
- [ ] Approval gates prompt user appropriately
- [ ] Safety guardrails block dangerous operations
- [ ] `/undo` works for all Eden actions
- [ ] Secret detection prevents accidental credential commits

---

## Phase 8: Testing, Polish & Release (Week 12)

**Goal:** Production-ready release candidate with comprehensive tests, documentation, and polished UX.

### 8.1 Aider Compatibility Testing
- [ ] Run full Aider test suite against fork:
  - `pytest tests/` — all existing tests must pass
  - Document any tests that needed modification and why
- [ ] Test all original slash commands:
  - `/add`, `/drop`, `/undo`, `/diff`, `/run`, `/lint`, `/test`, `/map`, `/tokens`, `/help`
- [ ] Test all edit formats:
  - `editblock`, `whole`, `udiff`, `patch`, `architect`
- [ ] Test repo map generation on various project sizes
- [ ] Test streaming LLM responses
- **Acceptance:** Zero Aider test regressions

### 8.2 End-to-End Integration Tests
- [ ] Test full workflow: launch → integrate-eden → test → improve → PR
- [ ] Test with sample projects:
  - LangChain agent (Python)
  - CrewAI agent (Python)
  - Custom OpenAI agent (Python)
  - Custom agent (TypeScript)
- [ ] Test edge cases:
  - No Eden API connection (offline mode)
  - Invalid API key
  - Large codebase (>1000 files)
  - Empty project (no files)
  - No git repository
- **Acceptance:** All E2E tests pass on all sample projects

### 8.3 Documentation
- [ ] Write `README.md`:
  - Installation (`pip install eden[cli-tui]` or `pipx install`)
  - Quick start (3 steps: install, configure, run)
  - Command reference table
  - Configuration reference
  - Troubleshooting
- [ ] Write `CONTRIBUTING.md`:
  - Development setup
  - Fork maintenance process (upstream rebase)
  - Testing guidelines
- [ ] Write `CHANGELOG.md` for v0.1.0
- [ ] Generate CLI help text: `eden --help`, `eden <command> --help`
- **Acceptance:** Documentation is complete and accurate

### 8.4 Packaging & Distribution
- [ ] Update `pyproject.toml`:
  - Package name: `eden-agent-cli`
  - Version: `0.1.0`
  - Entry point: `eden = "aider.main:main"`
  - Dependencies: include all Aider deps + Eden additions
  - Optional deps: `[cli-tui]` extra
- [ ] Test installation:
  - `pip install -e .` (development)
  - `pip install .` (standard)
  - `pipx install .` (isolated)
- [ ] Test on multiple platforms:
  - macOS (primary)
  - Linux (Ubuntu, Debian)
  - Windows (WSL)
- **Acceptance:** Package installs cleanly on all platforms

### 8.5 Performance & Polish
- [ ] Profile startup time (target: &lt;3 seconds)
- [ ] Profile KB context query latency (target: &lt;2 seconds)
- [ ] Profile observability context query latency (target: &lt;2 seconds)
- [ ] Add loading indicators for slow operations
- [ ] Polish error messages (no raw tracebacks in user-facing output)
- [ ] Add `--quiet` mode for scripting
- [ ] Add `--json` output mode for CI integration
- **Acceptance:** Startup <3s, all operations feel responsive

### 8.6 Release Checklist
- [ ] All tests pass (Aider + Eden)
- [ ] Documentation complete
- [ ] CHANGELOG updated
- [ ] Version bumped to `0.1.0`
- [ ] Tag release: `git tag v0.1.0`
- [ ] Publish to PyPI (or internal registry)
- [ ] Announce in team channels

#### M8 Milestone Check (End of Week 12)
- [ ] Zero Aider test regressions
- [ ] All E2E integration tests pass
- [ ] Documentation complete
- [ ] Package installs on all platforms
- [ ] Performance meets targets
- [ ] v0.1.0 tagged and ready for release

---

## Post-Release: Future Phases

### Phase 9: `/eden-improve` Command (Week 13–14)
- [ ] Build observability-informed improvement suggestion engine
- [ ] Analyze traces for patterns (slow tools, frequent errors, high costs)
- [ ] Query KB for best practices relevant to observed issues
- [ ] Generate code diffs with improvements
- [ ] Create PR with improvements

### Phase 10: Model Routing Optimization (Week 15)
- [ ] Use Eden's model routing to auto-select cheapest model per task
- [ ] A/B test model quality vs. cost
- [ ] Add cost tracking and budget alerts

### Phase 11: Plugin System (Week 16–17)
- [ ] Allow users to add custom slash commands
- [ ] Allow users to add custom KB sources
- [ ] Allow users to add custom context providers

### Phase 12: Multi-Agent Collaboration (Week 18+)
- [ ] Multiple developers sharing KB context in real-time
- [ ] Shared session state
- [ ] Collaborative editing

---

## Dependency Graph

```
Phase 1 (Fork & Core)
  ├── Phase 2 (KB Integration)
  │     ├── Phase 3 (Observability)
  │     │     ├── Phase 4 (Pipeline)
  │     │     │     ├── Phase 5 (PR Workflow)
  │     │     │     │     └── Phase 6 (/integrate-eden)
  │     │     │     │           └── Phase 7 (Autonomy)
  │     │     │     │                 └── Phase 8 (Testing & Polish)
  │     │     │     └── Phase 6 can start partially in parallel
  │     │     └── Phase 5 can start in parallel with Phase 4
  │     └── Phase 3 can start in parallel with late Phase 2
  └── Phase 2 can start as soon as API client is ready
```

**Critical path:** Phase 1 → Phase 2 → Phase 4 → Phase 6 → Phase 7 → Phase 8

---

## Resource Allocation

| Phase | Engineer 1 | Engineer 2 | Engineer 3 |
|---|---|---|---|
| **Phase 1** (Wk 1–2) | Fork, branding, config | API client, model routing | Entry point, banner |
| **Phase 2** (Wk 3–4) | KB context provider | Context injection | KB commands, tests |
| **Phase 3** (Wk 5) | Obs context provider | /eden-traces command | Tests |
| **Phase 4** (Wk 6–7) | Pipeline invoker | Progress display, /eden-test | /eden-bench, /eden-explain |
| **Phase 5** (Wk 8) | PR manager | /eden-pr command | Commit enhancement, tests |
| **Phase 6** (Wk 9–10) | Framework detector, SDK integrator | Eval harness generator | CI generator, /integrate-eden |
| **Phase 7** (Wk 11) | Autonomy model | Approval gates, safety | /undo, tests |
| **Phase 8** (Wk 12) | Aider compatibility | E2E tests | Docs, packaging |

---

## Risk Mitigation

| Risk | Mitigation | Owner | When |
|---|---|---|---|
| Aider upstream breakage | Quarterly rebase strategy; minimal footprint | Eng 1 | Ongoing |
| Context injection breaks prompting | Fallback to non-Eden mode; extensive testing | Eng 2 | Phase 2 |
| Eden API latency affects UX | Caching; async queries; loading indicators | Eng 2 | Phase 2–4 |
| Framework detection unreliable | Graceful fallback to generic; manual override | Eng 1 | Phase 6 |
| Large codebases exceed context budget | Progressive pruning; token budget management | Eng 3 | Phase 2 |
| GitHub API rate limits | Token auth; rate limit handling; caching | Eng 3 | Phase 5 |
