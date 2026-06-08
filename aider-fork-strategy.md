# Aider Fork Strategy — Eden Agent CLI

**Version:** 1.0
**Date:** June 6, 2026
**Status:** Draft

---

## 1. Aider Architecture Summary

### 1.1 Repository Overview

- **Repo:** https://github.com/Aider-AI/aider
- **License:** Apache 2.0 (permissive — fork, modify, redistribute freely)
- **Language:** Python
- **Stars:** ~45,800 (as of June 2026)
- **Release cadence:** Multiple times per month (very active)
- **Self-written:** ~70-80% of Aider's codebase is written by Aider itself

### 1.2 Key Dependencies

| Dependency | Purpose | Relevance to Eden |
|---|---|---|
| `litellm` | LLM provider abstraction | **Keep** — already supports OpenRouter, which Eden uses |
| `tree-sitter` | Code parsing for repo map | **Keep** — core codebase indexing |
| `grep-ast` | AST-aware grep for code search | **Keep** — codebase search |
| `networkx` | PageRank for repo map ranking | **Keep** — importance scoring |
| `gitpython` | Git operations | **Keep** — git integration |
| `prompt-toolkit` | Terminal input handling | **Keep** — TUI input |
| `rich` | Terminal formatting | **Keep** — rich output |
| `tiktoken` | Token counting | **Keep** — context budgeting |
| `diskcache` | Local caching | **Keep** — offline/perf caching |
| `pyyaml` | Config parsing | **Keep** — .eden/config.yaml |
| `httpx` | HTTP client | **Keep + extend** — Eden API calls |
| `networkx` | Graph algorithms | **Keep** — repo map PageRank |

### 1.3 Core Class Hierarchy

```
aider/
├── main.py                    # Entry point — arg parsing, init, main loop launch
├── models.py                  # Model class — LLM provider abstraction via LiteLLM
├── commands.py                # Commands class — slash command dispatch
├── repo.py                    # GitRepo class — git operations wrapper
├── repomap.py                 # RepoMap class — codebase indexing + PageRank
├── io.py                      # InputOutput class — terminal I/O abstraction
├── coders/
│   ├── __init__.py            # Exports all coder classes
│   ├── base_coder.py          # Coder base class — chat loop, context, LLM calls
│   ├── editblock_coder.py     # EditBlockCoder — search/replace block edits
│   ├── wholefile_coder.py     # WholeFileCoder — full file rewrites
│   ├── udiff_coder.py         # UnifiedDiffCoder — unified diff edits
│   ├── patch_coder.py         # PatchCoder — patch-based edits
│   ├── architect_coder.py     # ArchitectCoder — two-model architect+editor
│   ├── ask_coder.py           # AskCoder — read-only queries
│   ├── context_coder.py       # ContextCoder — context-focused coder
│   ├── help_coder.py          # HelpCoder — help/documentation
│   └── ..._prompts.py         # System prompts for each coder variant
├── history.py                 # Chat history management
├── linting.py                 # Linter integration
├── formatting.py              # Code formatting
└── configs.py                 # Configuration loading (CLI args, env vars, YAML files)
```

---

## 2. Key Abstractions & Extension Points

### 2.1 The Coder Class (`aider/coders/base_coder.py`)

**The heart of Aider.** This is the main class that orchestrates everything.

**Key attributes:**
- `edit_format` — string attribute that determines which coder variant to use
- `io` — InputOutput instance for terminal I/O
- `repo` — GitRepo instance for git operations
- `repo_map` — RepoMap instance for codebase context
- `model` — Model instance for LLM calls
- `abs_fnames` — set of absolute file paths in chat context
- `cur_messages` — current chat message history

