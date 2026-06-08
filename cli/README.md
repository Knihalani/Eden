# Eden Agent CLI

> AI-native agent development — terminal coding agent forked from [Aider](https://github.com/Aider-AI/aider) (Apache 2.0).

Eden Agent CLI is the developer-side companion to the [Eden platform](https://eden.example). Unlike a generic coding agent, the Eden CLI:

- **Understands your agent's telemetry.** Pulls traces, costs, latency, and failure modes from the Eden observability platform and injects them as reasoning context.
- **Reads the Eden Knowledge Base.** Global Eden best practices + your tenant's accumulated patterns are auto-injected into the system prompt.
- **Sweeps your codebase for improvements.** `/eden-improve` is the flagship command: it analyzes the entire repo + the entire telemetry corpus and proposes prioritized changes as diffs.
- **Writes back.** Each session can contribute team conventions to your tenant KB (pattern_miner cron).

## Install

```bash
cd cli
pip install -e .
```

This installs the `eden` command. The first run will scaffold `~/.eden/config.yaml` if missing.

## Quick start

```bash
# 1. Authenticate
eden login --api-key <EDEN_API_KEY> --org <ORG_ID>

# 2. Chat in any repo
cd ~/code/my-agent
eden chat

# 3. Inside the chat:
#    /eden-traces --limit 5
#    /eden-kb query "reward shaping"
#    /eden-improve --quick
```

## Slash commands

| Command | What it does |
|---|---|
| `/eden-kb query "..."` | Query the Eden Knowledge Base (global + tenant) |
| `/eden-traces` | List recent observability traces |
| `/eden-improve [--quick\|--deep]` | Multi-pass sweep → prioritized findings with diffs |

All Aider slash commands (`/add`, `/drop`, `/commit`, `/diff`, `/undo`, `/run`, `/map`, `/tokens`, `/help`) are retained.

## Configuration

`~/.eden/config.yaml` (global) and `./.eden/config.yaml` (project):

```yaml
eden:
  base_url: http://localhost:8000
  org_id: <uuid>

models:
  reasoning: anthropic/claude-sonnet-4.6
  code: qwen/qwen3-coder:free
  fast: deepseek/deepseek-v4-flash:free
  fallback: meta-llama/llama-3.3-70b-instruct

autonomy: approval   # approval | semi | autonomous

context:
  kb_token_budget: 4000
  observability_token_budget: 2000
```

Env vars (`EDEN_API_KEY`, `EDEN_BASE_URL`, `EDEN_ORG_ID`, `EDEN_MODEL`, `EDEN_AUTONOMY`) override the YAML.

## Architecture

```
cli/eden/
├── __main__.py          # entry: dispatches to Aider's chat loop with Eden config
├── config.py            # .eden/config.yaml + ~/.eden/config.yaml + env override
├── api_client.py        # async wrapper around Eden HTTP API
├── model_router.py      # Eden model slots → LiteLLM names
├── coders/
│   └── eden_coder.py    # subclass of EditBlockCoder; injects [GLOBAL KB], [TENANT CTX], [OBS CTX]
├── kb_context.py        # KB context provider
├── observability_context.py
├── commands/            # cmd_* auto-discovery (no central registry)
│   ├── kb.py
│   ├── traces.py
│   └── improve.py       # flagship: multi-pass sweep
└── pattern_miner.py     # cron entry point
```

## License

Apache 2.0 (inherited from Aider). Eden-specific code is also Apache 2.0.
