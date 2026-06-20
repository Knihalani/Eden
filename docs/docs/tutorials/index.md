---
id: index
title: Tutorials
sidebar_label: Overview
sidebar_position: 1
slug: /tutorials
---

# Tutorials

Hands-on, learning-oriented lessons. Each tutorial walks you through
a complete task from start to finish — by the end, you'll have
something real working in your dashboard.

Tutorials are different from how-to guides. A tutorial **teaches**
(you're learning the system), a how-to **does** (you have a goal and
need steps). Tutorials are also different from reference docs —
they don't try to be exhaustive.

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

- An Eden account (sign up via the portal; the wizard creates an
  org and gives you an API key)
- The Python SDK installed (`pip install eden-sdk`)
- An OpenAI API key (or any other supported provider)

If anything doesn't work, check the
[Quickstart troubleshooting table](/quickstart#common-gotchas) or
the **Settings → Diagnostics** page in the portal.