**Key methods:**
- `Coder.create(main_model, edit_format, **kwargs)` — **Factory method** that selects the right coder subclass based on `edit_format` attribute matching
- `run()` — **The main chat loop**: get input → process commands → build prompt → call LLM → apply edits → git commit → loop
- `send(messages, model, functions)` — Send messages to LLM and get response
- `apply_edits(edits)` — Apply parsed edits to files (delegated to subclass)
- `get_edits()` — Parse LLM response into structured edit objects
- `format_messages()` — Build the message list with system prompt, repo map, file contents
- `get_repo_map()` — Get the repo map for context injection

**Extension strategy for Eden:**
1. **Subclass `Coder`** to create `EdenCoder` that adds Eden-specific context injection
2. **Override `format_messages()`** to inject `[GLOBAL KNOWLEDGE]`, `[TENANT CONTEXT]`, and `[OBSERVABILITY CONTEXT]` sections
3. **Override `run()`** to add Eden pipeline suggestion triggers and autonomy gates
4. **Register `EdenCoder`** in `coders/__init__.py` so `Coder.create()` can find it

### 2.2 The Commands Class (`aider/commands.py`)

**Slash command dispatch.** Uses method-prefix convention — any method named `cmd_*` is auto-discovered as a slash command.

**How dispatch works:**
```python
def run(self, inp):
    # Inspect all methods on self
    for method_name in dir(self):
        if method_name.startswith("cmd_"):
            cmd_name = method_name[4:]  # Strip "cmd_" prefix
            # Match against user input
            if inp.startswith(f"/{cmd_name}"):
                # Parse args and invoke
                getattr(self, method_name)(args)
```

**Key methods:**
- `cmd_add(args)` — `/add` — Add file to chat context
- `cmd_drop(args)` — `/drop` — Remove file from chat context
- `cmd_run(args)` — `/run` — Execute shell command
- `cmd_commit(args)` — `/commit` — Manual git commit
- `cmd_diff(args)` — `/diff` — Show diff of changes
- `cmd_undo(args)` — `/undo` — Undo last commit
- `cmd_tokens(args)` — `/tokens` — Show token usage
- `cmd_map(args)` — `/map` — Show repo map

**Extension strategy for Eden:**
1. **Add new `cmd_*` methods** for all Eden commands (`cmd_integrate_eden`, `cmd_eden_test`, etc.)
2. **No need to modify dispatch logic** — the auto-discovery picks up new methods automatically
3. **Access `self.coder`** from within commands to interact with the chat loop, files, and LLM

### 2.3 The Model Class (`aider/models.py`)

**LLM provider abstraction.** Wraps LiteLLM with Aider-specific configuration.

**Key classes:**
- `ModelSettings` — Dataclass with model-specific settings (edit format, token limits, pricing)
- `Model` — Main class that wraps LiteLLM calls
- `ModelInfoManager` — Downloads and caches model metadata from LiteLLM

**Key methods:**
- `Model.__init__(model_name)` — Initialize with model name (e.g., "anthropic/claude-sonnet-4")
- `Model.send(messages, functions, stream)` — Send messages to LLM via LiteLLM
- `Model.token_count(messages)` — Count tokens for a message list

**Configuration:**
- `model-settings.yml` — Built-in model settings database
- `.aider.model.settings.yml` — User overrides (in home dir or project root)
- LiteLLM handles provider routing (OpenAI, Anthropic, OpenRouter, Ollama, etc.)

**Extension strategy for Eden:**
1. **Keep LiteLLM** — it already supports OpenRouter, which is Eden's primary LLM gateway
2. **Extend `ModelSettings`** with Eden-specific fields (model slot: reasoning/fast/code)
3. **Override model selection** to use Eden's model routing (reasoning → claude-sonnet-4, fast → deepseek-flash, etc.)
4. **Add Eden model-settings.yml** with Eden's model configurations

### 2.4 The RepoMap Class (`aider/repomap.py`)

**Codebase indexing and context generation.** Uses tree-sitter to parse code and networkx PageRank to rank symbols.

