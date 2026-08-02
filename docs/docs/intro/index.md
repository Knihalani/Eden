---
slug: /
id: index
title: Eden — observability + improvement for AI agents
description: Drop-in observability and evals for LLM applications and AI agents. OpenTelemetry-native, auto-instrumentation, deterministic judge scores, cost intelligence.
keywords: [eden, llm, observability, ai agents, evaluation, tracing, opentelemetry]
sidebar_label: Home
sidebar_position: 1
hide_title: true
hide_table_of_contents: true
---

<div class="eden-hero">
  <p class="eden-hero__brand">Eden</p>
  <h1 class="eden-hero__title">
    Observability and improvement for AI agents.
  </h1>
  <p class="eden-hero__subtitle">
    Drop-in tracing, auto-instrumentation, deterministic judges, cost
    intelligence — and a portal that turns traces into reviewable patches.
  </p>
  <div class="eden-hero__cta">
    <a class="eden-btn eden-btn--primary" href="/quickstart">Quickstart</a>
    <a class="eden-btn eden-btn--ghost" href="/reference/sdk-python">Browse SDKs</a>
    <a class="eden-btn eden-btn--ghost" href="https://edenobservability.com/sign-up">Start free</a>
  </div>
  <div class="eden-hero__install" role="group" aria-label="Install command">
    <span class="eden-hero__install-prompt" aria-hidden="true">$</span>
    <code class="eden-hero__install-code">pip install eden-sdk</code>
    <button class="eden-hero__install-copy" type="button" aria-label="Copy install command">copy</button>
  </div>
</div>

---

## What is Eden?

Eden is the data plane for production AI agents. Point an SDK or gateway
at your traffic, Eden captures every LLM call (tokens, cost, latency,
model, prompt, response), and the portal turns the firehose into traces,
judge scores, cost breakdowns, regression alerts, and human-reviewed
patch suggestions.

The platform ships:

- **Two production SDKs** — Python (`eden-sdk`) and TypeScript
  (`@eden-ai/sdk`). Fire-and-forget; producer p99 overhead budgeted ≤ 5 ms.
- **Open ingestion** — OpenAI, Anthropic, Bedrock, Gemini, LangChain,
  LlamaIndex, CrewAI, AutoGen, Vercel AI, and raw `custom` events.
  Wire it from your own code even without an SDK.
- **One portal** — Next.js workspace at `edenobservability.com`.
  Traces, evaluators, cost intelligence, and Improve.

---

## Observe. Evaluate. Improve.

<div class="eden-grid">

  <div class="eden-card">
    <p class="eden-card__eyebrow">Observe</p>
    <h3>Capture every call</h3>
    <p>OTel-compatible ingestion, full trace timelines, and specialised intelligence surfaces.</p>
    <a href="/reference/api-ingestion">Ingestion reference →</a>
  </div>

  <div class="eden-card">
    <p class="eden-card__eyebrow">Evaluate</p>
    <h3>Score what shipped</h3>
    <p>Deterministic + LLM judges, regression alerts, and offline eval runs in the portal Evaluate hub.</p>
    <a href="/tutorials/judge-model-output">Judge tutorial →</a>
  </div>

  <div class="eden-card">
    <p class="eden-card__eyebrow">Improve</p>
    <h3>Close the loop</h3>
    <p>Portal turns failing traces into reviewable patches — with budgets, PII redaction, and RBAC underneath.</p>
    <a href="/how-to/cost-budgets">Set a budget →</a>
  </div>

</div>

---

## Pick a starting point

<div class="eden-grid eden-grid--compact">

  <div class="eden-card eden-card--small">
    <p class="eden-card__eyebrow">New here</p>
    <ul>
      <li><a href="/quickstart">5-minute quickstart</a></li>
      <li><a href="/tutorials/auto-instrument-openai">Auto-instrument OpenAI</a></li>
      <li><a href="/tutorials/trace-multi-agent">Trace a multi-agent run</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <p class="eden-card__eyebrow">Integrate</p>
    <ul>
      <li><a href="/reference/sdk-python">Python SDK</a></li>
      <li><a href="/reference/sdk-typescript">TypeScript SDK</a></li>
      <li><a href="/reference/api">REST API</a></li>
      <li><a href="/how-to/api-keys">API keys</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <p class="eden-card__eyebrow">Security</p>
    <ul>
      <li><a href="/how-to/auth">Auth model</a></li>
      <li><a href="/how-to/pii">Set a PII policy</a></li>
      <li><a href="/explanation/security-model">Security model</a></li>
      <li><a href="https://edenobservability.com/security">Portal security</a></li>
    </ul>
  </div>

</div>

---

## SDKs talk to one API

Both SDKs hit the same ingestion surface
(`POST /orgs/{org_id}/ingest/{format}`) at
`https://api.edenobservability.com`.
