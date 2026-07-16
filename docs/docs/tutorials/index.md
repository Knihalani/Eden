---
id: index
title: Tutorials
sidebar_label: Overview
sidebar_position: 1
slug: /tutorials
---

# Tutorials

Hands-on lessons. Prefer the **[Quickstart](/quickstart)** first —
**Fill in** creates an API key and a runnable snippet — then pick a
tutorial below.

## Pick a tutorial

<div class="eden-grid eden-grid--compact">

  <div class="eden-card eden-card--small">
    <h4>🔌 Auto-instrument OpenAI</h4>
    <p>15 minutes. One decorator turns your existing OpenAI calls into traced events.</p>
    <a href="/tutorials/auto-instrument-openai">Start →</a>
  </div>

  <div class="eden-card eden-card--small">
    <h4>🤖 Trace a multi-agent run</h4>
    <p>20 minutes. End-to-end LangChain trace with parent + child spans.</p>
    <a href="/tutorials/trace-multi-agent">Start →</a>
  </div>

  <div class="eden-card eden-card--small">
    <h4>🧑‍⚖️ Judge a model output</h4>
    <p>15 minutes. Build a deterministic judge and a rubric-based LLM judge.</p>
    <a href="/tutorials/judge-model-output">Start →</a>
  </div>

  <div class="eden-card eden-card--small">
    <h4>💸 Set a cost budget + alert</h4>
    <p>10 minutes. Wire a Slack alert that fires when monthly tokens cross 80%.</p>
    <a href="/tutorials/cost-budget-alert">Start →</a>
  </div>

</div>

## Before you start

You'll need:

- An Eden account at [edenobservability.com](https://edenobservability.com)
- An org API key — use **[Fill in](/quickstart)** or **Settings → API Keys**
- The Python or TypeScript SDK installed
- A provider key (e.g. `OPENAI_API_KEY`) for LLM calls

If anything doesn't work, run `python -m eden_sdk.doctor` /
`npx @eden-ai/sdk doctor`, or re-check [Authenticate](/how-to/auth).