**How it works:**
1. Parse all project files with tree-sitter to extract symbols (functions, classes, variables)
2. Build a directed graph where nodes are files and edges are reference relationships
3. Run PageRank to determine which files/symbols are most important
4. Generate a compact "repo map" text showing key symbols and their signatures
5. Fit the map within a configurable token budget (`--map-tokens`)

**Key methods:**
- `RepoMap.__init__(root, map_tokens, ...)` — Initialize with project root and token budget
- `RepoMap.get_repo_map(chat_fnames, mentioned_fnames)` — Generate repo map excluding files already in chat context
- `RepoMap.get_ranked_tags(fname)` — Get ranked symbols for a file

**Extension strategy for Eden:**
1. **Keep as-is** — the PageRank-based ranking is excellent for context prioritization
2. **Extend with framework detection** — analyze imports to detect LangChain, CrewAI, etc.
3. **Extend with Eden-specific metadata** — mark files that have Eden instrumentation, eval harnesses, etc.
4. **Inject Eden context** alongside the repo map (not replacing it)

### 2.5 The GitRepo Class (`aider/repo.py`)

**Git operations wrapper.** Handles auto-commit, diff generation, branch management.

**Key methods:**
- `GitRepo.__init__(root)` — Initialize with project root
- `GitRepo.commit(message)` — Auto-commit with generated message
- `GitRepo.get_diffs(fnames)` — Get diffs for specific files
- `GitRepo.get_dirty_commits()` — Get uncommitted changes
- `GitRepo.undo_last_commit()` — Undo last commit

**Extension strategy for Eden:**
1. **Extend with PR creation** — add methods for GitHub/GitLab API integration
2. **Extend with branch management** — auto-create feature branches with Eden prefix
3. **Extend commit messages** — include Eden context metadata (KB entries used, observability data referenced)

### 2.6 The InputOutput Class (`aider/io.py`)

**Terminal I/O abstraction.** Handles user input, output formatting, confirmations.

**Key methods:**
- `InputOutput.input()` — Get user input
- `InputOutput.tool_output(msg)` — Display tool output
- `InputOutput.confirm_ask(msg)` — Ask for confirmation (bypassed by `--yes`)

**Extension strategy for Eden:**
1. **Extend with autonomy gates** — override `confirm_ask` to check autonomy mode
2. **Extend with rich formatting** — add Eden-specific output formatting (pipeline progress, KB results)
3. **Extend with progress display** — add pipeline progress widget

---

## 3. Specific Changes Required

### 3.1 New Files to Create

```
aider/
├── eden/
│   ├── __init__.py              # Eden CLI package
│   ├── client.py                # Eden API client (wraps httpx)
│   ├── config.py                # Eden configuration loading
│   ├── kb_context.py            # Knowledge base context provider
│   ├── observability_context.py # Observability data context provider
│   ├── pipeline_invoker.py      # Eden pipeline job submission + polling
│   ├── pr_manager.py            # GitHub/GitLab PR creation
│   ├── integrator.py            # /integrate-eden implementation
│   ├── autonomy.py              # Autonomy model + approval gates
│   ├── framework_detector.py    # Detect agent framework (LangChain, etc.)
│   └── eval_harness.py          # Generate evaluation harness
├── coders/
│   └── eden_coder.py            # Eden-specific coder subclass
└── commands/
    └── eden_commands.py         # Eden slash commands (cmd_integrate_eden, etc.)
```

### 3.2 Files to Modify

#### `aider/main.py` — Entry Point
**Changes:**
- Add Eden config loading (`.eden/config.yaml`, env vars)
- Add Eden API client initialization
- Add Eden context providers (KB, observability) to coder initialization
- Add Eden branding (replace "aider" with "eden" in help text)
- Add `--autonomous`, `--semi-autonomous` flags
- Add `--org`, `--api-key`, `--base-url` flags (from existing Eden CLI)

**Estimated diff:** ~100 lines added

