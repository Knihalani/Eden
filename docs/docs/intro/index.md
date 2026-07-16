---
slug: /
id: index
title: Eden — observability, evaluation, governance for AI agents
description: Drop-in observability and evals for LLM applications and AI agents. OpenTelemetry-native, auto-instrumentation, deterministic judge scores, cost intelligence.
keywords: [eden, llm, observability, ai agents, evaluation, tracing, opentelemetry]
sidebar_label: Home
sidebar_position: 1
hide_title: true
hide_table_of_contents: true
---

<div class="eden-hero">
  <div class="eden-hero__badge">EDEN · v1.7</div>
  <h1 class="eden-hero__title">
    Observability, evaluation,<br/>
    <span class="eden-hero__title--accent">governance for AI agents.</span>
  </h1>
  <p class="eden-hero__subtitle">
    Drop-in tracing, auto-instrumentation, deterministic judges, cost
    intelligence, and a portal that turns trace data into action.
  </p>
  <div class="eden-hero__cta">
    <a class="eden-btn eden-btn--primary" href="/quickstart">Get started →</a>
    <a class="eden-btn eden-btn--ghost" href="/reference/sdk-python">Browse SDKs</a>
  </div>
  <div class="eden-hero__install" role="group" aria-label="Install command">
    <span class="eden-hero__install-prompt" aria-hidden="true">$</span>
    <code class="eden-hero__install-code">pip install eden-sdk</code>
    <button class="eden-hero__install-copy" type="button" aria-label="Copy install command">copy</button>
  </div>
</div>

---

## What is Eden?

Eden is the data plane for production AI agents. You point the SDK at
your code, Eden captures every LLM call (tokens, cost, latency, model,
prompt, response), and the portal turns the firehose into traces,
judge scores, cost breakdowns, regression alerts, and audit-ready
governance evidence.

The platform ships:

- **Two production SDKs** — Python (`eden-sdk`) and TypeScript
  (`@eden-ai/sdk`). Each one is fire-and-forget; producer p99
  overhead is budgeted at ≤ 5 ms.
- **Open ingestion** — the API accepts OpenAI, Anthropic, LangChain,
  Vercel AI, and raw `custom` events. Wire it from your own code
  even if you don't use an SDK.
- **22 intelligence surfaces** — trace replay, RCA, evaluation,
  retrieval, memory, agents, cost, user, governance, outcome,
  experimentation, prediction, autonomy, APM depth, and more.
- **One portal** — Next.js dashboard at `edenobservability.com`.
  Observability, evaluators, cost intelligence, judges, incidents, and
  improvement controls.

---

## The four pillars

<div class="eden-grid">

  <div class="eden-card">
    <div class="eden-card__icon">🔭</div>
    <h3>Observe</h3>
    <p>OTel-compatible ingestion, full trace timelines, agent-graph view, and 22 specialised intelligence surfaces.</p>
    <a href="/reference/api-ingestion">Ingestion reference →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">🧠</div>
    <h3>Evaluate</h3>
    <p>Deterministic + LLM judges, regression alerts, golden datasets, batch replay, and closed-loop prompt evolution.</p>
    <a href="/tutorials/judge-model-output">Judge tutorial →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">💸</div>
    <h3>Control cost</h3>
    <p>Per-org token budgets, soft/hard limits, cost forecasting, anomaly detection, and ROI by department.</p>
    <a href="/how-to/cost-budgets">Set a budget →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">🛡️</div>
    <h3>Govern</h3>
    <p>PII scanner with in-place redaction, RTBF anonymisation, SOC 2 / HIPAA / GDPR evidence packs, audit log, RBAC.</p>
    <a href="/explanation/security-model">Security model →</a>
  </div>

</div>

---

## Pick a starting point

<div class="eden-grid eden-grid--compact">

  <div class="eden-card eden-card--small">
    <h4>📘 I'm new here</h4>
    <ul>
      <li><a href="/quickstart">5-minute quickstart</a></li>
      <li><a href="/tutorials/auto-instrument-openai">Auto-instrument OpenAI</a></li>
      <li><a href="/tutorials/trace-multi-agent">Trace a multi-agent run</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <h4>🛠️ I need to integrate</h4>
    <ul>
      <li><a href="/reference/sdk-python">Python SDK</a></li>
      <li><a href="/reference/sdk-typescript">TypeScript SDK</a></li>
      <li><a href="/reference/api">REST API</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <h4>🔒 I'm a security / compliance person</h4>
    <ul>
      <li><a href="/how-to/auth">Auth model</a></li>
      <li><a href="/how-to/pii">Set a PII policy</a></li>
      <li><a href="/explanation/security-model">Security model</a></li>
      <li><a href="/explanation/multi-tenancy">Multi-tenancy</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <h4>🚢 I need to deploy</h4>
    <ul>
      <li><a href="/how-to/deploy">Self-host with Docker / Kubernetes</a></li>
      <li><a href="/reference/environment-variables">Environment variables</a></li>
      <li><a href="/reference/configuration">Settings reference</a></li>
    </ul>
  </div>

</div>

---

## Open the box

```
eden/
├── src/eden/
│   ├── api/              FastAPI app (auth, ingestion, intel routes)
│   ├── observability/    Telemetry collector, OTel adapters
│   ├── kb/               Episodic + semantic KB, memory intel
│   ├── llm/              AI gateway, prompt registry
│   ├── evaluation/       Judges, eval runs, golden datasets
│   ├── cost/             Cost intel, budgeting, forecasting
│   ├── experiments/      A/B + Bayesian experimentation
│   ├── autonomous/       NL queries, self-heal (read-only by default)
│   ├── code_change/      Patch proposals, two-stage opt-in
│   └── ...               (22 intelligence services in total)
├── sdk/
│   ├── python/           pip install eden-sdk
│   └── ts-ai/            npm install @eden-ai/sdk
└── clients/portal/       Next.js 16 dashboard
```

The two SDKs both hit the same ingestion endpoint
(`POST /orgs/{org_id}/ingest/{format}`); they're equivalent at the
wire level.
