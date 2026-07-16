---
id: github
title: Connect GitHub
sidebar_label: Connect GitHub
sidebar_position: 5
---

# How-to — Connect GitHub

Connect the Eden GitHub App so the portal can see your repos for
agent metadata and code references. Eden does **not** open
auto-instrument PRs against your repositories — you wire the SDK
yourself via the [Quickstart](/quickstart) or
[Connect any agent](/how-to/connect-any-agent).

## Install the GitHub App

1. Portal → **Settings** → **Integrations** → **GitHub** → **Install**.
2. Pick the org or user that owns the repos.
3. Pick the repos (all, or a selection).

Typical permissions: read metadata and contents for framework /
agent detection. Write access to PRs is **not** required for
instrumentation (that flow was removed).

## Register an agent from your repo

Optional — add `eden/agent.yaml` (or the path your team uses) so the
portal can list agents:

```yaml
agents:
  - name: checkout
    framework: openai
    version: 2.1.0
    entrypoint: src/agents/checkout.py
```

## Next

- [Instrument an existing repo](/how-to/auto-instrument)
- [Connect any agent](/how-to/connect-any-agent)
- [API keys](/how-to/api-keys)