#### `aider/coders/base_coder.py` — Base Coder
**Changes:**
- Add `eden_client` attribute (Eden API client instance)
- Add `eden_kb_context` attribute (KB context provider)
- Add `eden_obs_context` attribute (Observability context provider)
- Override `format_messages()` to inject Eden context sections
- Add `_inject_eden_context(messages)` method
- Add `_should_suggest_pipeline(user_input)` method for auto-suggestion triggers
- Add autonomy check before applying edits

**Estimated diff:** ~200 lines added

#### `aider/commands.py` — Command Dispatch
**Changes:**
- Import Eden commands module
- Add Eden commands to the command registry
- No changes to dispatch logic (auto-discovery handles it)

**Estimated diff:** ~10 lines added

#### `aider/models.py` — Model Abstraction
**Changes:**
- Add Eden model slot mapping (reasoning, fast, code)
- Override model selection to use Eden's routing
- Add Eden-specific model settings

**Estimated diff:** ~50 lines added

#### `aider/repomap.py` — Repo Map
**Changes:**
- Add framework detection (analyze imports for LangChain, CrewAI, etc.)
- Add Eden metadata to repo map entries (instrumented files, eval harnesses)

**Estimated diff:** ~80 lines added

#### `aider/repo.py` — Git Integration
**Changes:**
- Add `create_pull_request()` method for GitHub/GitLab API
- Add `create_branch()` method with Eden prefix
- Extend `commit()` to include Eden context metadata

**Estimated diff:** ~150 lines added

#### `aider/io.py` — InputOutput
**Changes:**
- Add autonomy-aware `confirm_ask()` override
- Add `show_pipeline_progress()` method
- Add `show_kb_results()` method

**Estimated diff:** ~100 lines added

### 3.3 New Slash Commands

| Command | Implementation | Method Name | Location |
|---|---|---|---|
| `/integrate-eden` | `eden/integrator.py` | `cmd_integrate_eden` | `commands/eden_commands.py` |
| `/eden-test` | `eden/pipeline_invoker.py` | `cmd_eden_test` | `commands/eden_commands.py` |
| `/eden-improve` | `eden/pipeline_invoker.py` + KB | `cmd_eden_improve` | `commands/eden_commands.py` |
| `/eden-explain` | `eden/kb_context.py` | `cmd_eden_explain` | `commands/eden_commands.py` |
| `/eden-kb` | `eden/kb_context.py` | `cmd_eden_kb` | `commands/eden_commands.py` |
| `/eden-traces` | `eden/observability_context.py` | `cmd_eden_traces` | `commands/eden_commands.py` |
| `/eden-pr` | `eden/pr_manager.py` | `cmd_eden_pr` | `commands/eden_commands.py` |
| `/eden-pipeline` | `eden/pipeline_invoker.py` | `cmd_eden_pipeline` | `commands/eden_commands.py` |
| `/eden-bench` | `eden/pipeline_invoker.py` | `cmd_eden_bench` | `commands/eden_commands.py` |
| `/eden-config` | `eden/config.py` | `cmd_eden_config` | `commands/eden_commands.py` |

### 3.4 Context Injection Points

The most critical integration point is how Eden context gets injected into the LLM's system prompt.

**Current Aider flow:**
```
User input → build messages list → [system prompt, repo map, file contents, chat history] → LLM
```

**Eden-modified flow:**
```
User input → build messages list → [system prompt, repo map, file contents, chat history, 
                                     GLOBAL KNOWLEDGE, TENANT CONTEXT, OBSERVABILITY CONTEXT] → LLM
```

