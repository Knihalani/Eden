# Eden Agent CLI — Full Specification

**Version:** 1.0
**Date:** June 6, 2026
**Status:** Draft

---

## 1. Vision & Scope

### 1.1 What This Is

Eden Agent CLI is a terminal-based coding agent that serves as the primary developer interface for building, testing, observing, and improving AI agents. It replaces the current thin Click-based CLI with a rich, interactive TUI forked from [Aider](https://github.com/paul-gauthier/aider), extended with Eden's full pipeline, knowledge base, observability telemetry, and evaluation capabilities.

The CLI is **not** just a slash-command plugin. It is a fully Eden-aware coding agent that:
- Understands the user's agent codebase by indexing it at launch
- Automatically invokes Eden's pipeline when contextually appropriate
- Draws on both global and tenant knowledge bases during reasoning
- Can generate evaluation environments, open PRs, and integrate Eden SDK into any agent codebase
- Surfaces observability insights in its reasoning context (visualizations live in the web portal)

### 1.2 Target Users

- **Individual agent developers** building LLM agents in any framework (LangChain, CrewAI, AutoGen, LlamaIndex, custom)
- **Platform/infra teams** integrating Eden into CI/CD workflows and team development practices
- **Organizations** using Eden's multi-tenant platform for agent development at scale

### 1.3 Core Principles

1. **Eden-native, not Eden-adjacent.** The coding agent is built around Eden's capabilities, not retrofitted with them.
2. **Observability-informed reasoning.** The agent reads telemetry data (traces, LLM calls, tool calls, latency, costs, failure modes) and uses it to inform every suggestion.
3. **Knowledge-compounding.** Every interaction feeds back into the tenant KB. The agent gets smarter over time.
4. **Configurable autonomy.** Default to approval gates for significant actions; support `--autonomous` mode for power users.
5. **Framework-agnostic.** Treat agents as black boxes by default; analyze via inputs/outputs and observability traces.

---

## 2. Architecture

### 2.1 Fork Strategy: Aider

The CLI is forked from [Aider](https://github.com/paul-gauthier/aider) — the most popular terminal-based AI coding assistant. Aider provides:

- **Multi-file editing** with structured edit formats (whole, diff, udiff)
- **Git integration** (auto-commit, branch management, PR-ready commits)
- **Codebase indexing** via tree-sitter and grep-based search
- **Chat-based interaction** with streaming LLM responses
- **Context management** (auto-adds relevant files, repo map generation)
- **Model-agnostic** LLM backend (OpenAI, Anthropic, local models, OpenRouter)
- **Clean CLI UX** with rich terminal formatting

**What we keep from Aider:**
- Core chat loop, edit application, git integration, repo map generation
- LLM abstraction layer (extended to support Eden's model routing)
- Multi-file editing and structured edit formats
- Terminal UX patterns (streaming, syntax highlighting, file change display)

**What we replace/extend:**
- Replace Aider's manual `/add` file discovery with Eden's auto-indexing + KB-aware context
- Extend git integration with configurable remote PR creation (GitHub API, GitLab API)
- Add Eden pipeline invocation, KB query, observability context, eval harness generation
- Add `/integrate-eden` command and Eden-specific slash commands
- Replace Aider's model selection with Eden's LLM routing (per-agent model slots)
- Add multi-tenant auth (API key + org ID) and Eden API client
- Add configurable autonomy levels and approval gates

### 2.2 System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Eden Agent CLI (TUI)                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Chat Loop (from Aider)                                  │   │
│  │  - User input → LLM → Edit proposals → Apply/Reject      │   │
│  │  - Streaming responses with syntax highlighting           │   │
│  │  - Configurable autonomy: approval gates or --autonomous  │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐   │
│  │ Repo Map &   │ │ Eden KB      │ │ Observability          │   │
│  │ Codebase     │ │ Client       │ │ Context Provider       │   │
│  │ Indexer      │ │ (global +    │ │ (traces, metrics,      │   │
│  │ (tree-sitter │ │  tenant)     │ │  costs, failure modes) │   │
│  │  + grep)     │ │              │ │                        │   │
│  └──────────────┘ └──────────────┘ └────────────────────────┘   │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐   │
│  │ Eden Pipeline│ │ Git + PR     │ │ /integrate-eden        │   │
│  │ Invoker      │ │ Manager      │ │ (SDK + eval harness    │   │
│  │ (eval envs,  │ │ (local +     │ │  auto-integration)     │   │
│  │  testing)    │ │  remote PRs) │ │                        │   │
│  └──────────────┘ └──────────────┘ └────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Eden API Client (SDK)                                   │   │
│  │  - Auth (API key + org)                                  │   │
│  │  - Pipeline jobs, KB queries, telemetry, eval harnesses  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Eden API       │  │  Knowledge Base │  │  Observability  │
│  Server         │  │  (Global +      │  │  Pipeline       │
│  (FastAPI)      │  │   Tenant)       │  │  (Telemetry     │
│                 │  │                 │  │   Collector)    │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### 2.3 Knowledge Base Integration Model

The CLI accesses two distinct knowledge domains, injected for different purposes:

**Global KB (Eden's accumulated intelligence):**
- Best practices for agent design patterns
- Common failure modes and prevention rules (from Archivist)
- Exploit library (adversarial probes for known vulnerability categories)
- Framework facts and API compatibility data
- Research findings (from Research Harvester)
- Skill library (reusable code patterns)

*When injected:* During agent reasoning about architecture decisions, test design, error diagnosis, and improvement suggestions. The global KB provides "what Eden has learned from all jobs across all tenants."

**Tenant KB (organization-specific data):**
- Full observability telemetry (traces, LLM calls, tool calls, latency, costs)
- Agent-specific code patterns and quality standards
- Historical job results and evaluation outcomes
- Custom probes and evaluation criteria
- Team-specific conventions and style guides

*When injected:* When analyzing the specific agent's behavior, diagnosing failures from traces, generating tests targeting observed weaknesses, and maintaining consistency with team standards.

**Injection mechanism:**
- The Eden API client transparently queries both KBs based on the current context
- Global KB is queried via `/v1/kb/query` with `scope=global`
- Tenant KB is queried via `/v1/kb/query` with `scope=tenant` (org-scoped via API key)
- Results are formatted and injected into the LLM's system context as structured knowledge blocks
- The agent's reasoning prompt includes explicit sections: `[GLOBAL KNOWLEDGE]` and `[TENANT CONTEXT]`

### 2.4 Observability Data Flow

Observability data does **not** render as raw TUI panels. Instead:

1. **Agent reasoning layer:** The coding agent's system prompt includes a `[OBSERVABILITY CONTEXT]` section populated with:
   - Recent trace summaries (last N traces for this agent/project)
   - Error distributions and failure mode classifications
   - Latency percentiles (p50, p95, p99) per tool/operation
   - Cost breakdowns (LLM spend, token usage, per-request costs)
   - Quality trends over time (test pass rates, exploit scan results)

2. **Web portal:** Rich visualizations (trace timelines, heatmaps, flame graphs, cost dashboards) are viewed in the Eden web portal at `{base_url}/portal/{org_id}/observability`

3. **CLI references:** The agent can reference portal URLs inline: "I found a latency spike in your search tool — here's the trace: `{portal_url}/traces/{trace_id}`"

---

## 3. Slash Commands

### 3.1 Standard Aider Commands (Retained)

All Aider slash commands are retained and function as-is:
- `/add <file>` — Add file to chat context
- `/drop <file>` — Remove file from chat context
- `/undo` — Undo last git commit
- `/diff` — Show diff of last change
- `/run <cmd>` — Run a shell command
- `/lint` — Run linter
- `/test` — Run tests
- `/map` — Show repo map
- `/tokens` — Show token usage
- `/help` — Show help

### 3.2 Eden-Specific Commands

#### `/integrate-eden`
**The signature Eden command.** Analyzes the user's agent codebase and auto-integrates Eden.

**What it does:**
1. **Codebase analysis:** Scans the project for:
   - Entry points (main scripts, server files, agent definitions)
   - Framework detection (LangChain, CrewAI, AutoGen, LlamaIndex, custom)
   - Existing instrumentation (OpenTelemetry, logging, tracing)
   - Test infrastructure (pytest, jest, etc.)
   - CI/CD configuration (GitHub Actions, etc.)

2. **SDK integration:**
   - Installs `@eden/sdk` (TypeScript) or `eden-sdk` (Python) as a dependency
   - Adds auto-instrumentation decorators to agent entry points
   - Configures telemetry export to Eden's API endpoint
   - Sets up environment variables (`EDEN_API_KEY`, `EDEN_ORG_ID`, `EDEN_BASE_URL`)
   - Creates `.eden/config.yaml` with project-specific settings

3. **Eval harness generation:**
   - Analyzes the agent's input/output contract
   - Generates an Eden evaluation harness wrapping the agent
   - Creates initial evaluation criteria based on the agent's stated purpose
   - Sets up a baseline benchmark configuration
   - Generates a `eden-eval.yaml` describing the evaluation environment

4. **CI integration (optional):**
   - Adds Eden GitHub Action to `.github/workflows/`
   - Configures automatic eval runs on PR
   - Sets up benchmark regression detection

**Output:** A series of file changes presented to the user for review (or auto-applied in `--autonomous` mode).

#### `/eden-test`
Runs Eden's evaluation pipeline against the user's agent.

```
/eden-test [--quick] [--full] [--focus <category>]
```

- `--quick`: Run only the most relevant test categories (instantiation, step validity, reward non-degeneracy)
- `--full`: Run all 12 test categories
- `--focus <category>`: Run a specific category (e.g., `exploit_scan`, `mutation_testing`, `edge_case_stress`)

**Behavior:**
1. Uses the eval harness generated by `/integrate-eden` (or creates one on the fly)
2. Submits a job to Eden's pipeline via API
3. Streams progress back to the TUI (stage name, completion %)
4. Displays results summary when complete
5. Offers to open the full report in the web portal
6. If failures found, offers to analyze root cause using KB context

#### `/eden-improve`
Analyzes the agent's code and observability data, then generates improvement suggestions.

```
/eden-improve [--type <code|tests|architecture>] [--depth <quick|deep>]
```

**Behavior:**
1. Pulls recent observability data for the agent (traces, errors, latency)
2. Queries tenant KB for code patterns and quality standards
3. Queries global KB for best practices relevant to this agent's framework/domain
4. Analyzes gaps between current implementation and best practices
5. Generates specific improvement suggestions with:
   - Code diffs for direct improvements
   - New test cases targeting observed failure modes
   - Architecture suggestions for structural issues
6. Presents changes for review (or applies in autonomous mode)

#### `/eden-explain`
Analyzes a specific failure or issue using Eden's knowledge.

```
/eden-explain <issue description or trace ID>
```

**Behavior:**
1. If given a trace ID, fetches the full trace from observability
2. Queries global KB for known failure modes matching this pattern
3. Queries tenant KB for historical occurrences of this issue
4. Provides a root cause analysis with:
   - Explanation of what happened
   - Why it happened (with KB evidence)
   - How to fix it (with code suggestions)
   - How to prevent it (with test/eval suggestions)

#### `/eden-kb`
Direct knowledge base query interface.

```
/eden-kb query <search text>
/eden-kb query --global <search text>
/eden-kb query --tenant <search text>
/eden-kb stats
```

- `query`: Search both global and tenant KB, display merged results
- `query --global`: Search only global KB (best practices, failure modes, exploits)
- `query --tenant`: Search only tenant KB (observability, code patterns, history)
- `stats`: Show KB health metrics (entry count, freshness, retrieval hit rate)

#### `/eden-traces`
View and analyze observability traces.

```
/eden-traces [--limit N] [--agent-id <id>] [--realm <env|prod>]
/eden-traces show <trace_id>
/eden-traces compare <trace_id_1> <trace_id_2>
```

- List recent traces with summary (duration, outcome, error count)
- Show detailed trace with span tree (rendered as ASCII art in TUI)
- Compare environment vs. production trace

#### `/eden-pr`
Create a pull request from the current changes.

```
/eden-pr [--title <title>] [--body <body>] [--remote <origin|fork>] [--draft]
```

**Behavior:**
1. Ensures all changes are committed on a feature branch
2. Pushes to configured remote (origin or fork)
3. Creates PR via GitHub/GitLab API with:
   - Auto-generated title based on changes
   - Body includes: change summary, Eden test results, KB context used, observability data referenced
   - Labels based on change type (improvement, bugfix, test, architecture)
4. If `--draft`, creates as draft PR

**Configuration (in `.eden/config.yaml`):**
```yaml
pr:
  remote: origin          # or fork
  auto_push: true
  draft_by_default: false
  platform: github        # or gitlab
  default_reviewers: []
  labels: ["eden-improved"]
```

#### `/eden-pipeline`
Manually invoke the full Eden pipeline.

```
/eden-pipeline --description <desc>
/eden-pipeline --spec-file <path>
```

Submits an environment generation job and streams progress. Same as `eden generate` but with rich TUI progress display.

#### `/eden-bench`
Run or manage benchmarks against the agent.

```
/eden-bench create --name <name> --criteria <json>
/eden-bench run <benchmark_id>
/eden-bench compare <baseline_id> <current_id>
/eden-bench history
```

---

## 4. Autonomy Model

### 4.1 Autonomy Levels

The CLI supports three autonomy modes, configurable per-session or globally:

**Approval Mode (default):**
- All file edits require user approval before application
- Test runs require approval (unless `--auto-test` is set)
- PR creation always requires explicit approval
- KB writes require approval
- Pipeline invocations require approval

**Semi-Autonomous Mode (`--semi-autonomous`):**
- File edits within the current working directory are auto-applied
- Test runs are auto-approved
- PR creation requires approval
- KB writes require approval
- Pipeline invocations are auto-approved for quick runs; full runs require approval

**Autonomous Mode (`--autonomous`):**
- All actions are auto-applied
- PRs are created without asking
- Pipeline invocations run without asking
- A summary of all actions is displayed at the end
- User can always `/undo` to revert

### 4.2 Per-Action Overrides

Individual actions can be toggled regardless of mode:

```yaml
# .eden/config.yaml
autonomy:
  mode: approval                    # approval | semi-autonomous | autonomous
  auto_test: true                   # Run tests without asking
  auto_lint: true                   # Run linter without asking
  auto_pr: false                    # Never auto-create PRs
  auto_pipeline: false              # Never auto-invoke full pipeline
  auto_kb_write: false              # Never auto-write to tenant KB
  confirm_destructive: true         # Always confirm destructive operations
```

### 4.3 Safety Guardrails

Regardless of autonomy mode:
- Never push to `main`/`master` without explicit confirmation
- Never delete files without confirmation
- Never modify `.env` files or secrets
- Never run arbitrary user-provided shell commands in autonomous mode
- Always create a git branch before making changes (never commit directly to current branch)
- Rate-limit pipeline invocations (max 5 per hour by default)

---

## 5. Eden Pipeline Integration

### 5.1 Automatic Pipeline Invocation

The coding agent recognizes contextual triggers and suggests (or auto-invokes) Eden's pipeline:

**Triggers for suggesting `/eden-test`:**
- User asks "test my agent" or "how good is my agent"
- After significant code changes to agent logic
- When user mentions "benchmark", "evaluate", "score"
- After `/integrate-eden` completes (suggest running initial baseline)

**Triggers for suggesting `/eden-improve`:**
- When observability data shows degradation in latency, cost, or error rates
- When user asks "how can I improve" or "what's wrong with my agent"
- After a test run reveals failures

**Triggers for suggesting `/eden-pipeline`:**
- When user describes a new environment/eval they need
- When user asks for "a test environment for X"
- When discussing evaluation strategy

### 5.2 Pipeline Progress Display

When a pipeline job is running, the TUI shows:

```
┌─ Eden Pipeline ──────────────────────────────────────────────┐
│ Job: job_abc123  │  Status: running                          │
│                                                              │
│  ✅ Planner        ─── EDP generated (3 iterations)          │
│  ✅ Critic          ─── Approved with notes                  │
│  ✅ Refiner         ─── RES complete                         │
│  ✅ Fact Checker    ─── All claims verified                   │
│  🔄 Executor        ─── Generating code (pass 2/3)          │
│  ⏳ Code Quality    ─── Waiting                              │
│  ⏳ Verifier        ─── Waiting                              │
│  ⏳ Tester          ─── Waiting                              │
│  ⏳ Archivist       ─── Waiting                              │
│                                                              │
│  [████████████░░░░░░░░░░] 58%  │  ETA: ~4 min              │
│  Cost so far: $1.23           │  LLM calls: 14              │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 Results Integration

When a pipeline job completes:
- Results are displayed inline in the TUI
- Test reports are parsed and summarized
- Failures are analyzed using KB context
- The agent offers to:
  - Download the generated environment code
  - Run the evaluation against the user's agent
  - Create a PR with the generated eval environment
  - Explain any failures and suggest fixes

---

## 6. PR Workflow

### 6.1 Configuration

```yaml
# .eden/config.yaml
pr:
  platform: github              # github | gitlab | bitbucket
  remote: origin                # remote name
  base_branch: main             # base branch for PRs
  branch_prefix: eden/          # branch naming prefix
  auto_push: true               # push before creating PR
  draft_by_default: false       # create PRs as drafts
  default_reviewers: []         # auto-add reviewers
  default_labels: ["eden"]      # auto-add labels
  commit_prefix: "eden:"        # commit message prefix
  auto_commit: true             # auto-commit after changes (like Aider)
```

### 6.2 PR Body Template

Every PR created by the CLI includes a structured body:

```markdown
## Summary
{auto-generated summary of changes}

## Eden Context
- **Knowledge used:** {list of KB entries referenced}
- **Observability data:** {traces/metrics analyzed}
- **Best practices applied:** {from global KB}

## Changes
{structured list of changes with rationale}

## Test Results
{Eden evaluation results if applicable}
- Pass rate: X/Y
- Categories: {summary}
- Exploits detected: {count}

## Checklist
- [ ] Code follows team conventions
- [ ] Tests pass
- [ ] No new security issues
- [ ] Documentation updated
```

### 6.3 Commit Practices

Configurable commit behavior:
- `auto_commit: true` — Auto-commit after each successful edit (like Aider)
- `auto_commit: false` — User manually stages and commits
- Commit messages are auto-generated from change descriptions
- Prefix configurable (default: `eden:`)
- Each commit includes Eden context metadata in the commit body

---

## 7. Configuration

### 7.1 Config File Location

`~/.eden/config.yaml` (global) + `./.eden/config.yaml` (project-local, overrides global)

### 7.2 Full Config Schema

```yaml
# Authentication
api_key: ${EDEN_API_KEY}
org_id: ${EDEN_DEFAULT_ORG}
base_url: ${EDEN_BASE_URL:-http://localhost:8000}

# LLM Configuration
model:
  primary: anthropic/claude-sonnet-4        # Main coding model
  fast: deepseek/deepseek-v4-flash:free     # Quick tasks (linting, summarization)
  reasoning: anthropic/claude-sonnet-4      # Complex reasoning tasks
  provider: openrouter                       # LLM provider

# Autonomy
autonomy:
  mode: approval
  auto_test: true
  auto_lint: true
  auto_pr: false
  auto_pipeline: false
  auto_kb_write: false
  confirm_destructive: true

# PR Workflow
pr:
  platform: github
  remote: origin
  base_branch: main
  branch_prefix: eden/
  auto_push: true
  draft_by_default: false
  default_reviewers: []
  default_labels: ["eden"]
  commit_prefix: "eden:"
  auto_commit: true

# Knowledge Base
kb:
  global_enabled: true
  tenant_enabled: true
  context_budget_tokens: 4000    # Max tokens for KB context injection
  retrieval_limit: 10            # Max entries per query
  auto_query: true               # Auto-query KB on relevant context

# Observability
observability:
  context_enabled: true          # Inject observability data into agent context
  trace_limit: 20                # Recent traces to include
  include_costs: true
  include_latency: true
  include_errors: true
  portal_url: null               # Auto-derived from base_url

# Pipeline
pipeline:
  auto_suggest: true             # Suggest pipeline invocations contextually
  poll_interval_seconds: 5
  timeout_seconds: 1800
  show_progress: true

# Eden CLI (original thin CLI commands)
eden:
  output_format: table           # json | table | yaml
  quiet: false
  verbose: false
```

### 7.3 Environment Variables

| Variable | Description | Default |
|---|---|---|
| `EDEN_API_KEY` | Eden API key | Required |
| `EDEN_DEFAULT_ORG` | Default organization ID | Required |
| `EDEN_BASE_URL` | Eden API base URL | `http://localhost:8000` |
| `EDEN_MODEL` | Primary LLM model override | `anthropic/claude-sonnet-4` |
| `EDEN_AUTONOMY` | Autonomy mode override | `approval` |
| `EDEN_QUIET` | Suppress non-essential output | `false` |

---

## 8. Technical Implementation Details

### 8.1 Fork Integration Plan

**Phase 1: Aider Fork & Core Modifications**
1. Fork Aider repository
2. Strip Aider-specific branding, update to Eden branding
3. Replace Aider's model selection with Eden's LLM routing (OpenRouter)
4. Replace Aider's repo map with Eden's enhanced codebase indexer
5. Add Eden API client (reuse existing `eden/sdk/client.py`)
6. Add multi-tenant auth layer

**Phase 2: Knowledge Base Integration**
1. Build KB context provider that queries both global and tenant KB
2. Implement context injection into system prompt (`[GLOBAL KNOWLEDGE]`, `[TENANT CONTEXT]`)
3. Add `/eden-kb` slash command
4. Add auto-query triggers (when agent discusses patterns, errors, architecture)
5. Implement token budget management for KB context

**Phase 3: Observability Context Provider**
1. Build observability context provider (queries Eden telemetry API)
2. Format trace summaries, error distributions, latency stats for LLM context
3. Add `/eden-traces` slash command
4. Add portal URL references in agent responses

**Phase 4: Pipeline Integration**
1. Add pipeline invoker (submits jobs, polls progress, displays in TUI)
2. Implement progress display widget (ASCII progress bars, stage indicators)
3. Add `/eden-test`, `/eden-pipeline`, `/eden-bench` commands
4. Add automatic pipeline suggestion triggers

**Phase 5: PR Workflow**
1. Extend git integration with GitHub/GitLab API client
2. Implement configurable PR creation (local branch, auto-push, remote PR)
3. Add `/eden-pr` command with structured PR body template
4. Add commit message generation with Eden context

**Phase 6: `/integrate-eden` Command**
1. Build codebase analyzer (framework detection, entry point discovery)
2. Build SDK integration generator (adds deps, decorators, config)
3. Build eval harness generator (creates eval environment from agent contract)
4. Build CI integration generator (GitHub Action config)

**Phase 7: Autonomy Model**
1. Implement approval gate system (prompt user for each action type)
2. Implement autonomy mode switching (per-session and global)
3. Add safety guardrails (branch protection, secret detection, rate limiting)
4. Add `/undo` support for all Eden actions

### 8.2 Eden API Client Extensions

The existing `eden/sdk/client.py` needs these new endpoints:

```python
class EdenClient:
    # Existing
    jobs: JobsResource
    environments: EnvironmentsResource
    benchmarks: BenchmarksResource

    # New for CLI
    async def query_kb(self, query: str, scope: str = "all", limit: int = 10) -> KBResult
    async def get_observability_context(self, org_id: str, agent_id: str = None) -> ObservabilityContext
    async def get_traces(self, org_id: str, limit: int = 20, **filters) -> list[Trace]
    async def get_trace_tree(self, org_id: str, trace_id: str) -> TraceTree
    async def analyze_agent(self, org_id: str, codebase_path: str) -> AgentAnalysis
    async def generate_eval_harness(self, org_id: str, agent_spec: dict) -> EvalHarness
    async def create_pr_metadata(self, org_id: str, changes: dict) -> PRMetadata
```

### 8.3 Project Initialization

When the user runs `eden` in a directory for the first time:

```
$ cd ./my-agent-project
$ eden

Eden Agent CLI — AI-native agent development

Detected: Python project with LangChain
Indexed: 47 files, 12,340 lines

✓ Knowledge base: connected (global + tenant)
✓ Observability: connected (23 recent traces found)
✓ Eval harness: not configured (run /integrate-eden to set up)

Ready. Ask me anything about your agent, or try:
  /integrate-eden    — Auto-integrate Eden into this project
  /eden-test         — Run evaluation against your agent
  /eden-improve      — Get improvement suggestions
  /eden-kb stats     — Check knowledge base health

> _
```

### 8.4 System Prompt Structure

The coding agent's system prompt is composed of layers:

```
[BASE SYSTEM PROMPT]
You are Eden Agent CLI, an AI-native coding assistant specialized in
agent development. You have access to Eden's pipeline, knowledge base,
and observability data.

[GLOBAL KNOWLEDGE]
{injected from global KB — best practices, failure modes, framework facts}

[TENANT CONTEXT]
{injected from tenant KB — team conventions, code patterns, quality standards}

[OBSERVABILITY CONTEXT]
{injected from telemetry — recent traces, error rates, latency, costs}

[CODEBASE CONTEXT]
{repo map, key files, detected framework, project structure}

[USER PREFERENCES]
{autonomy mode, PR config, model preferences}
```

---

## 9. CLI Entry Points

### 9.1 Primary: Interactive TUI (default)

```bash
eden                          # Launch interactive TUI in current directory
eden ./path/to/agent          # Launch in specific directory
eden --model anthropic/claude-sonnet-4  # Override default model
eden --autonomous             # Launch in autonomous mode
eden --org org_abc123         # Override default org
```

### 9.2 Legacy: Thin CLI Commands (backward compatible)

All existing Click commands continue to work:

```bash
eden generate --description "Multi-agent negotiation"
eden environment list
eden job list --status running
eden benchmark run bench_abc123 --target-code ./agent.py
eden ci run --commit-sha abc123
eden trace list
eden config show
eden config login
```

### 9.3 Non-Interactive: One-Shot Commands

```bash
eden --message "Fix the latency issue in my search tool" --non-interactive
eden --message "Run tests and open a PR" --non-interactive --autonomous
```

---

## 10. Web Portal Integration

The CLI and web portal are complementary:

| Capability | CLI (TUI) | Web Portal |
|---|---|---|
| Code editing | ✅ Primary | ❌ |
| Chat interaction | ✅ Primary | ❌ |
| KB querying | ✅ CLI commands | ✅ Visual explorer |
| Observability visualization | ❌ (ASCII only) | ✅ Primary (rich charts) |
| Trace analysis | ✅ Summary + inline | ✅ Full interactive |
| Pipeline management | ✅ CLI commands | ✅ Dashboard |
| PR management | ✅ CLI commands | ✅ Dashboard |
| Team collaboration | ❌ | ✅ Primary |
| Billing / settings | ❌ | ✅ Primary |
| Benchmark results | ✅ Summary | ✅ Full reports |

The CLI references portal URLs for rich visualizations: "View the full trace timeline at `{portal_url}/traces/{trace_id}`"

---

## 11. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| Time to first eval run | &lt;5 min from `eden` launch | Telemetry |
| `/integrate-eden` success rate | >90% on first attempt | Telemetry |
| PR acceptance rate | >70% of Eden-created PRs merged | GitHub API |
| KB context relevance | >80% of injected KB entries used in reasoning | Archivist scoring |
| Agent improvement delta | Measurable latency/cost/accuracy improvement per `/eden-improve` | Benchmark comparison |
| User retention (weekly) | >60% of users return within 7 days | Telemetry |
| Autonomy progression | >40% of users move to semi-autonomous within 2 weeks | Config telemetry |

---

## 12. Dependencies & Build

### 12.1 New Dependencies (Python)

```toml
# pyproject.toml additions
[project.optional-dependencies]
cli-tui = [
    "aider-chat>=0.60.0",       # Forked base
    "rich>=13.0.0",              # Terminal formatting
    "textual>=0.80.0",           # TUI framework (if extending beyond Aider's UX)
    "prompt-toolkit>=3.0.0",     # Input handling
    "pyyaml>=6.0",               # Config parsing
    "httpx>=0.27.0",             # HTTP client (for Eden API)
    "pygithub>=2.0.0",           # GitHub API (for PR creation)
    "python-gitlab>=4.0.0",      # GitLab API (optional)
]
```

### 12.2 Installation

```bash
pip install eden[cli-tui]
# or
pipx install eden[cli-tui]
```

---

## 13. Open Questions & Future Considerations

1. **Fork maintenance:** Aider is actively developed. Need a strategy for upstream merges (rebase quarterly? cherry-pick critical fixes?)
2. **Multi-agent collaboration:** Future: multiple developers with Eden CLIs working on the same agent, sharing KB context in real-time
3. **Plugin system:** Allow users to add custom slash commands and KB sources
4. **Offline mode:** Support KB caching for offline development (sync when reconnected)
5. **Cost controls:** Per-org budgets for LLM calls within the CLI
6. **Model routing optimization:** Use Eden's model routing to automatically select the cheapest model that can handle the current task
7. **Voice input:** Future support for voice-to-code interaction in the TUI

---

## Appendix A: Command Reference

| Command | Description | Example |
|---|---|---|
| `/integrate-eden` | Auto-integrate Eden SDK + eval harness | `/integrate-eden` |
| `/eden-test` | Run Eden evaluation pipeline | `/eden-test --full` |
| `/eden-improve` | Generate improvement suggestions | `/eden-improve --type architecture` |
| `/eden-explain` | Analyze failure using KB | `/eden-explain trace_abc123` |
| `/eden-kb` | Query knowledge base | `/eden-kb query "reward shaping"` |
| `/eden-traces` | View observability traces | `/eden-traces --limit 10` |
| `/eden-pr` | Create pull request | `/eden-pr --draft` |
| `/eden-pipeline` | Invoke full Eden pipeline | `/eden-pipeline -d "Agent eval env"` |
| `/eden-bench` | Run/manage benchmarks | `/eden-bench run bench_abc` |
| `/eden-config` | View/edit CLI configuration | `/eden-config set autonomy.mode semi` |

## Appendix B: Example Workflows

### Workflow 1: First-time Setup
```bash
$ cd ./my-langchain-agent
$ eden
> /integrate-eden
# Eden: Analyzing codebase...
# Eden: Detected LangChain agent with 3 tools
# Eden: Installing eden-sdk...
# Eden: Adding auto-instrumentation to agent.py...
# Eden: Generating eval harness...
# Eden: Created eden-eval.yaml, .eden/config.yaml
# Eden: Run /eden-test to establish a baseline?
> /eden-test --quick
# Eden: Submitting eval job...
# Eden: [progress display]
# Eden: ✅ Baseline established. 8/12 categories passed.
# Eden: 4 issues found. Run /eden-improve for suggestions?
```

### Workflow 2: Iterative Improvement
```bash
$ eden
> My agent is too slow on tool calls. Average latency is 2.3s.
# Eden: [queries observability context]
# Eden: I can see from your last 20 traces that the search tool averages
#        1.8s and the code_exec tool averages 2.7s. The bottleneck is
#        the code_exec tool — it's making redundant LLM calls.
#        Here's what I suggest: [shows code diff]
> apply
# Eden: Applied. Run /eden-test --focus performance to verify?
> /eden-test --focus performance
# Eden: [runs test, shows improvement]
# Eden: ✅ Latency improved: 2.3s → 1.4s (39% reduction)
> /eden-pr
# Eden: Creating PR "Optimize tool call latency" on eden/perf-improvement...
# Eden: ✅ PR #42 created: https://github.com/org/repo/pull/42
```

### Workflow 3: Architecture Suggestion
```bash
$ eden
> How should I restructure my agent to support multi-turn conversations?
# Eden: [queries global KB for multi-turn agent patterns]
# Eden: [queries tenant KB for current architecture]
# Eden: Based on your current architecture and Eden's knowledge of
#        multi-turn agent patterns, here are 3 approaches: [...]
#        The recommended approach for your setup is: [...]
#        Want me to implement it?
> yes, implement option 1
# Eden: [implements changes]
# Eden: Run /eden-test to verify the changes?
```
