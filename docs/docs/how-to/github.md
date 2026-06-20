---
id: github
title: Connect GitHub
sidebar_label: Connect GitHub
sidebar_position: 5
---

# How-to — Connect GitHub

The GitHub App integration does two things:

1. **Agent registry** — your repo's `eden/agents.yaml` (or similar)
   is read at agent startup to register agents in the portal.
2. **Auto-instrument PR** — the onboarding wizard can open a PR
   that wires the SDK into a detected framework.

## Install the GitHub App

1. Portal → **Settings** → **Integrations** → **GitHub** →
   **Install**.
2. Pick the org or user that owns the repos you want to integrate.
3. Pick the repos (all, or a selection).

The app requests:

- Read access to metadata
- Read access to contents (so it can detect frameworks)
- Write access to branches and pull requests (for the auto-instrument
  PR flow)

## Register an agent from your repo

Add a `eden/agent.yaml` to your repo:

```yaml
agents:
  - name: checkout
    framework: openai
    version: 2.1.0
    entrypoint: src/agents/checkout.py
    tags: [prod, checkout]
    metadata:
      model_default: gpt-4o-mini
      max_tokens: 1024

  - name: research
    framework: langchain
    version: 1.4.0
    entrypoint: src/agents/research.py
    tags: [prod, research]
```

When the agent starts up, it calls
`POST /orgs/{org}/agents/register` with this manifest. The portal's
**Agents** tab populates from this.

## Open an auto-instrument PR

Portal → **Onboarding** → **New integration**.

1. Pick the repo.
2. Pick the detected framework (OpenAI, LangChain, CrewAI, AutoGen,
   LlamaIndex, Anthropic).
3. Pick a base branch (`main` is the default).
4. Click **Open PR**.

The wizard:

1. Adds the SDK to `requirements.txt` / `pyproject.toml` /
   `package.json` (depending on the detected stack).
2. Creates `eden/config.yaml` with your `EDEN_API_KEY` reference.
3. Adds a `with eden.configure(...)` block at the entrypoint.
4. Adds `@eden.trace_agent(...)` decorators to detected LLM call
   sites.
5. Opens a PR titled `[Eden] Wire observability into {framework} app`.

### Permissions

The onboarding wizard requires the `integrations:write` permission,
which only owners and admins have. Members and viewers see a
"Request from your admin" callout instead.

## Review the PR

The PR is a regular GitHub PR — review the diff and merge when
you're happy. The agent starts emitting traces on the next deploy.

## Webhook events

The GitHub App subscribes to:

- `push` — keeps `eden/agent.yaml` in sync with the portal
- `pull_request` — auto-closes the integration PR if you close the
  source PR
- `release` — bumps the `version` field in the agent registry

## Disconnect

Portal → **Settings** → **Integrations** → **GitHub** → **Uninstall**.

This revokes the GitHub App installation and removes all webhook
subscriptions. Existing traces and agents are preserved.