**Implementation in `base_coder.py`:**
```python
def format_messages(self, messages):
    # Existing Aider logic for system prompt, repo map, file contents
    
    # Eden context injection
    if self.eden_client:
        eden_context = self._build_eden_context()
        # Insert after system prompt, before file contents
        messages.insert(1, {
            "role": "system",
            "content": eden_context
        })
    
    return messages

def _build_eden_context(self):
    sections = []
    
    # Global KB context
    if self.eden_kb_context:
        global_kb = self.eden_kb_context.get_global_context(
            query=self._build_kb_query(),
            budget_tokens=self.eden_config.kb.context_budget_tokens
        )
        if global_kb:
            sections.append(f"[GLOBAL KNOWLEDGE]\n{global_kb}")
    
    # Tenant KB context
    if self.eden_kb_context:
        tenant_kb = self.eden_kb_context.get_tenant_context(
            query=self._build_kb_query(),
            budget_tokens=self.eden_config.kb.context_budget_tokens
        )
        if tenant_kb:
            sections.append(f"[TENANT CONTEXT]\n{tenant_kb}")
    
    # Observability context
    if self.eden_obs_context:
        obs = self.eden_obs_context.get_context(
            agent_id=self._detect_agent_id(),
            limit=self.eden_config.observability.trace_limit
        )
        if obs:
            sections.append(f"[OBSERVABILITY CONTEXT]\n{obs}")
    
    return "\n\n".join(sections)
```

---

## 4. Fork Maintenance Strategy

### 4.1 The Problem

Aider releases multiple times per month. A fork that diverges too far will accumulate merge conflicts rapidly.

### 4.2 Strategy: Minimal Footprint + Isolated Modules

**Principle:** Keep Eden-specific code in the `aider/eden/` directory and `commands/eden_commands.py`. Minimize changes to core Aider files.

**Approach:**
1. **Fork at a stable release tag** (e.g., `v0.60.0`) — not from `main`
2. **Create an `eden/` package** — all Eden-specific logic lives here
3. **Minimize changes to core files** — only add imports and hook points
4. **Use composition over modification** — Eden context providers are separate objects injected into the coder, not inline modifications
5. **Quarterly rebase** — rebase onto latest Aider release every 3 months
6. **Cherry-pick critical fixes** — between rebases, cherry-pick security fixes and critical bug fixes

### 4.3 Merge Conflict Risk Assessment

| File | Change Size | Conflict Risk | Mitigation |
|---|---|---|---|
| `main.py` | ~100 lines | **Medium** | Add Eden init in a separate function, call from main |
| `base_coder.py` | ~200 lines | **High** | Use composition: inject Eden context provider object |
| `commands.py` | ~10 lines | **Low** | Just add import |
| `models.py` | ~50 lines | **Low** | Add Eden model settings as separate config |
| `repomap.py` | ~80 lines | **Medium** | Add framework detection as separate module |
| `repo.py` | ~150 lines | **Medium** | Add PR manager as separate module, thin wrapper |
| `io.py` | ~10 lines | **Low** | Just add import |
| `eden/*` | ~1500 lines | **None** | New files, no conflict risk |

**Total estimated changes to core Aider files:** ~550 lines across 7 files
**Total new Eden-specific code:** ~1500 lines in `eden/` package

### 4.4 Rebase Process

```bash
# 1. Add Aider upstream remote
git remote add upstream https://github.com/Aider-AI/aider.git

# 2. Fetch latest release tag
git fetch upstream --tags

# 3. Create rebase branch
git checkout -b rebase-v0.XX.0

# 4. Rebase Eden changes onto new Aider release
git rebase v0.XX.0

# 5. Resolve conflicts (should be minimal if we followed the strategy)
# 6. Test thoroughly
# 7. Merge rebase branch into main
```

---

## 5. Integration with Existing Eden Codebase

### 5.1 Eden API Client Reuse

The existing `src/eden/sdk/client.py` provides the foundation. The CLI needs:

```python
# eden/client.py — wraps existing SDK
from eden.sdk import EdenClient
from eden.sdk.config import EdenConfig

class CLIClient:
    """CLI-specific wrapper around EdenClient."""
    
    def __init__(self, config: dict):
        self.config = EdenConfig.load(
            api_key=config.get("api_key"),
            base_url=config.get("base_url"),
            default_org=config.get("org_id"),
        )
        self.client = EdenClient(config=self.config)
    
    async def query_kb(self, query: str, scope: str = "all") -> dict:
        """Query knowledge base."""
        # Use existing /v1/kb/query endpoint
        ...
    
    async def get_observability_context(self, agent_id: str = None) -> dict:
        """Get observability data for context injection."""
        # Use existing /orgs/{org_id}/observability/ endpoints
        ...
    
    async def submit_pipeline_job(self, description: str) -> dict:
        """Submit an Eden pipeline job."""
        # Use existing /v1/jobs endpoint
        ...
```

