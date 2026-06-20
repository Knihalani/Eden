---
id: auto-instrument
title: Auto-instrument an existing repo
sidebar_label: Auto-instrument an existing repo
sidebar_position: 8
---

# How-to — Auto-instrument an existing repo

Two paths:

1. **Self-service** — run a CLI command that produces a patch and
   you review it locally.
2. **Onboarding PR** — the portal opens a PR against your repo
   automatically.

Both paths detect the framework and produce the same edits.

## Self-service

The CLI is bundled with the Python SDK:

```bash
pip install eden-sdk
eden instrument /path/to/your/repo --framework openai --org org_abc
```

What it does:

1. Scans the repo for `requirements.txt`, `pyproject.toml`,
   `package.json`, `Cargo.toml`, `go.mod` to detect the language
   and existing dependencies.
2. Detects LLM framework usage by file content (`import openai`,
   `from langchain`, `new OpenAI(`, etc.).
3. Generates:
   - `requirements.txt` patch adding `eden-sdk`
   - `eden/config.yaml` with org id reference
   - Edits to the detected entrypoint adding `import eden`,
     `eden.configure(...)`, `eden.instrument()`, and
     `@eden.trace_agent(...)` decorators
4. Prints a unified diff. Apply with `--apply`, or pipe to `git apply`.

```bash
# Dry run
eden instrument /path/to/repo --framework openai

# Apply
eden instrument /path/to/repo --framework openai --apply
```

## Onboarding PR

Portal → **Onboarding** → **New integration**.

1. Pick the GitHub repo (the GitHub App must be installed — see
   [How-to — Connect GitHub](/how-to/github)).
2. Pick the detected framework.
3. Pick the base branch.
4. Click **Open PR**.

The wizard produces a PR titled `[Eden] Wire observability into
{framework} app`. Review the diff and merge.

## What gets added

The minimum changes:

```diff
# requirements.txt
+ eden-sdk==0.1.0
```

```diff
# src/agents/checkout.py
+ import eden
+ import os
+
+ eden.configure(
+     api_key=os.environ["EDEN_API_KEY"],
+     org_id=os.environ["EDEN_ORG_ID"],
+ )
+ eden.instrument()

  from openai import OpenAI
  client = OpenAI()

+ @eden.trace_agent(name="checkout")
  def run(user_input: str) -> str:
      resp = client.chat.completions.create(...)
      return resp.choices[0].message.content
```

## What gets *not* added

The auto-instrumenter is conservative — it doesn't:

- Rewrite your prompts (that's the prompt registry / eval pipeline)
- Move code between files
- Add tests (you write them with the eval pipeline)
- Touch anything outside the detected framework file

If the diff looks too aggressive, run `eden instrument --dry-run`
first and edit the file before applying.

## Per-framework behaviour

| Framework | What gets added |
|-----------|-----------------|
| OpenAI | `import eden` + `eden.instrument()` + `@eden.trace_agent` on detected entrypoints |
| Anthropic | Same — the SDK patches `anthropic.Anthropic` |
| LangChain | `import eden` + `eden.instrument()` + tracing on `AgentExecutor.invoke` and `LLMChain.invoke` |
| LlamaIndex | `import eden` + tracing on `QueryEngine.query` and `ChatEngine.chat` |
| CrewAI | `import eden` + tracing on `Crew.kickoff` |
| AutoGen | `import eden` + tracing on `ConversableAgent.generate_reply` |
| Custom | Manual `eden.trace(...)` calls — the auto-instrumenter skips these |

## Verification

After merging, deploy and:

1. Send one request to your agent.
2. Open the portal → **Traces** tab. You should see a new trace
   within ~5 seconds.
3. Check the **Settings → Diagnostics** tab if it doesn't show up.

If the integration is broken (no trace, ingest errors), the PR is
still in your history — revert it cleanly:

```bash
git revert <merge-commit-sha>
```

## Removing the SDK

The auto-instrumenter is reversible. To remove the integration:

```bash
eden uninstrument /path/to/repo
```

Strips `eden.configure`, `eden.instrument`, and the decorators,
removes the `eden-sdk` dependency, deletes `eden/config.yaml`.