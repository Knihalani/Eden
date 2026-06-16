---
id: index
title: Eden — the intelligence layer for AI agents
description: Observability, evaluation, governance, and self-healing for LLM applications and AI agents in production.
keywords: [eden, llm, observability, ai agents, evaluation, tracing]
sidebar_label: Home
sidebar_position: 1
hide_title: true
hide_table_of_contents: true
---

<!-- Hero -->
<div class="eden-hero">
  <div class="eden-hero__badge">EDEN · v1.7</div>
  <h1 class="eden-hero__title">
    The intelligence layer<br/>
    <span class="eden-hero__title--accent">for AI agents.</span>
  </h1>
  <p class="eden-hero__subtitle">
    Generate, observe, evaluate, govern, and self-heal LLM applications
    and AI agents — in one platform.
  </p>
  <div class="eden-hero__cta">
    <a class="eden-btn eden-btn--primary" href="/guide/development">Get started →</a>
    <a class="eden-btn eden-btn--ghost" href="/observability/roadmap">See the roadmap</a>
  </div>
</div>

---

## Why Eden

AI applications are not software. They drift, hallucinate, regress silently,
and their failures look like successes. Traditional observability and APM
tools miss the point — they capture the *what*, not the *why*.

Eden is built for the agentic era. It captures traces, evaluations, outcomes,
costs, and behavioural signals, then closes the loop with continuous
improvement: better prompts, better evals, better guardrails, and — in v1.7 —
self-healing code changes.

---

## The five pillars

<div class="eden-grid">
  <div class="eden-card">
    <div class="eden-card__icon">⚡</div>
    <h3>Generate</h3>
    <p>Interview → spec → environment, with adversarial testing baked in.</p>
    <a href="/guide/architecture">Architecture →</a>
  </div>
  <div class="eden-card">
    <div class="eden-card__icon">🔭</div>
    <h3>Observe</h3>
    <p>Traces, metrics, insights, and 22 specialised intelligence surfaces.</p>
    <a href="/observability/roadmap">Observability →</a>
  </div>
  <div class="eden-card">
    <div class="eden-card__icon">🧠</div>
    <h3>Learn</h3>
    <p>Archivist, dual-layer KB, dataset generation, closed-loop prompts.</p>
    <a href="/observability/closed-loop-wiring">Closed loop →</a>
  </div>
  <div class="eden-card">
    <div class="eden-card__icon">🛡️</div>
    <h3>Trust</h3>
    <p>Guardrails, compliance (SOC 2, HIPAA, GDPR), security, audit, lineage.</p>
    <a href="/operations/security">Security →</a>
  </div>
  <div class="eden-card">
    <div class="eden-card__icon">🔁</div>
    <h3>Self-heal</h3>
    <p>Investigate, propose, sandbox, ship — Eden writes the patch, you approve.</p>
    <a href="/observability/autonomous-code-modification">Autonomy →</a>
  </div>
</div>

---

## What's in the box

<div class="eden-grid eden-grid--compact">
  <div class="eden-card eden-card--small">
    <h4><span class="pill pill--shipped">v1.7</span> 22 intelligence surfaces</h4>
    <p>Trace replay, RCA, evaluation, retrieval, memory, agents, cost, user, governance, outcome, experimentation, prediction, autonomy, APM depth, and more.</p>
  </div>
  <div class="eden-card eden-card--small">
    <h4><span class="pill pill--shipped">v1.6</span> Autonomous code modification</h4>
    <p>21 services + 19 tables + 24 routes that propose, sandbox, and ship code changes — gated on a two-stage opt-in.</p>
  </div>
  <div class="eden-card eden-card--small">
    <h4><span class="pill pill--shipped">v1.5</span> SLM-as-judge (Luna-2)</h4>
    <p>50-90× cheaper than GPT-4o judges, vLLM-served, 10 LoRA heads.</p>
  </div>
  <div class="eden-card eden-card--small">
    <h4><span class="pill pill--shipped">v1.4</span> APM depth</h4>
    <p>Tail-based sampling, K8s attribute enrichment, Pyroscope continuous profiling.</p>
  </div>
  <div class="eden-card eden-card--small">
    <h4><span class="pill pill--shipped">v1.3</span> Query DSL & time-travel</h4>
    <p>EQL for traces, per-step edit DSL, replay &amp; rewind.</p>
  </div>
  <div class="eden-card eden-card--small">
    <h4><span class="pill pill--shipped">v1.2</span> Closed-loop learning</h4>
    <p>Trace → insight → KB → prompt, automatically.</p>
  </div>
</div>

---

## Quick links

<div class="eden-grid eden-grid--compact">
  <div class="eden-card eden-card--small">
    <h4>📘 For new users</h4>
    <ul>
      <li><a href="/guide/development">Getting started</a></li>
      <li><a href="/guide/architecture">How Eden is built</a></li>
      <li><a href="/guide/api">API reference</a></li>
    </ul>
  </div>
  <div class="eden-card eden-card--small">
    <h4>🛠️ For operators</h4>
    <ul>
      <li><a href="/guide/deployment">Deployment guide</a></li>
      <li><a href="/operations/branch_protection">Branch protection</a></li>
      <li><a href="/operations/oncall">On-call runbook</a></li>
    </ul>
  </div>
  <div class="eden-card eden-card--small">
    <h4>📊 For product &amp; finance</h4>
    <ul>
      <li><a href="/observability/cost-intelligence">Cost intelligence</a></li>
      <li><a href="/observability/outcome-roi-intelligence">Outcome / ROI</a></li>
      <li><a href="/observability/user-intelligence">User intelligence</a></li>
    </ul>
  </div>
  <div class="eden-card eden-card--small">
    <h4>🔒 For security &amp; compliance</h4>
    <ul>
      <li><a href="/operations/security">Security model</a></li>
      <li><a href="/operations/soc2-control-mapping">SOC 2 mapping</a></li>
      <li><a href="/observability/governance-intelligence">Governance intelligence</a></li>
    </ul>
  </div>
</div>

---

## Ship status

```
22 / 23 productised intelligence categories IMPLEMENTED
 1 / 23 STUB surface (autonomous code modification — gated on 4 hard gates)

Closed-loop hooks wired across 12 of 22 categories.
Fly.io staging, Northflank production, Vercel portal — 99.5% SLO target.
```

See the [live roadmap](/observability/roadmap) for what shipped this week,
or the [observability gap roadmap](/observability/gap-roadmap) for the
strategic plan.