### 5.2 Config Integration

The CLI reads config from three sources (in priority order):
1. CLI flags (`--api-key`, `--org`, `--base-url`)
2. Project config (`.eden/config.yaml`)
3. Global config (`~/.eden/config.yaml`)
4. Environment variables (`EDEN_API_KEY`, `EDEN_DEFAULT_ORG`, `EDEN_BASE_URL`)

This matches the existing Eden CLI config pattern in `src/eden/cli/commands/config_cmd.py`.

### 5.3 Backward Compatibility

The existing thin CLI commands (`eden generate`, `eden environment`, etc.) remain functional:

```python
# main.py — entry point routing
def main():
    if len(sys.argv) > 1 and sys.argv[1] in THIN_CLI_COMMANDS:
        # Delegate to existing Click CLI
        from eden.cli.main import cli
        cli()
    else:
        # Launch interactive TUI (Aider fork)
        run_eden_tui()
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

- **Eden context providers:** Mock Eden API, test context formatting
- **Autonomy model:** Test approval gates, mode switching
- **Framework detector:** Test detection of LangChain, CrewAI, AutoGen, etc.
- **Eval harness generator:** Test harness generation for various agent types
- **PR manager:** Mock GitHub/GitLab API, test PR creation

### 6.2 Integration Tests

- **End-to-end chat loop:** Test full user input → LLM → edit → commit cycle with Eden context
- **KB injection:** Test that KB context appears in LLM messages
- **Pipeline invocation:** Test job submission, polling, and result display
- **`/integrate-eden`:** Test on sample agent codebases (LangChain, CrewAI, custom)

### 6.3 Aider Compatibility Tests

- **Run Aider's existing test suite** against the fork to ensure no regressions
- **Test all original slash commands** still work
- **Test all edit formats** (editblock, whole, udiff, patch) still work
- **Test repo map generation** still works

---

## 7. Implementation Timeline

| Phase | Duration | Deliverables |
|---|---|---|
| **Phase 1: Fork & Core** | 2 weeks | Fork Aider, add Eden branding, config loading, API client |
| **Phase 2: KB Integration** | 1.5 weeks | KB context provider, `/eden-kb` command, context injection |
| **Phase 3: Observability** | 1 week | Observability context provider, `/eden-traces` command |
| **Phase 4: Pipeline** | 1.5 weeks | Pipeline invoker, progress display, `/eden-test`, `/eden-pipeline` |
| **Phase 5: PR Workflow** | 1 week | PR manager, `/eden-pr` command, commit message generation |
| **Phase 6: `/integrate-eden`** | 2 weeks | Codebase analyzer, SDK integration, eval harness generation |
| **Phase 7: Autonomy** | 1 week | Approval gates, mode switching, safety guardrails |
| **Phase 8: Testing & Polish** | 2 weeks | Unit tests, integration tests, Aider compatibility, docs |
| **Total** | **~12 weeks** | Full Eden Agent CLI |

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Aider fork diverges too far | Medium | High | Minimal footprint strategy, quarterly rebase |
| Context injection breaks Aider's prompting | Medium | High | Extensive testing, fallback to non-Eden mode |
| Eden API client async/sync mismatch | Low | Medium | Use `asyncio.run()` wrapper (same pattern as existing CLI) |
| Large codebases exceed context budget | Medium | Medium | Token budget management, progressive pruning |
| Framework detection is unreliable | Medium | Low | Graceful fallback to generic agent treatment |
| GitHub API rate limits for PR creation | Low | Low | Token-based auth, rate limit handling |

---

## 9. Alternative Approaches Considered

### 9.1 Build from Scratch
- **Pros:** Full control, no fork maintenance burden
- **Cons:** Enormous effort (Aider is ~50k lines of battle-tested code), would take 6+ months
- **Decision:** Rejected — fork is 3x faster to market

### 9.2 Use Continue.dev as Base
- **Pros:** Strong context engine, VS Code integration
- **Cons:** Primarily VS Code-native, harder to make into a standalone TUI
- **Decision:** Rejected — Aider is already a TUI

### 9.3 Use OpenHands as Base
- **Pros:** Very capable, browser + terminal + code editing
- **Cons:** Heavy (Docker-based), complex architecture, harder to fork
- **Decision:** Rejected — too heavy for a CLI tool

### 9.4 Wrap Aider as a Library (No Fork)
- **Pros:** No fork maintenance, always up-to-date
- **Cons:** Can't inject context into system prompt, can't add slash commands, limited customization
- **Decision:** Rejected — need deep integration, not surface-level wrapper

### 9.5 Aider Plugin System (Contribute Upstream)
- **Pros:** Clean extension point, no fork needed
- **Cons:** Aider has no plugin system and the maintainer prefers minimalism
- **Decision:** Rejected as primary strategy — may contribute back later

---

## Appendix A: Aider Coder Types Reference

| Coder | Edit Format | Description | Use Case |
|---|---|---|---|
| `EditBlockCoder` | `edit` | Search/Replace blocks | Default — most reliable |
| `WholeFileCoder` | `whole` | Full file rewrites | Simple changes, new files |
| `UnifiedDiffCoder` | `udiff` | Standard unified diffs | Complex multi-hunk changes |
| `PatchCoder` | `patch` | Patch format | Large-scale refactors |
| `ArchitectCoder` | `architect` | Two-model plan+execute | Complex architectural changes |
| `AskCoder` | `ask` | Read-only queries | Questions about code |
| `ContextCoder` | `context` | Context-focused | Understanding codebase |
| `HelpCoder` | `help` | Documentation | Help and docs |

## Appendix B: Key Aider Methods to Override

```python
# In eden_coder.py — EdenCoder subclass

