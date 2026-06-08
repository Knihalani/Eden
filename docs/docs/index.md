---
id: index
title: Eden Documentation
sidebar_label: Home
sidebar_position: 1
---

# Eden

Eden is an AI-native environment generation system. The platform
generates, observes, and learns from the environments agents run
in, compounding in value over time.

## What you'll find here

- **[Getting started](./development.md)** — set up a local dev
  environment and run your first pipeline.
- **[Architecture](./architecture.md)** — high-level system
  design; pipeline, KB, observability, multi-tenancy.
- **[Deployment](./deployment.md)** — Docker compose, Kubernetes,
  self-hosted Helm chart.
- **[API reference](./api.md)** — every public endpoint, with
  curl + Python examples.
- **[Roadmap](./roadmap.md)** — what we're building next.
- **[Branch protection](./branch_protection.md)** — release
  process and merge rules.

## The five strategic pillars

```
Generate ─► Observe ─► Learn ─► Share
              │
              ▼
            Trust
```

1. **Generate** — interview → spec → environment, with
   adversarial testing.
2. **Observe** — traces, metrics, insights, visualizations.
3. **Learn** — Archivist, dual-layer KB, dataset generation.
4. **Share** — SDKs, API, CLI, marketplace, integrations.
5. **Trust** — security, quality gates, compliance, sandboxing.

## Status

Phases 1–3 are complete (May 2026). The active work is Phase 4
(Ecosystem & Enterprise) and Phase E (E2E / perf / monitoring /
security hardening). See the [roadmap](./roadmap.md) for the
live punch list.
