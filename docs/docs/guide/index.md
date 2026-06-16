---
id: guide-index
title: Guide
sidebar_label: Overview
sidebar_position: 1
slug: /guide
---

# Eden guide

Everything you need to use Eden day-to-day, from "spin up a local
stack" to "deploy a multi-tenant cluster".

## Where to start

<div class="eden-grid">

  <div class="eden-card">
    <div class="eden-card__icon">🚀</div>
    <h3>Getting started</h3>
    <p>Set up Eden locally, run the API + portal, and ship your first pipeline in under 15 minutes.</p>
    <a href="/guide/development">Start here →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">🏗️</div>
    <h3>Architecture</h3>
    <p>How the pipeline, KB, observability layer, and multi-tenant control plane fit together.</p>
    <a href="/guide/architecture">Architecture →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">🚢</div>
    <h3>Deployment</h3>
    <p>Docker Compose, Kubernetes, Helm, Northflank, and Fly.io. Pick the path that matches your scale.</p>
    <a href="/guide/deployment">Deploy →</a>
  </div>

  <div class="eden-card">
    <div class="eden-card__icon">📡</div>
    <h3>API reference</h3>
    <p>Every public endpoint, with curl + Python examples and a changelog.</p>
    <a href="/guide/api">Browse API →</a>
  </div>

</div>

## How Eden is organised

Eden ships with one platform and one CLI. The platform is the data
plane; the CLI is the developer surface. Both are versioned together
and share the same `eden` binary.

- **Pipeline** — generate environments from specs, with adversarial
  testing baked in. [`/guide/architecture`](#)
- **Knowledge base** — two-layer KB (curated + episodic) with the
  Archivist agent writing new entries from observed traces.
- **Observability** — 22 intelligence surfaces. See the
  [Observability section](/observability/roadmap).
- **Control plane** — multi-tenant orgs, RBAC, retention policies,
  per-org encryption.
- **Closed loop** — trace → insight → KB → prompt, all wired
  together. See [Cat 17](/observability/closed-loop-wiring).

## Conventions

- All timestamps are UTC.
- All IDs are deterministic and content-derived
  (`evt_<sha256[:16]>`, `run_<sha256[:16]>`, etc.) so re-runs are
  idempotent.
- All cost figures are in USD.
- All latency figures are server-side, client-perceived latency is
  shown alongside where it differs by more than 10%.