class EdenCoder(EditBlockCoder):
    """Eden-aware coding agent based on Aider's EditBlockCoder."""
    
    edit_format = "eden"  # Register with Coder.create()
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.eden_client = None  # Initialized in main.py
        self.eden_kb_context = None
        self.eden_obs_context = None
        self.eden_config = None
    
    def format_messages(self, messages):
        """Override to inject Eden context."""
        messages = super().format_messages(messages)
        if self.eden_client:
            eden_msg = self._build_eden_context_message()
            if eden_msg:
                # Insert after system prompt
                messages.insert(1, eden_msg)
        return messages
    
    def _build_eden_context_message(self):
        """Build Eden context message for LLM."""
        sections = []
        
        if self.eden_kb_context:
            kb = self.eden_kb_context.get_context(...)
            if kb:
                sections.append(f"[GLOBAL KNOWLEDGE]\n{kb}")
        
        if self.eden_obs_context:
            obs = self.eden_obs_context.get_context(...)
            if obs:
                sections.append(f"[OBSERVABILITY CONTEXT]\n{obs}")
        
        if not sections:
            return None
        
        return {
            "role": "system",
            "content": "\n\n".join(sections)
        }
    
    def run(self, user_message=None):
        """Override to add Eden pipeline suggestions."""
        # Check if user input triggers a pipeline suggestion
        if user_message and self._should_suggest_pipeline(user_message):
            self.io.tool_output(
                "💡 I can run Eden's evaluation pipeline on your agent. "
                "Try /eden-test to get started."
            )
        
        # Check autonomy before applying edits
        if self.eden_config and self.eden_config.autonomy.mode == "approval":
            # Aider's built-in confirmation handles this
            pass
        
        return super().run(user_message)
```
