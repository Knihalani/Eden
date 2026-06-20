---
id: index
title: Reference
sidebar_label: Overview
sidebar_position: 1
slug: /reference
---

# Reference

Everything you need to look something up — SDK signatures, REST
endpoints, configuration keys, error codes. Reference pages are
information-oriented, complete, and accurate. They don't try to
teach you a concept (see [Explanation](/explanation/architecture))
or walk you through a task (see [Tutorials](/tutorials) or
[How-to](/how-to)).

## Sections

<div class="eden-grid eden-grid--compact">

  <div class="eden-card eden-card--small">
    <h4>SDKs</h4>
    <p>Auto-instrumentation, tracing primitives, ingestion formats.</p>
    <ul>
      <li><a href="/reference/sdk-python">Python</a></li>
      <li><a href="/reference/sdk-typescript">TypeScript</a></li>
      <li><a href="/reference/auto-instrumentation">Supported frameworks</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <h4>REST API</h4>
    <p>Public HTTP endpoints for ingestion, traces, evals, agents, costs, orgs.</p>
    <ul>
      <li><a href="/reference/api">Overview + auth</a></li>
      <li><a href="/reference/api-ingestion">Ingestion</a></li>
      <li><a href="/reference/api-traces">Traces</a></li>
      <li><a href="/reference/api-eval">Evaluations</a></li>
      <li><a href="/reference/api-cost">Cost intelligence</a></li>
      <li><a href="/reference/api-error-codes">Error codes</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <h4>Configuration</h4>
    <p>Settings, environment variables, RBAC, webhooks.</p>
    <ul>
      <li><a href="/reference/configuration">Settings</a></li>
      <li><a href="/reference/environment-variables">Env vars</a></li>
      <li><a href="/reference/rbac">RBAC</a></li>
      <li><a href="/reference/webhooks">Webhooks</a></li>
      <li><a href="/reference/cli">CLI</a></li>
    </ul>
  </div>

  <div class="eden-card eden-card--small">
    <h4>Explanation</h4>
    <p>Why Eden is built the way it is. Architecture, data model, security model.</p>
    <ul>
      <li><a href="/explanation/architecture">Architecture</a></li>
      <li><a href="/explanation/data-model">Data model</a></li>
      <li><a href="/explanation/security-model">Security model</a></li>
      <li><a href="/explanation/multi-tenancy">Multi-tenancy</a></li>
      <li><a href="/explanation/intelligence-categories">Intelligence categories</a></li>
    </ul>
  </div>

</div>

## Versioning

The public REST API is versioned at `/v1/`. Breaking changes get a
new prefix (`/v2/`); old prefixes keep working for 12 months after
deprecation with a `Deprecation` header. SDK releases follow
[SemVer](https://semver.org/) — major bumps for breaking ingestion
changes, minor for new framework support.

The current Eden version is **v1.7** (June 2026). SDK versions track
the API they target, not the platform release.