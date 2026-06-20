---
id: cli
title: CLI
sidebar_label: CLI
sidebar_position: 1
---

# CLI

The Eden CLI ships as `eden` on PyPI and as a single static binary
for Linux/macOS/Windows. It bundles the same surface as the portal —
agent discovery, eval runs, configuration, and chat — for use from
CI, terminals, and scripts.

## Install

```bash
pip install eden-cli          # PyPI
brew install eden             # macOS / Linuxbrew
curl -fsSL https://edenobservability.com/install.sh | sh   # static binary
```

## Commands

### `eden login`

Authenticate against your Eden instance. Opens the browser for
OAuth; stores the token in `~/.eden/credentials.json`.

```bash
eden login                              # cloud default
eden login --api-url https://api.eu.edenobservability.com
eden login --api-key sk_eden_...        # non-interactive
```

### `eden config show`

Print the resolved configuration (org id, api key prefix, base url,
default realm, default tags).

```bash
eden config show
# org_id: org_abc
# api_key_prefix: sk_eden_AbCdEf...
# api_url: https://api.edenobservability.com
# realm: production
# tags: []
```

### `eden config discover-agents`

Scan the current directory tree for `eden/agent.yaml` files and
register every agent found.

```bash
eden config discover-agents
# Found 3 agents:
#   checkout   (openai)       agents/checkout.py
#   research   (langchain)    agents/research.py
#   refactor   (crewai)       agents/refactor.py
# Register all? [Y/n] y
# Registered 3 agents
```

### `eden agent push`

Push an agent registration to the server (used by `discover-agents`
under the hood; also scriptable for CI):

```bash
eden agent push --manifest eden/agent.yaml --agent-id checkout_v2
```

### `eden judge run`

Run a judge against a sample of recent traces:

```bash
eden judge run --judge-id judge_abc --sample 200 --since 24h
# Eval eval_xyz started. Run id: eval_xyz
# Status: complete
# Stats: total=200 passed=184 warned=12 failed=4 mean=4.42
```

### `eden dataset run`

Run a golden dataset against a judge:

```bash
eden dataset run --dataset support_smoke_v1 --judge judge_abc \
  --model gpt-4o-mini --prompt-version v3
```

### `eden trace list`

List recent traces:

```bash
eden trace list --limit 20 --since 24h --outcome error
```

### `eden trace get`

Print a trace as JSON:

```bash
eden trace get trc_abc
```

### `eden trace replay`

Re-run a trace against the current prompt registry:

```bash
eden trace replay trc_abc --commit   # by default dry-run
```

### `eden cost summary`

Print the cost dashboard for the current org:

```bash
eden cost summary
# Period: 2026-06-01 → 2026-06-19 (19 days)
# Total: $4,120.50
# By model:
#   gpt-4o-mini              $2,400.00 (58.2%)
#   claude-3-5-sonnet-2024   $1,500.00 (36.4%)
#   text-embedding-3-small     $220.50  (5.4%)
```

### `eden pattern mine`

Surface patterns in the trace data (the Cat 14 NL query engine, via
CLI):

```bash
eden pattern mine --since 7d --min-frequency 100
# Top patterns:
#   "checkout_completed after retry_attempt >= 1"      count=842  cost=$0.42
#   "agent_research_v3 timeout > 5s"                    count=120  cost=$0.18
```

### `eden kb search`

Search the episodic knowledge base:

```bash
eden kb search "user complaints about shipping"
```

### `eden pii scan`

Run a one-off PII scan against a payload (useful for testing custom
patterns):

```bash
echo "Email me at alice@acme.com" | eden pii scan
# Found 1 match: email → [REDACTED:email]
```

## Global flags

| Flag | Notes |
|------|-------|
| `--api-url` | Override the API URL (default: cloud) |
| `--api-key` | Override the API key |
| `--org-id` | Override the org |
| `--realm` | `production`, `staging`, `development`, `test` |
| `--format` | `json`, `table`, `plain` |
| `--verbose` | Debug logging |

## Configuration

`~/.eden/config.yaml`:

```yaml
api_url: https://api.edenobservability.com
api_key: sk_eden_...
org_id: org_abc
realm: production
default_tags: [prod]
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic error |
| 2 | Bad arguments |
| 3 | Auth failure |
| 4 | Resource not found |
| 5 | Rate limited |
| 6 | Server error |

## Shell completions

```bash
# bash
eden completion bash > /etc/bash_completion.d/eden

# zsh
eden completion zsh > "${fpath[1]}/_eden"

# fish
eden completion fish > ~/.config/fish/completions/eden.fish
```